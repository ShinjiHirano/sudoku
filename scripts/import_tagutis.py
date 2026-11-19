"""Build a Sudoku app backup and a local review page from Tagutis images."""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from urllib.parse import quote, urljoin

from PIL import Image

from tagutis_board import BoardError, find_board, open_image, read_board, solution_count, templates_from
from tagutis_site import SITE, cache_path, write_bytes, write_json


BACKUP_FORMAT = "sudoku-web/v1"
STATUS_EXTRACTED = "extracted"
STATUS_CORRECTED = "corrected"
STATUS_REVIEW = "review"
STATUS_UNAVAILABLE = "unavailable"


def boards_from_manifests(paths, local_images):
    records = {}
    for path in paths:
        for source in json.loads(path.read_text(encoding="utf-8")):
            number = source["number"]
            if number not in records or "error" not in source:
                records[number] = source
    for mapping in local_images:
        key, separator, filename = mapping.partition("=")
        if not separator or not key.isdecimal() or not 1 <= int(key) <= 800 or not filename:
            raise ValueError(f"画像指定は例題番号=ファイルパスの形にしてください: {mapping}")
        number = int(key)
        record = records.setdefault(number, {"number": number})
        record["local"] = str(Path(filename).resolve())
        record.pop("error", None)
    if not records:
        raise ValueError("収集結果または --local-image を指定してください")
    return [records[number] for number in sorted(records)]


def board_rows(values):
    return ["".join(map(str, values[row:row + 9])) for row in range(0, 81, 9)]


def read_corrections(path):
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    corrections = {}
    if not isinstance(raw, dict):
        raise ValueError("修正JSONは例題番号ごとに9行を指定してください")
    for key, rows in raw.items():
        if (not key.isdecimal() or not 1 <= int(key) <= 800 or
                not isinstance(rows, list) or len(rows) != 9 or
                any(not isinstance(row, str) or not re.fullmatch(r"[0-9]{9}", row) for row in rows)):
            raise ValueError(f"修正JSONの例題 {key} は各行9桁の数字を9行指定してください")
        corrections[int(key)] = list(map(int, "".join(rows)))
    return corrections


def relative_url(path, root):
    return quote(Path(os.path.relpath(path, root)).as_posix())


def source_path(work_dir, source):
    if source.get("local"):
        return Path(source["local"])
    if source.get("image"):
        return cache_path(work_dir, source["image"])
    return None


def process_source(work_dir, source, templates, correction):
    number = source["number"]
    item = {"number": number, "page": source.get("page") or urljoin(SITE, f"reidai{number}.html"),
            "image": source.get("image"),
            "candidates": [url for url in source.get("candidates", []) if url != source.get("image")]}
    path = source_path(work_dir, source)
    if path and path.is_file():
        item["preview"] = relative_url(path, work_dir)
        item["original"] = item["preview"]

    notes = []
    values = None
    status = STATUS_UNAVAILABLE
    if source.get("error"):
        notes.append(source["error"])
    elif path:
        try:
            crop = find_board(open_image(path))
            preview = work_dir / "previews" / f"{number}.jpg"
            preview.parent.mkdir(parents=True, exist_ok=True)
            image = crop.image.crop(crop.bounds)
            image.thumbnail((360, 360), Image.Resampling.LANCZOS)
            image.save(preview, quality=92)
            item["preview"] = relative_url(preview, work_dir)
            values, cell_notes = read_board(crop, templates)
            item["cells"] = cell_notes
            if cell_notes:
                notes.append(f"数字・空欄の候補が曖昧なマスが {len(cell_notes)} 個あります")
        except (OSError, BoardError) as error:
            notes.append(str(error))
        status = STATUS_REVIEW

    if correction is not None:
        values = correction
        notes = []
        item["cells"] = []
        status = STATUS_REVIEW
    if values is not None:
        if not notes:
            try:
                count = solution_count(values)
                if count != 1:
                    notes.append("盤面に解がありません" if count == 0 else "盤面に複数の解があります")
            except BoardError as error:
                notes.append(str(error))
        if not notes:
            status = STATUS_CORRECTED if correction is not None else STATUS_EXTRACTED
        item["rows"] = board_rows(values)
    item.update(status=status, reasons=notes)
    return item, values


def valid_grid(grid):
    return (isinstance(grid, list) and len(grid) == 81 and
            all(type(digit) is int and 0 <= digit <= 9 for digit in grid))


def read_backup(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("format") != BACKUP_FORMAT or not isinstance(data.get("books"), list):
        raise ValueError("バックアップが sudoku-web/v1 形式ではありません")
    for book in data["books"]:
        if (not isinstance(book, dict) or not isinstance(book.get("id"), str) or
                not isinstance(book.get("name"), str) or not isinstance(book.get("puzzles"), list)):
            raise ValueError("バックアップ内に不正な問題集があります")
        for puzzle in book["puzzles"]:
            if (not isinstance(puzzle, dict) or not all(isinstance(puzzle.get(field), str)
                    for field in ("id", "title", "createdAt", "updatedAt")) or
                    not valid_grid(puzzle.get("givens")) or not valid_grid(puzzle.get("entries")) or
                    not isinstance(puzzle.get("notes"), dict)):
                raise ValueError(f"バックアップ内の問題形式が不正です: {book['name']}")
            if any(not re.fullmatch(r"[0-9]+", index) or not 0 <= int(index) < 81 or
                   not isinstance(digits, list) or any(type(d) is not int or not 1 <= d <= 9 for d in digits)
                   for index, digits in puzzle["notes"].items()):
                raise ValueError(f"バックアップ内の候補メモが不正です: {book['name']}")
    return data


def make_backup(entries, base_backup=None):
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    data = base_backup if base_backup is not None else {"format": BACKUP_FORMAT, "books": []}
    books = data["books"]
    by_book_id = {book["id"]: book for book in books}
    existing = defaultdict(list)
    for book in books:
        for puzzle in book["puzzles"]:
            existing[puzzle["id"]].append(puzzle)
    for number, board in entries:
        puzzle_id = f"tagutis1-example-{number}"
        if puzzle_id in existing:
            if any(board != puzzle["givens"] for puzzle in existing[puzzle_id]):
                raise ValueError(f"例題 {number} の初期盤面が既存データと異なります")
            continue

        start = (number - 1) // 100 * 100 + 1
        book_id = f"tagutis1-book-{start}"
        if book_id not in by_book_id:
            book = {"id": book_id, "name": f"Tagutis 例題 {start}〜{start + 99}", "puzzles": []}
            books.append(book)
            by_book_id[book_id] = book
        by_book_id[book_id]["puzzles"].append(
            {"id": puzzle_id, "title": f"例題 {number}", "givens": board, "entries": [0] * 81,
             "notes": {}, "createdAt": now, "updatedAt": now}
        )
    data["exportedAt"] = now
    return data


def write_review(work_dir, results, corrections, totals):
    template = Path(__file__).with_name("tagutis_review.html").read_text(encoding="utf-8")
    payload = json.dumps({"items": results, "totals": totals,
                          "corrections": {key: board_rows(values) for key, values in corrections.items()}},
                         ensure_ascii=False)
    html = template.replace("{{REPORT_DATA}}", payload.replace("<", r"\u003c"))
    write_bytes(work_dir / "review.html", html.encode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=Path(".tagutis-import"))
    parser.add_argument("--sources", type=Path, nargs="+", help="収集結果JSON")
    parser.add_argument("--local-image", action="append", default=[], metavar="番号=ファイル")
    parser.add_argument("--template", type=Path, help="例題1の見本画像")
    parser.add_argument("--corrections", type=Path, help="確認画面から保存した修正JSON")
    parser.add_argument("--base-backup", type=Path, help="問題集を追加する既存アプリのバックアップ")
    parser.add_argument("--output", type=Path, help="アプリ用JSONの出力先")
    args = parser.parse_args()
    work_dir = args.work_dir
    output = args.output or work_dir / "tagutis-puzzles.json"
    if args.base_backup and output.resolve() == args.base_backup.resolve():
        parser.error("出力先にはバックアップと異なるファイルを指定してください")

    try:
        manifests = args.sources
        if manifests is None:
            manifests = [] if args.local_image else sorted(work_dir.glob("sources-[0-9]*-[0-9]*.json"))
        sources = boards_from_manifests(manifests, args.local_image)
        template = args.template
        if template is None:
            example_one = next((source for source in sources if source["number"] == 1), {})
            template = source_path(work_dir, example_one) or work_dir / "cache/reidai1/r01011.gif"
        templates = templates_from(template)
        corrections = read_corrections(args.corrections or work_dir / "corrections.json")
        base_backup = read_backup(args.base_backup) if args.base_backup else None

        results = []
        entries = []
        for source in sources:
            number = source["number"]
            item, board = process_source(work_dir, source, templates, corrections.get(number))
            results.append(item)
            if item["status"] in {STATUS_EXTRACTED, STATUS_CORRECTED}:
                entries.append((number, board))

        totals = {"requested": len(results), "exported": len(entries),
                  "review": sum(item["status"] == STATUS_REVIEW for item in results),
                  "unavailable": sum(item["status"] == STATUS_UNAVAILABLE for item in results)}
        write_review(work_dir, results, corrections, totals)
        write_json(work_dir / "results.json", {"totals": totals, "items": results})
        if not entries:
            parser.exit(1, f"出力できる盤面がありません。確認一覧: {work_dir / 'review.html'}\n")
        write_json(output, make_backup(entries, base_backup))
    except (OSError, ValueError, TypeError, KeyError) as error:
        parser.exit(1, f"{error}\n")
    print(f"{totals['exported']}/{totals['requested']}問を書き出しました。"
          f"要確認 {totals['review']}、取得不可 {totals['unavailable']}。")
    print(f"問題集JSON: {output}\n確認一覧: {work_dir / 'review.html'}")


if __name__ == "__main__":
    main()

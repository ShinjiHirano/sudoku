"""Collect the archived example pages and their first full-size illustrations."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import sys
from tempfile import NamedTemporaryFile
from threading import Lock
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


SITE = "https://tagutis1.web.fc2.com/"
ARCHIVE = urljoin(SITE, "reidai1to300.html")
IMAGE_SUFFIXES = {".gif", ".jpg", ".jpeg", ".png"}
ARCHIVE_PAGE = re.compile(r"/reidai(\d+)to([0-9o]+)\.html", re.I)
EXAMPLE_PAGE = re.compile(r"/reidai(\d+)\.html?", re.I)
# The second illustration for example 175 includes its initial grid on the left.
ALTERNATE_INITIAL_IMAGES = {175: urljoin(SITE, "17501211.gif")}


def site_url(base, link):
    parts = urlsplit(urljoin(base, link))
    if parts.netloc.lower() != urlsplit(SITE).netloc or parts.scheme not in {"http", "https"}:
        return None
    if parts.query or any(part in {".", ".."} for part in parts.path.split("/")):
        return None
    return SITE.rstrip("/") + quote(parts.path, safe="/%")


def cache_path(root, url):
    normalized = site_url(SITE, url)
    if not normalized or not urlsplit(normalized).path.strip("/"):
        raise ValueError(f"キャッシュ対象外のURL: {url}")
    return root / "cache" / urlsplit(normalized).path.lstrip("/")


def write_bytes(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(content)
            file.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def write_json(path, value):
    write_bytes(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


class SiteRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        destination = urlsplit(new_url)
        if destination.hostname == "error.fc2.com" and destination.path == "/web/404.html":
            raise HTTPError(request.full_url, 404, "Not Found", headers, fp)
        target = site_url(request.full_url, new_url)
        if target is None:
            raise ValueError(f"サイト外へのリダイレクト: {new_url}")
        return super().redirect_request(request, fp, code, msg, headers, target)


class Cache:
    def __init__(self, root, offline=False):
        self.root = root
        self.offline = offline
        self.lock = Lock()
        self.next_request = 0.0

    def get(self, url):
        path = cache_path(self.root, url)
        if path.is_file():
            return path.read_bytes()
        if self.offline:
            raise FileNotFoundError(f"キャッシュにありません: {url}")

        request = Request(url, headers={"User-Agent": "Numberplace-Archive/1.0"})
        for attempt in range(3):
            with self.lock:
                sleep(max(0, self.next_request - monotonic()))
                self.next_request = monotonic() + 0.25
            try:
                with build_opener(SiteRedirect()).open(request, timeout=12) as response:
                    content = response.read(6_000_001)
                if len(content) > 6_000_000:
                    raise ValueError(f"ファイルが大きすぎます: {url}")
                if not content:
                    raise ValueError(f"空のレスポンス: {url}")
                write_bytes(path, content)
                return content
            except (URLError, TimeoutError) as error:
                if isinstance(error, HTTPError) and error.code not in {408, 429, 500, 502, 503, 504}:
                    raise
                if attempt == 2:
                    raise
                retry_after = error.headers.get("Retry-After", "") if isinstance(error, HTTPError) else ""
                delay = max(2 ** attempt, int(retry_after) if retry_after.isdecimal() else 0)
                if delay > 60:
                    raise
                with self.lock:
                    self.next_request = max(self.next_request, monotonic() + delay)


class Page(HTMLParser):
    def __init__(self, url, content):
        super().__init__()
        self.url = url
        self.links = []
        self.images = []
        encoding = re.search(rb"charset\s*=\s*['\"]?([\w-]+)", content[:4096], re.I)
        charset = encoding[1].decode("ascii").lower() if encoding else "cp932"
        if charset in {"shift_jis", "shift-jis", "sjis"}:
            charset = "cp932"
        try:
            text = content.decode(charset, errors="replace")
        except LookupError:
            text = content.decode("cp932", errors="replace")
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "a" and attrs.get("href"):
            url = site_url(self.url, attrs["href"])
            if url:
                self.links.append(url)
        if tag == "img" and attrs.get("src"):
            url = site_url(self.url, attrs["src"])
            if url and PurePosixPath(urlsplit(url).path).suffix.lower() in IMAGE_SUFFIXES:
                size = [int(value) for key in ("width", "height")
                        if (value := attrs.get(key, "")) and value.isascii() and value.isdecimal()]
                if all(dimension >= 200 for dimension in size) and url not in self.images:
                    self.images.append(url)


def archive_sources(cache, numbers):
    root = Page(ARCHIVE, cache.get(ARCHIVE))
    sources = {}
    for index_url in dict.fromkeys(root.links):
        match = ARCHIVE_PAGE.fullmatch(urlsplit(index_url).path)
        if not match or index_url == ARCHIVE:
            continue
        first, last = int(match[1]), int(match[2].lower().replace("o", "0"))
        index_numbers = {number for number in numbers if first <= number <= last}
        if not index_numbers:
            continue
        try:
            index = Page(index_url, cache.get(index_url))
        except (OSError, ValueError) as error:
            for number in index_numbers:
                sources[number] = {"number": number, "index": index_url, "error": str(error)}
            continue
        for url in dict.fromkeys(index.links):
            example = EXAMPLE_PAGE.fullmatch(urlsplit(url).path)
            if example and (number := int(example[1])) in index_numbers:
                sources[number] = {"number": number, "index": index_url, "page": url}
    return [sources.get(number, {"number": number, "error": "例題一覧にリンクがありません"})
            for number in sorted(numbers)]


def collect_source(cache, source):
    if "page" not in source:
        return source
    try:
        page = Page(source["page"], cache.get(source["page"]))
    except (OSError, ValueError) as error:
        return {**source, "error": f"例題ページを取得できません: {error}"}
    if not page.images:
        return {**source, "error": "例題ページに画像候補がありません"}

    image_url = page.images[0]
    try:
        cache.get(image_url)
    except (OSError, ValueError) as error:
        alternate = ALTERNATE_INITIAL_IMAGES.get(source["number"])
        if alternate in page.images:
            try:
                cache.get(alternate)
                return {**source, "image": alternate, "candidates": page.images,
                        "initial_image_unavailable": image_url}
            except (OSError, ValueError):
                pass
        return {**source, "image": image_url, "candidates": page.images,
                "error": f"先頭の画像を取得できません: {error}"}
    return {**source, "image": image_url}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=Path(".tagutis-import"))
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=800)
    parser.add_argument("--numbers", type=int, nargs="+", help="指定した例題番号のみ収集")
    parser.add_argument("--output", type=Path, help="収集結果JSONの出力先")
    parser.add_argument("--offline", action="store_true", help="キャッシュのみ使用")
    args = parser.parse_args()
    numbers = set(args.numbers or range(args.start, args.end + 1))
    if not numbers or min(numbers) < 1 or max(numbers) > 800:
        parser.error("過去の例題1〜800の範囲で指定してください")
    output = args.output or args.work_dir / f"sources-{min(numbers)}-{max(numbers)}.json"
    cache = Cache(args.work_dir, args.offline)
    try:
        sources = archive_sources(cache, numbers)
    except (OSError, ValueError) as error:
        parser.exit(1, f"例題一覧を取得できません: {error}\n")

    results = []
    with ThreadPoolExecutor(max_workers=2) as workers:
        for result in workers.map(lambda source: collect_source(cache, source), sources):
            results.append(result)
            if len(results) % 25 == 0:
                print(f"収集 {len(results)}/{len(sources)}", file=sys.stderr, flush=True)
    write_json(output, results)
    failures = sum("error" in result for result in results)
    print(f"{len(results) - failures}/{len(results)}件を収集、取得失敗 {failures}件: {output}")


if __name__ == "__main__":
    main()

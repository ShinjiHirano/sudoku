"""Read the red givens in the leftmost grid of an archived example."""

from dataclasses import dataclass
from itertools import groupby

from PIL import Image, ImageChops


TEMPLATE_GRID = (
    "090000070" "100408002" "005030600"
    "070000040" "300806009" "002050100"
    "040000030" "000902000" "006000800"
)
GLYPH_SIZE = (24, 32)
MAX_GLYPH_DISTANCE = 0.24
MIN_GLYPH_MARGIN = 0.025


class BoardError(ValueError):
    pass


@dataclass
class BoardCrop:
    image: Image.Image
    bounds: tuple[int, int, int, int]
    cells: list[tuple[int, int, int, int]]


def open_image(path):
    with Image.open(path) as image:
        if image.width < 200 or image.height < 200:
            raise BoardError("画像が盤面を含むには小さすぎます")
        if getattr(image, "n_frames", 1) > 1:
            raise BoardError("複数フレームの画像です")
        foreground = image.convert("RGBA")
    background = Image.new("RGBA", foreground.size, "white")
    return Image.alpha_composite(background, foreground).convert("RGB")


def line_runs(counts):
    cutoff = max(counts) * 0.60
    positions = [index for index, count in enumerate(counts) if count > cutoff]
    runs = []
    for _, group in groupby(enumerate(positions), lambda entry: entry[1] - entry[0]):
        indexes = [index for _, index in group]
        runs.append((indexes[0], indexes[-1]))
    if len(runs) != 10:
        raise BoardError(f"罫線を10本検出できません（検出 {len(runs)} 本）")
    centers = [(first + last) / 2 for first, last in runs]
    step = (centers[-1] - centers[0]) / 9
    if any(abs(right - left - step) > step * 0.15 for left, right in zip(centers, centers[1:])):
        raise BoardError("罫線の間隔が揃っていません")
    return runs


def box_between(vertical, horizontal, column, row):
    return (vertical[column][1] + 1, horizontal[row][1] + 1,
            vertical[column + 1][0], horizontal[row + 1][0])


def find_board(image):
    left = image.crop((0, 0, image.width // 2, image.height))
    red, green, blue = left.split()
    dark = ImageChops.lighter(red, ImageChops.lighter(green, blue)).point(
        lambda light: int(light < 150)
    ).tobytes()
    width, height = left.size
    vertical = line_runs([dark[x::width].count(1) for x in range(width)])
    horizontal = line_runs([dark[y * width:(y + 1) * width].count(1) for y in range(height)])
    bounds = (vertical[0][0], horizontal[0][0], vertical[-1][1] + 1, horizontal[-1][1] + 1)
    board_width = bounds[2] - bounds[0]
    board_height = bounds[3] - bounds[1]
    if not 0.9 <= board_width / board_height <= 1.1:
        raise BoardError("縦横の罫線が正方形の盤面になりません")
    cells = [box_between(vertical, horizontal, column, row)
             for row in range(9) for column in range(9)]
    return BoardCrop(left, bounds, cells)


def red_mask(image):
    red, green, blue = image.split()
    contrast = ImageChops.subtract(red, ImageChops.lighter(green, blue))
    strong = ImageChops.multiply(
        red.point(lambda value: 255 if value > 165 else 0),
        contrast.point(lambda value: 255 if value > 70 else 0),
    )
    return strong, contrast


def glyph(mask):
    bounds = mask.getbbox()
    if bounds is None:
        return None
    return mask.crop(bounds).resize(GLYPH_SIZE, Image.Resampling.BILINEAR).tobytes()


def templates_from(path):
    crop = find_board(open_image(path))
    mask, _ = red_mask(crop.image)
    templates = {}
    for digit in range(1, 10):
        index = TEMPLATE_GRID.index(str(digit))
        template = glyph(mask.crop(crop.cells[index]))
        if template is None:
            raise BoardError(f"見本画像の数字 {digit} を読み取れません")
        templates[digit] = template
    return templates


def classify(digit, templates):
    scores = sorted(
        (sum(abs(a - b) for a, b in zip(digit, template)) / (len(digit) * 255), number)
        for number, template in templates.items()
    )
    best, number = scores[0]
    return number, best, scores[1][0] - best


def possible_missing_digit(cell, contrast):
    inset_x = max(2, round(cell.width * 0.10))
    inset_y = max(2, round(cell.height * 0.10))
    inner = (inset_x, inset_y, cell.width - inset_x, cell.height - inset_y)
    inner_gray = cell.crop(inner).convert("L")
    inner_contrast = contrast.crop(inner)
    dark = sum(inner_gray.histogram()[:125])
    pale_red = sum(inner_contrast.histogram()[43:])
    return max(dark, pale_red) > inner_gray.width * inner_gray.height * 0.025


def read_board(crop, templates):
    mask, contrast = red_mask(crop.image)
    cells = []
    uncertain = []
    for index, box in enumerate(crop.cells):
        cell_mask = mask.crop(box)
        digit = glyph(cell_mask)
        if digit is None:
            cells.append(0)
            if possible_missing_digit(crop.image.crop(box), contrast.crop(box)):
                uncertain.append({"cell": index, "reason": "空欄に薄い数字または暗い印があります"})
            continue

        number, distance, margin = classify(digit, templates)
        cells.append(number)
        ink = cell_mask.histogram()[255] / (cell_mask.width * cell_mask.height)
        if distance > MAX_GLYPH_DISTANCE or margin < MIN_GLYPH_MARGIN or ink < 0.018:
            uncertain.append({"cell": index, "reason": "数字の候補が曖昧です",
                              "distance": round(distance, 3), "margin": round(margin, 3)})
    return cells, uncertain


def solution_count(board):
    """Count up to two solutions, or request review if the search is too large."""
    rows = [0] * 9
    columns = [0] * 9
    boxes = [0] * 9
    empty = []
    all_digits = (1 << 9) - 1
    for index, digit in enumerate(board):
        row, column = divmod(index, 9)
        box = row // 3 * 3 + column // 3
        if not digit:
            empty.append((row, column, box))
            continue
        bit = 1 << (digit - 1)
        if bit & (rows[row] | columns[column] | boxes[box]):
            return 0
        rows[row] |= bit
        columns[column] |= bit
        boxes[box] |= bit

    steps = 0

    def visit(depth, limit):
        nonlocal steps
        steps += 1
        if steps > 1_000_000:
            raise BoardError("解の個数を判定できる探索範囲を超えました")
        if depth == len(empty):
            return 1

        best_index = depth
        best_bits = all_digits
        for index in range(depth, len(empty)):
            row, column, box = empty[index]
            available = all_digits & ~(rows[row] | columns[column] | boxes[box])
            if not available:
                return 0
            if available.bit_count() < best_bits.bit_count():
                best_index, best_bits = index, available
                if best_bits.bit_count() == 1:
                    break

        row, column, box = empty[best_index]
        empty[depth], empty[best_index] = empty[best_index], empty[depth]
        count = 0
        while best_bits and count < limit:
            bit = best_bits & -best_bits
            best_bits ^= bit
            rows[row] |= bit
            columns[column] |= bit
            boxes[box] |= bit
            count += visit(depth + 1, limit - count)
            rows[row] ^= bit
            columns[column] ^= bit
            boxes[box] ^= bit
        empty[depth], empty[best_index] = empty[best_index], empty[depth]
        return count

    return visit(0, 2)

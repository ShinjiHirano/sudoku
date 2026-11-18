import { createWorker } from 'tesseract.js';
import type { Digit } from './types';

export interface OcrResult {
  values: Digit[];
  confidence: number[];
}

export interface OcrCellResult {
  value: Digit;
  confidence: number;
}

export interface GridCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GridLines {
  horizontal: number[];
  vertical: number[];
}

interface PreparedCell {
  canvas: HTMLCanvasElement;
  inkRatio: number;
}

export function cropGrid(image: HTMLImageElement, crop: GridCrop): HTMLCanvasElement {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const x = Math.round(sourceWidth * crop.left);
  const y = Math.round(sourceHeight * crop.top);
  const width = Math.round(sourceWidth * (crop.right - crop.left));
  const height = Math.round(sourceHeight * (crop.bottom - crop.top));
  if (width < 90 || height < 90) throw new Error('切り出し範囲が小さすぎます。');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像処理を開始できません。');
  ctx.drawImage(image, x, y, width, height, 0, 0, width, height);
  return canvas;
}

function grayAt(data: Uint8ClampedArray, offset: number): number {
  return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
}

/** Finds the centers of dark, full-length grid lines in one image direction. */
function lineCenters(image: ImageData, vertical: boolean): number[] {
  const { width, height, data } = image;
  const length = vertical ? width : height;
  const crossLength = vertical ? height : width;
  const projection = Array<number>(length).fill(0);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      projection[vertical ? x : y] += 255 - grayAt(data, offset);
    }
  }

  const averages = projection.map((value) => value / crossLength);
  const minimum = Math.min(...averages);
  const maximum = Math.max(...averages);
  const threshold = minimum + (maximum - minimum) * 0.6;
  const centers: number[] = [];
  let start = -1;

  for (let index = 0; index <= averages.length; index += 1) {
    const isLine = index < averages.length && averages[index] >= threshold;
    if (isLine && start < 0) start = index;
    if (!isLine && start >= 0) {
      const end = index - 1;
      let weightedPosition = 0;
      let weight = 0;
      for (let point = start; point <= end; point += 1) {
        const pointWeight = averages[point] - minimum;
        weightedPosition += point * pointWeight;
        weight += pointWeight;
      }
      centers.push(weight ? weightedPosition / weight : (start + end) / 2);
      start = -1;
    }
  }
  return centers;
}

function evenlySpacedLines(width: number, height: number): GridLines {
  return {
    vertical: Array.from({ length: 10 }, (_, index) => width * index / 9),
    horizontal: Array.from({ length: 10 }, (_, index) => height * index / 9),
  };
}

function evenlySpaced(positions: number[], expectedStep: number): boolean {
  return positions.every((position, index) => {
    if (index === 0) return true;
    const step = position - positions[index - 1];
    return step > expectedStep * 0.55 && step < expectedStep * 1.45;
  });
}

/**
 * Uses the printed grid itself to find cell boundaries. A manual crop is still
 * accepted, and falls back to nine equal parts when its lines are not clear.
 */
function detectGridLines(source: CanvasImageSource, width: number, height: number): GridLines {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('画像処理を開始できません。');
  context.drawImage(source, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const vertical = lineCenters(image, true);
  const horizontal = lineCenters(image, false);
  if (vertical.length === 10 && horizontal.length === 10
    && evenlySpaced(vertical, width / 9) && evenlySpaced(horizontal, height / 9)) {
    return { vertical, horizontal };
  }
  return evenlySpacedLines(width, height);
}

/** Removes the detected grid strokes before character recognition. */
function removeGridLines(source: CanvasImageSource, lines: GridLines, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('画像処理を開始できません。');
  context.drawImage(source, 0, 0, width, height);
  const cellSize = Math.min(width, height) / 9;
  const halfStroke = Math.max(2, Math.round(cellSize * 0.045));
  context.fillStyle = '#fff';
  lines.vertical.forEach((position) => context.fillRect(position - halfStroke, 0, halfStroke * 2, height));
  lines.horizontal.forEach((position) => context.fillRect(0, position - halfStroke, width, halfStroke * 2));
  return canvas;
}

function cropCell(source: CanvasImageSource, lines: GridLines, row: number, col: number, trimRatio = 0.12, threshold = 175): PreparedCell {
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画像処理を開始できません。');
  const left = lines.vertical[col];
  const top = lines.horizontal[row];
  const cellWidth = lines.vertical[col + 1] - left;
  const cellHeight = lines.horizontal[row + 1] - top;
  const trimX = cellWidth * trimRatio;
  const trimY = cellHeight * trimRatio;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, left + trimX, top + trimY, cellWidth - trimX * 2, cellHeight - trimY * 2, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let darkPixels = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const gray = grayAt(image.data, i);
    const pixel = gray > threshold ? 255 : 0;
    if (pixel === 0) darkPixels += 1;
    image.data[i] = pixel;
    image.data[i + 1] = pixel;
    image.data[i + 2] = pixel;
  }
  ctx.putImageData(image, 0, 0);
  return { canvas, inkRatio: darkPixels / (canvas.width * canvas.height) };
}

async function createDigitWorker() {
  const worker = await createWorker('eng', 1, { logger: () => undefined, legacyCore: false, legacyLang: false });
  await worker.setParameters({
    tessedit_char_whitelist: '123456789',
    tessedit_pageseg_mode: '10' as Tesseract.PSM,
  });
  return worker;
}

async function recognizePreparedCell(worker: Awaited<ReturnType<typeof createDigitWorker>>, cell: PreparedCell): Promise<OcrCellResult> {
  if (cell.inkRatio < 0.012) return { value: 0, confidence: 100 };
  const { data } = await worker.recognize(cell.canvas, {}, { text: true, blocks: false, hocr: false, tsv: false });
  const digitText = data.text.replace(/\s/g, '');
  return {
    value: /^[1-9]$/.test(digitText) ? Number(digitText) as Digit : 0,
    confidence: /^[1-9]$/.test(digitText) ? data.confidence : 0,
  };
}

/**
 * The selected picture must be cropped to the outer edge of a square 9x9 grid.
 * Values read as a single digit are retained even at low confidence, so the
 * caller can review a useful draft instead of re-entering omitted clues.
 */
export async function recognizeGrid(
  image: CanvasImageSource,
  width: number,
  height: number,
  onProgress: (completed: number, total: number) => void,
): Promise<OcrResult> {
  const worker = await createDigitWorker();
  const values: Digit[] = [];
  const confidence: number[] = [];
  try {
    const lines = detectGridLines(image, width, height);
    const gridless = removeGridLines(image, lines, width, height);
    for (let index = 0; index < 81; index += 1) {
      const cell = cropCell(gridless, lines, Math.floor(index / 9), index % 9);
      const result = await recognizePreparedCell(worker, cell);
      values.push(result.value);
      confidence.push(result.confidence);
      onProgress(index + 1, 81);
    }
  } finally {
    await worker.terminate();
  }
  return { values, confidence };
}

/** Re-reads one selected cell with several crop and contrast variants. */
export async function recognizeCellVariants(
  image: CanvasImageSource,
  width: number,
  height: number,
  index: number,
  onProgress: (completed: number, total: number) => void,
): Promise<OcrCellResult> {
  const variants = [
    { trimRatio: 0.08, threshold: 155 },
    { trimRatio: 0.12, threshold: 175 },
    { trimRatio: 0.16, threshold: 195 },
  ];
  const worker = await createDigitWorker();
  const lines = detectGridLines(image, width, height);
  const gridless = removeGridLines(image, lines, width, height);
  let best: OcrCellResult = { value: 0, confidence: 0 };
  try {
    for (const [variantIndex, variant] of variants.entries()) {
      const cell = cropCell(gridless, lines, Math.floor(index / 9), index % 9, variant.trimRatio, variant.threshold);
      const result = await recognizePreparedCell(worker, cell);
      if (result.value && result.confidence >= best.confidence) best = result;
      onProgress(variantIndex + 1, variants.length);
    }
  } finally {
    await worker.terminate();
  }
  return best;
}

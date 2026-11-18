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

export interface GridPoint {
  x: number;
  y: number;
}

/** Clockwise: top-left, top-right, bottom-right, bottom-left. */
export type GridCorners = [GridPoint, GridPoint, GridPoint, GridPoint];

interface GridLines {
  horizontal: number[];
  vertical: number[];
}

interface PreparedCell {
  canvas: HTMLCanvasElement;
  inkRatio: number;
}

function solveLinearSystem(matrix: number[][]): number[] {
  const size = matrix.length;
  for (let pivot = 0; pivot < size; pivot += 1) {
    let bestRow = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[bestRow][pivot])) bestRow = row;
    }
    if (Math.abs(matrix[bestRow][pivot]) < 1e-9) throw new Error('四隅の指定が不正です。');
    [matrix[pivot], matrix[bestRow]] = [matrix[bestRow], matrix[pivot]];
    const divisor = matrix[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) matrix[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let column = pivot; column <= size; column += 1) matrix[row][column] -= factor * matrix[pivot][column];
    }
  }
  return matrix.map((row) => row[size]);
}

/** Rectifies a manually selected quadrilateral into a square canvas. */
export function warpGrid(image: HTMLImageElement, corners: GridCorners, size = 900): HTMLCanvasElement {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  if (sourceWidth < 90 || sourceHeight < 90) throw new Error('画像が小さすぎます。');
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('画像処理を開始できません。');
  sourceContext.drawImage(image, 0, 0);
  const source = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight);
  const destination = document.createElement('canvas');
  destination.width = size;
  destination.height = size;
  const destinationContext = destination.getContext('2d');
  if (!destinationContext) throw new Error('画像処理を開始できません。');

  const unitCorners: GridPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const equations: number[][] = [];
  unitCorners.forEach((point, index) => {
    const targetX = corners[index].x * sourceWidth;
    const targetY = corners[index].y * sourceHeight;
    equations.push([point.x, point.y, 1, 0, 0, 0, -point.x * targetX, -point.y * targetX, targetX]);
    equations.push([0, 0, 0, point.x, point.y, 1, -point.x * targetY, -point.y * targetY, targetY]);
  });
  const [a, b, c, d, e, f, g, h] = solveLinearSystem(equations);
  const output = destinationContext.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1);
      const divisor = g * u + h * v + 1;
      const sourceX = Math.round((a * u + b * v + c) / divisor);
      const sourceY = Math.round((d * u + e * v + f) / divisor);
      const outputOffset = (y * size + x) * 4;
      if (sourceX < 0 || sourceX >= sourceWidth || sourceY < 0 || sourceY >= sourceHeight) continue;
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      output.data[outputOffset] = source.data[sourceOffset];
      output.data[outputOffset + 1] = source.data[sourceOffset + 1];
      output.data[outputOffset + 2] = source.data[sourceOffset + 2];
      output.data[outputOffset + 3] = 255;
    }
  }
  destinationContext.putImageData(output, 0, 0);
  return destination;
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

async function recognizePreparedCell(worker: Awaited<ReturnType<typeof createDigitWorker>>, cell: PreparedCell, skipLikelyBlank = true): Promise<OcrCellResult> {
  if (skipLikelyBlank && cell.inkRatio < 0.012) return { value: 0, confidence: 100 };
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
  const worker = await createDigitWorker();
  const lines = detectGridLines(image, width, height);
  const gridless = removeGridLines(image, lines, width, height);
  const variants: Array<{ source: CanvasImageSource; trimRatio: number; threshold: number }> = [
    { source: gridless, trimRatio: 0.05, threshold: 125 },
    { source: gridless, trimRatio: 0.10, threshold: 150 },
    { source: gridless, trimRatio: 0.14, threshold: 175 },
    { source: gridless, trimRatio: 0.18, threshold: 200 },
    // Keep one image with the original strokes in case line removal touched a digit.
    { source: image, trimRatio: 0.20, threshold: 175 },
  ];
  let best: OcrCellResult = { value: 0, confidence: 0 };
  try {
    for (const [variantIndex, variant] of variants.entries()) {
      const cell = cropCell(variant.source, lines, Math.floor(index / 9), index % 9, variant.trimRatio, variant.threshold);
      const result = await recognizePreparedCell(worker, cell, false);
      if (result.value && result.confidence >= best.confidence) best = result;
      onProgress(variantIndex + 1, variants.length);
    }
  } finally {
    await worker.terminate();
  }
  return best;
}

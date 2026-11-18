import { createWorker } from 'tesseract.js';
import type { Digit } from './types';

export interface OcrResult {
  values: Digit[];
  confidence: number[];
  /** The locally rectified grid image used for OCR review. */
  preview: HTMLCanvasElement;
  /** The cropped and binarized image passed directly to OCR. */
  inputPreview: HTMLCanvasElement;
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

const OCR_CELL_SIZE = 240;

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

function imageDataFromSource(source: CanvasImageSource, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('画像処理を開始できません。');
  context.drawImage(source, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function smoothPath(path: number[], radius = 6): number[] {
  return path.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let point = Math.max(0, index - radius); point <= Math.min(path.length - 1, index + radius); point += 1) {
      sum += path[point];
      count += 1;
    }
    return sum / count;
  });
}

/** Tracks one printed grid line so a gently curved page need not be treated as flat. */
function traceGridLine(image: ImageData, center: number, vertical: boolean): number[] {
  const { width, height, data } = image;
  const pathLength = vertical ? height : width;
  const crossLength = vertical ? width : height;
  const radius = Math.max(5, Math.round(crossLength / 9 * 0.2));
  const thickness = 3;
  const path: number[] = [];
  for (let point = 0; point < pathLength; point += 1) {
    let bestPosition = center;
    let bestScore = -Infinity;
    const start = Math.max(0, Math.round(center - radius));
    const end = Math.min(crossLength - 1, Math.round(center + radius));
    for (let candidate = start; candidate <= end; candidate += 1) {
      let score = 0;
      for (let offset = -thickness; offset <= thickness; offset += 1) {
        const along = Math.max(0, Math.min(pathLength - 1, point + offset));
        const x = vertical ? candidate : along;
        const y = vertical ? along : candidate;
        score += 255 - grayAt(data, (y * width + x) * 4);
      }
      if (score > bestScore) {
        bestScore = score;
        bestPosition = candidate;
      }
    }
    path.push(bestPosition);
  }
  return smoothPath(path);
}

function gridIntersections(image: ImageData, lines: GridLines): GridPoint[][] {
  const verticalPaths = lines.vertical.map((center) => traceGridLine(image, center, true));
  const horizontalPaths = lines.horizontal.map((center) => traceGridLine(image, center, false));
  return lines.horizontal.map((horizontalCenter, row) => lines.vertical.map((verticalCenter, column) => {
    let x = verticalCenter;
    let y = horizontalCenter;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      y = horizontalPaths[row][Math.max(0, Math.min(image.width - 1, Math.round(x)))];
      x = verticalPaths[column][Math.max(0, Math.min(image.height - 1, Math.round(y)))];
    }
    return { x, y };
  }));
}

function cellCorners(intersections: GridPoint[][], index: number): GridCorners {
  const row = Math.floor(index / 9);
  const column = index % 9;
  return [intersections[row][column], intersections[row][column + 1], intersections[row + 1][column + 1], intersections[row + 1][column]];
}

/** Locally rectifies one cell from its four stable grid intersections. */
function warpCell(source: ImageData, corners: GridCorners, size = OCR_CELL_SIZE): HTMLCanvasElement {
  const { width, height, data } = source;
  const unitCorners: GridPoint[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const equations: number[][] = [];
  unitCorners.forEach((point, index) => {
    const target = corners[index];
    equations.push([point.x, point.y, 1, 0, 0, 0, -point.x * target.x, -point.y * target.x, target.x]);
    equations.push([0, 0, 0, point.x, point.y, 1, -point.x * target.y, -point.y * target.y, target.y]);
  });
  const [a, b, c, d, e, f, g, h] = solveLinearSystem(equations);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('画像処理を開始できません。');
  const output = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    const v = y / (size - 1);
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1);
      const divisor = g * u + h * v + 1;
      const sourceX = Math.round((a * u + b * v + c) / divisor);
      const sourceY = Math.round((d * u + e * v + f) / divisor);
      if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) continue;
      const inputOffset = (sourceY * width + sourceX) * 4;
      const outputOffset = (y * size + x) * 4;
      output.data[outputOffset] = data[inputOffset];
      output.data[outputOffset + 1] = data[inputOffset + 1];
      output.data[outputOffset + 2] = data[inputOffset + 2];
      output.data[outputOffset + 3] = 255;
    }
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

/** Crops the outer 10% of each cell, where printed grid strokes live. */
function prepareWarpedCell(source: HTMLCanvasElement, trimRatio = 0.10, threshold = 135): PreparedCell {
  const canvas = document.createElement('canvas');
  canvas.width = OCR_CELL_SIZE;
  canvas.height = OCR_CELL_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('画像処理を開始できません。');
  const trim = source.width * trimRatio;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, trim, trim, source.width - trim * 2, source.height - trim * 2, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let darkPixels = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      const pixel = grayAt(image.data, offset) <= threshold ? 0 : 255;
      if (pixel === 0) darkPixels += 1;
      image.data[offset] = pixel;
      image.data[offset + 1] = pixel;
      image.data[offset + 2] = pixel;
    }
  }
  context.putImageData(image, 0, 0);
  return { canvas, inkRatio: darkPixels / (canvas.width * canvas.height) };
}

/** Rebuilds a board from its locally rectified cells so the OCR geometry is inspectable. */
function composeRectifiedPreview(cells: HTMLCanvasElement[]): HTMLCanvasElement {
  const cellSize = 100;
  const canvas = document.createElement('canvas');
  canvas.width = cellSize * 9;
  canvas.height = cellSize * 9;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('画像処理を開始できません。');
  cells.forEach((cell, index) => {
    const x = (index % 9) * cellSize;
    const y = Math.floor(index / 9) * cellSize;
    context.drawImage(cell, x, y, cellSize, cellSize);
  });
  return canvas;
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
  if (skipLikelyBlank && cell.inkRatio < 0.004) return { value: 0, confidence: 100 };
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
  const warpedCells: HTMLCanvasElement[] = [];
  const preparedCells: HTMLCanvasElement[] = [];
  try {
    const source = imageDataFromSource(image, width, height);
    const lines = detectGridLines(image, width, height);
    const intersections = gridIntersections(source, lines);
    for (let index = 0; index < 81; index += 1) {
      const warpedCell = warpCell(source, cellCorners(intersections, index));
      warpedCells.push(warpedCell);
      const cell = prepareWarpedCell(warpedCell);
      preparedCells.push(cell.canvas);
      const result = await recognizePreparedCell(worker, cell);
      values.push(result.value);
      confidence.push(result.confidence);
      onProgress(index + 1, 81);
    }
  } finally {
    await worker.terminate();
  }
  return {
    values,
    confidence,
    preview: composeRectifiedPreview(warpedCells),
    inputPreview: composeRectifiedPreview(preparedCells),
  };
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
  const variants: Array<{ trimRatio: number; threshold: number }> = [
    { trimRatio: 0.06, threshold: 105 },
    { trimRatio: 0.08, threshold: 120 },
    { trimRatio: 0.10, threshold: 135 },
    { trimRatio: 0.12, threshold: 150 },
    { trimRatio: 0.14, threshold: 165 },
  ];
  let best: OcrCellResult = { value: 0, confidence: 0 };
  try {
    const source = imageDataFromSource(image, width, height);
    const lines = detectGridLines(image, width, height);
    const intersections = gridIntersections(source, lines);
    const warpedCell = warpCell(source, cellCorners(intersections, index));
    for (const [variantIndex, variant] of variants.entries()) {
      const cell = prepareWarpedCell(warpedCell, variant.trimRatio, variant.threshold);
      const result = await recognizePreparedCell(worker, cell, false);
      if (result.value && result.confidence >= best.confidence) best = result;
      onProgress(variantIndex + 1, variants.length);
    }
  } finally {
    await worker.terminate();
  }
  return best;
}

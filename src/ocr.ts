import { createWorker } from 'tesseract.js';
import type { Digit } from './types';

export interface OcrResult {
  values: Digit[];
  confidence: number[];
}

export interface GridCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
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

function cropCell(source: CanvasImageSource, width: number, height: number, row: number, col: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('画像処理を開始できません。');
  const cellWidth = width / 9;
  const cellHeight = height / 9;
  const trimX = cellWidth * 0.12;
  const trimY = cellHeight * 0.12;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, col * cellWidth + trimX, row * cellHeight + trimY, cellWidth - trimX * 2, cellHeight - trimY * 2, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < image.data.length; i += 4) {
    const gray = image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
    const pixel = gray > 175 ? 255 : 0;
    image.data[i] = pixel;
    image.data[i + 1] = pixel;
    image.data[i + 2] = pixel;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The selected picture must be cropped to the outer edge of a square 9x9 grid.
 * Recognition is deliberately conservative: untrusted values become blank and are
 * highlighted for correction by the caller.
 */
export async function recognizeGrid(
  image: CanvasImageSource,
  width: number,
  height: number,
  onProgress: (completed: number, total: number) => void,
): Promise<OcrResult> {
  const worker = await createWorker('eng', 1, { logger: () => undefined, legacyCore: false, legacyLang: false });
  const values: Digit[] = [];
  const confidence: number[] = [];
  try {
    for (let index = 0; index < 81; index += 1) {
      const cell = cropCell(image, width, height, Math.floor(index / 9), index % 9);
      const { data } = await worker.recognize(cell, {}, { text: true, blocks: false, hocr: false, tsv: false });
      const digitText = data.text.replace(/\s/g, '');
      const digit = /^[1-9]$/.test(digitText) && data.confidence >= 55 ? Number(digitText) as Digit : 0;
      values.push(digit);
      confidence.push(digit ? data.confidence : 0);
      onProgress(index + 1, 81);
    }
  } finally {
    await worker.terminate();
  }
  return { values, confidence };
}

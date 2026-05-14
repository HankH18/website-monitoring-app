import fs from "fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { logger } from "../logger";

export interface DiffBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelDiffResult {
  diffPercent: number;
  diffPixels: number;
  totalPixels: number;
  diffImagePath?: string;
  diff_bbox?: DiffBbox | null;
}

// Fraction of image area above which a bbox is considered "too scattered" to
// crop usefully. Above this, send the full page instead.
const SCATTERED_BBOX_AREA_THRESHOLD = 0.8;

// Padding added on each side of the tight diff bbox (as a fraction of the
// bbox's width/height), clamped to image bounds.
const BBOX_PADDING_FRACTION = 0.1;

export function compareScreenshots(
  referencePath: string,
  currentPath: string,
  diffOutputPath?: string,
): PixelDiffResult {
  const refBuf = fs.readFileSync(referencePath);
  const curBuf = fs.readFileSync(currentPath);

  const refPng = PNG.sync.read(refBuf);
  const curPng = PNG.sync.read(curBuf);

  // If sizes differ, normalize to the larger dimensions
  const width = Math.max(refPng.width, curPng.width);
  const height = Math.max(refPng.height, curPng.height);

  const refNorm = normalizeSize(refPng, width, height);
  const curNorm = normalizeSize(curPng, width, height);

  const diff = new PNG({ width, height });
  const totalPixels = width * height;

  const diffPixels = pixelmatch(refNorm.data, curNorm.data, diff.data, width, height, {
    threshold: 0.1,
    alpha: 0.3,
  });

  const diffPercent = (diffPixels / totalPixels) * 100;

  let diffImagePath: string | undefined;
  if (diffOutputPath) {
    fs.writeFileSync(diffOutputPath, PNG.sync.write(diff));
    diffImagePath = diffOutputPath;
  }

  logger.debug(`Pixel diff: ${diffPercent.toFixed(2)}% (${diffPixels}/${totalPixels} pixels)`);

  const diff_bbox = computeDiffBbox(diff.data, width, height);

  return { diffPercent, diffPixels, totalPixels, diffImagePath, diff_bbox };
}

// Walk the pixelmatch output buffer to find the bounding box of changed
// pixels. Pixelmatch paints diff pixels red (R≈255, G≈0, B≈0). Pure pass-through
// pixels are written semi-transparent grayscale (alpha=alpha option), so the
// red channel alone is a reliable signal: changed pixels have R high and G low.
function computeDiffBbox(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
): DiffBbox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      const r = data[i];
      const g = data[i + 1];
      // Pixelmatch marks diffs in red. Use a conservative test.
      if (r > 200 && g < 100) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    // Zero changed pixels.
    return null;
  }

  // Tight bbox.
  const tightW = maxX - minX + 1;
  const tightH = maxY - minY + 1;

  // Add padding on each side (clamped to image bounds).
  const padX = Math.round(tightW * BBOX_PADDING_FRACTION);
  const padY = Math.round(tightH * BBOX_PADDING_FRACTION);

  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  const right = Math.min(width, maxX + 1 + padX);
  const bottom = Math.min(height, maxY + 1 + padY);
  const bboxW = right - x;
  const bboxH = bottom - y;

  // If changes are scattered across most of the page, cropping doesn't help.
  const totalArea = width * height;
  const bboxArea = bboxW * bboxH;
  if (totalArea > 0 && bboxArea / totalArea > SCATTERED_BBOX_AREA_THRESHOLD) {
    return null;
  }

  return { x, y, width: bboxW, height: bboxH };
}

function normalizeSize(png: PNG, targetWidth: number, targetHeight: number): PNG {
  if (png.width === targetWidth && png.height === targetHeight) return png;

  const result = new PNG({ width: targetWidth, height: targetHeight, fill: true });
  // Fill with white background
  for (let i = 0; i < result.data.length; i += 4) {
    result.data[i] = 255;
    result.data[i + 1] = 255;
    result.data[i + 2] = 255;
    result.data[i + 3] = 255;
  }

  // Copy original image data
  PNG.bitblt(png, result, 0, 0, png.width, png.height, 0, 0);
  return result;
}

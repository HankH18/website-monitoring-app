import fs from "fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { logger } from "../logger";

export interface PixelDiffResult {
  diffPercent: number;
  diffPixels: number;
  totalPixels: number;
  diffImagePath?: string;
}

export function compareScreenshots(
  referencePath: string,
  currentPath: string,
  diffOutputPath?: string
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

  logger.debug(
    `Pixel diff: ${diffPercent.toFixed(2)}% (${diffPixels}/${totalPixels} pixels)`
  );

  return { diffPercent, diffPixels, totalPixels, diffImagePath };
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

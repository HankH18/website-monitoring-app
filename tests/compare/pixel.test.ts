import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { compareScreenshots } from "../../src/compare/pixel";

function writeWhitePng(filePath: string, width: number, height: number): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function writeWhitePngWithBlackPixels(
  filePath: string,
  width: number,
  height: number,
  blackPixelCount: number,
): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255;
    png.data[i + 1] = 255;
    png.data[i + 2] = 255;
    png.data[i + 3] = 255;
  }
  // Paint the first N pixels black (RGB=0,0,0).
  for (let p = 0; p < blackPixelCount; p++) {
    const idx = p * 4;
    png.data[idx] = 0;
    png.data[idx + 1] = 0;
    png.data[idx + 2] = 0;
    png.data[idx + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pageguard-pixel-test-"));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("compareScreenshots", () => {
  it("returns 0% diff for two identical 10×10 white PNGs", () => {
    const a = path.join(tmpDir, "a.png");
    const b = path.join(tmpDir, "b.png");
    writeWhitePng(a, 10, 10);
    writeWhitePng(b, 10, 10);

    const result = compareScreenshots(a, b);
    expect(result.totalPixels).toBe(100);
    expect(result.diffPixels).toBe(0);
    expect(result.diffPercent).toBe(0);
    expect(result.diffImagePath).toBeUndefined();
  });

  it("returns ~50% diff when 50 of 100 pixels differ", () => {
    const ref = path.join(tmpDir, "ref.png");
    const cur = path.join(tmpDir, "cur.png");
    writeWhitePng(ref, 10, 10);
    writeWhitePngWithBlackPixels(cur, 10, 10, 50);

    const result = compareScreenshots(ref, cur);
    expect(result.totalPixels).toBe(100);
    // White vs solid black is well above the threshold=0.1 cutoff, so all
    // 50 painted pixels register as diffs.
    expect(result.diffPixels).toBe(50);
    expect(result.diffPercent).toBe(50);
  });

  it("writes a diff PNG when diffOutputPath is supplied", () => {
    const ref = path.join(tmpDir, "ref.png");
    const cur = path.join(tmpDir, "cur.png");
    const out = path.join(tmpDir, "diff.png");
    writeWhitePng(ref, 6, 6);
    writeWhitePngWithBlackPixels(cur, 6, 6, 4);

    const result = compareScreenshots(ref, cur, out);
    expect(result.diffImagePath).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
    // Should be a valid PNG we can decode back.
    const buf = fs.readFileSync(out);
    const decoded = PNG.sync.read(buf);
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(6);
  });

  it("handles different dimensions by normalizing to the larger size", () => {
    // 5x5 white vs 10x10 white. After normalize-to-larger (10x10) with
    // white fill padding, both should be all-white => 0 diff pixels.
    const small = path.join(tmpDir, "small.png");
    const big = path.join(tmpDir, "big.png");
    writeWhitePng(small, 5, 5);
    writeWhitePng(big, 10, 10);

    const result = compareScreenshots(small, big);
    expect(result.totalPixels).toBe(100); // max(5,10) * max(5,10)
    expect(result.diffPixels).toBe(0);
    expect(result.diffPercent).toBe(0);
  });
});

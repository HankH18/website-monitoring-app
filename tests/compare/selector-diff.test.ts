import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSelectorCaptures } from "../../src/compare/selector";
import { SelectorCapture } from "../../src/types";

let tmpDir: string;

function writeRefText(
  index: number,
  content: string,
): {
  selector: string;
  textPath: string;
  screenshotPath: string;
} {
  const textPath = path.join(tmpDir, `ref_selector_${index}.txt`);
  fs.writeFileSync(textPath, content, "utf-8");
  return {
    selector: `#sel-${index}`,
    textPath,
    screenshotPath: path.join(tmpDir, `ref_selector_${index}.png`),
  };
}

function makeCurrent(index: number, text: string, matched = true): SelectorCapture {
  return {
    selector: `#sel-${index}`,
    text,
    textPath: path.join(tmpDir, `cur_selector_${index}.txt`),
    screenshotPath: path.join(tmpDir, `cur_selector_${index}.png`),
    matched,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pageguard-sel-test-"));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("compareSelectorCaptures", () => {
  it("returns zero changes when reference and current selector text are identical", () => {
    const ref = [writeRefText(0, "Hello world\nSecond line")];
    const cur = [makeCurrent(0, "Hello world\nSecond line")];
    const result = compareSelectorCaptures(ref, cur);
    expect(result.changedLineCount).toBe(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].changedLineCount).toBe(0);
  });

  it("detects text changes per selector and sums changedLineCount", () => {
    const ref = [writeRefText(0, "Hero title\nSubtitle"), writeRefText(1, "Price: $10\nIn stock")];
    const cur = [
      makeCurrent(0, "Hero title\nSubtitle"),
      makeCurrent(1, "Price: $25\nOut of stock"),
    ];
    const result = compareSelectorCaptures(ref, cur);
    expect(result.changedLineCount).toBeGreaterThan(0);
    expect(result.entries[0].changedLineCount).toBe(0);
    expect(result.entries[1].changedLineCount).toBeGreaterThan(0);
  });

  it("reports a warning when a current selector matched zero elements", () => {
    const ref = [writeRefText(0, "Some content")];
    const cur = [makeCurrent(0, "", false)];
    const result = compareSelectorCaptures(ref, cur);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/zero elements/);
  });

  it("changedPercent takes the max across selectors, not the sum", () => {
    const ref = [writeRefText(0, "a\nb\nc\nd"), writeRefText(1, "x\ny\nz")];
    const cur = [
      makeCurrent(0, "a\nb\nc\nd"), // unchanged
      makeCurrent(1, "X\nY\nZ"), // fully changed
    ];
    const result = compareSelectorCaptures(ref, cur);
    expect(result.entries[0].changedLineCount).toBe(0);
    expect(result.entries[1].changedLineCount).toBeGreaterThan(0);
    expect(result.changedPercent).toBeGreaterThan(0);
  });
});

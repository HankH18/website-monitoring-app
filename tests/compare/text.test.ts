import { describe, it, expect } from "vitest";
import { compareText } from "../../src/compare/text";

describe("compareText", () => {
  it("returns zero changed lines for identical strings", () => {
    const text = "hello world\nthis is line two\nfinal line";
    const result = compareText(text, text);
    expect(result.changedLineCount).toBe(0);
    expect(result.diffSummary).toBe("");
  });

  it("counts every meaningful line as changed for completely different content", () => {
    const a = "alpha\nbeta\ngamma";
    const b = "one\ntwo\nthree\nfour";
    const result = compareText(a, b);
    expect(result.changedLineCount).toBeGreaterThanOrEqual(4);
    expect(result.diffSummary).toContain("+ one");
    expect(result.diffSummary).toContain("- alpha");
  });

  it("detects a single added word as one meaningful change", () => {
    const a = "the quick brown fox\njumps over the lazy dog";
    const b = "the quick brown fox\njumps over the very lazy dog";
    const result = compareText(a, b);
    expect(result.changedLineCount).toBe(2);
    expect(result.diffSummary).toContain("very");
  });

  it("ignores Shopify-style cart badge count changes", () => {
    const a = "Home\nProducts\ncart (0)\nCheckout";
    const b = "Home\nProducts\ncart (3)\nCheckout";
    const result = compareText(a, b);
    expect(result.changedLineCount).toBe(0);
    expect(result.diffSummary).toBe("");
  });

  it("ignores timestamp-only changes", () => {
    const a = "Welcome\n12:34 PM\nLatest news";
    const b = "Welcome\n09:15 PM\nLatest news";
    const result = compareText(a, b);
    expect(result.changedLineCount).toBe(0);
  });

  it("ignores date-only changes", () => {
    const a = "Header\n2025-01-01\nFooter";
    const b = "Header\n2026-05-14\nFooter";
    const result = compareText(a, b);
    expect(result.changedLineCount).toBe(0);
  });

  it("ignores csrf and nonce token lines but counts real content alongside them", () => {
    const a = "Title\ncsrf-token: abc123\nnonce-xyz\nBody text v1";
    const b = "Title\ncsrf-token: zzz999\nnonce-aaa\nBody text v2";
    const result = compareText(a, b);
    expect(result.changedLineCount).toBe(2);
    expect(result.diffSummary).toContain("Body text v1");
    expect(result.diffSummary).toContain("Body text v2");
    expect(result.diffSummary).not.toContain("csrf");
    expect(result.diffSummary).not.toContain("nonce");
  });
});

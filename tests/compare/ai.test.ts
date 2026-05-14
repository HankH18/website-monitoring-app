import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

// pricingForModel is NOT exported from src/compare/ai.ts, and we can't modify
// that file (not in our owned paths). The AI_MODEL constant is hardcoded to
// "claude-sonnet-4-20250514", so the indirect cost-math test exercises the
// sonnet branch of pricingForModel. Haiku/Opus/unknown branches can't be
// exercised without either exporting pricingForModel or making AI_MODEL
// configurable — see report.

function makeSolidPng(filePath: string, width: number, height: number): void {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; // R
    png.data[i + 1] = 255; // G
    png.data[i + 2] = 255; // B
    png.data[i + 3] = 255; // A
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

// Hoisted mock factory — vi.mock runs before imports.
const messagesCreateMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: messagesCreateMock };
  }
  return { default: Anthropic };
});

let tmpDir: string;
let refPath: string;
let curPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pageguard-ai-test-"));
  refPath = path.join(tmpDir, "ref.png");
  curPath = path.join(tmpDir, "cur.png");
  makeSolidPng(refPath, 8, 8);
  makeSolidPng(curPath, 8, 8);
  messagesCreateMock.mockReset();
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("compare/ai — assessChange (mocked Anthropic SDK)", () => {
  it("returns the parsed assessment from the mocked API and computes the USD cost at sonnet rates", async () => {
    // sonnet rates: input $3/Mtok, output $15/Mtok
    // 1000 input + 500 output => (1000*3 + 500*15) / 1e6
    //                        => (3000 + 7500) / 1e6
    //                        => 0.0105
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            significant: true,
            confidence: 0.9,
            summary: "Layout broke",
            details: ["Header missing"],
            category: "layout_break",
          }),
        },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    });

    const { assessChange } = await import("../../src/compare/ai");
    const result = await assessChange(refPath, curPath, "diff text", "https://example.com");

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    expect(result.significant).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.category).toBe("layout_break");
    expect(result.summary).toBe("Layout broke");
    expect(result.details).toEqual(["Header missing"]);

    expect(result.usage).toBeDefined();
    expect(result.usage!.input_tokens).toBe(1000);
    expect(result.usage!.output_tokens).toBe(500);
    // Floating-point: tolerate tiny error.
    expect(result.usage!.cost_usd).toBeCloseTo(0.0105, 10);
  });

  it("computes cost_usd = 0 when zero tokens are reported", async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            significant: false,
            confidence: 0.1,
            summary: "no change",
            details: [],
            category: "other",
          }),
        },
      ],
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const { assessChange } = await import("../../src/compare/ai");
    const result = await assessChange(refPath, curPath, "", "https://example.com");

    expect(result.usage!.cost_usd).toBe(0);
  });

  it("strips ```json code-fence wrapping when parsing the response", async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text:
            "```json\n" +
            JSON.stringify({
              significant: false,
              confidence: 0.2,
              summary: "trivial",
              details: ["timestamp only"],
              category: "other",
            }) +
            "\n```",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const { assessChange } = await import("../../src/compare/ai");
    const result = await assessChange(refPath, curPath, "diff", "https://example.com");

    expect(result.significant).toBe(false);
    expect(result.summary).toBe("trivial");
    // cost: (10*3 + 20*15) / 1e6 = (30 + 300)/1e6 = 0.00033
    expect(result.usage!.cost_usd).toBeCloseTo(0.00033, 10);
  });

  it("falls back to a safe assessment when the response body isn't valid JSON", async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: "text", text: "not json at all" }],
      usage: { input_tokens: 5, output_tokens: 7 },
    });

    const { assessChange } = await import("../../src/compare/ai");
    const result = await assessChange(refPath, curPath, "", "https://example.com");

    expect(result.significant).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.category).toBe("other");
    expect(result.summary).toContain("not json at all");
    expect(result.usage).toBeDefined();
  });
});

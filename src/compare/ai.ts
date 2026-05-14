import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import sharp from "sharp";
import { AiAssessment } from "../types";
import { logger } from "../logger";
import { withRetry } from "../util/retry";

const AI_REQUEST_TIMEOUT_MS = 60_000;

const AI_MODEL = "claude-sonnet-4-20250514";

// Anthropic recommends ≤1568px on the long axis for image inputs.
const MAX_IMAGE_LONG_AXIS_PX = 1568;

// Per-million-token USD pricing for Anthropic models.
const PRICING_PER_MTOK = {
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  opus: { input: 15, output: 75 },
} as const;

function pricingForModel(model: string): { input: number; output: number } {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return PRICING_PER_MTOK.haiku;
  if (m.includes("opus")) return PRICING_PER_MTOK.opus;
  return PRICING_PER_MTOK.sonnet;
}

function computeCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = pricingForModel(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

async function loadAndResizeForAi(imagePath: string): Promise<string> {
  const buf = fs.readFileSync(imagePath);
  const meta = await sharp(buf).metadata();
  const longAxis = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longAxis > 0 && longAxis <= MAX_IMAGE_LONG_AXIS_PX) {
    // Already within limit — skip the re-encode round-trip.
    return buf.toString("base64");
  }
  const resized = await sharp(buf)
    .resize({
      width: MAX_IMAGE_LONG_AXIS_PX,
      height: MAX_IMAGE_LONG_AXIS_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return resized.toString("base64");
}

export interface DiffBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Crop to the given bbox (clamped to the actual image dimensions), then resize
// within MAX_IMAGE_LONG_AXIS_PX. Throws if the bbox cannot be applied — the
// caller is expected to fall back to the full-page path.
async function loadCropAndResizeForAi(imagePath: string, bbox: DiffBbox): Promise<string> {
  const buf = fs.readFileSync(imagePath);
  const meta = await sharp(buf).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW <= 0 || imgH <= 0) {
    throw new Error(`Invalid image dimensions for ${imagePath}: ${imgW}x${imgH}`);
  }

  // Clamp the bbox to the image bounds. The pixel-diff bbox is computed on a
  // normalized canvas that may be larger than this specific image.
  const x = Math.max(0, Math.min(bbox.x, imgW - 1));
  const y = Math.max(0, Math.min(bbox.y, imgH - 1));
  const width = Math.max(1, Math.min(bbox.width, imgW - x));
  const height = Math.max(1, Math.min(bbox.height, imgH - y));

  const cropped = await sharp(buf).extract({ left: x, top: y, width, height }).png().toBuffer();

  const cropMeta = await sharp(cropped).metadata();
  const longAxis = Math.max(cropMeta.width ?? 0, cropMeta.height ?? 0);
  if (longAxis > 0 && longAxis <= MAX_IMAGE_LONG_AXIS_PX) {
    return cropped.toString("base64");
  }
  const resized = await sharp(cropped)
    .resize({
      width: MAX_IMAGE_LONG_AXIS_PX,
      height: MAX_IMAGE_LONG_AXIS_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  return resized.toString("base64");
}

async function getImagePixelCount(imagePath: string): Promise<number> {
  const meta = await sharp(fs.readFileSync(imagePath)).metadata();
  return (meta.width ?? 0) * (meta.height ?? 0);
}

export interface AssessChangeResult extends AiAssessment {
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
}

function isTransientAiError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; name?: string; message?: string };

  // Anthropic SDK exposes HTTP status on errors
  if (typeof e.status === "number") {
    if (e.status === 429 || e.status === 503 || e.status >= 500) return true;
    // Other 4xx are permanent
    if (e.status >= 400 && e.status < 500) return false;
  }

  // Abort due to our own timeout — transient
  if (e.name === "AbortError") return true;

  const msg = (e.message || "").toLowerCase();
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("timeout")
  ) {
    return true;
  }

  return false;
}

function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    status?: number;
    headers?: Record<string, string> | { get?: (k: string) => string | null };
  };
  if (e.status !== 429) return null;
  let raw: string | null | undefined;
  const h = e.headers;
  if (h && typeof (h as any).get === "function") {
    raw = (h as any).get("retry-after");
  } else if (h && typeof h === "object") {
    const rec = h as Record<string, string>;
    raw = rec["retry-after"] ?? rec["Retry-After"];
  }
  if (!raw) return null;
  const num = Number(raw);
  if (Number.isFinite(num)) return Math.max(0, num * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

const SYSTEM_PROMPT = `You are a website monitoring agent for PageGuard. Your job is to compare a reference (baseline) screenshot and text content with a current capture of the same web page, and determine whether any changes are significant enough to warrant alerting the site owner.

You will receive:
1. The reference screenshot (how the page looked before)
2. The current screenshot (how the page looks now)
3. A text diff showing content changes between captures

## FLAG THESE (significant changes — set "significant": true)
- Broken layouts or major visual regressions
- Missing product images or placeholder images where real ones should be
- Error messages or error states (404, 500, "page not found," "out of stock" when it shouldn't be)
- Unexpected text changes (product names, prices, or descriptions changing)
- Missing navigation elements, header, or footer
- SSL/security warnings
- Blank or partially loaded pages
- Unexpected new elements (injected content, defacement, unfamiliar banners)

## IGNORE THESE (trivial changes — set "significant": false)
- Timestamp or date changes
- Minor pixel-level rendering differences (anti-aliasing, font rendering)
- Rotating banner/hero images that are part of normal CMS behavior
- Cookie consent banners appearing or not appearing
- Chat widgets or support popups loading or not loading
- Shopify cart badge count changes
- Shopify-generated dynamic section IDs or session tokens
- Minor whitespace or spacing differences

## Response Format
You MUST respond with valid JSON only — no markdown, no explanation, no wrapping:

{
  "significant": true,
  "confidence": 0.85,
  "summary": "One-sentence plain-English description of what changed",
  "details": ["Specific change 1", "Specific change 2"],
  "category": "layout_break|content_change|error_state|missing_element|other"
}

Rules:
- "confidence" is 0.0 to 1.0 — how sure you are about the significance assessment
- "category" must be exactly one of: layout_break, content_change, error_state, missing_element, other
- "details" should list each specific change you observed
- Be concise but precise in your summary`;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

export interface SelectorImagePair {
  selector: string;
  referencePath: string;
  currentPath: string;
  textDiffScore: number;
}

export async function assessSelectorChange(
  pairs: SelectorImagePair[],
  textDiff: string,
  url: string,
): Promise<AssessChangeResult> {
  const client = getClient();

  // Cap at 3 selectors with highest text-diff scores
  const ranked = [...pairs].sort((a, b) => b.textDiffScore - a.textDiffScore).slice(0, 3);

  const imageBlocks: Array<{
    type: "text" | "image";
    text?: string;
    source?: { type: "base64"; media_type: "image/png"; data: string };
  }> = [
    {
      type: "text",
      text: `Analyze changes to specific selectors on: ${url}\n\nThe site owner is monitoring specific page sections (not the whole page). Below are reference/current screenshot pairs for each monitored selector, followed by the text diff.\n\nText content diff per selector:\n\`\`\`\n${textDiff || "(no text changes)"}\n\`\`\``,
    },
  ];

  for (const pair of ranked) {
    try {
      const [refB64, curB64] = await Promise.all([
        loadAndResizeForAi(pair.referencePath),
        loadAndResizeForAi(pair.currentPath),
      ]);
      imageBlocks.push({
        type: "text",
        text: `\nSelector "${pair.selector}" — reference then current:`,
      });
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: refB64 },
      });
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: curB64 },
      });
    } catch (err: any) {
      logger.warn(`Skipping selector "${pair.selector}" image pair: ${err.message}`);
    }
  }

  logger.info(`Sending AI selector assessment request for ${url} (${ranked.length} pair(s))`);

  const response = await withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      try {
        return await client.messages.create(
          {
            model: AI_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: imageBlocks as any }],
          },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    {
      attempts: 3,
      backoffMs: [1000, 3000],
      retryable: isTransientAiError,
      delayOverride: (err) => getRetryAfterMs(err),
      onRetry: (err, attempt, delayMs) => {
        const msg = (err as { message?: string })?.message ?? String(err);
        logger.warn(
          `AI selector assessment transient error for ${url} (attempt ${attempt}): ${msg} — retrying in ${delayMs}ms`,
        );
      },
    },
  );

  return parseAiResponse(response, url);
}

function parseAiResponse(
  response: {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  },
  url: string,
): AssessChangeResult {
  const text = response.content[0].type === "text" ? (response.content[0].text ?? "") : "";
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: computeCostUsd(AI_MODEL, inputTokens, outputTokens),
  };

  try {
    const jsonStr = text
      .replace(/^```json?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    const assessment = JSON.parse(jsonStr) as AiAssessment;
    logger.info(
      `AI assessment for ${url}: significant=${assessment.significant}, confidence=${assessment.confidence}, category=${assessment.category}, tokens=${inputTokens}/${outputTokens}, cost=$${usage.cost_usd.toFixed(4)}`,
    );
    return { ...assessment, usage };
  } catch {
    logger.error(`Failed to parse AI response for ${url}: ${text}`);
    return {
      significant: true,
      confidence: 0.5,
      summary: `AI response could not be parsed. Raw: ${text.slice(0, 200)}`,
      details: ["Failed to parse AI response — flagging as significant for safety"],
      category: "other",
      usage,
    };
  }
}

export async function assessChange(
  referenceScreenshotPath: string,
  currentScreenshotPath: string,
  textDiff: string,
  url: string,
  diffBbox?: DiffBbox,
): Promise<AssessChangeResult> {
  const client = getClient();

  let usedCrop = false;
  let refBase64: string;
  let curBase64: string;

  if (diffBbox) {
    try {
      [refBase64, curBase64] = await Promise.all([
        loadCropAndResizeForAi(referenceScreenshotPath, diffBbox),
        loadCropAndResizeForAi(currentScreenshotPath, diffBbox),
      ]);
      usedCrop = true;

      // Cost-savings telemetry: compare crop area against full image area.
      try {
        const fullPixels = await getImagePixelCount(currentScreenshotPath);
        const cropPixels = diffBbox.width * diffBbox.height;
        if (fullPixels > 0) {
          const savingsPct = (1 - cropPixels / fullPixels) * 100;
          logger.info(
            `AI crop for ${url}: bbox=${diffBbox.width}x${diffBbox.height} at (${diffBbox.x},${diffBbox.y}), image_input_savings_pct=${savingsPct.toFixed(1)}`,
          );
        }
      } catch {
        // Telemetry is best-effort; ignore failures.
      }
    } catch (err: any) {
      logger.warn(
        `AI crop failed for ${url} (bbox=${JSON.stringify(diffBbox)}): ${err?.message ?? err} — falling back to full page`,
      );
      [refBase64, curBase64] = await Promise.all([
        loadAndResizeForAi(referenceScreenshotPath),
        loadAndResizeForAi(currentScreenshotPath),
      ]);
    }
  } else {
    [refBase64, curBase64] = await Promise.all([
      loadAndResizeForAi(referenceScreenshotPath),
      loadAndResizeForAi(currentScreenshotPath),
    ]);
  }

  const cropNote = usedCrop ? " (showing only the changed region of the page)" : "";
  logger.info(`Sending AI assessment request for ${url}${usedCrop ? " [cropped]" : ""}`);

  const response = await withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      try {
        return await client.messages.create(
          {
            model: AI_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Analyze changes to: ${url}\n\nText content diff:\n\`\`\`\n${textDiff || "(no text changes)"}\n\`\`\`\n\nBelow are the reference (baseline) screenshot followed by the current screenshot${cropNote}:`,
                  },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: refBase64,
                    },
                  },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: curBase64,
                    },
                  },
                ],
              },
            ],
          },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    {
      attempts: 3,
      backoffMs: [1000, 3000],
      retryable: isTransientAiError,
      delayOverride: (err) => getRetryAfterMs(err),
      onRetry: (err, attempt, delayMs) => {
        const msg = (err as { message?: string })?.message ?? String(err);
        logger.warn(
          `AI assessment transient error for ${url} (attempt ${attempt}): ${msg} — retrying in ${delayMs}ms`,
        );
      },
    },
  );

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: computeCostUsd(AI_MODEL, inputTokens, outputTokens),
  };

  try {
    // Strip any markdown wrapping if present
    const jsonStr = text
      .replace(/^```json?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
    const assessment = JSON.parse(jsonStr) as AiAssessment;

    logger.info(
      `AI assessment for ${url}: significant=${assessment.significant}, confidence=${assessment.confidence}, category=${assessment.category}, tokens=${inputTokens}/${outputTokens}, cost=$${usage.cost_usd.toFixed(4)}`,
    );

    return { ...assessment, usage };
  } catch (err: any) {
    logger.error(`Failed to parse AI response for ${url}: ${text}`);
    return {
      significant: true,
      confidence: 0.5,
      summary: `AI response could not be parsed. Raw: ${text.slice(0, 200)}`,
      details: ["Failed to parse AI response — flagging as significant for safety"],
      category: "other",
      usage,
    };
  }
}

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import { AiAssessment } from "../types";
import { logger } from "../logger";

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

export async function assessChange(
  referenceScreenshotPath: string,
  currentScreenshotPath: string,
  textDiff: string,
  url: string
): Promise<AiAssessment> {
  const client = getClient();

  const refImage = fs.readFileSync(referenceScreenshotPath);
  const curImage = fs.readFileSync(currentScreenshotPath);

  const refBase64 = refImage.toString("base64");
  const curBase64 = curImage.toString("base64");

  logger.info(`Sending AI assessment request for ${url}`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze changes to: ${url}\n\nText content diff:\n\`\`\`\n${textDiff || "(no text changes)"}\n\`\`\`\n\nBelow are the reference (baseline) screenshot followed by the current screenshot:`,
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
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  try {
    // Strip any markdown wrapping if present
    const jsonStr = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const assessment = JSON.parse(jsonStr) as AiAssessment;

    logger.info(
      `AI assessment for ${url}: significant=${assessment.significant}, confidence=${assessment.confidence}, category=${assessment.category}`
    );

    return assessment;
  } catch (err: any) {
    logger.error(`Failed to parse AI response for ${url}: ${text}`);
    return {
      significant: true,
      confidence: 0.5,
      summary: `AI response could not be parsed. Raw: ${text.slice(0, 200)}`,
      details: ["Failed to parse AI response — flagging as significant for safety"],
      category: "other",
    };
  }
}

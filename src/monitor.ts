import path from "path";
import { loadConfig } from "./config";
import { capturePage } from "./capture";
import { compareScreenshots } from "./compare/pixel";
import { compareText } from "./compare/text";
import { assessChange, AssessChangeResult } from "./compare/ai";
import { sendSlackAlert } from "./notify/slack";
import { sendEmailAlert } from "./notify/email";
import { notifyWebhook } from "./notify/webhook";
import { MonitoredUrl, AiAssessment } from "./types";
import {
  insertCapture,
  getReferenceCapture,
  setUrlReference,
  updateUrlStatus,
  insertChangeEvent,
  markEventNotified,
} from "./storage/db";
import { readTextContent } from "./storage/files";
import { logger } from "./logger";

export async function checkUrl(
  url: MonitoredUrl,
  isBaseline = false,
): Promise<void> {
  const config = loadConfig();

  // 1. Capture the page
  const capture = await capturePage(url.url);

  // 2. Store capture in DB
  const reference = isBaseline ? null : getReferenceCapture(url.id);
  const isRef = isBaseline || !reference;

  const captureRecord = insertCapture(
    url.id,
    capture.screenshotPath,
    capture.textPath,
    capture.textContent,
    isRef,
  );

  // If this is a baseline or first capture, set as reference and done
  if (isRef) {
    setUrlReference(url.id, captureRecord.id);
    updateUrlStatus(url.id, capture.error ? "error" : "ok");
    logger.info(`Reference set for ${url.label}`);
    return;
  }

  // 3. First-pass comparison (cheap)
  const pixelResult = compareScreenshots(
    reference!.screenshot_path,
    capture.screenshotPath,
    path.join(path.dirname(capture.screenshotPath), "diff.png"),
  );

  const refText = readTextContent(reference!.text_path);
  const textResult = compareText(refText, capture.textContent);

  const belowThreshold =
    pixelResult.diffPercent < config.thresholds.pixel_diff_percent &&
    textResult.changedLineCount <= config.thresholds.text_change_lines;

  if (belowThreshold) {
    updateUrlStatus(url.id, "ok");
    logger.info(
      `${url.label}: below threshold (pixel: ${pixelResult.diffPercent.toFixed(2)}%, text: ${textResult.changedLineCount} lines) — no AI check`,
    );
    return;
  }

  logger.info(
    `${url.label}: above threshold (pixel: ${pixelResult.diffPercent.toFixed(2)}%, text: ${textResult.changedLineCount} lines) — running AI check`,
  );

  // 4. Second-pass: AI assessment
  let assessment: AssessChangeResult;
  try {
    assessment = await assessChange(
      reference!.screenshot_path,
      capture.screenshotPath,
      textResult.diffSummary,
      url.url,
    );
  } catch (err: any) {
    logger.error(`AI assessment failed for ${url.label}: ${err.message}`);
    assessment = {
      significant: true,
      confidence: 0.5,
      summary: `AI assessment failed: ${err.message}`,
      details: ["AI check failed — flagging for manual review"],
      category: "other",
    };
  }

  // 5. Record change event
  const changeEvent = insertChangeEvent({
    url_id: url.id,
    capture_id: captureRecord.id,
    reference_capture_id: reference!.id,
    pixel_diff_percent: pixelResult.diffPercent,
    text_diff_count: textResult.changedLineCount,
    ai_significant: assessment.significant,
    ai_confidence: assessment.confidence,
    ai_summary: assessment.summary,
    ai_details: assessment.details,
    ai_category: assessment.category,
    input_tokens: assessment.usage?.input_tokens,
    output_tokens: assessment.usage?.output_tokens,
    ai_cost_usd: assessment.usage?.cost_usd,
  });

  if (!assessment.significant) {
    updateUrlStatus(url.id, "ok");
    logger.info(`${url.label}: AI says not significant — no notification`);
    return;
  }

  // 6. Notify
  updateUrlStatus(url.id, "change_detected");

  const urlNotifConfig = {
    slack: config.notifications.slack,
    email: config.notifications.email,
    ...((url as any).notifications || {}),
  };

  // Slack notification
  if (urlNotifConfig.slack) {
    const slackResult = await sendSlackAlert(
      changeEvent,
      url,
      assessment,
      capture.screenshotPath,
      reference!.screenshot_path,
    );
    if (slackResult) {
      markEventNotified(changeEvent.id, slackResult.ts, slackResult.channel);
    }
  }

  // Email notification
  if (urlNotifConfig.email) {
    await sendEmailAlert(changeEvent, url, assessment);
    if (!urlNotifConfig.slack) {
      markEventNotified(changeEvent.id);
    }
  }

  await notifyWebhook(changeEvent, url, assessment);

  logger.info(`${url.label}: significant change detected and notified`);
}

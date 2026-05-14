import path from "path";
import { loadConfig } from "./config";
import { capturePage } from "./capture";
import { compareScreenshots } from "./compare/pixel";
import { compareText } from "./compare/text";
import {
  assessChange,
  assessSelectorChange,
  AssessChangeResult,
  SelectorImagePair,
} from "./compare/ai";
import { compareSelectorCaptures } from "./compare/selector";
import { sendSlackAlert } from "./notify/slack";
import { sendEmailAlert } from "./notify/email";
import { notifyWebhook } from "./notify/webhook";
import { MonitoredUrl } from "./types";
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

export async function checkUrl(url: MonitoredUrl, isBaseline = false): Promise<void> {
  const config = loadConfig();

  if (!isBaseline && url.muted_until) {
    const until = new Date(url.muted_until.replace(" ", "T") + "Z");
    if (!isNaN(until.getTime()) && until.getTime() > Date.now()) {
      logger.info(`${url.label}: muted until ${url.muted_until}, skipping`);
      return;
    }
  }

  const selectors = url.selectors ?? [];
  const useSelectors = selectors.length > 0;

  // 1. Capture the page
  const capture = await capturePage(url.url, selectors);

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
  let pixelDiffPercent = 0;
  let textChangedLineCount = 0;
  let textDiffSummary = "";
  let selectorWarnings: string[] = [];
  let selectorDiff: ReturnType<typeof compareSelectorCaptures> | null = null;

  if (useSelectors) {
    const refDir = path.dirname(reference!.screenshot_path);
    const refSelectors = selectors.map((sel, i) => ({
      selector: sel,
      textPath: path.join(refDir, `selector_${i}.txt`),
      screenshotPath: path.join(refDir, `selector_${i}.png`),
    }));
    selectorDiff = compareSelectorCaptures(refSelectors, capture.selectors ?? []);
    textChangedLineCount = selectorDiff.changedLineCount;
    textDiffSummary = selectorDiff.diffSummary;
    selectorWarnings = selectorDiff.warnings;
  } else {
    const pixelResult = compareScreenshots(
      reference!.screenshot_path,
      capture.screenshotPath,
      path.join(path.dirname(capture.screenshotPath), "diff.png"),
    );
    pixelDiffPercent = pixelResult.diffPercent;

    const refText = readTextContent(reference!.text_path);
    const textResult = compareText(refText, capture.textContent);
    textChangedLineCount = textResult.changedLineCount;
    textDiffSummary = textResult.diffSummary;
  }

  const belowThreshold = useSelectors
    ? textChangedLineCount <= config.thresholds.text_change_lines && selectorWarnings.length === 0
    : pixelDiffPercent < config.thresholds.pixel_diff_percent &&
      textChangedLineCount <= config.thresholds.text_change_lines;

  if (belowThreshold) {
    updateUrlStatus(url.id, "ok");
    logger.info(
      useSelectors
        ? `${url.label}: below threshold (selector text: ${textChangedLineCount} lines) — no AI check`
        : `${url.label}: below threshold (pixel: ${pixelDiffPercent.toFixed(2)}%, text: ${textChangedLineCount} lines) — no AI check`,
    );
    return;
  }

  logger.info(
    useSelectors
      ? `${url.label}: above threshold (selector text: ${textChangedLineCount} lines, warnings: ${selectorWarnings.length}) — running AI check`
      : `${url.label}: above threshold (pixel: ${pixelDiffPercent.toFixed(2)}%, text: ${textChangedLineCount} lines) — running AI check`,
  );

  // 4. Second-pass: AI assessment
  let assessment: AssessChangeResult;
  try {
    if (useSelectors && selectorDiff) {
      const refDir = path.dirname(reference!.screenshot_path);
      const pairs: SelectorImagePair[] = selectorDiff.entries
        .filter((e) => e.matchedCurrent)
        .map((e) => ({
          selector: e.selector,
          referencePath: path.join(refDir, `selector_${e.index}.png`),
          currentPath: path.join(path.dirname(capture.screenshotPath), `selector_${e.index}.png`),
          textDiffScore: e.changedLineCount,
        }));
      const warningsText =
        selectorWarnings.length > 0 ? `\n\nWarnings:\n${selectorWarnings.join("\n")}` : "";
      assessment = await assessSelectorChange(pairs, textDiffSummary + warningsText, url.url);
    } else {
      assessment = await assessChange(
        reference!.screenshot_path,
        capture.screenshotPath,
        textDiffSummary,
        url.url,
      );
    }
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
    pixel_diff_percent: pixelDiffPercent,
    text_diff_count: textChangedLineCount,
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

import { App, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import fs from "fs";
import { loadConfig } from "../config";
import { ChangeEvent, MonitoredUrl, AiAssessment } from "../types";
import {
  acknowledgeEvent,
  getChangeEventBySlackTs,
  getChangeEventById,
  getUrlById,
  setUrlReference,
  getCaptureById,
} from "../storage/db";
import { logger } from "../logger";

let _app: App | null = null;
let _webClient: WebClient | null = null;

export function getSlackApp(): App | null {
  return _app;
}

export function initSlackApp(expressApp?: any): App | null {
  const token = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!token || !signingSecret) {
    logger.warn("Slack credentials not configured — Slack notifications disabled");
    return null;
  }

  _webClient = new WebClient(token);

  _app = new App({
    token,
    signingSecret,
    ...(appToken
      ? { socketMode: true, appToken }
      : {}),
    logLevel: LogLevel.WARN,
  });

  // Handle "Mark as intentional" button
  _app.action("mark_intentional", async ({ ack, body, client }) => {
    await ack();

    const action = body as any;
    const value = JSON.parse(action.actions[0].value);
    const eventId = value.event_id as number;

    const event = getChangeEventById(eventId);
    if (!event) {
      logger.warn(`Slack ack: change event ${eventId} not found`);
      return;
    }

    // Acknowledge the event
    acknowledgeEvent(eventId, "slack_button");

    // Update reference to the new capture
    setUrlReference(event.url_id, event.capture_id);

    const url = getUrlById(event.url_id);

    // Update the original message
    try {
      await client.chat.update({
        channel: event.slack_channel!,
        ts: event.slack_ts!,
        text: `Change on ${url?.label || url?.url} marked as intentional by <@${(body as any).user.id}>. Reference updated.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *Marked as intentional* by <@${(body as any).user.id}>\nReference updated for *${url?.label || url?.url}*`,
            },
          },
        ],
      });
    } catch (err: any) {
      logger.error(`Failed to update Slack message: ${err.message}`);
    }

    logger.info(`Event ${eventId} acknowledged via Slack button`);
  });

  // Handle thread reply with "approved"
  _app.message(/approved/i, async ({ message, client }) => {
    const msg = message as any;
    if (!msg.thread_ts) return; // only handle threaded replies

    const event = getChangeEventBySlackTs(msg.thread_ts);
    if (!event || event.acknowledged) return;

    acknowledgeEvent(event.id, "slack_thread");
    setUrlReference(event.url_id, event.capture_id);

    const url = getUrlById(event.url_id);

    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: msg.thread_ts,
      text: `✅ Change approved by <@${msg.user}>. Reference updated for ${url?.label || url?.url}.`,
    });

    logger.info(`Event ${event.id} acknowledged via Slack thread reply`);
  });

  return _app;
}

export async function startSlackApp(): Promise<void> {
  if (!_app) return;

  const appToken = process.env.SLACK_APP_TOKEN;
  if (appToken) {
    await _app.start();
    logger.info("Slack app started in socket mode");
  }
}

export async function sendSlackAlert(
  event: ChangeEvent,
  url: MonitoredUrl,
  assessment: AiAssessment,
  currentScreenshotPath: string,
  referenceScreenshotPath: string
): Promise<{ ts: string; channel: string } | null> {
  if (!_webClient) {
    logger.warn("Slack not initialized — skipping notification");
    return null;
  }

  const config = loadConfig();
  const channel = config.slack.channel;

  const categoryEmoji: Record<string, string> = {
    layout_break: "🔴",
    content_change: "🟡",
    error_state: "🔴",
    missing_element: "🟠",
    other: "⚪",
  };

  const emoji = categoryEmoji[assessment.category] || "⚪";
  const detailsList = assessment.details.map((d) => `• ${d}`).join("\n");

  try {
    // Upload before/after screenshots
    const refUpload = await _webClient.files.uploadV2({
      channel_id: channel,
      file: fs.readFileSync(referenceScreenshotPath),
      filename: `reference-${url.url_hash}.png`,
      title: `Reference: ${url.label}`,
    });

    const curUpload = await _webClient.files.uploadV2({
      channel_id: channel,
      file: fs.readFileSync(currentScreenshotPath),
      filename: `current-${url.url_hash}.png`,
      title: `Current: ${url.label}`,
    });

    // Send alert message
    const result = await _webClient.chat.postMessage({
      channel,
      text: `${emoji} Change detected on ${url.label}: ${assessment.summary}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `${emoji} Change Detected: ${url.label}`,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*URL:*\n<${url.url}|${url.url}>`,
            },
            {
              type: "mrkdwn",
              text: `*Category:*\n${assessment.category.replace("_", " ")}`,
            },
            {
              type: "mrkdwn",
              text: `*Confidence:*\n${(assessment.confidence * 100).toFixed(0)}%`,
            },
            {
              type: "mrkdwn",
              text: `*Pixel Diff:*\n${event.pixel_diff_percent.toFixed(1)}%`,
            },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Summary:* ${assessment.summary}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Details:*\n${detailsList}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Mark as Intentional",
              },
              action_id: "mark_intentional",
              value: JSON.stringify({ event_id: event.id }),
              style: "primary",
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: 'Reply "approved" in this thread to acknowledge, or click the button above.',
            },
          ],
        },
      ],
    });

    const ts = result.ts!;

    logger.info(`Slack alert sent for ${url.label} (ts: ${ts})`);
    return { ts, channel };
  } catch (err: any) {
    logger.error(`Failed to send Slack alert: ${err.message}`);
    return null;
  }
}

export async function sendSlackReminder(
  event: ChangeEvent,
  url: MonitoredUrl
): Promise<void> {
  if (!_webClient || !event.slack_ts || !event.slack_channel) return;

  try {
    await _webClient.chat.postMessage({
      channel: event.slack_channel,
      thread_ts: event.slack_ts,
      text: `⏰ Reminder: Change on *${url.label}* (<${url.url}|link>) has not been acknowledged. Please review and click "Mark as Intentional" or reply "approved" if this change is expected.`,
    });
    logger.info(`Reminder sent for event ${event.id}`);
  } catch (err: any) {
    logger.error(`Failed to send Slack reminder: ${err.message}`);
  }
}

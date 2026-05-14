import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "../config";
import { MonitoredUrl } from "../types";
import { logger } from "../logger";

const TIMEOUT_MS = 10_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function postSlack(
  url: MonitoredUrl,
  statusCode: number | null,
  error?: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const config = loadConfig();
  if (!config.notifications.slack) return;
  const channel = config.slack.channel;
  const client = new WebClient(token);
  const detail = statusCode != null ? `HTTP ${statusCode}` : `error: ${error || "unknown"}`;
  try {
    await client.chat.postMessage({
      channel,
      text: `🔴 Uptime failure on *${url.label}* (<${url.url}|link>) — ${detail} for 3 consecutive checks`,
    });
    logger.info(`Uptime Slack alert sent for ${url.label}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Uptime Slack alert failed: ${msg}`);
  }
}

async function postEmail(
  url: MonitoredUrl,
  statusCode: number | null,
  error?: string,
): Promise<void> {
  const config = loadConfig();
  if (!config.notifications.email || !config.email.to) return;
  const detail = statusCode != null ? `HTTP ${statusCode}` : `error: ${error || "unknown"}`;
  const subject = `[PageGuard] Uptime failure: ${url.label}`.replace(/[\r\n]+/g, " ");
  const text = `Uptime failure detected on ${url.label} (${url.url}).\nResult: ${detail}\nConsecutive failures: 3\n\n--\nPageGuard`;
  const html = `<div style="font-family:sans-serif;"><h2 style="color:#d32f2f;">Uptime failure: ${escapeHtml(url.label)}</h2><p>URL: <a href="${escapeHtml(url.url)}">${escapeHtml(url.url)}</a></p><p>Result: ${escapeHtml(detail)}</p><p>Consecutive failures: 3</p></div>`;
  try {
    if (config.email.provider === "resend") {
      const key = process.env.RESEND_API_KEY;
      if (!key) return;
      const { Resend } = await import("resend");
      const resend = new Resend(key);
      await resend.emails.send({
        from: config.email.from,
        to: config.email.to,
        subject,
        text,
        html,
      });
    } else {
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;
      if (!user || !pass) return;
      const transport = nodemailer.createTransport({
        host: config.email.smtp.host,
        port: config.email.smtp.port,
        secure: config.email.smtp.secure,
        auth: { user, pass },
      });
      await transport.sendMail({
        from: config.email.from,
        to: config.email.to,
        subject,
        text,
        html,
      });
    }
    logger.info(`Uptime email alert sent for ${url.label}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Uptime email alert failed: ${msg}`);
  }
}

async function postWebhook(
  url: MonitoredUrl,
  statusCode: number | null,
  error?: string,
): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return;
  const secret = process.env.WEBHOOK_SECRET || undefined;
  const payload = {
    event: "uptime_failure",
    url: url.url,
    label: url.label,
    status_code: statusCode,
    error: error || null,
    consecutive_failures: 3,
    captured_at: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Pageguard-Signature"] = `sha256=${sig}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.error(`Uptime webhook failed: ${res.status}`);
    } else {
      logger.info(`Uptime webhook delivered for ${url.label}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Uptime webhook error: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyUptimeFailure(
  url: MonitoredUrl,
  statusCode: number | null,
  error?: string,
): Promise<void> {
  await Promise.allSettled([
    postSlack(url, statusCode, error),
    postEmail(url, statusCode, error),
    postWebhook(url, statusCode, error),
  ]);
}

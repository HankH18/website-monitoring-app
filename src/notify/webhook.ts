import crypto from "node:crypto";
import { ChangeEvent, MonitoredUrl, AiAssessment } from "../types";
import { logger } from "../logger";
import { withRetry } from "../util/retry";

const TIMEOUT_MS = 10_000;

export interface WebhookPayload {
  event: "change_detected";
  url: string;
  label: string;
  change_event_id: number;
  summary: string;
  category: string;
  captured_at: string;
  dashboard_url: string | null;
}

function buildPayload(
  event: ChangeEvent,
  url: MonitoredUrl,
  assessment: AiAssessment,
): WebhookPayload {
  const base = process.env.DASHBOARD_BASE_URL;
  return {
    event: "change_detected",
    url: url.url,
    label: url.label,
    change_event_id: event.id,
    summary: assessment.summary,
    category: assessment.category,
    captured_at: event.timestamp,
    dashboard_url: base ? `${base.replace(/\/$/, "")}/events/${event.id}` : null,
  };
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function isTransientWebhookError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  const msg = (e.message || "").toLowerCase();
  if (e.name === "AbortError") return true;
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

class WebhookHttpError extends Error {
  status: number;
  retryable: boolean;
  constructor(status: number, body: string) {
    super(`Webhook responded ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.retryable = isRetryableStatus(status);
  }
}

async function postOnce(url: string, body: string, secret: string | undefined): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    headers["X-Pageguard-Signature"] = `sha256=${sig}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new WebhookHttpError(res.status, text);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyWebhook(
  event: ChangeEvent,
  url: MonitoredUrl,
  assessment: AiAssessment,
): Promise<boolean> {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) return false;

  const secret = process.env.WEBHOOK_SECRET || undefined;
  const payload = buildPayload(event, url, assessment);
  const body = JSON.stringify(payload);

  try {
    await withRetry(() => postOnce(webhookUrl, body, secret), {
      attempts: 3,
      backoffMs: [1000, 3000, 9000],
      retryable: (err) => {
        if (err instanceof WebhookHttpError) return err.retryable;
        return isTransientWebhookError(err);
      },
      onRetry: (err, attempt, delayMs) => {
        const msg = (err as { message?: string })?.message ?? String(err);
        logger.warn(
          `Webhook transient error (attempt ${attempt}): ${msg} — retrying in ${delayMs}ms`,
        );
      },
    });
    logger.info(`Webhook delivered for ${url.label} (event ${event.id})`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to deliver webhook for ${url.label}: ${msg}`);
    return false;
  }
}

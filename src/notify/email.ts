import nodemailer from "nodemailer";
import { loadConfig } from "../config";
import { ChangeEvent, MonitoredUrl, AiAssessment } from "../types";
import { logger } from "../logger";

let _transporter: nodemailer.Transporter | null = null;
let _resend: any = null;

function getTransporter(): nodemailer.Transporter | null {
  if (_transporter) return _transporter;

  const config = loadConfig();

  if (config.email.provider === "smtp") {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) {
      logger.warn("SMTP credentials not configured — email notifications disabled");
      return null;
    }
    _transporter = nodemailer.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: { user, pass },
    });
    return _transporter;
  }

  return null;
}

async function getResendClient(): Promise<any> {
  if (_resend) return _resend;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    logger.warn("Resend API key not configured — email notifications disabled");
    return null;
  }

  const { Resend } = await import("resend");
  _resend = new Resend(key);
  return _resend;
}

export async function sendEmailAlert(
  event: ChangeEvent,
  url: MonitoredUrl,
  assessment: AiAssessment
): Promise<boolean> {
  const config = loadConfig();

  if (!config.email.to) {
    logger.warn("Email recipient not configured — skipping email notification");
    return false;
  }

  const subject = `[PageGuard] Change detected: ${url.label}`;
  const detailsList = assessment.details.map((d) => `  - ${d}`).join("\n");

  const textBody = `PageGuard — Change Detected

URL: ${url.url}
Label: ${url.label}
Category: ${assessment.category.replace("_", " ")}
Confidence: ${(assessment.confidence * 100).toFixed(0)}%
Pixel Diff: ${event.pixel_diff_percent.toFixed(1)}%

Summary:
${assessment.summary}

Details:
${detailsList}

To acknowledge this change, visit the PageGuard dashboard and update the reference.
(Email is notification-only — acknowledgment via Slack or dashboard.)

---
PageGuard Website Monitor`;

  const htmlBody = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #d32f2f;">Change Detected: ${url.label}</h2>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 4px 8px; font-weight: bold;">URL:</td><td><a href="${url.url}">${url.url}</a></td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Category:</td><td>${assessment.category.replace("_", " ")}</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Confidence:</td><td>${(assessment.confidence * 100).toFixed(0)}%</td></tr>
    <tr><td style="padding: 4px 8px; font-weight: bold;">Pixel Diff:</td><td>${event.pixel_diff_percent.toFixed(1)}%</td></tr>
  </table>
  <p><strong>Summary:</strong> ${assessment.summary}</p>
  <p><strong>Details:</strong></p>
  <ul>${assessment.details.map((d) => `<li>${d}</li>`).join("")}</ul>
  <hr>
  <p style="color: #888; font-size: 12px;">To acknowledge this change, visit the PageGuard dashboard.<br>Email is notification-only.</p>
</div>`;

  try {
    if (config.email.provider === "resend") {
      const resend = await getResendClient();
      if (!resend) return false;

      await resend.emails.send({
        from: config.email.from,
        to: config.email.to,
        subject,
        text: textBody,
        html: htmlBody,
      });
    } else {
      const transport = getTransporter();
      if (!transport) return false;

      await transport.sendMail({
        from: config.email.from,
        to: config.email.to,
        subject,
        text: textBody,
        html: htmlBody,
      });
    }

    logger.info(`Email alert sent for ${url.label} to ${config.email.to}`);
    return true;
  } catch (err: any) {
    logger.error(`Failed to send email alert: ${err.message}`);
    return false;
  }
}

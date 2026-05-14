import { loadConfig } from "./config";
import { getUnacknowledgedEvents, markReminderSent, getUrlById } from "./storage/db";
import { sendSlackReminder } from "./notify/slack";
import { logger } from "./logger";

export function startAckChecker(): NodeJS.Timeout {
  const config = loadConfig();
  const intervalMs = config.ack_check_interval_minutes * 60 * 1000;
  const timeoutMs = config.ack_timeout_minutes * 60 * 1000;

  logger.info(
    `Ack checker started: checking every ${config.ack_check_interval_minutes}m, timeout ${config.ack_timeout_minutes}m`,
  );

  return setInterval(async () => {
    try {
      const unacked = getUnacknowledgedEvents();

      for (const event of unacked) {
        if (event.reminder_sent) continue;

        const eventTime = new Date(event.timestamp).getTime();
        const elapsed = Date.now() - eventTime;

        if (elapsed >= timeoutMs) {
          const url = getUrlById(event.url_id);
          if (!url) continue;

          logger.info(
            `Ack timeout reached for event ${event.id} (${url.label}) — sending reminder`,
          );

          await sendSlackReminder(event, url);
          markReminderSent(event.id);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Ack checker error: ${msg}`);
    }
  }, intervalMs);
}

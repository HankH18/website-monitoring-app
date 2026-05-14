import cron from "node-cron";
import { loadConfig } from "./config";
import { checkUrl } from "./monitor";
import { getAllUrls, upsertUrl } from "./storage/db";
import { logger } from "./logger";

let _task: cron.ScheduledTask | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAllChecks(): Promise<void> {
  const config = loadConfig();
  const urls = getAllUrls();

  if (urls.length === 0) {
    logger.warn("No URLs configured — skipping check cycle");
    return;
  }

  logger.info(`Starting check cycle for ${urls.length} URL(s)`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await checkUrl(url);
    } catch (err: any) {
      logger.error(`Check failed for ${url.label} (${url.url}): ${err.message}`);
    }

    // Delay between checks (skip after last URL)
    if (i < urls.length - 1) {
      await sleep(config.delay_between_checks_ms);
    }
  }

  logger.info("Check cycle complete");
}

export async function runBaseline(): Promise<void> {
  const config = loadConfig();

  // Sync URLs from config to database
  for (const u of config.urls) {
    upsertUrl(u.url, u.label);
  }

  const urls = getAllUrls();
  logger.info(`Capturing baselines for ${urls.length} URL(s)`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await checkUrl(url, true);
      logger.info(`Baseline captured for ${url.label}`);
    } catch (err: any) {
      logger.error(`Baseline failed for ${url.label}: ${err.message}`);
    }

    if (i < urls.length - 1) {
      await sleep(config.delay_between_checks_ms);
    }
  }

  logger.info("Baseline capture complete");
}

export function startScheduler(): void {
  const config = loadConfig();

  // Sync URLs from config to database on start
  for (const u of config.urls) {
    upsertUrl(u.url, u.label);
  }

  _task = cron.schedule(config.schedule, async () => {
    logger.info("Scheduled check triggered");
    await runAllChecks();
  });

  logger.info(`Scheduler started with cron: ${config.schedule}`);
}

export function stopScheduler(): void {
  if (_task) {
    _task.stop();
    _task = null;
    logger.info("Scheduler stopped");
  }
}

export function reschedule(newCron: string): void {
  stopScheduler();

  _task = cron.schedule(newCron, async () => {
    logger.info("Scheduled check triggered");
    await runAllChecks();
  });

  logger.info(`Scheduler rescheduled with cron: ${newCron}`);
}

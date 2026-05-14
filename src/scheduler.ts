import cron from "node-cron";
import { loadConfig } from "./config";
import { checkUrl } from "./monitor";
import { getAllUrls, upsertUrl } from "./storage/db";
import { runAllUptimeChecks } from "./uptime";
import { logger } from "./logger";

let _task: cron.ScheduledTask | null = null;
let _uptimeTask: cron.ScheduledTask | null = null;
let _running = false;
let _uptimeRunning = false;

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

async function tickRunAllChecks(): Promise<void> {
  if (_running) {
    logger.warn("previous cycle still running; skipping tick");
    return;
  }
  _running = true;
  const startedAt = Date.now();
  try {
    await runAllChecks();
  } finally {
    _running = false;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    logger.info(`cycle duration: ${seconds}s`);
  }
}

async function tickRunAllUptime(): Promise<void> {
  if (_uptimeRunning) {
    logger.warn("previous uptime cycle still running; skipping tick");
    return;
  }
  _uptimeRunning = true;
  try {
    await runAllUptimeChecks();
  } catch (err: any) {
    logger.error(`uptime cycle error: ${err.message}`);
  } finally {
    _uptimeRunning = false;
  }
}

function uptimeCronExpr(): string {
  const secs = Math.max(1, parseInt(process.env.UPTIME_INTERVAL_SECONDS || "60", 10) || 60);
  if (secs < 60) return `*/${secs} * * * * *`;
  const minutes = Math.floor(secs / 60);
  return minutes <= 1 ? "* * * * *" : `*/${minutes} * * * *`;
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
    await tickRunAllChecks();
  });

  const uptimeExpr = uptimeCronExpr();
  _uptimeTask = cron.schedule(uptimeExpr, async () => {
    await tickRunAllUptime();
  });

  logger.info(`Scheduler started with cron: ${config.schedule} (uptime: ${uptimeExpr})`);
}

export function stopScheduler(): void {
  if (_task) {
    _task.stop();
    _task = null;
    logger.info("Scheduler stopped");
  }
  if (_uptimeTask) {
    _uptimeTask.stop();
    _uptimeTask = null;
  }
}

export function reschedule(newCron: string): void {
  if (_task) {
    _task.stop();
    _task = null;
  }

  _task = cron.schedule(newCron, async () => {
    logger.info("Scheduled check triggered");
    await tickRunAllChecks();
  });

  logger.info(`Scheduler rescheduled with cron: ${newCron}`);
}

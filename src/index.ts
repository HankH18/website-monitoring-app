import * as Sentry from "@sentry/node";
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
    environment: process.env.NODE_ENV || "development",
  });
}

import { loadConfig } from "./config";
import { ensureDataDir } from "./storage/files";
import { getDb } from "./storage/db";
import { createDashboardApp, startDashboard } from "./dashboard/server";
import { initSlackApp, startSlackApp } from "./notify/slack";
import { startScheduler } from "./scheduler";
import { runBaseline, runAllChecks } from "./scheduler";
import { startAckChecker } from "./acknowledge";
import { closeBrowser } from "./capture";
import { logger } from "./logger";

if (process.env.NODE_ENV === "production" && process.env.SENTRY_DSN) {
  const fatal = async (err: unknown) => {
    try {
      Sentry.captureException(err);
      await Sentry.flush(2000);
    } catch {
      // Sentry flush failure should not block shutdown; we still log and exit below.
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Fatal: ${msg}`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Load config and initialize storage
  const config = loadConfig();
  ensureDataDir();
  getDb();

  logger.info("PageGuard starting...");

  // Handle CLI modes
  if (args.includes("--baseline")) {
    logger.info("Running baseline capture for all configured URLs");
    await runBaseline();
    await closeBrowser();
    logger.info("Baseline complete. Exiting.");
    process.exit(0);
  }

  if (args.includes("--check")) {
    logger.info("Running one-time check for all URLs");
    // Sync URLs from config
    const { upsertUrl } = await import("./storage/db");
    for (const u of config.urls) {
      upsertUrl(u.url, u.label);
    }
    await runAllChecks();
    await closeBrowser();
    logger.info("Check complete. Exiting.");
    process.exit(0);
  }

  // --- Server mode: start everything ---

  // Initialize Slack app (registers handlers for interactive messages)
  const slackApp = initSlackApp();

  // Start web dashboard
  const dashboardApp = createDashboardApp();
  startDashboard(dashboardApp);

  // Start Slack in socket mode if configured
  if (slackApp) {
    try {
      await startSlackApp();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Slack app failed to start: ${msg}`);
    }
  }

  // Start cron scheduler
  startScheduler();

  // Start acknowledgment timeout checker
  startAckChecker();

  logger.info("PageGuard is running.");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await closeBrowser();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});

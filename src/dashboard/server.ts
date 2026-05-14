import express from "express";
import path from "path";
import basicAuth from "express-basic-auth";
import { loadConfig, getDataDir } from "../config";
import { setupRoutes } from "./routes";
import { logger } from "../logger";
import { getDb } from "../storage/db";
import * as capture from "../capture";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require("../../package.json");

type CheckStatus = "ok" | "fail" | "not_started";

function buildHealthPayload(): {
  body: Record<string, unknown>;
  dbOk: boolean;
} {
  let dbStatus: CheckStatus = "ok";
  try {
    getDb().prepare("SELECT 1").get();
  } catch {
    dbStatus = "fail";
  }

  let browserStatus: CheckStatus = "not_started";
  try {
    const b = (capture as any)._browser ?? (capture as any).browser;
    if (b && typeof b.isConnected === "function") {
      browserStatus = b.isConnected() ? "ok" : "fail";
    }
  } catch {
    browserStatus = "fail";
  }

  return {
    dbOk: dbStatus === "ok",
    body: {
      status: dbStatus === "ok" ? "ok" : "fail",
      uptime_seconds: process.uptime(),
      version: pkg.version,
      checks: { db: dbStatus, browser: browserStatus },
    },
  };
}

export function createDashboardApp(): express.Application {
  const app = express();

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health endpoints — must be before basic auth so probes don't need credentials.
  const healthHandler = (_req: express.Request, res: express.Response) => {
    const { body, dbOk } = buildHealthPayload();
    res.status(dbOk ? 200 : 503).json(body);
  };
  app.get("/healthz", healthHandler);
  app.get("/readyz", healthHandler);

  // Basic auth
  const rawUser = process.env.DASHBOARD_USER;
  const rawPass = process.env.DASHBOARD_PASS;
  const isProd = process.env.NODE_ENV === "production";
  const insecure = !rawUser || !rawPass || rawPass === "changeme";

  if (insecure) {
    if (isProd) {
      logger.error(
        "Refusing to start: DASHBOARD_USER/DASHBOARD_PASS must be set to non-default values in production.",
      );
      process.exit(1);
    }
    logger.warn(
      "Dashboard is using insecure default credentials. Set DASHBOARD_USER and DASHBOARD_PASS before deploying.",
    );
  }

  const user = rawUser || "admin";
  const pass = rawPass || "changeme";

  app.use(
    basicAuth({
      users: { [user]: pass },
      challenge: true,
      realm: "PageGuard Dashboard",
    }),
  );

  // View engine
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  // Serve captured screenshots
  app.use("/captures", express.static(path.join(getDataDir(), "captures")));

  // Routes
  setupRoutes(app);

  return app;
}

export function startDashboard(app: express.Application): void {
  const config = loadConfig();
  const port = config.dashboard.port;

  app.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });
}

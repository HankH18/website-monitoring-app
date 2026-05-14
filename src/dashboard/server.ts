import express from "express";
import path from "path";
import basicAuth from "express-basic-auth";
import { loadConfig, getDataDir } from "../config";
import { setupRoutes } from "./routes";
import { logger } from "../logger";

export function createDashboardApp(): express.Application {
  const app = express();

  // Body parsing
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

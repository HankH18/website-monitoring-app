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
  const user = process.env.DASHBOARD_USER || "admin";
  const pass = process.env.DASHBOARD_PASS || "changeme";

  app.use(
    basicAuth({
      users: { [user]: pass },
      challenge: true,
      realm: "PageGuard Dashboard",
    })
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

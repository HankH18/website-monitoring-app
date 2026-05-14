import { Application, Request, Response, NextFunction } from "express";
import { loadConfig, reloadConfig, getDataDir, updateConfig } from "../config";
import {
  getAllUrls,
  getUrlById,
  upsertUrl,
  deleteUrl,
  getCapturesForUrl,
  getReferenceCapture,
  getLatestCapture,
  getChangeEventsForUrl,
  setUrlReference,
  getCaptureById,
  getChangeEventById,
  acknowledgeEvent,
} from "../storage/db";
import { checkUrl } from "../monitor";
import { reschedule } from "../scheduler";
import { logger } from "../logger";
import path from "path";
import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import cron from "node-cron";
import cookieParser from "cookie-parser";
import { doubleCsrf } from "csrf-csrf";

function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;

  if (family === 4) {
    const parts = ip.split(".").map((p) => parseInt(p, 10));
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;
  const firstHextet = parseInt(lower.split(":")[0] || "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    if (net.isIP(v4) === 4) return isPrivateIp(v4);
  }
  return false;
}

async function validatePublicUrl(raw: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Invalid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http or https";
  }
  if (process.env.ALLOW_PRIVATE_URLS === "true") return null;

  const host = parsed.hostname;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length === 0) return "Could not resolve host";
    for (const a of addrs) {
      if (isPrivateIp(a.address))
        return "URL resolves to a private or reserved address";
    }
  } catch {
    return "Could not resolve host";
  }
  return null;
}

export function setupRoutes(app: Application): void {
  const csrfSecret =
    process.env.CSRF_SECRET || crypto.randomBytes(32).toString("hex");

  app.use(cookieParser(csrfSecret));

  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => csrfSecret,
    getSessionIdentifier: (req: Request) => {
      const user =
        (req as any).auth?.user || req.headers["authorization"] || "anonymous";
      return String(user);
    },
    cookieName:
      process.env.NODE_ENV === "production" ? "__Host-pg.csrf" : "pg.csrf",
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
    getCsrfTokenFromRequest: (req: Request) => {
      const header = req.headers["x-csrf-token"];
      if (typeof header === "string" && header.length > 0) return header;
      return (req.body && (req.body as any)._csrf) as string | undefined;
    },
  });

  app.use(doubleCsrfProtection);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.csrfToken = generateCsrfToken(req, res);
    next();
  });

  // Dashboard home — URL list + status
  app.get("/", (req: Request, res: Response) => {
    const config = loadConfig();
    const urls = getAllUrls();
    res.render("index", { urls, schedule: config.schedule });
  });

  // URL detail — side-by-side, history
  app.get("/url/:id", (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const url = getUrlById(id);
    if (!url) return res.status(404).send("URL not found");

    const reference = getReferenceCapture(id);
    const latest = getLatestCapture(id);
    const captures = getCapturesForUrl(id);
    const events = getChangeEventsForUrl(id);
    const dataDir = getDataDir();

    res.render("detail", { url, reference, latest, captures, events, dataDir });
  });

  // Add URL
  app.post("/url/add", async (req: Request, res: Response) => {
    const { url, label } = req.body;
    if (!url || !label) return res.status(400).send("URL and label required");

    const validationError = await validatePublicUrl(url);
    if (validationError) {
      logger.warn(`Rejected URL add for "${url}": ${validationError}`);
      return res.status(400).send(validationError);
    }

    upsertUrl(url, label);
    res.redirect("/");
  });

  // Delete URL
  app.post("/url/:id/delete", (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    deleteUrl(id);
    res.redirect("/");
  });

  // Manual trigger check
  app.post("/url/:id/check", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const url = getUrlById(id);
    if (!url) return res.status(404).send("URL not found");

    try {
      await checkUrl(url);
      res.redirect(`/url/${id}`);
    } catch (err: any) {
      logger.error(`Manual check failed: ${err.message}`);
      res.status(500).send(`Check failed: ${err.message}`);
    }
  });

  // Manual baseline capture
  app.post("/url/:id/baseline", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const url = getUrlById(id);
    if (!url) return res.status(404).send("URL not found");

    try {
      await checkUrl(url, true);
      res.redirect(`/url/${id}`);
    } catch (err: any) {
      logger.error(`Baseline capture failed: ${err.message}`);
      res.status(500).send(`Baseline failed: ${err.message}`);
    }
  });

  // Update reference to a specific capture
  app.post(
    "/url/:id/set-reference/:captureId",
    (req: Request, res: Response) => {
      const urlId = parseInt(req.params.id as string);
      const captureId = parseInt(req.params.captureId as string);

      const url = getUrlById(urlId);
      const capture = getCaptureById(captureId);
      if (!url || !capture) return res.status(404).send("Not found");

      setUrlReference(urlId, captureId);
      res.redirect(`/url/${urlId}`);
    },
  );

  // Acknowledge a change event via dashboard
  app.post("/event/:id/acknowledge", (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const event = getChangeEventById(id);
    if (!event) return res.status(404).send("Event not found");

    acknowledgeEvent(id, "dashboard");
    setUrlReference(event.url_id, event.capture_id);
    res.redirect(`/url/${event.url_id}`);
  });

  // Settings page
  app.get("/settings", (req: Request, res: Response) => {
    const config = loadConfig();
    res.render("settings", { config });
  });

  // Update settings
  app.post("/settings/update", (req: Request, res: Response) => {
    try {
      const {
        schedule_preset,
        schedule_custom,
        delay_between_checks_ms,
        ack_timeout_minutes,
        pixel_diff_percent,
        text_change_lines,
      } = req.body;

      // Determine schedule value
      const newSchedule =
        schedule_preset === "custom" ? schedule_custom : schedule_preset;

      // Validate cron expression
      if (!cron.validate(newSchedule)) {
        const config = loadConfig();
        return res.render("settings", {
          config,
          error: `Invalid cron expression: "${newSchedule}"`,
        });
      }

      const oldConfig = loadConfig();
      const scheduleChanged = oldConfig.schedule !== newSchedule;

      // Apply updates
      updateConfig({
        schedule: newSchedule,
        delay_between_checks_ms: parseInt(delay_between_checks_ms) || 3000,
        ack_timeout_minutes: parseInt(ack_timeout_minutes) || 60,
        thresholds: {
          pixel_diff_percent: parseFloat(pixel_diff_percent) || 2.0,
          text_change_lines: parseInt(text_change_lines) || 0,
        },
      });

      // Reschedule cron if changed
      if (scheduleChanged) {
        reschedule(newSchedule);
        logger.info(`Schedule updated to: ${newSchedule}`);
      }

      const config = loadConfig();
      res.render("settings", { config, flash: "Settings saved successfully." });
    } catch (err: any) {
      logger.error(`Settings update failed: ${err.message}`);
      const config = loadConfig();
      res.render("settings", {
        config,
        error: `Failed to save: ${err.message}`,
      });
    }
  });

  // API: URL status (JSON)
  app.get("/api/urls", (req: Request, res: Response) => {
    res.json(getAllUrls());
  });

  // API: reload config
  app.post("/api/reload-config", (req: Request, res: Response) => {
    try {
      reloadConfig();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve screenshot images with correct path resolution
  app.get("/screenshot/*", (req: Request, res: Response) => {
    const requested = req.params[0];
    const dataDir = path.resolve(getDataDir());
    const resolved = path.resolve(requested);
    const rel = path.relative(dataDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return res.status(403).send("Forbidden");
    }
    res.sendFile(resolved);
  });
}

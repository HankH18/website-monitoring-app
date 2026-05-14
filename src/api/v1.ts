import express, { Request, Response, NextFunction, Router } from "express";
import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import {
  getAllUrls,
  getUrlById,
  upsertUrl,
  deleteUrl,
  getLatestCapture,
  getChangeEventById,
  acknowledgeEvent,
  setUrlReference,
  getDb,
} from "../storage/db";
import { checkUrl } from "../monitor";
import { logger } from "../logger";
import { ChangeEvent, MonitoredUrl } from "../types";
import pkg from "../../package.json";

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
      if (isPrivateIp(a.address)) return "URL resolves to a private or reserved address";
    }
  } catch {
    return "Could not resolve host";
  }
  return null;
}

function jsonError(res: Response, status: number, error: string, field?: string): Response {
  const body: Record<string, string> = { error };
  if (field) body.field = field;
  return res.status(status).json(body);
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.API_TOKEN;
  if (!token || token.length === 0) {
    jsonError(
      res,
      503,
      "API_TOKEN is not configured on the server. Set API_TOKEN in your environment (see .env.example) to enable the REST API.",
    );
    return;
  }
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    jsonError(res, 401, "Missing or malformed Authorization header");
    return;
  }
  const provided = header.slice("Bearer ".length).trim();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    jsonError(res, 401, "Invalid bearer token");
    return;
  }
  if (!crypto.timingSafeEqual(a, b)) {
    jsonError(res, 401, "Invalid bearer token");
    return;
  }
  next();
}

function parsePagination(req: Request): { limit: number; offset: number } {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;
  let limit = 100;
  let offset = 0;
  if (typeof rawLimit === "string" && rawLimit.length > 0) {
    const n = parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, 1000);
  }
  if (typeof rawOffset === "string" && rawOffset.length > 0) {
    const n = parseInt(rawOffset, 10);
    if (Number.isFinite(n) && n >= 0) offset = n;
  }
  return { limit, offset };
}

const ALLOWED_CREATE_URL_FIELDS = new Set(["url", "label"]);
const ALLOWED_ACK_FIELDS = new Set(["via"]);

function rejectExtraFields(body: unknown, allowed: Set<string>): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "Body must be a JSON object";
  }
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowed.has(key)) return `Unexpected field: ${key}`;
  }
  return null;
}

function serializeUrl(u: MonitoredUrl): Record<string, unknown> {
  return {
    id: u.id,
    url: u.url,
    label: u.label,
    url_hash: u.url_hash,
    status: u.status,
    last_checked: u.last_checked,
    last_change: u.last_change,
    reference_capture_id: u.reference_capture_id,
    created_at: u.created_at,
  };
}

function serializeEvent(e: ChangeEvent): Record<string, unknown> {
  let aiDetails: string[] | null = null;
  if (e.ai_details) {
    try {
      const parsed = JSON.parse(e.ai_details);
      if (Array.isArray(parsed)) aiDetails = parsed;
    } catch {
      aiDetails = null;
    }
  }
  return {
    id: e.id,
    url_id: e.url_id,
    capture_id: e.capture_id,
    reference_capture_id: e.reference_capture_id,
    pixel_diff_percent: e.pixel_diff_percent,
    text_diff_count: e.text_diff_count,
    ai_assessment: {
      significant: e.ai_significant,
      confidence: e.ai_confidence,
      summary: e.ai_summary,
      details: aiDetails,
      category: e.ai_category,
      input_tokens: e.input_tokens ?? null,
      output_tokens: e.output_tokens ?? null,
      cost_usd: e.ai_cost_usd ?? null,
    },
    notified: !!e.notified,
    acknowledged: !!e.acknowledged,
    acknowledged_at: e.acknowledged_at,
    acknowledged_via: e.acknowledged_via,
    timestamp: e.timestamp,
  };
}

export const apiV1Router: Router = express.Router();

// Mark this router so a CSRF middleware can skip it cleanly if mounted globally.
(apiV1Router as Router & { csrfExempt?: boolean }).csrfExempt = true;

apiV1Router.use(express.json());
apiV1Router.use(bearerAuth);

apiV1Router.get("/health", (_req: Request, res: Response) => {
  let dbOk = true;
  try {
    getDb().prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  res.status(200).json({
    status: dbOk ? "ok" : "degraded",
    uptime_seconds: process.uptime(),
    version: pkg.version,
    checks: { db: dbOk ? "ok" : "fail" },
  });
});

apiV1Router.get("/urls", (req: Request, res: Response) => {
  const { limit, offset } = parsePagination(req);
  const all = getAllUrls();
  const total = all.length;
  const slice = all.slice(offset, offset + limit).map(serializeUrl);
  res.status(200).json({ urls: slice, total });
});

apiV1Router.post("/urls", async (req: Request, res: Response) => {
  const fieldErr = rejectExtraFields(req.body, ALLOWED_CREATE_URL_FIELDS);
  if (fieldErr) return jsonError(res, 400, fieldErr);
  const { url, label } = req.body as { url?: unknown; label?: unknown };
  if (typeof url !== "string" || url.length === 0) {
    return jsonError(res, 400, "url is required and must be a string", "url");
  }
  if (typeof label !== "string" || label.length === 0) {
    return jsonError(res, 400, "label is required and must be a string", "label");
  }
  const validationError = await validatePublicUrl(url);
  if (validationError) {
    logger.warn(`API rejected URL add for "${url}": ${validationError}`);
    return jsonError(res, 400, validationError, "url");
  }
  const created = upsertUrl(url, label);
  return res.status(201).json(serializeUrl(created));
});

apiV1Router.get("/urls/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return jsonError(res, 400, "Invalid id", "id");
  const url = getUrlById(id);
  if (!url) return jsonError(res, 404, "URL not found");
  const latest = getLatestCapture(id);
  return res.status(200).json({
    ...serializeUrl(url),
    latest_capture: latest
      ? {
          id: latest.id,
          timestamp: latest.timestamp,
          is_reference: !!latest.is_reference,
          screenshot_path: latest.screenshot_path,
        }
      : null,
  });
});

apiV1Router.delete("/urls/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return jsonError(res, 400, "Invalid id", "id");
  const url = getUrlById(id);
  if (!url) return jsonError(res, 404, "URL not found");
  deleteUrl(id);
  return res.status(200).json({ deleted: true, id });
});

apiV1Router.post("/urls/:id/check", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return jsonError(res, 400, "Invalid id", "id");
  const url = getUrlById(id);
  if (!url) return jsonError(res, 404, "URL not found");

  try {
    await checkUrl(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API manual check failed for url ${id}: ${msg}`);
    return jsonError(res, 500, `Check failed: ${msg}`);
  }

  const db = getDb();
  const latestEvent = db
    .prepare("SELECT id FROM change_events WHERE url_id = ? ORDER BY id DESC LIMIT 1")
    .get(id) as { id: number } | undefined;

  return res.status(202).json({
    url_id: id,
    change_event_id: latestEvent ? latestEvent.id : null,
  });
});

apiV1Router.get("/events", (req: Request, res: Response) => {
  const { limit, offset } = parsePagination(req);
  const filters: string[] = [];
  const params: (string | number)[] = [];

  const rawUrlId = req.query.url_id;
  if (typeof rawUrlId === "string" && rawUrlId.length > 0) {
    const n = parseInt(rawUrlId, 10);
    if (!Number.isFinite(n)) return jsonError(res, 400, "url_id must be an integer", "url_id");
    filters.push("url_id = ?");
    params.push(n);
  }

  const rawAck = req.query.acknowledged;
  if (typeof rawAck === "string" && rawAck.length > 0) {
    if (rawAck !== "true" && rawAck !== "false") {
      return jsonError(res, 400, "acknowledged must be 'true' or 'false'", "acknowledged");
    }
    filters.push("acknowledged = ?");
    params.push(rawAck === "true" ? 1 : 0);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const db = getDb();
  const total = (
    db.prepare(`SELECT COUNT(*) as c FROM change_events ${where}`).get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(`SELECT * FROM change_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ChangeEvent[];

  res.status(200).json({ events: rows.map(serializeEvent), total });
});

apiV1Router.get("/events/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return jsonError(res, 400, "Invalid id", "id");
  const event = getChangeEventById(id);
  if (!event) return jsonError(res, 404, "Event not found");
  res.status(200).json(serializeEvent(event));
});

apiV1Router.post("/events/:id/acknowledge", (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return jsonError(res, 400, "Invalid id", "id");

  const body = req.body ?? {};
  const fieldErr = rejectExtraFields(body, ALLOWED_ACK_FIELDS);
  if (fieldErr) return jsonError(res, 400, fieldErr);

  const event = getChangeEventById(id);
  if (!event) return jsonError(res, 404, "Event not found");

  const bodyObj = body as { via?: unknown };
  const via = typeof bodyObj.via === "string" && bodyObj.via.length > 0 ? bodyObj.via : "api";

  acknowledgeEvent(id, via);
  setUrlReference(event.url_id, event.capture_id);
  return res.status(200).json({ acknowledged: true, id, via });
});

apiV1Router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if ((err as Error & { type?: string }).type === "entity.parse.failed") {
    jsonError(res, 400, "Malformed JSON body");
    return;
  }
  logger.error(`API v1 internal error: ${err.message}`);
  jsonError(res, 500, "Internal server error");
});

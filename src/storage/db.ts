import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";
import { getDataDir } from "../config";
import { MonitoredUrl, Capture, ChangeEvent, UrlStatus } from "../types";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, "pageguard.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitored_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_checked TEXT,
      last_change TEXT,
      reference_capture_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (reference_capture_id) REFERENCES captures(id)
    );

    CREATE TABLE IF NOT EXISTS captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_id INTEGER NOT NULL,
      screenshot_path TEXT NOT NULL,
      text_path TEXT NOT NULL,
      text_content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      is_reference INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (url_id) REFERENCES monitored_urls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_id INTEGER NOT NULL,
      capture_id INTEGER NOT NULL,
      reference_capture_id INTEGER NOT NULL,
      pixel_diff_percent REAL NOT NULL DEFAULT 0,
      text_diff_count INTEGER NOT NULL DEFAULT 0,
      ai_significant INTEGER,
      ai_confidence REAL,
      ai_summary TEXT,
      ai_details TEXT,
      ai_category TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      ai_cost_usd REAL,
      notified INTEGER NOT NULL DEFAULT 0,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      acknowledged_at TEXT,
      acknowledged_via TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      slack_ts TEXT,
      slack_channel TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (url_id) REFERENCES monitored_urls(id) ON DELETE CASCADE,
      FOREIGN KEY (capture_id) REFERENCES captures(id),
      FOREIGN KEY (reference_capture_id) REFERENCES captures(id)
    );

    CREATE INDEX IF NOT EXISTS idx_captures_url_id ON captures(url_id);
    CREATE INDEX IF NOT EXISTS idx_change_events_url_id ON change_events(url_id);
    CREATE INDEX IF NOT EXISTS idx_change_events_unacked ON change_events(acknowledged, notified);
  `);

  // Migrations: add columns to change_events for existing databases. NULL for older rows.
  addColumnIfMissing(db, "change_events", "input_tokens", "INTEGER");
  addColumnIfMissing(db, "change_events", "output_tokens", "INTEGER");
  addColumnIfMissing(db, "change_events", "ai_cost_usd", "REAL");

  // Mute windows
  addColumnIfMissing(db, "monitored_urls", "muted_until", "DATETIME");

  // Uptime layer
  addColumnIfMissing(db, "monitored_urls", "last_status_check", "DATETIME");
  addColumnIfMissing(db, "monitored_urls", "last_status_code", "INTEGER");
  addColumnIfMissing(db, "monitored_urls", "last_response_time_ms", "INTEGER");
  addColumnIfMissing(db, "monitored_urls", "ssl_not_after", "DATETIME");
  addColumnIfMissing(db, "monitored_urls", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE monitored_urls SET consecutive_failures = 0 WHERE consecutive_failures IS NULL");

  // Selector-targeted monitoring
  addColumnIfMissing(db, "monitored_urls", "selectors_json", "TEXT");
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function urlHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
}

// --- Monitored URLs ---

function hydrateUrl(row: MonitoredUrl | undefined): MonitoredUrl | undefined {
  if (!row) return row;
  return { ...row, selectors: parseSelectorsJson(row.selectors_json ?? null) };
}

export function parseSelectorsJson(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  } catch {
    return [];
  }
}

export function upsertUrl(url: string, label: string): MonitoredUrl {
  const db = getDb();
  const hash = urlHash(url);
  db.prepare(
    `INSERT INTO monitored_urls (url, label, url_hash) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET label = excluded.label`,
  ).run(url, label, hash);
  return hydrateUrl(
    db.prepare("SELECT * FROM monitored_urls WHERE url = ?").get(url) as MonitoredUrl,
  ) as MonitoredUrl;
}

export function updateUrlSelectors(id: number, selectors: string[]): void {
  const cleaned = selectors.map((s) => s.trim()).filter((s) => s.length > 0);
  const json = cleaned.length === 0 ? null : JSON.stringify(cleaned);
  getDb().prepare("UPDATE monitored_urls SET selectors_json = ? WHERE id = ?").run(json, id);
}

export function getAllUrls(): MonitoredUrl[] {
  const rows = getDb().prepare("SELECT * FROM monitored_urls ORDER BY id").all() as MonitoredUrl[];
  return rows.map((r) => hydrateUrl(r) as MonitoredUrl);
}

export function getUrlById(id: number): MonitoredUrl | undefined {
  const row = getDb().prepare("SELECT * FROM monitored_urls WHERE id = ?").get(id) as
    | MonitoredUrl
    | undefined;
  return hydrateUrl(row);
}

export function deleteUrl(id: number): void {
  getDb().prepare("DELETE FROM monitored_urls WHERE id = ?").run(id);
}

export function updateUrlStatus(id: number, status: UrlStatus): void {
  getDb()
    .prepare("UPDATE monitored_urls SET status = ?, last_checked = datetime('now') WHERE id = ?")
    .run(status, id);
}

export function muteUrl(id: number, minutes: number): void {
  getDb()
    .prepare(
      `UPDATE monitored_urls SET muted_until = datetime('now', '+' || ? || ' minutes') WHERE id = ?`,
    )
    .run(minutes, id);
}

export function unmuteUrl(id: number): void {
  getDb().prepare("UPDATE monitored_urls SET muted_until = NULL WHERE id = ?").run(id);
}

export function updateUrlUptime(
  id: number,
  statusCode: number | null,
  responseTimeMs: number,
  sslNotAfter: Date | null,
  resetFailures: boolean,
): number {
  const db = getDb();
  if (resetFailures) {
    db.prepare(
      `UPDATE monitored_urls
       SET last_status_check = datetime('now'),
           last_status_code = ?,
           last_response_time_ms = ?,
           ssl_not_after = ?,
           consecutive_failures = 0
       WHERE id = ?`,
    ).run(statusCode, responseTimeMs, sslNotAfter ? sslNotAfter.toISOString() : null, id);
    return 0;
  }
  db.prepare(
    `UPDATE monitored_urls
     SET last_status_check = datetime('now'),
         last_status_code = ?,
         last_response_time_ms = ?,
         ssl_not_after = ?,
         consecutive_failures = consecutive_failures + 1
     WHERE id = ?`,
  ).run(statusCode, responseTimeMs, sslNotAfter ? sslNotAfter.toISOString() : null, id);
  const row = db.prepare("SELECT consecutive_failures FROM monitored_urls WHERE id = ?").get(id) as
    | { consecutive_failures: number }
    | undefined;
  return row?.consecutive_failures ?? 0;
}

export function setUrlReference(urlId: number, captureId: number): void {
  const db = getDb();
  db.prepare("UPDATE captures SET is_reference = 0 WHERE url_id = ?").run(urlId);
  db.prepare("UPDATE captures SET is_reference = 1 WHERE id = ?").run(captureId);
  db.prepare("UPDATE monitored_urls SET reference_capture_id = ?, status = 'ok' WHERE id = ?").run(
    captureId,
    urlId,
  );
}

// --- Captures ---

export function insertCapture(
  urlId: number,
  screenshotPath: string,
  textPath: string,
  textContent: string,
  isReference: boolean,
): Capture {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO captures (url_id, screenshot_path, text_path, text_content, is_reference)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(urlId, screenshotPath, textPath, textContent, isReference ? 1 : 0);
  return db.prepare("SELECT * FROM captures WHERE id = ?").get(info.lastInsertRowid) as Capture;
}

export function getReferenceCapture(urlId: number): Capture | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM captures WHERE url_id = ? AND is_reference = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(urlId) as Capture | undefined;
}

export function getLatestCapture(urlId: number): Capture | undefined {
  return getDb()
    .prepare("SELECT * FROM captures WHERE url_id = ? ORDER BY id DESC LIMIT 1")
    .get(urlId) as Capture | undefined;
}

export function getCaptureById(id: number): Capture | undefined {
  return getDb().prepare("SELECT * FROM captures WHERE id = ?").get(id) as Capture | undefined;
}

export function getCapturesForUrl(urlId: number, limit = 20): Capture[] {
  return getDb()
    .prepare("SELECT * FROM captures WHERE url_id = ? ORDER BY id DESC LIMIT ?")
    .all(urlId, limit) as Capture[];
}

// --- Change Events ---

export function insertChangeEvent(event: {
  url_id: number;
  capture_id: number;
  reference_capture_id: number;
  pixel_diff_percent: number;
  text_diff_count: number;
  ai_significant?: boolean;
  ai_confidence?: number;
  ai_summary?: string;
  ai_details?: string[];
  ai_category?: string;
  input_tokens?: number;
  output_tokens?: number;
  ai_cost_usd?: number;
}): ChangeEvent {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO change_events
        (url_id, capture_id, reference_capture_id, pixel_diff_percent, text_diff_count,
         ai_significant, ai_confidence, ai_summary, ai_details, ai_category,
         input_tokens, output_tokens, ai_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.url_id,
      event.capture_id,
      event.reference_capture_id,
      event.pixel_diff_percent,
      event.text_diff_count,
      event.ai_significant != null ? (event.ai_significant ? 1 : 0) : null,
      event.ai_confidence ?? null,
      event.ai_summary ?? null,
      event.ai_details ? JSON.stringify(event.ai_details) : null,
      event.ai_category ?? null,
      event.input_tokens ?? null,
      event.output_tokens ?? null,
      event.ai_cost_usd ?? null,
    );
  return db
    .prepare("SELECT * FROM change_events WHERE id = ?")
    .get(info.lastInsertRowid) as ChangeEvent;
}

export function markEventNotified(eventId: number, slackTs?: string, slackChannel?: string): void {
  getDb()
    .prepare("UPDATE change_events SET notified = 1, slack_ts = ?, slack_channel = ? WHERE id = ?")
    .run(slackTs ?? null, slackChannel ?? null, eventId);
}

export function acknowledgeEvent(eventId: number, via: string): void {
  getDb()
    .prepare(
      "UPDATE change_events SET acknowledged = 1, acknowledged_at = datetime('now'), acknowledged_via = ? WHERE id = ?",
    )
    .run(via, eventId);
}

export function markReminderSent(eventId: number): void {
  getDb().prepare("UPDATE change_events SET reminder_sent = 1 WHERE id = ?").run(eventId);
}

export function getUnacknowledgedEvents(): ChangeEvent[] {
  return getDb()
    .prepare(
      `SELECT * FROM change_events
       WHERE notified = 1 AND acknowledged = 0 AND ai_significant = 1
       ORDER BY timestamp DESC`,
    )
    .all() as ChangeEvent[];
}

export function getChangeEventsForUrl(urlId: number, limit = 50): ChangeEvent[] {
  return getDb()
    .prepare("SELECT * FROM change_events WHERE url_id = ? ORDER BY id DESC LIMIT ?")
    .all(urlId, limit) as ChangeEvent[];
}

export function getChangeEventById(id: number): ChangeEvent | undefined {
  return getDb().prepare("SELECT * FROM change_events WHERE id = ?").get(id) as
    | ChangeEvent
    | undefined;
}

export function getChangeEventBySlackTs(slackTs: string): ChangeEvent | undefined {
  return getDb().prepare("SELECT * FROM change_events WHERE slack_ts = ?").get(slackTs) as
    | ChangeEvent
    | undefined;
}

import fs from "fs";
import path from "path";
import { getDataDir } from "../config";
import { urlHash, getDb, getAllUrls } from "./db";
import { Capture } from "../types";
import { logger } from "../logger";

export function ensureCaptureDir(url: string, timestamp: string): string {
  const hash = urlHash(url);
  const dir = path.join(
    getDataDir(),
    "captures",
    hash,
    timestamp.replace(/[: ]/g, "-"),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getScreenshotPath(captureDir: string): string {
  return path.join(captureDir, "screenshot.png");
}

export function getTextPath(captureDir: string): string {
  return path.join(captureDir, "content.txt");
}

export function readTextContent(textPath: string): string {
  if (!fs.existsSync(textPath)) return "";
  return fs.readFileSync(textPath, "utf-8");
}

export function readScreenshot(screenshotPath: string): Buffer {
  return fs.readFileSync(screenshotPath);
}

export function ensureDataDir(): void {
  const dataDir = getDataDir();
  fs.mkdirSync(path.join(dataDir, "captures"), { recursive: true });
}

export interface CleanupResult {
  urls_processed: number;
  captures_deleted: number;
  bytes_freed: number;
}

export function cleanupOldCaptures(): CleanupResult {
  const keepPerUrl = parseInt(process.env.RETENTION_KEEP_PER_URL || "20", 10);
  const db = getDb();
  const urls = getAllUrls();

  let capturesDeleted = 0;
  let bytesFreed = 0;

  const deleteStmt = db.prepare("DELETE FROM captures WHERE id = ?");

  for (const url of urls) {
    const recent = db
      .prepare(
        "SELECT id FROM captures WHERE url_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(url.id, keepPerUrl) as { id: number }[];

    const unackedCaptureIds = db
      .prepare(
        "SELECT DISTINCT capture_id AS id FROM change_events WHERE url_id = ? AND acknowledged = 0",
      )
      .all(url.id) as { id: number }[];

    const keep = new Set<number>();
    for (const r of recent) keep.add(r.id);
    for (const e of unackedCaptureIds) keep.add(e.id);
    if (url.reference_capture_id != null) keep.add(url.reference_capture_id);

    const candidates = db
      .prepare("SELECT * FROM captures WHERE url_id = ? AND is_reference = 0")
      .all(url.id) as Capture[];

    for (const cap of candidates) {
      if (keep.has(cap.id)) continue;

      for (const p of [cap.screenshot_path, cap.text_path]) {
        try {
          const stat = fs.statSync(p);
          bytesFreed += stat.size;
          fs.unlinkSync(p);
        } catch (err: any) {
          if (err.code !== "ENOENT") {
            logger.warn(`cleanup: failed to remove ${p}: ${err.message}`);
          }
        }
      }

      const captureDir = path.dirname(cap.screenshot_path);
      try {
        const remaining = fs.readdirSync(captureDir);
        if (remaining.length === 0) fs.rmdirSync(captureDir);
      } catch {
        // ignore
      }

      deleteStmt.run(cap.id);
      capturesDeleted++;
    }
  }

  return {
    urls_processed: urls.length,
    captures_deleted: capturesDeleted,
    bytes_freed: bytesFreed,
  };
}

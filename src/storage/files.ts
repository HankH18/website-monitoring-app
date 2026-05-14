import fs from "fs";
import path from "path";
import { getDataDir } from "../config";
import { urlHash } from "./db";

export function ensureCaptureDir(url: string, timestamp: string): string {
  const hash = urlHash(url);
  const dir = path.join(getDataDir(), "captures", hash, timestamp.replace(/[: ]/g, "-"));
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

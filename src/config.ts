import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { AppConfig } from "./types";

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "config.yaml");

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = yaml.load(raw) as AppConfig;

  // Apply defaults
  parsed.schedule = parsed.schedule || "*/15 * * * *";
  parsed.delay_between_checks_ms = parsed.delay_between_checks_ms ?? 3000;
  parsed.thresholds = parsed.thresholds || { pixel_diff_percent: 2.0, text_change_lines: 0 };
  parsed.ack_timeout_minutes = parsed.ack_timeout_minutes ?? 60;
  parsed.ack_check_interval_minutes = parsed.ack_check_interval_minutes ?? 5;
  parsed.notifications = parsed.notifications || { slack: true, email: false };
  parsed.dashboard = parsed.dashboard || { port: 3000 };
  parsed.playwright = parsed.playwright || {
    viewport_width: 1280,
    viewport_height: 720,
    wait_after_load_ms: 2000,
    full_page_screenshot: true,
  };
  parsed.urls = parsed.urls || [];

  _config = parsed;
  return parsed;
}

export function reloadConfig(): AppConfig {
  _config = null;
  return loadConfig();
}

export function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

export function updateConfig(updates: Partial<AppConfig>): AppConfig {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = yaml.load(raw) as Record<string, any>;

  // Merge updates into the parsed config
  if (updates.schedule !== undefined) parsed.schedule = updates.schedule;
  if (updates.delay_between_checks_ms !== undefined) parsed.delay_between_checks_ms = updates.delay_between_checks_ms;
  if (updates.ack_timeout_minutes !== undefined) parsed.ack_timeout_minutes = updates.ack_timeout_minutes;
  if (updates.thresholds) {
    parsed.thresholds = parsed.thresholds || {};
    if (updates.thresholds.pixel_diff_percent !== undefined)
      parsed.thresholds.pixel_diff_percent = updates.thresholds.pixel_diff_percent;
    if (updates.thresholds.text_change_lines !== undefined)
      parsed.thresholds.text_change_lines = updates.thresholds.text_change_lines;
  }

  // Write back to YAML
  const newYaml = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(CONFIG_PATH, newYaml, "utf-8");

  // Reload in-memory config
  _config = null;
  return loadConfig();
}

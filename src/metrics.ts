import { getDb } from "./storage/db";
import { logger } from "./logger";
import pkg from "../package.json";

/**
 * Escape a Prometheus label value per exposition format:
 * backslash, double-quote, and newline must be escaped.
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Detect whether a column exists on a table. SQLite-specific.
 * Used to tolerate fresh DBs that haven't run the AI-token migration yet.
 */
function hasColumn(table: string, column: string): boolean {
  try {
    const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/**
 * Render Prometheus exposition-format metrics for PageGuard's own activity.
 * Returned string is suitable for `Content-Type: text/plain; version=0.0.4`.
 */
export async function renderMetrics(): Promise<string> {
  const db = getDb();
  const lines: string[] = [];

  // --- pageguard_info ---
  lines.push("# HELP pageguard_info PageGuard build info.");
  lines.push("# TYPE pageguard_info gauge");
  lines.push(`pageguard_info{version="${escapeLabel(String(pkg.version))}"} 1`);

  // --- pageguard_uptime_seconds ---
  lines.push("# HELP pageguard_uptime_seconds Process uptime in seconds.");
  lines.push("# TYPE pageguard_uptime_seconds gauge");
  lines.push(`pageguard_uptime_seconds ${process.uptime()}`);

  // --- pageguard_urls_total ---
  const urlCountRow = db.prepare("SELECT COUNT(*) AS c FROM monitored_urls").get() as { c: number };
  lines.push("# HELP pageguard_urls_total Number of URLs being monitored.");
  lines.push("# TYPE pageguard_urls_total gauge");
  lines.push(`pageguard_urls_total ${urlCountRow.c}`);

  // --- pageguard_captures_total{url_id} ---
  const captureRows = db
    .prepare("SELECT url_id, COUNT(*) AS c FROM captures GROUP BY url_id")
    .all() as Array<{ url_id: number; c: number }>;
  lines.push("# HELP pageguard_captures_total Total captures taken, per monitored URL.");
  lines.push("# TYPE pageguard_captures_total counter");
  for (const row of captureRows) {
    lines.push(`pageguard_captures_total{url_id="${row.url_id}"} ${row.c}`);
  }

  // --- pageguard_change_events_total{url_id, acknowledged} ---
  const eventRows = db
    .prepare(
      `SELECT url_id, acknowledged, COUNT(*) AS c
       FROM change_events
       GROUP BY url_id, acknowledged`,
    )
    .all() as Array<{ url_id: number; acknowledged: number; c: number }>;
  lines.push("# HELP pageguard_change_events_total Change events recorded, per URL and ack state.");
  lines.push("# TYPE pageguard_change_events_total counter");
  for (const row of eventRows) {
    const ack = row.acknowledged ? "true" : "false";
    lines.push(
      `pageguard_change_events_total{url_id="${row.url_id}",acknowledged="${ack}"} ${row.c}`,
    );
  }

  // --- pageguard_ai_tokens_total{kind} ---
  // Defensive: AI token/cost columns are added by a separate migration.
  // Use COALESCE so NULLs become 0, and gate on column presence so an
  // older DB (pre-migration) doesn't blow up the whole endpoint.
  const hasInputTokens = hasColumn("change_events", "input_tokens");
  const hasOutputTokens = hasColumn("change_events", "output_tokens");
  const hasAiCost = hasColumn("change_events", "ai_cost_usd");

  const inputTokens = hasInputTokens
    ? (
        db.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS s FROM change_events").get() as {
          s: number;
        }
      ).s
    : 0;
  const outputTokens = hasOutputTokens
    ? (
        db.prepare("SELECT COALESCE(SUM(output_tokens), 0) AS s FROM change_events").get() as {
          s: number;
        }
      ).s
    : 0;
  lines.push("# HELP pageguard_ai_tokens_total Total AI tokens consumed by change-event analysis.");
  lines.push("# TYPE pageguard_ai_tokens_total counter");
  lines.push(`pageguard_ai_tokens_total{kind="input"} ${inputTokens}`);
  lines.push(`pageguard_ai_tokens_total{kind="output"} ${outputTokens}`);

  // --- pageguard_ai_cost_usd_total ---
  const aiCost = hasAiCost
    ? (
        db.prepare("SELECT COALESCE(SUM(ai_cost_usd), 0) AS s FROM change_events").get() as {
          s: number;
        }
      ).s
    : 0;
  lines.push("# HELP pageguard_ai_cost_usd_total Cumulative AI spend in USD.");
  lines.push("# TYPE pageguard_ai_cost_usd_total counter");
  lines.push(`pageguard_ai_cost_usd_total ${aiCost}`);

  // Prometheus exposition format requires a trailing newline.
  return lines.join("\n") + "\n";
}

/**
 * Express handler. Kept in this module so server.ts stays thin.
 * Logs and returns 500 on DB failure rather than crashing.
 */
export async function metricsHandler(
  _req: unknown,
  res: {
    set: (k: string, v: string) => void;
    status: (n: number) => { send: (b: string) => void };
    send: (b: string) => void;
  },
): Promise<void> {
  try {
    const body = await renderMetrics();
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.send(body);
  } catch (err) {
    logger.error(`Failed to render /metrics: ${(err as Error).message}`);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.status(500).send(`# metrics unavailable: ${(err as Error).message}\n`);
  }
}

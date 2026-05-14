import http from "http";
import https from "https";
import { TLSSocket } from "tls";
import { MonitoredUrl } from "./types";
import { updateUrlUptime, getUrlById } from "./storage/db";
import { notifyUptimeFailure } from "./notify/uptime-alert";
import { logger } from "./logger";

const TIMEOUT_MS = 10_000;

export interface UptimeResult {
  status_code: number | null;
  response_time_ms: number;
  ssl_not_after: Date | null;
  error?: string;
}

export function checkUrlUptime(url: MonitoredUrl): Promise<UptimeResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url.url);
    } catch (err: any) {
      resolve({
        status_code: null,
        response_time_ms: 0,
        ssl_not_after: null,
        error: `Invalid URL: ${err.message}`,
      });
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const start = Date.now();
    let settled = false;

    const finish = (r: UptimeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    try {
      const req = lib.request(
        {
          method: "GET",
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: { "User-Agent": "PageGuard/1.0" },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const elapsed = Date.now() - start;
          let sslNotAfter: Date | null = null;
          if (isHttps) {
            try {
              const sock = res.socket as TLSSocket;
              const cert = sock.getPeerCertificate();
              if (cert && cert.valid_to) {
                const d = new Date(cert.valid_to);
                if (!isNaN(d.getTime())) sslNotAfter = d;
              }
            } catch {
              // ignore cert read failures
            }
          }
          res.resume(); // drain
          finish({
            status_code: res.statusCode ?? null,
            response_time_ms: elapsed,
            ssl_not_after: sslNotAfter,
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });

      req.on("error", (err: Error) => {
        finish({
          status_code: null,
          response_time_ms: Date.now() - start,
          ssl_not_after: null,
          error: err.message,
        });
      });

      req.end();
    } catch (err: any) {
      finish({
        status_code: null,
        response_time_ms: Date.now() - start,
        ssl_not_after: null,
        error: err.message,
      });
    }
  });
}

function isMuted(url: MonitoredUrl): boolean {
  if (!url.muted_until) return false;
  const until = new Date(url.muted_until.replace(" ", "T") + "Z");
  return !isNaN(until.getTime()) && until.getTime() > Date.now();
}

export async function runUptimeCheck(url: MonitoredUrl): Promise<void> {
  if (isMuted(url)) {
    logger.info(`${url.label}: muted, skipping uptime check`);
    return;
  }

  const result = await checkUrlUptime(url);
  const ok = result.status_code != null && result.status_code >= 200 && result.status_code < 400;

  const newFailures = updateUrlUptime(
    url.id,
    result.status_code,
    result.response_time_ms,
    result.ssl_not_after,
    ok,
  );

  if (ok) {
    logger.info(`${url.label}: uptime ${result.status_code} (${result.response_time_ms}ms)`);
  } else {
    logger.warn(
      `${url.label}: uptime FAIL status=${result.status_code ?? "n/a"} error=${result.error ?? "none"} consecutive=${newFailures}`,
    );
    if (newFailures === 3) {
      const fresh = getUrlById(url.id) ?? url;
      await notifyUptimeFailure(fresh, result.status_code, result.error);
    }
  }

  // SSL warning
  if (result.ssl_not_after) {
    const warnDays = parseInt(process.env.SSL_WARN_DAYS || "14", 10);
    const msLeft = result.ssl_not_after.getTime() - Date.now();
    const daysLeft = msLeft / 86_400_000;
    if (daysLeft <= warnDays) {
      logger.warn(
        `${url.label}: SSL cert expires in ${daysLeft.toFixed(1)} days (${result.ssl_not_after.toISOString()})`,
      );
    }
  }
}

export async function runAllUptimeChecks(): Promise<void> {
  const { getAllUrls } = await import("./storage/db");
  const urls = getAllUrls();
  if (urls.length === 0) return;
  for (const u of urls) {
    try {
      await runUptimeCheck(u);
    } catch (err: any) {
      logger.error(`Uptime check failed for ${u.label}: ${err.message}`);
    }
  }
}

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkUrlUptime } from "../src/uptime";
import type { MonitoredUrl } from "../src/types";

function makeUrl(url: string): MonitoredUrl {
  return {
    id: 1,
    url,
    label: "test",
    url_hash: "abcabcabcabc",
    status: "pending",
    last_checked: null,
    last_change: null,
    reference_capture_id: null,
    created_at: "2026-01-01 00:00:00",
  };
}

describe("checkUrlUptime", () => {
  describe("against a local HTTP server returning 200", () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("returns status_code=200, response_time_ms >= 0, ssl_not_after=null", async () => {
      const result = await checkUrlUptime(makeUrl(`http://127.0.0.1:${port}/`));
      expect(result.status_code).toBe(200);
      expect(result.response_time_ms).toBeGreaterThanOrEqual(0);
      expect(result.ssl_not_after).toBeNull();
      expect(result.error).toBeUndefined();
    });
  });

  describe("against a local HTTP server returning 500", () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("nope");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("returns status_code=500", async () => {
      const result = await checkUrlUptime(makeUrl(`http://127.0.0.1:${port}/`));
      expect(result.status_code).toBe(500);
      expect(result.ssl_not_after).toBeNull();
      expect(result.error).toBeUndefined();
    });
  });

  it("returns an error string and status_code=null when the connection is refused", async () => {
    // Bind an ephemeral port, capture it, then close — any subsequent connect
    // to that port should be refused (no listener).
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      tmp.close((err) => (err ? reject(err) : resolve())),
    );

    const result = await checkUrlUptime(makeUrl(`http://127.0.0.1:${port}/`));
    expect(result.status_code).toBeNull();
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
    expect(result.ssl_not_after).toBeNull();
  });

  it("returns an error for an invalid URL string", async () => {
    const result = await checkUrlUptime(makeUrl("not a url at all"));
    expect(result.status_code).toBeNull();
    expect(result.error).toMatch(/Invalid URL/i);
  });
});

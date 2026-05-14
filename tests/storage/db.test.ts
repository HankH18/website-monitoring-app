import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type DbModule = typeof import("../../src/storage/db");

let tmpDir: string;
let db: DbModule;

async function freshDb(): Promise<DbModule> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pageguard-test-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.resetModules();
  return await import("../../src/storage/db");
}

beforeEach(async () => {
  db = await freshDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("storage/db", () => {
  it("inserts a monitored URL and lists it back", () => {
    const inserted = db.upsertUrl("https://example.com", "Example");
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.url).toBe("https://example.com");
    expect(inserted.label).toBe("Example");
    expect(inserted.status).toBe("pending");

    const all = db.getAllUrls();
    expect(all).toHaveLength(1);
    expect(all[0].url).toBe("https://example.com");
  });

  it("upsertUrl updates the label on conflict instead of duplicating", () => {
    const first = db.upsertUrl("https://example.com", "Example");
    const second = db.upsertUrl("https://example.com", "Renamed");
    expect(second.id).toBe(first.id);
    expect(second.label).toBe("Renamed");
    expect(db.getAllUrls()).toHaveLength(1);
  });

  it("marks a capture as the reference and retrieves it", () => {
    const url = db.upsertUrl("https://example.com", "Example");
    const capture = db.insertCapture(
      url.id,
      "/tmp/shot.png",
      "/tmp/text.txt",
      "hello",
      false,
    );

    db.setUrlReference(url.id, capture.id);

    const ref = db.getReferenceCapture(url.id);
    expect(ref).toBeDefined();
    expect(ref!.id).toBe(capture.id);
    expect(Boolean(ref!.is_reference)).toBe(true);

    const updatedUrl = db.getUrlById(url.id);
    expect(updatedUrl?.reference_capture_id).toBe(capture.id);
    expect(updatedUrl?.status).toBe("ok");
  });

  it("setUrlReference ensures only one capture per URL is the reference", () => {
    const url = db.upsertUrl("https://example.com", "Example");
    const cap1 = db.insertCapture(
      url.id,
      "/tmp/a.png",
      "/tmp/a.txt",
      "v1",
      true,
    );
    const cap2 = db.insertCapture(
      url.id,
      "/tmp/b.png",
      "/tmp/b.txt",
      "v2",
      false,
    );
    const cap3 = db.insertCapture(
      url.id,
      "/tmp/c.png",
      "/tmp/c.txt",
      "v3",
      false,
    );

    db.setUrlReference(url.id, cap2.id);

    const captures = db.getCapturesForUrl(url.id);
    const referenceCount = captures.filter((c) =>
      Boolean(c.is_reference),
    ).length;
    expect(referenceCount).toBe(1);

    const ref = db.getReferenceCapture(url.id);
    expect(ref?.id).toBe(cap2.id);

    db.setUrlReference(url.id, cap3.id);
    const captures2 = db.getCapturesForUrl(url.id);
    expect(captures2.filter((c) => Boolean(c.is_reference))).toHaveLength(1);
    expect(db.getReferenceCapture(url.id)?.id).toBe(cap3.id);
  });

  it("does not change is_reference on other URLs when promoting one URL's capture", () => {
    const urlA = db.upsertUrl("https://a.example", "A");
    const urlB = db.upsertUrl("https://b.example", "B");
    const capA = db.insertCapture(urlA.id, "/a.png", "/a.txt", "a", false);
    const capB = db.insertCapture(urlB.id, "/b.png", "/b.txt", "b", false);

    db.setUrlReference(urlA.id, capA.id);
    db.setUrlReference(urlB.id, capB.id);

    expect(db.getReferenceCapture(urlA.id)?.id).toBe(capA.id);
    expect(db.getReferenceCapture(urlB.id)?.id).toBe(capB.id);
  });

  it("urlHash is deterministic and 12 hex chars", () => {
    const h1 = db.urlHash("https://example.com");
    const h2 = db.urlHash("https://example.com");
    const h3 = db.urlHash("https://other.example");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{12}$/);
  });
});

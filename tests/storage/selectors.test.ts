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

describe("storage/db selectors", () => {
  it("a new URL has no selectors (null in DB, empty array hydrated)", () => {
    const u = db.upsertUrl("https://example.com", "Example");
    expect(u.selectors).toEqual([]);
    expect(u.selectors_json).toBeNull();
  });

  it("updateUrlSelectors persists and round-trips JSON", () => {
    const u = db.upsertUrl("https://example.com", "Example");
    db.updateUrlSelectors(u.id, ["#hero", ".product-price", "header > nav"]);

    const fetched = db.getUrlById(u.id);
    expect(fetched).toBeDefined();
    expect(fetched!.selectors).toEqual(["#hero", ".product-price", "header > nav"]);
    expect(typeof fetched!.selectors_json).toBe("string");
    expect(JSON.parse(fetched!.selectors_json as string)).toEqual([
      "#hero",
      ".product-price",
      "header > nav",
    ]);
  });

  it("getAllUrls hydrates selectors for every row", () => {
    const a = db.upsertUrl("https://a.example", "A");
    const b = db.upsertUrl("https://b.example", "B");
    db.updateUrlSelectors(a.id, ["#main"]);
    db.updateUrlSelectors(b.id, []);

    const all = db.getAllUrls();
    const aRow = all.find((r) => r.id === a.id)!;
    const bRow = all.find((r) => r.id === b.id)!;
    expect(aRow.selectors).toEqual(["#main"]);
    expect(bRow.selectors).toEqual([]);
  });

  it("updates can replace existing selectors", () => {
    const u = db.upsertUrl("https://example.com", "Example");
    db.updateUrlSelectors(u.id, ["#a", "#b"]);
    db.updateUrlSelectors(u.id, ["#c"]);
    expect(db.getUrlById(u.id)!.selectors).toEqual(["#c"]);
  });

  it("empty array stores NULL (equivalent to no selectors)", () => {
    const u = db.upsertUrl("https://example.com", "Example");
    db.updateUrlSelectors(u.id, ["#x"]);
    db.updateUrlSelectors(u.id, []);
    const fetched = db.getUrlById(u.id);
    expect(fetched!.selectors).toEqual([]);
    expect(fetched!.selectors_json).toBeNull();
  });

  it("whitespace-only or empty selector entries are stripped", () => {
    const u = db.upsertUrl("https://example.com", "Example");
    db.updateUrlSelectors(u.id, ["  #hero  ", "", "   ", ".price"]);
    expect(db.getUrlById(u.id)!.selectors).toEqual(["#hero", ".price"]);
  });

  it("parseSelectorsJson tolerates malformed JSON", () => {
    expect(db.parseSelectorsJson(null)).toEqual([]);
    expect(db.parseSelectorsJson("")).toEqual([]);
    expect(db.parseSelectorsJson("not json")).toEqual([]);
    expect(db.parseSelectorsJson('{"not":"array"}')).toEqual([]);
    expect(db.parseSelectorsJson('["a", "", "b", "  ", 5]')).toEqual(["a", "b"]);
  });
});

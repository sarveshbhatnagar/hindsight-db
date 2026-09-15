import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HindsightDB, openDatabase } from "../src/index.js";

const T0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const HOUR = 3_600_000;

let db: HindsightDB;
beforeEach(async () => {
  db = openDatabase();
  // 10 days of daily "market" points for AAPL and MSFT, plus a few news items.
  await db.timeline.insertMany(
    Array.from({ length: 10 }, (_, i) => [
      { timestamp: T0 + i * DAY, entity: "AAPL", namespace: "market", data: { close: 100 + i } },
      { timestamp: T0 + i * DAY, entity: "MSFT", namespace: "market", data: { close: 200 + i } },
    ]).flat(),
  );
  await db.timeline.insertMany([
    // published at day 3, but only observed (ingested) at day 3 + 12h
    { timestamp: T0 + 3 * DAY, observedAt: T0 + 3 * DAY + 12 * HOUR, entity: "AAPL", namespace: "news", data: "late" },
    { timestamp: T0 + 5 * DAY, entity: "AAPL", namespace: "news", data: "ontime" },
  ]);
});
afterEach(() => db.close());

describe("timeline.insert", () => {
  it("returns ids and defaults observedAt to timestamp", async () => {
    const p = await db.timeline.insert({ timestamp: "2024-02-01T00:00:00Z", entity: "X", namespace: "custom", data: 1 });
    expect(p.id).toBeGreaterThan(0);
    expect(p.observedAt).toBe(p.timestamp);
    expect(p.data).toBe(1);
  });
  it("validates required fields", async () => {
    await expect(db.timeline.insert({ timestamp: T0, entity: "", namespace: "m", data: 1 })).rejects.toThrow(/entity/);
    await expect(db.timeline.insert({ timestamp: T0, entity: "A", namespace: "", data: 1 })).rejects.toThrow(/namespace/);
  });
});

describe("timeline.range", () => {
  it("returns points in an inclusive window, ascending", async () => {
    const page = await db.timeline.range({ entity: "AAPL", namespace: "market", from: T0 + 2 * DAY, to: T0 + 4 * DAY });
    expect(page.items.map((p) => p.data)).toEqual([{ close: 102 }, { close: 103 }, { close: 104 }]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("filters by multiple entities / namespaces", async () => {
    const page = await db.timeline.range({ entity: ["AAPL", "MSFT"], from: T0, to: T0 });
    expect(page.items.map((p) => p.entity)).toEqual(["AAPL", "MSFT"]);
    const news = await db.timeline.range({ namespace: "news", from: T0, to: T0 + 30 * DAY });
    expect(news.items.map((p) => p.data)).toEqual(["late", "ontime"]);
  });

  it("paginates with a stable cursor", async () => {
    const p1 = await db.timeline.range({ entity: "AAPL", namespace: "market", from: T0, to: T0 + 9 * DAY, limit: 4 });
    expect(p1.items).toHaveLength(4);
    const p2 = await db.timeline.range({ entity: "AAPL", namespace: "market", from: T0, to: T0 + 9 * DAY, limit: 4, cursor: p1.nextCursor });
    const p3 = await db.timeline.range({ entity: "AAPL", namespace: "market", from: T0, to: T0 + 9 * DAY, limit: 4, cursor: p2.nextCursor });
    const all = [...p1.items, ...p2.items, ...p3.items].map((p) => (p.data as { close: number }).close);
    expect(all).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(p3.nextCursor).toBeUndefined();
  });

  it("asOf cuts on observation time, not event time", async () => {
    const before = await db.timeline.range({ namespace: "news", from: T0, to: T0 + 9 * DAY, asOf: T0 + 3 * DAY });
    expect(before.items).toHaveLength(0);
    const after = await db.timeline.range({ namespace: "news", from: T0, to: T0 + 9 * DAY, asOf: T0 + 3 * DAY + 12 * HOUR });
    expect(after.items.map((p) => p.data)).toEqual(["late"]);
  });

  it("rejects a malformed cursor", async () => {
    await expect(db.timeline.range({ from: T0, to: T0, cursor: "!!!" })).rejects.toThrow(/Invalid cursor/);
  });
});

describe("timeline.around", () => {
  beforeEach(async () => {
    await db.events.insert({ id: "ev", timestamp: T0 + 5 * DAY, type: "earnings", entities: ["AAPL"] });
    await db.events.insert({ id: "ev-noent", timestamp: T0 + 5 * DAY, type: "macro" });
  });

  it("groups streams by namespace, scoped to the event's entities", async () => {
    const streams = await db.timeline.around({ eventId: "ev", before: "2d", after: "1d" });
    expect(Object.keys(streams).sort()).toEqual(["market", "news"]);
    expect(streams.market!.map((p) => (p.data as { close: number }).close)).toEqual([103, 104, 105, 106]);
    expect(streams.market!.every((p) => p.entity === "AAPL")).toBe(true);
    expect(streams.news!.map((p) => p.data)).toEqual(["late", "ontime"]);
  });

  it("falls back to all entities when the event has none, and honours overrides", async () => {
    const all = await db.timeline.around({ eventId: "ev-noent", before: "0d", after: "0d" });
    expect(all.market!.map((p) => p.entity)).toEqual(["AAPL", "MSFT"]);
    const only = await db.timeline.around({ eventId: "ev", before: "0d", entities: "MSFT", namespace: "market" });
    expect(only.market!.map((p) => p.entity)).toEqual(["MSFT"]);
  });

  it("throws for unknown events", async () => {
    await expect(db.timeline.around({ eventId: "nope" })).rejects.toThrow(/not found/);
  });
});

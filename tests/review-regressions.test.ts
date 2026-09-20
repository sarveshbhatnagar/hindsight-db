import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HindsightDB, openDatabase } from "../src/index.js";
import { openTestDatabase } from "./helpers/backend.js";
import { MAX_LIST } from "../src/storage/storage.js";

const T0 = Date.UTC(2024, 0, 10);
const DAY = 86_400_000;
const HOUR = 3_600_000;

let db: HindsightDB;
beforeEach(async () => {
  db = await openTestDatabase();
});
afterEach(() => db.close());

describe("outcomes: decision/event consistency is enforced even with an explicit timestamp", () => {
  it("rejects a decision belonging to another event", async () => {
    await db.events.insertMany([
      { id: "ev1", timestamp: T0, type: "x" },
      { id: "ev2", timestamp: T0, type: "x" },
    ]);
    await db.decisions.insert({ id: "d2", eventId: "ev2", timestamp: T0, action: "x" });
    await expect(
      db.outcomes.insert({ eventId: "ev1", decisionId: "d2", timestamp: T0 + DAY, horizon: "1d", result: 1 }),
    ).rejects.toThrow(/belongs to event ev2/);
    await expect(
      db.outcomes.insert({ eventId: "nope", timestamp: T0 + DAY, horizon: "1d", result: 1 }),
    ).rejects.toThrow(/Event not found/);
    expect(await db.outcomes.forEvent("ev1")).toEqual([]);
  });
});

describe("events.list: order is whitelisted at runtime", () => {
  it("rejects anything but asc/desc", async () => {
    await db.events.insert({ id: "e", timestamp: T0, type: "x" });
    const injected = "asc, (CASE WHEN 1 THEN 0 ELSE (SELECT 1/0) END)" as unknown as "asc";
    await expect(db.events.list({ order: injected })).rejects.toThrow(/Invalid order/);
    await expect(db.events.list({ order: "ASC" as unknown as "asc" })).rejects.toThrow(/Invalid order/);
    expect((await db.events.list({ order: "desc" })).items).toHaveLength(1);
  });
});

describe("embeddings: non-finite values are rejected", () => {
  it("at insert time", async () => {
    await expect(db.events.insert({ timestamp: T0, type: "x", embedding: [1, NaN] })).rejects.toThrow(/non-finite.*index 1/);
    await expect(db.events.insert({ timestamp: T0, type: "x", embedding: [Infinity, 0] })).rejects.toThrow(/non-finite/);
    await expect(db.events.insert({ timestamp: T0, type: "x", embedding: [] })).rejects.toThrow(/must not be empty/);
  });
  it("at query time", async () => {
    await db.events.insert({ id: "e", timestamp: T0, type: "x", embedding: [1, 0] });
    await expect(db.events.similar({ event: [NaN, 0] })).rejects.toThrow(/non-finite/);
    const hits = await db.events.similar({ event: [1, 0] });
    expect(hits.map((h) => h.id)).toEqual(["e"]);
  });
});

describe("large id lists are chunked", () => {
  const N = MAX_LIST * 2 + 7;

  it("events.getMany / history.getMany / decisions.forEvents handle > MAX_LIST ids", async () => {
    const ids = Array.from({ length: N }, (_, i) => `e${i}`);
    await db.events.insertMany(ids.map((id, i) => ({ id, timestamp: T0 + i, type: "x" })));
    await db.decisions.insertMany(ids.slice(0, 3).map((id) => ({ eventId: id, timestamp: T0, action: "a" })));
    await db.outcomes.insertMany(ids.slice(0, 2).map((id) => ({ eventId: id, horizon: "1d", result: 1 })));

    const got = await db.events.getMany(ids);
    expect(got.map((e) => e.id)).toEqual(ids);

    const hs = await db.history.getMany({ eventIds: ids, before: "0ms" });
    expect(hs).toHaveLength(N);
    expect(hs.filter((h) => h.decisions.length).length).toBe(3);
    expect(hs.filter((h) => h.outcomes.length).length).toBe(0); // outcomes land at +1d, past the window
  });

  it("filter lists over the limit fail with a clear error instead of a driver error", async () => {
    const ids = Array.from({ length: MAX_LIST + 1 }, (_, i) => `e${i}`);
    await expect(db.events.list({ filters: { excludeIds: ids } })).rejects.toThrow(/Too many values/);
  });
});

describe("history: contextUntil / outcomeUntil consistency", () => {
  beforeEach(async () => {
    await db.events.insert({ id: "ev", timestamp: T0, observedAt: T0 + 2 * HOUR, type: "x", entities: ["A"] });
    await db.timeline.insertMany([
      { timestamp: T0, entity: "A", namespace: "m", data: "at-event" },
      { timestamp: T0, observedAt: T0 + HOUR, entity: "A", namespace: "m", data: "seen-1h-later" },
    ]);
  });

  it("default outcomeUntil never falls before contextUntil", async () => {
    const h = await db.history.get({ eventId: "ev" }); // after = 0, but observed 2h later
    expect(h.window.contextUntil).toBe(T0 + 2 * HOUR);
    expect(h.window.outcomeUntil).toBe(T0 + 2 * HOUR);
    expect(h.window.to).toBe(T0 + 2 * HOUR);
    expect(h.context.m!.map((p) => p.data)).toEqual(["at-event", "seen-1h-later"]);
    expect(h.timeline.m).toEqual(h.context.m);
  });

  it("rejects explicit cutoffs where context would know more than the outcome view", async () => {
    await expect(
      db.history.get({ eventId: "ev", contextUntil: T0 + DAY, outcomeUntil: T0 }),
    ).rejects.toThrow(/contextUntil .* must not be after outcomeUntil/);
    await expect(db.history.get({ eventId: "ev", outcomeUntil: T0 })).rejects.toThrow(RangeError);
  });
});

describe("closed database", () => {
  it("throws a clear error on use", async () => {
    const local = openDatabase();
    local.close();
    await expect(local.events.insert({ timestamp: T0, type: "x" })).rejects.toThrow(/not open/);
    await expect(local.events.list()).rejects.toThrow(/not open/);
  });
});

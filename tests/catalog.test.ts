import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionGraph, openDatabase } from "../src/index.js";

const T0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;

let db: ActionGraph;
beforeEach(async () => {
  db = openDatabase();
  await db.events.insertMany([
    { id: "e1", timestamp: T0, type: "earnings", entities: ["AAPL", "sector:tech"] },
    { id: "e2", timestamp: T0 + DAY, type: "earnings", entities: ["NVDA", "sector:tech", "theme:ai"] },
    { id: "e3", timestamp: T0 + 2 * DAY, type: "news", entities: ["AAPL", "NVDA"] },
    { id: "e4", timestamp: T0 + 3 * DAY, type: "macro" }, // no entities
    { id: "e5", timestamp: T0 + 4 * DAY, type: "news", entities: ["XOM", "sector:energy"] },
  ]);
  await db.timeline.insertMany([
    { timestamp: T0, entity: "AAPL", namespace: "market", data: 1 },
    { timestamp: T0 + DAY, entity: "AAPL", namespace: "market", data: 2 },
    { timestamp: T0 + DAY, entity: "AAPL", namespace: "news", data: "x" },
    { timestamp: T0 + 2 * DAY, entity: "NVDA", namespace: "market", data: 3 },
    { timestamp: T0 + 5 * DAY, entity: "SPX", namespace: "macro", data: 4 },
  ]);
});
afterEach(() => db.close());

describe("events.entities", () => {
  it("lists entities with counts and event-time span, most frequent first", async () => {
    const all = await db.events.entities();
    expect(all).toEqual([
      { entity: "AAPL", count: 2, firstSeen: T0, lastSeen: T0 + 2 * DAY },
      { entity: "NVDA", count: 2, firstSeen: T0 + DAY, lastSeen: T0 + 2 * DAY },
      { entity: "sector:tech", count: 2, firstSeen: T0, lastSeen: T0 + DAY },
      { entity: "XOM", count: 1, firstSeen: T0 + 4 * DAY, lastSeen: T0 + 4 * DAY },
      { entity: "sector:energy", count: 1, firstSeen: T0 + 4 * DAY, lastSeen: T0 + 4 * DAY },
      { entity: "theme:ai", count: 1, firstSeen: T0 + DAY, lastSeen: T0 + DAY },
    ]);
  });

  it("filters by type, time range and prefix; honours limit", async () => {
    expect((await db.events.entities({ type: "news" })).map((e) => [e.entity, e.count])).toEqual([
      ["AAPL", 1],
      ["NVDA", 1],
      ["XOM", 1],
      ["sector:energy", 1],
    ]);
    expect((await db.events.entities({ from: T0 + 3 * DAY })).map((e) => e.entity)).toEqual(["XOM", "sector:energy"]);
    expect((await db.events.entities({ prefix: "sector:" })).map((e) => [e.entity, e.count])).toEqual([
      ["sector:tech", 2],
      ["sector:energy", 1],
    ]);
    expect(await db.events.entities({ limit: 1 })).toHaveLength(1);
    expect(await db.events.entities({ prefix: "zzz" })).toEqual([]);
  });
});

describe("events.types", () => {
  it("lists types with counts and span", async () => {
    expect(await db.events.types()).toEqual([
      { type: "earnings", count: 2, firstSeen: T0, lastSeen: T0 + DAY },
      { type: "news", count: 2, firstSeen: T0 + 2 * DAY, lastSeen: T0 + 4 * DAY },
      { type: "macro", count: 1, firstSeen: T0 + 3 * DAY, lastSeen: T0 + 3 * DAY },
    ]);
  });
});

describe("entitiesAll filter", () => {
  const ids = async (filters: Parameters<typeof db.events.list>[0]["filters"]) =>
    (await db.events.list({ filters })).items.map((e) => e.id);

  it("requires every listed entity", async () => {
    expect(await ids({ entitiesAll: ["AAPL", "NVDA"] })).toEqual(["e3"]);
    expect(await ids({ entitiesAll: ["NVDA", "sector:tech"] })).toEqual(["e2"]);
    expect(await ids({ entitiesAll: ["AAPL", "XOM"] })).toEqual([]);
    expect(await ids({ entitiesAll: "AAPL" })).toEqual(["e1", "e3"]);
    // duplicates in the list don't change the requirement
    expect(await ids({ entitiesAll: ["AAPL", "AAPL", "NVDA"] })).toEqual(["e3"]);
  });

  it("combines with the any-of filter and works in similar()", async () => {
    expect(await ids({ entities: ["XOM", "NVDA"], entitiesAll: ["sector:tech"] })).toEqual(["e2"]);
    await db.events.insertMany([
      { id: "v1", timestamp: T0, type: "x", entities: ["A", "B"], embedding: [1, 0] },
      { id: "v2", timestamp: T0, type: "x", entities: ["A"], embedding: [1, 0] },
    ]);
    const hits = await db.events.similar({ event: [1, 0], filters: { entitiesAll: ["A", "B"] } });
    expect(hits.map((h) => h.id)).toEqual(["v1"]);
  });
});

describe("timeline.entities / timeline.namespaces", () => {
  it("lists entities with point counts, namespaces and span", async () => {
    expect(await db.timeline.entities()).toEqual([
      { entity: "AAPL", count: 3, namespaces: ["market", "news"], from: T0, to: T0 + DAY },
      { entity: "NVDA", count: 1, namespaces: ["market"], from: T0 + 2 * DAY, to: T0 + 2 * DAY },
      { entity: "SPX", count: 1, namespaces: ["macro"], from: T0 + 5 * DAY, to: T0 + 5 * DAY },
    ]);
    expect((await db.timeline.entities({ namespace: "market" })).map((e) => [e.entity, e.count])).toEqual([
      ["AAPL", 2],
      ["NVDA", 1],
    ]);
    expect((await db.timeline.entities({ prefix: "SP" })).map((e) => e.entity)).toEqual(["SPX"]);
  });

  it("lists namespaces with counts, distinct entities and span", async () => {
    expect(await db.timeline.namespaces()).toEqual([
      { namespace: "market", count: 3, entities: 2, from: T0, to: T0 + 2 * DAY },
      { namespace: "macro", count: 1, entities: 1, from: T0 + 5 * DAY, to: T0 + 5 * DAY },
      { namespace: "news", count: 1, entities: 1, from: T0 + DAY, to: T0 + DAY },
    ]);
  });

  it("is empty on an empty store", async () => {
    const fresh = openDatabase();
    expect(await fresh.events.entities()).toEqual([]);
    expect(await fresh.events.types()).toEqual([]);
    expect(await fresh.timeline.entities()).toEqual([]);
    expect(await fresh.timeline.namespaces()).toEqual([]);
    fresh.close();
  });
});

describe("events.addEntities / removeEntities / renameEntity", () => {
  it("appends new entities in order, ignores duplicates, and is filterable immediately", async () => {
    const ev = await db.events.addEntities("e1", ["theme:ai", "AAPL", "NVDA", "theme:ai"]);
    expect(ev.entities).toEqual(["AAPL", "sector:tech", "theme:ai", "NVDA"]);
    expect((await db.events.get("e1"))!.entities).toEqual(["AAPL", "sector:tech", "theme:ai", "NVDA"]);
    expect((await db.events.list({ filters: { entitiesAll: ["theme:ai", "AAPL"] } })).items.map((e) => e.id)).toEqual(["e1"]);
    // Appending again keeps the order stable.
    const again = await db.events.addEntities("e1", ["XOM"]);
    expect(again.entities).toEqual(["AAPL", "sector:tech", "theme:ai", "NVDA", "XOM"]);
  });

  it("labels an event that had no entities", async () => {
    const ev = await db.events.addEntities("e4", ["macro:fomc"]);
    expect(ev.entities).toEqual(["macro:fomc"]);
    expect((await db.events.entities({ prefix: "macro:" })).map((e) => e.entity)).toEqual(["macro:fomc"]);
  });

  it("removes entities and ignores ones not present", async () => {
    const ev = await db.events.removeEntities("e2", ["sector:tech", "nope"]);
    expect(ev.entities).toEqual(["NVDA", "theme:ai"]);
    expect((await db.events.list({ filters: { entities: "sector:tech" } })).items.map((e) => e.id)).toEqual(["e1"]);
    // Removing then re-adding appends at the end.
    expect((await db.events.addEntities("e2", ["sector:tech"])).entities).toEqual(["NVDA", "theme:ai", "sector:tech"]);
  });

  it("validates input and unknown events", async () => {
    await expect(db.events.addEntities("nope", ["A"])).rejects.toThrow(/not found/);
    await expect(db.events.removeEntities("nope", ["A"])).rejects.toThrow(/not found/);
    await expect(db.events.addEntities("e1", [""])).rejects.toThrow(/non-empty/);
    await expect(db.events.addEntities("e1", ["a\x1fb"])).rejects.toThrow(/U\+001F/);
    expect((await db.events.addEntities("e1", [])).entities).toEqual(["AAPL", "sector:tech"]);
  });

  it("renames an entity across events, merging with events that already have the target", async () => {
    await db.events.addEntities("e3", ["sector:tech"]); // e3 now has AAPL, NVDA, sector:tech
    await db.events.addEntities("e5", ["tech"]); // a variant spelling on an energy event
    expect(await db.events.renameEntity("sector:tech", "tech")).toBe(3); // e1, e2, e3
    expect((await db.events.entities({ prefix: "sector:" })).map((e) => e.entity)).toEqual(["sector:energy"]);
    expect((await db.events.entities()).find((e) => e.entity === "tech")?.count).toBe(4); // e1,e2,e3,e5
    expect((await db.events.get("e5"))!.entities).toEqual(["XOM", "sector:energy", "tech"]);
    expect(await db.events.renameEntity("ghost", "x")).toBe(0);
    expect(await db.events.renameEntity("tech", "tech")).toBe(0);
  });
});

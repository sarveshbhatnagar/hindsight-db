import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HindsightDB, openDatabase } from "../src/index.js";

const T0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;

let db: HindsightDB;
beforeEach(() => {
  db = openDatabase();
});
afterEach(() => db.close());

describe("events.insert / get", () => {
  it("round-trips a full event and generates ids", async () => {
    const ev = await db.events.insert({
      timestamp: T0,
      type: "earnings",
      entities: ["AAPL", "AAPL"],
      content: { headline: "Beat" },
      embedding: [1, 0, 0],
      metadata: { sector: "tech", surprise: 0.12, flagged: true, note: null },
    });
    expect(ev.id).toMatch(/[0-9a-f-]{36}/);
    expect(ev.entities).toEqual(["AAPL"]);
    expect(ev.observedAt).toBe(T0);

    const got = await db.events.get(ev.id, { includeEmbedding: true });
    expect(got).toMatchObject({
      id: ev.id,
      timestamp: T0,
      observedAt: T0,
      type: "earnings",
      entities: ["AAPL"],
      content: { headline: "Beat" },
      metadata: { sector: "tech", surprise: 0.12, flagged: true, note: null },
    });
    expect(Array.from(got!.embedding!)).toEqual([1, 0, 0]);

    const noEmb = await db.events.get(ev.id);
    expect(noEmb!.embedding).toBeUndefined();
  });

  it("accepts ISO timestamps and a separate observedAt", async () => {
    const ev = await db.events.insert({
      id: "e1",
      timestamp: "2024-01-01T00:00:00Z",
      observedAt: "2024-01-01T06:00:00Z",
      type: "filing",
    });
    expect(ev.timestamp).toBe(T0);
    expect(ev.observedAt).toBe(T0 + 6 * 3_600_000);
    expect(ev.content).toBeNull();
    expect(ev.metadata).toEqual({});
  });

  it("rejects duplicate ids and missing type", async () => {
    await db.events.insert({ id: "dup", timestamp: T0, type: "x" });
    await expect(db.events.insert({ id: "dup", timestamp: T0, type: "x" })).rejects.toThrow();
    await expect(db.events.insert({ timestamp: T0, type: "" })).rejects.toThrow(/type is required/);
  });

  it("getMany preserves order and omits missing; delete cascades", async () => {
    await db.events.insertMany([
      { id: "a", timestamp: T0, type: "x", entities: ["Z"] },
      { id: "b", timestamp: T0, type: "x" },
    ]);
    const got = await db.events.getMany(["b", "nope", "a"]);
    expect(got.map((e) => e.id)).toEqual(["b", "a"]);
    expect(await db.events.delete("a")).toBe(true);
    expect(await db.events.delete("a")).toBe(false);
    expect(await db.events.get("a")).toBeUndefined();
  });
});

describe("events.list", () => {
  beforeEach(async () => {
    await db.events.insertMany(
      Array.from({ length: 7 }, (_, i) => ({
        id: `e${i}`,
        timestamp: T0 + i * DAY,
        observedAt: T0 + i * DAY + 3_600_000,
        type: i % 2 ? "odd" : "even",
        entities: [i < 4 ? "AAPL" : "MSFT"],
        metadata: { bucket: i < 3 ? "a" : "b", n: i },
      })),
    );
  });

  it("paginates in order with a cursor", async () => {
    const p1 = await db.events.list({ limit: 3 });
    expect(p1.items.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await db.events.list({ limit: 3, cursor: p1.nextCursor });
    expect(p2.items.map((e) => e.id)).toEqual(["e3", "e4", "e5"]);
    const p3 = await db.events.list({ limit: 3, cursor: p2.nextCursor });
    expect(p3.items.map((e) => e.id)).toEqual(["e6"]);
    expect(p3.nextCursor).toBeUndefined();
  });

  it("supports desc ordering", async () => {
    const p = await db.events.list({ limit: 2, order: "desc" });
    expect(p.items.map((e) => e.id)).toEqual(["e6", "e5"]);
  });

  it("filters by type, entity, time range, asOf and metadata", async () => {
    const ids = async (filters: Parameters<typeof db.events.list>[0]["filters"]) =>
      (await db.events.list({ filters })).items.map((e) => e.id);

    expect(await ids({ type: "odd" })).toEqual(["e1", "e3", "e5"]);
    expect(await ids({ type: ["odd", "even"], entities: "MSFT" })).toEqual(["e4", "e5", "e6"]);
    expect(await ids({ from: T0 + 2 * DAY, to: T0 + 4 * DAY })).toEqual(["e2", "e3", "e4"]);
    // e2 is observed 1h after its timestamp — asOf exactly at its timestamp excludes it
    expect(await ids({ asOf: T0 + 2 * DAY })).toEqual(["e0", "e1"]);
    expect(await ids({ metadata: { bucket: "a" } })).toEqual(["e0", "e1", "e2"]);
    expect(await ids({ metadata: { bucket: "b", n: 5 } })).toEqual(["e5"]);
    expect(await ids({ excludeIds: ["e0", "e1", "e2", "e3", "e4"] })).toEqual(["e5", "e6"]);
  });

  it("rejects unsafe metadata keys", async () => {
    await expect(db.events.list({ filters: { metadata: { "a'b": 1 } } })).rejects.toThrow(/Invalid metadata/);
  });
});

describe("events.similar", () => {
  beforeEach(async () => {
    await db.events.insertMany([
      { id: "q", timestamp: T0 + 10 * DAY, type: "earnings", entities: ["AAPL"], embedding: [1, 0, 0] },
      { id: "near", timestamp: T0 + 1 * DAY, type: "earnings", entities: ["AAPL"], embedding: [0.9, 0.1, 0] },
      { id: "mid", timestamp: T0 + 2 * DAY, type: "earnings", entities: ["MSFT"], embedding: [0.5, 0.5, 0] },
      { id: "far", timestamp: T0 + 3 * DAY, type: "news", entities: ["AAPL"], embedding: [0, 1, 0] },
      { id: "opp", timestamp: T0 + 4 * DAY, type: "earnings", entities: ["AAPL"], embedding: [-1, 0, 0] },
      { id: "future", timestamp: T0 + 20 * DAY, type: "earnings", entities: ["AAPL"], embedding: [1, 0, 0] },
      { id: "noemb", timestamp: T0 + 5 * DAY, type: "earnings", entities: ["AAPL"] },
      { id: "otherdim", timestamp: T0 + 5 * DAY, type: "earnings", embedding: [1, 0] },
    ]);
  });

  it("ranks by cosine similarity and excludes the query event itself", async () => {
    const hits = await db.events.similar({ event: "q", limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(["future", "near", "mid", "far", "opp"]);
    expect(hits[0]!.score).toBeCloseTo(1);
    expect(hits[1]!.score).toBeCloseTo(0.9 / Math.hypot(0.9, 0.1));
    expect(hits[4]!.score).toBeCloseTo(-1);
    expect(hits[0]).toMatchObject({ timestamp: T0 + 20 * DAY, type: "earnings", entities: ["AAPL"] });
  });

  it("respects limit and minScore", async () => {
    const hits = await db.events.similar({ event: "q", limit: 2 });
    expect(hits.map((h) => h.id)).toEqual(["future", "near"]);
    const positive = await db.events.similar({ event: "q", minScore: 0.5 });
    expect(positive.map((h) => h.id)).toEqual(["future", "near", "mid"]);
  });

  it("accepts a bare embedding or an object with an embedding", async () => {
    expect((await db.events.similar({ event: [0, 1, 0], limit: 1 }))[0]!.id).toBe("far");
    expect((await db.events.similar({ event: Float32Array.from([0, 1, 0]), limit: 1 }))[0]!.id).toBe("far");
    // object form with id: the id is excluded from results
    const hits = await db.events.similar({ event: { id: "near", embedding: [1, 0, 0] } });
    expect(hits.map((h) => h.id)).not.toContain("near");
    expect(hits.map((h) => h.id)).toContain("q");
  });

  it("applies filters, including asOf for point-in-time safety", async () => {
    const asOf = await db.events.similar({ event: "q", filters: { asOf: T0 + 10 * DAY } });
    expect(asOf.map((h) => h.id)).toEqual(["near", "mid", "far", "opp"]);
    const typed = await db.events.similar({ event: "q", filters: { type: "news" } });
    expect(typed.map((h) => h.id)).toEqual(["far"]);
    const ent = await db.events.similar({ event: "q", filters: { entities: ["MSFT"] } });
    expect(ent.map((h) => h.id)).toEqual(["mid"]);
  });

  it("errors on unknown events or events without embeddings", async () => {
    await expect(db.events.similar({ event: "nope" })).rejects.toThrow(/not found/);
    await expect(db.events.similar({ event: "noemb" })).rejects.toThrow(/no embedding/);
    await expect(db.events.similar({ event: {} })).rejects.toThrow(TypeError);
  });
});

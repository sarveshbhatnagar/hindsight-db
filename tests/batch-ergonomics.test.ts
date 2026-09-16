import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addDuration, HindsightDB, openDatabase, uuidv7 } from "../src/index.js";
import { SECONDARY_INDEXES } from "../src/storage/migrations.js";

const T0 = Date.UTC(2024, 0, 10);
const DAY = 86_400_000;

let db: HindsightDB;
beforeEach(() => {
  db = openDatabase();
});
afterEach(() => db.close());

describe("addDuration", () => {
  it("shifts a timestamp by a signed duration in any input form", () => {
    expect(addDuration(T0, "-7d")).toBe(T0 - 7 * DAY);
    expect(addDuration(T0, "1d")).toBe(T0 + DAY);
    expect(addDuration("2024-01-10T00:00:00Z", "12h")).toBe(T0 + 12 * 3_600_000);
    expect(addDuration(new Date(T0), -500)).toBe(T0 - 500);
    expect(addDuration(T0, "0")).toBe(T0);
    expect(() => addDuration(T0, "7 days")).toThrow(/Invalid duration/);
  });

  it("makes the design doc's range example work", async () => {
    const ev = await db.events.insert({ id: "e", timestamp: T0, type: "x", entities: ["A"] });
    await db.timeline.insertMany([-8, -7, 0, 1, 2].map((d) => ({ timestamp: T0 + d * DAY, entity: "A", namespace: "m", data: d })));
    const page = await db.timeline.range({
      entity: "A",
      from: addDuration(ev.timestamp, "-7d"),
      to: addDuration(ev.timestamp, "1d"),
    });
    expect(page.items.map((p) => p.data)).toEqual([-7, 0, 1]);
  });
});

describe("uuidv7 ids", () => {
  it("is the default id generator and produces valid, time-ordered v7 uuids", async () => {
    const a = await db.events.insert({ timestamp: T0, type: "x" });
    const b = await db.events.insert({ timestamp: T0, type: "x" });
    const d = await db.decisions.insert({ eventId: a.id, timestamp: T0, action: 1 });
    const o = await db.outcomes.insert({ eventId: a.id, horizon: "1d", result: 1 });
    for (const id of [a.id, b.id, d.id, o.id]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(a.id < b.id).toBe(true);
    expect(b.id < d.id).toBe(true);
    expect(d.id < o.id).toBe(true);
  });

  it("stays strictly increasing within one millisecond and across ms", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Timestamp prefix encodes the time it was minted (48-bit ms, big-endian).
    const fixed = uuidv7(Date.UTC(2030, 0, 1));
    expect(parseInt(fixed.slice(0, 8) + fixed.slice(9, 13), 16)).toBe(Date.UTC(2030, 0, 1));
  });

  it("still honours a custom idGenerator", async () => {
    let n = 0;
    const custom = openDatabase({ idGenerator: () => `custom-${++n}` });
    expect((await custom.events.insert({ timestamp: T0, type: "x" })).id).toBe("custom-1");
    custom.close();
  });
});

describe("similar() returns content", () => {
  it("includes the stored content so candidates can be displayed without a second lookup", async () => {
    await db.events.insertMany([
      { id: "a", timestamp: T0, type: "x", content: { headline: "AAPL beats" }, embedding: [1, 0] },
      { id: "b", timestamp: T0, type: "x", content: "plain text", embedding: [0.9, 0.1] },
      { id: "c", timestamp: T0, type: "x", embedding: [0, 1] },
    ]);
    const hits = await db.events.similar({ event: [1, 0], limit: 3 });
    expect(hits.map((h) => [h.id, h.content])).toEqual([
      ["a", { headline: "AAPL beats" }],
      ["b", "plain text"],
      ["c", null],
    ]);
  });
});

describe("batched reads", () => {
  it("list() and getMany() attach entities in order for every row, across chunk boundaries", async () => {
    const n = 5003; // > one MAX_LIST chunk
    await db.events.insertMany(
      Array.from({ length: n }, (_, i) => ({
        id: `e${String(i).padStart(5, "0")}`,
        timestamp: T0 + i,
        type: "x",
        entities: i % 3 === 0 ? [] : [`Z${i}`, `A${i}`, "shared"],
      })),
    );
    const ids = Array.from({ length: n }, (_, i) => `e${String(i).padStart(5, "0")}`);
    const many = await db.events.getMany(ids);
    expect(many).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(many[i]!.entities).toEqual(i % 3 === 0 ? [] : [`Z${i}`, `A${i}`, "shared"]);
    }
    const page = await db.events.list({ limit: 10, cursor: undefined, order: "desc" });
    expect(page.items[0]!.id).toBe(ids[n - 1]);
    expect(page.items[0]!.entities).toEqual([`Z${n - 1}`, `A${n - 1}`, "shared"]);
  });

  it("outcomes.insertMany resolves anchors in bulk with the same validation as before", async () => {
    await db.events.insertMany([
      { id: "e1", timestamp: T0, type: "x" },
      { id: "e2", timestamp: T0 + DAY, type: "x" },
    ]);
    await db.decisions.insertMany([
      { id: "d1", eventId: "e1", timestamp: T0 + 3_600_000, action: 1 },
      { id: "d2", eventId: "e2", timestamp: T0 + DAY + 3_600_000, action: 1 },
    ]);
    const out = await db.outcomes.insertMany([
      { eventId: "e1", decisionId: "d1", horizon: "1d", result: 1 },
      { eventId: "e2", horizon: "2d", result: 2 },
      { eventId: "e2", decisionId: "d2", horizon: "0", result: 3 },
    ]);
    expect(out.map((o) => o.timestamp)).toEqual([T0 + 3_600_000 + DAY, T0 + 3 * DAY, T0 + DAY + 3_600_000]);
    // Cross-event decision and unknown ids still fail, atomically.
    await expect(
      db.outcomes.insertMany([
        { id: "ok", eventId: "e1", horizon: "1d", result: 1 },
        { eventId: "e1", decisionId: "d2", horizon: "1d", result: 1 },
      ]),
    ).rejects.toThrow(/belongs to event e2/);
    await expect(db.outcomes.insertMany([{ eventId: "nope", horizon: "1d", result: 1 }])).rejects.toThrow(/Event not found/);
    await expect(db.outcomes.insertMany([{ eventId: "e1", decisionId: "nope", horizon: "1d", result: 1 }])).rejects.toThrow(
      /Decision not found/,
    );
    expect(await db.outcomes.get("ok")).toBeUndefined();
  });
});

describe("bulkLoad", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hindsight-bulk-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const indexNames = (raw: Database.Database) =>
    (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name,
    );

  it("drops secondary indexes during the load and rebuilds them after; data and queries are intact", async () => {
    const raw = (db as unknown as { conn: { db: Database.Database } }).conn.db;
    const before = indexNames(raw);
    expect(before).toEqual(Object.keys(SECONDARY_INDEXES).sort());

    const result = await db.bulkLoad(async () => {
      expect(indexNames(raw)).toEqual([]);
      await db.events.insertMany(Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, timestamp: T0 + i, type: "x", entities: ["A"] })));
      await db.timeline.insertMany(Array.from({ length: 1000 }, (_, i) => ({ timestamp: T0 + i, entity: "A", namespace: "m", data: i })));
      await new Promise((r) => setTimeout(r, 1)); // real async work in between is fine
      return "done";
    });
    expect(result).toBe("done");
    expect(indexNames(raw)).toEqual(before);
    expect((await db.timeline.range({ entity: "A", namespace: "m", from: T0, to: T0 + 9 })).items).toHaveLength(10);
    expect((await db.events.list({ filters: { entities: "A" }, limit: 1000 })).items).toHaveLength(100);
    const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT * FROM timeline WHERE entity = ? AND timestamp >= ?`).all("A", T0) as { detail: string }[];
    expect(plan[0]!.detail).toMatch(/USING INDEX timeline_entity/);
  });

  it("rebuilds indexes even when the callback throws, and rejects nesting / use inside a transaction", async () => {
    const raw = (db as unknown as { conn: { db: Database.Database } }).conn.db;
    await expect(db.bulkLoad(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(indexNames(raw)).toEqual(Object.keys(SECONDARY_INDEXES).sort());
    await expect(db.bulkLoad(() => db.bulkLoad(() => 1))).rejects.toThrow(/cannot be nested/);
    let inTx: Promise<unknown> | undefined;
    db.transaction(() => {
      inTx = db.bulkLoad(() => 1);
      inTx.catch(() => {});
    });
    await expect(inTx).rejects.toThrow(/inside a transaction/);
  });

  it("a file left without indexes by an interrupted load is repaired on next open", async () => {
    const path = join(dir, "crash.db");
    let file = openDatabase({ path });
    await file.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
    // Simulate a crash mid-bulkLoad: indexes dropped, process gone before the rebuild.
    const raw = (file as unknown as { conn: { db: Database.Database } }).conn.db;
    for (const name of Object.keys(SECONDARY_INDEXES)) raw.exec(`DROP INDEX ${name}`);
    expect(indexNames(raw)).toEqual([]);
    file.close();

    file = openDatabase({ path });
    expect(indexNames((file as unknown as { conn: { db: Database.Database } }).conn.db)).toEqual(Object.keys(SECONDARY_INDEXES).sort());
    expect((await file.timeline.range({ entity: "A", from: T0, to: T0 })).items).toHaveLength(1);
    file.close();
  });
});

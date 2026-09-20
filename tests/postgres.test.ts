import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  openDatabase,
  POSTGRES_SCHEMA_VERSION,
  type Event,
  type EventProvider,
  type HindsightDB,
  type PgPool,
  type SqliteEventStore,
} from "../src/index.js";
import { POSTGRES_SECONDARY_INDEXES } from "../src/storage/postgres.js";
import { DATABASE_URL, schemaFor, truncate } from "./helpers/backend.js";

/**
 * Behaviour specific to the Postgres backend: opening, schema handling,
 * transaction semantics on a networked (fully asynchronous) store, and the
 * things the shared suite cannot see. The shared suite itself runs against
 * Postgres as the "postgres" vitest project (see vitest.config.ts).
 *
 * Skipped unless DATABASE_URL is set; the pgvector container from
 * insights-db's README on :5433 works.
 */

const T0 = Date.UTC(2024, 0, 10);
const DAY = 86_400_000;
const url = DATABASE_URL!;
const SCHEMA = schemaFor("postgres.test.ts");

// The structural pool type accepts a real pg.Pool as is (compile-time check).
type _PoolAssignable = import("pg").Pool extends PgPool ? true : never;
const _poolAssignable: _PoolAssignable = true;
void _poolAssignable;

describe.skipIf(!url)("Postgres backend", () => {
  let events: HindsightDB<SqliteEventStore>;
  let db: HindsightDB<SqliteEventStore>;
  const open = (extra: { schema?: string } = {}) => {
    events = openDatabase();
    db = openDatabase({ storage: "postgres", connectionString: url, schema: SCHEMA, ...extra, events: events.events });
    return db;
  };
  const raw = (h: HindsightDB<never> | HindsightDB<SqliteEventStore>) =>
    (h as unknown as { conn: { pool: { query(q: { text: string; values?: unknown[] }): Promise<{ rows: Record<string, unknown>[] }> } } }).conn.pool;

  beforeAll(async () => {
    const h = open();
    await h.ready();
    await truncate(h);
    await h.close();
    await events.close();
  });

  afterEach(async () => {
    await db?.close();
    await events?.close();
    db = events = undefined as never;
  });

  it("refuses to open without an external event source", () => {
    expect(() => openDatabase({ storage: "postgres", connectionString: url } as never)).toThrow(/external event source/);
  });

  it("validates its options up front", () => {
    const provider = openDatabase().events;
    expect(() => openDatabase({ storage: "postgres", events: provider })).toThrow(/connectionString or a pool/);
    expect(() => openDatabase({ storage: "postgres", connectionString: url, pool: {} as PgPool, events: provider })).toThrow(/not both/);
    expect(() => openDatabase({ storage: "postgres", pool: {} as PgPool, schema: "x", events: provider })).toThrow(/schema/);
    expect(() => openDatabase({ storage: "postgres", connectionString: url, schema: "bad-name", events: provider })).toThrow(/Invalid schema/);
  });

  it("creates the schema and tables on first use; ready() and schemaVersion report it", async () => {
    open();
    expect(db.storage).toBe("postgres");
    expect(() => db.schemaVersion).toThrow(/not ready/);
    await db.ready();
    expect(db.schemaVersion).toBe(POSTGRES_SCHEMA_VERSION);
    const tables = await raw(db).query({
      text: `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      values: [SCHEMA],
    });
    expect(tables.rows.map((r) => r.table_name)).toEqual(["decisions", "entity_aliases", "event_refs", "hindsight_schema", "outcomes", "timeline"]);
    const version = await raw(db).query({ text: `SELECT version FROM hindsight_schema` });
    expect(version.rows).toEqual([{ version: POSTGRES_SCHEMA_VERSION }]);
  });

  it("surfaces a connection failure through ready() and every operation, never as an unhandled rejection", async () => {
    events = openDatabase();
    db = openDatabase({
      storage: "postgres",
      connectionString: "postgres://nobody:wrong@localhost:1/nope",
      events: events.events,
    });
    await expect(db.ready()).rejects.toThrow();
    await expect(db.timeline.range({ from: T0, to: T0 })).rejects.toThrow();
    await expect(db.transaction(async () => 1)).rejects.toThrow();
  });

  it("shares a caller's pool and leaves it open on close()", async () => {
    const { default: pg } = await import("pg");
    const base = new URL(url);
    base.searchParams.set("options", `-c search_path=${SCHEMA},public`);
    const pool = new pg.Pool({ connectionString: base.toString() });
    events = openDatabase();
    db = openDatabase({ storage: "postgres", pool, events: events.events });
    await db.ready();
    await truncate(db);
    await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
    await db.close();
    // Still usable: the pool was not ours to end.
    expect((await pool.query(`SELECT count(*)::int AS n FROM timeline`)).rows[0]).toEqual({ n: 1 });
    await pool.end();
  });

  describe("data", () => {
    it("round-trips int8 columns as numbers and JSON columns exactly", async () => {
      open();
      await db.ready();
      await truncate(db);
      const big = 1_700_000_000_000; // epoch ms: beyond int4
      const data = { nested: { deep: [1, 2.5, "x", null, true] }, big: 9007199254740991, neg: -0.001, s: "ünïcödé " };
      const p = await db.timeline.insert({ timestamp: big, observedAt: big + 1, entity: "A", namespace: "m", data });
      expect(p).toEqual({ id: 1, timestamp: big, observedAt: big + 1, entity: "A", namespace: "m", data });
      const [got] = (await db.timeline.range({ from: big, to: big })).items;
      expect(got).toEqual(p);
      expect(typeof got!.timestamp).toBe("number");
      const [stats] = await db.timeline.entities();
      expect(stats).toEqual({ entity: "A", count: 1, namespaces: ["m"], from: big, to: big });
    });

    it("multi-row inserts keep ids aligned with inputs across statement chunks", async () => {
      open();
      await db.ready();
      await truncate(db);
      const n = 2500; // 5 columns → 1000 rows per statement → 3 statements
      const inputs = Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i, entity: `E${i % 7}`, namespace: "m", data: i }));
      const points = await db.timeline.insertMany(inputs);
      expect(points.map((p) => p.id)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      const back = await db.timeline.range({ from: T0, to: T0 + n, limit: 100_000 });
      expect(back.items.map((p) => [p.id, p.data])).toEqual(points.map((p) => [p.id, p.data]));
    });

    it("history.getMany batches uniform windows into one query and agrees with per-event history.get", async () => {
      open();
      await db.ready();
      await truncate(db);
      await events.events.insertMany([
        { id: "e1", timestamp: T0, type: "x", entities: ["A"] },
        { id: "e2", timestamp: T0 + 10 * DAY, type: "x", entities: ["B", "A"] },
        { id: "e3", timestamp: T0 + 20 * DAY, type: "x" }, // no entities: selects every stream
      ]);
      const points = [];
      for (let d = -5; d <= 25; d++) {
        for (const entity of ["A", "B", "C"]) {
          points.push({ timestamp: T0 + d * DAY, entity, namespace: "m", data: d });
          if (d % 3 === 0) points.push({ timestamp: T0 + d * DAY, observedAt: T0 + (d + 2) * DAY, entity, namespace: "late", data: d });
        }
      }
      await db.timeline.insertMany(points);
      await db.aliases.add("B", "C");
      const queries = [
        { before: "3d", after: "2d" },
        { before: "3d", after: "2d", maxPoints: 4 },
        { before: "30d", namespace: "late" },
        { before: "3d", entities: ["C"] },
        { before: "3d", after: "1d", contextUntil: T0 + 8 * DAY, outcomeUntil: T0 + 30 * DAY },
      ] as const;
      for (const opts of queries) {
        // e1 + e2 have entities and e3 has none: mixed shapes fall back to one query per window.
        for (const eventIds of [["e1", "e2"], ["e1", "e2", "e3"], ["e3", "e1"]]) {
          const many = await db.history.getMany({ eventIds, ...opts });
          const singles = [];
          for (const id of eventIds) singles.push(await db.history.get({ eventId: id, ...opts }));
          expect(many, JSON.stringify({ eventIds, opts })).toEqual(singles);
        }
      }
    });
  });

  describe("transactions", () => {
    it("commits an async callback's awaited writes together and rolls them back on a rejection", async () => {
      open();
      await db.ready();
      await truncate(db);
      await events.events.insert({ id: "ev", timestamp: T0, type: "x" });
      const id = await db.transaction(async () => {
        const d = await db.decisions.insert({ eventId: "ev", timestamp: T0, action: "buy" });
        await db.outcomes.insert({ eventId: "ev", decisionId: d.id, horizon: "1d", result: 1 });
        await db.transaction(async () => {
          await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
        });
        return d.id;
      });
      expect((await db.outcomes.forEvent("ev")).map((o) => o.decisionId)).toEqual([id]);
      expect((await db.timeline.range({ from: T0, to: T0 })).items).toHaveLength(1);

      await expect(
        db.transaction(async () => {
          await db.timeline.insert({ timestamp: T0 + 1, entity: "A", namespace: "m", data: 2 });
          await db.aliases.add("x", "A");
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect((await db.timeline.range({ from: T0, to: T0 + DAY })).items).toHaveLength(1);
      expect(await db.aliases.list()).toEqual([]);
    });

    it("a failed store call inside the callback rolls the whole transaction back even if swallowed", async () => {
      open();
      await db.ready();
      await truncate(db);
      await expect(
        db.transaction(async () => {
          await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
          await db.decisions.insert({ eventId: "missing", timestamp: T0, action: 1 }).catch(() => {});
          await db.timeline.insert({ timestamp: T0 + 1, entity: "A", namespace: "m", data: 2 });
        }),
      ).rejects.toThrow(/foreign key/);
      expect((await db.timeline.range({ from: T0, to: T0 + DAY })).items).toEqual([]);
      // The connection is fine afterwards.
      await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 3 });
      expect((await db.timeline.range({ from: T0, to: T0 })).items).toHaveLength(1);
    });

    it("a synchronous callback's un-awaited store calls are drained before the commit", async () => {
      open();
      await db.ready();
      await truncate(db);
      await db.transaction(() => {
        void db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
        void db.aliases.add("42", "A");
      });
      expect((await db.timeline.range({ from: T0, to: T0 })).items).toHaveLength(1);
      expect(await db.aliases.list()).toEqual([{ externalId: "42", entity: "A" }]);
    });

    it("is isolated from other connections until commit", async () => {
      open();
      await db.ready();
      await truncate(db);
      let seenDuring: unknown[] = [];
      await db.transaction(async () => {
        await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
        // A query on the pool (another connection) does not see the uncommitted row.
        seenDuring = (await raw(db).query({ text: "SELECT id::int FROM timeline" })).rows;
      });
      expect(seenDuring).toEqual([]);
      expect((await raw(db).query({ text: "SELECT id::int FROM timeline" })).rows).toEqual([{ id: 1 }]);
    });
  });

  describe("external events", () => {
    it("fetches stubs on first reference, fails unknown ids as foreign keys, and gc() drops what the provider lost", async () => {
      const store = new Map<string, Event>();
      const provider: EventProvider = {
        get: async (id) => store.get(id),
        getMany: vi.fn(async (ids: string[]) => ids.flatMap((id) => (store.has(id) ? [store.get(id)!] : []))),
        list: async () => ({ items: [] }),
        similar: async () => [],
        entities: async () => [],
        types: async () => [],
      };
      const ev = (id: string, timestamp: number): Event => ({ id, timestamp, observedAt: timestamp, type: "x", entities: [], content: null, metadata: {} });
      store.set("r1", ev("r1", T0));
      store.set("r2", ev("r2", T0 + DAY));
      events = openDatabase();
      db = openDatabase({ storage: "postgres", connectionString: url, schema: SCHEMA, events: provider }) as unknown as HindsightDB<SqliteEventStore>;
      await db.ready();
      await truncate(db);

      const d = await db.decisions.insert({ eventId: "r1", timestamp: T0 + 1, action: "buy" });
      expect(provider.getMany).toHaveBeenCalledWith(["r1"]);
      const o = await db.outcomes.insert({ eventId: "r2", horizon: "2d", result: 2 });
      expect(o.timestamp).toBe(T0 + 3 * DAY); // anchored on the stub's timestamp
      await expect(db.decisions.insert({ eventId: "nope", timestamp: T0, action: 1 })).rejects.toThrow(/foreign key/);

      store.delete("r1");
      expect(await db.gc()).toEqual({ removedEvents: 1, removedDecisions: 1, removedOutcomes: 0 });
      expect(await db.decisions.get(d.id)).toBeUndefined();
      expect(await db.outcomes.get(o.id)).toBeDefined();
    });
  });

  describe("bulkLoad", () => {
    it("drops the secondary indexes for the duration and rebuilds them, even when the callback throws", async () => {
      open();
      await db.ready();
      await truncate(db);
      const indexes = async () =>
        (
          await raw(db).query({
            text: `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[]) ORDER BY indexname`,
            values: [SCHEMA, Object.keys(POSTGRES_SECONDARY_INDEXES)],
          })
        ).rows.map((r) => r.indexname);
      const all = Object.keys(POSTGRES_SECONDARY_INDEXES).sort();
      expect(await indexes()).toEqual(all);
      let during: unknown[] = [];
      const n = await db.bulkLoad(async () => {
        during = await indexes();
        await db.timeline.insertMany([{ timestamp: T0, entity: "A", namespace: "m", data: 1 }]);
        return 7;
      });
      expect(n).toBe(7);
      expect(during).toEqual([]);
      expect(await indexes()).toEqual(all);
      await expect(db.bulkLoad(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect(await indexes()).toEqual(all);
      await expect(db.transaction(() => db.bulkLoad(async () => 1))).rejects.toThrow(/inside a transaction/);
    });
  });
});

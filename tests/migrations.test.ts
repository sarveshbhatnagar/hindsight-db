import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, SCHEMA_VERSION, SchemaVersionError } from "../src/index.js";
import { currentVersion, migrate, MIGRATIONS } from "../src/storage/migrations.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hindsight-migrations-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2024, 0, 1);

describe("schema versioning on open", () => {
  it("stamps a fresh database with the current schema version", () => {
    const db = openDatabase();
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
    db.close();
  });

  it("reopening a file is a no-op and keeps data", async () => {
    const path = join(dir, "a.db");
    let db = openDatabase({ path });
    await db.events.insert({ id: "e", timestamp: T0, type: "x", entities: ["A"] });
    db.close();
    db = openDatabase({ path });
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await db.events.get("e"))?.entities).toEqual(["A"]);
    db.close();
  });

  it("adopts a pre-versioning file (tables present, user_version 0) without touching its data", async () => {
    const path = join(dir, "legacy.db");
    const raw = new Database(path);
    raw.exec(MIGRATIONS[0]!); // the schema as it shipped before versioning existed
    raw.prepare(
      `INSERT INTO events (id, timestamp, observed_at, type, content, metadata) VALUES ('legacy', ?, ?, 'x', 'null', '{}')`,
    ).run(T0, T0);
    expect(currentVersion(raw)).toBe(0);
    raw.close();

    const db = openDatabase({ path });
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await db.events.get("legacy"))?.type).toBe("x");
    db.close();
  });

  it("upgrades a v1 file to v2 in place, adding the (entity, timestamp) index", async () => {
    const path = join(dir, "v1.db");
    const raw = new Database(path);
    migrate(raw, MIGRATIONS.slice(0, 1));
    raw.prepare(`INSERT INTO timeline (timestamp, observed_at, entity, namespace, data) VALUES (?, ?, 'A', 'm', '1')`).run(T0, T0);
    expect(currentVersion(raw)).toBe(1);
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'timeline_entity_ts'`).get()).toBeUndefined();
    raw.close();

    const db = openDatabase({ path });
    expect(db.schemaVersion).toBeGreaterThanOrEqual(2);
    const conn = (db as unknown as { conn: { db: Database.Database } }).conn.db;
    expect(conn.prepare(`SELECT name FROM sqlite_master WHERE name = 'timeline_entity_ts'`).get()).toEqual({ name: "timeline_entity_ts" });
    const plan = conn
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM timeline WHERE entity IN (?) AND timestamp >= ? AND timestamp <= ?`)
      .all("A", T0, T0) as { detail: string }[];
    expect(plan[0]!.detail).toContain("timeline_entity_ts");
    expect((await db.timeline.range({ entity: "A", from: T0, to: T0 })).items).toHaveLength(1);
    db.close();
  });

  it("upgrades a v2 file to v3: decisions/outcomes keep their rows and now reference event_refs", async () => {
    const path = join(dir, "v2.db");
    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    migrate(raw, MIGRATIONS.slice(0, 2));
    expect(currentVersion(raw)).toBe(2);
    raw.prepare(`INSERT INTO events (id, timestamp, observed_at, type, content, metadata) VALUES ('e1', ?, ?, 'x', 'null', '{}')`).run(T0, T0 + 5);
    raw.prepare(`INSERT INTO events (id, timestamp, observed_at, type, content, metadata) VALUES ('e2', ?, ?, 'x', 'null', '{}')`).run(T0 + 1, T0 + 1);
    raw.prepare(`INSERT INTO decisions (id, event_id, timestamp, action, metadata) VALUES ('d1', 'e1', ?, '"buy"', '{"m":1}')`).run(T0 + 10);
    raw.prepare(`INSERT INTO decisions (id, event_id, timestamp, action, metadata) VALUES ('d2', 'e2', ?, '"sell"', '{}')`).run(T0 + 20);
    raw.prepare(
      `INSERT INTO outcomes (id, event_id, decision_id, timestamp, horizon, horizon_ms, result, metadata)
       VALUES ('o1', 'e1', 'd1', ?, '1d', 86400000, '{"pnl":2}', '{}'), ('o2', 'e2', NULL, ?, '0ms', 0, '1', '{}')`,
    ).run(T0 + 10 + 86_400_000, T0 + 1);
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'event_refs'`).get()).toBeUndefined();
    raw.close();

    const db = openDatabase({ path });
    expect(db.schemaVersion).toBe(SCHEMA_VERSION);
    const conn = (db as unknown as { conn: { db: Database.Database } }).conn.db;
    expect(conn.pragma("foreign_keys", { simple: true })).toBe(1); // restored after the rebuild

    // Rows survived the rebuild, through the public API and with their metadata intact.
    expect(await db.decisions.get("d1")).toEqual({ id: "d1", eventId: "e1", timestamp: T0 + 10, action: "buy", metadata: { m: 1 } });
    expect((await db.decisions.forEvent("e2")).map((d) => d.id)).toEqual(["d2"]);
    expect((await db.outcomes.get("o1"))?.decisionId).toBe("d1");
    expect((await db.outcomes.get("o2"))?.decisionId).toBeNull();

    // The stub table was backfilled from events and is what the FKs now point at.
    expect(conn.prepare(`SELECT id, timestamp, observed_at FROM event_refs ORDER BY id`).all()).toEqual([
      { id: "e1", timestamp: T0, observed_at: T0 + 5 },
      { id: "e2", timestamp: T0 + 1, observed_at: T0 + 1 },
    ]);
    const fks = (table: string) => (conn.pragma(`foreign_key_list(${table})`) as { table: string; from: string; on_delete: string }[]).map((f) => [f.from, f.table, f.on_delete]);
    expect(fks("decisions")).toEqual([["event_id", "event_refs", "CASCADE"]]);
    expect(fks("outcomes")).toEqual(expect.arrayContaining([["event_id", "event_refs", "CASCADE"], ["decision_id", "decisions", "SET NULL"]]));
    expect(conn.pragma("foreign_key_check")).toEqual([]);
    for (const name of ["decisions_event", "outcomes_event", "outcomes_decision", "entity_aliases_entity"]) {
      expect(conn.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)).toEqual({ name });
    }

    // Cascades still flow: deleting the event removes its stub, decisions and outcomes.
    await db.events.delete("e1");
    expect(conn.prepare(`SELECT count(*) AS n FROM event_refs`).get()).toEqual({ n: 1 });
    expect(await db.decisions.get("d1")).toBeUndefined();
    expect(await db.outcomes.get("o1")).toBeUndefined();
    expect(await db.outcomes.get("o2")).toBeDefined();
    db.close();
  });

  it("refuses a file written by a newer library version", () => {
    const path = join(dir, "future.db");
    const raw = new Database(path);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => openDatabase({ path })).toThrow(SchemaVersionError);
    try {
      openDatabase({ path });
    } catch (e) {
      expect((e as SchemaVersionError).fileVersion).toBe(SCHEMA_VERSION + 5);
      expect((e as SchemaVersionError).supported).toBe(SCHEMA_VERSION);
    }
  });
});

describe("migrate()", () => {
  const custom = [
    `CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);`,
    `ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'b';`,
    `CREATE INDEX t_b ON t (b);`,
  ];

  it("applies only the migrations the file has not seen, in order", () => {
    const db = new Database(":memory:");
    expect(migrate(db, custom.slice(0, 1))).toEqual([1]);
    db.prepare(`INSERT INTO t (a) VALUES ('x')`).run();
    expect(migrate(db, custom)).toEqual([2, 3]);
    expect(currentVersion(db)).toBe(3);
    expect(db.prepare(`SELECT a, b FROM t`).get()).toEqual({ a: "x", b: "b" });
    expect(migrate(db, custom)).toEqual([]); // idempotent
    db.close();
  });

  it("a failing migration rolls back and leaves the version unchanged", () => {
    const db = new Database(":memory:");
    migrate(db, custom.slice(0, 1));
    const broken = [...custom.slice(0, 1), `ALTER TABLE t ADD COLUMN c TEXT; ALTER TABLE nope ADD COLUMN d TEXT;`];
    expect(() => migrate(db, broken)).toThrow(/no such table: nope/);
    expect(currentVersion(db)).toBe(1);
    // The first statement of the failed migration was rolled back too.
    expect(db.prepare(`PRAGMA table_info(t)`).all().map((c: any) => c.name)).toEqual(["id", "a"]);
    db.close();
  });

  it("runs table rebuilds with foreign keys off and restores the setting afterwards", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const rebuild = [
      `CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p(id) ON DELETE CASCADE);
       INSERT INTO p VALUES ('a'); INSERT INTO c VALUES ('c1', 'a');`,
      // With foreign_keys ON, DROP TABLE p would cascade-delete c's rows before the copy.
      `CREATE TABLE p2 (id TEXT PRIMARY KEY); INSERT INTO p2 SELECT id FROM p; DROP TABLE p; ALTER TABLE p2 RENAME TO p;`,
    ];
    expect(migrate(db, rebuild)).toEqual([1, 2]);
    expect(db.prepare(`SELECT count(*) AS n FROM c`).get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("rolls back a migration that leaves dangling foreign keys", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const broken = [
      `CREATE TABLE p (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT REFERENCES p(id));`,
      `INSERT INTO c VALUES ('c1', 'missing');`,
    ];
    expect(() => migrate(db, broken)).toThrow(/foreign key violation/);
    expect(currentVersion(db)).toBe(1);
    expect(db.prepare(`SELECT count(*) AS n FROM c`).get()).toEqual({ n: 0 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("rejects a version ahead of the list", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 9");
    expect(() => migrate(db, custom)).toThrow(SchemaVersionError);
    db.close();
  });
});

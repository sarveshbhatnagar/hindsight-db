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

  it("rejects a version ahead of the list", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 9");
    expect(() => migrate(db, custom)).toThrow(SchemaVersionError);
    db.close();
  });
});

import type Database from "better-sqlite3";

/**
 * Ordered, append-only list of schema migrations. Entry N brings a database
 * from schema version N to N+1. The version is stored in SQLite's
 * `PRAGMA user_version` header field.
 *
 * Rules:
 *  - Never edit or reorder an entry once it has shipped; append a new one.
 *  - Each entry runs inside its own transaction and the version is bumped in
 *    the same transaction, so a failed migration leaves the file untouched.
 *  - Entry 0 uses IF NOT EXISTS so files created before versioning (which
 *    already have these tables at user_version 0) adopt version 1 cleanly.
 */
export const MIGRATIONS: readonly string[] = [
  // v1: initial schema
  `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  timestamp   INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  type        TEXT NOT NULL,
  content     TEXT NOT NULL,       -- JSON
  embedding   BLOB,                -- Float32 LE
  dim         INTEGER,
  norm        REAL,
  metadata    TEXT NOT NULL        -- JSON object
);
CREATE INDEX IF NOT EXISTS events_timestamp   ON events (timestamp);
CREATE INDEX IF NOT EXISTS events_observed_at ON events (observed_at);
CREATE INDEX IF NOT EXISTS events_type_ts     ON events (type, timestamp);
CREATE INDEX IF NOT EXISTS events_dim         ON events (dim) WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_entities (
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  position  INTEGER NOT NULL DEFAULT 0,  -- insertion order
  PRIMARY KEY (event_id, entity_id)
);
CREATE INDEX IF NOT EXISTS event_entities_entity  ON event_entities (entity_id, event_id);
CREATE INDEX IF NOT EXISTS event_entities_ordered ON event_entities (event_id, position, entity_id);

CREATE TABLE IF NOT EXISTS timeline (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  entity      TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  data        TEXT NOT NULL        -- JSON
);
CREATE INDEX IF NOT EXISTS timeline_entity_ns_ts ON timeline (entity, namespace, timestamp);
CREATE INDEX IF NOT EXISTS timeline_ns_ts        ON timeline (namespace, timestamp);
CREATE INDEX IF NOT EXISTS timeline_ts           ON timeline (timestamp);

CREATE TABLE IF NOT EXISTS decisions (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  action    TEXT NOT NULL,         -- JSON
  metadata  TEXT NOT NULL          -- JSON object
);
CREATE INDEX IF NOT EXISTS decisions_event ON decisions (event_id, timestamp);

CREATE TABLE IF NOT EXISTS outcomes (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  timestamp   INTEGER NOT NULL,    -- outcome (observation) time
  horizon     TEXT NOT NULL,
  horizon_ms  INTEGER NOT NULL,
  result      TEXT NOT NULL,       -- JSON
  metadata    TEXT NOT NULL        -- JSON object
);
CREATE INDEX IF NOT EXISTS outcomes_event    ON outcomes (event_id, timestamp);
CREATE INDEX IF NOT EXISTS outcomes_decision ON outcomes (decision_id)`,
  // v2: history windows query (entity, time range) without a namespace; the
  // (entity, namespace, timestamp) index can only use its entity prefix for
  // that shape, so add an index whose order matches the query.
  `CREATE INDEX IF NOT EXISTS timeline_entity_ts ON timeline (entity, timestamp);`,
  // v3: events may live outside this file (an external EventProvider), so
  // decisions/outcomes can no longer reference `events` directly. They now
  // reference `event_refs`, a local stub of (id, timestamp, observed_at) that
  // the SQLite event store keeps in sync through triggers and that an
  // external provider fills on demand. `entity_aliases` maps external entity
  // ids to the labels timeline data is keyed by.
  //
  // Rebuilding a table with a new FK target is the SQLite create/copy/drop/
  // rename dance; `migrate()` runs it with foreign_keys OFF (otherwise the
  // DROP would cascade) and checks integrity before committing.
  `
CREATE TABLE event_refs (
  id          TEXT PRIMARY KEY,
  timestamp   INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
INSERT INTO event_refs (id, timestamp, observed_at) SELECT id, timestamp, observed_at FROM events;

CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO event_refs (id, timestamp, observed_at) VALUES (NEW.id, NEW.timestamp, NEW.observed_at)
  ON CONFLICT (id) DO UPDATE SET timestamp = excluded.timestamp, observed_at = excluded.observed_at;
END;
CREATE TRIGGER events_au AFTER UPDATE OF id, timestamp, observed_at ON events BEGIN
  UPDATE event_refs SET id = NEW.id, timestamp = NEW.timestamp, observed_at = NEW.observed_at WHERE id = OLD.id;
END;
CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  DELETE FROM event_refs WHERE id = OLD.id;
END;

CREATE TABLE decisions_v3 (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES event_refs(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  action    TEXT NOT NULL,         -- JSON
  metadata  TEXT NOT NULL          -- JSON object
);
INSERT INTO decisions_v3 (id, event_id, timestamp, action, metadata)
  SELECT id, event_id, timestamp, action, metadata FROM decisions;
DROP TABLE decisions;
ALTER TABLE decisions_v3 RENAME TO decisions;
CREATE INDEX decisions_event ON decisions (event_id, timestamp);

CREATE TABLE outcomes_v3 (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES event_refs(id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  timestamp   INTEGER NOT NULL,    -- outcome (observation) time
  horizon     TEXT NOT NULL,
  horizon_ms  INTEGER NOT NULL,
  result      TEXT NOT NULL,       -- JSON
  metadata    TEXT NOT NULL        -- JSON object
);
INSERT INTO outcomes_v3 (id, event_id, decision_id, timestamp, horizon, horizon_ms, result, metadata)
  SELECT id, event_id, decision_id, timestamp, horizon, horizon_ms, result, metadata FROM outcomes;
DROP TABLE outcomes;
ALTER TABLE outcomes_v3 RENAME TO outcomes;
CREATE INDEX outcomes_event    ON outcomes (event_id, timestamp);
CREATE INDEX outcomes_decision ON outcomes (decision_id);

CREATE TABLE entity_aliases (
  external_id TEXT NOT NULL,       -- e.g. an insights entity id "42"
  entity      TEXT NOT NULL,       -- timeline label, e.g. "AAPL"
  PRIMARY KEY (external_id, entity)
);
CREATE INDEX entity_aliases_entity ON entity_aliases (entity, external_id)`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Secondary indexes that `bulkLoad` drops for the duration of a load and
 * rebuilds afterwards. Kept in sync with the migrations above; `ensureIndexes`
 * recreates any that are missing on open, so an interrupted bulk load never
 * leaves a file without them.
 */
export const SECONDARY_INDEXES: Readonly<Record<string, string>> = {
  events_timestamp: "events (timestamp)",
  events_observed_at: "events (observed_at)",
  events_type_ts: "events (type, timestamp)",
  events_dim: "events (dim) WHERE embedding IS NOT NULL",
  event_entities_entity: "event_entities (entity_id, event_id)",
  event_entities_ordered: "event_entities (event_id, position, entity_id)",
  timeline_entity_ns_ts: "timeline (entity, namespace, timestamp)",
  timeline_ns_ts: "timeline (namespace, timestamp)",
  timeline_ts: "timeline (timestamp)",
  timeline_entity_ts: "timeline (entity, timestamp)",
  decisions_event: "decisions (event_id, timestamp)",
  outcomes_event: "outcomes (event_id, timestamp)",
  outcomes_decision: "outcomes (decision_id)",
  entity_aliases_entity: "entity_aliases (entity, external_id)",
};

export function ensureIndexes(db: Database.Database): void {
  for (const [name, def] of Object.entries(SECONDARY_INDEXES)) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${def}`);
  }
}

export function dropIndexes(db: Database.Database): void {
  for (const name of Object.keys(SECONDARY_INDEXES)) db.exec(`DROP INDEX IF EXISTS ${name}`);
}

export class SchemaVersionError extends Error {
  constructor(
    readonly fileVersion: number,
    readonly supported: number,
  ) {
    super(
      `Database schema version ${fileVersion} is newer than this library supports (${supported}); ` +
        `upgrade the library or open the file with the version that created it`,
    );
    this.name = "SchemaVersionError";
  }
}

export function currentVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Apply every migration the file has not seen yet. Returns the versions applied.
 * `migrations` defaults to MIGRATIONS; tests pass their own lists.
 */
export function migrate(db: Database.Database, migrations: readonly string[] = MIGRATIONS): number[] {
  const from = currentVersion(db);
  if (from > migrations.length) throw new SchemaVersionError(from, migrations.length);
  const applied: number[] = [];
  if (from === migrations.length) return applied;
  // Table rebuilds (create/copy/drop/rename) must run with foreign keys off,
  // or the DROP cascades into referencing rows. The pragma is a no-op inside
  // a transaction, so toggle it around each one and verify integrity before
  // committing; the rollback on failure covers the rebuild as well.
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  if (foreignKeys) db.pragma("foreign_keys = OFF");
  try {
    for (let v = from; v < migrations.length; v++) {
      db.transaction(() => {
        db.exec(migrations[v]!);
        if (foreignKeys) {
          const violations = db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) {
            throw new Error(`Migration to schema version ${v + 1} left ${violations.length} foreign key violation(s)`);
          }
        }
        db.pragma(`user_version = ${v + 1}`);
      })();
      applied.push(v + 1);
    }
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
  return applied;
}

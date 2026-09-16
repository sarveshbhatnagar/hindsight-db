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
  for (let v = from; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
    applied.push(v + 1);
  }
  return applied;
}

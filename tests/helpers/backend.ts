import { expect } from "vitest";
import { openDatabase, type HindsightDB, type SqliteEventStore } from "../../src/index.js";

/**
 * Which storage backend the current vitest project runs the shared tests
 * against (see vitest.config.ts). "postgres" needs DATABASE_URL; the pgvector
 * container from insights-db's README on :5433 works:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5433/insights_db npm test
 */
export type Backend = "sqlite" | "postgres";
export const BACKEND: Backend = process.env.HINDSIGHT_TEST_BACKEND === "postgres" ? "postgres" : "sqlite";
export const DATABASE_URL = process.env.DATABASE_URL;

const CONTEXT_TABLES = ["timeline", "event_refs", "decisions", "outcomes", "entity_aliases"];

/** One Postgres schema per test file, so files running in parallel never share tables. */
export function schemaFor(testPath: string | undefined): string {
  const base = (testPath ?? "adhoc").split("/").pop()!.replace(/\.test\.ts$/, "");
  return `hindsight_test_${base.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

/**
 * A fresh database for one test. On SQLite: in memory, events included. On
 * Postgres: the context in the file's own schema (emptied first), events in a
 * separate in-memory SQLite store — the mixed configuration the Postgres
 * backend is for. `close()` closes both.
 */
export async function openTestDatabase(backend: Backend = BACKEND): Promise<HindsightDB<SqliteEventStore>> {
  if (backend === "sqlite") return openDatabase();
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required for the postgres backend");
  const events = openDatabase();
  const db = openDatabase({
    storage: "postgres",
    connectionString: DATABASE_URL,
    schema: schemaFor(expect.getState().testPath),
    events: events.events,
  });
  await db.ready();
  await truncate(db);
  const close = db.close.bind(db);
  db.close = async () => {
    await close();
    await events.close();
  };
  return db;
}

/** Empty the context tables and restart the timeline id sequence. */
export async function truncate(db: HindsightDB<never> | HindsightDB<SqliteEventStore>): Promise<void> {
  const pool = (db as unknown as { conn: { pool: { query(q: { text: string }): Promise<unknown> } } }).conn.pool;
  await pool.query({ text: `TRUNCATE ${CONTEXT_TABLES.join(", ")} RESTART IDENTITY CASCADE` });
}

/** Backend-specific error texts for the same failure. */
export const ERRORS = {
  foreignKey: BACKEND === "postgres" ? /foreign key/ : /FOREIGN KEY/,
  unique: BACKEND === "postgres" ? /duplicate key/ : /UNIQUE/,
};

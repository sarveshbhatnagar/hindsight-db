import type { EventProvider } from "./events/provider.js";
import { SqliteEventStore } from "./events/sqlite.js";
import { EventRefStore } from "./storage/event-refs.js";
import { PostgresStorage } from "./storage/postgres.js";
import { SqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/storage.js";
import { AliasStore } from "./stores/aliases.js";
import { DecisionStore } from "./stores/decisions.js";
import { HistoryStore } from "./stores/history.js";
import { OutcomeStore } from "./stores/outcomes.js";
import { TimelineStore } from "./stores/timeline.js";
import type { DatabaseOptions, GcResult, PostgresDatabaseOptions, SqliteDatabaseOptions } from "./types.js";

export * from "./types.js";
export { addDuration, parseDuration, toMillis, windowAround } from "./time.js";
export { uuidv7 } from "./ids.js";
export { cosine } from "./vector.js";
export { SCHEMA_VERSION, SchemaVersionError } from "./storage/migrations.js";
export { POSTGRES_SCHEMA_VERSION } from "./storage/postgres.js";
export type { PgPool, PgPoolClient, PgQueryConfig, PgQueryResult, PgQueryable, PgTypesConfig } from "./storage/postgres.js";
export type { EventRefResolver } from "./storage/event-refs.js";
export { InsightsEventProvider } from "./events/insights.js";
export type {
  InsightsClaim,
  InsightsContentClaim,
  InsightsEventEntity,
  InsightsEventFilters,
  InsightsEventProviderOptions,
  InsightsEventRecord,
  InsightsEventsApi,
  InsightsHandle,
  InsightsOpenOptions,
  InsightsVector,
} from "./events/insights.js";
export type { GetManyOptions } from "./events/provider.js";
export type { EventProvider, SqliteEventStore, TimelineStore, DecisionStore, OutcomeStore, HistoryStore, AliasStore };
/** The default (SQLite-backed) event store. Alias kept for callers that imported it under this name. */
export type EventStore = SqliteEventStore;

/**
 * The hindsight-db database handle.
 *
 * ```ts
 * const db = openDatabase({ path: "history.db" });
 * const candidates = await db.events.similar({ event: currentEvent, limit: 20 });
 * const history = await db.history.getMany({ eventIds: candidates.map(c => c.id), before: "14d", after: "5d" });
 * ```
 *
 * `E` is the type of `db.events`: the writable `SqliteEventStore` by default,
 * or whatever `EventProvider` was passed via `options.events`.
 */
export class HindsightDB<E extends EventProvider = SqliteEventStore> {
  readonly events: E;
  readonly timeline: TimelineStore;
  readonly decisions: DecisionStore;
  readonly outcomes: OutcomeStore;
  readonly history: HistoryStore;
  /** External entity id → timeline label mappings, applied when an event's entities select its timeline. */
  readonly aliases: AliasStore;
  /** Which backend holds the context. */
  readonly storage: "sqlite" | "postgres";
  private readonly conn: Storage;
  private readonly refs: EventRefStore;

  constructor(options: DatabaseOptions<E> = {}) {
    const external = options.events;
    if (options.storage === "postgres") {
      if (!external) {
        throw new TypeError("The Postgres backend stores only the context; pass an external event source via `events`");
      }
      this.conn = new PostgresStorage(options);
    } else {
      this.conn = new SqliteStorage(options);
    }
    this.storage = this.conn.dialect.name;
    // Without an external provider, events live in the same file as the context.
    this.events = (external ?? new SqliteEventStore(this.conn as SqliteStorage)) as E;
    // Decisions and outcomes reference event stubs rather than the events
    // table. The SQLite store fills the stubs through triggers; an external
    // provider is asked for the events it owns the first time they are referenced.
    this.refs = new EventRefStore(this.conn, external ? (ids) => external.getMany(ids) : undefined);
    this.aliases = new AliasStore(this.conn);
    this.timeline = new TimelineStore(this.conn, this.events, this.aliases);
    this.decisions = new DecisionStore(this.conn, this.refs);
    this.outcomes = new OutcomeStore(this.conn, this.refs);
    this.history = new HistoryStore(this.conn, this.events, this.timeline, this.decisions, this.outcomes, this.aliases);
  }

  /**
   * Resolves once the schema is in place. SQLite migrates synchronously on
   * open, so this is immediate; Postgres connects and migrates on first use,
   * and every operation waits for it — await this to surface connection or
   * migration errors up front.
   */
  ready(): Promise<void> {
    return this.conn.ready();
  }

  /**
   * Schema version of the open database (equals `SCHEMA_VERSION` for SQLite,
   * `POSTGRES_SCHEMA_VERSION` for Postgres once `ready()` has resolved).
   */
  get schemaVersion(): number {
    return this.conn.schemaVersion;
  }

  /**
   * Backfill mode: drops secondary indexes for the duration of `fn` and
   * rebuilds them afterwards, which makes large loads several times faster.
   * Use for initial imports, not routine writes.
   *
   * ```ts
   * await db.bulkLoad(async () => {
   *   for await (const batch of readBatches()) await db.timeline.insertMany(batch);
   * });
   * ```
   */
  bulkLoad<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.conn.bulkLoad(fn);
  }

  /**
   * With an external event source, drop the decisions and outcomes of events
   * the provider no longer has (it may delete or merge them; nothing cascades
   * across databases). Asks the provider for every referenced id, in chunks.
   * A no-op with the SQLite event store, whose stubs follow its events.
   */
  gc(): Promise<GcResult> {
    return this.refs.gc();
  }

  /**
   * Run several writes atomically. Store calls made inside `fn` join the
   * transaction; nested calls join the enclosing one.
   *
   * With an async `fn`, await each store call — the transaction commits when
   * the returned promise resolves and rolls back when it rejects. Works the
   * same on both backends.
   *
   * With a synchronous `fn` on SQLite, store methods have executed their SQL
   * by the time they return their promise, so several can be issued inside
   * `fn` without awaiting and the transaction commits before this returns
   * (unless another context's async transaction is in flight, in which case
   * `fn` runs, and a promise is returned, once that has ended). On Postgres a
   * transaction is always asynchronous and a promise is always returned.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  transaction<T>(fn: () => T): T | Promise<Awaited<T>>;
  transaction<T>(fn: () => T): T | Promise<Awaited<T>> {
    return this.conn.transaction(fn);
  }

  /** Close the connection (or, on Postgres, the pool this database created). */
  close(): Promise<void> {
    return this.conn.close();
  }
}

/** Open a database whose events live in the SQLite file alongside the context. */
export function openDatabase(options?: SqliteDatabaseOptions & { events?: undefined }): HindsightDB<SqliteEventStore>;
/**
 * Open a database whose events come from an external `EventProvider`; only
 * timeline, decisions, outcomes and aliases are stored — in the SQLite file,
 * or in Postgres with `storage: "postgres"`. `db.events` is the provider
 * itself, so it exposes exactly the methods the provider has.
 */
export function openDatabase<E extends EventProvider>(
  options: (SqliteDatabaseOptions | PostgresDatabaseOptions) & { events: E },
): HindsightDB<E>;
export function openDatabase<E extends EventProvider>(options: DatabaseOptions<E> = {}): HindsightDB<E> {
  return new HindsightDB<E>(options);
}

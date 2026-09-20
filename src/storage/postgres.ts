import { AsyncLocalStorage } from "node:async_hooks";
import { uuidv7 } from "../ids.js";
import { SchemaVersionError } from "./migrations.js";
import type { Dialect, Effect, Op, SqlParam, Storage } from "./storage.js";

// ---------------------------------------------------------------------------
// The slice of `pg` this backend uses, declared structurally so hindsight-db
// typechecks and loads without the optional peer dependency installed. A real
// `pg.Pool` satisfies `PgPool` as is.
// ---------------------------------------------------------------------------

export interface PgTypesConfig {
  getTypeParser(oid: number, format?: "text" | "binary"): (value: never) => unknown;
}
export interface PgQueryConfig {
  text: string;
  values?: unknown[];
  types?: PgTypesConfig;
}
export interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
export interface PgQueryable {
  query(config: PgQueryConfig): Promise<PgQueryResult>;
}
export interface PgPoolClient extends PgQueryable {
  release(err?: Error | boolean): void;
}
export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

export interface PostgresOptions {
  /** Connection string for a pool this backend creates and owns (closed by `db.close()`). */
  connectionString?: string;
  /** An existing `pg.Pool` to share (e.g. insights-db's `pool`). Not closed by `db.close()`. */
  pool?: PgPool;
  /**
   * Schema for the hindsight tables, created if missing and put first on the
   * connections' `search_path`. Only with `connectionString`: a shared pool's
   * search path belongs to whoever created it. Default: the connection's own.
   */
  schema?: string;
  idGenerator?: () => string;
}

const POSTGRES: Dialect = {
  name: "postgres",
  groupConcat: (expr, separator) => `string_agg(${expr}, chr(${separator}))`,
};

/**
 * Ordered, append-only list of schema migrations for the Postgres backend,
 * versioned in the `hindsight_schema` table (the counterpart of SQLite's
 * `PRAGMA user_version`). Entry N brings the schema from version N to N+1.
 * Only the context tables live here: events come from an `EventProvider`.
 * Same rules as `MIGRATIONS`: never edit a shipped entry, append a new one.
 */
export const POSTGRES_MIGRATIONS: readonly string[] = [
  // v1: the context tables as of SQLite schema v3.
  `
CREATE TABLE IF NOT EXISTS event_refs (
  id          text PRIMARY KEY,
  timestamp   bigint NOT NULL,
  observed_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline (
  id          bigserial PRIMARY KEY,
  timestamp   bigint NOT NULL,
  observed_at bigint NOT NULL,
  entity      text NOT NULL,
  namespace   text NOT NULL,
  data        text NOT NULL        -- JSON
);
-- Every timeline index ends in (timestamp, id): reads order and page by that
-- pair, and unlike SQLite's rowid the id is not implicitly part of the key.
CREATE INDEX IF NOT EXISTS timeline_entity_ns_ts ON timeline (entity, namespace, timestamp, id);
CREATE INDEX IF NOT EXISTS timeline_ns_ts        ON timeline (namespace, timestamp, id);
CREATE INDEX IF NOT EXISTS timeline_ts           ON timeline (timestamp, id);
CREATE INDEX IF NOT EXISTS timeline_entity_ts    ON timeline (entity, timestamp, id);

CREATE TABLE IF NOT EXISTS decisions (
  id        text PRIMARY KEY,
  event_id  text NOT NULL REFERENCES event_refs(id) ON DELETE CASCADE,
  timestamp bigint NOT NULL,
  action    text NOT NULL,         -- JSON
  metadata  text NOT NULL          -- JSON object
);
CREATE INDEX IF NOT EXISTS decisions_event ON decisions (event_id, timestamp);

CREATE TABLE IF NOT EXISTS outcomes (
  id          text PRIMARY KEY,
  event_id    text NOT NULL REFERENCES event_refs(id) ON DELETE CASCADE,
  decision_id text REFERENCES decisions(id) ON DELETE SET NULL,
  timestamp   bigint NOT NULL,     -- outcome (observation) time
  horizon     text NOT NULL,
  horizon_ms  bigint NOT NULL,
  result      text NOT NULL,       -- JSON
  metadata    text NOT NULL        -- JSON object
);
CREATE INDEX IF NOT EXISTS outcomes_event    ON outcomes (event_id, timestamp);
CREATE INDEX IF NOT EXISTS outcomes_decision ON outcomes (decision_id);

CREATE TABLE IF NOT EXISTS entity_aliases (
  external_id text NOT NULL,       -- e.g. an insights entity id "42"
  entity      text NOT NULL,       -- timeline label, e.g. "AAPL"
  PRIMARY KEY (external_id, entity)
);
CREATE INDEX IF NOT EXISTS entity_aliases_entity ON entity_aliases (entity, external_id)`,
];

export const POSTGRES_SCHEMA_VERSION = POSTGRES_MIGRATIONS.length;

/** Secondary indexes `bulkLoad` drops and rebuilds; kept in sync with the migrations above. */
export const POSTGRES_SECONDARY_INDEXES: Readonly<Record<string, string>> = {
  timeline_entity_ns_ts: "timeline (entity, namespace, timestamp, id)",
  timeline_ns_ts: "timeline (namespace, timestamp, id)",
  timeline_ts: "timeline (timestamp, id)",
  timeline_entity_ts: "timeline (entity, timestamp, id)",
  decisions_event: "decisions (event_id, timestamp)",
  outcomes_event: "outcomes (event_id, timestamp)",
  outcomes_decision: "outcomes (decision_id)",
  entity_aliases_entity: "entity_aliases (entity, external_id)",
};

/** Advisory lock key serializing schema migration across processes. */
const MIGRATION_LOCK = 0x68696e64; // "hind"
const INT8_OID = 20;
const SQL_CACHE = 256;

/** An open transaction: the pinned client, savepoint depth, and the queue of work on it. */
interface TxContext {
  readonly client: PgPoolClient;
  readonly depth: number;
  /** Work issued on this client runs one piece at a time, in order. */
  chain: Promise<unknown>;
  /** Shared by every level of one transaction. */
  readonly root: { error: unknown };
}

/**
 * The Postgres backend for the context stores. Everything is asynchronous:
 * ops run one `await` per statement on the pool, or on the client pinned by
 * an enclosing `transaction(async fn)` (carried through AsyncLocalStorage).
 *
 * `pg` is an optional peer dependency, imported on first use only; the schema
 * is created/migrated lazily, and every operation waits for that to finish.
 */
export class PostgresStorage implements Storage {
  readonly dialect = POSTGRES;
  readonly newId: () => string;
  private pool!: PgPool;
  private types!: PgTypesConfig;
  private readonly ownsPool: boolean;
  private readonly init: Promise<void>;
  private version = -1;
  private readonly als = new AsyncLocalStorage<TxContext>();
  private readonly positional = new Map<string, string>();
  private bulkLoading = false;

  constructor(options: PostgresOptions) {
    if (!options.pool && !options.connectionString) {
      throw new TypeError("PostgresStorage needs a connectionString or a pool");
    }
    if (options.pool && options.connectionString) {
      throw new TypeError("PostgresStorage takes either a connectionString or a pool, not both");
    }
    if (options.schema !== undefined) {
      if (options.pool) throw new TypeError("schema can only be set together with connectionString");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.schema)) throw new TypeError(`Invalid schema name: "${options.schema}"`);
    }
    this.newId = options.idGenerator ?? uuidv7;
    this.ownsPool = options.pool === undefined;
    this.init = this.open(options);
    // Surfaces through ready() and every operation; never as an unhandled rejection.
    this.init.catch(() => {});
  }

  private async open(options: PostgresOptions): Promise<void> {
    const modName: string = "pg"; // not a literal, so neither tsc nor a bundler resolves it eagerly
    let pg: { Pool: new (config: { connectionString: string }) => PgPool; types: PgTypesConfig };
    try {
      pg = await import(modName);
    } catch (err) {
      throw new Error("The Postgres backend needs the optional peer dependency pg: npm install pg", { cause: err });
    }
    const defaults = pg.types;
    // Timestamps and counts are int8, which pg hands out as strings by default; they all fit in a double.
    this.types = {
      getTypeParser: (oid, format) =>
        oid === INT8_OID && format !== "binary" ? (value: never) => Number(value) : defaults.getTypeParser(oid, format),
    };
    if (options.pool) {
      this.pool = options.pool;
    } else {
      let connectionString = options.connectionString!;
      if (options.schema !== undefined) {
        // Startup parameter on every connection of the pool; the schema need not exist yet.
        const url = new URL(connectionString);
        url.searchParams.set("options", `-c search_path=${options.schema},public`);
        connectionString = url.toString();
      }
      this.pool = new pg.Pool({ connectionString });
    }
    await this.migrate(options.schema);
  }

  private async migrate(schema: string | undefined): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query({ text: "SELECT pg_advisory_lock($1)", values: [MIGRATION_LOCK] });
      try {
        if (schema !== undefined) await client.query({ text: `CREATE SCHEMA IF NOT EXISTS "${schema}"` });
        await client.query({ text: "CREATE TABLE IF NOT EXISTS hindsight_schema (version integer NOT NULL)" });
        const rows = (await client.query({ text: "SELECT version FROM hindsight_schema", types: this.types })).rows;
        let version = rows.length ? (rows[0]!.version as number) : -1;
        if (version < 0) {
          await client.query({ text: "INSERT INTO hindsight_schema (version) VALUES (0)" });
          version = 0;
        }
        if (version > POSTGRES_MIGRATIONS.length) throw new SchemaVersionError(version, POSTGRES_MIGRATIONS.length);
        for (let v = version; v < POSTGRES_MIGRATIONS.length; v++) {
          await client.query({ text: "BEGIN" });
          try {
            await client.query({ text: POSTGRES_MIGRATIONS[v]! });
            await client.query({ text: "UPDATE hindsight_schema SET version = $1", values: [v + 1] });
            await client.query({ text: "COMMIT" });
          } catch (err) {
            await client.query({ text: "ROLLBACK" }).catch(() => {});
            throw err;
          }
        }
        this.version = POSTGRES_MIGRATIONS.length;
        await this.ensureIndexes(client); // repairs a schema left without indexes by an interrupted bulkLoad
      } finally {
        await client.query({ text: "SELECT pg_advisory_unlock($1)", values: [MIGRATION_LOCK] }).catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  ready(): Promise<void> {
    return this.init;
  }

  get schemaVersion(): number {
    if (this.version < 0) throw new Error("Schema not ready yet: await db.ready() first");
    return this.version;
  }

  run<T>(op: Op<T>): Promise<T> {
    const ctx = this.als.getStore();
    return ctx ? this.enqueue(ctx, () => this.exec(op, ctx)) : this.init.then(() => this.exec(op, undefined));
  }

  /** Serialize `work` with everything else issued on the transaction's client. */
  private enqueue<T>(ctx: TxContext, work: () => Promise<T>): Promise<T> {
    const result = ctx.chain.then(work);
    ctx.chain = result.catch(() => {});
    return result;
  }

  private async exec<T>(op: Op<T>, ctx: TxContext | undefined): Promise<T> {
    let next = op.next();
    while (!next.done) {
      let result: unknown;
      try {
        result = await this.handle(next.value, ctx);
      } catch (err) {
        next = op.throw(err);
        continue;
      }
      next = op.next(result);
    }
    return next.value;
  }

  private async handle(effect: Effect, ctx: TxContext | undefined): Promise<unknown> {
    switch (effect.kind) {
      case "all":
        return (await this.query(ctx, effect.sql, effect.params)).rows;
      case "run":
        return { changes: (await this.query(ctx, effect.sql, effect.params)).rowCount ?? 0 };
      case "tx":
        return this.inTransaction(ctx, (inner) => this.exec(effect.op(), inner));
    }
  }

  private async query(ctx: TxContext | undefined, sql: string, params: readonly SqlParam[]): Promise<PgQueryResult> {
    const target = ctx?.client ?? this.pool;
    try {
      return await target.query({ text: this.toPositional(sql), values: [...params], types: this.types });
    } catch (err) {
      // A failed statement aborts the Postgres transaction; remember why so
      // commit reports it rather than silently rolling back.
      if (ctx && ctx.root.error === undefined) ctx.root.error = err;
      throw err;
    }
  }

  /** `?` placeholders → `$1, $2, …`. Our SQL never has a `?` inside a literal. */
  private toPositional(sql: string): string {
    let out = this.positional.get(sql);
    if (out !== undefined) return out;
    let n = 0;
    out = sql.replace(/\?/g, () => `$${++n}`);
    if (this.positional.size >= SQL_CACHE) this.positional.delete(this.positional.keys().next().value!);
    this.positional.set(sql, out);
    return out;
  }

  /**
   * Run `body` in a transaction: BEGIN/COMMIT on a client taken from the pool,
   * or a savepoint when `ctx` is an enclosing transaction. Work `body` queued
   * on the context but did not await is drained before the commit. As with
   * SQLite, a failure anywhere inside — even one the caller swallowed — rolls
   * the whole transaction back and rethrows.
   */
  private async inTransaction<T>(ctx: TxContext | undefined, body: (ctx: TxContext) => Promise<T>): Promise<T> {
    if (ctx) {
      const sp = `sp${ctx.depth}`;
      await this.query(ctx, `SAVEPOINT ${sp}`, []);
      const inner: TxContext = { client: ctx.client, depth: ctx.depth + 1, chain: Promise.resolve(), root: ctx.root };
      try {
        const result = await body(inner);
        await inner.chain;
        await ctx.client.query({ text: `RELEASE SAVEPOINT ${sp}` });
        return result;
      } catch (err) {
        if (ctx.root.error === undefined) ctx.root.error = err;
        await ctx.client.query({ text: `ROLLBACK TO SAVEPOINT ${sp}` }).catch(() => {});
        await ctx.client.query({ text: `RELEASE SAVEPOINT ${sp}` }).catch(() => {});
        throw err;
      }
    }
    const client = await this.pool.connect();
    const outer: TxContext = { client, depth: 0, chain: Promise.resolve(), root: { error: undefined } };
    try {
      await client.query({ text: "BEGIN" });
      const result = await body(outer);
      await outer.chain;
      if (outer.root.error !== undefined) throw outer.root.error;
      await client.query({ text: "COMMIT" });
      return result;
    } catch (err) {
      await client.query({ text: "ROLLBACK" }).catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Run `fn` inside a transaction on a dedicated client; store calls made
   * while it runs (in `fn`'s async context) join it. Nested calls become
   * savepoints. Always returns a promise: on Postgres nothing is synchronous.
   */
  transaction<T>(fn: () => T): Promise<Awaited<T>> {
    const ctx = this.als.getStore();
    const body = async (): Promise<Awaited<T>> => (await fn()) as Awaited<T>;
    const go = (): Promise<Awaited<T>> => this.inTransaction(ctx, (inner) => this.als.run(inner, body));
    return ctx ? this.enqueue(ctx, go) : this.init.then(go);
  }

  /**
   * Run `fn` with the secondary indexes dropped, then rebuild them. The same
   * trade as on SQLite — faster backfill, slow reads meanwhile — but on a
   * shared server the indexes are gone for every client for the duration.
   */
  async bulkLoad<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.bulkLoading) throw new Error("bulkLoad() cannot be nested");
    if (this.als.getStore()) throw new Error("bulkLoad() cannot run inside a transaction");
    await this.init;
    this.bulkLoading = true;
    for (const name of Object.keys(POSTGRES_SECONDARY_INDEXES)) await this.pool.query({ text: `DROP INDEX IF EXISTS ${name}` });
    try {
      return await fn();
    } finally {
      await this.ensureIndexes();
      this.bulkLoading = false;
    }
  }

  private async ensureIndexes(target: PgQueryable = this.pool): Promise<void> {
    for (const [name, def] of Object.entries(POSTGRES_SECONDARY_INDEXES)) {
      await target.query({ text: `CREATE INDEX IF NOT EXISTS ${name} ON ${def}` });
    }
  }

  private closed = false;

  /** End the pool if this backend created it; a shared pool is left to its owner. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.init.catch(() => {});
    if (this.ownsPool && this.pool) await this.pool.end();
  }
}

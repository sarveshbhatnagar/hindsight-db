/**
 * The storage layer the context stores (timeline, decisions, outcomes,
 * event_refs, entity_aliases) program against, so that the same store code
 * runs on SQLite and on Postgres.
 *
 * A store method describes its database work as an *op*: a generator that
 * yields SQL effects (`all`, `run`, `tx`) and receives their results back. The
 * backend interprets the op — `SqliteStorage` synchronously, in one go, which
 * is what keeps the documented "several store calls inside one synchronous
 * `db.transaction(() => …)`" contract working; `PostgresStorage` with an
 * `await` per effect. Only the interpreter knows whether a query blocks.
 *
 * SQL is written once, in the common dialect: `?` placeholders (rewritten to
 * `$n` for Postgres), `ON CONFLICT`, `RETURNING`, quoted camelCase aliases,
 * `1=1`/`1=0` rather than bare integers in WHERE. Where the dialects part ways
 * (`group_concat` vs `string_agg`) the store asks `Storage.dialect`.
 */

/** Bindable values. Arrays are Postgres-only (bound as `anyarray`); SQLite statements never take them. */
export type SqlParam = string | number | null | readonly (string | number | null)[];

export type Effect =
  | { readonly kind: "all"; readonly sql: string; readonly params: readonly SqlParam[] }
  | { readonly kind: "run"; readonly sql: string; readonly params: readonly SqlParam[] }
  | { readonly kind: "tx"; readonly op: () => Op<unknown> };

/** A unit of database work: yields effects, receives their results, returns `T`. */
export type Op<T> = Generator<Effect, T, unknown>;

/** Run a query and return its rows. */
export function* all<R>(sql: string, params: readonly SqlParam[] = []): Op<R[]> {
  return (yield { kind: "all", sql, params }) as R[];
}

/** Run a query expected to return at most one row. */
export function* one<R>(sql: string, params: readonly SqlParam[] = []): Op<R | undefined> {
  const rows = yield* all<R>(sql, params);
  return rows[0];
}

/** Run a statement; returns the number of rows it changed. */
export function* run(sql: string, params: readonly SqlParam[] = []): Op<{ changes: number }> {
  return (yield { kind: "run", sql, params }) as { changes: number };
}

/** Run `op` inside a transaction (nested calls join the enclosing one via savepoints). */
export function* tx<T>(op: () => Op<T>): Op<T> {
  return (yield { kind: "tx", op }) as T;
}

/** Where the two SQL dialects differ. */
export interface Dialect {
  readonly name: "sqlite" | "postgres";
  /** Concatenate `expr` across a group with the given ASCII separator code. */
  groupConcat(expr: string, separator: number): string;
}

export interface Storage {
  readonly dialect: Dialect;
  readonly newId: () => string;
  /**
   * Execute an op. SQLite returns the result synchronously (the op has run to
   * completion by the time this returns); Postgres returns a promise. Store
   * methods are `async`, which flattens both into the promise callers see.
   */
  run<T>(op: Op<T>): T | Promise<T>;
  /**
   * Run `fn` inside a transaction. `fn` may be synchronous or async; nested
   * calls join the enclosing transaction. See each backend for what
   * "synchronous" buys you.
   */
  transaction<T>(fn: () => T): T | Promise<Awaited<T>>;
  /** Run `fn` with all secondary indexes dropped, then rebuild them. */
  bulkLoad<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Resolves once the schema is in place (immediately for SQLite). */
  ready(): Promise<void>;
  /** Schema version of the open database, once `ready()` has resolved. */
  readonly schemaVersion: number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQL helpers shared by the stores
// ---------------------------------------------------------------------------

/**
 * Largest list we bind into a single statement. SQLite allows 32766 variables
 * and Postgres 65535; stay well under so a statement with several lists fits.
 */
export const MAX_LIST = 5000;

/** Split a list into MAX_LIST-sized chunks for batched lookups. */
export function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += MAX_LIST) out.push(values.slice(i, i + MAX_LIST));
  return out;
}

/** Build a `col IN (?, ?, ...)` fragment with its params. Lists must be at most MAX_LIST long. */
export function inList(col: string, values: readonly (string | number)[]): { sql: string; params: (string | number)[] } {
  if (values.length === 0) return { sql: "1=0", params: [] };
  if (values.length > MAX_LIST) {
    throw new RangeError(`Too many values for ${col} (${values.length} > ${MAX_LIST}); split the query`);
  }
  return { sql: `${col} IN (${values.map(() => "?").join(",")})`, params: [...values] };
}

/**
 * Multi-row `INSERT INTO table (cols) VALUES (...), (...)` statements, each
 * within the parameter limit. One round trip per chunk instead of per row.
 */
export function insertStatements(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly SqlParam[])[],
  suffix = "",
): { sql: string; params: SqlParam[] }[] {
  const perRow = columns.length;
  const rowsPerChunk = Math.max(1, Math.floor(MAX_LIST / perRow));
  const tuple = `(${columns.map(() => "?").join(",")})`;
  const out: { sql: string; params: SqlParam[] }[] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    out.push({
      sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk.map(() => tuple).join(",")}${suffix}`,
      params: chunk.flat() as SqlParam[],
    });
  }
  return out;
}

export function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

export function encodeCursor(obj: Record<string, number | string>): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export function decodeCursor<T extends Record<string, number | string>>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as T;
  } catch {
    throw new TypeError("Invalid cursor");
  }
}

/** Smallest string greater than every string with the given prefix (for range scans on an index). */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.codePointAt(prefix.length - 1)!;
  return prefix.slice(0, -1) + String.fromCodePoint(last + 1);
}

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

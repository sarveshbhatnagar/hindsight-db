import Database from "better-sqlite3";
import { uuidv7 } from "../ids.js";
import type { DatabaseOptions } from "../types.js";
import { dropIndexes, ensureIndexes, migrate } from "./migrations.js";


export class Connection {
  readonly db: Database.Database;
  readonly newId: () => string;
  private readonly jsonValid;
  private depth = 0;
  private nestedError: unknown;

  constructor(options: DatabaseOptions = {}) {
    this.db = new Database(options.path ?? ":memory:");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    migrate(this.db);
    ensureIndexes(this.db); // repairs a file left without indexes by an interrupted bulkLoad
    if (options.cacheSizeMb !== undefined) {
      if (!Number.isFinite(options.cacheSizeMb) || options.cacheSizeMb <= 0) throw new TypeError("cacheSizeMb must be > 0");
      this.db.pragma(`cache_size = -${Math.round(options.cacheSizeMb * 1024)}`);
    }
    this.newId = options.idGenerator ?? uuidv7;
    this.jsonValid = this.db.prepare("SELECT json_valid(?) AS ok");
  }

  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction.
   *
   * Store methods are async but execute their SQL synchronously before their
   * first await, so several of them can be issued inside one synchronous
   * callback. If any nested write fails, its error is recorded and re-thrown
   * from the outermost transaction after `fn` returns, so the whole batch
   * rolls back even though the failing call only surfaced a rejected promise.
   */
  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0;
    this.depth++;
    try {
      return this.db.transaction(() => {
        const result = fn();
        // better-sqlite3 rejects promise-returning callbacks; a store call's
        // rejection must not surface as an unhandled rejection on top of that.
        if (isThenable(result)) result.then(undefined, () => {});
        if (outer && this.nestedError !== undefined) throw this.nestedError;
        return result;
      })();
    } catch (err) {
      if (!outer && this.nestedError === undefined) this.nestedError = err;
      throw err;
    } finally {
      this.depth--;
      if (outer) this.nestedError = undefined;
    }
  }

  private bulkLoading = false;

  /**
   * Run `fn` with all secondary indexes dropped, then rebuild them. Large
   * backfills become sequential appends instead of random index inserts.
   * Reads issued inside `fn` still work but are slow (no indexes).
   */
  async bulkLoad<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.bulkLoading) throw new Error("bulkLoad() cannot be nested");
    if (this.depth > 0) throw new Error("bulkLoad() cannot run inside a transaction");
    this.bulkLoading = true;
    dropIndexes(this.db);
    try {
      return await fn();
    } finally {
      ensureIndexes(this.db);
      this.bulkLoading = false;
    }
  }

  /** True if SQLite can parse `json` (rejects e.g. >1000-deep nesting, which would break json_extract later). */
  isValidJson(json: string): boolean {
    return (this.jsonValid.get(json) as { ok: number }).ok === 1;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Largest list we bind into a single statement. SQLite allows 32766 variables;
 * stay well under so a statement with several lists still fits.
 */
export const MAX_LIST = 5000;

/** Split a list into MAX_LIST-sized chunks for batched lookups. */
export function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += MAX_LIST) out.push(values.slice(i, i + MAX_LIST));
  return out;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

/** Build a `col IN (?, ?, ...)` fragment with its params. Lists must be at most MAX_LIST long. */
export function inList(col: string, values: readonly (string | number)[]): { sql: string; params: (string | number)[] } {
  if (values.length === 0) return { sql: "0", params: [] };
  if (values.length > MAX_LIST) {
    throw new RangeError(`Too many values for ${col} (${values.length} > ${MAX_LIST}); split the query`);
  }
  return { sql: `${col} IN (${values.map(() => "?").join(",")})`, params: [...values] };
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

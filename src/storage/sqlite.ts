import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { uuidv7 } from "../ids.js";
import type { SqliteDatabaseOptions } from "../types.js";
import { dropIndexes, ensureIndexes, migrate } from "./migrations.js";
import { isThenable, type Dialect, type Effect, type Op, type Storage } from "./storage.js";

const SQLITE: Dialect = {
  name: "sqlite",
  groupConcat: (expr, separator) => `group_concat(${expr}, char(${separator}))`,
};

/** Identity of an open outermost transaction; carried to store calls through AsyncLocalStorage. */
type TxToken = object;

/** Prepared statements kept per connection; SQL strings repeat, parsing them does not have to. */
const STATEMENT_CACHE = 256;

/**
 * The SQLite backend: one better-sqlite3 connection, everything synchronous.
 *
 * Ops run to completion inside `run()`, so a store method has executed its
 * SQL before its first `await` and several of them can be issued inside one
 * synchronous `transaction(() => …)` callback. An async callback is supported
 * too: the transaction stays open across its awaits, and store calls from any
 * *other* async context queue up behind it until it commits (a single
 * connection cannot interleave two transactions).
 */
export class SqliteStorage implements Storage {
  readonly db: Database.Database;
  readonly newId: () => string;
  readonly dialect = SQLITE;
  private readonly jsonValid;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly als = new AsyncLocalStorage<TxToken>();
  /** The outermost open transaction, sync or async. */
  private active: TxToken | undefined;
  /** Savepoint nesting depth inside `active`. */
  private depth = 0;
  private nestedError: unknown;
  /** Resolves when `active` ends; what callers from other contexts wait on. */
  private released: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  constructor(options: SqliteDatabaseOptions = {}) {
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

  ready(): Promise<void> {
    return Promise.resolve();
  }

  get schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  /** True when the calling context is inside an open transaction of this connection. */
  private inTransaction(): boolean {
    return this.active !== undefined && this.als.getStore() === this.active;
  }

  /** True when a transaction opened by *another* context is in flight. */
  private blocked(): boolean {
    return this.active !== undefined && this.als.getStore() !== this.active;
  }

  run<T>(op: Op<T>): T | Promise<T> {
    if (this.blocked()) return this.released.then(() => this.run(op));
    return this.exec(op);
  }

  /**
   * Run raw better-sqlite3 work (the SQLite event store's) under the same
   * rule as ops: synchronously, unless another context's transaction is open,
   * in which case after it — so it never reads that transaction's uncommitted
   * rows or gets its writes swept into it.
   */
  guard<T>(fn: () => T): T | Promise<T> {
    if (this.blocked()) return this.released.then(() => this.guard(fn));
    return fn();
  }

  private exec<T>(op: Op<T>): T {
    let next = op.next();
    while (!next.done) {
      let result: unknown;
      try {
        result = this.handle(next.value);
      } catch (err) {
        next = op.throw(err);
        continue;
      }
      next = op.next(result);
    }
    return next.value;
  }

  private handle(effect: Effect): unknown {
    switch (effect.kind) {
      case "all":
        return this.prepare(effect.sql).all(...effect.params);
      case "run":
        return { changes: this.prepare(effect.sql).run(...effect.params).changes };
      case "tx":
        // Never blocked here: `run` checked the context before interpreting the op.
        return this.transaction(() => this.exec(effect.op()));
    }
  }

  private prepare(sql: string): Database.Statement {
    let stmt = this.statements.get(sql);
    if (stmt) return stmt;
    stmt = this.db.prepare(sql);
    if (this.statements.size >= STATEMENT_CACHE) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, stmt);
    return stmt;
  }

  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction.
   *
   * A synchronous `fn` commits before this returns. Store methods are async
   * but execute their SQL synchronously before their first await, so several
   * of them can be issued inside one synchronous callback. If any nested
   * write fails, its error is recorded and re-thrown from the outermost
   * transaction after `fn` returns, so the whole batch rolls back even though
   * the failing call only surfaced a rejected promise.
   *
   * An async `fn` keeps the transaction open until its promise settles;
   * meanwhile store calls from other async contexts wait for it. A call made
   * while another context's async transaction is open returns a promise that
   * runs `fn` once that transaction has ended.
   */
  transaction<T>(fn: () => T): T | Promise<Awaited<T>> {
    if (this.blocked()) return this.released.then(() => this.transaction(fn)) as Promise<Awaited<T>>;
    const outer = this.active === undefined;
    const token: TxToken = outer ? {} : this.active!;
    // Nothing is claimed until the statement has succeeded (the connection may be closed).
    this.db.exec(outer ? "BEGIN" : `SAVEPOINT sp${this.depth}`);
    const level = this.depth++;
    if (outer) {
      this.active = token;
      this.released = new Promise((resolve) => (this.release = resolve));
    }
    let result: T;
    try {
      result = this.als.run(token, fn);
    } catch (err) {
      this.rollback(outer, level, err);
      throw err;
    }
    if (isThenable(result)) {
      return Promise.resolve(result).then(
        (value) => {
          this.commit(outer, level);
          return value;
        },
        (err) => {
          this.rollback(outer, level, err);
          throw err;
        },
      );
    }
    this.commit(outer, level);
    return result;
  }

  private commit(outer: boolean, level: number): void {
    if (outer && this.nestedError !== undefined) {
      const err = this.nestedError;
      this.rollback(outer, level, err);
      throw err;
    }
    try {
      this.db.exec(outer ? "COMMIT" : `RELEASE sp${level}`);
    } catch (err) {
      this.rollback(outer, level, err);
      throw err;
    }
    this.finish(outer);
  }

  private rollback(outer: boolean, level: number, err: unknown): void {
    if (!outer && this.nestedError === undefined) this.nestedError = err;
    try {
      if (outer) this.db.exec("ROLLBACK");
      else this.db.exec(`ROLLBACK TO sp${level}; RELEASE sp${level}`);
    } catch {
      // The transaction is already gone (e.g. the failing statement rolled it back); nothing left to undo.
    }
    this.finish(outer);
  }

  private finish(outer: boolean): void {
    this.depth--;
    if (outer) {
      this.depth = 0;
      this.active = undefined;
      this.nestedError = undefined;
      this.release();
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
    if (this.inTransaction()) throw new Error("bulkLoad() cannot run inside a transaction");
    while (this.blocked()) await this.released;
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

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

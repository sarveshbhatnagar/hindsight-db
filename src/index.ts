import { Connection } from "./storage/sqlite.js";
import { DecisionStore } from "./stores/decisions.js";
import { EventStore } from "./stores/events.js";
import { HistoryStore } from "./stores/history.js";
import { OutcomeStore } from "./stores/outcomes.js";
import { TimelineStore } from "./stores/timeline.js";
import type { DatabaseOptions } from "./types.js";

export * from "./types.js";
export { addDuration, parseDuration, toMillis, windowAround } from "./time.js";
export { uuidv7 } from "./ids.js";
export { cosine } from "./vector.js";
export { SCHEMA_VERSION, SchemaVersionError } from "./storage/migrations.js";
export type { EventStore, TimelineStore, DecisionStore, OutcomeStore, HistoryStore };

/**
 * The hindsight-db database handle.
 *
 * ```ts
 * const db = openDatabase({ path: "history.db" });
 * const candidates = await db.events.similar({ event: currentEvent, limit: 20 });
 * const history = await db.history.getMany({ eventIds: candidates.map(c => c.id), before: "14d", after: "5d" });
 * ```
 */
export class HindsightDB {
  readonly events: EventStore;
  readonly timeline: TimelineStore;
  readonly decisions: DecisionStore;
  readonly outcomes: OutcomeStore;
  readonly history: HistoryStore;
  private readonly conn: Connection;

  constructor(options: DatabaseOptions = {}) {
    this.conn = new Connection(options);
    this.events = new EventStore(this.conn);
    this.timeline = new TimelineStore(this.conn, this.events);
    this.decisions = new DecisionStore(this.conn);
    this.outcomes = new OutcomeStore(this.conn);
    this.history = new HistoryStore(this.conn, this.events, this.timeline, this.decisions, this.outcomes);
  }

  /** Schema version of the open file (equals SCHEMA_VERSION after open). */
  get schemaVersion(): number {
    return this.conn.db.pragma("user_version", { simple: true }) as number;
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

  /** Run several writes atomically. */
  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn);
  }

  close(): void {
    this.conn.close();
  }
}

export function openDatabase(options: DatabaseOptions = {}): HindsightDB {
  return new HindsightDB(options);
}

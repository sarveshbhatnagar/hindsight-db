import type { EventRef, GcResult } from "../types.js";
import { all, chunks, inList, insertStatements, isThenable, MAX_LIST, run, tx, type Op, type Storage } from "./storage.js";

/**
 * Fetches events by id from wherever they live; an `EventProvider`'s
 * `getMany` fits directly. Ids it does not know are simply absent from the
 * result.
 */
export type EventRefResolver = (ids: string[]) => Promise<readonly EventRef[]>;

/** Event ids referenced by `inputs` that could be stubs; malformed ids are left for validation to reject. */
export function referencedEventIds(inputs: readonly { eventId: unknown }[]): string[] {
  return inputs.flatMap((i) => (typeof i.eventId === "string" && i.eventId ? [i.eventId] : []));
}

/**
 * Local stubs of events — (id, timestamp, observed_at) — that decisions and
 * outcomes reference instead of the `events` table, so that events may live
 * in another database. In the default mode the SQLite event store keeps the
 * stubs in sync through triggers; with an external provider the stub for an
 * id is fetched on first use through `resolver`.
 */
export class EventRefStore {
  private readonly storage: Storage;
  private readonly resolver: EventRefResolver | undefined;

  constructor(storage: Storage, resolver?: EventRefResolver) {
    this.storage = storage;
    this.resolver = resolver;
  }

  /** Stubs for `ids`, keyed by id. Unknown ids are omitted. */
  *getMany(ids: readonly string[]): Op<Map<string, EventRef>> {
    const out = new Map<string, EventRef>();
    for (const chunk of chunks(ids)) {
      const l = inList("id", chunk);
      const rows = yield* all<{ id: string; timestamp: number; observed_at: number }>(
        `SELECT id, timestamp, observed_at FROM event_refs WHERE ${l.sql}`,
        l.params,
      );
      for (const r of rows) out.set(r.id, { id: r.id, timestamp: r.timestamp, observedAt: r.observed_at });
    }
    return out;
  }

  /** Insert or refresh stubs. */
  *upsert(refs: readonly EventRef[]): Op<void> {
    if (refs.length === 0) return;
    yield* tx(function* () {
      const statements = insertStatements(
        "event_refs",
        ["id", "timestamp", "observed_at"],
        refs.map((r) => [r.id, r.timestamp, r.observedAt]),
        " ON CONFLICT (id) DO UPDATE SET timestamp = excluded.timestamp, observed_at = excluded.observed_at",
      );
      for (const s of statements) yield* run(s.sql, s.params);
    });
  }

  /**
   * Make sure every id in `ids` that the resolver knows has a local stub.
   * Returns `undefined` when there is nothing to fetch — no resolver, or every
   * id is already present — so callers can stay synchronous in that case and
   * keep working inside `db.transaction()`. Ids the resolver does not return
   * are left absent; the caller's insert then fails as for any unknown event.
   */
  ensure(ids: readonly string[]): Promise<void> | undefined {
    if (!this.resolver || ids.length === 0) return undefined;
    const distinct = [...new Set(ids)];
    const present = this.storage.run(this.getMany(distinct));
    const fetchMissing = (known: Map<string, EventRef>): Promise<void> | undefined => {
      const missing = distinct.filter((id) => !known.has(id));
      if (missing.length === 0) return undefined;
      return this.resolver!(missing).then((refs) => this.storage.run(this.upsert(refs)));
    };
    // On Postgres the presence check is itself async; then so is the whole thing.
    if (isThenable(present)) return Promise.resolve(present).then((known) => fetchMissing(known));
    return fetchMissing(present);
  }

  /**
   * Drop the stubs of events the resolver no longer knows, and with them
   * (by cascade) their decisions and outcomes. Ids are checked in chunks,
   * each chunk deleted in its own transaction, so a large table is swept
   * without holding the whole id list or a long write lock. Nothing to do
   * without a resolver: the SQLite event store keeps the stubs in sync itself.
   */
  async gc(): Promise<GcResult> {
    const result: GcResult = { removedEvents: 0, removedDecisions: 0, removedOutcomes: 0 };
    if (!this.resolver) return result;
    let after = "";
    for (;;) {
      const ids = (
        await this.storage.run(all<{ id: string }>(`SELECT id FROM event_refs WHERE id > ? ORDER BY id LIMIT ?`, [after, MAX_LIST]))
      ).map((r) => r.id);
      if (ids.length === 0) break;
      after = ids[ids.length - 1]!;
      const known = new Set((await this.resolver(ids)).map((r) => r.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length === 0) continue;
      const removed = await this.storage.run(
        tx(function* () {
          const l = inList("event_id", missing);
          const count = function* (table: string): Op<number> {
            const rows = yield* all<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${l.sql}`, l.params);
            return rows[0]!.n;
          };
          const decisions = yield* count("decisions");
          const outcomes = yield* count("outcomes");
          const del = inList("id", missing);
          const events = (yield* run(`DELETE FROM event_refs WHERE ${del.sql}`, del.params)).changes;
          return { events, decisions, outcomes };
        }),
      );
      result.removedEvents += removed.events;
      result.removedDecisions += removed.decisions;
      result.removedOutcomes += removed.outcomes;
    }
    return result;
  }
}

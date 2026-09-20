import type { EventRef } from "../types.js";
import type { Connection } from "./sqlite.js";
import { chunks, inList } from "./sqlite.js";

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
  private readonly conn: Connection;
  private readonly resolver: EventRefResolver | undefined;
  private readonly prepared;

  constructor(conn: Connection, resolver?: EventRefResolver) {
    this.conn = conn;
    this.resolver = resolver;
    this.prepared = {
      upsert: conn.db.prepare(
        `INSERT INTO event_refs (id, timestamp, observed_at) VALUES (@id, @timestamp, @observed_at)
         ON CONFLICT (id) DO UPDATE SET timestamp = excluded.timestamp, observed_at = excluded.observed_at`,
      ),
    };
  }

  /** Stubs for `ids`, keyed by id. Unknown ids are omitted. */
  getMany(ids: readonly string[]): Map<string, EventRef> {
    const out = new Map<string, EventRef>();
    for (const chunk of chunks(ids)) {
      const l = inList("id", chunk);
      const rows = this.conn.db
        .prepare(`SELECT id, timestamp, observed_at FROM event_refs WHERE ${l.sql}`)
        .all(...l.params) as { id: string; timestamp: number; observed_at: number }[];
      for (const r of rows) out.set(r.id, { id: r.id, timestamp: r.timestamp, observedAt: r.observed_at });
    }
    return out;
  }

  /** Insert or refresh stubs. */
  upsert(refs: readonly EventRef[]): void {
    this.conn.transaction(() => {
      for (const r of refs) this.prepared.upsert.run({ id: r.id, timestamp: r.timestamp, observed_at: r.observedAt });
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
    const present = this.getMany(distinct);
    const missing = distinct.filter((id) => !present.has(id));
    if (missing.length === 0) return undefined;
    return this.resolver(missing).then((refs) => this.upsert(refs));
  }
}

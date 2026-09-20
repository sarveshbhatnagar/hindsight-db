import { referencedEventIds, type EventRefStore } from "../storage/event-refs.js";
import type { Connection } from "../storage/sqlite.js";
import { chunks, inList } from "../storage/sqlite.js";
import { parseDuration, toMillis } from "../time.js";
import type { Outcome, OutcomeInput } from "../types.js";
import { assertId } from "../validate.js";

interface OutcomeRow {
  id: string;
  event_id: string;
  decision_id: string | null;
  timestamp: number;
  horizon: string;
  horizon_ms: number;
  result: string;
  metadata: string;
}

function rowToOutcome(r: OutcomeRow): Outcome {
  return {
    id: r.id,
    eventId: r.event_id,
    decisionId: r.decision_id,
    timestamp: r.timestamp,
    horizon: r.horizon,
    horizonMs: r.horizon_ms,
    result: JSON.parse(r.result),
    metadata: JSON.parse(r.metadata),
  };
}

export class OutcomeStore {
  private readonly conn: Connection;
  private readonly refs: EventRefStore;
  private readonly prepared;

  constructor(conn: Connection, refs: EventRefStore) {
    this.conn = conn;
    this.refs = refs;
    this.prepared = {
      insert: this.conn.db.prepare(
        `INSERT INTO outcomes (id, event_id, decision_id, timestamp, horizon, horizon_ms, result, metadata)
         VALUES (@id, @event_id, @decision_id, @timestamp, @horizon, @horizon_ms, @result, @metadata)`,
      ),
      get: this.conn.db.prepare(`SELECT * FROM outcomes WHERE id = ?`),
      byEvent: this.conn.db.prepare(`SELECT * FROM outcomes WHERE event_id = ? ORDER BY timestamp ASC, id ASC`),
    };
  }

  async insert(input: OutcomeInput): Promise<Outcome> {
    const [o] = await this.insertMany([input]);
    return o!;
  }

  /** Insert many outcomes atomically. Validates that any referenced decision belongs to `eventId`. */
  async insertMany(inputs: OutcomeInput[]): Promise<Outcome[]> {
    // With an external event source, stubs for unseen events are fetched
    // first, so `resolveAnchors` below still reads locally and synchronously.
    const pending = this.refs.ensure(referencedEventIds(inputs));
    if (pending) await pending;
    const rows = this.conn.transaction(() => {
      for (const input of inputs) {
        assertId("outcome.eventId", input.eventId);
        if (input.decisionId !== undefined && input.decisionId !== null) assertId("outcome.decisionId", input.decisionId);
        if (input.result === undefined) throw new TypeError("outcome.result is required");
      }
      const anchors = this.resolveAnchors(inputs);
      return inputs.map((input) => {
        const horizonMs = parseDuration(input.horizon);
        if (horizonMs < 0) throw new TypeError(`outcome.horizon must not be negative (got ${String(input.horizon)})`);
        const horizon = typeof input.horizon === "string" ? input.horizon.trim() : `${horizonMs}ms`;
        // Always resolve the anchor: it is also the event/decision consistency check.
        const anchor = anchors(input);
        const timestamp = input.timestamp !== undefined ? toMillis(input.timestamp) : anchor + horizonMs;
        const row = {
          id: input.id === undefined ? this.conn.newId() : assertId("outcome.id", input.id),
          event_id: input.eventId,
          decision_id: input.decisionId ?? null,
          timestamp,
          horizon,
          horizon_ms: horizonMs,
          result: JSON.stringify(input.result),
          metadata: JSON.stringify(input.metadata ?? {}),
        };
        this.prepared.insert.run(row);
        return row;
      });
    });
    return rows.map(rowToOutcome);
  }

  /**
   * Look up every referenced decision and event stub in one query each, then
   * return a resolver: the decision's timestamp if a decision is referenced,
   * otherwise the event's. The resolver throws if the event/decision does not
   * exist or the decision belongs to another event.
   */
  private resolveAnchors(inputs: OutcomeInput[]): (input: OutcomeInput) => number {
    const decisionIds = [...new Set(inputs.flatMap((i) => (i.decisionId ? [i.decisionId] : [])))];
    const eventIds = [...new Set(inputs.flatMap((i) => (i.decisionId ? [] : [i.eventId])))];
    const decisions = new Map<string, { event_id: string; timestamp: number }>();
    for (const chunk of chunks(decisionIds)) {
      const l = inList("id", chunk);
      for (const d of this.conn.db.prepare(`SELECT id, event_id, timestamp FROM decisions WHERE ${l.sql}`).all(...l.params) as {
        id: string;
        event_id: string;
        timestamp: number;
      }[]) {
        decisions.set(d.id, d);
      }
    }
    const events = this.refs.getMany(eventIds);
    return (input) => {
      if (input.decisionId) {
        const d = decisions.get(input.decisionId);
        if (!d) throw new Error(`Decision not found: ${input.decisionId}`);
        if (d.event_id !== input.eventId) {
          throw new Error(`Decision ${input.decisionId} belongs to event ${d.event_id}, not ${input.eventId}`);
        }
        return d.timestamp;
      }
      const ref = events.get(input.eventId);
      if (ref === undefined) throw new Error(`Event not found: ${input.eventId}`);
      return ref.timestamp;
    };
  }

  async get(id: string): Promise<Outcome | undefined> {
    const row = this.prepared.get.get(id) as OutcomeRow | undefined;
    return row ? rowToOutcome(row) : undefined;
  }

  /** Outcomes for an event, ascending by outcome time. `until` cuts at outcome time. */
  async forEvent(eventId: string, opts: { until?: number } = {}): Promise<Outcome[]> {
    const rows = this.prepared.byEvent.all(eventId) as OutcomeRow[];
    return rows.map(rowToOutcome).filter((o) => opts.until === undefined || o.timestamp <= opts.until);
  }

  /** Outcomes for many events in one query, keyed by event id. */
  forEvents(eventIds: string[]): Map<string, Outcome[]> {
    const out = new Map<string, Outcome[]>(eventIds.map((id) => [id, []]));
    if (eventIds.length === 0) return out;
    for (const chunk of chunks(eventIds)) {
      const l = inList("event_id", chunk);
      const rows = this.conn.db
        .prepare(`SELECT * FROM outcomes WHERE ${l.sql} ORDER BY timestamp ASC, id ASC`)
        .all(...l.params) as OutcomeRow[];
      for (const r of rows) out.get(r.event_id)!.push(rowToOutcome(r));
    }
    return out;
  }
}

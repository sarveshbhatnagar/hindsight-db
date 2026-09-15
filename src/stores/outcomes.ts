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
  private readonly prepared;

  constructor(conn: Connection) {
    this.conn = conn;
    this.prepared = {
      insert: this.conn.db.prepare(
        `INSERT INTO outcomes (id, event_id, decision_id, timestamp, horizon, horizon_ms, result, metadata)
         VALUES (@id, @event_id, @decision_id, @timestamp, @horizon, @horizon_ms, @result, @metadata)`,
      ),
      get: this.conn.db.prepare(`SELECT * FROM outcomes WHERE id = ?`),
      byEvent: this.conn.db.prepare(`SELECT * FROM outcomes WHERE event_id = ? ORDER BY timestamp ASC, id ASC`),
      eventTs: this.conn.db.prepare(`SELECT timestamp FROM events WHERE id = ?`),
      decisionTs: this.conn.db.prepare(`SELECT event_id, timestamp FROM decisions WHERE id = ?`),
    };
  }

  async insert(input: OutcomeInput): Promise<Outcome> {
    const [o] = await this.insertMany([input]);
    return o!;
  }

  /** Insert many outcomes atomically. Validates that any referenced decision belongs to `eventId`. */
  async insertMany(inputs: OutcomeInput[]): Promise<Outcome[]> {
    const rows = this.conn.transaction(() =>
      inputs.map((input) => {
        assertId("outcome.eventId", input.eventId);
        if (input.decisionId !== undefined && input.decisionId !== null) assertId("outcome.decisionId", input.decisionId);
        if (input.result === undefined) throw new TypeError("outcome.result is required");
        const horizonMs = parseDuration(input.horizon);
        if (horizonMs < 0) throw new TypeError(`outcome.horizon must not be negative (got ${String(input.horizon)})`);
        const horizon = typeof input.horizon === "string" ? input.horizon.trim() : `${horizonMs}ms`;
        // Always resolve the anchor: it is also the event/decision consistency check.
        const anchor = this.anchorTimestamp(input);
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
      }),
    );
    return rows.map(rowToOutcome);
  }

  /**
   * The decision's timestamp if a decision is referenced, otherwise the event's.
   * Throws if the event/decision does not exist or the decision belongs to another event.
   */
  private anchorTimestamp(input: OutcomeInput): number {
    if (input.decisionId) {
      const d = this.prepared.decisionTs.get(input.decisionId) as { event_id: string; timestamp: number } | undefined;
      if (!d) throw new Error(`Decision not found: ${input.decisionId}`);
      if (d.event_id !== input.eventId) {
        throw new Error(`Decision ${input.decisionId} belongs to event ${d.event_id}, not ${input.eventId}`);
      }
      return d.timestamp;
    }
    const e = this.prepared.eventTs.get(input.eventId) as { timestamp: number } | undefined;
    if (!e) throw new Error(`Event not found: ${input.eventId}`);
    return e.timestamp;
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

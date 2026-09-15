import type { Connection } from "../storage/sqlite.js";
import { chunks, inList } from "../storage/sqlite.js";
import { toMillis } from "../time.js";
import type { Decision, DecisionInput } from "../types.js";
import { assertId } from "../validate.js";

interface DecisionRow {
  id: string;
  event_id: string;
  timestamp: number;
  action: string;
  metadata: string;
}

function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    eventId: r.event_id,
    timestamp: r.timestamp,
    action: JSON.parse(r.action),
    metadata: JSON.parse(r.metadata),
  };
}

export class DecisionStore {
  private readonly conn: Connection;
  private readonly prepared;

  constructor(conn: Connection) {
    this.conn = conn;
    this.prepared = {
      insert: this.conn.db.prepare(
        `INSERT INTO decisions (id, event_id, timestamp, action, metadata)
         VALUES (@id, @event_id, @timestamp, @action, @metadata)`,
      ),
      get: this.conn.db.prepare(`SELECT * FROM decisions WHERE id = ?`),
      byEvent: this.conn.db.prepare(`SELECT * FROM decisions WHERE event_id = ? ORDER BY timestamp ASC, id ASC`),
    };
  }

  async insert(input: DecisionInput): Promise<Decision> {
    const [d] = await this.insertMany([input]);
    return d!;
  }

  async insertMany(inputs: DecisionInput[]): Promise<Decision[]> {
    const rows = this.conn.transaction(() => {
      const normalized = inputs.map((input) => {
      assertId("decision.eventId", input.eventId);
      if (input.action === undefined) throw new TypeError("decision.action is required");
      return {
        id: input.id === undefined ? this.conn.newId() : assertId("decision.id", input.id),
        event_id: input.eventId,
        timestamp: toMillis(input.timestamp),
        action: JSON.stringify(input.action),
          metadata: JSON.stringify(input.metadata ?? {}),
        };
      });
      for (const row of normalized) this.prepared.insert.run(row);
      return normalized;
    });
    return rows.map(rowToDecision);
  }

  async get(id: string): Promise<Decision | undefined> {
    const row = this.prepared.get.get(id) as DecisionRow | undefined;
    return row ? rowToDecision(row) : undefined;
  }

  /** Decisions for an event, ascending by timestamp. */
  async forEvent(eventId: string, opts: { until?: number } = {}): Promise<Decision[]> {
    const rows = this.prepared.byEvent.all(eventId) as DecisionRow[];
    return rows.map(rowToDecision).filter((d) => opts.until === undefined || d.timestamp <= opts.until);
  }

  /** Decisions for many events in one query, keyed by event id. */
  forEvents(eventIds: string[]): Map<string, Decision[]> {
    const out = new Map<string, Decision[]>(eventIds.map((id) => [id, []]));
    if (eventIds.length === 0) return out;
    for (const chunk of chunks(eventIds)) {
      const l = inList("event_id", chunk);
      const rows = this.conn.db
        .prepare(`SELECT * FROM decisions WHERE ${l.sql} ORDER BY timestamp ASC, id ASC`)
        .all(...l.params) as DecisionRow[];
      for (const r of rows) out.get(r.event_id)!.push(rowToDecision(r));
    }
    return out;
  }
}

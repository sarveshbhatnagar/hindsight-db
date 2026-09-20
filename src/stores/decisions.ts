import { referencedEventIds, type EventRefStore } from "../storage/event-refs.js";
import { all, chunks, inList, insertStatements, one, run, tx, type Op, type SqlParam, type Storage } from "../storage/storage.js";
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

const COLUMNS = ["id", "event_id", "timestamp", "action", "metadata"] as const;

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
  private readonly storage: Storage;
  private readonly refs: EventRefStore;

  constructor(storage: Storage, refs: EventRefStore) {
    this.storage = storage;
    this.refs = refs;
  }

  async insert(input: DecisionInput): Promise<Decision> {
    const [d] = await this.insertMany([input]);
    return d!;
  }

  async insertMany(inputs: DecisionInput[]): Promise<Decision[]> {
    // With an external event source, stubs for unseen events are fetched
    // first; the SQL below then runs as usual (synchronously, on SQLite).
    const pending = this.refs.ensure(referencedEventIds(inputs));
    if (pending) await pending;
    const storage = this.storage;
    const rows = await storage.run(
      tx(function* () {
        const normalized = inputs.map((input): DecisionRow => {
          assertId("decision.eventId", input.eventId);
          if (input.action === undefined) throw new TypeError("decision.action is required");
          return {
            id: input.id === undefined ? storage.newId() : assertId("decision.id", input.id),
            event_id: input.eventId,
            timestamp: toMillis(input.timestamp),
            action: JSON.stringify(input.action),
            metadata: JSON.stringify(input.metadata ?? {}),
          };
        });
        const statements = insertStatements("decisions", COLUMNS, normalized.map((r) => COLUMNS.map((c) => r[c] as SqlParam)));
        for (const s of statements) yield* run(s.sql, s.params);
        return normalized;
      }),
    );
    return rows.map(rowToDecision);
  }

  async get(id: string): Promise<Decision | undefined> {
    const row = await this.storage.run(one<DecisionRow>(`SELECT * FROM decisions WHERE id = ?`, [id]));
    return row ? rowToDecision(row) : undefined;
  }

  /** Decisions for an event, ascending by timestamp. */
  async forEvent(eventId: string, opts: { until?: number } = {}): Promise<Decision[]> {
    const rows = await this.storage.run(
      all<DecisionRow>(`SELECT * FROM decisions WHERE event_id = ? ORDER BY timestamp ASC, id ASC`, [eventId]),
    );
    return rows.map(rowToDecision).filter((d) => opts.until === undefined || d.timestamp <= opts.until);
  }

  /** Decisions for many events in one query, keyed by event id. */
  *forEvents(eventIds: string[]): Op<Map<string, Decision[]>> {
    const out = new Map<string, Decision[]>(eventIds.map((id) => [id, []]));
    if (eventIds.length === 0) return out;
    for (const chunk of chunks(eventIds)) {
      const l = inList("event_id", chunk);
      const rows = yield* all<DecisionRow>(`SELECT * FROM decisions WHERE ${l.sql} ORDER BY timestamp ASC, id ASC`, l.params);
      for (const r of rows) out.get(r.event_id)!.push(rowToDecision(r));
    }
    return out;
  }
}

import type { Connection } from "../storage/sqlite.js";
import { asArray, decodeCursor, encodeCursor, inList } from "../storage/sqlite.js";
import { toMillis, windowAround } from "../time.js";
import type {
  NamespaceStats,
  Page,
  TimelineEntityStats,
  TimelineEntityStatsQuery,
  TimelineAroundQuery,
  TimelinePoint,
  TimelinePointInput,
  TimelineRangeQuery,
  TimelineStreams,
} from "../types.js";
import { assertEntity, assertLimit } from "../validate.js";
import { prefixUpperBound, type EventStore } from "./events.js";

interface TimelineRow {
  id: number;
  timestamp: number;
  observed_at: number;
  entity: string;
  namespace: string;
  data: string;
}

function rowToPoint(r: TimelineRow): TimelinePoint {
  return {
    id: r.id,
    timestamp: r.timestamp,
    observedAt: r.observed_at,
    entity: r.entity,
    namespace: r.namespace,
    data: JSON.parse(r.data),
  };
}

/** Group points by namespace. Points are expected to arrive sorted by timestamp. */
export function groupByNamespace(points: TimelinePoint[]): TimelineStreams {
  const streams: TimelineStreams = {};
  for (const p of points) (streams[p.namespace] ??= []).push(p);
  return streams;
}

export interface TimelineWindowSpec {
  from: number;
  to: number;
  asOf?: number;
  entities?: string[];
  namespaces?: string[];
  /** Fetch at most this many points; the result reports whether more exist. */
  limit?: number;
}

export interface TimelineWindow {
  points: TimelinePoint[];
  /** Set when `limit` cut the window: the keyset cursor for the remainder. */
  nextCursor?: string;
}

export class TimelineStore {
  private readonly conn: Connection;
  private readonly events: EventStore;
  private readonly prepared;

  constructor(conn: Connection, events: EventStore) {
    this.conn = conn;
    this.events = events;
    this.prepared = {
      insert: conn.db.prepare(
        `INSERT INTO timeline (timestamp, observed_at, entity, namespace, data)
         VALUES (@timestamp, @observed_at, @entity, @namespace, @data)`,
      ),
    };
  }

  async insert(input: TimelinePointInput): Promise<TimelinePoint> {
    const [p] = await this.insertMany([input]);
    return p!;
  }

  async insertMany(inputs: TimelinePointInput[]): Promise<TimelinePoint[]> {
    const ids: number[] = [];
    const rows = this.conn.transaction(() => {
      const normalized = inputs.map((input) => {
      assertEntity("timeline.entity", input.entity);
      assertEntity("timeline.namespace", input.namespace);
      const timestamp = toMillis(input.timestamp);
      return {
        timestamp,
        observed_at: input.observedAt === undefined ? timestamp : toMillis(input.observedAt),
        entity: input.entity,
        namespace: input.namespace,
          data: JSON.stringify(input.data ?? null),
        };
      });
      for (const row of normalized) ids.push(Number(this.prepared.insert.run(row).lastInsertRowid));
      return normalized;
    });
    return rows.map((row, i) => ({
      id: ids[i]!,
      timestamp: row.timestamp,
      observedAt: row.observed_at,
      entity: row.entity,
      namespace: row.namespace,
      data: JSON.parse(row.data),
    }));
  }

  /** Points in an absolute [from, to] window, ascending by (timestamp, id), paginated. */
  async range(query: TimelineRangeQuery): Promise<Page<TimelinePoint>> {
    const limit = assertLimit("limit", query.limit, 1000, 100_000);
    const spec: TimelineWindowSpec = {
      from: toMillis(query.from),
      to: toMillis(query.to),
      ...(query.asOf !== undefined ? { asOf: toMillis(query.asOf) } : {}),
      ...(query.entity !== undefined ? { entities: asArray(query.entity) } : {}),
      ...(query.namespace !== undefined ? { namespaces: asArray(query.namespace) } : {}),
    };
    const { where, params } = this.buildWhere(spec);
    const cursor = decodeCursor<{ t: number; id: number }>(query.cursor);
    const cursorSql = cursor ? " AND (timestamp > ? OR (timestamp = ? AND id > ?))" : "";
    const cursorParams = cursor ? [cursor.t, cursor.t, cursor.id] : [];
    const rows = this.conn.db
      .prepare(`SELECT * FROM timeline WHERE ${where}${cursorSql} ORDER BY timestamp ASC, id ASC LIMIT ?`)
      .all(...params, ...cursorParams, limit + 1) as TimelineRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToPoint);
    const last = items[items.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ t: last.timestamp, id: last.id }) } : {}),
    };
  }

  /** All streams in a window around an event, grouped by namespace. */
  async around(query: TimelineAroundQuery): Promise<TimelineStreams> {
    const event = await this.events.get(query.eventId);
    if (!event) throw new Error(`Event not found: ${query.eventId}`);
    const { from, to } = windowAround(event.timestamp, query.before, query.after);
    const entities = query.entities !== undefined ? asArray(query.entities) : event.entities;
    return groupByNamespace(
      this.fetchWindow({
        from,
        to,
        ...(query.asOf !== undefined ? { asOf: toMillis(query.asOf) } : {}),
        ...(entities && entities.length ? { entities } : {}),
        ...(query.namespace !== undefined ? { namespaces: asArray(query.namespace) } : {}),
      }).points,
    );
  }

  /** Entities with timeline data, with point counts, namespaces and time span, most data first. */
  async entities(query: TimelineEntityStatsQuery = {}): Promise<TimelineEntityStats[]> {
    const limit = assertLimit("limit", query.limit, 1000, 100_000);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    const namespaces = asArray(query.namespace);
    if (namespaces?.length) {
      const l = inList("namespace", namespaces);
      clauses.push(l.sql);
      params.push(...l.params);
    }
    if (query.prefix) {
      clauses.push("entity >= ? AND entity < ?");
      params.push(query.prefix, prefixUpperBound(query.prefix));
    }
    const where = clauses.length ? clauses.join(" AND ") : "1";
    const rows = this.conn.db
      .prepare(
        `SELECT entity, sum(count) AS count, group_concat(namespace, char(31)) AS namespaces, min(f) AS "from", max(t) AS "to"
         FROM (
           SELECT entity, namespace, count(*) AS count, min(timestamp) AS f, max(timestamp) AS t
           FROM timeline WHERE ${where} GROUP BY entity, namespace
         )
         GROUP BY entity ORDER BY count DESC, entity ASC LIMIT ?`,
      )
      .all(...params, limit) as { entity: string; count: number; namespaces: string; from: number; to: number }[];
    return rows.map((r) => ({ ...r, namespaces: r.namespaces.split(String.fromCharCode(31)).sort() }));
  }

  /** Namespaces (streams) in use, with point counts, distinct entities and time span. */
  async namespaces(): Promise<NamespaceStats[]> {
    return this.conn.db
      .prepare(
        `SELECT namespace, count(*) AS count, count(DISTINCT entity) AS entities, min(timestamp) AS "from", max(timestamp) AS "to"
         FROM timeline GROUP BY namespace ORDER BY count DESC, namespace ASC`,
      )
      .all() as NamespaceStats[];
  }

  /** Window fetch used internally by `around` and the history API; unbounded unless `spec.limit` is set. */
  fetchWindow(spec: TimelineWindowSpec): TimelineWindow {
    const { where, params } = this.buildWhere(spec);
    const sql = `SELECT * FROM timeline WHERE ${where} ORDER BY timestamp ASC, id ASC`;
    if (spec.limit === undefined) {
      return { points: (this.conn.db.prepare(sql).all(...params) as TimelineRow[]).map(rowToPoint) };
    }
    const rows = this.conn.db.prepare(`${sql} LIMIT ?`).all(...params, spec.limit + 1) as TimelineRow[];
    const points = rows.slice(0, spec.limit).map(rowToPoint);
    const last = points[points.length - 1];
    return rows.length > spec.limit && last
      ? { points, nextCursor: encodeCursor({ t: last.timestamp, id: last.id }) }
      : { points };
  }

  /**
   * Fetch several windows in one read transaction. Each window is returned
   * sorted ascending by (timestamp, id), in the same order as `specs`.
   */
  fetchWindows(specs: TimelineWindowSpec[]): TimelineWindow[] {
    if (specs.length === 0) return [];
    return this.conn.transaction(() => specs.map((s) => this.fetchWindow(s)));
  }

  private buildWhere(spec: TimelineWindowSpec): { where: string; params: (string | number)[] } {
    const clauses = ["timestamp >= ?", "timestamp <= ?"];
    const params: (string | number)[] = [spec.from, spec.to];
    if (spec.asOf !== undefined) {
      clauses.push("observed_at <= ?");
      params.push(spec.asOf);
    }
    if (spec.entities?.length) {
      const l = inList("entity", spec.entities);
      clauses.push(l.sql);
      params.push(...l.params);
    }
    if (spec.namespaces?.length) {
      const l = inList("namespace", spec.namespaces);
      clauses.push(l.sql);
      params.push(...l.params);
    }
    return { where: clauses.join(" AND "), params };
  }
}

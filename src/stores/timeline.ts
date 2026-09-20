import {
  all,
  asArray,
  decodeCursor,
  encodeCursor,
  inList,
  insertStatements,
  prefixUpperBound,
  tx,
  type Op,
  type SqlParam,
  type Storage,
} from "../storage/storage.js";
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
import type { EventProvider } from "../events/provider.js";
import type { AliasStore } from "./aliases.js";

interface TimelineRow {
  id: number;
  timestamp: number;
  observed_at: number;
  entity: string;
  namespace: string;
  data: string;
}

/** ASCII unit separator: never part of an entity or namespace (see `assertEntity`). */
const SEP = 31;

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
  private readonly storage: Storage;
  private readonly events: EventProvider;
  private readonly aliases: AliasStore;

  constructor(storage: Storage, events: EventProvider, aliases: AliasStore) {
    this.storage = storage;
    this.events = events;
    this.aliases = aliases;
  }

  async insert(input: TimelinePointInput): Promise<TimelinePoint> {
    const [p] = await this.insertMany([input]);
    return p!;
  }

  async insertMany(inputs: TimelinePointInput[]): Promise<TimelinePoint[]> {
    return this.storage.run(
      tx(function* () {
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
        // Ids are assigned in row order within one statement on both backends,
        // so sorting what RETURNING hands back lines them up with the inputs.
        const ids: number[] = [];
        const statements = insertStatements(
          "timeline",
          ["timestamp", "observed_at", "entity", "namespace", "data"],
          normalized.map((r) => [r.timestamp, r.observed_at, r.entity, r.namespace, r.data]),
          " RETURNING id",
        );
        for (const s of statements) {
          const rows = yield* all<{ id: number }>(s.sql, s.params);
          ids.push(...rows.map((r) => r.id).sort((a, b) => a - b));
        }
        return normalized.map((row, i) => ({
          id: ids[i]!,
          timestamp: row.timestamp,
          observedAt: row.observed_at,
          entity: row.entity,
          namespace: row.namespace,
          data: JSON.parse(row.data),
        }));
      }),
    );
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
    const { where, params } = buildWhere(spec);
    const cursor = decodeCursor<{ t: number; id: number }>(query.cursor);
    // Row-value form: both backends turn it into a single index range start.
    const cursorSql = cursor ? " AND (timestamp, id) > (?, ?)" : "";
    const cursorParams = cursor ? [cursor.t, cursor.id] : [];
    const rows = await this.storage.run(
      all<TimelineRow>(`SELECT * FROM timeline WHERE ${where}${cursorSql} ORDER BY timestamp ASC, id ASC LIMIT ?`, [
        ...params,
        ...cursorParams,
        limit + 1,
      ]),
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToPoint);
    const last = items[items.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ t: last.timestamp, id: last.id }) } : {}),
    };
  }

  /**
   * All streams in a window around an event, grouped by namespace. The
   * event's entities select the streams (expanded through `db.aliases`)
   * unless `entities` overrides them.
   */
  async around(query: TimelineAroundQuery): Promise<TimelineStreams> {
    const event = await this.events.get(query.eventId);
    if (!event) throw new Error(`Event not found: ${query.eventId}`);
    const { from, to } = windowAround(event.timestamp, query.before, query.after);
    const store = this;
    const window = await this.storage.run(
      tx(function* () {
        const entities = query.entities !== undefined ? asArray(query.entities) : yield* store.aliases.expand(event.entities);
        return yield* store.fetchWindow({
          from,
          to,
          ...(query.asOf !== undefined ? { asOf: toMillis(query.asOf) } : {}),
          ...(entities && entities.length ? { entities } : {}),
          ...(query.namespace !== undefined ? { namespaces: asArray(query.namespace) } : {}),
        });
      }),
    );
    return groupByNamespace(window.points);
  }

  /** Entities with timeline data, with point counts, namespaces and time span, most data first. */
  async entities(query: TimelineEntityStatsQuery = {}): Promise<TimelineEntityStats[]> {
    const limit = assertLimit("limit", query.limit, 1000, 100_000);
    const clauses: string[] = [];
    const params: SqlParam[] = [];
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
    const where = clauses.length ? clauses.join(" AND ") : "1=1";
    const rows = await this.storage.run(
      all<{ entity: string; count: number; namespaces: string; from: number; to: number }>(
        `SELECT entity, CAST(sum(count) AS BIGINT) AS count, ${this.storage.dialect.groupConcat("namespace", SEP)} AS namespaces,
                min(f) AS "from", max(t) AS "to"
         FROM (
           SELECT entity, namespace, count(*) AS count, min(timestamp) AS f, max(timestamp) AS t
           FROM timeline WHERE ${where} GROUP BY entity, namespace
         ) AS per_namespace
         GROUP BY entity ORDER BY count DESC, entity ASC LIMIT ?`,
        [...params, limit],
      ),
    );
    return rows.map((r) => ({ ...r, namespaces: r.namespaces.split(String.fromCharCode(SEP)).sort() }));
  }

  /** Namespaces (streams) in use, with point counts, distinct entities and time span. */
  async namespaces(): Promise<NamespaceStats[]> {
    return this.storage.run(
      all<NamespaceStats>(
        `SELECT namespace, count(*) AS count, count(DISTINCT entity) AS entities, min(timestamp) AS "from", max(timestamp) AS "to"
         FROM timeline GROUP BY namespace ORDER BY count DESC, namespace ASC`,
      ),
    );
  }

  /** Window fetch used internally by `around` and the history API; unbounded unless `spec.limit` is set. */
  *fetchWindow(spec: TimelineWindowSpec): Op<TimelineWindow> {
    const { where, params } = buildWhere(spec);
    const sql = `SELECT * FROM timeline WHERE ${where} ORDER BY timestamp ASC, id ASC`;
    if (spec.limit === undefined) {
      return { points: (yield* all<TimelineRow>(sql, params)).map(rowToPoint) };
    }
    const rows = yield* all<TimelineRow>(`${sql} LIMIT ?`, [...params, spec.limit + 1]);
    return cut(rows, spec.limit);
  }

  /**
   * Fetch several windows in one read transaction. Each window is returned
   * sorted ascending by (timestamp, id), in the same order as `specs`. On
   * Postgres, windows of one shape go out as a single query.
   */
  *fetchWindows(specs: TimelineWindowSpec[]): Op<TimelineWindow[]> {
    if (specs.length === 0) return [];
    const store = this;
    return yield* tx(function* () {
      if (store.storage.dialect.name === "postgres" && specs.length > 1) {
        const batched = yield* store.fetchWindowsBatched(specs);
        if (batched) return batched;
      }
      const out: TimelineWindow[] = [];
      for (const spec of specs) out.push(yield* store.fetchWindow(spec));
      return out;
    });
  }

  /**
   * One round trip for many windows: the specs go over as parallel arrays,
   * `unnest`ed and joined LATERAL to a per-window index scan. Needs every
   * window to have the same shape (all or none with entities, namespaces,
   * asOf and limit), so the WHERE clause — and the index it drives — is the
   * same for each; returns undefined otherwise.
   */
  private *fetchWindowsBatched(specs: TimelineWindowSpec[]): Op<TimelineWindow[] | undefined> {
    const has = (pick: (s: TimelineWindowSpec) => boolean): boolean | undefined => {
      const n = specs.filter(pick).length;
      return n === specs.length ? true : n === 0 ? false : undefined;
    };
    const withEntities = has((s) => (s.entities?.length ?? 0) > 0);
    const withNamespaces = has((s) => (s.namespaces?.length ?? 0) > 0);
    const withAsOf = has((s) => s.asOf !== undefined);
    const withLimit = has((s) => s.limit !== undefined);
    if ([withEntities, withNamespaces, withAsOf, withLimit].includes(undefined)) return undefined;
    const sep = String.fromCharCode(SEP);
    const join = (list: string[] | undefined): string | undefined => {
      if (!list) return "";
      if (list.some((s) => s.includes(sep))) return undefined; // cannot be encoded; fall back
      return list.join(sep);
    };
    const ents = specs.map((s) => join(s.entities));
    const nss = specs.map((s) => join(s.namespaces));
    if (ents.includes(undefined) || nss.includes(undefined)) return undefined;

    const clauses = ["timestamp >= w.f", "timestamp <= w.t"];
    if (withAsOf) clauses.push("observed_at <= w.as_of");
    if (withEntities) clauses.push("entity = ANY(string_to_array(w.ents, chr(31)))");
    if (withNamespaces) clauses.push("namespace = ANY(string_to_array(w.nss, chr(31)))");
    const rows = yield* all<TimelineRow & { i: number }>(
      `SELECT w.i, t.id, t.timestamp, t.observed_at, t.entity, t.namespace, t.data
       FROM unnest(?::int[], ?::bigint[], ?::bigint[], ?::bigint[], ?::text[], ?::text[], ?::bigint[]) AS w(i, f, t, as_of, ents, nss, lim)
       JOIN LATERAL (
         SELECT * FROM timeline WHERE ${clauses.join(" AND ")} ORDER BY timestamp ASC, id ASC LIMIT w.lim
       ) t ON true
       ORDER BY w.i ASC, t.timestamp ASC, t.id ASC`,
      [
        specs.map((_, i) => i),
        specs.map((s) => s.from),
        specs.map((s) => s.to),
        specs.map((s) => s.asOf ?? 0),
        ents as string[],
        nss as string[],
        specs.map((s) => (s.limit === undefined ? null : s.limit + 1)),
      ],
    );
    const perWindow: TimelineRow[][] = specs.map(() => []);
    for (const r of rows) perWindow[r.i]!.push(r);
    return perWindow.map((windowRows, i) => {
      const limit = specs[i]!.limit;
      return limit === undefined ? { points: windowRows.map(rowToPoint) } : cut(windowRows, limit);
    });
  }
}

/** Trim a `limit + 1` fetch to `limit` points, with a cursor when the extra row proved there is more. */
function cut(rows: TimelineRow[], limit: number): TimelineWindow {
  const points = rows.slice(0, limit).map(rowToPoint);
  const last = points[points.length - 1];
  return rows.length > limit && last ? { points, nextCursor: encodeCursor({ t: last.timestamp, id: last.id }) } : { points };
}

function buildWhere(spec: TimelineWindowSpec): { where: string; params: SqlParam[] } {
  const clauses = ["timestamp >= ?", "timestamp <= ?"];
  const params: SqlParam[] = [spec.from, spec.to];
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

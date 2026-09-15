import type { Connection } from "../storage/sqlite.js";
import { asArray, chunks, decodeCursor, encodeCursor, inList } from "../storage/sqlite.js";
import { toMillis } from "../time.js";
import type {
  Event,
  EventFilters,
  EventInput,
  EventListQuery,
  Page,
  SimilarEvent,
  SimilarQuery,
} from "../types.js";
import { assertEntity, assertId, assertLimit, assertPlainObject } from "../validate.js";
import { assertFiniteEmbedding, cosine, decodeEmbedding, encodeEmbedding, l2norm, toFloat32 } from "../vector.js";

interface EventRow {
  id: string;
  timestamp: number;
  observed_at: number;
  type: string;
  content: string;
  embedding: Buffer | null;
  dim: number | null;
  norm: number | null;
  metadata: string;
  entities: string | null; // joined with SEP via group_concat
}

/** ASCII unit separator: safe join character for entity ids. */
const SEP = String.fromCharCode(31);

const SELECT = `
  SELECT e.*, (
    SELECT group_concat(entity_id, char(31))
    FROM (SELECT entity_id FROM event_entities ee WHERE ee.event_id = e.id ORDER BY position)
  ) AS entities
  FROM events e`;

function splitEntities(s: string | null): string[] {
  return s ? s.split(SEP) : [];
}

function rowToEvent(r: EventRow, includeEmbedding: boolean): Event {
  const ev: Event = {
    id: r.id,
    timestamp: r.timestamp,
    observedAt: r.observed_at,
    type: r.type,
    entities: splitEntities(r.entities),
    content: JSON.parse(r.content),
    metadata: JSON.parse(r.metadata),
  };
  if (includeEmbedding && r.embedding) ev.embedding = decodeEmbedding(r.embedding);
  return ev;
}

/** Translate EventFilters into a WHERE clause over alias `e`. */
function buildWhere(filters: EventFilters | undefined): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (!filters) return { where: "1", params };

  const types = asArray(filters.type);
  if (types?.length) {
    const l = inList("e.type", types);
    clauses.push(l.sql);
    params.push(...l.params);
  }
  const entities = asArray(filters.entities);
  if (entities?.length) {
    // IN-subquery lets the planner drive from event_entities_entity instead of scanning events.
    const l = inList("entity_id", entities);
    clauses.push(`e.id IN (SELECT event_id FROM event_entities WHERE ${l.sql})`);
    params.push(...l.params);
  }
  if (filters.from !== undefined) {
    clauses.push("e.timestamp >= ?");
    params.push(toMillis(filters.from));
  }
  if (filters.to !== undefined) {
    clauses.push("e.timestamp <= ?");
    params.push(toMillis(filters.to));
  }
  if (filters.asOf !== undefined) {
    clauses.push("e.observed_at <= ?");
    params.push(toMillis(filters.asOf));
  }
  if (filters.metadata) {
    for (const [key, value] of Object.entries(filters.metadata)) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) throw new TypeError(`Invalid metadata filter key: "${key}"`);
      const path = `'$.${key}'`;
      if (value === null) {
        clauses.push(`json_type(e.metadata, ${path}) = 'null'`);
      } else if (typeof value === "boolean") {
        clauses.push(`json_type(e.metadata, ${path}) = ?`);
        params.push(value ? "true" : "false");
      } else if (typeof value === "number") {
        clauses.push(`json_type(e.metadata, ${path}) IN ('integer', 'real') AND json_extract(e.metadata, ${path}) = ?`);
        params.push(value);
      } else if (typeof value === "string") {
        clauses.push(`json_type(e.metadata, ${path}) = 'text' AND json_extract(e.metadata, ${path}) = ?`);
        params.push(value);
      } else {
        throw new TypeError(`Metadata filter "${key}" must be a string, number, boolean or null`);
      }
    }
  }
  if (filters.excludeIds?.length) {
    const l = inList("e.id", filters.excludeIds);
    clauses.push(`NOT ${l.sql}`);
    params.push(...l.params);
  }
  return { where: clauses.length ? clauses.join(" AND ") : "1", params };
}

export class EventStore {
  private readonly conn: Connection;
  private readonly prepared;

  constructor(conn: Connection) {
    this.conn = conn;
    this.prepared = {
      insert: this.conn.db.prepare(
        `INSERT INTO events (id, timestamp, observed_at, type, content, embedding, dim, norm, metadata)
         VALUES (@id, @timestamp, @observed_at, @type, @content, @embedding, @dim, @norm, @metadata)`,
      ),
        insertEntity: this.conn.db.prepare(
        `INSERT OR IGNORE INTO event_entities (event_id, entity_id, position) VALUES (?, ?, ?)`,
      ),
      get: this.conn.db.prepare(`${SELECT} WHERE e.id = ?`),
      delete: this.conn.db.prepare(`DELETE FROM events WHERE id = ?`),
    };
  }

  /** Insert one event. Returns the stored event (with generated id if none was given). */
  async insert(input: EventInput): Promise<Event> {
    const [ev] = await this.insertMany([input]);
    return ev!;
  }

  /** Insert many events in a single transaction. */
  async insertMany(inputs: EventInput[]): Promise<Event[]> {
    // Validation runs inside the transaction so an enclosing db.transaction() sees failures too.
    const rows = this.conn.transaction(() => {
      const normalized = inputs.map((input) => this.normalize(input));
      for (const { row, entities } of normalized) {
        this.prepared.insert.run(row);
        entities.forEach((entity, i) => this.prepared.insertEntity.run(row.id, entity, i));
      }
      return normalized;
    });
    return rows.map(({ row, entities, embedding }) => ({
      id: row.id,
      timestamp: row.timestamp,
      observedAt: row.observed_at,
      type: row.type,
      entities,
      content: JSON.parse(row.content),
      metadata: JSON.parse(row.metadata),
      ...(embedding ? { embedding } : {}),
    }));
  }

  private normalize(input: EventInput) {
    if (!input.type) throw new TypeError("event.type is required");
    const id = input.id === undefined ? this.conn.newId() : assertId("event.id", input.id);
    const timestamp = toMillis(input.timestamp);
    const observedAt = input.observedAt === undefined ? timestamp : toMillis(input.observedAt);
    const entities = [...new Set((input.entities ?? []).map((e) => assertEntity("event.entities[]", e)))];
    const embedding = input.embedding ? toFloat32(input.embedding) : undefined;
    if (embedding) assertFiniteEmbedding(embedding);
    const metadata = JSON.stringify(input.metadata === undefined ? {} : assertPlainObject("event.metadata", input.metadata));
    if (!this.conn.isValidJson(metadata)) throw new TypeError("event.metadata is too deeply nested for SQLite JSON");
    return {
      entities,
      embedding,
      row: {
        id,
        timestamp,
        observed_at: observedAt,
        type: input.type,
        content: JSON.stringify(input.content ?? null),
        embedding: embedding ? encodeEmbedding(embedding) : null,
        dim: embedding ? embedding.length : null,
        norm: embedding ? l2norm(embedding) : null,
        metadata,
      },
    };
  }

  async get(id: string, opts: { includeEmbedding?: boolean } = {}): Promise<Event | undefined> {
    const row = this.prepared.get.get(id) as EventRow | undefined;
    return row ? rowToEvent(row, opts.includeEmbedding ?? false) : undefined;
  }

  /** Fetch many events by id. Missing ids are omitted; order matches `ids`. */
  async getMany(ids: string[], opts: { includeEmbedding?: boolean } = {}): Promise<Event[]> {
    if (ids.length === 0) return [];
    const byId = new Map<string, Event>();
    for (const chunk of chunks(ids)) {
      const l = inList("e.id", chunk);
      const rows = this.conn.db.prepare(`${SELECT} WHERE ${l.sql}`).all(...l.params) as EventRow[];
      for (const r of rows) byId.set(r.id, rowToEvent(r, opts.includeEmbedding ?? false));
    }
    return ids.map((id) => byId.get(id)).filter((e): e is Event => e !== undefined);
  }

  async delete(id: string): Promise<boolean> {
    return this.prepared.delete.run(id).changes > 0;
  }

  /** Filtered, paginated listing ordered by (timestamp, id). */
  async list(query: EventListQuery = {}): Promise<Page<Event>> {
    const limit = assertLimit("limit", query.limit, 100, 10_000);
    // Whitelist: `order` is interpolated into SQL, so never trust the static type alone.
    const order = query.order === undefined || query.order === "asc" ? "asc" : query.order === "desc" ? "desc" : null;
    if (order === null) throw new TypeError(`Invalid order: ${String(query.order)} (expected "asc" or "desc")`);
    const { where, params } = buildWhere(query.filters);
    const cursor = decodeCursor<{ t: number; id: string }>(query.cursor);
    const cmp = order === "asc" ? ">" : "<";
    const cursorSql = cursor ? ` AND (e.timestamp ${cmp} ? OR (e.timestamp = ? AND e.id ${cmp} ?))` : "";
    const cursorParams = cursor ? [cursor.t, cursor.t, cursor.id] : [];
    const rows = this.conn.db
      .prepare(`${SELECT} WHERE ${where}${cursorSql} ORDER BY e.timestamp ${order}, e.id ${order} LIMIT ?`)
      .all(...params, ...cursorParams, limit + 1) as EventRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => rowToEvent(r, false));
    const last = items[items.length - 1];
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ t: last.timestamp, id: last.id }) } : {}),
    };
  }

  /**
   * Vector similarity search (cosine). Candidates are narrowed by `filters` in
   * SQL, then scored in-process. The query event itself is always excluded.
   */
  async similar(query: SimilarQuery): Promise<SimilarEvent[]> {
    const limit = assertLimit("limit", query.limit, 20, Number.MAX_SAFE_INTEGER);
    const { vector, selfId } = await this.resolveQueryVector(query.event);
    assertFiniteEmbedding(vector);
    const qnorm = l2norm(vector);

    const filters: EventFilters = { ...query.filters };
    if (selfId) filters.excludeIds = [...(filters.excludeIds ?? []), selfId];
    const { where, params } = buildWhere(filters);

    if (query.minScore !== undefined && !Number.isFinite(query.minScore)) {
      throw new TypeError("minScore must be a finite number");
    }
    const minScore = query.minScore ?? -Infinity;

    // Scan only what scoring needs; everything else is fetched for the few hits afterwards.
    const rows = this.conn.db
      .prepare(`SELECT e.id, e.embedding, e.norm FROM events e WHERE e.embedding IS NOT NULL AND e.dim = ? AND ${where}`)
      .iterate(vector.length, ...params) as IterableIterator<Pick<EventRow, "id" | "embedding" | "norm">>;

    // Bounded top-k: keep a descending-sorted array of at most `limit` entries.
    const top: { id: string; score: number }[] = [];
    try {
      for (const r of rows) {
        const score = cosine(vector, decodeEmbedding(r.embedding!), qnorm, r.norm ?? undefined);
        if (score < minScore) continue;
        if (top.length === limit && score <= top[top.length - 1]!.score) continue;
        let i = top.length;
        while (i > 0 && top[i - 1]!.score < score) i--;
        top.splice(i, 0, { id: r.id, score });
        if (top.length > limit) top.pop();
      }
    } finally {
      // Never leave the statement open (it would mark the connection busy).
      rows.return?.();
    }

    const hits = await this.getMany(top.map((t) => t.id));
    const byId = new Map(hits.map((h) => [h.id, h]));
    return top.map(({ id, score }) => {
      const e = byId.get(id)!;
      return {
        id,
        score,
        timestamp: e.timestamp,
        observedAt: e.observedAt,
        type: e.type,
        entities: e.entities,
        metadata: e.metadata,
      };
    });
  }

  private async resolveQueryVector(
    event: SimilarQuery["event"],
  ): Promise<{ vector: Float32Array; selfId?: string }> {
    if (typeof event === "string") {
      const stored = await this.get(event, { includeEmbedding: true });
      if (!stored) throw new Error(`Event not found: ${event}`);
      if (!stored.embedding) throw new Error(`Event ${event} has no embedding`);
      return { vector: stored.embedding, selfId: stored.id };
    }
    if (Array.isArray(event) || event instanceof Float32Array) {
      return { vector: toFloat32(event) };
    }
    if (event.embedding) {
      return { vector: toFloat32(event.embedding), ...(event.id ? { selfId: event.id } : {}) };
    }
    if (event.id) return this.resolveQueryVector(event.id);
    throw new TypeError("similar(): `event` must be an id, an embedding, or an object with an embedding");
  }
}

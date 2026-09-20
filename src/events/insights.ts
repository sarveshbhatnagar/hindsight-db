import { toMillis } from "../time.js";
import type {
  EntityStats,
  EntityStatsQuery,
  Event,
  EventFilters,
  EventListQuery,
  Page,
  SimilarEvent,
  SimilarQuery,
  SimilarResults,
  TypeStats,
} from "../types.js";
import { assertLimit } from "../validate.js";
import type { Embedding } from "../vector.js";
import type { EventProvider, GetManyOptions } from "./provider.js";

// ---------------------------------------------------------------------------
// The slice of insights-db this adapter uses: the `events` read API of an
// `Insights` handle (`openInsights(...)`). It is declared here structurally so
// that this file — and so hindsight-db — typechecks and loads with insights-db
// absent; a real handle satisfies it as is.
// ---------------------------------------------------------------------------

export interface InsightsClaim {
  claimId: string;
  text: string;
  assertedAt: Date;
  kind: "fact" | "speculation";
  disputedWith: string[];
  verdict: "refuted" | "unsupported" | null;
  evidenceUrl: string | null;
  supersededBy: string | null;
  hidden: boolean;
}

export interface InsightsEventEntity {
  id: string;
  name: string;
  type: string;
  role: string;
}

export interface InsightsEventRecord {
  id: string;
  /** Calendar day, YYYY-MM-DD; read as 00:00 UTC. */
  occurredAt: string;
  observedAt: Date;
  eventType: string;
  title: string;
  pattern: string;
  storylineId: string | null;
  entities: InsightsEventEntity[];
  claims: InsightsClaim[];
}

export interface InsightsEventFilters {
  eventType?: string | string[] | undefined;
  entityIds?: string[] | undefined;
  from?: Date | string | undefined;
  to?: Date | string | undefined;
  asOf?: Date | string | undefined;
  excludeIds?: string[] | undefined;
}

export type InsightsVector = "pattern" | "content";

export interface InsightsEventsApi {
  getMany(ids: string[], opts?: { asOf?: Date | string | undefined }): Promise<InsightsEventRecord[]>;
  list(
    query?: InsightsEventFilters & { limit?: number | undefined; cursor?: string | undefined; order?: "asc" | "desc" | undefined },
  ): Promise<{ items: InsightsEventRecord[]; nextCursor?: string | undefined }>;
  similar(
    query: { eventId?: string | undefined; embedding?: number[] | undefined; k?: number | undefined; minScore?: number | undefined; filters?: InsightsEventFilters | undefined },
    vector?: InsightsVector,
  ): Promise<(InsightsEventRecord & { score: number })[]>;
  types(): Promise<{ eventType: string; count: number; from: string; to: string }[]>;
  entities(query?: {
    eventType?: string | string[] | undefined;
    from?: Date | string | undefined;
    to?: Date | string | undefined;
    limit?: number | undefined;
  }): Promise<{ id: string; name: string; type: string; count: number; from: string; to: string }[]>;
}

/** What `openInsights()` returns, as far as this adapter is concerned. */
export interface InsightsHandle {
  events: InsightsEventsApi;
  /** Closes the connection pool; present on a real handle. */
  end?(): Promise<void>;
}

export interface InsightsEventProviderOptions {
  /**
   * Which embedding `similar` ranks by. `pattern` (default) is written once
   * when the event is created and never changes, so a backtest sees the same
   * neighbours at any later date; `content` follows the claims as they merge
   * and reflects everything known today.
   */
  vector?: InsightsVector;
}

/** Options for `InsightsEventProvider.open`: passed to insights-db's `openInsights`. */
export interface InsightsOpenOptions extends InsightsEventProviderOptions {
  /** Postgres connection string. Defaults to `DATABASE_URL`. */
  connectionString?: string;
  /** An existing `pg.Pool` to share instead. */
  pool?: unknown;
}

/** An event's claims as stored in `content`; `assertedAt` in epoch ms like every other clock. */
export type InsightsContentClaim = {
  claimId: string;
  text: string;
  assertedAt: number;
  kind: "fact" | "speculation";
  disputedWith: string[];
  verdict: "refuted" | "unsupported" | null;
  evidenceUrl: string | null;
  supersededBy: string | null;
  hidden: boolean;
};

const DAY = 86_400_000;
const NUMERIC_ID = /^\d+$/;

/** A YYYY-MM-DD day as 00:00 UTC in epoch ms. */
function dayToMillis(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new TypeError(`insights-db returned an unexpected date: "${day}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function toRecordEvent(r: InsightsEventRecord): Event {
  return {
    id: r.id,
    timestamp: dayToMillis(r.occurredAt),
    observedAt: r.observedAt.getTime(),
    type: r.eventType,
    entities: r.entities.map((n) => n.id),
    content: {
      title: r.title,
      claims: r.claims.map(
        (c): InsightsContentClaim => ({
          claimId: c.claimId,
          text: c.text,
          assertedAt: c.assertedAt.getTime(),
          kind: c.kind,
          disputedWith: c.disputedWith,
          verdict: c.verdict,
          evidenceUrl: c.evidenceUrl,
          supersededBy: c.supersededBy,
          hidden: c.hidden,
        }),
      ),
    },
    metadata: {
      storylineId: r.storylineId,
      pattern: r.pattern,
      entityNames: r.entities.map((n) => ({ id: n.id, name: n.name, type: n.type, role: n.role })),
    },
  };
}

const asList = (v: string | string[] | undefined): string[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

function assertEntityIds(field: string, ids: string[]): string[] {
  for (const id of ids) {
    if (!NUMERIC_ID.test(id)) {
      throw new TypeError(`${field}: insights-db entity ids are numeric, got "${id}" (aliases map the other way: from insights ids to timeline labels)`);
    }
  }
  return ids;
}

/**
 * hindsight `EventFilters` → insights filters. Everything insights cannot
 * express throws, so a caller never gets a silently wider result.
 */
export function translateFilters(filters: EventFilters | undefined): InsightsEventFilters {
  if (!filters) return {};
  const out: InsightsEventFilters = {};
  const types = asList(filters.type);
  if (types !== undefined) out.eventType = types;

  const any = asList(filters.entities);
  const all = asList(filters.entitiesAll);
  if (all !== undefined && all.length > 0) {
    // insights only has any-of; all-of collapses to it for a single id, which
    // is also the only case where combining both keeps their meaning.
    const distinct = [...new Set(all)];
    if (distinct.length > 1 || (any !== undefined && any.length > 0)) {
      throw new TypeError("entitiesAll: insights-db filters events by any of the given entities, not all; pass one id, or use `entities`");
    }
    out.entityIds = assertEntityIds("entitiesAll", distinct);
  } else if (any !== undefined) {
    out.entityIds = assertEntityIds("entities", any);
  }

  // occurredAt is a calendar day (00:00 UTC), so an event-time bound is
  // rounded to the days it can actually cut: `from` up, `to` down.
  if (filters.from !== undefined) out.from = new Date(Math.ceil(toMillis(filters.from) / DAY) * DAY);
  if (filters.to !== undefined) out.to = new Date(Math.floor(toMillis(filters.to) / DAY) * DAY);
  if (filters.asOf !== undefined) out.asOf = new Date(toMillis(filters.asOf));
  if (filters.metadata) {
    const keys = Object.keys(filters.metadata);
    if (keys.length > 0) {
      throw new TypeError(
        `metadata filter on ${keys.map((k) => `"${k}"`).join(", ")}: insights-db's read API has no metadata filters; filter by type, entities, from/to or asOf instead`,
      );
    }
  }
  if (filters.excludeIds !== undefined) {
    // A non-numeric id cannot be an insights event, so excluding it changes nothing.
    out.excludeIds = filters.excludeIds.filter((id) => NUMERIC_ID.test(id));
  }
  return out;
}

/**
 * `EventProvider` over an insights-db database, so `openDatabase({ events })`
 * can keep timeline, decisions and outcomes in SQLite around events that
 * insights ingests and deduplicates. Uses only the insights read API
 * (`handle.events.*`), never SQL of its own.
 *
 * Mapping: `occurredAt` (a day) → `timestamp` at 00:00 UTC; `observedAt` as
 * is; `eventType` → `type`; the entities' insights ids → `entities` (map them
 * to timeline labels with `db.aliases`); `{ title, claims }` → `content`;
 * `{ storylineId, pattern, entityNames }` → `metadata`.
 *
 * ```ts
 * import { openInsights } from "insights-db";
 * const db = openDatabase({ path: "context.db", events: new InsightsEventProvider(openInsights()) });
 * ```
 */
export class InsightsEventProvider implements EventProvider {
  /** insights keeps adding claims to an event after it is first observed; `getMany({ asOf })` returns it as it stood then. */
  readonly pointInTime = true;
  readonly insights: InsightsHandle;
  private readonly vector: InsightsVector;

  constructor(insights: InsightsHandle, options: InsightsEventProviderOptions = {}) {
    this.insights = insights;
    this.vector = options.vector ?? "pattern";
  }

  /**
   * Open an insights-db connection and wrap it. insights-db is an optional
   * peer dependency, imported here on first use only, so a SQLite-only
   * install never loads it (nor Postgres, nor its LLM client).
   */
  static async open(options: InsightsOpenOptions = {}): Promise<InsightsEventProvider> {
    const { vector, ...connection } = options;
    const modName: string = "insights-db"; // not a literal, so neither tsc nor a bundler resolves it eagerly
    let mod: { openInsights: (opts: InsightsOpenOptions) => InsightsHandle };
    try {
      mod = await import(modName);
    } catch (err) {
      throw new Error(`InsightsEventProvider.open() needs the optional peer dependency insights-db: npm install insights-db`, { cause: err });
    }
    return new InsightsEventProvider(mod.openInsights(connection), vector === undefined ? {} : { vector });
  }

  async get(id: string): Promise<Event | undefined> {
    const [event] = await this.getMany([id]);
    return event;
  }

  /**
   * Fetch many events by id, in the order asked. Ids insights does not know
   * (including any that are not numeric) are omitted. With `asOf`, only
   * events observed by then, each with the claims asserted by then.
   * `includeEmbedding` is not supported: insights does not hand out its vectors.
   */
  async getMany(ids: string[], opts: GetManyOptions = {}): Promise<Event[]> {
    const numeric = ids.filter((id) => NUMERIC_ID.test(id));
    if (numeric.length === 0) return [];
    const records = await this.insights.events.getMany(numeric, opts.asOf === undefined ? {} : { asOf: new Date(toMillis(opts.asOf)) });
    return records.map(toRecordEvent);
  }

  async list(query: EventListQuery = {}): Promise<Page<Event>> {
    const page = await this.insights.events.list({
      ...translateFilters(query.filters),
      limit: assertLimit("limit", query.limit, 100, 10_000),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    });
    return {
      items: page.items.map(toRecordEvent),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * Nearest events by the configured embedding (see `vector`). `event` may be
   * an insights event id or an embedding of that vector's kind. insights ranks
   * in one pass, so `cursor` is not supported.
   */
  async similar(query: SimilarQuery): Promise<SimilarResults> {
    if (query.cursor !== undefined) throw new TypeError("similar(): insights-db does not page similarity results; raise `limit` instead");
    const filters = translateFilters(query.filters);
    const target = resolveTarget(query.event);
    if (target.selfId !== undefined) {
      if (target.embedding !== undefined) filters.excludeIds = [...(filters.excludeIds ?? []), target.selfId];
      else if (!NUMERIC_ID.test(target.selfId)) throw new Error(`Event not found: ${target.selfId}`);
    }
    const hits = await this.insights.events.similar(
      {
        ...(target.embedding !== undefined ? { embedding: target.embedding } : { eventId: target.selfId }),
        k: assertLimit("limit", query.limit, 20, 10_000),
        ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
        filters,
      },
      this.vector,
    );
    const results: SimilarEvent[] = hits.map((h) => ({ ...toRecordEvent(h), score: h.score }));
    return results;
  }

  /** insights' entity catalog, keyed by entity id like the events' `entities`. `prefix` is not supported (ids are numeric). */
  async entities(query: EntityStatsQuery = {}): Promise<EntityStats[]> {
    if (query.prefix !== undefined) throw new TypeError("entities(): insights-db entity ids are numeric; `prefix` has nothing to match");
    const types = asList(query.type);
    const rows = await this.insights.events.entities({
      ...(types !== undefined ? { eventType: types } : {}),
      ...(query.from !== undefined ? { from: new Date(Math.ceil(toMillis(query.from) / DAY) * DAY) } : {}),
      ...(query.to !== undefined ? { to: new Date(Math.floor(toMillis(query.to) / DAY) * DAY) } : {}),
      limit: assertLimit("limit", query.limit, 1000, 100_000),
    });
    return rows.map((r) => ({ entity: r.id, count: r.count, firstSeen: dayToMillis(r.from), lastSeen: dayToMillis(r.to) }));
  }

  async types(): Promise<TypeStats[]> {
    const rows = await this.insights.events.types();
    return rows.map((r) => ({ type: r.eventType, count: r.count, firstSeen: dayToMillis(r.from), lastSeen: dayToMillis(r.to) }));
  }
}

const toNumbers = (v: Embedding): number[] => (Array.isArray(v) ? v : Array.from(v));

function resolveTarget(event: SimilarQuery["event"]): { selfId?: string; embedding?: number[] } {
  if (typeof event === "string") return { selfId: event };
  if (Array.isArray(event) || event instanceof Float32Array) return { embedding: toNumbers(event) };
  if (event.embedding) return { embedding: toNumbers(event.embedding), ...(event.id !== undefined ? { selfId: event.id } : {}) };
  if (event.id) return { selfId: event.id };
  throw new TypeError("similar(): `event` must be an id, an embedding, or an object with an embedding");
}

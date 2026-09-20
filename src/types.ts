import type { EventProvider } from "./events/provider.js";
import type { DurationInput, TimestampInput } from "./time.js";
import type { Embedding } from "./vector.js";

export type { DurationInput, TimestampInput, Embedding };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Metadata = Record<string, Json>;

// ---------------------------------------------------------------------------
// Time boundary
//
//   timestamp   Event time    — when the underlying thing happened
//   observedAt  Observation   — when the information became available to us
//   (outcomes)  Outcome time  — when the result became observable
//
// Every record carries both `timestamp` and `observedAt` (defaulting to the
// same value) so that history queries can be cut at a point in observation
// time without leaking future information into pre-decision context.
// ---------------------------------------------------------------------------

// Events -------------------------------------------------------------------

export interface EventInput {
  /** Stable id. Generated if omitted. */
  id?: string;
  /** Event time. */
  timestamp: TimestampInput;
  /** Observation time. Defaults to `timestamp`. */
  observedAt?: TimestampInput;
  type: string;
  /** Entities this event concerns, e.g. tickers, people, instruments. Non-empty strings; order is preserved. */
  entities?: string[];
  /** Free-form content (text, or any JSON). */
  content?: Json;
  embedding?: Embedding;
  metadata?: Metadata;
}

export interface Event {
  id: string;
  timestamp: number;
  observedAt: number;
  type: string;
  entities: string[];
  content: Json;
  /** Present only when requested via `includeEmbedding`. */
  embedding?: Float32Array;
  metadata: Metadata;
}

export interface EventFilters {
  /** Match any of these types. */
  type?: string | string[];
  /** Match events touching any of these entities. */
  entities?: string | string[];
  /** Match only events touching all of these entities. Combines with `entities`. */
  entitiesAll?: string | string[];
  /** Event-time bounds (inclusive). */
  from?: TimestampInput;
  to?: TimestampInput;
  /** Only events whose `observedAt` <= asOf. Use for point-in-time / backtest safety. */
  asOf?: TimestampInput;
  /** Top-level metadata equality, e.g. { sector: "tech" }. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Exclude these ids (the query event itself is always excluded). */
  excludeIds?: string[];
}

export interface SimilarQuery {
  /** An event id, an event with an embedding, or a bare embedding vector. */
  event: string | { id?: string; embedding?: Embedding } | Embedding;
  limit?: number;
  /** Discard results below this cosine similarity. */
  minScore?: number;
  filters?: EventFilters;
  /** Opaque cursor from a previous result's `nextCursor` to fetch the next page of matches. */
  cursor?: string;
}

/** Ranked matches; `nextCursor` is set when more matches exist beyond `limit`. */
export type SimilarResults = SimilarEvent[] & { nextCursor?: string };

export interface SimilarEvent {
  id: string;
  score: number;
  timestamp: number;
  observedAt: number;
  type: string;
  entities: string[];
  content: Json;
  metadata: Metadata;
}

/** Catalog queries: what labels exist, how often, and over what period. */
export interface EntityStatsQuery {
  /** Only count events of these types. */
  type?: string | string[];
  /** Only count events in this event-time range. */
  from?: TimestampInput;
  to?: TimestampInput;
  /** Case-sensitive prefix on the entity id, e.g. "sector:". */
  prefix?: string;
  /** Max rows, ordered by count descending. Default 1000. */
  limit?: number;
}

export interface EntityStats {
  entity: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface TypeStats {
  type: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface TimelineEntityStatsQuery {
  namespace?: string | string[];
  prefix?: string;
  limit?: number;
}

export interface TimelineEntityStats {
  entity: string;
  count: number;
  namespaces: string[];
  from: number;
  to: number;
}

export interface NamespaceStats {
  namespace: string;
  count: number;
  entities: number;
  from: number;
  to: number;
}

export interface EventListQuery {
  filters?: EventFilters;
  limit?: number;
  /** Opaque cursor from a previous page. */
  cursor?: string;
  order?: "asc" | "desc";
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to fetch the next page; undefined when exhausted. */
  nextCursor?: string;
}

// Timeline -----------------------------------------------------------------

export interface TimelinePointInput {
  timestamp: TimestampInput;
  /** Observation time. Defaults to `timestamp`. */
  observedAt?: TimestampInput;
  entity: string;
  /** Stream name: "market", "news", "macro", "signals", "positions", or anything custom. */
  namespace: string;
  data: Json;
}

export interface TimelinePoint {
  id: number;
  timestamp: number;
  observedAt: number;
  entity: string;
  namespace: string;
  data: Json;
}

export interface TimelineRangeQuery {
  entity?: string | string[];
  namespace?: string | string[];
  /** Event-time bounds (inclusive). */
  from: TimestampInput;
  to: TimestampInput;
  /** Only points whose `observedAt` <= asOf. */
  asOf?: TimestampInput;
  limit?: number;
  cursor?: string;
}

export interface TimelineAroundQuery {
  eventId: string;
  before?: DurationInput;
  after?: DurationInput;
  /** Restrict to these entities. Defaults to the event's entities (all if the event has none). */
  entities?: string | string[];
  namespace?: string | string[];
  asOf?: TimestampInput;
}

/** Timeline points grouped by namespace, each sorted ascending by timestamp. */
export type TimelineStreams = Record<string, TimelinePoint[]>;

// Decisions ----------------------------------------------------------------

export interface DecisionInput {
  id?: string;
  eventId: string;
  timestamp: TimestampInput;
  action: Json;
  metadata?: Metadata;
}

export interface Decision {
  id: string;
  eventId: string;
  timestamp: number;
  action: Json;
  metadata: Metadata;
}

// Outcomes -----------------------------------------------------------------

export interface OutcomeInput {
  id?: string;
  eventId: string;
  decisionId?: string;
  /** Outcome time — when the result became observable. Defaults to decision/event timestamp + horizon. */
  timestamp?: TimestampInput;
  /** Horizon after the decision (or event) at which this outcome was measured, e.g. "1d". Non-negative. */
  horizon: DurationInput;
  result: Json;
  metadata?: Metadata;
}

export interface Outcome {
  id: string;
  eventId: string;
  decisionId: string | null;
  timestamp: number;
  horizon: string;
  horizonMs: number;
  result: Json;
  metadata: Metadata;
}

// History ------------------------------------------------------------------

export interface HistoryQuery {
  eventId: string;
  /** Timeline window before the event. Default "7d". */
  before?: DurationInput;
  /** Timeline window after the event. Default: 0, extended to cover `outcomeUntil` when that is later. */
  after?: DurationInput;
  /**
   * Observation-time cutoff for `context`. Nothing observed after this is
   * included in `context`. Defaults to the event's `observedAt`.
   */
  contextUntil?: TimestampInput;
  /**
   * Observation-time cutoff for `outcomes` and post-event `timeline`.
   * Defaults to event.timestamp + after.
   */
  outcomeUntil?: TimestampInput;
  entities?: string | string[];
  namespace?: string | string[];
  /**
   * Cap on timeline points fetched per event (across all streams), in
   * (timestamp, id) order. Default 100 000. When the window holds more, the
   * result carries `truncated` with a ready-made `timeline.range` query for
   * the remainder.
   */
  maxPoints?: number;
}

export interface History {
  event: Event;
  /** Timeline streams known at `contextUntil` — safe pre-decision context. */
  context: TimelineStreams;
  /** Full timeline window [event - before, event + after], cut at `outcomeUntil`. */
  timeline: TimelineStreams;
  decisions: Decision[];
  outcomes: Outcome[];
  window: { from: number; to: number; contextUntil: number; outcomeUntil: number };
  /**
   * Present when the window held more than `maxPoints` timeline points.
   * `context` and `timeline` contain every point up to and including
   * (timestamp, id) = `at`; pass `next` to `timeline.range` for the rest
   * (filter its items by `observedAt <= window.contextUntil` for context).
   */
  truncated?: { at: { timestamp: number; id: number }; next: TimelineRangeQuery };
}

export interface HistoryManyQuery extends Omit<HistoryQuery, "eventId"> {
  eventIds: string[];
}

export interface DatabaseOptions<E extends EventProvider = EventProvider> {
  /** Path to the SQLite file. Defaults to ":memory:". */
  path?: string;
  /**
   * External event source. When given, `db.events` is this provider and the
   * SQLite file holds only the context (timeline, decisions, outcomes).
   * Omit to store events in the file too (the default `SqliteEventStore`).
   */
  events?: E;
  /** Generate ids for records inserted without one. Defaults to time-ordered UUID v7. */
  idGenerator?: () => string;
  /** SQLite page cache in MiB (default: SQLite's ~2 MiB). Larger values speed up scans and paging at the cost of RAM. */
  cacheSizeMb?: number;
}

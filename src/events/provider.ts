import type {
  EntityStats,
  EntityStatsQuery,
  Event,
  EventListQuery,
  Page,
  SimilarQuery,
  SimilarResults,
  TimestampInput,
  TypeStats,
} from "../types.js";

export interface GetManyOptions {
  includeEmbedding?: boolean;
  /**
   * Observation-time cutoff: return each event as it stood then, and omit
   * events not yet observed. Only meaningful for providers whose events
   * change after they are first seen (`pointInTime`); the SQLite store's
   * events are immutable, so it ignores it.
   */
  asOf?: TimestampInput;
}

/**
 * The read side of an event source. Everything else in hindsight-db —
 * timeline windows, decisions, outcomes, history — only needs this to locate
 * an event in time and know which entities it concerns, so an external system
 * that owns the events (e.g. insights-db) can be plugged in via
 * `openDatabase({ events })` while the context stays in SQLite.
 *
 * Implementations must return `Event`s with `timestamp`/`observedAt` in epoch
 * ms and honour the `EventFilters` they can; unsupported filters should throw
 * rather than be silently ignored. Writes are not part of the contract: the
 * default `SqliteEventStore` has them, an external provider need not.
 */
export interface EventProvider {
  /**
   * Set when `getMany({ asOf })` returns events as they stood at that
   * observation time — content included — because the source keeps adding to
   * an event after it is first observed. `history` then fetches each event
   * at its `contextUntil`, so nothing learned later shows in `event.content`.
   * Leave unset when events never change after insertion.
   */
  readonly pointInTime?: boolean;
  get(id: string, opts?: { includeEmbedding?: boolean }): Promise<Event | undefined>;
  /** Fetch many events by id. Missing ids are omitted; order matches `ids`. */
  getMany(ids: string[], opts?: GetManyOptions): Promise<Event[]>;
  /** Filtered, paginated listing ordered by (timestamp, id). */
  list(query?: EventListQuery): Promise<Page<Event>>;
  /** Similarity search; the query event itself is always excluded. */
  similar(query: SimilarQuery): Promise<SimilarResults>;
  /** Entities in use, with counts and event-time span, most frequent first. */
  entities(query?: EntityStatsQuery): Promise<EntityStats[]>;
  /** Event types in use, with counts and event-time span, most frequent first. */
  types(): Promise<TypeStats[]>;
}

import type {
  EntityStats,
  EntityStatsQuery,
  Event,
  EventListQuery,
  Page,
  SimilarQuery,
  SimilarResults,
  TypeStats,
} from "../types.js";

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
  get(id: string, opts?: { includeEmbedding?: boolean }): Promise<Event | undefined>;
  /** Fetch many events by id. Missing ids are omitted; order matches `ids`. */
  getMany(ids: string[], opts?: { includeEmbedding?: boolean }): Promise<Event[]>;
  /** Filtered, paginated listing ordered by (timestamp, id). */
  list(query?: EventListQuery): Promise<Page<Event>>;
  /** Similarity search; the query event itself is always excluded. */
  similar(query: SimilarQuery): Promise<SimilarResults>;
  /** Entities in use, with counts and event-time span, most frequent first. */
  entities(query?: EntityStatsQuery): Promise<EntityStats[]>;
  /** Event types in use, with counts and event-time span, most frequent first. */
  types(): Promise<TypeStats[]>;
}

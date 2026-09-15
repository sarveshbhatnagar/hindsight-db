# hindsight-db

Embedded database for looking back at historical events the way a decision-maker saw them at the time — and what happened next. It stores multiple related views of historical data:

```
Event
├── Context at event time
├── Action / Decision
├── Timeline before and after the event
└── Observed Outcome
```

Applications use it to find similar historical events, reconstruct the timeline around them, and look up what was decided and what happened next — without leaking future information into pre-decision context. Reasoning and decision-making stay in the application layer. See [`design.md`](./design.md) for the full design.

## Install

```sh
npm install        # better-sqlite3 (embedded storage)
npm test           # vitest
npm run build      # emits dist/
```

Requires Node 18+.

## Quick start

```ts
import { openDatabase } from "hindsight-db";

const db = openDatabase({ path: "history.db" }); // omit path for in-memory

// 1. Events: discrete things that happened, with optional embeddings.
const event = await db.events.insert({
  timestamp: "2024-03-01T21:30:00Z",
  type: "earnings",
  entities: ["AAPL"],
  content: "AAPL beats on revenue",
  embedding: [/* ... */],
  metadata: { surprise: 0.12 },
});

// 2. Timeline: any timestamped data, keyed by entity + namespace.
await db.timeline.insert({
  timestamp: "2024-02-28T21:00:00Z",
  entity: "AAPL",
  namespace: "market",
  data: { close: 180.1 },
});

// 3. Decisions and (later) outcomes, linked to the event.
const decision = await db.decisions.insert({
  eventId: event.id,
  timestamp: "2024-03-01T22:00:00Z",
  action: { side: "buy", qty: 100 },
});
await db.outcomes.insert({
  eventId: event.id,
  decisionId: decision.id,
  horizon: "5d",
  result: { return: 0.031 },
});

// 4. Retrieval: similar events → parallel history reconstruction.
const candidates = await db.events.similar({
  event: { embedding: currentEmbedding },
  limit: 20,
  filters: { type: "earnings", asOf: now },
});

const histories = await db.history.getMany({
  eventIds: candidates.map((c) => c.id),
  before: "14d",
  after: "5d",
});
// histories[i] = { event, context, timeline, decisions, outcomes, window }
```

## API

All methods return promises. Timestamps accept epoch ms, ISO strings or `Date`s and are returned as epoch ms. Durations accept ms or strings like `"7d"`, `"12h"`, `"30m"`, `"45s"`, `"500ms"`, `"2w"`.

### `db.events`

| Method | Description |
| --- | --- |
| `insert(event)` / `insertMany(events)` | Store events. `id` is generated if omitted. `observedAt` defaults to `timestamp`. |
| `get(id, { includeEmbedding? })` / `getMany(ids)` | Fetch by id. |
| `list({ filters?, limit?, cursor?, order? })` | Filtered, cursor-paginated listing. |
| `similar({ event, limit?, minScore?, filters? })` | Cosine similarity search. `event` may be an id, an embedding, or `{ id?, embedding? }`. The query event is always excluded. |
| `delete(id)` | Delete an event and its decisions/outcomes. |
| `addEntities(id, entities)` / `removeEntities(id, entities)` | Re-label an existing event. Adds append in order and ignore duplicates; removes ignore absent ones. |
| `renameEntity(from, to)` | Rename a label across all events (merges with events that already carry `to`). |
| `entities({ type?, from?, to?, prefix?, limit? })` | Catalog: entities in use with counts and event-time span, most frequent first. |
| `types()` | Catalog: event types with counts and span. |

Filters: `type`, `entities` (any-of), `entitiesAll` (all-of), `from`/`to` (event time), `asOf` (observation time — only events known at that point), `metadata` (top-level equality), `excludeIds`.

Events can carry any number of entities. Entities are the indexed, filterable labels — tickers, people, and also tags such as `sector:tech` or `theme:ai`; a prefix convention keeps them discoverable via `entities({ prefix: "sector:" })`. `metadata` is for scalar attributes you filter by equality, not for set membership.

### `db.timeline`

| Method | Description |
| --- | --- |
| `insert(point)` / `insertMany(points)` | Store timestamped data under an `entity` and `namespace` (`market`, `news`, `macro`, `signals`, `positions`, or anything custom). |
| `range({ entity?, namespace?, from, to, asOf?, limit?, cursor? })` | Points in an absolute window, ascending, paginated. |
| `around({ eventId, before?, after?, entities?, namespace?, asOf? })` | All streams in a window around an event, grouped by namespace. Defaults to the event's entities. |
| `entities({ namespace?, prefix?, limit? })` | Catalog: entities with timeline data, point counts, namespaces and span. |
| `namespaces()` | Catalog: streams in use with point counts, distinct entities and span. |

### `db.decisions` / `db.outcomes`

| Method | Description |
| --- | --- |
| `decisions.insert({ eventId, timestamp, action, metadata? })` | Record an action taken in response to an event. |
| `decisions.forEvent(eventId, { until? })` | Decisions for an event, ascending. |
| `outcomes.insert({ eventId, decisionId?, horizon, result, timestamp? })` | Attach an observed result. Outcome time defaults to the decision's (or event's) timestamp + `horizon`. |
| `outcomes.forEvent(eventId, { until? })` | Outcomes for an event, ascending by outcome time. |

### `db.history`

```ts
const h = await db.history.get({
  eventId,
  before: "7d",          // window before event time (default "7d")
  after: "5d",           // window after event time (default: 0, or far enough to cover outcomeUntil)
  contextUntil?: ...,    // observation-time cutoff for `context` (default: event.observedAt)
  outcomeUntil?: ...,    // observation-time cutoff for `timeline`/`decisions`/`outcomes` (default: max(event.timestamp + after, contextUntil))
  entities?: ...,        // default: the event's entities
  namespace?: ...,
});
```

Returns:

| Field | Contents |
| --- | --- |
| `event` | The event. |
| `context` | Timeline streams **observed at or before `contextUntil`** — safe pre-decision context. |
| `timeline` | Full window `[event − before, event + after]`, cut at `outcomeUntil`. |
| `decisions` | Decisions with `timestamp ≤ outcomeUntil`. |
| `outcomes` | Outcomes with outcome time `≤ outcomeUntil`. |
| `window` | The resolved `{ from, to, contextUntil, outcomeUntil }` in ms. |

`history.getMany({ eventIds, ...sameOptions })` returns one `History` per found id, in input order, with all lookups batched into a single read transaction.

## Time semantics

Every record distinguishes three clocks, as required by the design:

| Clock | Field | Meaning |
| --- | --- | --- |
| Event time | `timestamp` | When the underlying thing happened. |
| Observation time | `observedAt` | When the information became available. Defaults to `timestamp`. |
| Outcome time | `outcomes[].timestamp` | When the result became observable. Defaults to anchor + `horizon`. |

Window bounds (`before`/`after`, `from`/`to`) apply to **event time**. Cutoffs (`asOf`, `contextUntil`, `outcomeUntil`) apply to **observation time**. When `after` is omitted, the event-time window automatically extends to cover `outcomeUntil`, so the design's `{ contextUntil: decision.timestamp, outcomeUntil: decision.timestamp + 5d }` form works on its own. `contextUntil` may never exceed `outcomeUntil` — the outcome view always knows at least as much as the context view — and `history.get` throws if explicit cutoffs violate that. A revised data point with `timestamp = T−1d` but `observedAt = T+1d` is therefore inside a `before: "7d"` window but excluded from `context` — that is the point.

## Implementation notes

- **Storage**: a single SQLite file via `better-sqlite3` (WAL mode, foreign keys on, cascading deletes from events). All stores share one connection.
- **Vector search**: embeddings are stored as Float32 blobs (native byte order) with a precomputed L2 norm; non-finite components are rejected at insert and query time. `similar()` narrows candidates with SQL filters, then scores cosine similarity in-process with a bounded top-k. This is exact, not approximate — fine up to roughly 10⁵ events per query; swap in an ANN index behind the same interface when that stops being true.
- **Parallelism**: SQLite is synchronous and single-writer, so "parallel" retrieval is implemented as *batched* retrieval — `history.getMany` runs one query for events, one for decisions, one for outcomes, and all timeline windows inside one read transaction. The API is promise-based throughout so a networked backend (e.g. Postgres + pgvector) can be dropped in without changing callers.
- **Pagination**: `events.list` and `timeline.range` use opaque keyset cursors on `(timestamp, id)`.
- **List sizes**: id lookups (`events.getMany`, `history.getMany`) are chunked internally, so any number of ids is fine. Filter lists (`entities`, `type`, `excludeIds`) are capped at 5000 values per query and fail with a clear error beyond that.
- **Transactions**: `insertMany` on every store is atomic. `db.transaction(fn)` wraps several writes all-or-nothing: `fn` must be synchronous (store methods execute their SQL before their first `await`, so calling several inside `fn` works), and if any of them fails, the outer transaction rolls back and rethrows that error.
- **Validation**: ids, entities and namespaces must be non-empty strings (entities may not contain U+001F); `metadata` must be a plain object shallow enough for SQLite's JSON parser; embeddings must be non-empty and finite; `limit` must be a positive integer; `horizon` must be non-negative. Metadata filters are type-strict (`1`, `"1"` and `true` are distinct).

## Performance

`npm run build && node bench/scale.ts` runs the scale benchmark (env knobs: `N_EVENTS`, `N_ENTITIES`, `N_DAYS`, `RUNS`). On an M2 Pro with 100k events (128-dim, 3 entities each):

| Operation | Time |
| --- | --- |
| `events.similar`, no filter, 100k candidates | ~115 ms |
| `events.similar`, type filter (10%) | ~35 ms |
| `events.similar`, one entity | ~50 ms |
| `events.similar`, 1000 candidates at 1536-dim | ~5 ms |
| `history.getMany` (≈420 timeline points/event) | ~0.5–1 ms/event |
| `timeline.range` paging | ~1.5–3 ms per 1000 points |
| Ingest | events ~14k/s, timeline ~65k/s (2M rows), decisions ~70k/s |

`similar()` scans only `(id, embedding, norm)` and hydrates the top-k afterwards; cost is roughly 1 µs/row plus ~4 ns/dim/row **over the candidates that survive the SQL filters**, so selective filters are the main lever:

| `similar()` on 100k events, 128-dim | Candidates | Time |
| --- | --- | --- |
| no filter | 100k | ~80 ms |
| entity carried by 10% of events | 10k | ~14 ms |
| entity carried by 1% | 1k | ~1.4 ms |
| entity carried by 0.1% | 100 | ~0.3 ms |
| 1% event-time window | 1k | ~1 ms |

A filter on an entity that nearly every event carries (e.g. a catch-all tag) is *slower* than no filter, since it adds a join without pruning anything. Use `events.entities()` to check a label's count before relying on it. For a much larger event table with unfiltered queries, an ANN index is the next step.

Known follow-ups, measured but not implemented: bulk-load mode that drops/rebuilds timeline indexes (≈4.6× faster ingest of 2M rows); a `timeline(entity, timestamp)` index or per-namespace range queries for history windows (≈2× on `getMany` with many namespaces); batching `events.list`'s entity lookup (≈20%/page); batch-resolving outcome anchors in `outcomes.insertMany` (≈1.5×). Pass `cacheSizeMb` to `openDatabase` for a larger page cache (≈20% on paging).

## Layout

```
src/
  index.ts            openDatabase(), HindsightDB, public exports
  types.ts            input/output types
  time.ts             duration + timestamp parsing
  vector.ts           embedding encoding, cosine
  storage/sqlite.ts   schema + connection helpers
  stores/             events, timeline, decisions, outcomes, history
tests/                vitest, one file per store + end-to-end flow
```

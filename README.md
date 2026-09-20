# hindsight-db

[![CI](https://github.com/sarveshbhatnagar/hindsight-db/actions/workflows/ci.yml/badge.svg)](https://github.com/sarveshbhatnagar/hindsight-db/actions/workflows/ci.yml)

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
npm install pg     # optional: Postgres backend for the context stores
npm test           # vitest
npm run build      # emits dist/
```

Requires Node 22+.

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

All methods return promises. Timestamps accept epoch ms, ISO strings or `Date`s and are returned as epoch ms. Durations accept ms or strings like `"7d"`, `"12h"`, `"30m"`, `"45s"`, `"500ms"`, `"2w"`. `addDuration(ts, "-7d")` shifts a timestamp; `parseDuration` and `windowAround` are exported too.

Ids default to time-ordered UUID v7 (override with `idGenerator`).

### `db.events`

| Method | Description |
| --- | --- |
| `insert(event)` / `insertMany(events)` | Store events. `id` is generated if omitted. `observedAt` defaults to `timestamp`. |
| `get(id, { includeEmbedding? })` / `getMany(ids)` | Fetch by id. |
| `list({ filters?, limit?, cursor?, order? })` | Filtered, cursor-paginated listing. |
| `similar({ event, limit?, minScore?, filters?, cursor? })` | Cosine similarity search. `event` may be an id, an embedding, or `{ id?, embedding? }`. The query event is always excluded. Results include `content` and `metadata`, are ordered `(score desc, id asc)`, and carry `nextCursor` when more matches exist; each page rescans candidates, so paging is exact but not cheaper than the first page. |
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
| `around({ eventId, before?, after?, entities?, namespace?, asOf? })` | All streams in a window around an event, grouped by namespace. Defaults to the event's entities, expanded through `db.aliases`. |
| `entities({ namespace?, prefix?, limit? })` | Catalog: entities with timeline data, point counts, namespaces and span. |
| `namespaces()` | Catalog: streams in use with point counts, distinct entities and span. |

### `db.decisions` / `db.outcomes`

| Method | Description |
| --- | --- |
| `decisions.insert({ eventId, timestamp, action, metadata? })` | Record an action taken in response to an event. |
| `decisions.forEvent(eventId, { until? })` | Decisions for an event, ascending. |
| `outcomes.insert({ eventId, decisionId?, horizon, result, timestamp? })` | Attach an observed result. Outcome time defaults to the decision's (or event's) timestamp + `horizon`. |
| `outcomes.forEvent(eventId, { until? })` | Outcomes for an event, ascending by outcome time. |

### `db.aliases`

Events and timeline data may name the same entity differently — an event imported from another system might carry an entity id such as `"42"` while its prices are stored under `"AAPL"`. Aliases bridge the two: whenever an event's own entities select its timeline window (`timeline.around`, `history.get`/`getMany` without an explicit `entities`), each entity is expanded to itself plus its aliases. The table is empty by default, so nothing changes until you add one.

| Method | Description |
| --- | --- |
| `add(externalId, entity \| entity[])` | Map an external id to one or more timeline labels. Existing pairs are ignored. |
| `remove(externalId, entity)` | Remove one mapping; returns whether it existed. |
| `forExternal(externalIds)` | `Map<externalId, entity[]>` for each requested id (empty list when unmapped). |
| `list({ prefix?, limit? })` | All mappings ordered by `(externalId, entity)`; `prefix` filters on the external id. |

```ts
await db.events.insert({ id: "q3", timestamp: "2024-01-25", type: "earnings", entities: ["42"] });
await db.aliases.add("42", "AAPL");
const h = await db.history.get({ eventId: "q3" }); // includes timeline points stored under "AAPL"
```

### `db.history`

```ts
const h = await db.history.get({
  eventId,
  before: "7d",          // window before event time (default "7d")
  after: "5d",           // window after event time (default: 0, or far enough to cover outcomeUntil)
  contextUntil?: ...,    // observation-time cutoff for `context` (default: event.observedAt)
  outcomeUntil?: ...,    // observation-time cutoff for `timeline`/`decisions`/`outcomes` (default: max(event.timestamp + after, contextUntil))
  entities?: ...,        // default: the event's entities, expanded through db.aliases
  namespace?: ...,
  maxPoints?: 100000,    // cap on timeline points per event (default and max 100 000)
});
```

Returns:

| Field | Contents |
| --- | --- |
| `event` | The event. From a provider with point-in-time content (insights-db), as it stood at `contextUntil`. |
| `context` | Timeline streams **observed at or before `contextUntil`** — safe pre-decision context. |
| `timeline` | Full window `[event − before, event + after]`, cut at `outcomeUntil`. |
| `decisions` | Decisions with `timestamp ≤ outcomeUntil`. |
| `outcomes` | Outcomes with outcome time `≤ outcomeUntil`. |
| `window` | The resolved `{ from, to, contextUntil, outcomeUntil }` in ms. |
| `truncated?` | Present when the window held more than `maxPoints` points: `{ at: { timestamp, id }, next }`, where `next` is a ready-made `timeline.range` query for the remainder (page through it with its `nextCursor`; filter items by `observedAt <= window.contextUntil` to extend `context`). |

`history.getMany({ eventIds, ...sameOptions })` returns one `History` per found id, in input order, with all lookups batched into a single read transaction.

### External event source

Events can live somewhere else — a system that ingests and deduplicates them on its own — while hindsight-db keeps the context around them. Pass an `EventProvider` (the read half of `db.events`: `get`, `getMany`, `list`, `similar`, `entities`, `types`) and only the timeline, decisions and outcomes are stored in the SQLite file:

```ts
import { openDatabase, type EventProvider } from "hindsight-db";

const provider: EventProvider = /* adapter over your event store */;
const db = openDatabase({ path: "context.db", events: provider });

await db.timeline.insert({ timestamp, entity: "AAPL", namespace: "market", data });
const h = await db.history.get({ eventId: "42", before: "7d" }); // event fetched via provider
```

`db.events` is then the provider itself, so it has exactly the methods the provider has — there is no `insert`/`delete` unless the provider offers them. Events must come back with `timestamp`/`observedAt` in epoch ms; their `entities` either are the labels the timeline is keyed by or map to them through `db.aliases`. Decisions and outcomes reference events by id and fetch a local stub from the provider on first use.

A provider whose events keep growing after they are first observed (new facts get attached to an old event) sets `pointInTime` and honours `getMany(ids, { asOf })`; `history` then fetches each event as it stood at its `contextUntil`, so `event.content` never knows more than `context` does.

| Method | Description |
| --- | --- |
| `db.gc()` | Drop the decisions and outcomes of events the provider no longer has (it may delete or merge them; nothing cascades across databases). Returns `{ removedEvents, removedDecisions, removedOutcomes }`. A no-op with the SQLite event store. |

### Storage backends

The context — timeline, decisions, outcomes, aliases — lives in a **SQLite** file by default: zero configuration, embedded, events included. With an external event source it can live in **Postgres** instead, so an application whose events are already in Postgres (insights-db, say) keeps everything in one database:

```ts
import { openDatabase } from "hindsight-db";

const db = openDatabase({
  storage: "postgres",
  connectionString: process.env.DATABASE_URL, // or: pool (an existing pg.Pool, e.g. insights.pool)
  schema: "hindsight",                          // optional; only with connectionString
  events: provider,                             // required: Postgres stores only the context
});
await db.ready(); // optional: connects and creates/migrates the schema now rather than on first use
```

| Option | |
| --- | --- |
| `connectionString` | A pool the database creates and owns; `db.close()` ends it. |
| `pool` | A `pg.Pool` to share (its tables land wherever that pool's `search_path` points). Not ended by `db.close()`. |
| `schema` | Postgres schema for the hindsight tables, created if missing and put first on the connections' `search_path`. With a shared `pool`, set its search path yourself. |

`pg` is an optional peer dependency (`npm install pg`), imported on first use; a SQLite-only install never loads it. The tables are the same as the SQLite ones (`event_refs`, `timeline`, `decisions`, `outcomes`, `entity_aliases`; JSON columns as `text`, timestamps as `bigint`), versioned in a `hindsight_schema` table the way SQLite files are in `PRAGMA user_version` (`db.schemaVersion`, `POSTGRES_SCHEMA_VERSION`); opening applies pending migrations under an advisory lock, so several processes can start at once. `db.storage` tells you which backend a handle uses.

What changes with Postgres:

- **Everything is asynchronous.** On SQLite a store method has executed its SQL by the time it hands back its promise; on Postgres nothing happens until you await. `db.transaction(fn)` therefore takes an async callback — `await db.transaction(async () => { await db.timeline.insert(…); await db.decisions.insert(…); })` — which works identically on both backends, and always returns a promise on Postgres. See *Transactions* under Implementation notes.
- **Round trips cost.** `history.getMany` fetches all its windows in one query, and all inserts are multi-row statements, so batch where you can: on a local Postgres `getMany` is ~3× faster per event than a loop of `history.get`, and `timeline.range` paging is bounded by moving 1000 rows over the wire (~7 ms/page) rather than by the index scan (~1.7 ms).
- **`bulkLoad`** drops the secondary indexes for every client of that schema for the duration, not just yours.
- **Events** stay wherever the provider keeps them; a Postgres-backed *event* store (pgvector `similar`) is not part of this — use `InsightsEventProvider`, your own `EventProvider`, or a separate SQLite file's `db.events` as the source.

The test suite runs against both backends: `DATABASE_URL=postgres://… npm test` adds a `postgres` project that runs the store tests a second time against Postgres (in schemas of its own, `hindsight_test_*`), plus `tests/postgres.test.ts` for backend-specific behaviour.

### Using insights-db as the event source

[insights-db](https://github.com/sarveshbhatnagar/insights-db) ingests documents into deduplicated real-world events with their facts, on Postgres + pgvector. `InsightsEventProvider` wraps its read API so hindsight-db can keep the context around those events. insights-db is an optional peer dependency (`npm install insights-db`); nothing of it is loaded unless you use the adapter.

```ts
import { addDuration, openDatabase, InsightsEventProvider } from "hindsight-db";
import { openInsights } from "insights-db";

const insights = openInsights({ connectionString: process.env.DATABASE_URL });
const db = openDatabase({ path: "context.db", events: new InsightsEventProvider(insights) });
// or, to have the adapter import insights-db and open the connection itself:
// const db = openDatabase({ path: "context.db", events: await InsightsEventProvider.open({ connectionString }) });

// Events name entities by insights' ids; timeline data is keyed by your labels.
const [meridian] = await db.events.entities({ limit: 1 });
await db.aliases.add(meridian.entity, "MRDN");

const h = await db.history.get({ eventId, contextUntil: decision.timestamp, outcomeUntil: addDuration(decision.timestamp, "5d") });
// h.event.content.claims: only what insights had asserted by contextUntil, a later correction not yet applied
// h.context.market:       your MRDN points observed by contextUntil

await db.gc(); // after insights merged or detached events: drop their orphaned decisions/outcomes
```

How insights records map to hindsight events:

| insights | hindsight `Event` |
| --- | --- |
| `id` | `id` |
| `occurredAt` (a calendar day) | `timestamp` = that day at **00:00 UTC** — insights knows events to the day, so `before`/`after` windows and `from`/`to` filters work at day granularity; timeline data on the event's own day counts as *after* it |
| `observedAt` (earliest document date) | `observedAt` |
| `eventType` | `type` |
| `entities[].id` | `entities` (insights' numeric ids; map them with `db.aliases`) |
| `title`, `claims` | `content: { title, claims }` — each claim with `claimId`, `text`, `assertedAt` (epoch ms), `kind`, `supersededBy`, `disputedWith`, `verdict`, `evidenceUrl`, `hidden` |
| `storylineId`, `pattern`, entity names/types/roles | `metadata: { storylineId, pattern, entityNames }` |

`similar` ranks by insights' **pattern** embedding (written once per event, so a backtest sees the same neighbours at any later date); pass `{ vector: "content" }` to the constructor to rank by the content embedding, which follows the claims as they merge. Filters: `type`, `entities` (any-of), `from`/`to` (rounded to whole days), `asOf`, `excludeIds`. `entitiesAll` is accepted for a single id only, `metadata` filters and `similar`'s `cursor` throw — insights' read API has no equivalent, and a silently wider result would be worse than an error. `getMany(ids, { asOf })` returns each event as insights knew it then, which is what `history` uses. `includeEmbedding` is ignored (insights does not hand out vectors).

To keep the context in the same Postgres as insights, share its pool: `openDatabase({ storage: "postgres", pool: insights.pool, events: new InsightsEventProvider(insights) })` puts the hindsight tables in insights' schema (see *Storage backends*).

The integration test in `tests/insights-integration.test.ts` runs when `DATABASE_URL` points at a Postgres with pgvector (see the container in insights-db's README); it creates its own `hindsight_it` schema there and runs once with the context in SQLite and once with it in that same schema.

### `db.bulkLoad(fn)`

Backfill mode. Drops all secondary indexes for the duration of `fn` and rebuilds them afterwards, turning random index inserts into sequential appends. Use for initial imports, not routine writes; reads inside `fn` work but are slow. If the process dies mid-load, the next `openDatabase` recreates any missing indexes.

```ts
await db.bulkLoad(async () => {
  for await (const batch of readCsvBatches()) await db.timeline.insertMany(batch);
});
```

## Time semantics

Every record distinguishes three clocks, as required by the design:

| Clock | Field | Meaning |
| --- | --- | --- |
| Event time | `timestamp` | When the underlying thing happened. |
| Observation time | `observedAt` | When the information became available. Defaults to `timestamp`. |
| Outcome time | `outcomes[].timestamp` | When the result became observable. Defaults to anchor + `horizon`. |

Window bounds (`before`/`after`, `from`/`to`) apply to **event time**. Cutoffs (`asOf`, `contextUntil`, `outcomeUntil`) apply to **observation time**. When `after` is omitted, the event-time window automatically extends to cover `outcomeUntil`, so the design's `{ contextUntil: decision.timestamp, outcomeUntil: decision.timestamp + 5d }` form works on its own. `contextUntil` may never exceed `outcomeUntil` — the outcome view always knows at least as much as the context view — and `history.get` throws if explicit cutoffs violate that. A revised data point with `timestamp = T−1d` but `observedAt = T+1d` is therefore inside a `before: "7d"` window but excluded from `context` — that is the point.

## Implementation notes

- **Storage**: by default a single SQLite file via `better-sqlite3` (WAL mode, foreign keys on, cascading deletes from events), all stores sharing one connection; or Postgres for the context tables (see *Storage backends*). The context stores are written once against a small `Storage` interface (`src/storage/storage.ts`): a store method describes its work as a generator that yields SQL effects (`all`, `run`, `tx`) and gets their results back, and the backend interprets it — `SqliteStorage` synchronously in one go, `PostgresStorage` with an await per statement. SQL is written in the common dialect (`?` placeholders, rewritten to `$n` for Postgres; `ON CONFLICT`; `RETURNING`; multi-row `VALUES`), with the one divergence (`group_concat` vs `string_agg`) behind `Storage.dialect`. The SQLite event store is not behind this interface: it uses better-sqlite3 directly (triggers, blob embeddings, the `similar()` scan).
- **Event stubs**: decisions and outcomes do not reference the `events` table directly but `event_refs`, a local `(id, timestamp, observed_at)` stub per event. In the default setup triggers keep it in sync with `events` (inserts, timestamp updates, deletes — the cascade from an event delete flows through it), so it is invisible. It exists so events can live in another database: with `openDatabase({ events: provider })`, `decisions.insert`/`outcomes.insert` fetch the stubs for ids they have not seen from `provider.getMany` *before* opening their write transaction, so `outcomes.insert` still resolves its default timestamp locally (and, on SQLite, synchronously). Ids the provider does not know fail as unknown events. Once an event's stub exists, later writes for it are synchronous again on SQLite and may run inside a synchronous `db.transaction()`. Nothing tells the file when the provider drops an event; `db.gc()` asks the provider about every stub, 5000 ids at a time, and deletes the ones it no longer knows (cascading to their decisions and outcomes).
- **Point-in-time content**: `history.getMany` first fetches the events as they stand (to resolve each window), then — for a provider with `pointInTime` — once more per distinct `contextUntil` with `asOf`, so an explicit cutoff costs one extra call for the whole batch and the default (each event's own `observedAt`) one per event, issued concurrently. An event observed only after its cutoff is returned as it stands.
- **Schema migrations**: the SQLite schema is an append-only list in `src/storage/migrations.ts`, versioned with SQLite's `PRAGMA user_version`; the Postgres schema is its own list in `src/storage/postgres.ts` (context tables only, versioned in `hindsight_schema`, currently **v1**), applied under an advisory lock so concurrent openers serialize. Opening a file applies any migrations it hasn't seen, each in its own transaction, so older files upgrade in place and a failed migration leaves the file untouched. A file written by a newer library version is refused with `SchemaVersionError` rather than misread. `db.schemaVersion` / `SCHEMA_VERSION` expose the numbers. To change the schema: append an entry, never edit a shipped one. `migrate()` runs with foreign keys off (a table rebuild's `DROP` would otherwise cascade) and refuses to commit a migration that leaves a foreign-key violation. Versions so far: **v1** initial schema; **v2** `timeline (entity, timestamp)` index; **v3** `event_refs` (decisions/outcomes rebuilt to reference it, populated from existing events) and `entity_aliases`. Opening a v2 file upgrades it in place, keeping all decision and outcome rows.
- **Vector search**: embeddings are stored as Float32 blobs (native byte order) with a precomputed L2 norm; non-finite components are rejected at insert and query time. `similar()` narrows candidates with SQL filters, then scores cosine similarity in-process with a bounded top-k. This is exact, not approximate — fine up to roughly 10⁵ events per query; swap in an ANN index behind the same interface when that stops being true.
- **Parallelism**: SQLite is synchronous and single-writer, so "parallel" retrieval is implemented as *batched* retrieval — `history.getMany` runs one query for events, then one read transaction for everything local: alias expansion, every timeline window, decisions, outcomes. On Postgres the windows of one shape (all with entities or none, etc.) go out as a single `unnest … JOIN LATERAL` query, one index scan per window server-side, instead of one round trip each. The API is promise-based throughout, and the event side is behind the `EventProvider` interface, so a networked event store (e.g. Postgres + pgvector) can be dropped in via `openDatabase({ events })` without changing callers.
- **Pagination**: `events.list` and `timeline.range` use opaque keyset cursors on `(timestamp, id)`.
- **List sizes**: id lookups (`events.getMany`, `history.getMany`) are chunked internally, so any number of ids is fine. Filter lists (`entities`, `type`, `excludeIds`) are capped at 5000 values per query and fail with a clear error beyond that.
- **Transactions**: `insertMany` on every store is atomic. `db.transaction(fn)` wraps several writes all-or-nothing, and if any store call inside fails — even one whose rejection you swallowed — the whole transaction rolls back and rethrows that error. `fn` may be **async**: store calls made in its async context (via `AsyncLocalStorage`) join the transaction, nested `db.transaction` calls become savepoints, and it commits when the returned promise resolves. Await store calls one after another inside it; un-awaited ones are still drained before the commit, but interleaving two nested transactions is not supported. On SQLite a **synchronous** `fn` is the fast path: store methods run their SQL before their first `await`, so `db.transaction(() => { void db.timeline.insertMany(a); void db.decisions.insertMany(b); })` commits before it returns. While an async transaction is open on SQLite, store calls from other async contexts wait for it to end (one connection cannot interleave two transactions) — so never `await` something inside `fn` that itself needs the database from outside `fn`'s context. On Postgres a transaction pins one pool client and is always asynchronous; other connections do not see its writes until commit, as usual.
- **Validation**: ids, entities and namespaces must be non-empty strings (entities may not contain U+001F); `metadata` must be a plain object shallow enough for SQLite's JSON parser; embeddings must be non-empty and finite; `limit` must be a positive integer; `horizon` must be non-negative. Metadata filters are type-strict (`1`, `"1"` and `true` are distinct).

## Performance

`npm run build && node bench/scale.ts` runs the scale benchmark (env knobs: `N_EVENTS`, `N_ENTITIES`, `N_DAYS`, `RUNS`). On an M2 Pro with 100k events (128-dim, 3 entities each):

| Operation | Time |
| --- | --- |
| `events.similar`, no filter, 100k candidates | ~115 ms |
| `events.similar`, type filter (10%) | ~35 ms |
| `events.similar`, one entity | ~50 ms |
| `events.similar`, 1000 candidates at 1536-dim | ~5 ms |
| `history.getMany` (≈420 timeline points/event, 800k-row timeline) | ~0.35 ms/event |
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

Ingest: `bulkLoad` measured 1.6× on 600k in-memory timeline rows (more on large on-disk tables, where index maintenance dominates); UUID v7 ids 1.25× on event ingest vs random UUIDs. Pass `cacheSizeMb` to `openDatabase` for a larger page cache (≈20% on paging).

### Postgres

`STORAGE=postgres DATABASE_URL=postgres://… node bench/scale.ts` runs the same bench with the context in Postgres (events stay in the SQLite file). Against a Postgres 16 in Docker on the same M2 Pro, at 20k events / 200k timeline points (`N_EVENTS=20000 N_ENTITIES=100 N_DAYS=500`):

| Operation | SQLite | Postgres (context) |
| --- | --- | --- |
| `history.getMany` ×100 (≈420 points/event) | ~0.5 ms/event | ~0.8 ms/event |
| loop of `history.get` ×100 | ~0.57 ms/event | ~2.3 ms/event |
| `timeline.range` paging, 1000 points/page | ~3 ms/page | ~7 ms/page (index scan 1.7 ms; the rest is the wire) |
| Ingest: timeline (batches of 10k) | ~170k rows/s | ~105k rows/s |
| Ingest: decisions / outcomes (batches of 1k / 2k) | ~270k / ~180k rows/s | ~35k / ~38k rows/s |

Every timeline index in Postgres ends in `(timestamp, id)` — the pair reads order and page by — because, unlike SQLite's rowid, the id is not implicitly part of an index key there; the paging cursor is a row-value comparison for the same reason. Where the numbers differ it is round trips and bytes on the wire, not the plan: batch through `insertMany`/`getMany`, and prefer a Unix socket or a nearby server.

## Layout

```
src/
  index.ts            openDatabase(), HindsightDB, public exports
  types.ts            input/output types
  time.ts             duration + timestamp parsing, addDuration
  ids.ts              UUID v7 generator
  vector.ts           embedding encoding, cosine
  storage/storage.ts  Storage interface, generator ops, shared SQL helpers
  storage/sqlite.ts   SqliteStorage (synchronous interpreter, transactions)
  storage/postgres.ts PostgresStorage (async interpreter over pg) + its schema
  storage/migrations.ts  versioned SQLite schema (append-only)
  storage/event-refs.ts  local event stubs that decisions/outcomes reference
  events/provider.ts  EventProvider interface (read side of an event source)
  events/sqlite.ts    SqliteEventStore, the default provider (adds writes)
  events/insights.ts  InsightsEventProvider, adapter over insights-db's read API
  stores/             timeline, decisions, outcomes, history, aliases
tests/                vitest, one file per store + end-to-end flow; store tests run on both backends
tests/helpers/backend.ts  picks the backend per vitest project (see vitest.config.ts)
```

## Releasing

Releases are automated. Bump the version and push the tag; CI publishes to npm (via trusted publishing, no tokens) and creates the GitHub release:

```sh
npm run release patch      # or minor / major — runs checks, bumps package.json, commits, tags
git push --follow-tags
```

## License

MIT

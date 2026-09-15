# Goal

Build a database for storing and retrieving multiple related views of historical data in parallel.

The primary abstraction is:

```text
Event
├── Context at event time
├── Action / Decision
├── Timeline before and after the event
└── Observed Outcome
```

The database should make it easy for an application to:

1. find similar historical events,
2. retrieve the timeline around those events,
3. retrieve actions and observed outcomes,
4. execute these lookups efficiently in parallel.

Reasoning, filtering, and decision-making remain responsibilities of the application layer.

# Core Architecture

The database exposes three primary storage primitives:

```text
Event Store
→ discrete events + embeddings + metadata

Timeline Store
→ timestamped data such as market data, news, signals, context

Decision Store
→ actions and observed outcomes linked to events
```

These stores are connected through:

```text
event_id
entity_id
timestamp
```

This allows an application to start with an event and efficiently reconstruct the complete historical state around it.

```text
Event
  │
  ├── Similar Events
  │
  ├── Timeline [-30d, +5d]
  │
  ├── Decision
  │
  └── Outcome
```

# Database Capabilities

### 1. Event Storage

Store structured and unstructured events.

```ts
db.events.insert({
  id,
  timestamp,
  type,
  entities,
  content,
  embedding,
  metadata
})
```

Events should support:

* metadata filtering
* entity filtering
* vector similarity search
* timestamp filtering

### 2. Timeline Storage

Store arbitrary timestamped information independently of events.

```ts
db.timeline.insert({
  timestamp,
  entity,
  namespace: "market",
  data: {...}
})
```

Namespaces could include:

```text
market
news
macro
signals
positions
custom
```

The important property is that an application can query any historical window:

```ts
db.timeline.range({
  entity: "AAPL",
  from: event.timestamp - "7d",
  to: event.timestamp + "1d"
})
```

### 3. Actions and Outcomes

Store decisions independently from their eventual outcomes.

```ts
db.decisions.insert({
  eventId,
  timestamp,
  action,
  metadata
})
```

Outcomes can be attached later once they become known:

```ts
db.outcomes.insert({
  eventId,
  decisionId,
  horizon: "1d",
  result: {...}
})
```

This is important for historical lookback because the database can provide both:

```text
What was known when the decision was made
+
What actually happened afterward
```

without leaking future information into the original context.

# Retrieval APIs

The primary API should support compound historical retrieval.

### Similar Event Search

```ts
db.events.similar({
  event,
  limit: 20,
  filters: {...}
})
```

Returns event IDs, similarity scores, metadata, and timestamps.

### Timeline Lookup

```ts
db.timeline.around({
  eventId,
  before: "7d",
  after: "1d"
})
```

Returns all relevant timeline streams around the event.

### Historical Record

A convenience API should reconstruct the complete historical record:

```ts
db.history.get({
  eventId,
  before: "7d",
  after: "5d"
})
```

Response:

```ts
{
  event,
  context,
  decisions,
  timeline,
  outcomes
}
```

### Parallel Historical Retrieval

Because the common access pattern operates over multiple candidate events, this should be a first-class API:

```ts
db.history.getMany({
  eventIds,
  before: "7d",
  after: "5d"
})
```

Internally, the database can fetch timelines, decisions, and outcomes concurrently.

# SDK

The SDK should expose a small set of composable primitives:

```ts
db.events
db.timeline
db.decisions
db.outcomes
db.history
```

A typical application flow would look like:

```ts
const candidates = await db.events.similar({
  event: currentEvent,
  limit: 20
})

// Application decides which candidates it cares about.

const history = await db.history.getMany({
  eventIds: selectedIds,
  before: "14d",
  after: "5d"
})

// Application / agent performs reasoning over `history`.
```

The SDK should handle:

* batching
* parallel reads
* pagination
* time-window normalization
* serialization
* retries
* connection pooling

but should not contain agent-specific logic.

# Important Data Boundary

The database should explicitly distinguish:

```text
Observation Time
→ when information became available

Event Time
→ when the underlying event occurred

Outcome Time
→ when the result became observable
```

This makes historical queries safe for backtesting and prevents future information from accidentally appearing in pre-decision context.

For example:

```ts
db.history.get({
  eventId,
  contextUntil: decision.timestamp,
  outcomeUntil: decision.timestamp + "5d"
})
```

# MVP API Surface

A first version only needs:

```text
events.insert()
events.similar()

timeline.insert()
timeline.range()

decisions.insert()

outcomes.insert()

history.get()
history.getMany()
```

This provides the core database primitive we need:

```text
similar event retrieval
        +
parallel timeline reconstruction
        +
decision/outcome lookup
```

Applications can then build agents, reasoning systems, or decision engines independently on top of the database.

/**
 * Randomized, seeded property tests.
 *
 * Each seed builds a fresh in-memory database with random events (random
 * observation lags, entities, embeddings, metadata), timeline points (some
 * observed well after their event time), decisions and outcomes, then checks
 * invariants that must hold for ANY data against brute-force oracles computed
 * in the test from the inserted records.
 *
 * On failure the test name carries the seed and the assertion message carries
 * the exact query, so a repro is: `new Rng(seed)` + the printed query.
 */
import { describe, expect, it } from "vitest";
import {
  openDatabase,
  type ActionGraph,
  type Decision,
  type DurationInput,
  type Event,
  type EventFilters,
  type History,
  type HistoryQuery,
  type Metadata,
  type Outcome,
  type SimilarQuery,
  type TimelinePoint,
  type TimelineStreams,
  type TimestampInput,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// PRNG (mulberry32) — deterministic per seed, no dependencies.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  /** Uniform integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)]!;
  }
  subset<T>(arr: readonly T[], p = 0.5): T[] {
    return arr.filter(() => this.bool(p));
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }
  /** A random instant in a ±30d band around T0, on a 6h grid so ties are common. */
  ts(): number {
    return T0 + this.int(-120, 120) * STEP;
  }
  /** The same instant in one of the accepted input encodings. */
  tsInput(ms: number): TimestampInput {
    const k = this.int(0, 2);
    return k === 0 ? ms : k === 1 ? new Date(ms) : new Date(ms).toISOString();
  }
  /** A single value or an array, as the `string | string[]` filter fields accept both. */
  oneOrMany(arr: readonly string[]): { input: string | string[]; values: string[] } {
    const values = this.subset(arr, 0.5);
    if (values.length === 1 && this.bool()) return { input: values[0]!, values };
    return { input: values, values };
  }
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2024, 0, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STEP = 6 * HOUR;
/** A cutoff beyond every generated observation time: "everything is known". */
const FAR_FUTURE = T0 + 10_000 * DAY;

const ENTITIES = ["A", "B", "C", "D"];
const NAMESPACES = ["market", "news", "macro"];
const TYPES = ["earnings", "guidance", "macro"];
const SECTORS = ["tech", "energy", "fin"];
const NOTES: (string | null)[] = [null, "a", "b"];
/** Durations paired with their ms value so the oracle never depends on parseDuration. */
const DURATIONS: { input: DurationInput; ms: number }[] = [
  { input: "0ms", ms: 0 },
  { input: "12h", ms: 12 * HOUR },
  { input: "1d", ms: DAY },
  { input: "3d", ms: 3 * DAY },
  { input: "7d", ms: 7 * DAY },
  { input: "-2d", ms: 2 * DAY }, // sign is ignored by windowAround
  { input: 20 * DAY, ms: 20 * DAY },
  { input: 36 * HOUR, ms: 36 * HOUR },
];

const SEED_COUNT = 50;
const seeds = (base: number) => Array.from({ length: SEED_COUNT }, (_, i) => base + i);

function check(cond: unknown, msg: () => string): asserts cond {
  if (!cond) throw new Error(msg());
}

/** (timestamp, id) ordering used by every store; ids are ASCII so JS and SQLite agree. */
function byTsId<T extends { timestamp: number; id: string | number }>(dir: 1 | -1 = 1) {
  return (a: T, b: T): number => {
    if (a.timestamp !== b.timestamp) return (a.timestamp - b.timestamp) * dir;
    if (a.id === b.id) return 0;
    return (a.id < b.id ? -1 : 1) * dir;
  };
}

function describeQuery(q: unknown): string {
  return JSON.stringify(q, (_k, v) => (v instanceof Float32Array ? Array.from(v) : v));
}

// ---------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------

interface World {
  seed: number;
  db: ActionGraph;
  dim: number;
  events: Event[]; // without embeddings
  embeddings: Map<string, Float32Array>; // events that have one
  points: TimelinePoint[];
  decisions: Decision[];
  outcomes: Outcome[];
}

function randomVector(rng: Rng, dim: number): number[] {
  if (rng.bool(0.08)) return new Array<number>(dim).fill(0); // zero vector: cosine is defined as 0
  // Small halves: exactly representable in float32, and ties in cosine are common.
  return Array.from({ length: dim }, () => rng.int(-4, 4) / 2);
}

async function buildWorld(seed: number): Promise<World> {
  const rng = new Rng(seed);
  const db = openDatabase();
  const dim = rng.int(2, 4);

  // Events. Ids are shuffled so (timestamp, id) ordering is independent of insertion order.
  const n = rng.int(4, 30);
  const ids = rng.shuffle(Array.from({ length: n }, (_, i) => `e${i}`));
  const eventInputs = ids.map((id) => {
    const timestamp = rng.ts();
    const metadata: Metadata = {};
    if (rng.bool(0.6)) metadata.sector = rng.pick(SECTORS);
    if (rng.bool(0.6)) metadata.score = rng.int(0, 3);
    if (rng.bool(0.6)) metadata.flag = rng.bool();
    if (rng.bool(0.6)) metadata.note = rng.pick(NOTES);
    const embedding = rng.bool(0.85) ? randomVector(rng, rng.bool(0.1) ? dim + 1 : dim) : undefined;
    return {
      id,
      timestamp,
      // Half the events are observed exactly at event time; the rest with a lag (occasionally negative).
      ...(rng.bool(0.5) ? {} : { observedAt: timestamp + rng.int(-2, 16) * STEP }),
      type: rng.pick(TYPES),
      entities: rng.subset(ENTITIES, 0.4),
      content: `content ${id}`,
      ...(embedding ? { embedding } : {}),
      metadata,
    };
  });
  const inserted = await db.events.insertMany(eventInputs);
  const events: Event[] = [];
  const embeddings = new Map<string, Float32Array>();
  for (const ev of inserted) {
    const { embedding, ...rest } = ev;
    events.push(rest);
    if (embedding) embeddings.set(ev.id, embedding);
  }

  // Timeline points: mixed lags, including revisions observed well after their event time.
  const m = rng.int(20, 200);
  const points = await db.timeline.insertMany(
    Array.from({ length: m }, (_, i) => {
      const timestamp = rng.ts();
      const r = rng.float();
      const observedAt =
        r < 0.5 ? timestamp
        : r < 0.8 ? timestamp + rng.int(1, 40) * STEP
        : r < 0.95 ? timestamp + rng.int(10, 40) * DAY
        : timestamp - rng.int(1, 4) * STEP;
      return {
        timestamp,
        observedAt,
        entity: rng.bool(0.05) ? "Z" : rng.pick(ENTITIES),
        namespace: rng.pick(NAMESPACES),
        data: { i },
      };
    }),
  );

  // Decisions: 0..2 per event, mostly after the event.
  let dk = 0;
  const decisions = await db.decisions.insertMany(
    events.flatMap((ev) =>
      Array.from({ length: rng.int(0, 2) }, () => ({
        id: `d${dk++}`,
        eventId: ev.id,
        timestamp: ev.timestamp + rng.int(-1, 20) * STEP,
        action: { side: rng.pick(["buy", "sell", "hold"]) },
      })),
    ),
  );

  // Outcomes: for most decisions, plus some attached directly to the event; some with explicit timestamps.
  let ok = 0;
  const horizons: DurationInput[] = ["12h", "1d", "3d", "5d", 2 * DAY];
  const outcomeInputs = [
    ...decisions.flatMap((d) =>
      rng.bool(0.7)
        ? Array.from({ length: rng.int(1, 2) }, () => ({
            id: `o${ok++}`,
            eventId: d.eventId,
            decisionId: d.id,
            horizon: rng.pick(horizons),
            ...(rng.bool(0.2) ? { timestamp: d.timestamp + rng.int(0, 30) * STEP } : {}),
            result: { ret: rng.int(-10, 10) / 100 },
          }))
        : [],
    ),
    ...events.flatMap((ev) =>
      rng.bool(0.3)
        ? [{ id: `o${ok++}`, eventId: ev.id, horizon: rng.pick(horizons), result: { ret: rng.int(-10, 10) / 100 } }]
        : [],
    ),
  ];
  const outcomes = await db.outcomes.insertMany(outcomeInputs);

  return { seed, db, dim, events, embeddings, points, decisions, outcomes };
}

async function withWorld(seed: number, fn: (world: World, rng: Rng) => Promise<void>): Promise<void> {
  const world = await buildWorld(seed);
  try {
    // A second stream for query generation, so the queries are independent of world size.
    await fn(world, new Rng(seed ^ 0x9e3779b9));
  } finally {
    world.db.close();
  }
}

// ---------------------------------------------------------------------------
// History oracle
// ---------------------------------------------------------------------------

type WindowOptions = Omit<HistoryQuery, "eventId">;

/** A random history/around option set together with the numeric values the oracle needs. */
interface WindowSpec {
  before?: { input: DurationInput; ms: number };
  after?: { input: DurationInput; ms: number };
  contextUntil?: number;
  outcomeUntil?: number;
  /** Entity override (undefined = the event's entities). Empty means "all", like the store. */
  entities?: { input: string | string[]; values: string[] };
  namespace?: { input: string | string[]; values: string[] };
}

function randomWindowSpec(rng: Rng, event: Event): WindowSpec {
  const spec: WindowSpec = {};
  if (rng.bool(0.8)) spec.before = rng.pick(DURATIONS);
  if (rng.bool(0.8)) spec.after = rng.pick(DURATIONS);
  if (rng.bool(0.5)) spec.contextUntil = event.timestamp + rng.int(-12, 32) * STEP;
  if (rng.bool(0.5)) spec.outcomeUntil = event.timestamp + rng.int(-8, 120) * STEP;
  if (rng.bool(0.3)) spec.entities = rng.oneOrMany(ENTITIES);
  if (rng.bool(0.4)) spec.namespace = rng.oneOrMany(NAMESPACES);
  return spec;
}

function toWindowOptions(spec: WindowSpec, rng: Rng): WindowOptions {
  return {
    ...(spec.before ? { before: spec.before.input } : {}),
    ...(spec.after ? { after: spec.after.input } : {}),
    ...(spec.contextUntil !== undefined ? { contextUntil: rng.tsInput(spec.contextUntil) } : {}),
    ...(spec.outcomeUntil !== undefined ? { outcomeUntil: rng.tsInput(spec.outcomeUntil) } : {}),
    ...(spec.entities ? { entities: spec.entities.input } : {}),
    ...(spec.namespace ? { namespace: spec.namespace.input } : {}),
  };
}

interface ResolvedWindow {
  from: number;
  to: number;
  contextUntil: number;
  outcomeUntil: number;
}

/** Mirrors the documented window/cutoff defaults. `null` = the query must be rejected. */
function resolveWindow(spec: WindowSpec, event: Event): ResolvedWindow | null {
  const from = event.timestamp - (spec.before?.ms ?? 7 * DAY);
  const explicitTo = event.timestamp + (spec.after?.ms ?? 0);
  const contextUntil = spec.contextUntil ?? event.observedAt;
  const outcomeUntil = spec.outcomeUntil ?? Math.max(explicitTo, contextUntil);
  // Without an explicit `after`, the event-time window stretches to cover the observation cutoffs.
  const to = spec.after ? explicitTo : Math.max(explicitTo, outcomeUntil);
  if (contextUntil > outcomeUntil) return null;
  return { from, to, contextUntil, outcomeUntil };
}

/** Points in the window known at `asOf`, ascending by (timestamp, id). */
function expectedPoints(world: World, event: Event, spec: WindowSpec, w: { from: number; to: number }, asOf: number) {
  const entities = spec.entities ? spec.entities.values : event.entities;
  const namespaces = spec.namespace?.values;
  return world.points
    .filter(
      (p) =>
        p.timestamp >= w.from &&
        p.timestamp <= w.to &&
        p.observedAt <= asOf &&
        (entities.length === 0 || entities.includes(p.entity)) &&
        (!namespaces || namespaces.length === 0 || namespaces.includes(p.namespace)),
    )
    .sort(byTsId());
}

function streamIds(streams: TimelineStreams): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const ns of Object.keys(streams).sort()) out[ns] = streams[ns]!.map((p) => p.id);
  return out;
}

function groupIds(points: TimelinePoint[]): Record<string, number[]> {
  const grouped: TimelineStreams = {};
  for (const p of points) (grouped[p.namespace] ??= []).push(p);
  return streamIds(grouped);
}

/** Invariants that hold for any history result, independent of the oracle. */
function checkHistoryInvariants(h: History, spec: WindowSpec, ctx: () => string): void {
  const w = h.window;
  check(w.contextUntil <= w.outcomeUntil, () => `${ctx()}: contextUntil > outcomeUntil in ${describeQuery(w)}`);
  check(w.from <= w.to, () => `${ctx()}: from > to in ${describeQuery(w)}`);

  const allowedEntities = spec.entities ? spec.entities.values : h.event.entities;
  const allowedNamespaces = spec.namespace?.values;
  const contextIds = new Set<number>();
  const timelineIds = new Set<number>();

  const checkStreams = (streams: TimelineStreams, cutoff: number, label: string, ids: Set<number>) => {
    for (const [ns, pts] of Object.entries(streams)) {
      check(pts.length > 0, () => `${ctx()}: ${label}.${ns} is an empty stream`);
      let prev: TimelinePoint | undefined;
      for (const p of pts) {
        check(p.namespace === ns, () => `${ctx()}: ${label} point ${p.id} filed under ${ns} but is ${p.namespace}`);
        check(p.observedAt <= cutoff, () => `${ctx()}: ${label} point ${p.id} observed at ${p.observedAt} > cutoff ${cutoff}`);
        check(p.timestamp >= w.from && p.timestamp <= w.to, () => `${ctx()}: ${label} point ${p.id} ts ${p.timestamp} outside [${w.from}, ${w.to}]`);
        check(allowedEntities.length === 0 || allowedEntities.includes(p.entity), () => `${ctx()}: ${label} point ${p.id} entity ${p.entity} not in ${allowedEntities}`);
        check(!allowedNamespaces || allowedNamespaces.length === 0 || allowedNamespaces.includes(p.namespace), () => `${ctx()}: ${label} point ${p.id} namespace ${p.namespace} not in ${allowedNamespaces}`);
        check(!prev || byTsId()(prev, p) < 0, () => `${ctx()}: ${label}.${ns} not strictly ascending by (timestamp, id) at point ${p.id}`);
        check(!ids.has(p.id), () => `${ctx()}: ${label} point ${p.id} appears twice`);
        ids.add(p.id);
        prev = p;
      }
    }
  };
  checkStreams(h.context, w.contextUntil, "context", contextIds);
  checkStreams(h.timeline, w.outcomeUntil, "timeline", timelineIds);
  for (const id of contextIds) check(timelineIds.has(id), () => `${ctx()}: context point ${id} missing from timeline`);

  let prevD: Decision | undefined;
  for (const d of h.decisions) {
    check(d.eventId === h.event.id, () => `${ctx()}: decision ${d.id} belongs to ${d.eventId}`);
    check(d.timestamp <= w.outcomeUntil, () => `${ctx()}: decision ${d.id} at ${d.timestamp} > outcomeUntil ${w.outcomeUntil}`);
    check(!prevD || byTsId()(prevD, d) < 0, () => `${ctx()}: decisions not ascending at ${d.id}`);
    prevD = d;
  }
  let prevO: Outcome | undefined;
  for (const o of h.outcomes) {
    check(o.eventId === h.event.id, () => `${ctx()}: outcome ${o.id} belongs to ${o.eventId}`);
    check(o.timestamp <= w.outcomeUntil, () => `${ctx()}: outcome ${o.id} at ${o.timestamp} > outcomeUntil ${w.outcomeUntil}`);
    check(!prevO || byTsId()(prevO, o) < 0, () => `${ctx()}: outcomes not ascending at ${o.id}`);
    prevO = o;
  }
}

// ---------------------------------------------------------------------------
// Event filter oracle
// ---------------------------------------------------------------------------

function randomEventFilters(rng: Rng, world: World): { filters: EventFilters; matches: (e: Event) => boolean } {
  const filters: EventFilters = {};
  const preds: ((e: Event) => boolean)[] = [];
  if (rng.bool(0.4)) {
    const { input, values } = rng.oneOrMany(TYPES);
    filters.type = input;
    if (values.length) preds.push((e) => values.includes(e.type)); // empty list = no filter
  }
  if (rng.bool(0.4)) {
    const { input, values } = rng.oneOrMany(ENTITIES);
    filters.entities = input;
    if (values.length) preds.push((e) => e.entities.some((x) => values.includes(x)));
  }
  if (rng.bool(0.4)) {
    const from = rng.ts();
    filters.from = rng.tsInput(from);
    preds.push((e) => e.timestamp >= from);
  }
  if (rng.bool(0.4)) {
    const to = rng.ts();
    filters.to = rng.tsInput(to);
    preds.push((e) => e.timestamp <= to);
  }
  if (rng.bool(0.4)) {
    const asOf = rng.ts() + rng.int(0, 8) * STEP;
    filters.asOf = rng.tsInput(asOf);
    preds.push((e) => e.observedAt <= asOf);
  }
  if (rng.bool(0.4)) {
    // Each key has a single value type, so JSON equality in SQLite and strict equality here agree.
    const metadata: Record<string, string | number | boolean | null> = {};
    if (rng.bool(0.5)) metadata.sector = rng.pick(SECTORS);
    if (rng.bool(0.4)) metadata.score = rng.int(0, 3);
    if (rng.bool(0.4)) metadata.flag = rng.bool();
    if (rng.bool(0.4)) metadata.note = rng.pick(NOTES);
    filters.metadata = metadata;
    for (const [k, v] of Object.entries(metadata)) preds.push((e) => k in e.metadata && e.metadata[k] === v);
  }
  if (rng.bool(0.3)) {
    const excludeIds = [...rng.subset(world.events, 0.2).map((e) => e.id), ...(rng.bool() ? ["nope"] : [])];
    filters.excludeIds = excludeIds;
    preds.push((e) => !excludeIds.includes(e.id));
  }
  return { filters, matches: (e) => preds.every((p) => p(e)) };
}

// Same formula as the store so scores are bit-identical; tolerance is still applied below.
function cosineOracle(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}
const SCORE_EPS = 1e-9;

// ---------------------------------------------------------------------------
// 1. history.get: window/cutoff invariants + exact oracle
// ---------------------------------------------------------------------------

describe("fuzz: history.get respects windows and observation cutoffs", () => {
  for (const seed of seeds(1000)) {
    it(`seed ${seed}`, async () => {
      await withWorld(seed, async (world, rng) => {
        const sample = rng.shuffle([...world.events]).slice(0, 8);
        for (const event of sample) {
          const spec = randomWindowSpec(rng, event);
          const opts = toWindowOptions(spec, rng);
          const query: HistoryQuery = { eventId: event.id, ...opts };
          const ctx = () => `seed=${seed} query=${describeQuery(query)}`;
          const w = resolveWindow(spec, event);

          if (w === null) {
            await expect(world.db.history.get(query), ctx()).rejects.toThrow(RangeError);
            continue;
          }
          const h = await world.db.history.get(query);
          check(h.event.id === event.id, () => `${ctx()}: wrong event ${h.event.id}`);
          expect(h.window, ctx()).toEqual(w);
          checkHistoryInvariants(h, spec, ctx);

          // Exact oracle: which points/decisions/outcomes must be present.
          expect(streamIds(h.context), ctx()).toEqual(groupIds(expectedPoints(world, event, spec, w, w.contextUntil)));
          expect(streamIds(h.timeline), ctx()).toEqual(groupIds(expectedPoints(world, event, spec, w, w.outcomeUntil)));
          expect(h.decisions.map((d) => d.id), ctx()).toEqual(
            world.decisions.filter((d) => d.eventId === event.id && d.timestamp <= w.outcomeUntil).sort(byTsId()).map((d) => d.id),
          );
          expect(h.outcomes.map((o) => o.id), ctx()).toEqual(
            world.outcomes.filter((o) => o.eventId === event.id && o.timestamp <= w.outcomeUntil).sort(byTsId()).map((o) => o.id),
          );
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. history.getMany == [history.get(id) ...] for random id lists
// ---------------------------------------------------------------------------

describe("fuzz: history.getMany matches history.get per id", () => {
  for (const seed of seeds(2000)) {
    it(`seed ${seed}`, async () => {
      await withWorld(seed, async (world, rng) => {
        for (let q = 0; q < 4; q++) {
          const known = new Map(world.events.map((e) => [e.id, e]));
          const eventIds = Array.from({ length: rng.int(0, 12) }, () =>
            rng.bool(0.15) ? `nope${rng.int(0, 3)}` : rng.pick(world.events).id,
          );
          // Same spec for the whole batch; oracle resolves it per event because defaults depend on the event.
          const spec = randomWindowSpec(rng, world.events[0]!);
          const opts = toWindowOptions(spec, rng);
          const ctx = () => `seed=${seed} eventIds=${describeQuery(eventIds)} opts=${describeQuery(opts)}`;

          const uniqueKnown = [...new Set(eventIds)].map((id) => known.get(id)).filter((e): e is Event => e !== undefined);
          const anyRejected = uniqueKnown.some((e) => resolveWindow(spec, e) === null);
          if (anyRejected) {
            await expect(world.db.history.getMany({ eventIds, ...opts }), ctx()).rejects.toThrow(RangeError);
            continue;
          }
          const many = await world.db.history.getMany({ eventIds, ...opts });
          const singles: History[] = [];
          for (const e of uniqueKnown) singles.push(await world.db.history.get({ eventId: e.id, ...opts }));
          expect(many, ctx()).toEqual(singles);
          expect(many.map((h) => h.event.id), ctx()).toEqual(uniqueKnown.map((e) => e.id));
          for (const id of eventIds.filter((x) => x.startsWith("nope"))) {
            await expect(world.db.history.get({ eventId: id, ...opts }), ctx()).rejects.toThrow(/not found/);
          }
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 3. events.similar: brute-force top-k oracle
// ---------------------------------------------------------------------------

describe("fuzz: events.similar returns a valid filtered top-k", () => {
  for (const seed of seeds(3000)) {
    it(`seed ${seed}`, async () => {
      await withWorld(seed, async (world, rng) => {
        const withEmbedding = world.events.filter((e) => world.embeddings.has(e.id));
        for (let q = 0; q < 6; q++) {
          // Query form: id | { id } | { id, embedding } | bare vector (array or Float32Array).
          let queryEvent: SimilarQuery["event"];
          let vector: Float32Array;
          let selfId: string | undefined;
          const form = withEmbedding.length ? rng.int(0, 4) : 4;
          if (form === 0 || form === 1) {
            const e = rng.pick(withEmbedding);
            queryEvent = form === 0 ? e.id : { id: e.id };
            vector = world.embeddings.get(e.id)!;
            selfId = e.id;
          } else if (form === 2) {
            const e = rng.pick(world.events);
            vector = Float32Array.from(randomVector(rng, world.dim));
            queryEvent = { id: e.id, embedding: Array.from(vector) };
            selfId = e.id;
          } else if (form === 3) {
            vector = Float32Array.from(randomVector(rng, world.dim));
            queryEvent = { id: "nope", embedding: vector };
          } else {
            vector = Float32Array.from(randomVector(rng, rng.bool(0.15) ? world.dim + 1 : world.dim));
            queryEvent = rng.bool() ? Array.from(vector) : vector;
          }
          const { filters, matches } = randomEventFilters(rng, world);
          const limit = rng.bool(0.3) ? undefined : rng.int(1, 6);
          const minScore = rng.bool(0.4) ? rng.pick([-0.3, 0, 0.3, 0.9, 0.99]) : undefined;
          const query: SimilarQuery = {
            event: queryEvent,
            ...(limit !== undefined ? { limit } : {}),
            ...(minScore !== undefined ? { minScore } : {}),
            filters,
          };
          const ctx = () => `seed=${seed} query=${describeQuery(query)}`;

          // Oracle: every candidate passing the SQL-side filters, scored in-process.
          const candidates = world.events
            .filter((e) => e.id !== selfId && matches(e))
            .flatMap((e) => {
              const emb = world.embeddings.get(e.id);
              if (!emb || emb.length !== vector.length) return [];
              const score = cosineOracle(vector, emb);
              return minScore !== undefined && score < minScore ? [] : [{ id: e.id, score }];
            })
            .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
          const k = limit ?? 20;
          const topK = candidates.slice(0, k);
          const oracleScore = new Map(candidates.map((c) => [c.id, c.score]));

          const hits = await world.db.events.similar(query);
          check(hits.length === topK.length, () => `${ctx()}: expected ${topK.length} hits, got ${hits.length}: ${describeQuery(hits.map((h) => [h.id, h.score]))}`);
          const seen = new Set<string>();
          for (let i = 0; i < hits.length; i++) {
            const h = hits[i]!;
            check(!seen.has(h.id), () => `${ctx()}: duplicate hit ${h.id}`);
            seen.add(h.id);
            check(h.id !== selfId, () => `${ctx()}: query event returned as its own neighbour`);
            const expected = oracleScore.get(h.id);
            check(expected !== undefined, () => `${ctx()}: hit ${h.id} is not a candidate`);
            check(Math.abs(h.score - expected) < SCORE_EPS, () => `${ctx()}: hit ${h.id} score ${h.score} != oracle ${expected}`);
            check(i === 0 || hits[i - 1]!.score >= h.score, () => `${ctx()}: hits not sorted descending at ${h.id}`);
            // Score multiset must equal the oracle's top-k (ties may be broken either way).
            check(Math.abs(h.score - topK[i]!.score) < SCORE_EPS, () => `${ctx()}: score at rank ${i} is ${h.score}, oracle top-k has ${topK[i]!.score}`);
            // Payload matches the stored event.
            const ev = world.events.find((e) => e.id === h.id)!;
            expect({ id: h.id, timestamp: h.timestamp, observedAt: h.observedAt, type: h.type, entities: h.entities, metadata: h.metadata }, ctx()).toEqual({
              id: ev.id, timestamp: ev.timestamp, observedAt: ev.observedAt, type: ev.type, entities: ev.entities, metadata: ev.metadata,
            });
          }
          // Nothing left out scores strictly higher than something returned.
          const worst = hits.length ? hits[hits.length - 1]!.score : Infinity;
          for (const c of candidates) {
            if (seen.has(c.id)) continue;
            check(c.score <= worst + SCORE_EPS, () => `${ctx()}: candidate ${c.id} (score ${c.score}) beats returned worst ${worst} but was omitted`);
          }
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Pagination oracles: events.list and timeline.range
// ---------------------------------------------------------------------------

async function walkPages<T>(
  fetch: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  limit: number,
  ctx: () => string,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetch(cursor);
    pages++;
    check(pages <= 10_000, () => `${ctx()}: pagination did not terminate`);
    check(page.items.length <= limit, () => `${ctx()}: page ${pages} has ${page.items.length} > limit ${limit}`);
    check(pages === 1 || page.items.length > 0, () => `${ctx()}: empty page ${pages} after a nextCursor`);
    check(!page.nextCursor || page.items.length === limit, () => `${ctx()}: page ${pages} is short (${page.items.length} < ${limit}) yet has a nextCursor`);
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

describe("fuzz: events.list pagination yields every matching event once, in order", () => {
  for (const seed of seeds(4000)) {
    it(`seed ${seed}`, async () => {
      await withWorld(seed, async (world, rng) => {
        for (let q = 0; q < 5; q++) {
          const { filters, matches } = randomEventFilters(rng, world);
          const order = rng.bool() ? ("asc" as const) : ("desc" as const);
          const limit = rng.bool(0.15) ? undefined : rng.int(1, 7);
          const ctx = () => `seed=${seed} list=${describeQuery({ filters, order, limit })}`;
          const items = await walkPages(
            (cursor) =>
              world.db.events.list({
                filters,
                ...(rng.bool() ? { order } : order === "desc" ? { order } : {}), // asc may also be the default
                ...(limit !== undefined ? { limit } : {}),
                ...(cursor ? { cursor } : {}),
              }),
            limit ?? 100,
            ctx,
          );
          const expected = world.events.filter(matches).sort(byTsId(order === "asc" ? 1 : -1));
          expect(items.map((e) => e.id), ctx()).toEqual(expected.map((e) => e.id));
          expect(items, ctx()).toEqual(expected);
        }
      });
    });
  }
});

describe("fuzz: timeline.range pagination yields every matching point once, in order", () => {
  for (const seed of seeds(5000)) {
    it(`seed ${seed}`, async () => {
      await withWorld(seed, async (world, rng) => {
        for (let q = 0; q < 5; q++) {
          const from = rng.ts();
          const to = rng.bool(0.1) ? from - STEP : from + rng.int(0, 60) * STEP; // occasionally an empty window
          const entity = rng.bool(0.6) ? rng.oneOrMany([...ENTITIES, "Z"]) : undefined;
          const namespace = rng.bool(0.5) ? rng.oneOrMany(NAMESPACES) : undefined;
          const asOf = rng.bool(0.5) ? to + rng.int(-4, 20) * STEP : undefined;
          const limit = rng.bool(0.15) ? undefined : rng.int(1, 9);
          const base = {
            from: rng.tsInput(from),
            to: rng.tsInput(to),
            ...(entity ? { entity: entity.input } : {}),
            ...(namespace ? { namespace: namespace.input } : {}),
            ...(asOf !== undefined ? { asOf: rng.tsInput(asOf) } : {}),
            ...(limit !== undefined ? { limit } : {}),
          };
          const ctx = () => `seed=${seed} range=${describeQuery(base)}`;
          const items = await walkPages(
            (cursor) => world.db.timeline.range({ ...base, ...(cursor ? { cursor } : {}) }),
            limit ?? 1000,
            ctx,
          );
          const expected = world.points
            .filter(
              (p) =>
                p.timestamp >= from &&
                p.timestamp <= to &&
                (asOf === undefined || p.observedAt <= asOf) &&
                (!entity || entity.values.length === 0 || entity.values.includes(p.entity)) &&
                (!namespace || namespace.values.length === 0 || namespace.values.includes(p.namespace)),
            )
            .sort(byTsId());
          expect(items.map((p) => p.id), ctx()).toEqual(expected.map((p) => p.id));
          expect(items, ctx()).toEqual(expected);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 5. timeline.around == history.get(...).timeline for the same window/asOf
// ---------------------------------------------------------------------------

describe("fuzz: timeline.around agrees with history.get(...).timeline", () => {
  for (const seed of seeds(6000)) {
    it(`seed ${seed}`, async () => {
      await withWorld(seed, async (world, rng) => {
        for (let q = 0; q < 6; q++) {
          const event = rng.pick(world.events);
          const spec = randomWindowSpec(rng, event);
          // `around` has no 7d default: pass explicit durations, and use the same cutoff for both views.
          const before = spec.before ?? DURATIONS[0]!;
          const after = spec.after ?? DURATIONS[0]!;
          const asOf = rng.bool(0.7) ? event.timestamp + rng.int(-8, 120) * STEP : undefined;
          const cutoff = asOf ?? FAR_FUTURE;
          const shared = {
            eventId: event.id,
            before: before.input,
            after: after.input,
            ...(spec.entities ? { entities: spec.entities.input } : {}),
            ...(spec.namespace ? { namespace: spec.namespace.input } : {}),
          };
          const ctx = () => `seed=${seed} around=${describeQuery({ ...shared, asOf })}`;

          const around = await world.db.timeline.around({ ...shared, ...(asOf !== undefined ? { asOf: rng.tsInput(asOf) } : {}) });
          const h = await world.db.history.get({ ...shared, contextUntil: cutoff, outcomeUntil: rng.tsInput(cutoff) });
          expect(around, ctx()).toEqual(h.timeline);

          // Both must also equal the brute-force window.
          const w = { from: event.timestamp - before.ms, to: event.timestamp + after.ms };
          expect(streamIds(around), ctx()).toEqual(groupIds(expectedPoints(world, event, spec, w, cutoff)));
        }
      });
    });
  }
});

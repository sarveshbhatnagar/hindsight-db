import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionGraph, openDatabase, parseDuration, windowAround } from "../src/index.js";
import type { Event, History, TimelinePoint } from "../src/index.js";

/**
 * Spec-conformance tests: every code snippet and stated behaviour in
 * design.md, taken literally and exercised through the public API as the
 * "application developer" described there would use it.
 *
 * Scenario: an AAPL earnings beat, with market / news / macro / signals /
 * positions streams around it, one decision made an hour after the print,
 * and outcomes attached later at several horizons.
 *
 * Tests under "design-implied behaviour" are written the way design.md
 * implies and are allowed to fail; each carries a note explaining the gap.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Event time: AAPL reports after the close on 2024-02-01.
const E = Date.UTC(2024, 1, 1, 21, 30);
// Decision time: one hour after the print.
const D = E + HOUR;
// Daily closes land at 21:00Z, i.e. the day-0 close is 30 minutes before the event.
const close = (k: number) => Date.UTC(2024, 1, 1, 21, 0) + k * DAY;

interface Scenario {
  event: Event;
  decisionId: string;
  lateDecisionId: string;
}

/** Seed the AAPL earnings scenario. Returns the ids the tests refer to. */
async function seedAapl(db: ActionGraph): Promise<Scenario> {
  const event = await db.events.insert({
    id: "aapl-q1-2024",
    timestamp: E,
    type: "earnings",
    entities: ["AAPL"],
    content: "AAPL beats on revenue and EPS; guides up for Q2",
    embedding: [0.9, 0.1, 0.0, 0.0],
    metadata: { ticker: "AAPL", sector: "tech", surprise: 0.12 },
  });

  const points = [];
  // market: daily closes for AAPL and a noise ticker from -40d .. +30d.
  for (let k = -40; k <= 30; k++) {
    points.push({ timestamp: close(k), entity: "AAPL", namespace: "market", data: { k, close: 180 + k * 0.5 } });
    points.push({ timestamp: close(k), entity: "MSFT", namespace: "market", data: { k, close: 400 + k } });
  }
  // news: two pre-event items, the headline 30 min after the print, one two days later.
  points.push({ timestamp: E - 5 * DAY, entity: "AAPL", namespace: "news", data: { headline: "Analysts expect strong iPhone quarter" } });
  points.push({ timestamp: E - 1 * DAY, entity: "AAPL", namespace: "news", data: { headline: "Options imply 4% move" } });
  points.push({ timestamp: E + 30 * MIN, entity: "AAPL", namespace: "news", data: { headline: "AAPL beats; shares up 3% after hours" } });
  points.push({ timestamp: E + 2 * DAY, entity: "AAPL", namespace: "news", data: { headline: "Upgrades roll in" } });
  // macro: a CPI print three days before the event, plus a revision that was
  // only *published* the day after the event (event time unchanged).
  points.push({ timestamp: E - 3 * DAY, entity: "AAPL", namespace: "macro", data: { cpi: 3.1, revision: "initial" } });
  points.push({ timestamp: E - 3 * DAY, observedAt: E + 1 * DAY, entity: "AAPL", namespace: "macro", data: { cpi: 3.3, revision: "revised" } });
  // signals and positions the day before.
  points.push({ timestamp: E - 1 * DAY, entity: "AAPL", namespace: "signals", data: { momentum: 0.7 } });
  points.push({ timestamp: E - 1 * DAY, entity: "AAPL", namespace: "positions", data: { qty: 0 } });
  // a custom namespace.
  points.push({ timestamp: E - 2 * DAY, entity: "AAPL", namespace: "custom", data: { note: "anything goes" } });
  await db.timeline.insertMany(points);

  const decision = await db.decisions.insert({
    eventId: event.id,
    timestamp: D,
    action: { side: "buy", qty: 100 },
    metadata: { strategy: "post-earnings-drift" },
  });
  // A second, later decision (add to position a week on).
  const late = await db.decisions.insert({ eventId: event.id, timestamp: E + 7 * DAY, action: { side: "buy", qty: 50 } });

  return { event, decisionId: decision.id, lateDecisionId: late.id };
}

/** Attach outcomes "later once they become known". */
async function attachOutcomes(db: ActionGraph, s: Scenario) {
  await db.outcomes.insertMany([
    { eventId: s.event.id, decisionId: s.decisionId, horizon: "1d", result: { return: 0.031 } },
    { eventId: s.event.id, decisionId: s.decisionId, horizon: "5d", result: { return: 0.052 } },
    { eventId: s.event.id, decisionId: s.decisionId, horizon: "20d", result: { return: 0.08 } },
  ]);
}

const flatten = (streams: Record<string, TimelinePoint[]>): TimelinePoint[] => Object.values(streams).flat();
const ks = (pts: TimelinePoint[] | undefined) => (pts ?? []).map((p) => (p.data as { k: number }).k);
const headlines = (pts: TimelinePoint[] | undefined) => (pts ?? []).map((p) => (p.data as { headline: string }).headline);

let db: ActionGraph;
beforeEach(() => {
  db = openDatabase();
});
afterEach(() => db.close());

// ---------------------------------------------------------------------------
// SDK surface
// ---------------------------------------------------------------------------

describe("SDK primitives (design.md § SDK / MVP API Surface)", () => {
  it("exposes db.events, db.timeline, db.decisions, db.outcomes, db.history", () => {
    expect(db.events).toBeDefined();
    expect(db.timeline).toBeDefined();
    expect(db.decisions).toBeDefined();
    expect(db.outcomes).toBeDefined();
    expect(db.history).toBeDefined();
  });

  it("exposes every MVP method as a function", () => {
    expect(typeof db.events.insert).toBe("function");
    expect(typeof db.events.similar).toBe("function");
    expect(typeof db.timeline.insert).toBe("function");
    expect(typeof db.timeline.range).toBe("function");
    expect(typeof db.timeline.around).toBe("function");
    expect(typeof db.decisions.insert).toBe("function");
    expect(typeof db.outcomes.insert).toBe("function");
    expect(typeof db.history.get).toBe("function");
    expect(typeof db.history.getMany).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 1. Event storage
// ---------------------------------------------------------------------------

describe("1. Event Storage", () => {
  it("accepts the exact insert shape { id, timestamp, type, entities, content, embedding, metadata }", async () => {
    const ev = await db.events.insert({
      id: "ev-1",
      timestamp: E,
      type: "earnings",
      entities: ["AAPL"],
      content: "AAPL beats",
      embedding: [1, 0],
      metadata: { surprise: 0.12 },
    });
    expect(ev.id).toBe("ev-1");
    expect(ev.timestamp).toBe(E);
    expect(ev.type).toBe("earnings");
    expect(ev.entities).toEqual(["AAPL"]);
    expect(ev.content).toBe("AAPL beats");
    expect(ev.metadata).toEqual({ surprise: 0.12 });
    expect(await db.events.get("ev-1")).toMatchObject({ id: "ev-1", timestamp: E, type: "earnings" });
  });

  it("stores structured and unstructured events", async () => {
    await db.events.insert({ id: "u", timestamp: E, type: "note", content: "free text, unicode: 苹果 📈" });
    await db.events.insert({
      id: "s",
      timestamp: E,
      type: "filing",
      content: { form: "10-Q", items: [{ line: "revenue", value: 119.6e9 }], flags: { restated: false, note: null } },
    });
    expect((await db.events.get("u"))!.content).toBe("free text, unicode: 苹果 📈");
    expect((await db.events.get("s"))!.content).toEqual({
      form: "10-Q",
      items: [{ line: "revenue", value: 119.6e9 }],
      flags: { restated: false, note: null },
    });
  });

  describe("filtering", () => {
    beforeEach(async () => {
      await db.events.insertMany([
        { id: "a", timestamp: E - 90 * DAY, type: "earnings", entities: ["AAPL"], embedding: [1, 0], metadata: { sector: "tech", surprise: 0.1 } },
        { id: "b", timestamp: E - 60 * DAY, type: "earnings", entities: ["MSFT", "NASDAQ"], embedding: [0.9, 0.1], metadata: { sector: "tech", surprise: -0.05 } },
        { id: "c", timestamp: E - 30 * DAY, type: "guidance", entities: ["XOM"], embedding: [0.8, 0.2], metadata: { sector: "energy" } },
        { id: "d", timestamp: E + 10 * DAY, type: "earnings", entities: ["AAPL"], embedding: [1, 0.05], metadata: { sector: "tech" } },
      ]);
    });

    it("supports metadata filtering", async () => {
      const hits = await db.events.similar({ event: [1, 0], filters: { metadata: { sector: "energy" } } });
      expect(hits.map((h) => h.id)).toEqual(["c"]);
      const list = await db.events.list({ filters: { metadata: { sector: "tech" } } });
      expect(list.items.map((e) => e.id).sort()).toEqual(["a", "b", "d"]);
    });

    it("supports entity filtering", async () => {
      const hits = await db.events.similar({ event: [1, 0], filters: { entities: "NASDAQ" } });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
      const list = await db.events.list({ filters: { entities: ["AAPL"] } });
      expect(list.items.map((e) => e.id)).toEqual(["a", "d"]);
    });

    it("supports timestamp filtering", async () => {
      const list = await db.events.list({ filters: { from: E - 70 * DAY, to: E } });
      expect(list.items.map((e) => e.id)).toEqual(["b", "c"]);
      const hits = await db.events.similar({ event: [1, 0], filters: { to: E } });
      expect(hits.map((h) => h.id)).not.toContain("d");
    });

    it("supports vector similarity search ordered by score", async () => {
      const hits = await db.events.similar({ event: [1, 0], limit: 10 });
      expect(hits.map((h) => h.id)).toEqual(["a", "d", "b", "c"]);
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Timeline storage
// ---------------------------------------------------------------------------

describe("2. Timeline Storage", () => {
  it("accepts the exact insert shape { timestamp, entity, namespace, data }", async () => {
    const p = await db.timeline.insert({ timestamp: close(-1), entity: "AAPL", namespace: "market", data: { close: 180.1 } });
    expect(p).toMatchObject({ timestamp: close(-1), entity: "AAPL", namespace: "market", data: { close: 180.1 } });
  });

  it("stores timeline data independently of events (no event needed)", async () => {
    // No events exist at all.
    await db.timeline.insert({ timestamp: close(0), entity: "AAPL", namespace: "market", data: { close: 1 } });
    const page = await db.timeline.range({ entity: "AAPL", from: close(-1), to: close(1) });
    expect(page.items).toHaveLength(1);
  });

  it("supports every namespace listed in the design plus custom ones", async () => {
    const s = await seedAapl(db);
    const streams = await db.timeline.around({ eventId: s.event.id, before: "7d", after: "1d" });
    for (const ns of ["market", "news", "macro", "signals", "positions", "custom"]) {
      expect(streams[ns], `namespace ${ns}`).toBeDefined();
      expect(streams[ns]!.length).toBeGreaterThan(0);
      for (const p of streams[ns]!) expect(p.namespace).toBe(ns);
    }
  });

  it("can query any historical window with absolute bounds", async () => {
    const s = await seedAapl(db);
    const page = await db.timeline.range({ entity: "AAPL", namespace: "market", from: s.event.timestamp - 7 * DAY, to: s.event.timestamp + 1 * DAY });
    // Closes land at 21:00 and the event is at 21:30, so k=-7 is 30 min before `from` and k=+1 is 30 min before `to`.
    expect(ks(page.items)).toEqual([-6, -5, -4, -3, -2, -1, 0, 1]);
    for (const p of page.items) {
      expect(p.timestamp).toBeGreaterThanOrEqual(s.event.timestamp - 7 * DAY);
      expect(p.timestamp).toBeLessThanOrEqual(s.event.timestamp + 1 * DAY);
      expect(p.entity).toBe("AAPL");
    }
  });

  describe("the design's `event.timestamp - \"7d\"` arithmetic", () => {
    it("(letter) fails loudly rather than silently returning a bad window", async () => {
      const s = await seedAapl(db);
      // JS evaluates `number - "7d"` to NaN and `number + "1d"` to "…1d".
      const from = s.event.timestamp - ("7d" as unknown as number);
      const to = s.event.timestamp + ("1d" as unknown as number);
      expect(Number.isNaN(from)).toBe(true);
      await expect(db.timeline.range({ entity: "AAPL", from, to })).rejects.toThrow(/Invalid timestamp/);
    });

    it("(ergonomic) parseDuration makes the design's intent expressible", async () => {
      const s = await seedAapl(db);
      const page = await db.timeline.range({
        entity: "AAPL",
        namespace: "market",
        from: s.event.timestamp - parseDuration("7d"),
        to: s.event.timestamp + parseDuration("1d"),
      });
      expect(ks(page.items)).toEqual([-6, -5, -4, -3, -2, -1, 0, 1]);
    });

    it("(ergonomic) windowAround spreads straight into range()", async () => {
      const s = await seedAapl(db);
      const page = await db.timeline.range({ entity: "AAPL", namespace: "market", ...windowAround(s.event.timestamp, "7d", "1d") });
      expect(ks(page.items)).toEqual([-6, -5, -4, -3, -2, -1, 0, 1]);
      // Note: windowAround takes |before| and |after|; "-7d" and "7d" are the same window.
      expect(windowAround(E, "-7d", "1d")).toEqual(windowAround(E, "7d", "1d"));
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Actions and outcomes
// ---------------------------------------------------------------------------

describe("3. Actions and Outcomes", () => {
  it("accepts the exact decisions.insert shape { eventId, timestamp, action, metadata }", async () => {
    const s = await seedAapl(db);
    const d = await db.decisions.insert({ eventId: s.event.id, timestamp: D, action: "hold", metadata: { reason: "wait for guidance" } });
    expect(d).toMatchObject({ eventId: s.event.id, timestamp: D, action: "hold", metadata: { reason: "wait for guidance" } });
    expect(typeof d.id).toBe("string");
  });

  it("accepts the exact outcomes.insert shape { eventId, decisionId, horizon, result }", async () => {
    const s = await seedAapl(db);
    const o = await db.outcomes.insert({ eventId: s.event.id, decisionId: s.decisionId, horizon: "1d", result: { return: 0.031 } });
    expect(o).toMatchObject({ eventId: s.event.id, decisionId: s.decisionId, horizon: "1d", horizonMs: DAY, result: { return: 0.031 } });
  });

  it("stores decisions independently from outcomes: outcomes can be attached later and history reflects them", async () => {
    const s = await seedAapl(db);

    const before = await db.history.get({ eventId: s.event.id, before: "7d", after: "30d" });
    expect(before.decisions.map((d) => d.id)).toEqual([s.decisionId, s.lateDecisionId]);
    expect(before.outcomes).toEqual([]);

    // ... time passes, results become known ...
    await attachOutcomes(db, s);

    const after = await db.history.get({ eventId: s.event.id, before: "7d", after: "30d" });
    expect(after.outcomes.map((o) => o.horizon)).toEqual(["1d", "5d", "20d"]);
    expect(after.outcomes.every((o) => o.decisionId === s.decisionId)).toBe(true);
  });

  it("derives outcome time (when the result became observable) from the decision time + horizon", async () => {
    const s = await seedAapl(db);
    await attachOutcomes(db, s);
    const outcomes = await db.outcomes.forEvent(s.event.id);
    expect(outcomes.map((o) => o.timestamp)).toEqual([D + 1 * DAY, D + 5 * DAY, D + 20 * DAY]);
  });

  it("anchors an outcome without a decision at the event time", async () => {
    const s = await seedAapl(db);
    const o = await db.outcomes.insert({ eventId: s.event.id, horizon: "5d", result: { drift: 0.04 } });
    expect(o.decisionId).toBeNull();
    expect(o.timestamp).toBe(E + 5 * DAY);
  });

  it("rejects an outcome attached to a decision of a different event", async () => {
    const s = await seedAapl(db);
    await db.events.insert({ id: "other", timestamp: E, type: "earnings" });
    await expect(
      db.outcomes.insert({ eventId: "other", decisionId: s.decisionId, horizon: "1d", result: 1 }),
    ).rejects.toThrow(/belongs to event/);
  });
});

// ---------------------------------------------------------------------------
// Retrieval APIs
// ---------------------------------------------------------------------------

describe("Similar Event Search", () => {
  beforeEach(async () => {
    await db.events.insertMany(
      Array.from({ length: 12 }, (_, i) => ({
        id: `h-${i}`,
        timestamp: E - (i + 1) * 30 * DAY,
        type: i % 4 === 0 ? "guidance" : "earnings",
        entities: [i % 2 === 0 ? "AAPL" : "MSFT"],
        embedding: [Math.cos(i / 12), Math.sin(i / 12), 0, 0],
        metadata: { sector: "tech", i },
      })),
    );
  });

  it("returns event IDs, similarity scores, metadata, and timestamps", async () => {
    const hits = await db.events.similar({ event: [1, 0, 0, 0], limit: 5, filters: {} });
    expect(hits).toHaveLength(5);
    for (const h of hits) {
      expect(typeof h.id).toBe("string");
      expect(typeof h.score).toBe("number");
      expect(h.score).toBeGreaterThanOrEqual(-1);
      expect(h.score).toBeLessThanOrEqual(1);
      expect(typeof h.timestamp).toBe("number");
      expect(h.metadata).toEqual(expect.objectContaining({ sector: "tech" }));
    }
    expect(hits[0]!.id).toBe("h-0");
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it("accepts the design's `event: currentEvent` form for an event that is not stored yet", async () => {
    const currentEvent = {
      id: "aapl-live",
      timestamp: Date.now(),
      type: "earnings",
      entities: ["AAPL"],
      content: "AAPL just reported",
      embedding: [1, 0, 0, 0],
      metadata: {},
    };
    const hits = await db.events.similar({ event: currentEvent, limit: 20 });
    expect(hits.length).toBe(12);
    expect(hits[0]!.id).toBe("h-0");
  });

  it("accepts a stored event (as returned by insert) and excludes it from its own results", async () => {
    const stored = await db.events.insert({ id: "self", timestamp: E, type: "earnings", embedding: [1, 0, 0, 0] });
    const hits = await db.events.similar({ event: stored, limit: 20 });
    expect(hits.map((h) => h.id)).not.toContain("self");
    const byId = await db.events.similar({ event: "self", limit: 20 });
    expect(byId.map((h) => h.id)).toEqual(hits.map((h) => h.id));
  });

  it("honours limit and combined filters", async () => {
    const hits = await db.events.similar({
      event: [1, 0, 0, 0],
      limit: 3,
      filters: { type: "earnings", entities: "AAPL", to: E - 100 * DAY },
    });
    expect(hits.length).toBeLessThanOrEqual(3);
    for (const h of hits) {
      expect(h.type).toBe("earnings");
      expect(h.entities).toContain("AAPL");
      expect(h.timestamp).toBeLessThanOrEqual(E - 100 * DAY);
    }
  });

  it("can be made backtest-safe with asOf so events observed later are not candidates", async () => {
    // A filing dated before `now` but only published afterwards.
    await db.events.insert({ id: "late", timestamp: E - 400 * DAY, observedAt: E + DAY, type: "earnings", embedding: [1, 0, 0, 0] });
    const unsafe = await db.events.similar({ event: [1, 0, 0, 0], limit: 50 });
    expect(unsafe.map((h) => h.id)).toContain("late");
    const safe = await db.events.similar({ event: [1, 0, 0, 0], limit: 50, filters: { asOf: E } });
    expect(safe.map((h) => h.id)).not.toContain("late");
  });
});

describe("Timeline Lookup: db.timeline.around({ eventId, before, after })", () => {
  it("returns all relevant timeline streams around the event, grouped by namespace", async () => {
    const s = await seedAapl(db);
    const streams = await db.timeline.around({ eventId: s.event.id, before: "7d", after: "1d" });
    expect(Object.keys(streams).sort()).toEqual(["custom", "macro", "market", "news", "positions", "signals"]);
    // Only the event's own entity, not MSFT.
    for (const p of flatten(streams)) expect(p.entity).toBe("AAPL");
    expect(ks(streams.market)).toEqual([-6, -5, -4, -3, -2, -1, 0, 1]);
    expect(headlines(streams.news)).toEqual(["Analysts expect strong iPhone quarter", "Options imply 4% move", "AAPL beats; shares up 3% after hours"]);
    // Both the initial and revised macro print are in the window (no asOf given).
    expect(streams.macro!.map((p) => (p.data as { revision: string }).revision)).toEqual(["initial", "revised"]);
  });

  it("rejects an unknown event id", async () => {
    await expect(db.timeline.around({ eventId: "nope", before: "7d", after: "1d" })).rejects.toThrow(/not found/);
  });
});

describe("Historical Record: db.history.get({ eventId, before, after })", () => {
  it("responds with { event, context, decisions, timeline, outcomes }", async () => {
    const s = await seedAapl(db);
    await attachOutcomes(db, s);
    const h = await db.history.get({ eventId: s.event.id, before: "7d", after: "5d" });
    for (const key of ["event", "context", "decisions", "timeline", "outcomes"]) expect(h).toHaveProperty(key);
    expect(h.event.id).toBe(s.event.id);
    expect(Array.isArray(h.decisions)).toBe(true);
    expect(Array.isArray(h.outcomes)).toBe(true);
    expect(typeof h.context).toBe("object");
    expect(typeof h.timeline).toBe("object");
  });

  it("reconstructs the Timeline [-30d, +5d] view from the architecture diagram", async () => {
    const s = await seedAapl(db);
    await attachOutcomes(db, s);
    const h = await db.history.get({ eventId: s.event.id, before: "30d", after: "5d" });
    expect(ks(h.timeline.market)).toEqual(Array.from({ length: 35 }, (_, i) => i - 29)); // k=-30 closes 30 min before `from`
    expect(h.window.from).toBe(E - 30 * DAY);
    expect(h.window.to).toBe(E + 5 * DAY);
    // Decisions and outcomes observable within the window.
    expect(h.decisions.map((d) => d.id)).toEqual([s.decisionId]);
    expect(h.outcomes.map((o) => o.horizon)).toEqual(["1d"]); // 5d outcome lands at D+5d, an hour past the window
  });

  it("`context` is what was known at event time; `timeline` is the full window", async () => {
    const s = await seedAapl(db);
    const h = await db.history.get({ eventId: s.event.id, before: "7d", after: "5d" });
    // Context: nothing after the event's observation time.
    for (const p of flatten(h.context)) expect(p.observedAt).toBeLessThanOrEqual(s.event.observedAt);
    expect(ks(h.context.market)).toEqual([-6, -5, -4, -3, -2, -1, 0]);
    expect(headlines(h.context.news)).toEqual(["Analysts expect strong iPhone quarter", "Options imply 4% move"]);
    expect(h.context.macro!.map((p) => (p.data as { revision: string }).revision)).toEqual(["initial"]);
    // Timeline: the whole [-7d, +5d] window, including what came out afterwards.
    expect(ks(h.timeline.market)).toEqual([-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
    expect(headlines(h.timeline.news)).toHaveLength(4);
    expect(h.timeline.macro!.map((p) => (p.data as { revision: string }).revision)).toEqual(["initial", "revised"]);
  });

  it("rejects an unknown event id", async () => {
    await expect(db.history.get({ eventId: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("Parallel Historical Retrieval: db.history.getMany({ eventIds, before, after })", () => {
  it("returns one history per id, in input order, identical to individual gets", async () => {
    const s = await seedAapl(db);
    await attachOutcomes(db, s);
    await db.events.insert({ id: "msft", timestamp: E - 3 * DAY, type: "earnings", entities: ["MSFT"] });
    const many = await db.history.getMany({ eventIds: ["msft", s.event.id], before: "7d", after: "5d" });
    const singles = await Promise.all(
      ["msft", s.event.id].map((eventId) => db.history.get({ eventId, before: "7d", after: "5d" })),
    );
    expect(many).toEqual(singles);
    expect(many.map((h) => h.event.id)).toEqual(["msft", s.event.id]);
  });

  it("omits unknown ids rather than throwing (caller must diff eventIds against results)", async () => {
    const s = await seedAapl(db);
    const many = await db.history.getMany({ eventIds: ["ghost", s.event.id], before: "7d" });
    expect(many.map((h) => h.event.id)).toEqual([s.event.id]);
  });
});

// ---------------------------------------------------------------------------
// Important Data Boundary
// ---------------------------------------------------------------------------

describe("Important Data Boundary (observation / event / outcome time)", () => {
  it("every record distinguishes event time from observation time; outcomes carry outcome time", async () => {
    const ev = await db.events.insert({ id: "f", timestamp: E - 3 * DAY, observedAt: E, type: "filing" });
    expect(ev.timestamp).toBe(E - 3 * DAY);
    expect(ev.observedAt).toBe(E);
    const p = await db.timeline.insert({ timestamp: E - 3 * DAY, observedAt: E + DAY, entity: "AAPL", namespace: "macro", data: 1 });
    expect(p.observedAt).toBe(E + DAY);
    const d = await db.decisions.insert({ eventId: "f", timestamp: E + HOUR, action: "buy" });
    const o = await db.outcomes.insert({ eventId: "f", decisionId: d.id, horizon: "2d", result: 1 });
    expect(o.timestamp).toBe(E + HOUR + 2 * DAY);
  });

  describe("the design's example: history.get({ eventId, contextUntil: decision.timestamp, outcomeUntil: decision.timestamp + \"5d\" })", () => {
    it("(letter) `decision.timestamp + \"5d\"` is string concatenation in JS and is rejected loudly", async () => {
      const s = await seedAapl(db);
      const decision = (await db.decisions.get(s.decisionId))!;
      const outcomeUntil = decision.timestamp + ("5d" as unknown as number);
      await expect(
        db.history.get({ eventId: s.event.id, contextUntil: decision.timestamp, outcomeUntil }),
      ).rejects.toThrow(/Invalid timestamp/);
    });

    it("nothing observed after decision.timestamp appears in context", async () => {
      const s = await seedAapl(db);
      await attachOutcomes(db, s);
      const decision = (await db.decisions.get(s.decisionId))!;
      const h = await db.history.get({
        eventId: s.event.id,
        after: "5d",
        contextUntil: decision.timestamp,
        outcomeUntil: decision.timestamp + parseDuration("5d"),
      });
      const ctx = flatten(h.context);
      expect(ctx.length).toBeGreaterThan(0);
      for (const p of ctx) expect(p.observedAt).toBeLessThanOrEqual(decision.timestamp);
      // Things that happened before the decision but were only known afterwards are NOT context.
      expect(headlines(h.context.news)).not.toContain("Upgrades roll in");
      expect(ks(h.context.market)).toEqual([-6, -5, -4, -3, -2, -1, 0]);
    });

    it("a data point revised after the decision does not leak into context, but is visible in the outcome view", async () => {
      const s = await seedAapl(db);
      const decision = (await db.decisions.get(s.decisionId))!;
      const h = await db.history.get({
        eventId: s.event.id,
        after: "5d",
        contextUntil: decision.timestamp,
        outcomeUntil: decision.timestamp + parseDuration("5d"),
      });
      const revisions = (pts: TimelinePoint[] | undefined) => (pts ?? []).map((p) => (p.data as { revision: string }).revision);
      expect(revisions(h.context.macro)).toEqual(["initial"]);
      expect(revisions(h.timeline.macro)).toEqual(["initial", "revised"]);
      // Same event time; only observation time differs.
      const [initial, revised] = h.timeline.macro!;
      expect(initial!.timestamp).toBe(revised!.timestamp);
      expect(revised!.observedAt).toBeGreaterThan(decision.timestamp);
    });

    it("what was known at decision time includes post-event information observed before the decision", async () => {
      const s = await seedAapl(db);
      const decision = (await db.decisions.get(s.decisionId))!;
      const h = await db.history.get({
        eventId: s.event.id,
        after: "5d",
        contextUntil: decision.timestamp,
        outcomeUntil: decision.timestamp + parseDuration("5d"),
      });
      // The headline 30 minutes after the print was known an hour after the print.
      expect(headlines(h.context.news)).toContain("AAPL beats; shares up 3% after hours");
    });

    it("outcomes and later decisions are cut at outcomeUntil", async () => {
      const s = await seedAapl(db);
      await attachOutcomes(db, s);
      const decision = (await db.decisions.get(s.decisionId))!;
      const h = await db.history.get({
        eventId: s.event.id,
        after: "5d",
        contextUntil: decision.timestamp,
        outcomeUntil: decision.timestamp + parseDuration("5d"),
      });
      expect(h.outcomes.map((o) => o.horizon)).toEqual(["1d", "5d"]); // 20d not yet observable
      expect(h.decisions.map((d) => d.id)).toEqual([s.decisionId]); // the +7d decision is in the future
      expect(h.window).toEqual({
        from: E - 7 * DAY,
        to: E + 5 * DAY,
        contextUntil: decision.timestamp,
        outcomeUntil: decision.timestamp + 5 * DAY,
      });
    });

    it("refuses a context view that would know more than the outcome view", async () => {
      const s = await seedAapl(db);
      await expect(
        db.history.get({ eventId: s.event.id, contextUntil: D + 5 * DAY, outcomeUntil: D }),
      ).rejects.toThrow(/contextUntil/);
    });
  });

  it("the default context cutoff is the event's observation time, so post-event news is not context", async () => {
    const s = await seedAapl(db);
    const h = await db.history.get({ eventId: s.event.id, before: "7d", after: "5d" });
    expect(headlines(h.context.news)).not.toContain("AAPL beats; shares up 3% after hours");
    expect(headlines(h.timeline.news)).toContain("AAPL beats; shares up 3% after hours");
  });

  it("an event observed later than it happened has context cut at its observation time", async () => {
    // A filing dated Friday, published Monday.
    await db.events.insert({ id: "filing", timestamp: E, observedAt: E + 3 * DAY, type: "filing", entities: ["AAPL"] });
    await db.timeline.insertMany([
      { timestamp: E + 1 * DAY, entity: "AAPL", namespace: "market", data: { k: 1 } },
      { timestamp: E + 1 * DAY, observedAt: E + 4 * DAY, entity: "AAPL", namespace: "market", data: { k: "late" } },
    ]);
    const h = await db.history.get({ eventId: "filing", before: "1d", after: "5d" });
    expect(ks(h.context.market)).toEqual([1]);
    expect(ks(h.timeline.market)).toEqual([1, "late" as unknown as number]);
  });
});

// ---------------------------------------------------------------------------
// Design-implied behaviour (allowed to fail; see notes)
// ---------------------------------------------------------------------------

describe("design-implied behaviour: the data-boundary example taken literally (no before/after)", () => {
  // design.md shows history.get({ eventId, contextUntil, outcomeUntil }) with
  // no `after`. A reader takes outcomeUntil as "how far forward the outcome
  // view sees". The implementation keeps the event-time window at its default
  // (after = 0), so with the literal call the post-event timeline is empty
  // and post-event information known before the decision is not context.

  it("outcome view (`timeline`) extends forward to outcomeUntil", async () => {
    const s = await seedAapl(db);
    await attachOutcomes(db, s);
    const decision = (await db.decisions.get(s.decisionId))!;
    const h = await db.history.get({
      eventId: s.event.id,
      contextUntil: decision.timestamp,
      outcomeUntil: decision.timestamp + parseDuration("5d"),
    });
    // Outcomes are cut at outcomeUntil as expected...
    expect(h.outcomes.map((o) => o.horizon)).toEqual(["1d", "5d"]);
    // ...but the "what actually happened afterward" timeline should reach D+5d too.
    expect(ks(h.timeline.market)).toContain(5);
  });

  it("context includes post-event information that was known at decision time", async () => {
    const s = await seedAapl(db);
    const decision = (await db.decisions.get(s.decisionId))!;
    const h = await db.history.get({
      eventId: s.event.id,
      contextUntil: decision.timestamp,
      outcomeUntil: decision.timestamp + parseDuration("5d"),
    });
    expect(headlines(h.context.news)).toContain("AAPL beats; shares up 3% after hours");
  });
});

// ---------------------------------------------------------------------------
// Typical application flow
// ---------------------------------------------------------------------------

describe("typical application flow (design.md § SDK)", () => {
  it("similar → application selects → history.getMany → reasoning over `history`", async () => {
    const tickers = ["AAPL", "MSFT", "NVDA", "AMZN"];
    // 24 historical earnings events over 2 years, with toy embeddings
    // [surprise, ticker one-hot...]; decisions and outcomes for each.
    const historical = Array.from({ length: 24 }, (_, i) => {
      const ticker = tickers[i % 4]!;
      const surprise = ((i % 6) - 2) / 20; // -0.10 .. 0.15
      return {
        id: `earn-${i}`,
        timestamp: E - (i + 1) * 30 * DAY,
        type: "earnings",
        entities: [ticker],
        content: `${ticker} earnings, surprise ${surprise}`,
        embedding: [surprise * 5, ...tickers.map((t) => (t === ticker ? 1 : 0))],
        metadata: { ticker, surprise },
      };
    });
    await db.events.insertMany(historical);
    const points = [];
    for (let d = -800; d <= 40; d++) {
      for (const t of tickers) points.push({ timestamp: close(d), entity: t, namespace: "market", data: { close: 100 + d * 0.1 } });
    }
    await db.timeline.insertMany(points);
    for (const e of historical) {
      const d = await db.decisions.insert({ eventId: e.id, timestamp: e.timestamp + HOUR, action: { side: e.metadata.surprise > 0 ? "buy" : "sell" } });
      await db.outcomes.insertMany([
        { eventId: e.id, decisionId: d.id, horizon: "1d", result: { return: e.metadata.surprise / 4 } },
        { eventId: e.id, decisionId: d.id, horizon: "5d", result: { return: e.metadata.surprise / 2 } },
      ]);
    }

    // The event that just happened (not stored yet).
    const currentEvent = {
      timestamp: E,
      type: "earnings",
      entities: ["AAPL"],
      content: "AAPL beats",
      embedding: [0.12 * 5, 1, 0, 0, 0],
      metadata: { ticker: "AAPL", surprise: 0.12 },
    };

    const candidates = await db.events.similar({ event: currentEvent, limit: 20 });
    expect(candidates.length).toBe(20);
    expect(candidates[0]!.metadata.ticker).toBe("AAPL"); // same ticker + positive surprise scores highest

    // Application decides which candidates it cares about.
    const selectedIds = candidates.filter((c) => c.score > 0.95).map((c) => c.id);
    expect(selectedIds.length).toBeGreaterThan(0);

    const history = await db.history.getMany({ eventIds: selectedIds, before: "14d", after: "5d" });

    // Application / agent performs reasoning over `history`.
    expect(history.map((h) => h.event.id)).toEqual(selectedIds);
    for (const h of history) {
      expect(h.event.type).toBe("earnings");
      expect(h.context.market!.length).toBe(14); // 14 pre-event closes (-13..0)
      expect(h.timeline.market!.length).toBe(19); // + 5 post-event closes
      expect(h.decisions).toHaveLength(1);
      expect(h.outcomes.map((o) => o.horizon)).toEqual(["1d"]); // 5d outcome at D+5d is 1h past the window
      for (const p of flatten(h.context)) expect(p.observedAt).toBeLessThanOrEqual(h.event.observedAt);
    }
    const avg1d = history.reduce((s, h) => s + (h.outcomes[0]!.result as { return: number }).return, 0) / history.length;
    expect(Number.isFinite(avg1d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SDK responsibilities
// ---------------------------------------------------------------------------

describe("SDK responsibilities", () => {
  describe("batching", () => {
    it("insertMany on every store is atomic", async () => {
      await expect(
        db.events.insertMany([
          { id: "ok", timestamp: E, type: "earnings" },
          { id: "bad", timestamp: "not a date", type: "earnings" },
        ]),
      ).rejects.toThrow();
      expect(await db.events.get("ok")).toBeUndefined();

      await db.events.insert({ id: "ev", timestamp: E, type: "earnings" });
      await expect(
        db.outcomes.insertMany([
          { id: "o-ok", eventId: "ev", horizon: "1d", result: 1 },
          { eventId: "ev", decisionId: "missing-decision", horizon: "1d", result: 1 },
        ]),
      ).rejects.toThrow(/Decision not found/);
      expect(await db.outcomes.get("o-ok")).toBeUndefined();
    });

    it("db.transaction wraps several writes atomically", async () => {
      expect(() =>
        db.transaction(() => {
          void db.events.insert({ id: "t1", timestamp: E, type: "x" });
          throw new Error("abort");
        }),
      ).toThrow("abort");
      expect(await db.events.get("t1")).toBeUndefined();
    });

    it("id lookups beyond the per-statement list cap are chunked transparently", async () => {
      const ids = Array.from({ length: 6000 }, (_, i) => `e${i}`);
      await db.events.insertMany(ids.map((id, i) => ({ id, timestamp: E + i, type: "x" })));
      const got = await db.events.getMany(ids);
      expect(got.map((e) => e.id)).toEqual(ids);
      const hist = await db.history.getMany({ eventIds: ids, before: "1d" });
      expect(hist).toHaveLength(6000);
    });
  });

  describe("pagination", () => {
    it("timeline.range pages with an opaque cursor and the pages concatenate to the full window", async () => {
      const s = await seedAapl(db);
      const full = await db.timeline.range({ entity: "AAPL", namespace: "market", from: E - 40 * DAY, to: E + 30 * DAY, limit: 1000 });
      expect(full.items).toHaveLength(70); // k=-39..30
      expect(full.nextCursor).toBeUndefined();

      const paged: TimelinePoint[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await db.timeline.range({ entity: "AAPL", namespace: "market", from: E - 40 * DAY, to: E + 30 * DAY, limit: 10, cursor });
        paged.push(...page.items);
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(7);
      expect(paged).toEqual(full.items);
      void s;
    });

    it("events.list pages with an opaque cursor", async () => {
      await db.events.insertMany(Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, timestamp: E + i, type: "x" })));
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await db.events.list({ limit: 10, cursor });
        ids.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => `e${i}`));
    });

    it("rejects a garbage cursor", async () => {
      await expect(db.timeline.range({ from: 0, to: 1, cursor: "!!!" })).rejects.toThrow(/cursor/i);
    });
  });

  describe("time-window normalization", () => {
    it("accepts epoch ms, ISO strings and Dates for timestamps and returns epoch ms", async () => {
      const iso = "2024-02-01T21:30:00.000Z";
      const [a, b, c] = await db.events.insertMany([
        { id: "ms", timestamp: E, type: "x" },
        { id: "iso", timestamp: iso, type: "x" },
        { id: "date", timestamp: new Date(iso), type: "x" },
      ]);
      expect(a!.timestamp).toBe(E);
      expect(b!.timestamp).toBe(E);
      expect(c!.timestamp).toBe(E);
    });

    it("accepts durations as ms or strings, and equivalent spellings resolve to the same window", async () => {
      const s = await seedAapl(db);
      const a = await db.history.get({ eventId: s.event.id, before: "2w", after: "5d" });
      const b = await db.history.get({ eventId: s.event.id, before: "14d", after: 5 * DAY });
      const c = await db.history.get({ eventId: s.event.id, before: 14 * DAY, after: "120h" });
      expect(a.window).toEqual(b.window);
      expect(a.window).toEqual(c.window);
      expect(a).toEqual(b);
      expect(parseDuration("7d")).toBe(7 * DAY);
      expect(parseDuration("500ms")).toBe(500);
    });

    it("applies defaults: before = 7d, after = 0", async () => {
      const s = await seedAapl(db);
      const h = await db.history.get({ eventId: s.event.id });
      expect(h.window.from).toBe(E - 7 * DAY);
      expect(h.window.to).toBe(E);
    });
  });

  describe("serialization", () => {
    it("round-trips JSON content, metadata, actions and results", async () => {
      const content = { text: "Q1 beat — 苹果 📈", nested: { arr: [1, 2.5, null, "x", { deep: true }] }, big: 1e21, neg: -0 };
      const ev = await db.events.insert({ id: "j", timestamp: E, type: "x", content, metadata: { tags: ["a", "b"], n: 1 } });
      const got = (await db.events.get("j"))!;
      expect(got.content).toEqual(JSON.parse(JSON.stringify(content)));
      expect(got.metadata).toEqual({ tags: ["a", "b"], n: 1 });
      const d = await db.decisions.insert({ eventId: "j", timestamp: E, action: { legs: [{ side: "buy", qty: 100 }, { side: "sell", qty: 50 }] } });
      expect((await db.decisions.get(d.id))!.action).toEqual(d.action);
      const o = await db.outcomes.insert({ eventId: "j", horizon: "1d", result: [0.1, { pnl: -12.5 }] });
      expect((await db.outcomes.get(o.id))!.result).toEqual([0.1, { pnl: -12.5 }]);
      expect(ev.content).toEqual(got.content);
    });

    it("round-trips embeddings as Float32 (exactly for float32-representable values)", async () => {
      await db.events.insert({ id: "emb", timestamp: E, type: "x", embedding: [0.5, -0.25, 1, 0.125] });
      const got = await db.events.get("emb", { includeEmbedding: true });
      expect(Array.from(got!.embedding!)).toEqual([0.5, -0.25, 1, 0.125]);
      // Not returned unless asked for.
      expect((await db.events.get("emb"))!.embedding).toBeUndefined();
    });
  });

  describe("parallel reads: getMany over 200 events × 30 days of daily data", () => {
    it("completes in under 2s and matches individual gets", async () => {
      const N = 200;
      const events = Array.from({ length: N }, (_, i) => ({
        id: `ev-${i}`,
        timestamp: E + i * HOUR, // spread over ~8 days
        type: "earnings",
        entities: [`T${i}`],
        embedding: [Math.cos(i), Math.sin(i)],
        metadata: { i },
      }));
      await db.events.insertMany(events);
      const points = [];
      for (const e of events) {
        for (let d = -35; d <= 10; d++) {
          points.push({ timestamp: e.timestamp + d * DAY, entity: e.entities[0]!, namespace: "market", data: { d, close: 100 + d } });
          if (d % 5 === 0) points.push({ timestamp: e.timestamp + d * DAY + HOUR, entity: e.entities[0]!, namespace: "news", data: { d } });
        }
      }
      await db.timeline.insertMany(points);
      const decisions = await db.decisions.insertMany(events.map((e) => ({ eventId: e.id, timestamp: e.timestamp + HOUR, action: "buy" })));
      await db.outcomes.insertMany(
        decisions.flatMap((d) => [
          { eventId: d.eventId, decisionId: d.id, horizon: "1d", result: { r: 0.01 } },
          { eventId: d.eventId, decisionId: d.id, horizon: "5d", result: { r: 0.03 } },
        ]),
      );

      const ids = events.map((e) => e.id);
      const t0 = performance.now();
      const many = await db.history.getMany({ eventIds: ids, before: "30d", after: "5d" });
      const elapsed = performance.now() - t0;

      expect(many).toHaveLength(N);
      expect(elapsed).toBeLessThan(2000);
      for (const h of many) {
        expect(h.context.market).toHaveLength(31); // -30..0
        expect(h.timeline.market).toHaveLength(36); // -30..+5
        expect(h.decisions).toHaveLength(1);
        expect(h.outcomes).toHaveLength(1); // the 5d outcome lands at D+5d, an hour past the window
      }

      const singles: History[] = [];
      for (const eventId of ids) singles.push(await db.history.get({ eventId, before: "30d", after: "5d" }));
      expect(many).toEqual(singles);
    });

    it("similar() over a few thousand embedded events is fast enough for interactive use", async () => {
      const dim = 64;
      const N = 3000;
      await db.events.insertMany(
        Array.from({ length: N }, (_, i) => ({
          id: `s-${i}`,
          timestamp: E - i * HOUR,
          type: "earnings",
          embedding: Array.from({ length: dim }, (_, j) => Math.sin(i * 0.01 + j)),
        })),
      );
      const q = Array.from({ length: dim }, (_, j) => Math.sin(j));
      const t0 = performance.now();
      const hits = await db.events.similar({ event: q, limit: 20 });
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(hits).toHaveLength(20);
      expect(hits[0]!.id).toBe("s-0");
    });
  });
});

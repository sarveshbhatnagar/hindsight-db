import { describe, expect, it } from "vitest";
import { openDatabase, InsightsEventProvider, type Event } from "../src/index.js";
import {
  translateFilters,
  type InsightsEventRecord,
  type InsightsEventsApi,
  type InsightsHandle,
} from "../src/events/insights.js";

/**
 * The adapter is exercised against a stub of insights-db's read API that
 * records every call, so each test can assert both what hindsight gets back
 * and exactly what insights was asked.
 */

const DAY = 86_400_000;
const D = (day: string) => Date.parse(`${day}T00:00:00Z`);

function record(over: Partial<InsightsEventRecord> & { id: string }): InsightsEventRecord {
  return {
    occurredAt: "2026-09-10",
    observedAt: new Date("2026-09-11T08:00:00Z"),
    eventType: "bank_failure",
    title: "Meridian Bank fails",
    pattern: "regional bank seized after deposit run",
    storylineId: "7",
    entities: [
      { id: "42", name: "Meridian Bank", type: "org", role: "subject" },
      { id: "9", name: "FDIC", type: "org", role: "regulator" },
    ],
    claims: [
      {
        claimId: "c1",
        text: "Meridian Bank was closed by regulators",
        assertedAt: new Date("2026-09-11T08:00:00Z"),
        kind: "fact",
        disputedWith: [],
        verdict: null,
        evidenceUrl: null,
        supersededBy: null,
        hidden: false,
      },
      {
        claimId: "c3",
        text: "Withdrawals reached $4bn",
        assertedAt: new Date("2026-09-13T10:00:00Z"),
        kind: "fact",
        disputedWith: [],
        verdict: null,
        evidenceUrl: "https://example.com/4bn",
        supersededBy: null,
        hidden: false,
      },
    ],
    ...over,
  };
}

type Call = { method: keyof InsightsEventsApi; args: unknown[] };

function stub(records: InsightsEventRecord[]) {
  const calls: Call[] = [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const api: InsightsEventsApi = {
    async getMany(ids, opts) {
      calls.push({ method: "getMany", args: [ids, opts] });
      const asOf = opts?.asOf === undefined ? undefined : new Date(opts.asOf).getTime();
      return ids
        .map((id) => byId.get(id))
        .filter((r): r is InsightsEventRecord => r !== undefined)
        .filter((r) => asOf === undefined || r.observedAt.getTime() <= asOf)
        .map((r) => (asOf === undefined ? r : { ...r, claims: r.claims.filter((c) => c.assertedAt.getTime() <= asOf) }));
    },
    async list(query) {
      calls.push({ method: "list", args: [query] });
      return { items: records, nextCursor: "next" };
    },
    async similar(query, vector) {
      calls.push({ method: "similar", args: [query, vector] });
      return records.map((r, i) => ({ ...r, score: 1 - i / 10 }));
    },
    async types() {
      calls.push({ method: "types", args: [] });
      return [{ eventType: "bank_failure", count: 2, from: "2026-06-12", to: "2026-09-10" }];
    },
    async entities(query) {
      calls.push({ method: "entities", args: [query] });
      return [{ id: "9", name: "FDIC", type: "org", count: 3, from: "2026-06-12", to: "2026-09-14" }];
    },
  };
  const handle: InsightsHandle = { events: api };
  return { handle, calls, byId };
}

describe("InsightsEventProvider mapping", () => {
  it("maps an insights record to a hindsight Event", async () => {
    const { handle, calls } = stub([record({ id: "100" })]);
    const provider = new InsightsEventProvider(handle);
    const ev = await provider.get("100");
    expect(ev).toEqual<Event>({
      id: "100",
      timestamp: D("2026-09-10"),
      observedAt: Date.parse("2026-09-11T08:00:00Z"),
      type: "bank_failure",
      entities: ["42", "9"],
      content: {
        title: "Meridian Bank fails",
        claims: [
          {
            claimId: "c1",
            text: "Meridian Bank was closed by regulators",
            assertedAt: Date.parse("2026-09-11T08:00:00Z"),
            kind: "fact",
            disputedWith: [],
            verdict: null,
            evidenceUrl: null,
            supersededBy: null,
            hidden: false,
          },
          {
            claimId: "c3",
            text: "Withdrawals reached $4bn",
            assertedAt: Date.parse("2026-09-13T10:00:00Z"),
            kind: "fact",
            disputedWith: [],
            verdict: null,
            evidenceUrl: "https://example.com/4bn",
            supersededBy: null,
            hidden: false,
          },
        ],
      },
      metadata: {
        storylineId: "7",
        pattern: "regional bank seized after deposit run",
        entityNames: [
          { id: "42", name: "Meridian Bank", type: "org", role: "subject" },
          { id: "9", name: "FDIC", type: "org", role: "regulator" },
        ],
      },
    });
    expect(provider.pointInTime).toBe(true);
    expect(calls).toEqual([{ method: "getMany", args: [["100"], {}] }]);
  });

  it("getMany keeps the order asked, drops unknown and non-numeric ids, and passes asOf through as a Date", async () => {
    const { handle, calls } = stub([record({ id: "100" }), record({ id: "200", occurredAt: "2026-09-14" })]);
    const provider = new InsightsEventProvider(handle);
    const events = await provider.getMany(["200", "missing", "999", "100"]);
    expect(events.map((e) => e.id)).toEqual(["200", "100"]);
    expect(calls[0]).toEqual({ method: "getMany", args: [["200", "999", "100"], {}] });

    expect(await provider.getMany(["nope", "uuid-ish"])).toEqual([]);
    expect(calls).toHaveLength(1); // nothing numeric to ask for

    const then = await provider.getMany(["100"], { asOf: "2026-09-12T00:00:00Z" });
    expect(calls[1]).toEqual({ method: "getMany", args: [["100"], { asOf: new Date("2026-09-12T00:00:00Z") }] });
    expect((then[0]!.content as { claims: unknown[] }).claims).toHaveLength(1);
    expect(await provider.getMany(["100"], { asOf: D("2026-09-11") })).toEqual([]);
    expect(await provider.get("x")).toBeUndefined();
  });

  it("rejects a malformed occurredAt rather than guessing a timestamp", async () => {
    const { handle } = stub([record({ id: "1", occurredAt: "2026/09/10" })]);
    await expect(new InsightsEventProvider(handle).get("1")).rejects.toThrow(/unexpected date/);
  });
});

describe("InsightsEventProvider filter translation", () => {
  it("maps type, entities, time bounds, asOf and excludeIds", () => {
    expect(translateFilters(undefined)).toEqual({});
    expect(translateFilters({})).toEqual({});
    expect(translateFilters({ type: "a" })).toEqual({ eventType: ["a"] });
    expect(translateFilters({ type: ["a", "b"] })).toEqual({ eventType: ["a", "b"] });
    expect(translateFilters({ entities: "42" })).toEqual({ entityIds: ["42"] });
    expect(translateFilters({ entities: ["42", "9"] })).toEqual({ entityIds: ["42", "9"] });
    expect(translateFilters({ asOf: "2026-09-11T07:59:59Z" })).toEqual({ asOf: new Date("2026-09-11T07:59:59Z") });
    expect(translateFilters({ asOf: 1000 })).toEqual({ asOf: new Date(1000) });
    expect(translateFilters({ excludeIds: ["1", "not-an-insights-id", "2"] })).toEqual({ excludeIds: ["1", "2"] });
  });

  it("rounds event-time bounds to the calendar days insights can cut on", () => {
    // Midnight bounds pass through; anything inside a day moves `from` up and `to` down.
    expect(translateFilters({ from: "2026-08-01T00:00:00Z", to: "2026-08-31T00:00:00Z" })).toEqual({
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-08-31T00:00:00Z"),
    });
    expect(translateFilters({ from: "2026-08-01T10:00:00Z", to: "2026-08-31T10:00:00Z" })).toEqual({
      from: new Date("2026-08-02T00:00:00Z"),
      to: new Date("2026-08-31T00:00:00Z"),
    });
    expect(translateFilters({ to: D("2026-08-31") - 1 })).toEqual({ to: new Date("2026-08-30T00:00:00Z") });
  });

  it("collapses a single all-of entity to any-of and refuses the rest", () => {
    expect(translateFilters({ entitiesAll: "42" })).toEqual({ entityIds: ["42"] });
    expect(translateFilters({ entitiesAll: ["42", "42"] })).toEqual({ entityIds: ["42"] });
    expect(translateFilters({ entitiesAll: [] })).toEqual({});
    expect(() => translateFilters({ entitiesAll: ["42", "9"] })).toThrow(/any of the given entities, not all/);
    expect(() => translateFilters({ entitiesAll: "42", entities: "9" })).toThrow(/any of the given entities, not all/);
  });

  it("refuses entity ids that cannot be insights ids", () => {
    expect(() => translateFilters({ entities: ["42", "AAPL"] })).toThrow(/entities: insights-db entity ids are numeric, got "AAPL"/);
    expect(() => translateFilters({ entitiesAll: "AAPL" })).toThrow(/entitiesAll: insights-db entity ids are numeric/);
  });

  it("throws on any metadata filter, naming the key", () => {
    expect(translateFilters({ metadata: {} })).toEqual({});
    expect(() => translateFilters({ metadata: { storylineId: "7" } })).toThrow(/metadata filter on "storylineId": insights-db's read API has no metadata filters/);
    expect(() => translateFilters({ metadata: { sector: "tech", x: 1 } })).toThrow(/"sector", "x"/);
  });
});

describe("InsightsEventProvider list, similar and catalogs", () => {
  it("list forwards filters, paging and order, and maps the page", async () => {
    const { handle, calls } = stub([record({ id: "1" }), record({ id: "2" })]);
    const provider = new InsightsEventProvider(handle);
    const page = await provider.list({ filters: { type: "bank_failure", asOf: D("2026-09-12") }, limit: 2, cursor: "abc", order: "desc" });
    expect(page.items.map((e) => e.id)).toEqual(["1", "2"]);
    expect(page.nextCursor).toBe("next");
    expect(calls).toEqual([
      { method: "list", args: [{ eventType: ["bank_failure"], asOf: new Date(D("2026-09-12")), limit: 2, cursor: "abc", order: "desc" }] },
    ]);
    await provider.list();
    expect(calls[1]).toEqual({ method: "list", args: [{ limit: 100 }] });
    await expect(provider.list({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(provider.list({ filters: { metadata: { a: 1 } } })).rejects.toThrow(/metadata filter/);
  });

  it("similar ranks by the pattern embedding unless told otherwise, and never pages", async () => {
    const { handle, calls } = stub([record({ id: "1" }), record({ id: "2" })]);
    const provider = new InsightsEventProvider(handle);
    const hits = await provider.similar({ event: "5", limit: 3, minScore: 0.5, filters: { type: "t" } });
    expect(hits.map((h) => [h.id, h.score])).toEqual([
      ["1", 1],
      ["2", 0.9],
    ]);
    expect(hits[0]).not.toHaveProperty("embedding");
    expect(hits.nextCursor).toBeUndefined();
    expect(calls[0]).toEqual({
      method: "similar",
      args: [{ eventId: "5", k: 3, minScore: 0.5, filters: { eventType: ["t"] } }, "pattern"],
    });

    await new InsightsEventProvider(handle, { vector: "content" }).similar({ event: { id: "5" } });
    expect(calls[1]).toEqual({ method: "similar", args: [{ eventId: "5", k: 20, filters: {} }, "content"] });

    // A bare embedding is passed through as numbers; an id alongside it only excludes that event.
    await provider.similar({ event: new Float32Array([0.5, 0.25]) });
    expect(calls[2]!.args[0]).toEqual({ embedding: [0.5, 0.25], k: 20, filters: {} });
    await provider.similar({ event: { id: "5", embedding: [0.1, 0.2] }, filters: { excludeIds: ["3"] } });
    expect(calls[3]!.args[0]).toEqual({ embedding: [0.1, 0.2], k: 20, filters: { excludeIds: ["3", "5"] } });

    await expect(provider.similar({ event: "5", cursor: "x" })).rejects.toThrow(/does not page/);
    await expect(provider.similar({ event: "not-numeric" })).rejects.toThrow("Event not found: not-numeric");
    await expect(provider.similar({ event: {} })).rejects.toThrow(/must be an id, an embedding/);
    expect(calls).toHaveLength(4);
  });

  it("maps the entity and type catalogs, with day spans as 00:00 UTC", async () => {
    const { handle, calls } = stub([]);
    const provider = new InsightsEventProvider(handle);
    expect(await provider.entities({ type: "bank_failure", from: "2026-06-01T12:00:00Z", to: "2026-12-31T12:00:00Z", limit: 5 })).toEqual([
      { entity: "9", count: 3, firstSeen: D("2026-06-12"), lastSeen: D("2026-09-14") },
    ]);
    expect(calls[0]).toEqual({
      method: "entities",
      args: [{ eventType: ["bank_failure"], from: new Date(D("2026-06-02")), to: new Date(D("2026-12-31")), limit: 5 }],
    });
    await provider.entities();
    expect(calls[1]).toEqual({ method: "entities", args: [{ limit: 1000 }] });
    await expect(provider.entities({ prefix: "sector:" })).rejects.toThrow(/prefix/);

    expect(await provider.types()).toEqual([{ type: "bank_failure", count: 2, firstSeen: D("2026-06-12"), lastSeen: D("2026-09-10") }]);
  });
});

describe("history with point-in-time content", () => {
  const observed = Date.parse("2026-09-11T08:00:00Z");
  const later = Date.parse("2026-09-13T10:00:00Z");

  it("hands out each event as it stood at its contextUntil, in one call per distinct cutoff", async () => {
    const { handle, calls } = stub([
      record({ id: "1" }),
      record({ id: "2", occurredAt: "2026-09-12", observedAt: new Date(later) }),
    ]);
    const db = openDatabase({ events: new InsightsEventProvider(handle) });
    const claims = (e: Event) => (e.content as { claims: { claimId: string }[] }).claims.map((c) => c.claimId);

    // Default cutoffs: each event's own observedAt, so two asOf fetches.
    const byDefault = await db.history.getMany({ eventIds: ["1", "2"] });
    expect(byDefault.map((h) => [h.event.id, claims(h.event)])).toEqual([
      ["1", ["c1"]],
      ["2", ["c1", "c3"]],
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      [["1", "2"], {}],
      [["1"], { asOf: new Date(observed) }],
      [["2"], { asOf: new Date(later) }],
    ]);
    calls.length = 0;

    // One explicit cutoff: one extra call for both.
    const explicit = await db.history.getMany({ eventIds: ["1", "2"], contextUntil: later, outcomeUntil: later + DAY });
    expect(explicit.map((h) => claims(h.event))).toEqual([
      ["c1", "c3"],
      ["c1", "c3"],
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      [["1", "2"], {}],
      [["1", "2"], { asOf: new Date(later) }],
    ]);
    calls.length = 0;

    // A cutoff before an event was observed: it had no state then, so it is
    // returned as it stands and left out of the asOf fetch.
    const early = await db.history.getMany({ eventIds: ["1", "2"], contextUntil: observed, outcomeUntil: later + DAY });
    expect(early.map((h) => [claims(h.event), h.event.observedAt > h.window.contextUntil])).toEqual([
      [["c1"], false],
      [["c1", "c3"], true],
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      [["1", "2"], {}],
      [["1"], { asOf: new Date(observed) }],
    ]);
    db.close();
  });

  it("history.get sees the same view", async () => {
    const { handle } = stub([record({ id: "1" })]);
    const db = openDatabase({ events: new InsightsEventProvider(handle) });
    const h = await db.history.get({ eventId: "1" });
    expect((h.event.content as { claims: unknown[] }).claims).toHaveLength(1);
    expect(h.window.contextUntil).toBe(observed);
    db.close();
  });

  it("does not ask an immutable provider twice", async () => {
    const calls: string[] = [];
    const ev: Event = { id: "e", timestamp: observed, observedAt: observed, type: "t", entities: [], content: null, metadata: {} };
    const db = openDatabase({
      events: {
        async get() {
          return ev;
        },
        async getMany(ids, opts) {
          calls.push(JSON.stringify([ids, opts]));
          return ids.includes("e") ? [ev] : [];
        },
        async list() {
          return { items: [] };
        },
        async similar() {
          return [];
        },
        async entities() {
          return [];
        },
        async types() {
          return [];
        },
      },
    });
    await db.history.get({ eventId: "e", contextUntil: observed + DAY, outcomeUntil: observed + DAY });
    expect(calls).toEqual(['[["e"],null]']);
    db.close();
  });
});

describe("db.gc()", () => {
  it("removes the decisions and outcomes of events the provider no longer has", async () => {
    const { handle, byId } = stub([record({ id: "1" }), record({ id: "2" }), record({ id: "3" })]);
    const db = openDatabase({ events: new InsightsEventProvider(handle) });
    const d1 = await db.decisions.insert({ eventId: "1", timestamp: observedMs(), action: "hold" });
    await db.decisions.insert({ eventId: "2", timestamp: observedMs(), action: "sell" });
    await db.decisions.insert({ eventId: "2", timestamp: observedMs(), action: "sell more" });
    await db.outcomes.insert({ eventId: "1", decisionId: d1.id, horizon: "1d", result: 0 });
    await db.outcomes.insert({ eventId: "2", horizon: "1d", result: 1 });
    await db.outcomes.insert({ eventId: "3", horizon: "1d", result: 2 });

    expect(await db.gc()).toEqual({ removedEvents: 0, removedDecisions: 0, removedOutcomes: 0 });

    // insights merged 2 into 1 and detached 3's only document.
    byId.delete("2");
    byId.delete("3");
    expect(await db.gc()).toEqual({ removedEvents: 2, removedDecisions: 2, removedOutcomes: 2 });
    expect(await db.decisions.forEvent("2")).toEqual([]);
    expect(await db.outcomes.forEvent("3")).toEqual([]);
    expect((await db.outcomes.forEvent("1")).map((o) => o.decisionId)).toEqual([d1.id]);
    expect(await db.gc()).toEqual({ removedEvents: 0, removedDecisions: 0, removedOutcomes: 0 });
    // A stub can be fetched again when the id returns (an event is never truly gone until gc ran).
    byId.set("2", record({ id: "2" }));
    await db.decisions.insert({ eventId: "2", timestamp: observedMs(), action: "again" });
    expect(await db.decisions.forEvent("2")).toHaveLength(1);
    db.close();
  });

  it("sweeps in chunks and keeps going after a clean chunk", async () => {
    const ids = Array.from({ length: 5001 }, (_, i) => String(i + 1));
    const { handle, byId, calls } = stub(ids.map((id) => record({ id })));
    const db = openDatabase({ events: new InsightsEventProvider(handle) });
    await db.decisions.insertMany(ids.map((id) => ({ eventId: id, timestamp: 0, action: null })));
    calls.length = 0;
    byId.delete("999"); // last in text order, so in the second chunk
    expect(await db.gc()).toEqual({ removedEvents: 1, removedDecisions: 1, removedOutcomes: 0 });
    expect(calls.map((c) => (c.args[0] as string[]).length)).toEqual([5000, 1]);
    db.close();
  });

  it("is a no-op with the SQLite event store", async () => {
    const db = openDatabase();
    const ev = await db.events.insert({ timestamp: 0, type: "t" });
    await db.decisions.insert({ eventId: ev.id, timestamp: 0, action: null });
    expect(await db.gc()).toEqual({ removedEvents: 0, removedDecisions: 0, removedOutcomes: 0 });
    expect(await db.decisions.forEvent(ev.id)).toHaveLength(1);
    db.close();
  });
});

describe("InsightsEventProvider.open", () => {
  it("wraps an insights-db handle opened on demand, or explains what to install", async () => {
    let installed = true;
    try {
      await import("insights-db" as string);
    } catch {
      installed = false;
    }
    if (!installed) {
      await expect(InsightsEventProvider.open({ connectionString: "postgres://localhost/x" })).rejects.toThrow(/npm install insights-db/);
      return;
    }
    // pg pools connect lazily, so no database is needed to build the handle.
    const provider = await InsightsEventProvider.open({ connectionString: "postgres://nobody@localhost:1/none", vector: "content" });
    expect(provider).toBeInstanceOf(InsightsEventProvider);
    expect(typeof provider.insights.events.getMany).toBe("function");
    await provider.insights.end!();
  });
});

function observedMs(): number {
  return Date.parse("2026-09-11T09:00:00Z");
}

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HindsightDB, openDatabase, type Event, type EventProvider } from "../src/index.js";
import { EventRefStore } from "../src/storage/event-refs.js";
import { SqliteStorage } from "../src/storage/sqlite.js";
import { DecisionStore } from "../src/stores/decisions.js";
import { OutcomeStore } from "../src/stores/outcomes.js";
import type { EventRef } from "../src/types.js";

const T0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const HOUR = 3_600_000;

function raw(db: HindsightDB): Database.Database {
  return (db as unknown as { conn: { db: Database.Database } }).conn.db;
}

describe("db.aliases", () => {
  let db: HindsightDB;
  beforeEach(() => {
    db = openDatabase();
  });
  afterEach(() => db.close());

  it("adds, lists, looks up and removes mappings", async () => {
    await db.aliases.add("42", "AAPL");
    await db.aliases.add("42", ["AAPL", "US0378331005"]); // duplicate pair is ignored
    await db.aliases.add("7", "MSFT");
    expect(await db.aliases.list()).toEqual([
      { externalId: "42", entity: "AAPL" },
      { externalId: "42", entity: "US0378331005" },
      { externalId: "7", entity: "MSFT" },
    ]);
    expect(await db.aliases.list({ prefix: "4" })).toEqual([
      { externalId: "42", entity: "AAPL" },
      { externalId: "42", entity: "US0378331005" },
    ]);
    expect(await db.aliases.list({ limit: 1 })).toEqual([{ externalId: "42", entity: "AAPL" }]);
    expect(await db.aliases.forExternal(["42", "7", "unknown"])).toEqual(
      new Map([
        ["42", ["AAPL", "US0378331005"]],
        ["7", ["MSFT"]],
        ["unknown", []],
      ]),
    );
    expect(await db.aliases.forExternal([])).toEqual(new Map());
    expect(await db.aliases.remove("42", "US0378331005")).toBe(true);
    expect(await db.aliases.remove("42", "US0378331005")).toBe(false);
    expect((await db.aliases.forExternal(["42"])).get("42")).toEqual(["AAPL"]);
  });

  it("validates ids like entities", async () => {
    await expect(db.aliases.add("", "AAPL")).rejects.toThrow(/alias.externalId/);
    await expect(db.aliases.add("42", ["AAPL", ""])).rejects.toThrow(/alias.entity/);
    await expect(db.aliases.add("42", "A" + String.fromCharCode(31) + "B")).rejects.toThrow(/U\+001F/);
    expect(await db.aliases.list()).toEqual([]); // the failed batch was rolled back as a whole
    await expect(db.aliases.list({ limit: 0 })).rejects.toThrow(/limit/);
  });

  it("joins an enclosing transaction", async () => {
    expect(() =>
      db.transaction(() => {
        db.aliases.add("42", "AAPL").catch(() => {});
        db.aliases.add("", "bad").catch(() => {});
      }),
    ).toThrow(/alias.externalId/);
    expect(await db.aliases.list()).toEqual([]);
  });
});

describe("alias expansion in history and timeline", () => {
  let db: HindsightDB;
  beforeEach(async () => {
    db = openDatabase();
    // The event names its entity by an external id; timeline data is keyed by a label.
    await db.events.insert({ id: "ev", timestamp: T0, type: "earnings", entities: ["42"] });
    await db.timeline.insertMany([
      { timestamp: T0 - DAY, entity: "AAPL", namespace: "market", data: { px: 1 } },
      { timestamp: T0 - DAY, entity: "42", namespace: "market", data: { px: 2 } },
      { timestamp: T0 - DAY, entity: "MSFT", namespace: "market", data: { px: 3 } },
    ]);
  });
  afterEach(() => db.close());

  it("is a no-op while the alias table is empty", async () => {
    const h = await db.history.get({ eventId: "ev" });
    expect(h.timeline.market!.map((p) => p.entity)).toEqual(["42"]);
    expect((await db.timeline.around({ eventId: "ev", before: "2d" })).market!.map((p) => p.entity)).toEqual(["42"]);
  });

  it("history.get sees timeline points under an alias of the event's entity", async () => {
    await db.aliases.add("42", "AAPL");
    const h = await db.history.get({ eventId: "ev" });
    expect(h.context.market!.map((p) => p.entity).sort()).toEqual(["42", "AAPL"]);
    expect(h.timeline.market!.map((p) => p.entity).sort()).toEqual(["42", "AAPL"]);
    // Pagination carries the expanded entity list, so the remainder query sees the same streams.
    const cut = await db.history.get({ eventId: "ev", maxPoints: 1 });
    expect(cut.truncated?.next.entity).toEqual(["42", "AAPL"]);
  });

  it("timeline.around expands the same way; explicit entities are taken as given", async () => {
    await db.aliases.add("42", "AAPL");
    expect((await db.timeline.around({ eventId: "ev", before: "2d" })).market!.map((p) => p.entity).sort()).toEqual(["42", "AAPL"]);
    expect((await db.timeline.around({ eventId: "ev", before: "2d", entities: "42" })).market!.map((p) => p.entity)).toEqual(["42"]);
    expect((await db.history.get({ eventId: "ev", entities: ["42"] })).timeline.market!.map((p) => p.entity)).toEqual(["42"]);
  });

  it("history.getMany expands per event with one lookup", async () => {
    await db.events.insert({ id: "ev2", timestamp: T0, type: "earnings", entities: ["7"] });
    await db.aliases.add("42", "AAPL");
    await db.aliases.add("7", "MSFT");
    const [a, b] = await db.history.getMany({ eventIds: ["ev", "ev2"] });
    expect(a!.timeline.market!.map((p) => p.entity).sort()).toEqual(["42", "AAPL"]);
    expect(b!.timeline.market!.map((p) => p.entity)).toEqual(["MSFT"]);
  });

  it("an event with no entities still selects every stream", async () => {
    await db.aliases.add("42", "AAPL");
    await db.events.insert({ id: "bare", timestamp: T0, type: "x" });
    expect((await db.history.get({ eventId: "bare" })).timeline.market).toHaveLength(3);
  });
});

describe("event_refs", () => {
  let db: HindsightDB;
  beforeEach(() => {
    db = openDatabase();
  });
  afterEach(() => db.close());

  it("mirrors the events table through inserts, bulk loads and deletes", async () => {
    await db.events.insert({ id: "a", timestamp: T0, observedAt: T0 + 5, type: "x" });
    await db.bulkLoad(async () => {
      await db.events.insertMany([{ id: "b", timestamp: T0 + 1, type: "x" }]);
    });
    const refs = () => raw(db).prepare(`SELECT id, timestamp, observed_at FROM event_refs ORDER BY id`).all();
    expect(refs()).toEqual([
      { id: "a", timestamp: T0, observed_at: T0 + 5 },
      { id: "b", timestamp: T0 + 1, observed_at: T0 + 1 },
    ]);
    await db.events.delete("a");
    expect(refs()).toEqual([{ id: "b", timestamp: T0 + 1, observed_at: T0 + 1 }]);
  });

  it("an outcome's default timestamp resolves from a stub that has no local event", async () => {
    raw(db).prepare(`INSERT INTO event_refs (id, timestamp, observed_at) VALUES ('remote', ?, ?)`).run(T0, T0);
    expect(await db.events.get("remote")).toBeUndefined();
    const d = await db.decisions.insert({ eventId: "remote", timestamp: T0 + HOUR, action: "buy" });
    const o = await db.outcomes.insert({ eventId: "remote", horizon: "1d", result: 1 });
    expect(o.timestamp).toBe(T0 + DAY);
    const o2 = await db.outcomes.insert({ eventId: "remote", decisionId: d.id, horizon: "1d", result: 1 });
    expect(o2.timestamp).toBe(T0 + HOUR + DAY);
    expect((await db.outcomes.forEvent("remote")).map((x) => x.id)).toEqual([o.id, o2.id]);
    // Removing the stub cascades as an event delete would.
    raw(db).prepare(`DELETE FROM event_refs WHERE id = 'remote'`).run();
    expect(await db.decisions.get(d.id)).toBeUndefined();
    expect(await db.outcomes.forEvent("remote")).toEqual([]);
  });

  it("inserting a local event over an existing stub refreshes it instead of failing", async () => {
    raw(db).prepare(`INSERT INTO event_refs (id, timestamp, observed_at) VALUES ('e', ?, ?)`).run(T0, T0);
    await db.decisions.insert({ id: "d", eventId: "e", timestamp: T0, action: 1 });
    await db.events.insert({ id: "e", timestamp: T0 + 1, observedAt: T0 + 2, type: "x" });
    expect(raw(db).prepare(`SELECT timestamp, observed_at FROM event_refs WHERE id = 'e'`).get()).toEqual({
      timestamp: T0 + 1,
      observed_at: T0 + 2,
    });
    expect(await db.decisions.get("d")).toBeDefined(); // the upsert did not cascade
  });
});

describe("external event source: stubs are fetched before the write", () => {
  let conn: SqliteStorage;
  let resolver: ReturnType<typeof vi.fn<(ids: string[]) => Promise<EventRef[]>>>;
  let decisions: DecisionStore;
  let outcomes: OutcomeStore;
  const remote = new Map<string, EventRef>([
    ["r1", { id: "r1", timestamp: T0, observedAt: T0 }],
    ["r2", { id: "r2", timestamp: T0 + DAY, observedAt: T0 + DAY }],
  ]);

  beforeEach(() => {
    conn = new SqliteStorage();
    resolver = vi.fn(async (ids: string[]) => ids.flatMap((id) => (remote.has(id) ? [remote.get(id)!] : [])));
    const refs = new EventRefStore(conn, resolver);
    decisions = new DecisionStore(conn, refs);
    outcomes = new OutcomeStore(conn, refs);
  });
  afterEach(() => conn.close());

  it("decisions and outcomes resolve unseen events through the resolver once", async () => {
    const d = await decisions.insert({ eventId: "r1", timestamp: T0 + HOUR, action: "buy" });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(["r1"]);
    expect(conn.db.prepare(`SELECT id FROM event_refs`).all()).toEqual([{ id: "r1" }]);

    const [o1, o2] = await outcomes.insertMany([
      { eventId: "r1", decisionId: d.id, horizon: "1d", result: 1 },
      { eventId: "r2", horizon: "2d", result: 2 },
    ]);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenLastCalledWith(["r2"]); // only what was missing
    expect(o1!.timestamp).toBe(T0 + HOUR + DAY);
    expect(o2!.timestamp).toBe(T0 + 3 * DAY);
  });

  it("ids the resolver does not know fail as unknown events", async () => {
    await expect(decisions.insert({ eventId: "nope", timestamp: T0, action: 1 })).rejects.toThrow(/FOREIGN KEY/);
    await expect(outcomes.insert({ eventId: "nope", horizon: "1d", result: 1 })).rejects.toThrow(/Event not found: nope/);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("malformed ids are rejected by validation, not sent to the resolver", async () => {
    await expect(decisions.insert({ eventId: "", timestamp: T0, action: 1 })).rejects.toThrow(/decision.eventId/);
    await expect(outcomes.insert({ eventId: 7 as unknown as string, horizon: "1d", result: 1 })).rejects.toThrow(/outcome.eventId/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("stays synchronous once the stub is present, so db.transaction() still wraps it", async () => {
    await decisions.insert({ eventId: "r1", timestamp: T0, action: "warm-up" });
    const count = () => (conn.db.prepare(`SELECT count(*) AS n FROM decisions`).get() as { n: number }).n;
    expect(() =>
      conn.transaction(() => {
        decisions.insert({ eventId: "r1", timestamp: T0, action: "a" }).catch(() => {});
        outcomes.insert({ eventId: "r1", horizon: "-1d", result: 1 }).catch(() => {}); // fails: rolls back both
      }),
    ).toThrow(/horizon/);
    expect(count()).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe("openDatabase({ events: provider }) end to end", () => {
  const remote: Event[] = [
    { id: "ext-1", timestamp: T0, observedAt: T0, type: "news", entities: ["42"], content: null, metadata: {} },
  ];
  const calls: string[] = [];
  const provider: EventProvider = {
    async get(id) {
      return remote.find((e) => e.id === id);
    },
    async getMany(ids) {
      calls.push(ids.join(","));
      return remote.filter((e) => ids.includes(e.id));
    },
    async list() {
      return { items: remote };
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
  };

  beforeEach(() => calls.splice(0));

  it("records decisions and outcomes against provider-owned events and reconstructs their history", async () => {
    const db = openDatabase({ events: provider });
    await db.timeline.insert({ timestamp: T0 - DAY, entity: "AAPL", namespace: "market", data: { px: 1 } });
    await db.aliases.add("42", "AAPL");

    const d = await db.decisions.insert({ eventId: "ext-1", timestamp: T0 + HOUR, action: "buy" });
    expect(calls).toEqual(["ext-1"]);
    const o = await db.outcomes.insert({ eventId: "ext-1", decisionId: d.id, horizon: "1d", result: { pnl: 1 } });
    expect(o.timestamp).toBe(T0 + HOUR + DAY);
    expect(calls).toEqual(["ext-1"]); // the stub was reused, not refetched

    const h = await db.history.get({ eventId: "ext-1", after: "2d" });
    expect(h.event.id).toBe("ext-1");
    expect(h.timeline.market!.map((p) => p.entity)).toEqual(["AAPL"]); // via the alias
    expect(h.decisions.map((x) => x.id)).toEqual([d.id]);
    expect(h.outcomes.map((x) => x.id)).toEqual([o.id]);

    await expect(db.outcomes.insert({ eventId: "ext-404", horizon: "1d", result: 1 })).rejects.toThrow(/Event not found: ext-404/);
    db.close();
  });
});

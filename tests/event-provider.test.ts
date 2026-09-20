import { describe, expect, it } from "vitest";
import { openDatabase, type Event, type EventProvider } from "../src/index.js";

/**
 * `openDatabase({ events })` swaps the event source for an external provider
 * while timeline/decisions/outcomes/history stay in SQLite. The fake here is
 * the smallest thing that satisfies `EventProvider`; it records which methods
 * were hit so we can assert the stores really go through the provider.
 */

const DAY = 86_400_000;
const T = (day: number) => Date.UTC(2024, 0, 1) + day * DAY;

function fakeProvider(events: Event[]) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const calls: string[] = [];
  const provider: EventProvider = {
    async get(id) {
      calls.push(`get:${id}`);
      return byId.get(id);
    },
    async getMany(ids) {
      calls.push(`getMany:${ids.join(",")}`);
      return ids.map((id) => byId.get(id)).filter((e): e is Event => e !== undefined);
    },
    async list() {
      return { items: [...byId.values()] };
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
  return { provider, calls };
}

const external: Event[] = [
  { id: "ext-1", timestamp: T(10), observedAt: T(10), type: "news", entities: ["AAPL"], content: "ext 1", metadata: {} },
  { id: "ext-2", timestamp: T(20), observedAt: T(21), type: "news", entities: ["MSFT"], content: "ext 2", metadata: {} },
];

describe("openDatabase({ events: provider })", () => {
  it("routes timeline.around through the provider", async () => {
    const { provider, calls } = fakeProvider(external);
    const db = openDatabase({ events: provider });
    await db.timeline.insertMany([
      { timestamp: T(8), entity: "AAPL", namespace: "market", data: { close: 1 } },
      { timestamp: T(9), entity: "AAPL", namespace: "market", data: { close: 2 } },
      { timestamp: T(9), entity: "MSFT", namespace: "market", data: { close: 9 } },
    ]);
    const streams = await db.timeline.around({ eventId: "ext-1", before: "3d" });
    expect(streams.market?.map((p) => p.data)).toEqual([{ close: 1 }, { close: 2 }]);
    expect(calls).toEqual(["get:ext-1"]);
    await expect(db.timeline.around({ eventId: "nope" })).rejects.toThrow("Event not found: nope");
    db.close();
  });

  it("reconstructs history for provider events with local context", async () => {
    const { provider, calls } = fakeProvider(external);
    const db = openDatabase({ events: provider });
    await db.timeline.insertMany([
      { timestamp: T(19), entity: "MSFT", namespace: "market", data: { close: 1 } },
      // Observed after the event: in the window, but out of `context`.
      { timestamp: T(19), observedAt: T(22), entity: "MSFT", namespace: "market", data: { close: 1.5 } },
      { timestamp: T(22), entity: "MSFT", namespace: "market", data: { close: 2 } },
    ]);
    const h = await db.history.get({ eventId: "ext-2", before: "2d", after: "3d" });
    expect(h.event).toEqual(external[1]);
    expect(h.context.market?.map((p) => p.data)).toEqual([{ close: 1 }]);
    expect(h.timeline.market?.map((p) => p.data)).toEqual([{ close: 1 }, { close: 1.5 }, { close: 2 }]);
    expect(h.decisions).toEqual([]);
    expect(h.outcomes).toEqual([]);
    expect(calls).toEqual(["getMany:ext-2"]);

    const many = await db.history.getMany({ eventIds: ["ext-2", "missing", "ext-1"], before: "1d" });
    expect(many.map((x) => x.event.id)).toEqual(["ext-2", "ext-1"]);
    db.close();
  });

  it("exposes the provider as db.events, without the SQLite write surface", async () => {
    const { provider } = fakeProvider(external);
    const db = openDatabase({ events: provider });
    expect(db.events).toBe(provider);
    expect(await db.events.get("ext-1")).toEqual(external[0]);
    // @ts-expect-error insert is not part of EventProvider
    expect(db.events.insert).toBeUndefined();
    db.close();
  });

  it("keeps the SQLite store, with writes, when no provider is given", async () => {
    const db = openDatabase();
    const ev = await db.events.insert({ timestamp: T(1), type: "t" });
    expect((await db.events.get(ev.id))?.id).toBe(ev.id);
    db.close();
  });
});

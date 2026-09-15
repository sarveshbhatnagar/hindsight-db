import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionGraph, openDatabase } from "../src/index.js";

const T0 = Date.UTC(2024, 0, 10); // event time
const DAY = 86_400_000;
const HOUR = 3_600_000;

let db: ActionGraph;
beforeEach(async () => {
  db = openDatabase();
  // Event at day 0 (T0), observed 2h later.
  await db.events.insert({
    id: "ev",
    timestamp: T0,
    observedAt: T0 + 2 * HOUR,
    type: "earnings",
    entities: ["AAPL"],
    content: "AAPL beats",
    embedding: [1, 0],
  });
  // Daily market closes from -10d .. +10d for AAPL (and MSFT as noise).
  await db.timeline.insertMany(
    Array.from({ length: 21 }, (_, i) => i - 10).flatMap((d) => [
      { timestamp: T0 + d * DAY, entity: "AAPL", namespace: "market", data: { d } },
      { timestamp: T0 + d * DAY, entity: "MSFT", namespace: "market", data: { d } },
    ]),
  );
  // A revised macro print: event time is -1d, but it was only observed at +1d.
  await db.timeline.insertMany([
    { timestamp: T0 - DAY, observedAt: T0 + DAY, entity: "AAPL", namespace: "macro", data: "revised-late" },
    { timestamp: T0 - DAY, entity: "AAPL", namespace: "macro", data: "initial" },
  ]);
  // Two decisions and three outcomes.
  await db.decisions.insert({ id: "d1", eventId: "ev", timestamp: T0 + 3 * HOUR, action: "buy" });
  await db.decisions.insert({ id: "d2", eventId: "ev", timestamp: T0 + 2 * DAY, action: "add" });
  await db.outcomes.insertMany([
    { id: "o1", eventId: "ev", decisionId: "d1", horizon: "1d", result: { ret: 0.01 } },
    { id: "o5", eventId: "ev", decisionId: "d1", horizon: "5d", result: { ret: 0.05 } },
    { id: "o10", eventId: "ev", decisionId: "d1", horizon: "10d", result: { ret: 0.1 } },
  ]);
});
afterEach(() => db.close());

const days = (points: { data: unknown }[] | undefined) => (points ?? []).map((p) => (p.data as { d: number }).d);

describe("history.get", () => {
  it("reconstructs event, context, timeline, decisions and outcomes for a window", async () => {
    const h = await db.history.get({ eventId: "ev", before: "3d", after: "5d" });

    expect(h.event.id).toBe("ev");
    expect(h.window).toEqual({
      from: T0 - 3 * DAY,
      to: T0 + 5 * DAY,
      contextUntil: T0 + 2 * HOUR,
      outcomeUntil: T0 + 5 * DAY,
    });

    // Context is cut at the event's observation time: only AAPL, only <= day 0.
    expect(days(h.context.market)).toEqual([-3, -2, -1, 0]);
    expect(h.context.macro!.map((p) => p.data)).toEqual(["initial"]);

    // Timeline spans the full window, including the late-observed macro revision.
    expect(days(h.timeline.market)).toEqual([-3, -2, -1, 0, 1, 2, 3, 4, 5]);
    expect(h.timeline.macro!.map((p) => p.data).sort()).toEqual(["initial", "revised-late"]);
    expect(h.timeline.market!.every((p) => p.entity === "AAPL")).toBe(true);

    expect(h.decisions.map((d) => d.id)).toEqual(["d1", "d2"]);
    // Outcomes are anchored on d1 (T0+3h): o1 = +1d3h is inside the +5d window, o5 = +5d3h is not.
    expect(h.outcomes.map((o) => o.id)).toEqual(["o1"]);
  });

  it("never leaks post-context observations into context", async () => {
    const h = await db.history.get({ eventId: "ev", before: "3d", after: "5d" });
    for (const stream of Object.values(h.context)) {
      for (const p of stream) expect(p.observedAt).toBeLessThanOrEqual(h.window.contextUntil);
    }
  });

  it("honours explicit contextUntil / outcomeUntil cutoffs", async () => {
    const h = await db.history.get({
      eventId: "ev",
      before: "3d",
      after: "10d",
      contextUntil: T0 - DAY, // context as of one day before the event
      outcomeUntil: T0 + 2 * DAY, // only what was known two days after
    });
    expect(days(h.context.market)).toEqual([-3, -2, -1]);
    expect(days(h.timeline.market)).toEqual([-3, -2, -1, 0, 1, 2]);
    expect(h.timeline.macro!.map((p) => p.data).sort()).toEqual(["initial", "revised-late"]);
    expect(h.decisions.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(h.outcomes.map((o) => o.id)).toEqual(["o1"]);
  });

  it("uses default window (7d before, through observation time) and supports entity/namespace overrides", async () => {
    const h = await db.history.get({ eventId: "ev" });
    expect(h.window.from).toBe(T0 - 7 * DAY);
    // No explicit `after`: the window extends to the observation cutoff (event observed at +2h).
    expect(h.window.to).toBe(T0 + 2 * HOUR);
    expect(days(h.timeline.market)).toEqual([-7, -6, -5, -4, -3, -2, -1, 0]);

    const explicit = await db.history.get({ eventId: "ev", after: "0ms" });
    expect(explicit.window.to).toBe(T0);

    const msft = await db.history.get({ eventId: "ev", before: "1d", entities: "MSFT", namespace: "market" });
    expect(Object.keys(msft.timeline)).toEqual(["market"]);
    expect(msft.timeline.market!.every((p) => p.entity === "MSFT")).toBe(true);
  });

  it("throws for unknown events", async () => {
    await expect(db.history.get({ eventId: "nope" })).rejects.toThrow(/not found/);
  });
});

describe("history.getMany", () => {
  beforeEach(async () => {
    await db.events.insertMany([
      { id: "ev-b", timestamp: T0 + 3 * DAY, type: "earnings", entities: ["MSFT"] },
      { id: "ev-c", timestamp: T0 - 5 * DAY, type: "earnings", entities: ["AAPL"] },
    ]);
    await db.decisions.insert({ id: "db", eventId: "ev-b", timestamp: T0 + 3 * DAY, action: "sell" });
  });

  it("returns histories in input order, deduplicated, omitting unknown ids", async () => {
    const hs = await db.history.getMany({ eventIds: ["ev-c", "nope", "ev", "ev-c", "ev-b"], before: "1d", after: "1d" });
    expect(hs.map((h) => h.event.id)).toEqual(["ev-c", "ev", "ev-b"]);

    const [c, a, b] = hs;
    expect(days(c!.timeline.market)).toEqual([-6, -5, -4]);
    expect(c!.timeline.market!.every((p) => p.entity === "AAPL")).toBe(true);
    expect(c!.decisions).toEqual([]);

    expect(a!.decisions.map((d) => d.id)).toEqual(["d1"]);
    // o1 is observable at +1d3h, just past the +1d window.
    expect(a!.outcomes).toEqual([]);

    expect(days(b!.timeline.market)).toEqual([2, 3, 4]);
    expect(b!.timeline.market!.every((p) => p.entity === "MSFT")).toBe(true);
    expect(b!.decisions.map((d) => d.id)).toEqual(["db"]);
  });

  it("matches history.get per event", async () => {
    const opts = { before: "2d", after: "3d" };
    const many = await db.history.getMany({ eventIds: ["ev", "ev-b"], ...opts });
    const single = await Promise.all([db.history.get({ eventId: "ev", ...opts }), db.history.get({ eventId: "ev-b", ...opts })]);
    expect(many).toEqual(single);
  });

  it("handles empty input", async () => {
    expect(await db.history.getMany({ eventIds: [] })).toEqual([]);
    expect(await db.history.getMany({ eventIds: ["nope"] })).toEqual([]);
  });
});

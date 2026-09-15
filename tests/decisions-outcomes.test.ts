import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionGraph, openDatabase } from "../src/index.js";

const T0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const HOUR = 3_600_000;

let db: ActionGraph;
beforeEach(async () => {
  db = openDatabase();
  await db.events.insert({ id: "ev", timestamp: T0, type: "earnings", entities: ["AAPL"] });
  await db.events.insert({ id: "ev2", timestamp: T0, type: "earnings", entities: ["MSFT"] });
});
afterEach(() => db.close());

describe("decisions", () => {
  it("inserts and lists per event in time order", async () => {
    const d2 = await db.decisions.insert({ eventId: "ev", timestamp: T0 + 2 * HOUR, action: { side: "sell" } });
    const d1 = await db.decisions.insert({
      id: "d1",
      eventId: "ev",
      timestamp: T0 + HOUR,
      action: { side: "buy", qty: 10 },
      metadata: { model: "v1" },
    });
    expect(d1).toEqual({
      id: "d1",
      eventId: "ev",
      timestamp: T0 + HOUR,
      action: { side: "buy", qty: 10 },
      metadata: { model: "v1" },
    });
    expect((await db.decisions.forEvent("ev")).map((d) => d.id)).toEqual(["d1", d2.id]);
    expect((await db.decisions.forEvent("ev", { until: T0 + HOUR })).map((d) => d.id)).toEqual(["d1"]);
    expect(await db.decisions.get("d1")).toEqual(d1);
    expect(await db.decisions.get("nope")).toBeUndefined();
  });

  it("requires an existing event and an action", async () => {
    await expect(db.decisions.insert({ eventId: "nope", timestamp: T0, action: 1 })).rejects.toThrow(/FOREIGN KEY/);
    await expect(db.decisions.insert({ eventId: "ev", timestamp: T0, action: undefined as never })).rejects.toThrow(
      /action is required/,
    );
  });
});

describe("outcomes", () => {
  it("derives outcome time from the decision timestamp + horizon", async () => {
    const d = await db.decisions.insert({ id: "d", eventId: "ev", timestamp: T0 + HOUR, action: "buy" });
    const o = await db.outcomes.insert({ eventId: "ev", decisionId: d.id, horizon: "1d", result: { pnl: 1.5 } });
    expect(o).toMatchObject({
      eventId: "ev",
      decisionId: "d",
      timestamp: T0 + HOUR + DAY,
      horizon: "1d",
      horizonMs: DAY,
      result: { pnl: 1.5 },
      metadata: {},
    });
  });

  it("derives outcome time from the event when no decision is given", async () => {
    const o = await db.outcomes.insert({ eventId: "ev", horizon: "5d", result: { ret: -0.02 } });
    expect(o.decisionId).toBeNull();
    expect(o.timestamp).toBe(T0 + 5 * DAY);
  });

  it("accepts an explicit outcome timestamp and numeric horizon", async () => {
    const o = await db.outcomes.insert({ eventId: "ev", horizon: 1000, timestamp: T0 + 42, result: 1 });
    expect(o.timestamp).toBe(T0 + 42);
    expect(o.horizon).toBe("1000ms");
    expect(o.horizonMs).toBe(1000);
  });

  it("validates decision/event consistency", async () => {
    await db.decisions.insert({ id: "d-ev2", eventId: "ev2", timestamp: T0, action: "x" });
    await expect(db.outcomes.insert({ eventId: "ev", decisionId: "d-ev2", horizon: "1d", result: 1 })).rejects.toThrow(
      /belongs to event ev2/,
    );
    await expect(db.outcomes.insert({ eventId: "ev", decisionId: "nope", horizon: "1d", result: 1 })).rejects.toThrow(
      /Decision not found/,
    );
    await expect(db.outcomes.insert({ eventId: "nope", horizon: "1d", result: 1 })).rejects.toThrow(/Event not found/);
  });

  it("lists per event with an outcome-time cutoff", async () => {
    await db.outcomes.insertMany([
      { id: "o1", eventId: "ev", horizon: "1d", result: 1 },
      { id: "o5", eventId: "ev", horizon: "5d", result: 5 },
      { id: "o3", eventId: "ev", horizon: "3d", result: 3 },
    ]);
    expect((await db.outcomes.forEvent("ev")).map((o) => o.id)).toEqual(["o1", "o3", "o5"]);
    expect((await db.outcomes.forEvent("ev", { until: T0 + 3 * DAY })).map((o) => o.id)).toEqual(["o1", "o3"]);
  });

  it("is atomic: one bad outcome rolls back the batch", async () => {
    await expect(
      db.outcomes.insertMany([
        { id: "ok", eventId: "ev", horizon: "1d", result: 1 },
        { id: "bad", eventId: "nope", horizon: "1d", result: 1 },
      ]),
    ).rejects.toThrow();
    expect(await db.outcomes.get("ok")).toBeUndefined();
  });
});

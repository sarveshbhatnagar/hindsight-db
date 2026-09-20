import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HindsightDB, openDatabase, parseDuration, toMillis, type EventFilters } from "../src/index.js";

/**
 * Adversarial, boundary and lifecycle tests.
 *
 * Conventions:
 *   - `it.fails(...)` + a `BUG:` comment marks behaviour we believe is wrong.
 *     The assertion states the *expected* behaviour, so the test goes red
 *     (and should be flipped to `it`) once the bug is fixed.
 *   - Plain `it(...)` + a `SURPRISE:` comment pins down current behaviour that
 *     is defensible but easy to trip over; the comment says why.
 */

const T0 = Date.UTC(2024, 0, 10);
const DAY = 86_400_000;
const HOUR = 3_600_000;

let db: HindsightDB;
beforeEach(() => {
  db = openDatabase();
});
afterEach(() => db.close());

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe("inclusive boundaries", () => {
  beforeEach(async () => {
    await db.events.insertMany([
      { id: "ev", timestamp: T0, observedAt: T0 + HOUR, type: "x", entities: ["A"] },
      { id: "before", timestamp: T0 - 1, type: "x" },
      { id: "after", timestamp: T0 + 1, type: "x" },
    ]);
    await db.timeline.insertMany([
      { timestamp: T0 - 1, entity: "A", namespace: "m", data: "from-1" },
      { timestamp: T0, entity: "A", namespace: "m", data: "at" },
      { timestamp: T0 + 1, entity: "A", namespace: "m", data: "to+1" },
      { timestamp: T0, observedAt: T0 + HOUR, entity: "A", namespace: "m", data: "obs=ctx" },
      { timestamp: T0, observedAt: T0 + HOUR + 1, entity: "A", namespace: "m", data: "obs=ctx+1" },
    ]);
  });

  it("events.list from/to/asOf are inclusive on the exact millisecond", async () => {
    const ids = async (f: EventFilters) =>
      (await db.events.list({ filters: f })).items.map((e) => e.id);
    expect(await ids({ from: T0, to: T0 })).toEqual(["ev"]);
    expect(await ids({ from: T0 + 1 })).toEqual(["after"]);
    expect(await ids({ to: T0 - 1 })).toEqual(["before"]);
    expect(await ids({ asOf: T0 + HOUR })).toContain("ev");
    expect(await ids({ asOf: T0 + HOUR - 1 })).not.toContain("ev");
  });

  it("timeline.range window and asOf are inclusive", async () => {
    const data = async (q: Parameters<typeof db.timeline.range>[0]) =>
      (await db.timeline.range(q)).items.map((p) => p.data);
    expect(await data({ entity: "A", from: T0, to: T0 })).toEqual(["at", "obs=ctx", "obs=ctx+1"]);
    expect(await data({ entity: "A", from: T0, to: T0, asOf: T0 + HOUR })).toEqual(["at", "obs=ctx"]);
    expect(await data({ entity: "A", from: T0, to: T0, asOf: T0 })).toEqual(["at"]);
    expect(await data({ entity: "A", from: T0 + 1, to: T0 - 1 })).toEqual([]); // inverted window
  });

  it('before "0ms" yields a single-instant window', async () => {
    const streams = await db.timeline.around({ eventId: "ev", before: "0ms", after: 0 });
    expect(streams.m!.map((p) => p.data)).toEqual(["at", "obs=ctx", "obs=ctx+1"]);
  });

  it("history cutoffs: contextUntil / outcomeUntil are inclusive on the exact millisecond", async () => {
    await db.decisions.insertMany([
      { id: "d-at", eventId: "ev", timestamp: T0 + HOUR, action: 1 },
      { id: "d-after", eventId: "ev", timestamp: T0 + HOUR + 1, action: 1 },
    ]);
    await db.outcomes.insertMany([
      { id: "o-at", eventId: "ev", horizon: "1h", result: 1 }, // T0 + 1h
      { id: "o-after", eventId: "ev", horizon: "1h", timestamp: T0 + HOUR + 1, result: 1 },
    ]);
    const h = await db.history.get({ eventId: "ev", before: "0ms", after: 0, outcomeUntil: T0 + HOUR });
    expect(h.window).toEqual({ from: T0, to: T0, contextUntil: T0 + HOUR, outcomeUntil: T0 + HOUR });
    expect(h.context.m!.map((p) => p.data)).toEqual(["at", "obs=ctx"]);
    expect(h.timeline.m!.map((p) => p.data)).toEqual(["at", "obs=ctx"]);
    expect(h.decisions.map((d) => d.id)).toEqual(["d-at"]);
    expect(h.outcomes.map((o) => o.id)).toEqual(["o-at"]);

    // One ms more of outcome knowledge admits the +1 records into timeline but never into context.
    const h2 = await db.history.get({ eventId: "ev", before: "0ms", after: 0, outcomeUntil: T0 + HOUR + 1 });
    expect(h2.context.m!.map((p) => p.data)).toEqual(["at", "obs=ctx"]);
    expect(h2.timeline.m!.map((p) => p.data)).toEqual(["at", "obs=ctx", "obs=ctx+1"]);
    expect(h2.decisions.map((d) => d.id)).toEqual(["d-at", "d-after"]);
    expect(h2.outcomes.map((o) => o.id)).toEqual(["o-at", "o-after"]);
  });

  it("contextUntil equal to outcomeUntil is allowed; contextUntil earlier than the window is fine", async () => {
    const h = await db.history.get({ eventId: "ev", contextUntil: T0 - DAY, outcomeUntil: T0 - DAY });
    expect(h.context).toEqual({});
    expect(h.timeline).toEqual({});
  });
});

describe("unusual timestamps", () => {
  it("negative epoch timestamps work end-to-end, including cursor pagination", async () => {
    await db.events.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, timestamp: (i - 4) * DAY, type: "x", entities: ["A"] })),
    );
    await db.timeline.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ timestamp: (i - 4) * DAY, entity: "A", namespace: "m", data: i - 4 })),
    );
    const p1 = await db.events.list({ limit: 2 });
    const p2 = await db.events.list({ limit: 2, cursor: p1.nextCursor });
    const p3 = await db.events.list({ limit: 2, cursor: p2.nextCursor });
    expect([...p1.items, ...p2.items, ...p3.items].map((e) => e.timestamp)).toEqual([-4, -3, -2, -1, 0].map((d) => d * DAY));
    expect(p3.nextCursor).toBeUndefined();

    const range = await db.timeline.range({ from: "1969-12-29T00:00:00Z", to: new Date(-DAY) });
    expect(range.items.map((p) => p.data)).toEqual([-3, -2, -1]);

    const h = await db.history.get({ eventId: "n3", before: "1d", after: "1d" });
    expect(h.window.from).toBe(-2 * DAY);
    expect(h.timeline.m!.map((p) => p.data)).toEqual([-2, -1, 0]);
    expect(await db.events.similar({ event: [1], filters: { to: -1 } })).toEqual([]);
  });

  it("year-9999 and max-Date timestamps round-trip", async () => {
    const y9999 = "9999-12-31T23:59:59.999Z";
    const maxDate = 8.64e15;
    await db.events.insertMany([
      { id: "far", timestamp: y9999, type: "x" },
      { id: "max", timestamp: new Date(maxDate), type: "x" },
    ]);
    expect((await db.events.get("far"))!.timestamp).toBe(253402300799999);
    expect((await db.events.get("max"))!.timestamp).toBe(maxDate);
    const page = await db.events.list({ filters: { from: y9999 } });
    expect(page.items.map((e) => e.id)).toEqual(["far", "max"]);
    // Beyond the Date range the ISO string is unparseable and rejected.
    await expect(db.events.insert({ timestamp: "+275761-01-01T00:00:00Z", type: "x" })).rejects.toThrow(/Invalid timestamp/);
  });

  it("timestamps beyond int64 are stored as REAL but still compare correctly", async () => {
    await db.events.insertMany([
      { id: "big", timestamp: 1e20, type: "x" },
      { id: "safe", timestamp: Number.MAX_SAFE_INTEGER, type: "x" },
    ]);
    expect((await db.events.get("big"))!.timestamp).toBe(1e20);
    expect((await db.events.get("safe"))!.timestamp).toBe(Number.MAX_SAFE_INTEGER);
    expect((await db.events.list({ filters: { from: 1e19 } })).items.map((e) => e.id)).toEqual(["big"]);
  });

  it("fractional milliseconds are truncated consistently on write and in filters", async () => {
    await db.events.insert({ id: "f", timestamp: 1000.9, observedAt: 1000.1, type: "x" });
    const ev = (await db.events.get("f"))!;
    expect(ev.timestamp).toBe(1000);
    expect(ev.observedAt).toBe(1000);
    expect((await db.events.list({ filters: { from: 1000.2, to: 1000.7 } })).items.map((e) => e.id)).toEqual(["f"]);
    expect((await db.events.list({ filters: { to: 999.999 } })).items).toEqual([]);
    // Negative fractions truncate toward zero, not down.
    await db.timeline.insert({ timestamp: -0.5, entity: "A", namespace: "m", data: 1 });
    expect((await db.timeline.range({ from: 0, to: 0 })).items).toHaveLength(1);
  });

  it("Date objects are accepted in every timestamp slot", async () => {
    const d = (ms: number) => new Date(ms);
    await db.events.insert({ id: "ev", timestamp: d(T0), observedAt: d(T0 + HOUR), type: "x", entities: ["A"] });
    await db.timeline.insert({ timestamp: d(T0), observedAt: d(T0 + HOUR), entity: "A", namespace: "m", data: 1 });
    await db.decisions.insert({ eventId: "ev", timestamp: d(T0 + HOUR), action: 1 });
    await db.outcomes.insert({ eventId: "ev", horizon: "1h", timestamp: d(T0 + 2 * HOUR), result: 1 });

    expect((await db.events.list({ filters: { from: d(T0), to: d(T0), asOf: d(T0 + HOUR) } })).items).toHaveLength(1);
    expect((await db.timeline.range({ from: d(T0), to: d(T0), asOf: d(T0 + HOUR) })).items).toHaveLength(1);
    expect(await db.events.similar({ event: [1], filters: { asOf: d(T0) } })).toEqual([]);
    const h = await db.history.get({ eventId: "ev", contextUntil: d(T0 + HOUR), outcomeUntil: d(T0 + 2 * HOUR) });
    expect(h.window).toMatchObject({ contextUntil: T0 + HOUR, outcomeUntil: T0 + 2 * HOUR });
    expect(h.context.m).toHaveLength(1);
    expect(h.decisions).toHaveLength(1);
    expect(h.outcomes).toHaveLength(1);
    expect((await db.timeline.around({ eventId: "ev", asOf: d(T0) })).m).toBeUndefined();
  });

  it('SURPRISE: short all-digit strings are epoch ms, not years; a leading "+" is an expanded-year ISO date', () => {
    // "2024" is not January 1st 2024 — it is 2.024 seconds after the epoch.
    expect(toMillis("2024")).toBe(2024);
    expect(toMillis("20240110")).toBe(20240110);
    // "+1000" does not match the numeric fast path and Date.parse reads it as the year 1000
    // (in *local* time, since it is a date-only form V8 does not treat as UTC).
    expect(new Date(toMillis("+1000")).getFullYear()).toBe(1000);
    expect(toMillis(" 1000 ")).toBe(1000);
  });
});

describe("durations", () => {
  it('"1.5d", whitespace and sign are accepted everywhere a duration is', async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", entities: ["A"] });
    const h = await db.history.get({ eventId: "ev", before: " + 1.5d ", after: "-2h" });
    expect(h.window.from).toBe(T0 - 1.5 * DAY);
    expect(h.window.to).toBe(T0 + 2 * HOUR); // sign is ignored on after/before
    const o = await db.outcomes.insert({ eventId: "ev", horizon: " 1.5d ", result: 1 });
    expect(o.horizon).toBe("1.5d");
    expect(o.horizonMs).toBe(1.5 * DAY);
    expect(o.timestamp).toBe(T0 + 1.5 * DAY);
    const streams = await db.timeline.around({ eventId: "ev", before: "1.5d", after: "36h" });
    expect(streams).toEqual({});
  });

  it("a negative horizon is rejected", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x" });
    await expect(db.outcomes.insert({ eventId: "ev", horizon: "-1d", result: 1 })).rejects.toThrow(/must not be negative/);
    await expect(db.outcomes.insert({ eventId: "ev", horizon: -5, result: 1 })).rejects.toThrow(/must not be negative/);
  });

  it('unit-less "0" is accepted; other unit-less values are not; "1M" is one minute', async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x" });
    expect((await db.history.get({ eventId: "ev", after: "0" })).window.to).toBe(T0);
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration(" -00 ")).toBe(0);
    expect(() => parseDuration("5")).toThrow(/Invalid duration/);
    expect(parseDuration("0ms")).toBe(0);
    expect(parseDuration(0)).toBe(0);
    // Units are case-insensitive, so "M" is minutes, not months.
    expect(parseDuration("1M")).toBe(60_000);
    expect(parseDuration("1D")).toBe(DAY);
    // Sub-millisecond durations truncate to zero and scientific notation is rejected.
    expect(parseDuration("0.5ms")).toBe(0);
    expect(() => parseDuration("1e3ms")).toThrow(/Invalid duration/);
    expect(() => parseDuration(Infinity)).toThrow(/Invalid duration/);
  });

  it("an absurdly large numeric window does not throw", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x" });
    const h = await db.history.get({ eventId: "ev", before: 1e308, after: 1e308 });
    expect(h.window.from).toBe(-1e308);
    expect(h.window.to).toBe(1e308);
  });
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

describe("string inputs", () => {
  it("unicode and emoji round-trip through ids, types, entities, namespaces and filters", async () => {
    const id = "事件-😀-ñ";
    const type = "収益/📈";
    const entity = "AAPL 🍎";
    const ns = "ニュース📰";
    await db.events.insert({ id, timestamp: T0, type, entities: [entity], content: "内容 🧪", metadata: { k: "値" } });
    await db.timeline.insert({ timestamp: T0, entity, namespace: ns, data: { text: "😀" } });
    await db.decisions.insert({ id: "決定", eventId: id, timestamp: T0, action: { side: "買い" } });
    await db.outcomes.insert({ id: "結果", eventId: id, decisionId: "決定", horizon: "1d", result: "😀" });

    const ev = (await db.events.get(id))!;
    expect(ev).toMatchObject({ id, type, entities: [entity], content: "内容 🧪", metadata: { k: "値" } });
    expect((await db.events.list({ filters: { type, entities: entity, metadata: { k: "値" } } })).items).toHaveLength(1);
    const streams = await db.timeline.around({ eventId: id, before: "0ms" });
    expect(Object.keys(streams)).toEqual([ns]);
    expect(streams[ns]![0]!.data).toEqual({ text: "😀" });
    const h = await db.history.get({ eventId: id, after: "1d", namespace: ns });
    expect(h.decisions[0]!.id).toBe("決定");
    expect(h.outcomes[0]!.decisionId).toBe("決定");
  });

  it("emoji ids paginate correctly through a cursor (ties on timestamp broken by id)", async () => {
    const ids = ["😀", "🙂", "a", "z", "Ω", "😎"];
    await db.events.insertMany(ids.map((id) => ({ id, timestamp: T0, type: "x" })));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await db.events.list({ limit: 2, cursor });
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("entity ids containing commas and quotes are stored, filtered and returned intact", async () => {
    const entities = ["AAPL,MSFT", "O'Reilly", 'say "hi"', "back\\slash", "semi;colon"];
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", entities });
    expect(new Set((await db.events.get("ev"))!.entities)).toEqual(new Set(entities));
    for (const e of entities) {
      expect((await db.events.list({ filters: { entities: e } })).items.map((x) => x.id)).toEqual(["ev"]);
    }
    expect((await db.events.list({ filters: { entities: "AAPL" } })).items).toEqual([]);
    expect((await db.events.list({ filters: { entities: "MSFT" } })).items).toEqual([]);
  });

  // U+001F is the internal entity join separator; it is rejected at insert so reads can never split an id.
  it("an entity id containing U+001F is rejected", async () => {
    const entity = "a\x1fb";
    await expect(db.events.insert({ id: "ev", timestamp: T0, type: "x", entities: [entity] })).rejects.toThrow(/U\+001F/);
    await expect(db.timeline.insert({ timestamp: T0, entity, namespace: "m", data: 1 })).rejects.toThrow(/U\+001F/);
    await expect(db.timeline.insert({ timestamp: T0, entity: "A", namespace: entity, data: 1 })).rejects.toThrow(/U\+001F/);
  });

  it("entity order is preserved from insert() through get()/list()/similar()", async () => {
    const inserted = await db.events.insert({
      id: "ev", timestamp: T0, type: "x", entities: ["MSFT", "AAPL", "GOOG", "AAPL"], embedding: [1],
    });
    expect(inserted.entities).toEqual(["MSFT", "AAPL", "GOOG"]);
    expect((await db.events.get("ev"))!.entities).toEqual(["MSFT", "AAPL", "GOOG"]);
    expect((await db.events.list()).items[0]!.entities).toEqual(["MSFT", "AAPL", "GOOG"]);
    expect((await db.events.similar({ event: [1] }))[0]!.entities).toEqual(["MSFT", "AAPL", "GOOG"]);
  });

  it("empty-string entities are rejected, like timeline entities", async () => {
    await expect(db.events.insert({ id: "e", timestamp: T0, type: "x", entities: [""] })).rejects.toThrow(/non-empty/);
    await expect(db.events.insert({ id: "e", timestamp: T0, type: "x", entities: ["A", ""] })).rejects.toThrow(/non-empty/);
    expect(await db.events.get("e")).toBeUndefined();
  });

  it("empty-string ids are rejected everywhere", async () => {
    await expect(db.events.insert({ id: "", timestamp: T0, type: "x" })).rejects.toThrow(/event.id must be a non-empty/);
    await db.events.insert({ id: "ev", timestamp: T0, type: "x" });
    await expect(db.decisions.insert({ id: "", eventId: "ev", timestamp: T0, action: 1 })).rejects.toThrow(/decision.id/);
    await expect(db.decisions.insert({ eventId: "", timestamp: T0, action: 1 })).rejects.toThrow(/decision.eventId/);
    await expect(db.outcomes.insert({ id: "", eventId: "ev", horizon: "1d", result: 1 })).rejects.toThrow(/outcome.id/);
    await expect(db.outcomes.insert({ eventId: "", horizon: "1d", result: 1 })).rejects.toThrow(/outcome.eventId/);
  });

  it("decisionId '' is rejected up front rather than silently anchoring on the event", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x" });
    await expect(
      db.outcomes.insert({ eventId: "ev", decisionId: "", horizon: "1d", result: 1 }),
    ).rejects.toThrow(/outcome.decisionId must be a non-empty/);
    expect(await db.outcomes.forEvent("ev")).toEqual([]);
  });

  it("very long strings (100k chars) round-trip as id, type, entity and namespace", async () => {
    const long = "x".repeat(100_000);
    await db.events.insert({ id: long, timestamp: T0, type: long, entities: [long], content: long, metadata: { k: long } });
    await db.timeline.insert({ timestamp: T0, entity: long, namespace: long, data: long });
    const ev = (await db.events.get(long))!;
    expect(ev.type).toBe(long);
    expect(ev.entities).toEqual([long]);
    expect(ev.content).toBe(long);
    expect((await db.events.list({ filters: { type: long, entities: long, metadata: { k: long } } })).items).toHaveLength(1);
    const streams = await db.timeline.around({ eventId: long, before: "0ms" });
    expect(streams[long]![0]!.data).toBe(long);
  });

  it("an event with many entities lists and filters correctly", async () => {
    const entities = Array.from({ length: 2000 }, (_, i) => `ent-${i}`);
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", entities });
    expect((await db.events.get("ev"))!.entities).toHaveLength(2000);
    expect((await db.events.list({ filters: { entities: ["ent-1999", "nope"] } })).items.map((e) => e.id)).toEqual(["ev"]);
    await db.events.delete("ev");
    expect((await db.events.list({ filters: { entities: "ent-0" } })).items).toEqual([]);
  });
});

describe("JSON content and metadata", () => {
  it("deeply nested content (2000 levels) round-trips", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 2000; i++) deep = { d: deep };
    const ev = await db.events.insert({ id: "ev", timestamp: T0, type: "x", content: deep as never });
    expect(ev.content).toEqual(deep);
    expect((await db.events.get("ev"))!.content).toEqual(deep);
    await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: deep as never });
    expect((await db.timeline.range({ from: T0, to: T0 })).items[0]!.data).toEqual(deep);
  });

  // SQLite's JSON parser refuses documents nested deeper than 1000 levels, and
  // json_extract runs over every row when a metadata filter is used — so such
  // metadata is rejected at insert instead of poisoning every later query.
  it("metadata too deep for SQLite JSON is rejected at insert; shallow metadata keeps working", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 1200; i++) deep = { d: deep };
    await db.events.insert({ id: "shallow", timestamp: T0, type: "x", metadata: { k: 1 }, embedding: [1] });
    await expect(
      db.events.insert({ id: "deep", timestamp: T0, type: "x", metadata: { k: 1, deep: deep as never } }),
    ).rejects.toThrow(/too deeply nested/);
    expect((await db.events.list({ filters: { metadata: { k: 1 } } })).items.map((e) => e.id)).toEqual(["shallow"]);
    expect(await db.events.similar({ event: [1], filters: { metadata: { k: 1 } } })).toHaveLength(1);
    // Non-object metadata is rejected too, since filters address `$.key`.
    await expect(db.events.insert({ timestamp: T0, type: "x", metadata: [1] as never })).rejects.toThrow(/plain object/);
  });

  it("SURPRISE: JSON.stringify semantics apply — undefined is dropped, NaN becomes null, Dates become strings, BigInt throws", async () => {
    const ev = await db.events.insert({
      timestamp: T0,
      type: "x",
      content: { a: undefined, b: NaN, c: new Date(0), d: [undefined, Infinity] } as never,
      metadata: { m: undefined } as never,
    });
    expect(ev.content).toEqual({ b: null, c: "1970-01-01T00:00:00.000Z", d: [null, null] });
    expect(ev.metadata).toEqual({});
    await expect(db.events.insert({ timestamp: T0, type: "x", content: { n: 1n } as never })).rejects.toThrow(/BigInt/);
    await expect(db.decisions.insert({ eventId: ev.id, timestamp: T0, action: { n: 1n } as never })).rejects.toThrow(/BigInt/);
  });

  it("metadata filter is strict about string vs number", async () => {
    await db.events.insert({ id: "n", timestamp: T0, type: "x", metadata: { v: 5 } });
    await db.events.insert({ id: "s", timestamp: T0, type: "x", metadata: { v: "5" } });
    const ids = async (v: string | number) => (await db.events.list({ filters: { metadata: { v } } })).items.map((e) => e.id);
    expect(await ids(5)).toEqual(["n"]);
    expect(await ids("5")).toEqual(["s"]);
    expect(await ids(5.0)).toEqual(["n"]);
  });

  it("metadata filter is type-strict: booleans, numbers and strings do not cross-match", async () => {
    await db.events.insert({ id: "bool", timestamp: T0, type: "x", metadata: { flag: true } });
    await db.events.insert({ id: "int", timestamp: T0, type: "x", metadata: { flag: 1 } });
    await db.events.insert({ id: "str", timestamp: T0, type: "x", metadata: { flag: "1" } });
    await db.events.insert({ id: "real", timestamp: T0, type: "x", metadata: { flag: 1.5 } });
    const ids = async (flag: boolean | number | string) =>
      (await db.events.list({ filters: { metadata: { flag } } })).items.map((e) => e.id);
    expect(await ids(true)).toEqual(["bool"]);
    expect(await ids(1)).toEqual(["int"]);
    expect(await ids(1.5)).toEqual(["real"]);
    expect(await ids("1")).toEqual(["str"]);
    expect(await ids(false)).toEqual([]);
  });

  it("metadata filter with null matches only an explicit null, not a missing key", async () => {
    await db.events.insert({ id: "explicit", timestamp: T0, type: "x", metadata: { v: null } });
    await db.events.insert({ id: "missing", timestamp: T0, type: "x", metadata: {} });
    await db.events.insert({ id: "obj", timestamp: T0, type: "x", metadata: { v: { nested: true } } });
    expect((await db.events.list({ filters: { metadata: { v: null } } })).items.map((e) => e.id)).toEqual(["explicit"]);
  });

  it("`__proto__` and numeric metadata keys are stored as own properties and are filterable without pollution", async () => {
    const meta = JSON.parse('{"__proto__": 7, "0": "zero", "constructor": "c"}');
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", metadata: meta });
    const got = (await db.events.get("ev"))!.metadata;
    expect(Object.getOwnPropertyDescriptor(got, "__proto__")?.value).toBe(7);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect((await db.events.list({ filters: { metadata: JSON.parse('{"__proto__": 7}') } })).items).toHaveLength(1);
    expect((await db.events.list({ filters: { metadata: { "0": "zero", constructor: "c" } } })).items).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("non-scalar metadata filter values are rejected with a clear error", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", metadata: { v: 5 } });
    for (const v of [{ a: 1 }, [5, 6], [5], undefined]) {
      await expect(db.events.list({ filters: { metadata: { v: v as never } } })).rejects.toThrow(
        /must be a string, number, boolean or null/,
      );
    }
  });

  it("SURPRISE: non-ASCII metadata keys cannot be filtered on", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", metadata: { señor: 1, "a-b": 2 } });
    await expect(db.events.list({ filters: { metadata: { señor: 1 } } })).rejects.toThrow(/Invalid metadata filter key/);
    await expect(db.events.list({ filters: { metadata: { "a-b": 2 } } })).rejects.toThrow(/Invalid metadata filter key/);
  });

  it("SURPRISE: empty filter lists mean 'no filter', not 'match nothing'", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", entities: ["A"], embedding: [1] });
    await db.timeline.insertMany([
      { timestamp: T0, entity: "A", namespace: "m", data: 1 },
      { timestamp: T0, entity: "B", namespace: "n", data: 2 },
    ]);
    expect((await db.events.list({ filters: { type: [], entities: [], excludeIds: [] } })).items).toHaveLength(1);
    expect(await db.events.similar({ event: [1], filters: { type: [] } })).toHaveLength(1);
    expect((await db.timeline.range({ from: T0, to: T0, entity: [], namespace: [] })).items).toHaveLength(2);
    // An explicit `entities: []` override on around/history widens to *all* entities
    // rather than narrowing to none — easy to hit when an app passes through a
    // computed (possibly empty) list.
    expect(Object.keys(await db.timeline.around({ eventId: "ev", before: "0ms", entities: [], namespace: [] })).sort()).toEqual(["m", "n"]);
    expect(Object.keys((await db.history.get({ eventId: "ev", entities: [] })).timeline).sort()).toEqual(["m", "n"]);
  });
});

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

describe("embeddings", () => {
  it("1-dim and 4096-dim vectors work, and only same-dimension events are candidates", async () => {
    const rnd = (seed: number) => {
      // mulberry32: independent pseudo-random vectors per seed (Math.sin(seed + i) would be correlated).
      let a = seed >>> 0;
      return Float32Array.from({ length: 4096 }, () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
      });
    };
    await db.events.insertMany([
      { id: "one-pos", timestamp: T0, type: "x", embedding: [3] },
      { id: "one-neg", timestamp: T0, type: "x", embedding: [-2] },
      { id: "big1", timestamp: T0, type: "x", embedding: rnd(1) },
      { id: "big2", timestamp: T0, type: "x", embedding: rnd(2) },
      { id: "big3", timestamp: T0, type: "x", embedding: rnd(3) },
    ]);
    expect((await db.events.similar({ event: [1] })).map((h) => [h.id, h.score])).toEqual([
      ["one-pos", 1],
      ["one-neg", -1],
    ]);
    const hits = await db.events.similar({ event: rnd(1) });
    expect(hits.map((h) => h.id)).toHaveLength(3);
    expect(hits[0]!.id).toBe("big1");
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    const byId = await db.events.similar({ event: "big1" });
    expect(byId.map((h) => h.id).sort()).toEqual(["big2", "big3"]);
    expect(byId.every((h) => Math.abs(h.score) < 0.2)).toBe(true);
    // A dimension nobody has -> no candidates, no error.
    expect(await db.events.similar({ event: [1, 2, 3] })).toEqual([]);
  });

  it("Float32Array views with a non-zero byteOffset are encoded correctly at insert and query time", async () => {
    const backing = new Float32Array([9, 9, 0, 1, 0, 9, 9]);
    const view = backing.subarray(2, 5); // [0, 1, 0], byteOffset 8
    expect(view.byteOffset).toBe(8);
    await db.events.insert({ id: "v", timestamp: T0, type: "x", embedding: view });
    await db.events.insert({ id: "w", timestamp: T0, type: "x", embedding: [1, 0, 0] });
    expect(Array.from((await db.events.get("v", { includeEmbedding: true }))!.embedding!)).toEqual([0, 1, 0]);
    const hits = await db.events.similar({ event: new Float32Array(backing.buffer, 8, 3) });
    expect(hits.map((h) => [h.id, h.score])).toEqual([
      ["v", 1],
      ["w", 0],
    ]);
    // Mutating the backing array after insert does not affect what was stored.
    backing[3] = 5;
    expect(Array.from((await db.events.get("v", { includeEmbedding: true }))!.embedding!)).toEqual([0, 1, 0]);
  });

  it("stored embeddings are float32: double inputs come back rounded", async () => {
    await db.events.insert({ id: "v", timestamp: T0, type: "x", embedding: [0.1, 1e-45, 3.4e38] });
    const got = Array.from((await db.events.get("v", { includeEmbedding: true }))!.embedding!);
    expect(got).toEqual([Math.fround(0.1), Math.fround(1e-45), Math.fround(3.4e38)]);
    expect(got[0]).not.toBe(0.1);
  });

  it("zero vectors score 0 at insert and query time, and are excluded by any positive minScore", async () => {
    await db.events.insertMany([
      { id: "zero", timestamp: T0, type: "x", embedding: [0, 0] },
      { id: "unit", timestamp: T0, type: "x", embedding: [1, 0] },
    ]);
    expect((await db.events.similar({ event: [1, 0] })).map((h) => [h.id, h.score])).toEqual([
      ["unit", 1],
      ["zero", 0],
    ]);
    expect((await db.events.similar({ event: [0, 0] })).map((h) => h.score)).toEqual([0, 0]);
    expect((await db.events.similar({ event: "zero" })).map((h) => [h.id, h.score])).toEqual([["unit", 0]]);
    expect(await db.events.similar({ event: "zero", minScore: Number.MIN_VALUE })).toEqual([]);
  });

  it("limit larger than the candidate count returns everything; minScore > 1 returns nothing", async () => {
    await db.events.insertMany(Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, timestamp: T0, type: "x", embedding: [1, i] })));
    expect(await db.events.similar({ event: [1, 0], limit: 1000 })).toHaveLength(5);
    expect(await db.events.similar({ event: [1, 0], minScore: 1.0000001 })).toEqual([]);
    expect(await db.events.similar({ event: [1, 0], minScore: 1 })).toHaveLength(1); // exact match survives minScore 1
  });

  it("limit must be a positive integer and minScore a finite number", async () => {
    await db.events.insertMany(Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, timestamp: T0, type: "x", embedding: [1, i] })));
    for (const limit of [0, -5, 2.7, NaN, Infinity]) {
      await expect(db.events.similar({ event: [1, 0], limit })).rejects.toThrow(/limit must be a positive integer/);
    }
    await expect(db.events.similar({ event: [1, 0], minScore: NaN })).rejects.toThrow(/minScore must be a finite/);
    expect(await db.events.similar({ event: [1, 0], limit: 2 })).toHaveLength(2);
  });

  it("similar() with an unknown id in the object form just excludes that id", async () => {
    await db.events.insert({ id: "a", timestamp: T0, type: "x", embedding: [1] });
    expect((await db.events.similar({ event: { id: "ghost", embedding: [1] } })).map((h) => h.id)).toEqual(["a"]);
    expect(await db.events.similar({ event: { id: "a", embedding: [1] } })).toEqual([]);
    await expect(db.events.similar({ event: {} })).rejects.toThrow(TypeError);
    await expect(db.events.similar({ event: [] })).rejects.toThrow(/must not be empty/);
    await expect(db.events.similar({ event: new Float32Array(0) })).rejects.toThrow(/must not be empty/);
  });
});

// ---------------------------------------------------------------------------
// Pagination / cursors
// ---------------------------------------------------------------------------

describe("cursors", () => {
  beforeEach(async () => {
    await db.events.insertMany(
      Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, timestamp: T0 + i * DAY, type: i % 2 ? "odd" : "even" })),
    );
    await db.timeline.insertMany(
      Array.from({ length: 6 }, (_, i) => ({ timestamp: T0 + i * DAY, entity: "A", namespace: "m", data: i })),
    );
  });

  it("a cursor reused with different filters continues from the same key under the new filters", async () => {
    const p1 = await db.events.list({ limit: 2 }); // e0, e1
    const odd = await db.events.list({ limit: 10, cursor: p1.nextCursor, filters: { type: "odd" } });
    expect(odd.items.map((e) => e.id)).toEqual(["e3", "e5"]);
    const later = await db.events.list({ limit: 10, cursor: p1.nextCursor, filters: { from: T0 + 4 * DAY } });
    expect(later.items.map((e) => e.id)).toEqual(["e4", "e5"]);
  });

  it("SURPRISE: an asc cursor used in a desc query walks backwards from the key", async () => {
    const p1 = await db.events.list({ limit: 3 }); // e0..e2, cursor at e2
    const back = await db.events.list({ limit: 10, cursor: p1.nextCursor, order: "desc" });
    expect(back.items.map((e) => e.id)).toEqual(["e1", "e0"]);
  });

  it("an exactly-full final page carries no cursor and a stale cursor returns an empty page", async () => {
    const p1 = await db.events.list({ limit: 3 });
    const p2 = await db.events.list({ limit: 3, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(3);
    expect(p2.nextCursor).toBeUndefined();
    // Re-using p1's cursor after everything past it has been deleted.
    for (const id of ["e3", "e4", "e5"]) await db.events.delete(id);
    const empty = await db.events.list({ limit: 3, cursor: p1.nextCursor });
    expect(empty).toEqual({ items: [] });

    const t1 = await db.timeline.range({ from: T0, to: T0 + 10 * DAY, limit: 6 });
    expect(t1.nextCursor).toBeUndefined();
    const t2 = await db.timeline.range({ from: T0, to: T0 + 10 * DAY, limit: 5 });
    const t3 = await db.timeline.range({ from: T0, to: T0 + 10 * DAY, limit: 5, cursor: t2.nextCursor });
    expect(t3.items.map((p) => p.data)).toEqual([5]);
    expect(t3.nextCursor).toBeUndefined();
  });

  it("tampered cursors: appended garbage is rejected", async () => {
    const p1 = await db.events.list({ limit: 2 });
    await expect(db.events.list({ cursor: p1.nextCursor + "xx" })).rejects.toThrow(/Invalid cursor/);
    await expect(db.events.list({ cursor: "%%%" })).rejects.toThrow(/Invalid cursor/);
    const t1 = await db.timeline.range({ from: T0, to: T0 + 10 * DAY, limit: 2 });
    await expect(db.timeline.range({ from: T0, to: T0 + 10 * DAY, cursor: t1.nextCursor + "xx" })).rejects.toThrow(/Invalid cursor/);
  });

  it("SURPRISE: well-formed base64 that is not a {t,id} object is not rejected", async () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    // `{}` / `[]` / wrong-typed fields bind NULL or mismatched types -> silently empty page.
    expect((await db.events.list({ cursor: b64("{}") })).items).toEqual([]);
    expect((await db.events.list({ cursor: b64("[]") })).items).toEqual([]);
    expect((await db.events.list({ cursor: b64('{"t":"x","id":"e0"}') })).items).toEqual([]);
    expect((await db.timeline.range({ from: T0, to: T0 + 10 * DAY, cursor: b64("{}") })).items).toEqual([]);
    // `null` is treated as "no cursor".
    expect((await db.events.list({ cursor: b64("null") })).items).toHaveLength(6);
    // A timeline cursor (numeric id) fed to events.list is accepted; TEXT ids always sort after a number,
    // so the row sharing the cursor timestamp is repeated.
    const t1 = await db.timeline.range({ from: T0, to: T0 + 10 * DAY, limit: 2 }); // cursor at (T0 + 1d, id 2)
    expect((await db.events.list({ cursor: t1.nextCursor })).items.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("non-integer or non-positive list limits are rejected up front; oversize limits are capped", async () => {
    for (const limit of [2.5, NaN, 0, -1]) {
      await expect(db.events.list({ limit })).rejects.toThrow(/limit must be a positive integer/);
      await expect(db.timeline.range({ from: T0, to: T0, limit })).rejects.toThrow(/limit must be a positive integer/);
    }
  });

  it("events.list caps limit at 10 000 and still returns a cursor", async () => {
    await db.events.insertMany(Array.from({ length: 10_001 - 6 }, (_, i) => ({ id: `bulk${i}`, timestamp: T0 + 100 * DAY + i, type: "x" })));
    const page = await db.events.list({ limit: 50_000 });
    expect(page.items).toHaveLength(10_000);
    expect(page.nextCursor).toBeDefined();
    const rest = await db.events.list({ limit: 50_000, cursor: page.nextCursor });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle: on-disk databases", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hindsight-db-edge-"));
    path = join(dir, "edge.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("survives being closed and reopened many times", async () => {
    for (let i = 0; i < 30; i++) {
      const h = openDatabase({ path });
      await h.events.insert({ id: `e${i}`, timestamp: T0 + i, type: "x", entities: ["A"], embedding: [1, i] });
      await h.timeline.insert({ timestamp: T0 + i, entity: "A", namespace: "m", data: i });
      expect((await h.events.list({ limit: 1000 })).items).toHaveLength(i + 1);
      h.close();
      h.close(); // double close is harmless
    }
    const h = openDatabase({ path });
    expect(await db.events.similar({ event: [1, 0] })).toEqual([]); // the in-memory db is unrelated
    expect((await h.events.similar({ event: [1, 0], limit: 100 })).map((x) => x.id)[0]).toBe("e0");
    expect((await h.timeline.range({ from: 0, to: T0 + DAY })).items).toHaveLength(30);
    h.close();
  });

  it("two handles on the same file see each other's committed writes (WAL)", async () => {
    const a = openDatabase({ path });
    const b = openDatabase({ path });
    await a.events.insert({ id: "from-a", timestamp: T0, type: "x", entities: ["A"] });
    expect((await b.events.get("from-a"))?.id).toBe("from-a");
    await b.decisions.insert({ id: "d", eventId: "from-a", timestamp: T0, action: 1 });
    await b.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });
    const h = await a.history.get({ eventId: "from-a", before: "0ms" });
    expect(h.decisions.map((d) => d.id)).toEqual(["d"]);
    expect(h.timeline.m).toHaveLength(1);
    // A delete on one handle cascades and is visible on the other.
    await b.events.delete("from-a");
    expect(await a.events.get("from-a")).toBeUndefined();
    expect(await a.decisions.get("d")).toBeUndefined();
    // Closing one handle does not affect the other.
    a.close();
    expect((await b.timeline.range({ from: T0, to: T0 })).items).toHaveLength(1);
    await expect(a.events.list()).rejects.toThrow(/not open/);
    b.close();
  });

  it("a write on one handle inside a transaction is invisible to the other until commit", async () => {
    const a = openDatabase({ path });
    const b = openDatabase({ path });
    let seenDuring: number | undefined;
    a.transaction(() => {
      void a.events.insert({ id: "pending", timestamp: T0, type: "x" });
      // b is a separate connection; a synchronous read here happens before a commits.
      seenDuring = (b as unknown as { conn: { db: { prepare(sql: string): { all(): unknown[] } } } }).conn.db
        .prepare("SELECT id FROM events")
        .all().length;
    });
    expect(seenDuring).toBe(0);
    expect((await b.events.get("pending"))?.id).toBe("pending");
    a.close();
    b.close();
  });

  it("opening a path in a missing directory fails loudly", () => {
    expect(() => openDatabase({ path: join(dir, "missing", "x.db") })).toThrow(/directory does not exist/);
  });
});

describe("lifecycle: deletes, ids, batches and transactions", () => {
  it("delete cascades to decisions, outcomes and event_entities; the id can then be reused", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", entities: ["A"] });
    await db.decisions.insert({ id: "d", eventId: "ev", timestamp: T0, action: 1 });
    await db.outcomes.insert({ id: "o", eventId: "ev", decisionId: "d", horizon: "1d", result: 1 });
    await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 });

    expect(await db.events.delete("ev")).toBe(true);
    expect(await db.decisions.get("d")).toBeUndefined();
    expect(await db.outcomes.get("o")).toBeUndefined();
    expect(await db.decisions.forEvent("ev")).toEqual([]);
    expect(await db.outcomes.forEvent("ev")).toEqual([]);
    expect((await db.events.list({ filters: { entities: "A" } })).items).toEqual([]);
    await expect(db.history.get({ eventId: "ev" })).rejects.toThrow(/not found/);
    expect(await db.history.getMany({ eventIds: ["ev"] })).toEqual([]);

    // Re-insert with the same id: a clean slate, but timeline data (keyed by entity) is untouched.
    const again = await db.events.insert({ id: "ev", timestamp: T0, type: "y", entities: ["B"] });
    expect(again.type).toBe("y");
    const h = await db.history.get({ eventId: "ev", before: "0ms", entities: "A" });
    expect(h.decisions).toEqual([]);
    expect(h.outcomes).toEqual([]);
    expect(h.timeline.m).toHaveLength(1);
    // The old decision id is free again.
    await db.decisions.insert({ id: "d", eventId: "ev", timestamp: T0, action: 2 });
    expect((await db.decisions.get("d"))!.action).toBe(2);
  });

  it("an idGenerator that repeats ids fails on the second insert with a UNIQUE error, and the batch is atomic", async () => {
    const local = openDatabase({ idGenerator: () => "same" });
    try {
      await local.events.insert({ timestamp: T0, type: "x" });
      await expect(local.events.insert({ timestamp: T0, type: "x" })).rejects.toThrow(/UNIQUE/);
      await local.decisions.insert({ eventId: "same", timestamp: T0, action: 1 });
      await expect(local.decisions.insert({ eventId: "same", timestamp: T0, action: 1 })).rejects.toThrow(/UNIQUE/);
      await expect(local.outcomes.insertMany([
        { eventId: "same", horizon: "1d", result: 1 },
        { eventId: "same", horizon: "2d", result: 2 },
      ])).rejects.toThrow(/UNIQUE/);
      expect(await local.outcomes.forEvent("same")).toEqual([]);
      // Explicit ids bypass the generator.
      expect((await local.events.insert({ id: "explicit", timestamp: T0, type: "x" })).id).toBe("explicit");
    } finally {
      local.close();
    }
  });

  it("duplicate ids within one insertMany batch roll back the whole batch", async () => {
    await expect(db.events.insertMany([
      { id: "a", timestamp: T0, type: "x" },
      { id: "b", timestamp: T0, type: "x" },
      { id: "a", timestamp: T0, type: "x" },
    ])).rejects.toThrow(/UNIQUE/);
    expect((await db.events.list()).items).toEqual([]);
    // Duplicate *entities* within one event are fine (deduplicated).
    const ev = await db.events.insert({ id: "a", timestamp: T0, type: "x", entities: ["A", "A", "B", "A"] });
    expect(ev.entities).toEqual(["A", "B"]);
  });

  it("insertMany([]) is a no-op on every store", async () => {
    expect(await db.events.insertMany([])).toEqual([]);
    expect(await db.timeline.insertMany([])).toEqual([]);
    expect(await db.decisions.insertMany([])).toEqual([]);
    expect(await db.outcomes.insertMany([])).toEqual([]);
    expect(await db.events.getMany([])).toEqual([]);
    expect(await db.history.getMany({ eventIds: [] })).toEqual([]);
  });

  it("transaction(): a throw in the callback rolls back nested insertMany calls and nested transactions", async () => {
    await db.events.insert({ id: "keep", timestamp: T0, type: "x" });
    expect(() =>
      db.transaction(() => {
        void db.events.insertMany([{ id: "a", timestamp: T0, type: "x", entities: ["A"] }]);
        db.transaction(() => {
          void db.timeline.insertMany([{ timestamp: T0, entity: "A", namespace: "m", data: 1 }]);
          void db.decisions.insertMany([{ id: "d", eventId: "a", timestamp: T0, action: 1 }]);
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect((await db.events.list()).items.map((e) => e.id)).toEqual(["keep"]);
    expect((await db.timeline.range({ from: T0, to: T0 })).items).toEqual([]);
    expect(await db.decisions.get("d")).toBeUndefined();
    expect((await db.events.list({ filters: { entities: "A" } })).items).toEqual([]);

    // The happy path commits and returns the callback's value.
    const n = db.transaction(() => {
      void db.events.insertMany([{ id: "a", timestamp: T0, type: "x" }]);
      return db.transaction(() => 42);
    });
    expect(n).toBe(42);
    expect((await db.events.get("a"))?.id).toBe("a");
  });

  it("transaction(): an async callback keeps the transaction open across awaits and commits when it resolves", async () => {
    const n = await db.transaction(async () => {
      const ev = await db.events.insert({ id: "a", timestamp: T0, type: "x" });
      const d = await db.decisions.insert({ eventId: ev.id, timestamp: T0, action: 1 });
      await db.outcomes.insert({ eventId: ev.id, decisionId: d.id, horizon: "1d", result: 1 });
      return 3;
    });
    expect(n).toBe(3);
    expect((await db.history.get({ eventId: "a", after: "2d" })).outcomes).toHaveLength(1);
  });

  it("transaction(): an async callback that rejects rolls back everything it awaited", async () => {
    await expect(
      db.transaction(async () => {
        await db.events.insert({ id: "b", timestamp: T0, type: "x" });
        await db.timeline.insert({ timestamp: T0, entity: "B", namespace: "m", data: 1 });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await db.events.get("b")).toBeUndefined();
    expect((await db.timeline.range({ from: T0, to: T0 })).items).toEqual([]);
  });

  it("transaction(): store calls from another context wait for an open async transaction", async () => {
    let released = false;
    const tx = db.transaction(async () => {
      await db.events.insert({ id: "c", timestamp: T0, type: "x" });
      await new Promise((r) => setTimeout(r, 20));
      released = true;
    });
    // Issued while the transaction is open, from outside it: runs after the commit.
    const outside = db.events.get("c").then((ev) => ({ ev, released }));
    await tx;
    expect(await outside).toEqual({ ev: expect.objectContaining({ id: "c" }), released: true });
  });

  // Store methods are async, so a failure inside one surfaces as a rejected
  // promise; the outer transaction still observes it and rolls back everything.
  it("a failing store call inside db.transaction rolls back its siblings and rethrows", async () => {
    const rejections: unknown[] = [];
    expect(() =>
      db.transaction(() => {
        db.events.insert({ id: "first", timestamp: T0, type: "x" }).catch((e) => rejections.push(e));
        db.events.insert({ id: "first", timestamp: T0, type: "x" }).catch((e) => rejections.push(e)); // UNIQUE
        db.events.insert({ id: "second", timestamp: T0, type: "x" }).catch((e) => rejections.push(e));
      }),
    ).toThrow(/UNIQUE/);
    await new Promise((r) => setTimeout(r, 0));
    expect(rejections).toHaveLength(1);
    expect(await db.events.get("first")).toBeUndefined();
    expect(await db.events.get("second")).toBeUndefined();
    // The connection is usable afterwards and no error state leaks into the next transaction.
    db.transaction(() => {
      db.events.insert({ id: "third", timestamp: T0, type: "x" });
    });
    expect((await db.events.get("third"))?.id).toBe("third");
  });

  it("a validation failure inside db.transaction also rolls back its siblings", async () => {
    expect(() =>
      db.transaction(() => {
        db.events.insert({ id: "ok", timestamp: T0, type: "x" }).catch(() => {});
        db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 }).catch(() => {});
        db.decisions.insert({ eventId: "ok", timestamp: T0, action: undefined as never }).catch(() => {});
      }),
    ).toThrow(/action is required/);
    expect(await db.events.get("ok")).toBeUndefined();
    expect((await db.timeline.range({ from: T0, to: T0 })).items).toEqual([]);
  });

  it("a failing store call in a promise-returning callback rejects the transaction with its real error", async () => {
    await expect(db.transaction(() => db.events.insert({ id: "x", timestamp: T0, type: "" }))).rejects.toThrow(
      /type is required/,
    );
    expect(await db.events.get("x")).toBeUndefined();
  });

  it("validation failures happen before the write transaction, so ids are not burned", async () => {
    const before = (await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 })).id;
    await expect(db.timeline.insertMany([
      { timestamp: T0, entity: "A", namespace: "m", data: 1 },
      { timestamp: "not a date", entity: "A", namespace: "m", data: 1 },
    ])).rejects.toThrow(/Invalid timestamp/);
    const after = (await db.timeline.insert({ timestamp: T0, entity: "A", namespace: "m", data: 1 })).id;
    expect(after).toBe(before + 1);
    expect((await db.timeline.range({ from: T0, to: T0 })).items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Decisions / outcomes oddities
// ---------------------------------------------------------------------------

describe("decisions and outcomes: unvalidated orderings", () => {
  it("SURPRISE: decisions before the event and outcomes before their decision are accepted", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, observedAt: T0 + HOUR, type: "x" });
    const d = await db.decisions.insert({ id: "d", eventId: "ev", timestamp: T0 - DAY, action: 1 }); // before the event
    expect(d.timestamp).toBe(T0 - DAY);
    const o = await db.outcomes.insert({ eventId: "ev", decisionId: "d", horizon: "1d", timestamp: 0, result: 1 });
    expect(o.timestamp).toBe(0); // "observable" at the epoch, long before the decision
    // Such an outcome then shows up in every history view, even with contextUntil far in the past.
    const h = await db.history.get({ eventId: "ev", contextUntil: T0 - 10 * DAY, outcomeUntil: T0 - 10 * DAY });
    expect(h.outcomes.map((x) => x.id)).toEqual([o.id]);
    expect(h.decisions).toEqual([]);
  });

  it("outcomes with horizon 0 land exactly on the anchor and are included by an exact cutoff", async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x" });
    const o = await db.outcomes.insert({ eventId: "ev", horizon: 0, result: 1 });
    expect(o.horizon).toBe("0ms");
    expect(o.timestamp).toBe(T0);
    expect(await db.outcomes.forEvent("ev", { until: T0 })).toHaveLength(1);
    expect(await db.outcomes.forEvent("ev", { until: T0 - 1 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// timeline.around / history scoping
// ---------------------------------------------------------------------------

describe("timeline.around / history scoping", () => {
  beforeEach(async () => {
    await db.events.insertMany([
      { id: "noent", timestamp: T0, type: "macro" },
      { id: "withA", timestamp: T0, type: "x", entities: ["A"] },
    ]);
    await db.timeline.insertMany([
      { timestamp: T0, entity: "A", namespace: "market", data: "A-market" },
      { timestamp: T0, entity: "A", namespace: "news", data: "A-news" },
      { timestamp: T0, entity: "B", namespace: "market", data: "B-market" },
      { timestamp: T0, entity: "B", namespace: "macro", data: "B-macro" },
    ]);
  });

  it("an event without entities sees every entity, narrowed by namespace", async () => {
    const all = await db.timeline.around({ eventId: "noent", before: "0ms" });
    expect(Object.keys(all).sort()).toEqual(["macro", "market", "news"]);
    const market = await db.timeline.around({ eventId: "noent", before: "0ms", namespace: "market" });
    expect(Object.keys(market)).toEqual(["market"]);
    expect(market.market!.map((p) => p.entity)).toEqual(["A", "B"]);
    const multi = await db.timeline.around({ eventId: "noent", before: "0ms", namespace: ["news", "macro"] });
    expect(Object.keys(multi).sort()).toEqual(["macro", "news"]);
    const none = await db.timeline.around({ eventId: "noent", before: "0ms", namespace: "nope" });
    expect(none).toEqual({});
    const h = await db.history.get({ eventId: "noent", before: "0ms", namespace: "macro" });
    expect(h.timeline.macro!.map((p) => p.data)).toEqual(["B-macro"]);
    expect(h.context.macro!.map((p) => p.data)).toEqual(["B-macro"]);
  });

  it("an entities override to an entity the event does not have replaces the event's own scope", async () => {
    const onlyB = await db.timeline.around({ eventId: "withA", before: "0ms", entities: "B" });
    expect(Object.keys(onlyB).sort()).toEqual(["macro", "market"]);
    expect(onlyB.market!.map((p) => p.data)).toEqual(["B-market"]);
    const both = await db.timeline.around({ eventId: "withA", before: "0ms", entities: ["A", "B"], namespace: "market" });
    expect(both.market!.map((p) => p.data)).toEqual(["A-market", "B-market"]);
    const ghost = await db.timeline.around({ eventId: "withA", before: "0ms", entities: "Z" });
    expect(ghost).toEqual({});
    const h = await db.history.get({ eventId: "withA", before: "0ms", entities: "B", namespace: "macro" });
    expect(h.timeline).toEqual({ macro: expect.any(Array) });
    expect(h.timeline.macro![0]!.data).toBe("B-macro");
  });

  it("history.getMany applies one override to every event in the batch", async () => {
    const hs = await db.history.getMany({ eventIds: ["noent", "withA", "noent", "ghost"], before: "0ms", entities: "B", namespace: "market" });
    expect(hs.map((h) => h.event.id)).toEqual(["noent", "withA"]);
    for (const h of hs) expect(h.timeline.market!.map((p) => p.data)).toEqual(["B-market"]);
  });
});

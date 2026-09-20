import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HindsightDB } from "../src/index.js";
import { openTestDatabase } from "./helpers/backend.js";

const T0 = Date.UTC(2024, 0, 10);
const DAY = 86_400_000;
const MIN = 60_000;

let db: HindsightDB;
beforeEach(async () => {
  db = await openTestDatabase();
});
afterEach(() => db.close());

describe("similar() pagination", () => {
  // 47 events whose scores against [1,0] are distinct except for deliberate ties.
  beforeEach(async () => {
    const events = [];
    for (let i = 0; i < 47; i++) {
      const angle = ((i % 40) / 40) * Math.PI; // i and i+40 tie exactly (7 ties)
      events.push({ id: `e${String(i).padStart(2, "0")}`, timestamp: T0, type: "x", embedding: [Math.cos(angle), Math.sin(angle)] });
    }
    await db.events.insertMany(events);
  });

  it("walks every match exactly once, in (score desc, id asc) order, across pages", async () => {
    const all = await db.events.similar({ event: [1, 0], limit: 100 });
    expect(all).toHaveLength(47);
    expect(all.nextCursor).toBeUndefined();
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!, b = all[i]!;
      expect(a.score > b.score || (a.score === b.score && a.id < b.id)).toBe(true);
    }

    for (const limit of [1, 5, 7, 46, 47]) {
      const walked = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await db.events.similar({ event: [1, 0], limit, cursor });
        expect(page.length).toBeLessThanOrEqual(limit);
        walked.push(...page);
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(Math.ceil(47 / limit));
      expect(walked.map((h) => h.id)).toEqual(all.map((h) => h.id));
      expect(walked.map((h) => h.score)).toEqual(all.map((h) => h.score));
    }
  });

  it("splits exact ties across a page boundary without loss or duplication", async () => {
    // Ties: e00/e40, e01/e41, ... — find a page size that splits one.
    const all = await db.events.similar({ event: [1, 0], limit: 100 });
    const tieIndex = all.findIndex((h, i) => i > 0 && h.score === all[i - 1]!.score);
    expect(tieIndex).toBeGreaterThan(0);
    const p1 = await db.events.similar({ event: [1, 0], limit: tieIndex });
    const p2 = await db.events.similar({ event: [1, 0], limit: 100, cursor: p1.nextCursor });
    expect([...p1, ...p2].map((h) => h.id)).toEqual(all.map((h) => h.id));
  });

  it("respects filters and minScore consistently across pages", async () => {
    const full = await db.events.similar({ event: [1, 0], minScore: 0, filters: { excludeIds: ["e00"] }, limit: 100 });
    const p1 = await db.events.similar({ event: [1, 0], minScore: 0, filters: { excludeIds: ["e00"] }, limit: 10 });
    const p2 = await db.events.similar({ event: [1, 0], minScore: 0, filters: { excludeIds: ["e00"] }, limit: 100, cursor: p1.nextCursor });
    expect([...p1, ...p2].map((h) => h.id)).toEqual(full.map((h) => h.id));
    expect(p2.nextCursor).toBeUndefined();
  });

  it("has no cursor when results fit in one page, and rejects a malformed cursor", async () => {
    const page = await db.events.similar({ event: [1, 0], limit: 47 });
    expect(page.nextCursor).toBeUndefined();
    await expect(db.events.similar({ event: [1, 0], cursor: "!!" })).rejects.toThrow(/Invalid cursor/);
  });
});

describe("history maxPoints truncation", () => {
  beforeEach(async () => {
    await db.events.insert({ id: "ev", timestamp: T0, type: "x", entities: ["A"] });
    // 1-minute bars for 2 days before and 1 day after: 3 * 1440 = 4320 points, plus a sparse "news" stream.
    const pts = [];
    for (let m = -2 * 1440; m < 1440; m++) pts.push({ timestamp: T0 + m * MIN, entity: "A", namespace: "bars", data: m });
    for (let d = -2; d <= 1; d++) pts.push({ timestamp: T0 + d * DAY, entity: "A", namespace: "news", data: `d${d}` });
    await db.timeline.insertMany(pts);
  });

  it("returns everything by default (well under the 100k cap)", async () => {
    const h = await db.history.get({ eventId: "ev", before: "2d", after: "1d" });
    expect(h.truncated).toBeUndefined();
    expect(h.timeline.bars).toHaveLength(4320);
    expect(h.timeline.news).toHaveLength(4);
  });

  it("caps points in (timestamp, id) order and hands back a resumable range query", async () => {
    const h = await db.history.get({ eventId: "ev", before: "2d", after: "1d", maxPoints: 1000 });
    const got = [...(h.timeline.bars ?? []), ...(h.timeline.news ?? [])];
    expect(got).toHaveLength(1000);
    expect(h.truncated).toBeDefined();
    const lastTs = Math.max(...got.map((p) => p.timestamp));
    expect(h.truncated!.at.timestamp).toBe(lastTs);
    // Nothing later than `at` slipped in.
    expect(got.every((p) => p.timestamp <= lastTs)).toBe(true);

    // Walk the remainder with the provided query and reassemble the full window.
    const rest = [];
    let q = h.truncated!.next;
    for (;;) {
      const page = await db.timeline.range(q);
      rest.push(...page.items);
      if (!page.nextCursor) break;
      q = { ...q, cursor: page.nextCursor };
    }
    const full = await db.history.get({ eventId: "ev", before: "2d", after: "1d" });
    const fullIds = [...full.timeline.bars!, ...full.timeline.news!].map((p) => p.id).sort((a, b) => a - b);
    const walkedIds = [...got, ...rest].map((p) => p.id).sort((a, b) => a - b);
    expect(walkedIds).toEqual(fullIds);
  });

  it("truncation respects the observation cutoff and context stays a subset", async () => {
    await db.timeline.insert({ timestamp: T0 - DAY, observedAt: T0 + 2 * DAY, entity: "A", namespace: "late", data: 1 });
    const h = await db.history.get({ eventId: "ev", before: "2d", after: "1d", maxPoints: 500 });
    expect(h.timeline.late).toBeUndefined(); // observed after outcomeUntil
    expect(h.truncated!.next.asOf).toBe(h.window.outcomeUntil);
    const ctxIds = new Set(Object.values(h.context).flat().map((p) => p.id));
    const tlIds = new Set(Object.values(h.timeline).flat().map((p) => p.id));
    for (const id of ctxIds) expect(tlIds.has(id)).toBe(true);
  });

  it("applies per event in getMany and validates maxPoints", async () => {
    await db.events.insert({ id: "ev2", timestamp: T0 + DAY, type: "x", entities: ["A"] });
    const hs = await db.history.getMany({ eventIds: ["ev", "ev2"], before: "1d", after: "0ms", maxPoints: 100 });
    expect(hs.map((h) => Object.values(h.timeline).flat().length)).toEqual([100, 100]);
    expect(hs.every((h) => h.truncated)).toBe(true);
    await expect(db.history.get({ eventId: "ev", maxPoints: 0 })).rejects.toThrow(/maxPoints must be a positive integer/);
  });
});

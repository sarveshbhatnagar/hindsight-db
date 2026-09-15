import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/index.js";

/**
 * The "typical application flow" from design.md, run against an on-disk
 * database so persistence across handles is exercised too.
 */

const DAY = 86_400_000;
const T = (day: number) => Date.UTC(2024, 0, 1) + day * DAY;

let dir: string;
let path: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "action-graph-"));
  path = join(dir, "history.db");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("end-to-end flow", () => {
  it("ingests, persists, finds similar events and reconstructs their histories", async () => {
    // --- ingestion ---------------------------------------------------------
    {
      const db = openDatabase({ path });

      // 30 historical earnings events for a handful of tickers.
      const tickers = ["AAPL", "MSFT", "NVDA"];
      const events = Array.from({ length: 30 }, (_, i) => {
        const ticker = tickers[i % 3]!;
        const surprise = (i % 5) / 10 - 0.2; // -0.2 .. 0.2
        return {
          id: `earn-${i}`,
          timestamp: T(10 + i * 10),
          type: "earnings",
          entities: [ticker],
          content: `${ticker} earnings, surprise ${surprise}`,
          // Toy embedding: [surprise, ticker one-hot...]
          embedding: [surprise, ...tickers.map((t) => (t === ticker ? 1 : 0))],
          metadata: { ticker, surprise },
        };
      });
      await db.events.insertMany(events);

      // Daily closes for every ticker over the whole period.
      const points = [];
      for (let d = 0; d < 320; d++) {
        for (const t of tickers) points.push({ timestamp: T(d), entity: t, namespace: "market", data: { close: 100 + d } });
      }
      await db.timeline.insertMany(points);

      // Each event got a decision the same day and outcomes at 1d/5d.
      for (const e of events) {
        const d = await db.decisions.insert({ eventId: e.id, timestamp: e.timestamp, action: { side: "buy" } });
        await db.outcomes.insertMany([
          { eventId: e.id, decisionId: d.id, horizon: "1d", result: { ret: 0.01 } },
          { eventId: e.id, decisionId: d.id, horizon: "5d", result: { ret: 0.03 } },
        ]);
      }
      db.close();
    }

    // --- application flow ----------------------------------------------------
    const db = openDatabase({ path });

    // A new AAPL event arrives with a +0.2 surprise; find similar history as of "now".
    const now = T(330);
    const currentEvent = { embedding: [0.2, 1, 0, 0] };
    const candidates = await db.events.similar({
      event: currentEvent,
      limit: 5,
      filters: { type: "earnings", asOf: now },
    });
    expect(candidates).toHaveLength(5);
    expect(candidates[0]!.score).toBeGreaterThan(candidates[4]!.score);
    // Best matches are AAPL events with the highest surprise.
    expect(candidates[0]!.entities).toEqual(["AAPL"]);
    expect(candidates[0]!.metadata.surprise).toBe(0.2);

    // Application selects which candidates it cares about, then reconstructs history.
    const selected = candidates.slice(0, 3).map((c) => c.id);
    const histories = await db.history.getMany({ eventIds: selected, before: "14d", after: "5d" });
    expect(histories.map((h) => h.event.id)).toEqual(selected);

    for (const h of histories) {
      expect(Object.keys(h.timeline)).toEqual(["market"]);
      // 14 days before + event day + 5 after = 20 daily points, all for the event's entity.
      expect(h.timeline.market).toHaveLength(20);
      expect(h.timeline.market!.every((p) => p.entity === h.event.entities[0])).toBe(true);
      // Context stops at the event: 15 points.
      expect(h.context.market).toHaveLength(15);
      expect(h.context.market!.at(-1)!.timestamp).toBe(h.event.timestamp);
      expect(h.decisions).toHaveLength(1);
      expect(h.outcomes.map((o) => o.horizon)).toEqual(["1d", "5d"]);
    }

    db.close();
  });
});

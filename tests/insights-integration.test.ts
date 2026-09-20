import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, InsightsEventProvider, type HindsightDB } from "../src/index.js";

/**
 * End to end against a real insights-db on Postgres + pgvector. Skipped
 * unless DATABASE_URL is set; the container from insights-db's README does:
 *
 *   docker run -d --name insights-db-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=insights_db \
 *     -p 5433:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5433/insights_db npm test
 *
 * The insights schema is created in a schema of its own (`hindsight_it`) and
 * seeded through SQL — the shape ingest would leave behind, without the LLM:
 * a bank failure first reported on 9/11 with two claims, one of which a
 * document on 9/13 supersedes, and a later acquisition of the same bank.
 */

const url = process.env.DATABASE_URL;
const SCHEMA = "hindsight_it";
const DIM = 1536;

// A unit vector along one axis, plus optionally another, as a pgvector literal.
const vec = (...axes: number[]): string => {
  const v = new Array<number>(DIM).fill(0);
  for (const a of axes) v[a] = 1;
  return `[${v.join(",")}]`;
};

type Insights = import("insights-db").Insights;

describe.skipIf(!url)("InsightsEventProvider against insights-db", () => {
  let insights: Insights;
  let db: HindsightDB<InsightsEventProvider>;
  let ids: { bank: string; sale: string; meridian: string; fdic: string; doc2: string; c1: string; c2: string; c3: string; c4: string };

  beforeAll(async () => {
    const { openInsights } = await import("insights-db");
    const base = new URL(url!);
    base.searchParams.set("options", `-c search_path=${SCHEMA},public`);
    // A pool to reset the schema, then the handle under test.
    const admin = openInsights({ connectionString: base.toString() });
    await admin.pool.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA};`);
    await admin.init();
    ids = await seed(admin);
    await admin.end();
    insights = openInsights({ connectionString: base.toString() });
    db = openDatabase({ events: new InsightsEventProvider(insights) });
  });

  afterAll(async () => {
    db?.close();
    await insights?.end();
  });

  async function seed(h: Insights) {
    const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => h.pool.query<T>(sql, params).then((r) => r.rows);
    const one = async (sql: string, params: unknown[]) => (await q<{ id: string }>(sql, params))[0]!.id;
    const meridian = await one(`insert into entities (name, type, embedding) values ('Meridian Bank', 'org', $1::vector) returning id`, [vec(1)]);
    const fdic = await one(`insert into entities (name, type, embedding) values ('FDIC', 'org', $1::vector) returning id`, [vec(2)]);
    const bank = await one(
      `insert into events (title, event_type, pattern, occurred_at, content_embedding, pattern_embedding)
       values ('Meridian Bank seized by regulators', 'bank_failure', 'regional bank fails after deposit run', '2026-09-10', $1::vector, $2::vector) returning id`,
      [vec(10), vec(20, 21)],
    );
    const sale = await one(
      `insert into events (title, event_type, pattern, occurred_at, content_embedding, pattern_embedding)
       values ('Meridian Bank assets sold to Harbor', 'bank_acquisition', 'failed bank assets sold by regulator', '2026-09-14', $1::vector, $2::vector) returning id`,
      [vec(11), vec(20)],
    );
    await q(`insert into event_entities (event_id, entity_id, role) values ($1, $2, 'subject'), ($1, $3, 'regulator'), ($4, $2, 'seller')`, [bank, meridian, fdic, sale]);
    const doc = (body: string, publishedAt: string, eventId: string) =>
      one(
        `insert into documents (body, published_at, content_hash, simhash, event_id) values ($1, $2, sha256(convert_to($1::text, 'UTF8')), 0, $3) returning id`,
        [body, publishedAt, eventId],
      );
    const doc1 = await doc("Meridian Bank was closed by regulators on Thursday after $3bn in withdrawals.", "2026-09-11T08:00:00Z", bank);
    const doc2 = await doc("Withdrawals from Meridian Bank reached $4bn; the FDIC is seeking an acquirer.", "2026-09-13T10:00:00Z", bank);
    const doc3 = await doc("Harbor Financial bought Meridian Bank's deposits from the FDIC.", "2026-09-14T09:00:00Z", sale);
    const claim = (eventId: string, docId: string, text: string, assertedAt: string, axis: number) =>
      one(`insert into claims (event_id, document_id, text, asserted_at, embedding) values ($1, $2, $3, $4, $5::vector) returning id`, [eventId, docId, text, assertedAt, vec(axis)]);
    const c1 = await claim(bank, doc1, "Meridian Bank was closed by regulators", "2026-09-11T08:00:00Z", 100);
    const c2 = await claim(bank, doc1, "Withdrawals totalled $3bn", "2026-09-11T08:00:00Z", 101);
    const c3 = await claim(bank, doc2, "Withdrawals reached $4bn", "2026-09-13T10:00:00Z", 102);
    const c4 = await claim(bank, doc2, "The FDIC is seeking an acquirer", "2026-09-13T10:00:00Z", 103);
    await claim(sale, doc3, "Harbor Financial bought Meridian's deposits", "2026-09-14T09:00:00Z", 104);
    await q(`update claims set superseded_by = $2 where id = $1`, [c2, c3]);
    return { bank, sale, meridian, fdic, doc2, c1, c2, c3, c4 };
  }

  it("maps records: day-level occurredAt at 00:00 UTC, document dates as observedAt, entities by insights id", async () => {
    const ev = await db.events.get(ids.bank);
    expect(ev).toMatchObject({
      id: ids.bank,
      timestamp: Date.UTC(2026, 8, 10),
      observedAt: Date.parse("2026-09-11T08:00:00Z"),
      type: "bank_failure",
      entities: [ids.meridian, ids.fdic].sort((a, b) => Number(a) - Number(b)),
      metadata: { storylineId: null, pattern: "regional bank fails after deposit run" },
    });
    const content = ev!.content as { title: string; claims: { claimId: string; assertedAt: number; supersededBy: string | null }[] };
    expect(content.title).toBe("Meridian Bank seized by regulators");
    // As it stands now: the superseded claim is gone, the two later ones are in.
    expect(content.claims.map((c) => c.claimId)).toEqual([ids.c1, ids.c3, ids.c4]);
    expect(content.claims[1]!.assertedAt).toBe(Date.parse("2026-09-13T10:00:00Z"));
    expect(await db.events.getMany(["not-an-id", ids.sale])).toHaveLength(1);
  });

  it("history cuts the event's own content at contextUntil, along with the timeline", async () => {
    await db.aliases.add(ids.meridian, "MRDN");
    const day = (d: number, hour = 21) => Date.UTC(2026, 8, d, hour);
    await db.timeline.insertMany([
      { timestamp: day(8), entity: "MRDN", namespace: "market", data: { close: 30 } },
      { timestamp: day(9), entity: "MRDN", namespace: "market", data: { close: 28 } },
      { timestamp: day(10), entity: "MRDN", namespace: "market", data: { close: 12 } },
      { timestamp: day(11), entity: "MRDN", namespace: "market", data: { close: 4 } },
      { timestamp: day(12), entity: "MRDN", namespace: "market", data: { close: 3 } },
      { timestamp: day(15), entity: "MRDN", namespace: "market", data: { close: 5 } },
    ]);
    const decision = await db.decisions.insert({ eventId: ids.bank, timestamp: "2026-09-11T12:00:00Z", action: { side: "short" } });
    const outcome = await db.outcomes.insert({ eventId: ids.bank, decisionId: decision.id, horizon: "3d", result: { return: 0.6 } });
    expect(outcome.timestamp).toBe(Date.parse("2026-09-14T12:00:00Z"));

    const claims = (h: { event: { content: unknown } }) => (h.event.content as { claims: { claimId: string; supersededBy: string | null }[] }).claims;
    const closes = (streams: Record<string, { data: unknown }[]>) => streams.market?.map((p) => (p.data as { close: number }).close);

    // At decision time: the first report only, its $3bn figure still standing.
    const atDecision = await db.history.get({ eventId: ids.bank, before: "3d", contextUntil: "2026-09-11T12:00:00Z", outcomeUntil: "2026-09-15T00:00:00Z" });
    expect(claims(atDecision).map((c) => [c.claimId, c.supersededBy])).toEqual([
      [ids.c1, null],
      [ids.c2, null],
    ]);
    expect(closes(atDecision.context)).toEqual([30, 28, 12]);
    expect(closes(atDecision.timeline)).toEqual([30, 28, 12, 4, 3]);
    expect(atDecision.decisions.map((d) => d.id)).toEqual([decision.id]);
    expect(atDecision.outcomes.map((o) => o.id)).toEqual([outcome.id]);
    expect(atDecision.window).toMatchObject({ contextUntil: Date.parse("2026-09-11T12:00:00Z"), outcomeUntil: Date.parse("2026-09-15T00:00:00Z") });

    // Default cutoff is the event's observedAt: the same two claims.
    expect(claims(await db.history.get({ eventId: ids.bank })).map((c) => c.claimId)).toEqual([ids.c1, ids.c2]);

    // A later cutoff sees the correction: $3bn superseded, the new claims in.
    const later = await db.history.get({ eventId: ids.bank, contextUntil: "2026-09-14T00:00:00Z", outcomeUntil: "2026-09-15T00:00:00Z" });
    expect(claims(later).map((c) => c.claimId)).toEqual([ids.c1, ids.c3, ids.c4]);
    expect(closes(later.context)).toEqual([30, 28, 12, 4, 3]);

    // Before the event was reported at all: nothing to fetch as of then; the event comes back as it stands.
    const before = await db.history.get({ eventId: ids.bank, contextUntil: "2026-09-10T00:00:00Z", outcomeUntil: "2026-09-15T00:00:00Z" });
    expect(before.event.observedAt).toBeGreaterThan(before.window.contextUntil);
    expect(claims(before).map((c) => c.claimId)).toEqual([ids.c1, ids.c3, ids.c4]);

    // Batched: two events, one explicit cutoff.
    const many = await db.history.getMany({ eventIds: [ids.sale, ids.bank], contextUntil: "2026-09-14T12:00:00Z", outcomeUntil: "2026-09-16T00:00:00Z" });
    expect(many.map((h) => [h.event.id, claims(h).length])).toEqual([
      [ids.sale, 1],
      [ids.bank, 3],
    ]);
    expect(closes(many[0]!.context)).toEqual([30, 28, 12, 4, 3]);
    expect(closes(many[0]!.timeline)).toEqual([30, 28, 12, 4, 3, 5]);
  });

  it("list, similar and the catalogs go through insights' filters", async () => {
    const list = async (q: Parameters<typeof db.events.list>[0]) => (await db.events.list(q)).items.map((e) => e.id);
    expect(await list({ filters: { entities: ids.meridian } })).toEqual([ids.bank, ids.sale]);
    expect(await list({ filters: { entitiesAll: ids.fdic } })).toEqual([ids.bank]);
    expect(await list({ filters: { asOf: "2026-09-12T00:00:00Z" } })).toEqual([ids.bank]);
    expect(await list({ filters: { from: "2026-09-10T12:00:00Z" } })).toEqual([ids.sale]); // rounds up to 9/11
    expect(await list({ filters: { to: "2026-09-13T23:59:59Z" }, order: "desc" })).toEqual([ids.bank]);
    expect(await list({ filters: { type: "bank_acquisition", excludeIds: ["x"] } })).toEqual([ids.sale]);
    await expect(list({ filters: { metadata: { storylineId: "1" } } })).rejects.toThrow(/metadata filter/);
    await expect(list({ filters: { entities: "MRDN" } })).rejects.toThrow(/numeric/);
    const page = await db.events.list({ limit: 1 });
    expect(page.items.map((e) => e.id)).toEqual([ids.bank]);
    expect((await db.events.list({ limit: 1, cursor: page.nextCursor })).items.map((e) => e.id)).toEqual([ids.sale]);

    // The two patterns share an axis; the query event itself is excluded.
    const similar = await db.events.similar({ event: ids.bank, limit: 5 });
    expect(similar.map((s) => s.id)).toEqual([ids.sale]);
    expect(similar[0]!.score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(similar[0]!.type).toBe("bank_acquisition");
    expect(await db.events.similar({ event: ids.bank, limit: 5, filters: { asOf: "2026-09-12T00:00:00Z" } })).toEqual([]);
    // An orthogonal query vector scores 0 against both; minScore cuts them.
    const orthogonal = { embedding: [1, ...new Array<number>(DIM - 1).fill(0)] };
    expect((await db.events.similar({ event: orthogonal })).map((s) => s.score)).toEqual([0, 0]);
    expect(await db.events.similar({ event: orthogonal, minScore: 0.5 })).toEqual([]);
    await expect(db.events.similar({ event: "999999" })).rejects.toThrow(/no event/);

    expect(await db.events.types()).toEqual([
      { type: "bank_acquisition", count: 1, firstSeen: Date.UTC(2026, 8, 14), lastSeen: Date.UTC(2026, 8, 14) },
      { type: "bank_failure", count: 1, firstSeen: Date.UTC(2026, 8, 10), lastSeen: Date.UTC(2026, 8, 10) },
    ]);
    expect(await db.events.entities()).toEqual([
      { entity: ids.meridian, count: 2, firstSeen: Date.UTC(2026, 8, 10), lastSeen: Date.UTC(2026, 8, 14) },
      { entity: ids.fdic, count: 1, firstSeen: Date.UTC(2026, 8, 10), lastSeen: Date.UTC(2026, 8, 10) },
    ]);
    expect(await db.events.entities({ type: "bank_acquisition" })).toMatchObject([{ entity: ids.meridian, count: 1 }]);
  });

  it("gc drops the context of events insights no longer has", async () => {
    await db.decisions.insert({ eventId: ids.sale, timestamp: "2026-09-14T12:00:00Z", action: "watch" });
    await db.outcomes.insert({ eventId: ids.sale, horizon: "1d", result: null });
    expect(await db.gc()).toEqual({ removedEvents: 0, removedDecisions: 0, removedOutcomes: 0 });
    // What detachDocument does to an event left with no documents and no claims.
    for (const sql of [
      "delete from claims where event_id = $1",
      "delete from event_entities where event_id = $1",
      "update documents set event_id = null where event_id = $1",
      "delete from events where id = $1",
    ]) {
      await insights.pool.query(sql, [ids.sale]);
    }
    expect(await db.gc()).toEqual({ removedEvents: 1, removedDecisions: 1, removedOutcomes: 1 });
    expect(await db.decisions.forEvent(ids.sale)).toEqual([]);
    expect(await db.decisions.forEvent(ids.bank)).toHaveLength(1);
    await expect(db.decisions.insert({ eventId: ids.sale, timestamp: 0, action: null })).rejects.toThrow();
  });
});

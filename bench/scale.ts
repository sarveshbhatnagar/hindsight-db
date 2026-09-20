/**
 * Scale / performance benchmark for hindsight-db.
 *
 * Run:  npm run build && node bench/scale.ts
 * (Node >= 22.18 strips types natively; older Node: `node --experimental-strip-types`.)
 *
 * Writes an on-disk database under BENCH_DIR (default: a temp directory),
 * deletes it when done. Scale knobs are env-overridable so the run stays under a
 * few minutes; defaults match the spec (100k events, 2M timeline points, ...).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../dist/index.js";
import { cosine, decodeEmbedding, l2norm } from "../dist/vector.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BENCH_DIR = process.env.BENCH_DIR ?? join(tmpdir(), "hindsight-db-bench");
const DB_PATH = join(BENCH_DIR, "hindsight-db-scale.db");

const N_EVENTS = num("N_EVENTS", 100_000);
const DIM = 128;
const N_BIG = num("N_BIG", 1_000);
const BIG_DIM = 1536;
const N_ENTITIES = num("N_ENTITIES", 500);
const N_DAYS = num("N_DAYS", 1000);
const NAMESPACES = ["market", "news", "macro", "signals"];
const N_TYPES = 10;
const EVENT_BATCH = 1000;
const TIMELINE_BATCH = 10_000;
const RUNS = num("RUNS", 5);

const DAY = 86_400_000;
const T0 = Date.parse("2020-01-01T00:00:00Z");
const T_END = T0 + N_DAYS * DAY;

function num(name: string, dflt: number): number {
  const v = process.env[name];
  return v ? Number(v) : dflt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deterministic PRNG so runs are comparable.
let seed = 0x9e3779b9;
function rand(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
function randInt(n: number): number {
  return Math.floor(rand() * n);
}
function randVec(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  return v;
}
function pickEntities(k: number): string[] {
  const s = new Set<string>();
  while (s.size < k) s.add(entityName(randInt(N_ENTITIES)));
  return [...s];
}
function entityName(i: number): string {
  return `E${String(i).padStart(4, "0")}`;
}

function fmt(n: number, digits = 1): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Median wall-clock ms of `runs` invocations after `warmup` untimed ones. */
async function bench(fn: () => Promise<unknown> | unknown, runs = RUNS, warmup = 1): Promise<{ median: number; min: number; max: number }> {
  for (let i = 0; i < warmup; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)]!, min: times[0]!, max: times[times.length - 1]! };
}

interface Row {
  section: string;
  case: string;
  result: string;
  note?: string;
}
const results: Row[] = [];
function record(section: string, c: string, result: string, note = ""): void {
  results.push({ section, case: c, result, note });
  console.log(`  ${c.padEnd(52)} ${result.padStart(16)}  ${note}`);
}

function fileSizeMB(): number {
  let bytes = 0;
  for (const suffix of ["", "-wal"]) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) bytes += statSync(p).size;
  }
  return bytes / 1_048_576;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(BENCH_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(DB_PATH + suffix, { force: true });

  console.log(`hindsight-db scale bench  node ${process.version}  ${new Date().toISOString()}`);
  console.log(
    `events=${N_EVENTS} dim=${DIM}  big=${N_BIG}@${BIG_DIM}  timeline=${N_ENTITIES}x${NAMESPACES.length}x${N_DAYS}=${N_ENTITIES * NAMESPACES.length * N_DAYS}  runs=${RUNS}\n`,
  );
  const tAll = performance.now();
  const db = openDatabase({ path: DB_PATH });

  // ------------------------------------------------------------------ ingest
  console.log("== 1. Ingest");
  const eventIds: string[] = [];
  const eventTs: number[] = [];
  let ms = 0;
  const batchTimes: number[] = [];
  for (let start = 0; start < N_EVENTS; start += EVENT_BATCH) {
    const n = Math.min(EVENT_BATCH, N_EVENTS - start);
    const batch = Array.from({ length: n }, (_, j) => {
      const i = start + j;
      // Keep [ts-30d, ts+5d] inside the timeline range so history windows are full.
      const ts = T0 + (40 + randInt(N_DAYS - 50)) * DAY + randInt(24) * 3_600_000;
      return {
        timestamp: ts,
        observedAt: ts + randInt(4) * 3_600_000,
        type: `type${i % N_TYPES}`,
        entities: pickEntities(3),
        content: `event ${i} content`,
        embedding: randVec(DIM),
        metadata: { sector: `s${i % 7}`, score: i % 100 },
      };
    });
    const t = performance.now();
    const inserted = await db.events.insertMany(batch);
    const dt = performance.now() - t;
    ms += dt;
    batchTimes.push(dt);
    for (const e of inserted) {
      eventIds.push(e.id);
      eventTs.push(e.timestamp);
    }
  }
  const decile = (xs: number[], which: "first" | "last") => {
    const k = Math.max(1, Math.floor(xs.length / 10));
    const part = which === "first" ? xs.slice(0, k) : xs.slice(-k);
    return part.reduce((a, b) => a + b, 0) / part.length;
  };
  const evFirst = decile(batchTimes, "first");
  const evLast = decile(batchTimes, "last");
  batchTimes.sort((a, b) => a - b);
  record(
    "ingest",
    `events x${fmtInt(N_EVENTS)} (${DIM}-dim + 3 entities, batch ${EVENT_BATCH})`,
    `${fmtInt(N_EVENTS / (ms / 1000))} rows/s`,
    `${fmt(ms / 1000, 2)} s total; median batch ${fmt(batchTimes[Math.floor(batchTimes.length / 2)]!)} ms; first 10% of batches ${fmt(evFirst)} ms, last 10% ${fmt(evLast)} ms`,
  );

  // 1,000 events at 1536-dim for the per-dimension test.
  {
    const batch = Array.from({ length: N_BIG }, (_, i) => ({
      timestamp: T0 + (40 + randInt(N_DAYS - 50)) * DAY,
      type: "big",
      entities: pickEntities(3),
      content: `big ${i}`,
      embedding: randVec(BIG_DIM),
      metadata: {},
    }));
    const t = performance.now();
    await db.events.insertMany(batch);
    const dt = performance.now() - t;
    record("ingest", `events x${fmtInt(N_BIG)} (${BIG_DIM}-dim)`, `${fmtInt(N_BIG / (dt / 1000))} rows/s`, `${fmt(dt)} ms`);
  }

  // Timeline: entity x namespace x day, one point per day at 21:00Z.
  {
    const total = N_ENTITIES * NAMESPACES.length * N_DAYS;
    let done = 0;
    let tms = 0;
    const times: number[] = [];
    let batch: { timestamp: number; entity: string; namespace: string; data: { close: number; vol: number } }[] = [];
    const flush = async () => {
      const t = performance.now();
      await db.timeline.insertMany(batch);
      const dt = performance.now() - t;
      tms += dt;
      times.push(dt);
      done += batch.length;
      batch = [];
    };
    for (let e = 0; e < N_ENTITIES; e++) {
      const entity = entityName(e);
      for (const namespace of NAMESPACES) {
        for (let d = 0; d < N_DAYS; d++) {
          batch.push({
            timestamp: T0 + d * DAY + 21 * 3_600_000,
            entity,
            namespace,
            data: { close: Math.round(rand() * 100000) / 100, vol: randInt(1_000_000) },
          });
          if (batch.length === TIMELINE_BATCH) await flush();
        }
      }
    }
    if (batch.length) await flush();
    const tlFirst = decile(times, "first");
    const tlLast = decile(times, "last");
    times.sort((a, b) => a - b);
    record(
      "ingest",
      `timeline x${fmtInt(total)} (batch ${TIMELINE_BATCH})`,
      `${fmtInt(done / (tms / 1000))} rows/s`,
      `${fmt(tms / 1000, 2)} s total; median batch ${fmt(times[Math.floor(times.length / 2)]!)} ms, max ${fmt(times[times.length - 1]!)} ms; first 10% of batches ${fmt(tlFirst)} ms, last 10% ${fmt(tlLast)} ms`,
    );
  }

  // Decisions: one per event.
  const decisionIds: string[] = [];
  {
    let dms = 0;
    for (let start = 0; start < N_EVENTS; start += EVENT_BATCH) {
      const n = Math.min(EVENT_BATCH, N_EVENTS - start);
      const batch = Array.from({ length: n }, (_, j) => ({
        eventId: eventIds[start + j]!,
        timestamp: eventTs[start + j]! + 3_600_000,
        action: { side: j % 2 ? "buy" : "sell", qty: 100 + j },
        metadata: { model: "v1" },
      }));
      const t = performance.now();
      const ins = await db.decisions.insertMany(batch);
      dms += performance.now() - t;
      for (const d of ins) decisionIds.push(d.id);
    }
    record("ingest", `decisions x${fmtInt(N_EVENTS)} (batch ${EVENT_BATCH})`, `${fmtInt(N_EVENTS / (dms / 1000))} rows/s`, `${fmt(dms / 1000, 2)} s`);
  }

  // Outcomes: two per event (1d, 5d), linked to the decision.
  {
    let oms = 0;
    const N_OUT = N_EVENTS * 2;
    for (let start = 0; start < N_EVENTS; start += EVENT_BATCH) {
      const n = Math.min(EVENT_BATCH, N_EVENTS - start);
      const batch: { eventId: string; decisionId: string; horizon: string; result: { return: number } }[] = [];
      for (let j = 0; j < n; j++) {
        const i = start + j;
        for (const horizon of ["1d", "5d"]) {
          batch.push({ eventId: eventIds[i]!, decisionId: decisionIds[i]!, horizon, result: { return: rand() * 0.1 - 0.05 } });
        }
      }
      const t = performance.now();
      await db.outcomes.insertMany(batch);
      oms += performance.now() - t;
    }
    record("ingest", `outcomes x${fmtInt(N_OUT)} (batch ${EVENT_BATCH * 2})`, `${fmtInt(N_OUT / (oms / 1000))} rows/s`, `${fmt(oms / 1000, 2)} s`);
  }

  record("ingest", "db size after ingest (main + wal)", `${fmt(fileSizeMB())} MB`);
  // Checkpoint so the query phase reads from the main file, not a huge WAL.
  (db as any).conn.db.pragma("wal_checkpoint(TRUNCATE)");
  record("ingest", "db size after checkpoint", `${fmt(fileSizeMB())} MB`);
  console.log(`  [elapsed ${fmt((performance.now() - tAll) / 1000)} s]\n`);

  // ----------------------------------------------------------------- similar
  console.log("== 2. events.similar (limit 20)");
  const qvec = randVec(DIM);
  const simCases: [string, Parameters<typeof db.events.similar>[0]][] = [
    [`(a) all ${fmtInt(N_EVENTS)} events, no filter`, { event: qvec, limit: 20 }],
    [`(b) filter type (≈10%)`, { event: qvec, limit: 20, filters: { type: "type3" } }],
    [`(c) filter one entity`, { event: qvec, limit: 20, filters: { entities: entityName(42) } }],
    [`(d) filter asOf (≈50%)`, { event: qvec, limit: 20, filters: { asOf: T0 + (N_DAYS / 2) * DAY } }],
    [`(e) by stored event id (self excluded)`, { event: eventIds[123]!, limit: 20 }],
  ];
  for (const [name, q] of simCases) {
    const r = await bench(() => db.events.similar(q));
    const cnt = (await db.events.similar(q)).length;
    record("similar", name, `${fmt(r.median, 1)} ms`, `min ${fmt(r.min)} / max ${fmt(r.max)}; ${cnt} hits`);
  }
  {
    const bigq = randVec(BIG_DIM);
    const r = await bench(() => db.events.similar({ event: bigq, limit: 20 }));
    record("similar", `(f) ${fmtInt(N_BIG)} events at ${BIG_DIM}-dim, no filter`, `${fmt(r.median, 1)} ms`, `min ${fmt(r.min)} / max ${fmt(r.max)}`);
    const r2 = await bench(() => db.events.similar({ event: bigq, limit: 20, filters: { type: "big" } }));
    record("similar", `(g) same, filter type="big" (index hits ${fmtInt(N_BIG)} rows)`, `${fmt(r2.median, 1)} ms`, `min ${fmt(r2.min)} / max ${fmt(r2.max)}`);
  }
  console.log(`  [elapsed ${fmt((performance.now() - tAll) / 1000)} s]\n`);

  // ----------------------------------------------------------------- history
  console.log('== 3. history.getMany  before "30d" after "5d"');
  const sample = (n: number) => Array.from({ length: n }, (_, i) => eventIds[(i * 7919) % N_EVENTS]!);
  for (const n of [20, 100, 500]) {
    const ids = sample(n);
    const runs = n >= 500 ? 3 : RUNS;
    const r = await bench(() => db.history.getMany({ eventIds: ids, before: "30d", after: "5d" }), runs);
    const hs = await db.history.getMany({ eventIds: ids, before: "30d", after: "5d" });
    const pts = hs.reduce((s, h) => s + Object.values(h.timeline).reduce((a, v) => a + v.length, 0), 0);
    record(
      "history",
      `getMany x${n}`,
      `${fmt(r.median, 1)} ms`,
      `${fmt(r.median / n, 2)} ms/event; ${fmtInt(pts / n)} pts/event, ${fmtInt(pts / (r.median / 1000))} pts/s`,
    );
    const rl = await bench(async () => {
      for (const id of ids) await db.history.get({ eventId: id, before: "30d", after: "5d" });
    }, runs);
    record("history", `loop of history.get x${n}`, `${fmt(rl.median, 1)} ms`, `${fmt(rl.median / n, 2)} ms/event; ${fmt(rl.median / r.median, 2)}x getMany`);
  }
  console.log(`  [elapsed ${fmt((performance.now() - tAll) / 1000)} s]\n`);

  // ----------------------------------------------------------------- paging
  console.log("== 4. timeline.range paging (limit 1000)");
  {
    // 50 days x 500 entities x 4 namespaces = 100k points.
    const days = Math.ceil(100_000 / (N_ENTITIES * NAMESPACES.length));
    const from = T0 + 100 * DAY;
    const to = from + days * DAY - 1;
    let pages = 0;
    let total = 0;
    const r = await bench(async () => {
      pages = 0;
      total = 0;
      let cursor: string | undefined;
      do {
        const page = await db.timeline.range({ from, to, limit: 1000, cursor });
        total += page.items.length;
        pages++;
        cursor = page.nextCursor;
      } while (cursor);
    }, 3);
    record("paging", `timeline.range ${fmtInt(total)} pts in ${pages} pages`, `${fmt(r.median, 1)} ms`, `${fmt(r.median / pages, 2)} ms/page; ${fmtInt(total / (r.median / 1000))} pts/s`);
    // Same window but restricted to one entity (uses entity index).
    const r2 = await bench(async () => {
      let cursor: string | undefined;
      do {
        const page = await db.timeline.range({ entity: entityName(7), namespace: "market", from: T0, to: T_END, limit: 1000, cursor });
        cursor = page.nextCursor;
      } while (cursor);
    }, 3);
    record("paging", `timeline.range one entity+ns, ${fmtInt(N_DAYS)} pts`, `${fmt(r2.median, 1)} ms`);
  }

  console.log("\n== 5. events.list paging (limit 1000)");
  {
    let pages = 0;
    let total = 0;
    const r = await bench(async () => {
      pages = 0;
      total = 0;
      let cursor: string | undefined;
      do {
        const page = await db.events.list({ limit: 1000, cursor });
        total += page.items.length;
        pages++;
        cursor = page.nextCursor;
      } while (cursor);
    }, 3);
    record("paging", `events.list ${fmtInt(total)} events in ${pages} pages`, `${fmt(r.median, 1)} ms`, `${fmt(r.median / pages, 2)} ms/page; ${fmtInt(total / (r.median / 1000))} ev/s`);
    const r2 = await bench(async () => {
      let cursor: string | undefined;
      do {
        const page = await db.events.list({ limit: 1000, cursor, filters: { type: "type3" } });
        cursor = page.nextCursor;
      } while (cursor);
    }, 3);
    record("paging", `events.list filter type (≈10%)`, `${fmt(r2.median, 1)} ms`);
  }
  console.log(`  [elapsed ${fmt((performance.now() - tAll) / 1000)} s]\n`);

  // ----------------------------------------------------------------- profile
  console.log("== 6. Profile: where does similar() spend its time? (100k-row scan, median of runs)");
  db.close();
  await profileSimilar(qvec);

  console.log("\n== 7. Ingest pragma experiment (separate db, reduced scale)");
  await ingestPragmaExperiment();

  // ----------------------------------------------------------------- summary
  console.log("\n== Results table\n");
  console.log("| Section | Case | Result | Notes |");
  console.log("| --- | --- | --- | --- |");
  for (const r of results) console.log(`| ${r.section} | ${r.case} | ${r.result} | ${r.note ?? ""} |`);
  console.log(`\nTotal bench runtime: ${fmt((performance.now() - tAll) / 1000)} s`);

  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(DB_PATH + suffix, { force: true });
  console.log("Deleted benchmark database.");
}

// ---------------------------------------------------------------------------
// Manual profile of the similar() hot loop, against a read-only connection.
// Each variant reproduces one more stage of SqliteEventStore.similar() so the
// difference between adjacent rows isolates that stage's cost.
// ---------------------------------------------------------------------------

async function profileSimilar(qvec: Float32Array): Promise<void> {
  // Read-write: the "what-if" experiments below add indexes / run ANALYZE on the bench db.
  const raw = new Database(DB_PATH);
  const qnorm = l2norm(qvec);
  const SELECT_GC = `SELECT e.*, (SELECT group_concat(entity_id, char(31)) FROM event_entities ee WHERE ee.event_id = e.id) AS entities FROM events e`;
  const SELECT_STAR = `SELECT e.* FROM events e`;
  const SELECT_MIN = `SELECT e.id, e.embedding, e.norm FROM events e`;
  const WHERE = ` WHERE e.embedding IS NOT NULL AND e.dim = ?`;

  const stmtGC = raw.prepare(SELECT_GC + WHERE);
  const stmtStar = raw.prepare(SELECT_STAR + WHERE);
  const stmtMin = raw.prepare(SELECT_MIN + WHERE);

  const prof = async (name: string, fn: () => unknown) => {
    const r = await bench(fn, RUNS, 1);
    record("profile", name, `${fmt(r.median, 1)} ms`);
    return r.median;
  };
  const note = (text: string) => {
    results[results.length - 1]!.note = text;
    console.log(`      -> ${text}`);
  };

  let sink = 0;
  const tGC = await prof("A. SQL iterate, SELECT e.* + group_concat subquery, no JS work", () => {
    for (const _ of stmtGC.iterate(DIM)) sink++;
  });
  const tStar = await prof("B. SQL iterate, SELECT e.* (no group_concat)", () => {
    for (const _ of stmtStar.iterate(DIM)) sink++;
  });
  note(`group_concat subquery costs ${fmt(tGC - tStar)} ms (${fmt((100 * (tGC - tStar)) / tGC, 0)}% of A)`);
  const tMin = await prof("C. SQL iterate, SELECT id, embedding, norm only", () => {
    for (const _ of stmtMin.iterate(DIM)) sink++;
  });
  note(`content/metadata/type/timestamp columns cost ${fmt(tStar - tMin)} ms`);
  const tAllMin = await prof("C'. same as C but .all() instead of .iterate()", () => {
    sink += stmtMin.all(DIM).length;
  });
  void tAllMin;
  const tDecode = await prof("D. C + decodeEmbedding (copy to aligned Float32Array)", () => {
    for (const r of stmtMin.iterate(DIM) as Iterable<{ embedding: Buffer }>) sink += decodeEmbedding(r.embedding).length;
  });
  note(`blob decode costs ${fmt(tDecode - tMin)} ms`);
  const tCos = await prof("E. D + cosine (== full similar() scoring path)", () => {
    for (const r of stmtMin.iterate(DIM) as Iterable<{ embedding: Buffer; norm: number }>) {
      sink += cosine(qvec, decodeEmbedding(r.embedding), qnorm, r.norm);
    }
  });
  note(`cosine costs ${fmt(tCos - tDecode)} ms`);
  const tFull = await prof("F. A + decode + cosine (== similar() minus top-k bookkeeping)", () => {
    for (const r of stmtGC.iterate(DIM) as Iterable<{ embedding: Buffer; norm: number }>) {
      sink += cosine(qvec, decodeEmbedding(r.embedding), qnorm, r.norm);
    }
  });
  note(`breakdown of F: SQL+group_concat ${fmt((100 * tGC) / tFull, 0)}%, decode ${fmt((100 * (tDecode - tMin)) / tFull, 0)}%, cosine ${fmt((100 * (tCos - tDecode)) / tFull, 0)}%`);

  // Alternative decode strategies.
  let aligned = 0;
  let total = 0;
  for (const r of stmtMin.iterate(DIM) as Iterable<{ embedding: Buffer }>) {
    total++;
    if (r.embedding.byteOffset % 4 === 0) aligned++;
  }
  record("profile", "blob alignment: buffers with byteOffset % 4 == 0", `${fmt((100 * aligned) / total, 1)} %`, "zero-copy Float32Array view possible when aligned");
  const tView = await prof("G. C + zero-copy view when aligned (copy otherwise) + cosine", () => {
    for (const r of stmtMin.iterate(DIM) as Iterable<{ embedding: Buffer; norm: number }>) {
      const b = r.embedding;
      const v =
        b.byteOffset % 4 === 0 ? new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2) : decodeEmbedding(b);
      sink += cosine(qvec, v, qnorm, r.norm);
    }
  });
  note(`vs E: ${fmt(tCos - tView)} ms saved`);
  const tDot = await prof("H. C + dot product straight off the Buffer (readFloatLE), no allocation", () => {
    const n = qvec.length;
    for (const r of stmtMin.iterate(DIM) as Iterable<{ embedding: Buffer; norm: number }>) {
      const b = r.embedding;
      let dot = 0;
      for (let i = 0; i < n; i++) dot += qvec[i]! * b.readFloatLE(i << 2);
      sink += dot / (qnorm * r.norm);
    }
  });
  void tDot;
  // Pre-normalized vectors: dot only, skip the norm multiply (tiny) — but also
  // demonstrates cost with Float32Array query vs number[] query.
  const qArr = Array.from(qvec);
  const tArr = await prof("I. E but query vector as number[] (what callers pass via API before toFloat32)", () => {
    for (const r of stmtMin.iterate(DIM) as Iterable<{ embedding: Buffer; norm: number }>) {
      const v = decodeEmbedding(r.embedding);
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += qArr[i]! * v[i]!;
      sink += dot / (qnorm * r.norm);
    }
  });
  void tArr;

  // Cost of the un-indexed `dim = ?` scan for the 1536-dim query: how long to find 1000 rows among 101k.
  const tDimScan = await prof(`J. SELECT count(*) WHERE dim = ${BIG_DIM} (no index on dim; full table scan)`, () => {
    sink += (raw.prepare(`SELECT count(*) FROM events WHERE embedding IS NOT NULL AND dim = ?`).get(BIG_DIM) as any)["count(*)"];
  });
  const tTypeScan = await prof(`K. SELECT count(*) WHERE type = 'big' AND dim = ${BIG_DIM} (uses events_type_ts index)`, () => {
    sink += (raw.prepare(`SELECT count(*) FROM events WHERE type = 'big' AND embedding IS NOT NULL AND dim = ?`).get(BIG_DIM) as any)["count(*)"];
  });
  note(`un-indexed dim filter costs ${fmt(tDimScan - tTypeScan)} ms per 1536-dim query`);

  // JSON.parse(metadata) only happens for rows entering the top-k, so it is negligible in similar();
  // measure it anyway to quantify what a "return full rows" design would cost.
  const tJson = await prof("L. C + JSON.parse(metadata) for every row (hypothetical, NOT what similar() does)", () => {
    for (const r of raw.prepare(`SELECT metadata FROM events WHERE embedding IS NOT NULL AND dim = ?`).iterate(DIM) as Iterable<{ metadata: string }>) {
      sink += JSON.parse(r.metadata).score;
    }
  });
  void tJson;

  // Query plans for the two filtered paths and the history timeline window.
  console.log("\n  Query plans:");
  const plans: [string, string, unknown[]][] = [
    ["similar, no filter", SELECT_GC + WHERE + " AND 1", [DIM]],
    ["similar, type filter", SELECT_GC + WHERE + " AND e.type IN (?)", [DIM, "type3"]],
    [
      "similar, entity filter",
      SELECT_GC + WHERE + " AND EXISTS (SELECT 1 FROM event_entities ee WHERE ee.event_id = e.id AND ee.entity_id IN (?))",
      [DIM, "E0042"],
    ],
    ["similar, asOf filter", SELECT_GC + WHERE + " AND e.observed_at <= ?", [DIM, T0]],
    [
      "history timeline window (entity IN 3, no namespace)",
      "SELECT * FROM timeline WHERE timestamp >= ? AND timestamp <= ? AND observed_at <= ? AND entity IN (?,?,?) ORDER BY timestamp ASC, id ASC",
      [T0, T0 + 36 * DAY, T0 + 36 * DAY, "E0001", "E0002", "E0003"],
    ],
    [
      "timeline.range, no entity/namespace",
      "SELECT * FROM timeline WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, id ASC LIMIT ?",
      [T0, T0 + DAY, 1001],
    ],
    [
      "events.list, no filter",
      SELECT_GC + " WHERE 1 ORDER BY e.timestamp asc, e.id asc LIMIT ?",
      [1001],
    ],
  ];
  for (const [name, sql, params] of plans) {
    const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
    console.log(`  - ${name}:`);
    for (const r of rows) console.log(`      ${r.detail}`);
  }

  // One history timeline window, timed directly, to show the index-scan cost per window.
  {
    const stmt = raw.prepare(
      "SELECT * FROM timeline WHERE timestamp >= ? AND timestamp <= ? AND observed_at <= ? AND entity IN (?,?,?) ORDER BY timestamp ASC, id ASC",
    );
    const from = T0 + 200 * DAY;
    const r = await prof("M. one history timeline window (3 entities x 4 ns x 36 d), SQL only", () => {
      sink += stmt.all(from, from + 36 * DAY, from + 36 * DAY, "E0001", "E0002", "E0003").length;
    });
    const stmt2 = raw.prepare(
      "SELECT * FROM timeline WHERE entity = ? AND namespace = ? AND timestamp >= ? AND timestamp <= ? AND observed_at <= ? ORDER BY timestamp ASC, id ASC",
    );
    const r2 = await prof("N. same window as 12 (entity,namespace) point-range queries", () => {
      for (const e of ["E0001", "E0002", "E0003"])
        for (const ns of NAMESPACES) sink += stmt2.all(e, ns, from, from + 36 * DAY, from + 36 * DAY).length;
    });
    note(`vs M: ${fmt(r - r2)} ms per window`);
    const r3 = await prof("O. M + JSON.parse(data) per point (== rowToPoint)", () => {
      for (const p of stmt.all(from, from + 36 * DAY, from + 36 * DAY, "E0001", "E0002", "E0003") as { data: string }[]) sink += JSON.parse(p.data).vol;
    });
    note(`JSON.parse costs ${fmt(r3 - r)} ms per window (${fmt((100 * (r3 - r)) / r3, 0)}% of SQL+parse)`);
  }

  // ------------------------------------------------------------ what-ifs
  console.log("\n  What-if experiments (schema/query changes NOT in src/):");
  const winSql =
    "SELECT * FROM timeline WHERE timestamp >= ? AND timestamp <= ? AND observed_at <= ? AND entity IN (?,?,?) ORDER BY timestamp ASC, id ASC";
  const winFrom = T0 + 200 * DAY;
  const winArgs = [winFrom, winFrom + 36 * DAY, winFrom + 36 * DAY, "E0001", "E0002", "E0003"];

  // Entity filter: current EXISTS form vs IN-subquery form (both with the group_concat SELECT, as similar() uses).
  const existsSql = SELECT_GC + WHERE + " AND EXISTS (SELECT 1 FROM event_entities ee WHERE ee.event_id = e.id AND ee.entity_id IN (?))";
  const inSql = SELECT_GC + WHERE + " AND e.id IN (SELECT event_id FROM event_entities WHERE entity_id IN (?))";
  const tExists = await prof("P1. entity filter, current EXISTS form (SQL iterate only)", () => {
    for (const _ of raw.prepare(existsSql).iterate(DIM, "E0042")) sink++;
  });
  const tIn = await prof("P2. entity filter, `e.id IN (SELECT event_id ...)` form", () => {
    for (const _ of raw.prepare(inSql).iterate(DIM, "E0042")) sink++;
  });
  note(`IN-subquery form is ${fmt(tExists / tIn, 1)}x faster (${fmt(tExists)} -> ${fmt(tIn)} ms)`);
  for (const r of raw.prepare(`EXPLAIN QUERY PLAN ${inSql}`).all(DIM, "E0042") as { detail: string }[]) console.log(`      plan: ${r.detail}`);

  // Paging loops: default 2 MB page cache vs 256 MB. Row lookups from the
  // timestamp indexes are random across the file (insert order != timestamp order).
  {
    const rangePage = raw.prepare(
      "SELECT * FROM timeline WHERE timestamp >= ? AND timestamp <= ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) ORDER BY timestamp ASC, id ASC LIMIT ?",
    );
    const listPage = raw.prepare(SELECT_GC + " WHERE (e.timestamp > ? OR (e.timestamp = ? AND e.id > ?)) ORDER BY e.timestamp asc, e.id asc LIMIT ?");
    const from = T0 + 100 * DAY;
    const to = from + 50 * DAY - 1;
    const pageAll = () => {
      let t = -1;
      let id = -1;
      let pages = 0;
      for (;;) {
        const rows = rangePage.all(from, to, t, t, id, 1001) as { timestamp: number; id: number }[];
        pages++;
        if (rows.length <= 1000) break;
        const last = rows[999]!;
        t = last.timestamp;
        id = last.id;
      }
      return pages;
    };
    const listAll = () => {
      let t = -1;
      let id = "";
      let pages = 0;
      for (;;) {
        const rows = listPage.all(t, t, id, 1001) as { timestamp: number; id: string }[];
        pages++;
        if (rows.length <= 1000) break;
        const last = rows[999]!;
        t = last.timestamp;
        id = last.id;
      }
      return pages;
    };
    for (const r of raw.prepare(`EXPLAIN QUERY PLAN ${rangePage.source}`).all(from, to, -1, -1, -1, 1001) as { detail: string }[]) console.log(`      range plan: ${r.detail}`);
    for (const r of raw.prepare(`EXPLAIN QUERY PLAN ${listPage.source}`).all(-1, -1, "", 1001) as { detail: string }[]) console.log(`      list plan: ${r.detail}`);
    for (const [label, cache] of [["default cache_size=-2000 (2 MB)", -2000], ["cache_size=-262144 (256 MB)", -262144]] as const) {
      raw.pragma(`cache_size = ${cache}`);
      const tR = await prof(`V. timeline.range 100 pages, SQL only, ${label}`, () => {
        sink += pageAll();
      });
      const tL = await prof(`W. events.list 101 pages, SQL only (with group_concat), ${label}`, () => {
        sink += listAll();
      });
      void tR;
      void tL;
    }
    raw.pragma("cache_size = -2000");
  }

  // ANALYZE: does the planner pick a better plan for the EXISTS form with stats?
  {
    const t = performance.now();
    raw.exec("ANALYZE");
    record("what-if", "ANALYZE on the full db", `${fmt(performance.now() - t)} ms`);
    const tExists2 = await prof("P3. entity filter, EXISTS form after ANALYZE", () => {
      for (const _ of raw.prepare(existsSql).iterate(DIM, "E0042")) sink++;
    });
    note(`ANALYZE: ${fmt(tExists)} -> ${fmt(tExists2)} ms`);
    for (const r of raw.prepare(`EXPLAIN QUERY PLAN ${existsSql}`).all(DIM, "E0042") as { detail: string }[]) console.log(`      plan: ${r.detail}`);
    const tWin2 = await prof("P4. history window after ANALYZE", () => {
      sink += raw.prepare(winSql).all(...winArgs).length;
    });
    for (const r of raw.prepare(`EXPLAIN QUERY PLAN ${winSql}`).all(...winArgs) as { detail: string }[]) console.log(`      plan: ${r.detail}`);
    void tWin2;
  }

  // Candidate index on dim for the un-indexed `dim = ?` predicate.
  {
    const t = performance.now();
    raw.exec("CREATE INDEX IF NOT EXISTS x_events_dim ON events (dim) WHERE embedding IS NOT NULL");
    record("what-if", "CREATE INDEX events(dim) WHERE embedding IS NOT NULL", `${fmt(performance.now() - t)} ms`);
    const tJ2 = await prof(`Q. count(*) WHERE dim = ${BIG_DIM} with dim index`, () => {
      sink += (raw.prepare(`SELECT count(*) FROM events WHERE embedding IS NOT NULL AND dim = ?`).get(BIG_DIM) as any)["count(*)"];
    });
    note(`${fmt(tDimScan)} -> ${fmt(tJ2)} ms for the 1536-dim candidate scan`);
  }

  // Candidate index (entity, timestamp) for history windows without a namespace filter.
  {
    const t = performance.now();
    raw.exec("CREATE INDEX IF NOT EXISTS x_timeline_entity_ts ON timeline (entity, timestamp)");
    record("what-if", "CREATE INDEX timeline(entity, timestamp) on 2M rows", `${fmt(performance.now() - t)} ms`);
    const tWin3 = await prof("R. history window with (entity, timestamp) index", () => {
      sink += raw.prepare(winSql).all(...winArgs).length;
    });
    for (const r of raw.prepare(`EXPLAIN QUERY PLAN ${winSql}`).all(...winArgs) as { detail: string }[]) console.log(`      plan: ${r.detail}`);
    note(`per-window SQL ${fmt(tWin3)} ms; x500 windows ≈ ${fmt(tWin3 * 500)} ms`);
    raw.exec("DROP INDEX x_timeline_entity_ts");
  }

  // Statement preparation overhead: fetchWindow() / getMany() prepare a fresh statement per call.
  const tPrep = await prof("S. 500 x db.prepare(window SQL) (uncached statement cost in getMany x500)", () => {
    for (let i = 0; i < 500; i++) sink += raw.prepare(winSql).reader ? 1 : 0;
  });
  void tPrep;

  // events.list page: SQL cost with and without the group_concat subquery, plus JSON.parse.
  {
    const listGC = raw.prepare(SELECT_GC + " WHERE 1 ORDER BY e.timestamp asc, e.id asc LIMIT ?");
    const listPlain = raw.prepare(SELECT_STAR + " WHERE 1 ORDER BY e.timestamp asc, e.id asc LIMIT ?");
    const tL1 = await prof("T1. events.list page of 1000, SQL only, with group_concat", () => {
      sink += listGC.all(1001).length;
    });
    const tL2 = await prof("T2. events.list page of 1000, SQL only, no group_concat", () => {
      sink += listPlain.all(1001).length;
    });
    note(`group_concat costs ${fmt(tL1 - tL2)} ms/page`);
    const tL3 = await prof("T3. T1 + JSON.parse(content, metadata) (== rowToEvent)", () => {
      for (const r of listGC.all(1001) as { content: string; metadata: string }[]) sink += JSON.parse(r.content).length + JSON.parse(r.metadata).score;
    });
    note(`JSON.parse costs ${fmt(tL3 - tL1)} ms/page`);
  }

  // timeline.range page: SQL only vs + JSON.parse.
  {
    const rangeSql = raw.prepare("SELECT * FROM timeline WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC, id ASC LIMIT ?");
    const from = T0 + 100 * DAY;
    const tR1 = await prof("U1. timeline.range page of 1000, SQL only", () => {
      sink += rangeSql.all(from, from + 50 * DAY, 1001).length;
    });
    const tR2 = await prof("U2. U1 + JSON.parse(data)", () => {
      for (const r of rangeSql.all(from, from + 50 * DAY, 1001) as { data: string }[]) sink += JSON.parse(r.data).vol;
    });
    note(`JSON.parse costs ${fmt(tR2 - tR1)} ms/page`);
  }

  void sink;
  raw.close();
}

// ---------------------------------------------------------------------------
// Ingest pragma experiment: default connection vs a tuned one, at reduced scale.
// ---------------------------------------------------------------------------

async function ingestPragmaExperiment(): Promise<void> {
  const N_TL = 500_000;
  const N_EV = 20_000;
  const configs: [string, (raw: Database.Database) => void][] = [
    ["defaults (WAL, synchronous=FULL, cache_size=-2000)", () => {}],
    [
      "synchronous=NORMAL, cache_size=-262144 (256 MB)",
      (raw) => {
        raw.pragma("synchronous = NORMAL");
        raw.pragma("cache_size = -262144");
      },
    ],
    ["cache_size=-262144 only", (raw) => raw.pragma("cache_size = -262144")],
    ["synchronous=NORMAL only", (raw) => raw.pragma("synchronous = NORMAL")],
  ];
  for (const [name, apply] of configs) {
    const path = join(BENCH_DIR, "hindsight-db-pragma.db");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    const db = openDatabase({ path });
    apply((db as any).conn.db);
    seed = 12345;
    let evMs = 0;
    for (let start = 0; start < N_EV; start += EVENT_BATCH) {
      const batch = Array.from({ length: EVENT_BATCH }, (_, j) => ({
        timestamp: T0 + randInt(N_DAYS) * DAY,
        type: `type${(start + j) % N_TYPES}`,
        entities: pickEntities(3),
        content: "c",
        embedding: randVec(DIM),
        metadata: {},
      }));
      const t = performance.now();
      await db.events.insertMany(batch);
      evMs += performance.now() - t;
    }
    let tlMs = 0;
    let inserted = 0;
    let batch: { timestamp: number; entity: string; namespace: string; data: { close: number } }[] = [];
    let n = 0;
    for (let e = 0; e < N_ENTITIES && n < N_TL; e++) {
      for (const namespace of NAMESPACES) {
        for (let d = 0; d < N_DAYS && n < N_TL; d++, n++) {
          batch.push({ timestamp: T0 + d * DAY, entity: entityName(e), namespace, data: { close: d } });
          if (batch.length === TIMELINE_BATCH) {
            const t = performance.now();
            await db.timeline.insertMany(batch);
            tlMs += performance.now() - t;
            inserted += batch.length;
            batch = [];
          }
        }
      }
    }
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    record(
      "ingest-pragma",
      name,
      `${fmtInt(inserted / (tlMs / 1000))} tl rows/s`,
      `timeline x${fmtInt(inserted)}: ${fmt(tlMs / 1000, 2)} s; events x${fmtInt(N_EV)}: ${fmtInt(N_EV / (evMs / 1000))} rows/s`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

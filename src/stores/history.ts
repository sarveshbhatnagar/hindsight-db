import type { Connection } from "../storage/sqlite.js";
import { asArray } from "../storage/sqlite.js";
import { toMillis, windowAround } from "../time.js";
import type {
  Decision,
  Event,
  History,
  HistoryManyQuery,
  HistoryQuery,
  Outcome,
  TimelineRangeQuery,
} from "../types.js";
import type { EventProvider } from "../events/provider.js";
import { assertLimit } from "../validate.js";
import type { DecisionStore } from "./decisions.js";
import type { OutcomeStore } from "./outcomes.js";
import { groupByNamespace, type TimelineStore, type TimelineWindow, type TimelineWindowSpec } from "./timeline.js";

const DEFAULT_BEFORE = "7d";
const DEFAULT_AFTER = "0ms";
const DEFAULT_MAX_POINTS = 100_000;

type WindowOptions = Omit<HistoryQuery, "eventId">;

interface ResolvedWindow {
  from: number;
  to: number;
  contextUntil: number;
  outcomeUntil: number;
}

/**
 * Compound historical retrieval. Reconstructs, for one or many events, the
 * event itself, the pre-decision context, the surrounding timeline, and the
 * decisions/outcomes attached to it — respecting the observation-time
 * boundary so that nothing observed after `contextUntil` leaks into `context`.
 */
export class HistoryStore {
  constructor(
    private readonly conn: Connection,
    private readonly events: EventProvider,
    private readonly timeline: TimelineStore,
    private readonly decisions: DecisionStore,
    private readonly outcomes: OutcomeStore,
  ) {}

  async get(query: HistoryQuery): Promise<History> {
    const { eventId, ...opts } = query;
    const [history] = await this.getMany({ eventIds: [eventId], ...opts });
    if (!history) throw new Error(`Event not found: ${eventId}`);
    return history;
  }

  /**
   * Retrieve histories for many events. All lookups are batched: one query
   * for events, one for decisions, one for outcomes, and one read
   * transaction for all timeline windows. Results preserve the order of
   * `eventIds`; unknown ids are omitted.
   */
  async getMany(query: HistoryManyQuery): Promise<History[]> {
    const { eventIds, ...opts } = query;
    const ids = [...new Set(eventIds)];
    if (ids.length === 0) return [];

    const events = await this.events.getMany(ids);
    if (events.length === 0) return [];

    // Capped at timeline.range's page limit so `truncated.next` is always a valid range query.
    const maxPoints = assertLimit("maxPoints", opts.maxPoints, DEFAULT_MAX_POINTS, DEFAULT_MAX_POINTS);
    const windows = events.map((e) => resolveWindow(e, opts));
    const specs: TimelineWindowSpec[] = events.map((e, i) => {
      const w = windows[i]!;
      const entities = opts.entities !== undefined ? asArray(opts.entities) : e.entities;
      return {
        from: w.from,
        to: w.to,
        // outcomeUntil >= contextUntil, so this is the superset of both views; sliced below.
        asOf: w.outcomeUntil,
        ...(entities && entities.length ? { entities } : {}),
        ...(opts.namespace !== undefined ? { namespaces: asArray(opts.namespace) } : {}),
        limit: maxPoints,
      };
    });

    const foundIds = events.map((e) => e.id);
    const [points, decisionsByEvent, outcomesByEvent] = this.conn.transaction(() => [
      this.timeline.fetchWindows(specs),
      this.decisions.forEvents(foundIds),
      this.outcomes.forEvents(foundIds),
    ]);

    return events.map((event, i) =>
      assemble(event, windows[i]!, specs[i]!, points[i]!, decisionsByEvent.get(event.id)!, outcomesByEvent.get(event.id)!),
    );
  }
}

function resolveWindow(event: Event, opts: WindowOptions): ResolvedWindow {
  const { from, to: explicitTo } = windowAround(event.timestamp, opts.before ?? DEFAULT_BEFORE, opts.after ?? DEFAULT_AFTER);
  const contextUntil = opts.contextUntil !== undefined ? toMillis(opts.contextUntil) : event.observedAt;
  // The outcome view must know at least as much as the context view, so the
  // default cutoff never falls before contextUntil (an event may be observed
  // after the end of a short window).
  const outcomeUntil =
    opts.outcomeUntil !== undefined ? toMillis(opts.outcomeUntil) : Math.max(explicitTo, contextUntil);
  // Unless `after` was given explicitly, the event-time window extends to
  // cover the observation cutoffs, so `contextUntil: decision.timestamp,
  // outcomeUntil: decision.timestamp + 5d` sees the data those cutoffs imply.
  const to = opts.after !== undefined ? explicitTo : Math.max(explicitTo, outcomeUntil);
  if (contextUntil > outcomeUntil) {
    throw new RangeError(
      `contextUntil (${contextUntil}) must not be after outcomeUntil (${outcomeUntil}); context would know more than the outcome view`,
    );
  }
  return { from, to, contextUntil, outcomeUntil };
}

function assemble(
  event: Event,
  w: ResolvedWindow,
  spec: TimelineWindowSpec,
  window: TimelineWindow,
  decisions: Decision[],
  outcomes: Outcome[],
): History {
  const { points } = window;
  const history: History = {
    event,
    context: groupByNamespace(points.filter((p) => p.observedAt <= w.contextUntil)),
    timeline: groupByNamespace(points.filter((p) => p.observedAt <= w.outcomeUntil)),
    decisions: decisions.filter((d) => d.timestamp <= w.outcomeUntil),
    outcomes: outcomes.filter((o) => o.timestamp <= w.outcomeUntil),
    window: w,
  };
  const last = points[points.length - 1];
  if (window.nextCursor && last) {
    const next: TimelineRangeQuery = {
      from: spec.from,
      to: spec.to,
      asOf: w.outcomeUntil,
      ...(spec.entities ? { entity: spec.entities } : {}),
      ...(spec.namespaces ? { namespace: spec.namespaces } : {}),
      limit: spec.limit!,
      cursor: window.nextCursor,
    };
    history.truncated = { at: { timestamp: last.timestamp, id: last.id }, next };
  }
  return history;
}

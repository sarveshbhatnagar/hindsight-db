/**
 * Time helpers.
 *
 * All timestamps are stored and returned as epoch milliseconds. Inputs may be
 * epoch ms, ISO-8601 strings, or Date objects.
 *
 * Durations may be a number of milliseconds or a compact string such as
 * "7d", "12h", "30m", "45s", "500ms", "2w", or a bare "0". Whitespace and sign
 * are allowed ("-7d", "+ 5d").
 */

export type TimestampInput = number | string | Date;
export type DurationInput = number | string;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

const DURATION_RE = /^([+-])?\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;

export function toMillis(input: TimestampInput): number {
  if (input instanceof Date) {
    const t = input.getTime();
    if (Number.isNaN(t)) throw new TypeError("Invalid Date");
    return t;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError(`Invalid timestamp: ${input}`);
    return Math.trunc(input);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    const t = Date.parse(trimmed);
    if (Number.isNaN(t)) throw new TypeError(`Invalid timestamp: "${input}"`);
    return t;
  }
  throw new TypeError(`Invalid timestamp: ${String(input)}`);
}

export function parseDuration(input: DurationInput): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError(`Invalid duration: ${input}`);
    return Math.trunc(input);
  }
  const trimmed = input.trim();
  if (/^[+-]?0+$/.test(trimmed)) return 0;
  const m = DURATION_RE.exec(trimmed);
  if (!m) throw new TypeError(`Invalid duration: "${input}" (expected e.g. "7d", "12h", "30m", "45s", "500ms")`);
  const sign = m[1] === "-" ? -1 : 1;
  const value = Number(m[2]);
  const unit = m[3]!.toLowerCase();
  return sign * Math.trunc(value * UNIT_MS[unit]!);
}

/**
 * Shift a timestamp by a signed duration: `addDuration(event.timestamp, "-7d")`.
 * This is the working form of the design's `event.timestamp - "7d"` pseudocode.
 */
export function addDuration(timestamp: TimestampInput, duration: DurationInput): number {
  return toMillis(timestamp) + parseDuration(duration);
}

/** Resolve a "before"/"after" window around a center timestamp into absolute ms bounds. */
export function windowAround(
  center: number,
  before: DurationInput | undefined,
  after: DurationInput | undefined,
): { from: number; to: number } {
  const b = before === undefined ? 0 : Math.abs(parseDuration(before));
  const a = after === undefined ? 0 : Math.abs(parseDuration(after));
  return { from: center - b, to: center + a };
}

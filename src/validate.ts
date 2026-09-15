/** Input validation shared by the stores. All throw TypeError with a field-qualified message. */

const SEP_CODE = 31; // U+001F, used internally to join entity ids

export function assertId(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

export function assertEntity(field: string, value: unknown): string {
  const s = assertId(field, value);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === SEP_CODE) throw new TypeError(`${field} must not contain U+001F`);
  }
  return s;
}

export function assertPlainObject(field: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

/** Positive integer page/result size. */
export function assertLimit(field: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return Math.min(value, max);
}

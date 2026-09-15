import { describe, expect, it } from "vitest";
import { parseDuration, toMillis, windowAround } from "../src/time.js";

const DAY = 86_400_000;

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("2w")).toBe(14 * DAY);
  });
  it("accepts sign, whitespace, decimals and numbers", () => {
    expect(parseDuration("-7d")).toBe(-7 * DAY);
    expect(parseDuration(" + 1.5d ")).toBe(1.5 * DAY);
    expect(parseDuration(1234)).toBe(1234);
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("7 days")).toThrow(/Invalid duration/);
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration(NaN)).toThrow();
  });
});

describe("toMillis", () => {
  it("accepts ms, ISO strings, numeric strings and Dates", () => {
    expect(toMillis(1000)).toBe(1000);
    expect(toMillis("1000")).toBe(1000);
    expect(toMillis("2024-01-02T00:00:00Z")).toBe(Date.UTC(2024, 0, 2));
    expect(toMillis(new Date(Date.UTC(2024, 0, 2)))).toBe(Date.UTC(2024, 0, 2));
  });
  it("rejects invalid values", () => {
    expect(() => toMillis("not a date")).toThrow(/Invalid timestamp/);
    expect(() => toMillis(new Date("x"))).toThrow(/Invalid Date/);
  });
});

describe("windowAround", () => {
  it("builds absolute bounds and ignores sign on before/after", () => {
    expect(windowAround(10 * DAY, "7d", "1d")).toEqual({ from: 3 * DAY, to: 11 * DAY });
    expect(windowAround(10 * DAY, "-7d", undefined)).toEqual({ from: 3 * DAY, to: 10 * DAY });
  });
});

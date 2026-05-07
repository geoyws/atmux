// Unit tests for src/abstractions/time.ts (ADR-012).

import { afterEach, describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatMyt,
  formatMytFull,
  now,
  nowIso,
  resetNow,
  setNow,
} from "../../../src/abstractions/time.ts";

afterEach(() => {
  resetNow();
});

describe("clock injection", () => {
  test("now() returns Date.now() by default", () => {
    const before = Date.now();
    const got = now();
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });

  test("setNow() overrides; resetNow() restores", () => {
    setNow(() => 1_000);
    expect(now()).toBe(1_000);
    resetNow();
    const got = now();
    expect(got).toBeGreaterThan(1_000);
  });
});

describe("formatMyt", () => {
  test("renders MYT with explicit suffix at known instant", () => {
    // 03:44 UTC May 4 2026 → 11:44 MYT (UTC+8)
    setNow(() => Date.UTC(2026, 4, 4, 3, 44));
    expect(formatMyt()).toBe("11:44 MYT");
  });

  test("respects explicit epochMs argument", () => {
    expect(formatMyt(Date.UTC(2026, 4, 4, 16, 0))).toBe("00:00 MYT");
  });

  test("uses 24-hour clock", () => {
    expect(formatMyt(Date.UTC(2026, 4, 4, 13, 30))).toBe("21:30 MYT");
  });
});

describe("formatMytFull", () => {
  test("renders YYYY-MM-DD HH:MM:SS MYT", () => {
    setNow(() => Date.UTC(2026, 4, 4, 3, 44, 12));
    expect(formatMytFull()).toBe("2026-05-04 11:44:12 MYT");
  });

  test("strips comma between date and time", () => {
    const out = formatMytFull(Date.UTC(2026, 4, 4, 0, 0, 0));
    expect(out).not.toContain(",");
    expect(out.endsWith(" MYT")).toBe(true);
  });
});

describe("nowIso", () => {
  test("renders ISO 8601 second-precision UTC", () => {
    setNow(() => Date.UTC(2026, 4, 4, 3, 44, 12, 567));
    expect(nowIso()).toBe("2026-05-04T03:44:12Z");
  });

  test("accepts explicit epoch", () => {
    expect(nowIso(0)).toBe("1970-01-01T00:00:00Z");
  });
});

describe("formatDuration", () => {
  test.each<[number, string]>([
    [0, "0min"],
    [30_000, "1min"], // sub-minute → 1min
    [47 * 60_000, "47min"],
    [60 * 60_000, "1h"],
    [2 * 3_600_000, "2h"],
    [6 * 3_600_000 + 45 * 60_000, "6h45m"],
    [25 * 3_600_000 + 49 * 60_000, "25h49m"],
    [48 * 3_600_000, "48h"], // no day unit
    [-30 * 60_000, "30min"], // negative absorbed
  ])("formatDuration(%dms) → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  test("non-finite input returns 0min", () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0min");
    expect(formatDuration(Number.NaN)).toBe("0min");
  });

  test("rounds nearest minute", () => {
    expect(formatDuration(89_000)).toBe("1min"); // 1.48m → rounds to 1
    expect(formatDuration(91_000)).toBe("2min"); // 1.51m → rounds to 2
  });
});

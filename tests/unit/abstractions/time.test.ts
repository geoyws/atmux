// Unit tests for src/abstractions/time.ts (ADR-012).

import { afterEach, describe, expect, test } from "bun:test";
import {
  formatDuration,
  formatTickDuration,
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

describe("formatTickDuration", () => {
  test.each<[number, string]>([
    // Sub-second
    [0, "0ms"],
    [1, "1ms"],
    [750, "750ms"],
    [999, "999ms"],
    // Seconds (sub-minute)
    [1000, "1s"],
    [5500, "5s500ms"], // sub-1m keeps ms tail
    [26119, "26s119ms"],
    [59999, "59s999ms"],
    // Minutes (sub-hour)
    [60_000, "1m"],
    [90_000, "1m30s"],
    [110_484, "1m50s"],
    [59 * 60_000 + 59_000, "59m59s"],
    // Hours (sub-day)
    [3_600_000, "1h"],
    [3_660_000, "1h1m"],
    [23 * 3_600_000 + 59 * 60_000, "23h59m"],
    // Days
    [24 * 3_600_000, "1d"],
    [25 * 3_600_000, "1d1h"],
    [2 * 24 * 3_600_000 + 5 * 3_600_000, "2d5h"],
  ])("formatTickDuration(%dms) → %s", (ms, expected) => {
    expect(formatTickDuration(ms)).toBe(expected);
  });

  test("non-finite / negative / zero input returns 0ms", () => {
    expect(formatTickDuration(0)).toBe("0ms");
    expect(formatTickDuration(-1)).toBe("0ms");
    expect(formatTickDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
    expect(formatTickDuration(Number.NaN)).toBe("0ms");
  });

  test("picks the two largest non-zero units only — never 4-unit output", () => {
    // 1d 2h 3m 4s 5ms → "1d2h" (m/s/ms suppressed)
    const ms = 24 * 3_600_000 + 2 * 3_600_000 + 3 * 60_000 + 4 * 1000 + 5;
    expect(formatTickDuration(ms)).toBe("1d2h");
  });
});

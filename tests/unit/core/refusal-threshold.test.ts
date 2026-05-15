// Unit tests for src/core/refusal-threshold.ts (ADR-139 T2 /
// t-e49b7a18).
//
// Coverage: each threshold class (soft / hard / role) fires
// rotation correctly; meta-class never fires; window expiry drops
// stale events from the count; mixed-severity picks highest-
// precedence threshold; future events (clock skew) ignored.

import { describe, expect, test } from "bun:test";
import type { RefusalDetectionResult } from "../../../src/core/refusal-classifier.ts";
import {
  DEFAULT_REFUSAL_THRESHOLD_CONFIG,
  HARD_REFUSAL_WINDOW_MIN,
  type RefusalEvent,
  shouldRotate,
} from "../../../src/core/refusal-threshold.ts";

function event(
  member: string,
  team: string,
  timestamp: number,
  severity: RefusalDetectionResult["severity"],
  confidence = 0.5,
): RefusalEvent {
  return {
    member,
    team,
    timestamp,
    result: {
      detected: severity !== "none",
      phrases: severity === "none" ? [] : [{ phrase: `${severity}:test`, class: severity }],
      severity,
      confidence,
    },
  };
}

const NOW = 1_700_000_000;
const CONFIG = DEFAULT_REFUSAL_THRESHOLD_CONFIG;

describe("shouldRotate — soft threshold (3 in 30min)", () => {
  test("3 soft events in window → rotate=true", () => {
    const events = [
      event("m1", "t1", NOW - 60, "soft"),
      event("m1", "t1", NOW - 600, "soft"),
      event("m1", "t1", NOW - 1200, "soft"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(true);
    expect(r.triggeringClass).toBe("soft");
    expect(r.reason).toContain("soft-class refusal");
    expect(r.reason).toContain("3 event");
  });

  test("2 soft events → below threshold, no rotate", () => {
    const events = [
      event("m1", "t1", NOW - 60, "soft"),
      event("m1", "t1", NOW - 600, "soft"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
    expect(r.triggeringClass).toBeNull();
    expect(r.reason).toBe("");
  });

  test("4 soft events, but one outside 30min window → not counted", () => {
    const events = [
      event("m1", "t1", NOW - 60, "soft"),
      event("m1", "t1", NOW - 600, "soft"),
      event("m1", "t1", NOW - 31 * 60, "soft"), // outside 30min
      event("m1", "t1", NOW - 35 * 60, "soft"), // outside 30min
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
  });
});

describe("shouldRotate — hard threshold (2 in 10min)", () => {
  test("2 hard events in 10min → rotate=true", () => {
    const events = [
      event("m1", "t1", NOW - 60, "hard"),
      event("m1", "t1", NOW - 9 * 60, "hard"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(true);
    expect(r.triggeringClass).toBe("hard");
    expect(r.reason).toContain("hard-class refusal");
    expect(r.reason).toContain(`${HARD_REFUSAL_WINDOW_MIN}min`);
  });

  test("2 hard events, one outside 10min window → no rotate", () => {
    const events = [
      event("m1", "t1", NOW - 60, "hard"),
      event("m1", "t1", NOW - 11 * 60, "hard"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
  });

  test("hard window is tighter than soft window (10min vs 30min)", () => {
    // Two hard events at 15min apart fall outside the hard window
    // (10min) but inside the soft window (30min). They should NOT
    // count toward hard threshold even though they're in soft
    // window range.
    const events = [
      event("m1", "t1", NOW - 60, "hard"),
      event("m1", "t1", NOW - 15 * 60, "hard"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
  });
});

describe("shouldRotate — role threshold (1 instant)", () => {
  test("1 role event → rotate=true", () => {
    const events = [event("m1", "t1", NOW - 30, "role")];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(true);
    expect(r.triggeringClass).toBe("role");
    expect(r.reason).toContain("role-class refusal");
  });

  test("0 role events → no rotate (even with soft+hard noise)", () => {
    const events = [
      event("m1", "t1", NOW - 60, "soft"),
      event("m1", "t1", NOW - 120, "soft"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
  });

  test("role event outside window → still counts? (windowMin governs)", () => {
    // ADR-139 §D3 says "Role: 1 event → rotate immediately" — but
    // the threshold helper still bounds by windowMin. An event from
    // an hour ago shouldn't fire a rotate based on stale signal.
    const events = [event("m1", "t1", NOW - 60 * 60, "role")];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
  });
});

describe("shouldRotate — meta class ignored", () => {
  test("10 meta events → no rotate (meta is warn-class)", () => {
    const events: RefusalEvent[] = [];
    for (let i = 0; i < 10; i += 1) {
      events.push(event("m1", "t1", NOW - i * 60, "meta"));
    }
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
    expect(r.triggeringClass).toBeNull();
  });
});

describe("shouldRotate — precedence (role > hard > soft)", () => {
  test("role + hard + soft all over threshold → role wins", () => {
    const events = [
      event("m1", "t1", NOW - 30, "role"),
      event("m1", "t1", NOW - 60, "hard"),
      event("m1", "t1", NOW - 120, "hard"),
      event("m1", "t1", NOW - 180, "soft"),
      event("m1", "t1", NOW - 240, "soft"),
      event("m1", "t1", NOW - 300, "soft"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.triggeringClass).toBe("role");
  });

  test("hard + soft over threshold → hard wins (no role)", () => {
    const events = [
      event("m1", "t1", NOW - 60, "hard"),
      event("m1", "t1", NOW - 120, "hard"),
      event("m1", "t1", NOW - 180, "soft"),
      event("m1", "t1", NOW - 240, "soft"),
      event("m1", "t1", NOW - 300, "soft"),
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.triggeringClass).toBe("hard");
  });
});

describe("shouldRotate — edge cases", () => {
  test("empty events list → no rotate", () => {
    const r = shouldRotate([], CONFIG, NOW);
    expect(r.rotate).toBe(false);
    expect(r.reason).toBe("");
  });

  test("future-dated events (clock skew) ignored", () => {
    const events = [
      event("m1", "t1", NOW + 100, "role"), // future
      event("m1", "t1", NOW + 200, "role"), // future
    ];
    const r = shouldRotate(events, CONFIG, NOW);
    expect(r.rotate).toBe(false);
  });

  test("custom config overrides defaults", () => {
    const tight = { softThreshold: 1, hardThreshold: 1, roleThreshold: 1, windowMin: 60 };
    const events = [event("m1", "t1", NOW - 30, "soft")];
    const r = shouldRotate(events, tight, NOW);
    expect(r.rotate).toBe(true);
    expect(r.triggeringClass).toBe("soft");
  });

  test("DEFAULT_REFUSAL_THRESHOLD_CONFIG matches ADR-139 §Config defaults", () => {
    expect(DEFAULT_REFUSAL_THRESHOLD_CONFIG.softThreshold).toBe(3);
    expect(DEFAULT_REFUSAL_THRESHOLD_CONFIG.hardThreshold).toBe(2);
    expect(DEFAULT_REFUSAL_THRESHOLD_CONFIG.roleThreshold).toBe(1);
    expect(DEFAULT_REFUSAL_THRESHOLD_CONFIG.windowMin).toBe(30);
  });

  test("HARD_REFUSAL_WINDOW_MIN matches ADR-139 §D3 ('2 events in 10min')", () => {
    expect(HARD_REFUSAL_WINDOW_MIN).toBe(10);
  });
});

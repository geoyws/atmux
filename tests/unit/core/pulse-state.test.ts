// Unit tests for src/core/pulse-state.ts (ADR-086 Phase 1).
//
// Coverage:
//   - pulseStatePath (HOME + env fallback + throw)
//   - readPulseState (absent → empty; round-trip)
//   - writePulseState (atomic)
//   - shouldFire branches: first-observation, transition, sustained-urgency
//     within + past window, deduped non-urgent + deduped urgent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../../../src/errors.ts";
import {
  DEFAULT_PULSE_DEDUP_MIN,
  DEFAULT_PULSE_WINDOW_MIN,
  DEFAULT_PULSE_INTERVAL_MIN,
  PULSE_DRIVER_INBOX_STALE_MIN,
  pulseStatePath,
  readPulseState,
  shouldFire,
  writePulseState,
} from "../../../src/core/pulse-state.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atmux-pulse-state-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("constants", () => {
  test("defaults match the ADR-086 table", () => {
    expect(DEFAULT_PULSE_WINDOW_MIN).toBe(30);
    expect(DEFAULT_PULSE_INTERVAL_MIN).toBe(5);
    expect(DEFAULT_PULSE_DEDUP_MIN).toBe(120);
    expect(PULSE_DRIVER_INBOX_STALE_MIN).toBe(30);
  });
});

describe("pulseStatePath", () => {
  test("uses opts.home when provided", () => {
    expect(pulseStatePath({ home: "/tmp/foo" })).toBe("/tmp/foo/.atmux/state/pulse-state.json");
  });
  test("falls back to env.HOME", () => {
    expect(pulseStatePath({ env: { HOME: "/tmp/bar" } })).toBe(
      "/tmp/bar/.atmux/state/pulse-state.json",
    );
  });
  test("throws ConfigError when HOME unresolvable", () => {
    expect(() => pulseStatePath({ env: {} })).toThrow(ConfigError);
  });
});

describe("readPulseState / writePulseState", () => {
  test("absent file → empty state", async () => {
    const got = await readPulseState(pulseStatePath({ home }));
    expect(got).toEqual({ teams: {} });
  });

  test("round-trip", async () => {
    const path = pulseStatePath({ home });
    await writePulseState(path, {
      teams: {
        atmux: { verdict: "🟢 Shipping", lastFireEpoch: 1700000000, lastCommitCount: 3 },
      },
    });
    const got = await readPulseState(path);
    expect(got.teams.atmux?.verdict).toBe("🟢 Shipping");
    expect(got.teams.atmux?.lastFireEpoch).toBe(1700000000);
    expect(got.teams.atmux?.lastCommitCount).toBe(3);
  });
});

describe("shouldFire — first observation", () => {
  test("no prior state → fires", () => {
    const r = shouldFire({
      prior: null,
      current: "🟢 Shipping",
      currentCommitCount: 3,
      nowSec: 1700000000,
      dedupMins: 30,
    });
    expect(r.didFire).toBe(true);
    expect(r.reason).toBe("first-observation");
    expect(r.next?.verdict).toBe("🟢 Shipping");
    expect(r.next?.lastCommitCount).toBe(3);
  });
});

describe("shouldFire — transitions", () => {
  test("verdict change → fires (`transition`)", () => {
    const r = shouldFire({
      prior: { verdict: "🟢 Shipping", lastFireEpoch: 1700000000, lastCommitCount: 3 },
      current: "🟡 Idle",
      currentCommitCount: 0,
      nowSec: 1700001000,
      dedupMins: 30,
    });
    expect(r.didFire).toBe(true);
    expect(r.reason).toBe("transition");
    expect(r.next?.verdict).toBe("🟡 Idle");
    expect(r.next?.lastFireEpoch).toBe(1700001000);
    expect(r.next?.lastCommitCount).toBe(0);
  });

  test("transition down from urgent → fires", () => {
    const r = shouldFire({
      prior: { verdict: "🚨 Need you", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🟢 Shipping",
      currentCommitCount: 5,
      nowSec: 1700001000,
      dedupMins: 30,
    });
    expect(r.didFire).toBe(true);
    expect(r.reason).toBe("transition");
  });
});

describe("shouldFire — sustained urgency", () => {
  test("same 🔴 within window → deduped", () => {
    const r = shouldFire({
      prior: { verdict: "🔴 Stalled", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🔴 Stalled",
      currentCommitCount: 0,
      nowSec: 1700000000 + 10 * 60, // 10min later
      dedupMins: 30,
    });
    expect(r.didFire).toBe(false);
    expect(r.reason).toBe("deduped");
    expect(r.next).toBe(null);
  });

  test("same 🔴 past window → fires (`sustained-urgency`)", () => {
    const r = shouldFire({
      prior: { verdict: "🔴 Stalled", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🔴 Stalled",
      currentCommitCount: 0,
      nowSec: 1700000000 + 30 * 60, // exactly window
      dedupMins: 30,
    });
    expect(r.didFire).toBe(true);
    expect(r.reason).toBe("sustained-urgency");
    expect(r.next?.lastFireEpoch).toBe(1700000000 + 30 * 60);
  });

  test("same 🚨 past window → fires", () => {
    const r = shouldFire({
      prior: { verdict: "🚨 Need you", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🚨 Need you",
      currentCommitCount: 0,
      nowSec: 1700000000 + 31 * 60,
      dedupMins: 30,
    });
    expect(r.didFire).toBe(true);
    expect(r.reason).toBe("sustained-urgency");
  });
});

describe("shouldFire — non-urgent dedup", () => {
  test("same 🟢 Shipping → deduped regardless of time elapsed", () => {
    const r = shouldFire({
      prior: { verdict: "🟢 Shipping", lastFireEpoch: 1700000000, lastCommitCount: 3 },
      current: "🟢 Shipping",
      currentCommitCount: 5,
      nowSec: 1700000000 + 24 * 60 * 60, // 24h later
      dedupMins: 30,
    });
    expect(r.didFire).toBe(false);
    expect(r.reason).toBe("deduped");
  });

  test("same 🟡 Cool → deduped", () => {
    const r = shouldFire({
      prior: { verdict: "🟡 Cool", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🟡 Cool",
      currentCommitCount: 0,
      nowSec: 1700000000 + 60 * 60,
      dedupMins: 30,
    });
    expect(r.didFire).toBe(false);
    expect(r.reason).toBe("deduped");
  });

  test("same 🟡 Idle → deduped", () => {
    const r = shouldFire({
      prior: { verdict: "🟡 Idle", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🟡 Idle",
      currentCommitCount: 0,
      nowSec: 1700000000 + 60 * 60,
      dedupMins: 30,
    });
    expect(r.didFire).toBe(false);
    expect(r.reason).toBe("deduped");
  });
});

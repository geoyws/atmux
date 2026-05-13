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
import {
  DEFAULT_PULSE_DEDUP_LADDER,
  DEFAULT_PULSE_DEDUP_MIN,
  DEFAULT_PULSE_INTERVAL_MIN,
  DEFAULT_PULSE_WINDOW_MIN,
  PULSE_DRIVER_INBOX_STALE_MIN,
  type PulseDedupLadder,
  pulseStatePath,
  readPulseState,
  shouldFire,
  writePulseState,
} from "../../../src/core/pulse-state.ts";
import { ConfigError } from "../../../src/errors.ts";

/** ADR-086 §Phase 1.5 test helper: build a ladder that mirrors the
 *  pre-1.5 binary URGENT_VERDICTS semantic — flat int for 🔴 / 🚨,
 *  default cadences for 🟡 / 🟢. Used by tests that pre-date the
 *  ladder to keep their assertions identical without rewriting. */
function flatLadder(n: number): PulseDedupLadder {
  return {
    ...DEFAULT_PULSE_DEDUP_LADDER,
    "🔴 Stalled": n,
    "🚨 Need you": n,
  };
}

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
    // ADR-086 §Phase 1.1 bumped 30 → 120 (channel-noise reduction);
    // §Phase 1.5 keeps the constant as the soft-deprecated flat
    // fallback for legacy `cockpit.pulse.dedupMins` configs.
    expect(DEFAULT_PULSE_DEDUP_MIN).toBe(120);
    expect(PULSE_DRIVER_INBOX_STALE_MIN).toBe(30);
  });

  test("ADR-086 §Phase 1.5 default ladder shape", () => {
    // 5-verdict map; sustained-urgency cadences <= 60min; lull
    // verdicts at 4h; 🟢 disabled.
    expect(DEFAULT_PULSE_DEDUP_LADDER["🚨 Need you"]).toBe(60);
    expect(DEFAULT_PULSE_DEDUP_LADDER["🔴 Stalled"]).toBe(30);
    expect(DEFAULT_PULSE_DEDUP_LADDER["🟡 Cool"]).toBe(4 * 60);
    expect(DEFAULT_PULSE_DEDUP_LADDER["🟡 Idle"]).toBe(4 * 60);
    expect(DEFAULT_PULSE_DEDUP_LADDER["🟢 Shipping"]).toBeNull();
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
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
      dedupLadderMins: flatLadder(30),
    });
    expect(r.didFire).toBe(false);
    expect(r.reason).toBe("deduped");
  });
});

// ---------- ADR-086 §Phase 1.5: verdict-specific dedup ladder ----------

describe("shouldFire — Phase 1.5 ladder per-verdict cadence", () => {
  test("🚨 Need you re-fires at the ladder cadence (60min default)", () => {
    // 59min later → still deduped under the default ladder's 60min entry.
    const before = shouldFire({
      prior: { verdict: "🚨 Need you", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🚨 Need you",
      currentCommitCount: 0,
      nowSec: 1700000000 + 59 * 60,
      dedupLadderMins: DEFAULT_PULSE_DEDUP_LADDER,
    });
    expect(before.didFire).toBe(false);
    // 60min later → fires.
    const at = shouldFire({
      prior: { verdict: "🚨 Need you", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🚨 Need you",
      currentCommitCount: 0,
      nowSec: 1700000000 + 60 * 60,
      dedupLadderMins: DEFAULT_PULSE_DEDUP_LADDER,
    });
    expect(at.didFire).toBe(true);
    expect(at.reason).toBe("sustained-urgency");
  });

  test("🟡 Cool re-fires after 4h (steady-state confirm)", () => {
    // 3h59m → still deduped.
    const before = shouldFire({
      prior: { verdict: "🟡 Cool", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🟡 Cool",
      currentCommitCount: 0,
      nowSec: 1700000000 + (4 * 60 - 1) * 60,
      dedupLadderMins: DEFAULT_PULSE_DEDUP_LADDER,
    });
    expect(before.didFire).toBe(false);
    // 4h00m → fires (removes the "cron broken or team cool?" silent
    // ambiguity from Phase 1.1).
    const at = shouldFire({
      prior: { verdict: "🟡 Cool", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🟡 Cool",
      currentCommitCount: 0,
      nowSec: 1700000000 + 4 * 60 * 60,
      dedupLadderMins: DEFAULT_PULSE_DEDUP_LADDER,
    });
    expect(at.didFire).toBe(true);
    expect(at.reason).toBe("sustained-urgency");
  });

  test("🟢 Shipping null entry → never re-fires regardless of elapsed time", () => {
    // 24h later, ladder['🟢 Shipping'] is null → silent.
    const r = shouldFire({
      prior: { verdict: "🟢 Shipping", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🟢 Shipping",
      currentCommitCount: 5,
      nowSec: 1700000000 + 24 * 60 * 60,
      dedupLadderMins: DEFAULT_PULSE_DEDUP_LADDER,
    });
    expect(r.didFire).toBe(false);
    expect(r.reason).toBe("deduped");
  });

  test("operator override of ladder entry to null disables re-fire", () => {
    // 🔴 default is 30min; operator override to null disables.
    const customLadder: PulseDedupLadder = { ...DEFAULT_PULSE_DEDUP_LADDER, "🔴 Stalled": null };
    const r = shouldFire({
      prior: { verdict: "🔴 Stalled", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🔴 Stalled",
      currentCommitCount: 0,
      nowSec: 1700000000 + 24 * 60 * 60,
      dedupLadderMins: customLadder,
    });
    expect(r.didFire).toBe(false);
  });

  test("operator override of ladder entry to longer cadence works", () => {
    // 🚨 set to 90min; 60min → still deduped.
    const customLadder: PulseDedupLadder = { ...DEFAULT_PULSE_DEDUP_LADDER, "🚨 Need you": 90 };
    const r = shouldFire({
      prior: { verdict: "🚨 Need you", lastFireEpoch: 1700000000, lastCommitCount: 0 },
      current: "🚨 Need you",
      currentCommitCount: 0,
      nowSec: 1700000000 + 60 * 60,
      dedupLadderMins: customLadder,
    });
    expect(r.didFire).toBe(false);
  });

  test("transitions ALWAYS fire regardless of ladder entries", () => {
    // Even with all ladder entries null (silent everywhere), a verdict
    // change still fires — the transition branch precedes the ladder
    // lookup.
    const silentLadder: PulseDedupLadder = {
      "🚨 Need you": null,
      "🔴 Stalled": null,
      "🟡 Cool": null,
      "🟡 Idle": null,
      "🟢 Shipping": null,
    };
    const r = shouldFire({
      prior: { verdict: "🟢 Shipping", lastFireEpoch: 1700000000, lastCommitCount: 3 },
      current: "🚨 Need you",
      currentCommitCount: 0,
      nowSec: 1700000000 + 60 * 60,
      dedupLadderMins: silentLadder,
    });
    expect(r.didFire).toBe(true);
    expect(r.reason).toBe("transition");
  });
});

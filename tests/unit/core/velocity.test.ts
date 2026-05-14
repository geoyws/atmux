// Unit tests for src/core/velocity.ts — ADR-087 ground-truth
// velocity classifier. Pure module, so the test harness is a
// straight assertion suite over the resolution table from
// ADR-087 §Spec.

import { describe, expect, test } from "bun:test";
import {
  classifyVelocity,
  DEFAULT_STANDBY_GRACE_MIN,
  DEFAULT_STRIKE_THRESHOLD,
  DEFAULT_VELOCITY_WINDOW_MIN,
  type PaneSignal,
  shouldIncrementStrike,
  shouldNudgeLeadPane,
  type VelocityInputs,
} from "../../../src/core/velocity.ts";

function baseInputs(over: Partial<VelocityInputs> = {}): VelocityInputs {
  return {
    commitsInWindow: 0,
    lastCommitAgeMin: null,
    inProgressTaskCount: 0,
    paneSignal: "READY",
    windowMin: 60,
    standbyGraceMin: 30,
    ...over,
  };
}

describe("classifyVelocity — resolution order", () => {
  test("OK: ≥1 commit in window wins regardless of other signals", () => {
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 1, lastCommitAgeMin: 240, inProgressTaskCount: 5 }),
    );
    expect(got.verdict).toBe("OK");
    expect(got.reason).toContain("1 commit");
    expect(got.reason).toContain("60min");
  });

  test("OK: plural commits render plural form in reason", () => {
    const got = classifyVelocity(baseInputs({ commitsInWindow: 5 }));
    expect(got.verdict).toBe("OK");
    expect(got.reason).toContain("5 commits");
  });

  test("STANDBY: lastCommitAgeMin within standby grace beats BAD", () => {
    // 0 commits in window, but last commit was 20min ago (≤30 grace).
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 0, lastCommitAgeMin: 20, inProgressTaskCount: 3 }),
    );
    expect(got.verdict).toBe("STANDBY");
    expect(got.reason).toContain("20min ago");
    expect(got.reason).toContain("grace");
  });

  test("STANDBY: standby grace exact boundary (==) is STANDBY", () => {
    const got = classifyVelocity(baseInputs({ lastCommitAgeMin: 30, inProgressTaskCount: 3 }));
    expect(got.verdict).toBe("STANDBY");
  });

  test("STANDBY: standby grace +1 falls through to BAD (>30 → no grace)", () => {
    const got = classifyVelocity(baseInputs({ lastCommitAgeMin: 31, inProgressTaskCount: 3 }));
    expect(got.verdict).toBe("BAD");
  });

  test("STANDBY: 0 in-progress + 0 commits = STANDBY (nothing to ship)", () => {
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 0, lastCommitAgeMin: null, inProgressTaskCount: 0 }),
    );
    expect(got.verdict).toBe("STANDBY");
    expect(got.reason).toContain("nothing to ship");
  });

  test("STANDBY: 0 in-progress wins over no-prior-commits + zero commits", () => {
    // Fresh team, no commits ever, no work claimed → STANDBY.
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 0, lastCommitAgeMin: null, inProgressTaskCount: 0 }),
    );
    expect(got.verdict).toBe("STANDBY");
  });

  test("BAD: 0 commits + work in flight + stale prior commit → BAD", () => {
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 0, lastCommitAgeMin: 240, inProgressTaskCount: 3 }),
    );
    expect(got.verdict).toBe("BAD");
    expect(got.reason).toContain("0 commits");
    expect(got.reason).toContain("240min");
    expect(got.reason).toContain("3 in-progress");
    expect(got.reason).toContain("stalled");
  });

  test("BAD: 0 commits + work in flight + NEVER any commits → BAD with 'no prior commits' phrasing", () => {
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 0, lastCommitAgeMin: null, inProgressTaskCount: 3 }),
    );
    expect(got.verdict).toBe("BAD");
    expect(got.reason).toContain("no prior commits");
  });

  test("verdict ignores paneSignal entirely (gate is on whip.ts side)", () => {
    const bad1 = classifyVelocity(
      baseInputs({ lastCommitAgeMin: 240, inProgressTaskCount: 3, paneSignal: "READY" }),
    );
    const bad2 = classifyVelocity(
      baseInputs({ lastCommitAgeMin: 240, inProgressTaskCount: 3, paneSignal: "BUSY" }),
    );
    const bad3 = classifyVelocity(
      baseInputs({ lastCommitAgeMin: 240, inProgressTaskCount: 3, paneSignal: "UNREACHABLE" }),
    );
    expect(bad1.verdict).toBe("BAD");
    expect(bad2.verdict).toBe("BAD");
    expect(bad3.verdict).toBe("BAD");
  });

  test("reason uses windowMin from inputs (not hardcoded)", () => {
    const got = classifyVelocity(
      baseInputs({ commitsInWindow: 0, lastCommitAgeMin: 999, inProgressTaskCount: 1, windowMin: 120 }),
    );
    expect(got.verdict).toBe("BAD");
    expect(got.reason).toContain("120min");
  });

  test("reason uses standbyGraceMin from inputs (not hardcoded)", () => {
    const got = classifyVelocity(
      baseInputs({ lastCommitAgeMin: 45, inProgressTaskCount: 2, standbyGraceMin: 60 }),
    );
    expect(got.verdict).toBe("STANDBY");
    expect(got.reason).toContain("60min grace");
  });
});

describe("shouldNudgeLeadPane", () => {
  test("BAD + READY → true", () => {
    expect(
      shouldNudgeLeadPane({ verdict: "BAD", reason: "x" }, "READY"),
    ).toBe(true);
  });

  test("BAD + BUSY → false (classifier-swallow risk)", () => {
    expect(
      shouldNudgeLeadPane({ verdict: "BAD", reason: "x" }, "BUSY"),
    ).toBe(false);
  });

  test("BAD + UNREACHABLE → false (existing checkMember handles wedge)", () => {
    expect(
      shouldNudgeLeadPane({ verdict: "BAD", reason: "x" }, "UNREACHABLE"),
    ).toBe(false);
  });

  test("OK + READY → false (no nudge needed)", () => {
    expect(
      shouldNudgeLeadPane({ verdict: "OK", reason: "x" }, "READY"),
    ).toBe(false);
  });

  test("STANDBY + READY → false", () => {
    expect(
      shouldNudgeLeadPane({ verdict: "STANDBY", reason: "x" }, "READY"),
    ).toBe(false);
  });
});

describe("shouldIncrementStrike", () => {
  test("BAD increments (regardless of pane signal — classifier-swallow IS a strike)", () => {
    expect(shouldIncrementStrike({ verdict: "BAD", reason: "x" })).toBe(true);
  });

  test("OK does not increment", () => {
    expect(shouldIncrementStrike({ verdict: "OK", reason: "x" })).toBe(false);
  });

  test("STANDBY does not increment", () => {
    expect(shouldIncrementStrike({ verdict: "STANDBY", reason: "x" })).toBe(false);
  });
});

describe("default constants match schema defaults", () => {
  test("DEFAULT_VELOCITY_WINDOW_MIN === 60", () => {
    expect(DEFAULT_VELOCITY_WINDOW_MIN).toBe(60);
  });

  test("DEFAULT_STANDBY_GRACE_MIN === 30", () => {
    expect(DEFAULT_STANDBY_GRACE_MIN).toBe(30);
  });

  test("DEFAULT_STRIKE_THRESHOLD === 3", () => {
    expect(DEFAULT_STRIKE_THRESHOLD).toBe(3);
  });

  test("DEFAULT_STANDBY_GRACE_MIN < DEFAULT_VELOCITY_WINDOW_MIN (grace shorter than window)", () => {
    // ADR-087 §OQ3 — grace should be tighter than window so a fresh
    // post-ship pause isn't suppressed by the window's own buffer.
    expect(DEFAULT_STANDBY_GRACE_MIN).toBeLessThan(DEFAULT_VELOCITY_WINDOW_MIN);
  });
});

describe("PaneSignal type — coverage of every branch", () => {
  // Compile-time coverage assertion + smoke test that every PaneSignal
  // value flows through both helpers.
  const signals: PaneSignal[] = ["READY", "BUSY", "UNREACHABLE"];
  test("every PaneSignal value resolves shouldNudgeLeadPane deterministically", () => {
    for (const s of signals) {
      const r = shouldNudgeLeadPane({ verdict: "BAD", reason: "x" }, s);
      expect(typeof r).toBe("boolean");
    }
  });
});

// Unit tests for src/core/sentinel-escalation.ts (ADR-132 T6
// / t-a6a1c9ab).
//
// Coverage strategy (per task body):
//   - Each EscalationReason has a HIT fixture + a NEAR-MISS
//     fixture. Hit confirms the gate fires; near-miss confirms
//     the gate does NOT over-fire when the signal is just below
//     threshold.
//   - ADR-131 hygiene fingerprint adversarial pin: all 5
//     fingerprint classes (ghost-owner, lane-mismatch,
//     role-mismatch, lane-null-orphan, prio-null) are evaluated
//     against E2; only the two P0 classes (ghost-owner +
//     lane-mismatch) trigger. Documents the intentional narrowing
//     of E2 to `hygiene-blocker-p0` per the T2 EscalationReason
//     enum (which superseded the task body's broader 'hygiene-
//     blocker' name pre-rename).
//   - 100% line coverage on the implementation file.
//   - E6 mandatory-floor proven: even when no other reason fires,
//     last2hr=0 alone triggers escalation.

import { describe, expect, test } from "bun:test";
import type { Observation } from "../../../src/abstractions/sentinel.ts";
import type { PaneClassification } from "../../../src/core/pane-state.ts";
import {
  classify,
  type ObservationHistory,
  shouldEscalate,
} from "../../../src/core/sentinel-escalation.ts";

// ---------- Fixtures ----------

function paneCls(state: PaneClassification["state"] = "READY"): PaneClassification {
  return { state, evidence: "", capturedAt: 0 };
}

/** Healthy baseline observation — every gate evaluates to FALSE.
 *  Tests mutate fields locally to flip one gate at a time, so the
 *  near-miss test for gate X never inadvertently activates gate Y.
 *  `lastTickAt` is fixed at a non-zero ms so `nowMs - pushedAt`
 *  arithmetic in E1 has a stable anchor. */
function healthyObs(overrides: Partial<Observation> = {}): Observation {
  return {
    team: "atmux",
    members: [
      {
        name: "fe-1",
        paneState: paneCls("READY"),
        ctxTokens: 5_000,
        lastEnterPushable: false,
        queuedComposerText: null,
      },
      {
        name: "be-1",
        paneState: paneCls("BUSY"),
        ctxTokens: 12_000,
        lastEnterPushable: false,
        queuedComposerText: null,
      },
    ],
    kanbanDelta: {
      newClaims: [],
      completedSinceLastTick: [],
      wedgedClaims: [],
    },
    // last2hr > 0 so E6 stays silent. Each near-miss test must
    // preserve this unless it explicitly tests the E6 path.
    commitCadence: {
      sinceLastTick: 1,
      last30min: 2,
      last2hr: 5,
    },
    lastTickAt: 1_000_000_000_000, // anchor ms (not real epoch — arithmetic only)
    ...overrides,
  };
}

/** Cold-start history — no prior signals. Every temporal gate
 *  evaluates to FALSE on this history. */
function emptyHistory(): ObservationHistory {
  return {
    enterPushedAt: {},
    lowConfidenceStreak: 0,
    inboxEntries: [],
    pendingGitDenials: [],
  };
}

// ---------- E1: wedged-after-nudge ----------

describe("E1 wedged-after-nudge", () => {
  test("HIT: member with queued text + enter-pushable + enter-push >15min ago", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "claim --next --as fe-1",
        },
      ],
    });
    const history: ObservationHistory = {
      ...emptyHistory(),
      enterPushedAt: { "fe-1": obs.lastTickAt - 16 * 60 * 1000 }, // 16min stale
    };
    expect(classify(obs, history)).toContain("wedged-after-nudge");
  });

  test("NEAR-MISS: enter-push exactly 15min ago (boundary — strict > only)", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "claim --next --as fe-1",
        },
      ],
    });
    const history: ObservationHistory = {
      ...emptyHistory(),
      enterPushedAt: { "fe-1": obs.lastTickAt - 15 * 60 * 1000 }, // EXACTLY 15min
    };
    expect(classify(obs, history)).not.toContain("wedged-after-nudge");
  });

  test("NEAR-MISS: member is enter-pushable + queued text but NO prior enter-push", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "claim --next --as fe-1",
        },
      ],
    });
    expect(classify(obs, emptyHistory())).not.toContain("wedged-after-nudge");
  });

  test("NEAR-MISS: queued text but no longer enter-pushable (modal intercepted)", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("MODAL"),
          ctxTokens: 8_000,
          lastEnterPushable: false,
          queuedComposerText: "claim --next --as fe-1",
        },
      ],
    });
    const history: ObservationHistory = {
      ...emptyHistory(),
      enterPushedAt: { "fe-1": obs.lastTickAt - 60 * 60 * 1000 }, // 1hr stale
    };
    // Not "wedged-after-nudge" — the pane is in MODAL, the wedge
    // class shifted; E1 specifically targets enter-pushable wedges.
    expect(classify(obs, history)).not.toContain("wedged-after-nudge");
  });

  test("NEAR-MISS: queuedComposerText null (nudge took effect, queue drained)", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("READY"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: null,
        },
      ],
    });
    const history: ObservationHistory = {
      ...emptyHistory(),
      enterPushedAt: { "fe-1": obs.lastTickAt - 60 * 60 * 1000 },
    };
    expect(classify(obs, history)).not.toContain("wedged-after-nudge");
  });

  test("dedups when multiple members wedged — single E1 entry", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "x",
        },
        {
          name: "be-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "y",
        },
      ],
    });
    const history: ObservationHistory = {
      ...emptyHistory(),
      enterPushedAt: {
        "fe-1": obs.lastTickAt - 20 * 60 * 1000,
        "be-1": obs.lastTickAt - 20 * 60 * 1000,
      },
    };
    const reasons = classify(obs, history);
    const e1Count = reasons.filter((r) => r === "wedged-after-nudge").length;
    expect(e1Count).toBe(1);
  });
});

// ---------- E2: hygiene-blocker-p0 ----------

describe("E2 hygiene-blocker-p0", () => {
  test("HIT: ghost-owner P0 fingerprint wedged 4h+", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-001", class: "ghost-owner", wedgedMin: 240 }],
      },
    });
    expect(classify(obs, emptyHistory())).toContain("hygiene-blocker-p0");
  });

  test("HIT: lane-mismatch P0 fingerprint wedged 5h+", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-002", class: "lane-mismatch", wedgedMin: 300 }],
      },
    });
    expect(classify(obs, emptyHistory())).toContain("hygiene-blocker-p0");
  });

  test("NEAR-MISS: P0 class but wedgedMin just under 4h gate", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-003", class: "ghost-owner", wedgedMin: 239 }],
      },
    });
    expect(classify(obs, emptyHistory())).not.toContain("hygiene-blocker-p0");
  });

  test("ADR-131 adversarial: role-mismatch (P1) does NOT trigger E2", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-004", class: "role-mismatch", wedgedMin: 600 }],
      },
    });
    expect(classify(obs, emptyHistory())).not.toContain("hygiene-blocker-p0");
  });

  test("ADR-131 adversarial: lane-null-orphan (P3) does NOT trigger E2", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-005", class: "lane-null-orphan", wedgedMin: 600 }],
      },
    });
    expect(classify(obs, emptyHistory())).not.toContain("hygiene-blocker-p0");
  });

  test("ADR-131 adversarial: prio-null (P3) does NOT trigger E2", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-006", class: "prio-null", wedgedMin: 600 }],
      },
    });
    expect(classify(obs, emptyHistory())).not.toContain("hygiene-blocker-p0");
  });

  test("ADR-131 adversarial: ALL 5 fingerprint classes in one tick — only P0 pair fires E2 (single entry)", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [
          { taskId: "t-100", class: "ghost-owner", wedgedMin: 240 },
          { taskId: "t-101", class: "lane-mismatch", wedgedMin: 240 },
          { taskId: "t-102", class: "role-mismatch", wedgedMin: 600 },
          { taskId: "t-103", class: "lane-null-orphan", wedgedMin: 600 },
          { taskId: "t-104", class: "prio-null", wedgedMin: 600 },
        ],
      },
    });
    const reasons = classify(obs, emptyHistory());
    const e2Count = reasons.filter((r) => r === "hygiene-blocker-p0").length;
    expect(e2Count).toBe(1);
  });

  test("boundary: wedgedMin === 240 (inclusive ≥) fires E2", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-007", class: "ghost-owner", wedgedMin: 240 }],
      },
    });
    expect(classify(obs, emptyHistory())).toContain("hygiene-blocker-p0");
  });

  test("unknown fingerprint class never triggers E2 (forward-compat)", () => {
    const obs = healthyObs({
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-008", class: "future-class", wedgedMin: 9999 }],
      },
    });
    expect(classify(obs, emptyHistory())).not.toContain("hygiene-blocker-p0");
  });
});

// ---------- E3: merge-conflict-or-push ----------

describe("E3 merge-conflict-or-push", () => {
  test("HIT: pendingGitDenials non-empty", () => {
    const history: ObservationHistory = {
      ...emptyHistory(),
      pendingGitDenials: [{ member: "fe-1", op: "git push --force-with-lease" }],
    };
    expect(classify(healthyObs(), history)).toContain("merge-conflict-or-push");
  });

  test("NEAR-MISS: pendingGitDenials empty (steady state)", () => {
    expect(classify(healthyObs(), emptyHistory())).not.toContain("merge-conflict-or-push");
  });

  test("dedups when multiple denials — single E3 entry", () => {
    const history: ObservationHistory = {
      ...emptyHistory(),
      pendingGitDenials: [
        { member: "fe-1", op: "git push --force" },
        { member: "be-1", op: "git reset --hard" },
      ],
    };
    const reasons = classify(healthyObs(), history);
    const e3Count = reasons.filter((r) => r === "merge-conflict-or-push").length;
    expect(e3Count).toBe(1);
  });
});

// ---------- E4: inbox-unprocessed ----------

describe("E4 inbox-unprocessed", () => {
  test("HIT: inbox entry tickAge >= 2 (threshold)", () => {
    const history: ObservationHistory = {
      ...emptyHistory(),
      inboxEntries: [{ id: "2026-05-14T10:13", tickAge: 2 }],
    };
    expect(classify(healthyObs(), history)).toContain("inbox-unprocessed");
  });

  test("HIT: multiple inbox entries, one stale — single E4 entry (deduped)", () => {
    const history: ObservationHistory = {
      ...emptyHistory(),
      inboxEntries: [
        { id: "fresh", tickAge: 0 },
        { id: "stale", tickAge: 5 },
      ],
    };
    const reasons = classify(healthyObs(), history);
    const e4Count = reasons.filter((r) => r === "inbox-unprocessed").length;
    expect(e4Count).toBe(1);
  });

  test("NEAR-MISS: all entries tickAge < 2", () => {
    const history: ObservationHistory = {
      ...emptyHistory(),
      inboxEntries: [
        { id: "a", tickAge: 0 },
        { id: "b", tickAge: 1 },
      ],
    };
    expect(classify(healthyObs(), history)).not.toContain("inbox-unprocessed");
  });

  test("NEAR-MISS: empty inboxEntries", () => {
    expect(classify(healthyObs(), emptyHistory())).not.toContain("inbox-unprocessed");
  });
});

// ---------- E5: low-confidence-streak ----------

describe("E5 low-confidence-streak", () => {
  test("HIT: streak === 3 (threshold)", () => {
    const history: ObservationHistory = { ...emptyHistory(), lowConfidenceStreak: 3 };
    expect(classify(healthyObs(), history)).toContain("low-confidence-streak");
  });

  test("HIT: streak >> threshold", () => {
    const history: ObservationHistory = { ...emptyHistory(), lowConfidenceStreak: 99 };
    expect(classify(healthyObs(), history)).toContain("low-confidence-streak");
  });

  test("NEAR-MISS: streak === 2 (just below threshold)", () => {
    const history: ObservationHistory = { ...emptyHistory(), lowConfidenceStreak: 2 };
    expect(classify(healthyObs(), history)).not.toContain("low-confidence-streak");
  });

  test("NEAR-MISS: streak === 0", () => {
    expect(classify(healthyObs(), emptyHistory())).not.toContain("low-confidence-streak");
  });
});

// ---------- E6: ship-zero-2hr (MANDATORY floor) ----------

describe("E6 ship-zero-2hr (mandatory)", () => {
  test("HIT: last2hr === 0", () => {
    const obs = healthyObs({
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 },
    });
    expect(classify(obs, emptyHistory())).toContain("ship-zero-2hr");
  });

  test("NEAR-MISS: last2hr === 1 (one commit in last 2hr — barely shipping)", () => {
    const obs = healthyObs({
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 1 },
    });
    expect(classify(obs, emptyHistory())).not.toContain("ship-zero-2hr");
  });

  test("E6 fires even when every other gate is clean — mandatory floor proof", () => {
    // No member queued-text, no wedges, no git denials, no inbox
    // entries, no low-confidence streak — only last2hr = 0.
    const obs = healthyObs({
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 },
    });
    const reasons = classify(obs, emptyHistory());
    expect(reasons).toEqual(["ship-zero-2hr"]);
    expect(shouldEscalate(reasons)).toBe(true);
  });

  // ADR-148 T5 (t-ac95b267): per-member ship-zero-window verdict
  // fires E6 alongside the team-aggregate `last2hr === 0` path.
  test("HIT (ADR-148 T5): member cadence verdict ship-zero-window fires E6 even with last2hr > 0", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("READY"),
          ctxTokens: 5_000,
          lastEnterPushable: false,
          queuedComposerText: null,
          cadence: {
            windowSec: 1800,
            commitsInWindow: 0,
            lastCommitAt: 1_700_000_000 - 10_000,
            lastCommitSha: "abc1234",
            ageOfLastCommitSec: 10_000,
            verdict: "ship-zero-window",
          },
        },
      ],
      // last2hr > 0 — the team-aggregate gate does NOT fire here;
      // the per-member verdict path is the sole trigger.
      commitCadence: { sinceLastTick: 1, last30min: 2, last2hr: 5 },
    });
    expect(classify(obs, emptyHistory())).toContain("ship-zero-2hr");
  });

  test("NEAR-MISS (ADR-148 T5): member cadence verdict shipping does NOT fire E6", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("READY"),
          ctxTokens: 5_000,
          lastEnterPushable: false,
          queuedComposerText: null,
          cadence: {
            windowSec: 1800,
            commitsInWindow: 3,
            lastCommitAt: 1_700_000_000 - 200,
            lastCommitSha: "def5678",
            ageOfLastCommitSec: 200,
            verdict: "shipping",
          },
        },
      ],
    });
    expect(classify(obs, emptyHistory())).not.toContain("ship-zero-2hr");
  });

  test("NEAR-MISS (ADR-148 T5): member cadence verdict idle does NOT fire E6", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("READY"),
          ctxTokens: 5_000,
          lastEnterPushable: false,
          queuedComposerText: null,
          cadence: {
            windowSec: 1800,
            commitsInWindow: 0,
            lastCommitAt: 1_700_000_000 - 5000,
            lastCommitSha: "ghi9abc",
            ageOfLastCommitSec: 5000,
            verdict: "idle",
          },
        },
      ],
    });
    expect(classify(obs, emptyHistory())).not.toContain("ship-zero-2hr");
  });

  test("HIT (ADR-148 T5): mixed roster — one member ship-zero-window, others shipping → E6 fires", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("READY"),
          ctxTokens: 5_000,
          lastEnterPushable: false,
          queuedComposerText: null,
          cadence: {
            windowSec: 1800,
            commitsInWindow: 3,
            lastCommitAt: 1_700_000_000 - 200,
            lastCommitSha: "abcd123",
            ageOfLastCommitSec: 200,
            verdict: "shipping",
          },
        },
        {
          name: "be-1",
          paneState: paneCls("READY"),
          ctxTokens: 8_000,
          lastEnterPushable: false,
          queuedComposerText: null,
          cadence: {
            windowSec: 1800,
            commitsInWindow: 0,
            lastCommitAt: 1_700_000_000 - 9000,
            lastCommitSha: "efef456",
            ageOfLastCommitSec: 9000,
            verdict: "ship-zero-window",
          },
        },
      ],
      // last2hr still > 0 — proves the per-member path is the
      // only trigger.
      commitCadence: { sinceLastTick: 1, last30min: 2, last2hr: 5 },
    });
    expect(classify(obs, emptyHistory())).toContain("ship-zero-2hr");
  });

  test("ADR-148 T5: ship-zero-2hr reason appears EXACTLY ONCE even when both paths fire", () => {
    // Belt-and-braces: when team-aggregate last2hr === 0 AND a member
    // also has ship-zero-window verdict, the reason still appears
    // once (the `else if` short-circuits the second path).
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("READY"),
          ctxTokens: 5_000,
          lastEnterPushable: false,
          queuedComposerText: null,
          cadence: {
            windowSec: 1800,
            commitsInWindow: 0,
            lastCommitAt: 1_700_000_000 - 10_000,
            lastCommitSha: "abc1234",
            ageOfLastCommitSec: 10_000,
            verdict: "ship-zero-window",
          },
        },
      ],
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 },
    });
    const reasons = classify(obs, emptyHistory());
    const shipZeroCount = reasons.filter((r) => r === "ship-zero-2hr").length;
    expect(shipZeroCount).toBe(1);
  });
});

// ---------- Aggregate / interaction ----------

describe("classify() composition", () => {
  test("multi-gate fire: E1 + E2 + E6 all present in healthy-aside scenario", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "claim --next --as fe-1",
        },
      ],
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-009", class: "ghost-owner", wedgedMin: 400 }],
      },
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 },
    });
    const history: ObservationHistory = {
      ...emptyHistory(),
      enterPushedAt: { "fe-1": obs.lastTickAt - 20 * 60 * 1000 },
    };
    const reasons = classify(obs, history);
    expect(reasons).toContain("wedged-after-nudge");
    expect(reasons).toContain("hygiene-blocker-p0");
    expect(reasons).toContain("ship-zero-2hr");
  });

  test("order is E1→E6 for log readability", () => {
    const obs = healthyObs({
      members: [
        {
          name: "fe-1",
          paneState: paneCls("TYPING"),
          ctxTokens: 8_000,
          lastEnterPushable: true,
          queuedComposerText: "x",
        },
      ],
      kanbanDelta: {
        newClaims: [],
        completedSinceLastTick: [],
        wedgedClaims: [{ taskId: "t-010", class: "lane-mismatch", wedgedMin: 240 }],
      },
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 },
    });
    const history: ObservationHistory = {
      enterPushedAt: { "fe-1": obs.lastTickAt - 20 * 60 * 1000 },
      lowConfidenceStreak: 3,
      inboxEntries: [{ id: "stale", tickAge: 4 }],
      pendingGitDenials: [{ member: "fe-1", op: "push --force" }],
    };
    const reasons = classify(obs, history);
    // Expected canonical order — sorted by §D5 numbering.
    expect(reasons).toEqual([
      "wedged-after-nudge",
      "hygiene-blocker-p0",
      "merge-conflict-or-push",
      "inbox-unprocessed",
      "low-confidence-streak",
      "ship-zero-2hr",
    ]);
  });

  test("steady-state: all gates silent → empty reasons array", () => {
    expect(classify(healthyObs(), emptyHistory())).toEqual([]);
  });
});

// ---------- shouldEscalate ----------

describe("shouldEscalate()", () => {
  test("empty array → false", () => {
    expect(shouldEscalate([])).toBe(false);
  });

  test("single-reason array → true (any §D5 trigger)", () => {
    expect(shouldEscalate(["ship-zero-2hr"])).toBe(true);
    expect(shouldEscalate(["wedged-after-nudge"])).toBe(true);
    expect(shouldEscalate(["hygiene-blocker-p0"])).toBe(true);
    expect(shouldEscalate(["merge-conflict-or-push"])).toBe(true);
    expect(shouldEscalate(["inbox-unprocessed"])).toBe(true);
    expect(shouldEscalate(["low-confidence-streak"])).toBe(true);
  });

  test("multi-reason array → true", () => {
    expect(shouldEscalate(["ship-zero-2hr", "wedged-after-nudge"])).toBe(true);
  });

  test("ReadonlyArray input accepted (immutable callers)", () => {
    const reasons: ReadonlyArray<"ship-zero-2hr"> = ["ship-zero-2hr"];
    expect(shouldEscalate(reasons)).toBe(true);
  });
});

// ---------- E6 unconditional / over-escalation posture ----------

describe("E6 unconditional floor — over-escalation is OK, under-escalation is the failure mode", () => {
  test("non-Claude impl cannot suppress E6 — classifier is single source of truth", () => {
    // Simulates the dispatcher receiving an Observation where the
    // commit cadence is 0/2hr. The classifier MUST fire E6 with
    // zero dependence on impl judgment. This is the "ship-zero
    // overnight = Reddit receipts" gate.
    const obs = healthyObs({
      // Even with otherwise-healthy fields (queues clean, no
      // wedges, no inbox entries) the cadence-zero alone fires.
      commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 },
    });
    const reasons = classify(obs, emptyHistory());
    expect(shouldEscalate(reasons)).toBe(true);
    expect(reasons).toContain("ship-zero-2hr");
  });
});

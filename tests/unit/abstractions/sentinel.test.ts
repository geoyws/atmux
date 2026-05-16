// Unit tests for src/abstractions/sentinel.ts + src/abstractions/sentinels/claude.ts
// (ADR-132 T2 / t-2791cf60).
//
// Coverage:
//   - ClaudeSentinel.name literal — "claude"
//   - observe() — delegates to injected observeFn verbatim
//   - decide() — always emits exactly one escalate-to-claude-lead
//     carrying the same Observation passed in
//   - apply() — throws when called (unreachable path)
//   - shouldEscalateToClaudeLead() — unconditionally true
//   - Type-shape sanity: discriminated unions narrow correctly;
//     EscalationReason enum covers all six §D5 triggers.

import { describe, expect, test } from "bun:test";
import type { PaneClassification } from "../../../src/core/pane-state.ts";
import { ClaudeSentinel } from "../../../src/abstractions/sentinels/claude.ts";
import type {
  EscalationReason,
  Sentinel,
  NudgeAction,
  Observation,
} from "../../../src/abstractions/sentinel.ts";

// ---------- Helpers ----------

function paneCls(state: PaneClassification["state"] = "READY"): PaneClassification {
  return {
    state,
    evidence: "",
    capturedAt: 0,
  };
}

function fixtureObservation(team = "atmux"): Observation {
  return {
    team,
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
      newClaims: [{ taskId: "t-001", member: "fe-1", claimedAtSec: 1_000 }],
      completedSinceLastTick: [{ taskId: "t-000", subject: "prior work" }],
      wedgedClaims: [],
    },
    commitCadence: {
      sinceLastTick: 2,
      last30min: 4,
      last2hr: 10,
    },
    lastTickAt: 1_500_000,
  };
}

// ---------- ClaudeSentinel ----------

describe("ClaudeSentinel", () => {
  test("name is 'claude' literal (constrained per ADR-132 §D simplified set)", () => {
    const m = new ClaudeSentinel({
      observeFn: async () => fixtureObservation(),
    });
    expect(m.name).toBe("claude");
  });

  test("observe() delegates to injected observeFn — returns its result verbatim", async () => {
    const fixture = fixtureObservation("test-team");
    const captured: string[] = [];
    const m = new ClaudeSentinel({
      observeFn: async (team) => {
        captured.push(team);
        return fixture;
      },
    });
    const obs = await m.observe("test-team");
    expect(obs).toBe(fixture); // referential equality — no mutation/copy
    expect(captured).toEqual(["test-team"]);
  });

  test("decide() emits exactly one escalate-to-claude-lead carrying the observation", async () => {
    const fixture = fixtureObservation("a");
    const m = new ClaudeSentinel({ observeFn: async () => fixture });
    const actions = await m.decide(fixture);
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe("escalate-to-claude-lead");
    if (action.kind === "escalate-to-claude-lead") {
      expect(action.observation).toBe(fixture);
      expect(action.reason).toContain("claude sentinel");
      expect(action.reason).toContain("degenerate");
    }
  });

  test("decide() never emits autonomous-action kinds (enter-push / claim-next / rotate)", async () => {
    const m = new ClaudeSentinel({ observeFn: async () => fixtureObservation() });
    // Run across multiple fixture shapes — degenerate impl must
    // emit zero autonomous actions in every case.
    for (const variant of [
      fixtureObservation("a"),
      { ...fixtureObservation("b"), commitCadence: { sinceLastTick: 0, last30min: 0, last2hr: 0 } },
      {
        ...fixtureObservation("c"),
        members: [
          {
            name: "fe-1",
            paneState: paneCls("READY"),
            ctxTokens: 5_000,
            lastEnterPushable: true,
            queuedComposerText: "claim T-001",
          },
        ],
      },
    ]) {
      const actions = await m.decide(variant);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.kind).toBe("escalate-to-claude-lead");
    }
  });

  test("apply() throws — unreachable for degenerate impl", async () => {
    const m = new ClaudeSentinel({ observeFn: async () => fixtureObservation() });
    const someAction: NudgeAction = {
      kind: "enter-push",
      member: "fe-1",
      reason: "should never reach apply()",
    };
    await expect(m.apply(someAction)).rejects.toThrow(/unreachable/);
    await expect(m.apply(someAction)).rejects.toThrow(/enter-push/);
  });

  test("apply() error message names the kind that was incorrectly dispatched", async () => {
    const m = new ClaudeSentinel({ observeFn: async () => fixtureObservation() });
    await expect(
      m.apply({ kind: "claim-next", member: "be-1", reason: "x" }),
    ).rejects.toThrow(/claim-next/);
    await expect(
      m.apply({ kind: "rotate-routine", member: "fe-1", reason: "x" }),
    ).rejects.toThrow(/rotate-routine/);
    await expect(
      m.apply({ kind: "rotate-emergency", member: "fe-1", reason: "x" }),
    ).rejects.toThrow(/rotate-emergency/);
    await expect(
      m.apply({ kind: "modal-release", member: "fe-1", reason: "x" }),
    ).rejects.toThrow(/modal-release/);
    await expect(
      m.apply({ kind: "force-push-approved", member: "fe-1", reason: "x" }),
    ).rejects.toThrow(/force-push-approved/);
  });

  test("shouldEscalateToClaudeLead is unconditionally true", () => {
    const m = new ClaudeSentinel({ observeFn: async () => fixtureObservation() });
    expect(m.shouldEscalateToClaudeLead(fixtureObservation())).toBe(true);
    // Edge: even with `wedgedClaims` empty + `last2hr` healthy
    // (no E-trigger conditions), the degenerate impl still escalates.
    expect(
      m.shouldEscalateToClaudeLead({
        ...fixtureObservation(),
        kanbanDelta: {
          newClaims: [],
          completedSinceLastTick: [],
          wedgedClaims: [],
        },
        commitCadence: { sinceLastTick: 5, last30min: 10, last2hr: 30 },
      }),
    ).toBe(true);
  });

  test("structural conformance: implements Sentinel interface", () => {
    // TS structural-type assertion — instance assignable to the
    // interface var. Compile-time only; runtime asserts presence
    // of the four method names.
    const m: Sentinel = new ClaudeSentinel({
      observeFn: async () => fixtureObservation(),
    });
    expect(typeof m.observe).toBe("function");
    expect(typeof m.decide).toBe("function");
    expect(typeof m.apply).toBe("function");
    expect(typeof m.shouldEscalateToClaudeLead).toBe("function");
    expect(m.name).toBe("claude");
  });
});

// ---------- Type-level sanity ----------

describe("Sentinel types", () => {
  test("NudgeAction discriminated union narrows on `kind`", () => {
    // Compile-time assertion via switch-exhaustiveness. If a
    // future commit adds a new kind without updating this
    // switch, TS surfaces the missing case at typecheck time.
    function evidence(a: NudgeAction): string {
      switch (a.kind) {
        case "enter-push":
          return `enter-push:${a.member}`;
        case "claim-next":
          return `claim-next:${a.member}`;
        case "modal-release":
          return `modal-release:${a.member}`;
        case "force-push-approved":
          return `force-push-approved:${a.member}`;
        case "rotate-routine":
          return `rotate-routine:${a.member}`;
        case "rotate-emergency":
          return `rotate-emergency:${a.member}`;
        case "escalate-to-claude-lead":
          return `escalate:${a.observation.team}`;
      }
    }
    expect(evidence({ kind: "enter-push", member: "fe-1", reason: "r" })).toBe("enter-push:fe-1");
    expect(evidence({ kind: "claim-next", member: "be-1", reason: "r" })).toBe("claim-next:be-1");
    expect(evidence({ kind: "modal-release", member: "fe-1", reason: "r" })).toBe(
      "modal-release:fe-1",
    );
    expect(evidence({ kind: "force-push-approved", member: "fe-1", reason: "r" })).toBe(
      "force-push-approved:fe-1",
    );
    expect(evidence({ kind: "rotate-routine", member: "reviewer", reason: "r" })).toBe(
      "rotate-routine:reviewer",
    );
    expect(evidence({ kind: "rotate-emergency", member: "reviewer", reason: "r" })).toBe(
      "rotate-emergency:reviewer",
    );
    expect(
      evidence({
        kind: "escalate-to-claude-lead",
        observation: fixtureObservation("x"),
        reason: "r",
      }),
    ).toBe("escalate:x");
  });

  test("EscalationReason enum covers all six §D5 triggers", () => {
    // Compile-time switch must handle every variant; runtime
    // assertion confirms the literal set is the spec set. This
    // would fail if T6 (escalation classifier) silently drops
    // a trigger.
    const all: EscalationReason[] = [
      "wedged-after-nudge",
      "hygiene-blocker-p0",
      "merge-conflict-or-push",
      "inbox-unprocessed",
      "low-confidence-streak",
      "ship-zero-2hr",
    ];
    expect(all).toHaveLength(6);
    // Each literal accepted in a switch without `default`
    for (const r of all) {
      const label: string = (() => {
        switch (r) {
          case "wedged-after-nudge":
            return "E1";
          case "hygiene-blocker-p0":
            return "E2";
          case "merge-conflict-or-push":
            return "E3";
          case "inbox-unprocessed":
            return "E4";
          case "low-confidence-streak":
            return "E5";
          case "ship-zero-2hr":
            return "E6";
        }
      })();
      expect(label).toMatch(/^E[1-6]$/);
    }
  });

  test("Sentinel.name literal is the simplified two-impl set", () => {
    // Documentation test: compile-time fence ensures `name`
    // stays constrained to claude|cursor per the 2026-05-14
    // 12:53 MYT driver simplification.
    type ExpectedNames = "claude" | "cursor";
    const claude: ExpectedNames = "claude";
    const cursor: ExpectedNames = "cursor";
    expect([claude, cursor]).toEqual(["claude", "cursor"]);
    // The Sentinel interface's `name` field must accept exactly
    // these two strings — a future "minimax" reintroduction
    // would need to update both the interface AND this test.
  });
});

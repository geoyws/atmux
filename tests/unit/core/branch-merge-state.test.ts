// Unit tests for src/core/branch-merge-state.ts — pure state machine
// per ADR-091 + ADR-134 shared module. 100% branch coverage on the
// pure transition function + every adjacency edge in the state graph.

import { describe, expect, test } from "bun:test";
import {
  BRANCH_MERGE_STATES,
  type BranchMergeState,
  canEnterMerging,
  isTerminalState,
  isValidTransition,
  type PreMergeGateInput,
  shouldTransitionFromInProgress,
  shouldTransitionToReady,
  TERMINAL_STATES,
  TEST_OUTCOMES,
  type TestOutcome,
} from "../../../src/core/branch-merge-state.ts";

// ---------- enum shape ----------

describe("BRANCH_MERGE_STATES", () => {
  test("contains exactly 10 states per ADR-134 §state-machine", () => {
    expect(BRANCH_MERGE_STATES).toHaveLength(10);
  });
  test("contains every named state literal", () => {
    const expected: ReadonlyArray<BranchMergeState> = [
      "open",
      "in_progress",
      "ready_to_merge",
      "rebasing",
      "merging",
      "tested",
      "merged",
      "conflict",
      "test_failed",
      "reverted",
    ];
    for (const s of expected) expect(BRANCH_MERGE_STATES).toContain(s);
  });
  test("preserves declaration order (event-driven cascade order)", () => {
    // Caller code (state.db migrations, debug-log renderers) may
    // rely on declaration order for sort stability — pin it.
    expect(BRANCH_MERGE_STATES[0]).toBe("open");
    expect(BRANCH_MERGE_STATES[1]).toBe("in_progress");
    expect(BRANCH_MERGE_STATES[2]).toBe("ready_to_merge");
    expect(BRANCH_MERGE_STATES[BRANCH_MERGE_STATES.length - 1]).toBe("reverted");
  });
});

// ---------- terminal classification ----------

describe("TERMINAL_STATES + isTerminalState", () => {
  test("merged is terminal", () => {
    expect(TERMINAL_STATES.has("merged")).toBe(true);
    expect(isTerminalState("merged")).toBe(true);
  });
  test("conflict is terminal", () => {
    expect(isTerminalState("conflict")).toBe(true);
  });
  test("reverted is terminal", () => {
    expect(isTerminalState("reverted")).toBe(true);
  });
  test("test_failed is NOT terminal — transitions to reverted OR in_progress", () => {
    expect(isTerminalState("test_failed")).toBe(false);
  });
  test("intermediate states are not terminal", () => {
    const intermediates: ReadonlyArray<BranchMergeState> = [
      "open",
      "in_progress",
      "ready_to_merge",
      "rebasing",
      "merging",
      "tested",
    ];
    for (const s of intermediates) {
      expect(isTerminalState(s)).toBe(false);
    }
  });
});

// ---------- pure pre-merge readiness gate ----------

describe("shouldTransitionFromInProgress — decision tree", () => {
  const allClean: PreMergeGateInput = {
    ownerOpenTaskCount: 0,
    worktreeIsClean: true,
    isAheadOfBase: true,
    baseHasMoved: false,
  };

  test("all gates pass → ready_to_merge with positive reason", () => {
    const d = shouldTransitionFromInProgress(allClean);
    expect(d.next).toBe("ready_to_merge");
    expect(d.reason).toContain("ready to merge");
  });

  test("base moved → rebasing (preempts ready_to_merge)", () => {
    const d = shouldTransitionFromInProgress({ ...allClean, baseHasMoved: true });
    expect(d.next).toBe("rebasing");
    expect(d.reason).toContain("base moved");
  });

  test("owner has 1 open task → stay in_progress, singular reason", () => {
    const d = shouldTransitionFromInProgress({ ...allClean, ownerOpenTaskCount: 1 });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("1 open task ");
    // Singular grammar matters — operators read the reason field.
    expect(d.reason).not.toContain("tasks");
  });

  test("owner has 5 open tasks → stay in_progress, plural reason", () => {
    const d = shouldTransitionFromInProgress({ ...allClean, ownerOpenTaskCount: 5 });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("5 open tasks");
  });

  test("worktree dirty → stay in_progress", () => {
    const d = shouldTransitionFromInProgress({ ...allClean, worktreeIsClean: false });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("worktree dirty");
  });

  test("branch not ahead of base → stay in_progress", () => {
    const d = shouldTransitionFromInProgress({ ...allClean, isAheadOfBase: false });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("not ahead");
  });

  test("blocker priority — owner-tasks dominates worktree-dirty + not-ahead + base-moved", () => {
    const d = shouldTransitionFromInProgress({
      ownerOpenTaskCount: 2,
      worktreeIsClean: false,
      isAheadOfBase: false,
      baseHasMoved: true,
    });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("2 open tasks");
    // None of the lower-priority reasons should leak.
    expect(d.reason).not.toContain("dirty");
    expect(d.reason).not.toContain("not ahead");
    expect(d.reason).not.toContain("base moved");
  });

  test("blocker priority — worktree-dirty dominates not-ahead + base-moved", () => {
    const d = shouldTransitionFromInProgress({
      ownerOpenTaskCount: 0,
      worktreeIsClean: false,
      isAheadOfBase: false,
      baseHasMoved: true,
    });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("dirty");
    expect(d.reason).not.toContain("not ahead");
    expect(d.reason).not.toContain("base moved");
  });

  test("blocker priority — not-ahead dominates base-moved", () => {
    const d = shouldTransitionFromInProgress({
      ownerOpenTaskCount: 0,
      worktreeIsClean: true,
      isAheadOfBase: false,
      baseHasMoved: true,
    });
    expect(d.next).toBe("in_progress");
    expect(d.reason).toContain("not ahead");
    expect(d.reason).not.toContain("base moved");
  });

  test("pure — same input yields same output (no Date.now() / no mutation)", () => {
    const input: PreMergeGateInput = {
      ownerOpenTaskCount: 0,
      worktreeIsClean: true,
      isAheadOfBase: true,
      baseHasMoved: false,
    };
    const a = shouldTransitionFromInProgress(input);
    const b = shouldTransitionFromInProgress(input);
    expect(a).toEqual(b);
  });
});

describe("shouldTransitionToReady — boolean convenience", () => {
  test("returns true when all gates pass", () => {
    expect(
      shouldTransitionToReady({
        ownerOpenTaskCount: 0,
        worktreeIsClean: true,
        isAheadOfBase: true,
        baseHasMoved: false,
      }),
    ).toBe(true);
  });
  test("returns false when base moved (routes to rebasing)", () => {
    expect(
      shouldTransitionToReady({
        ownerOpenTaskCount: 0,
        worktreeIsClean: true,
        isAheadOfBase: true,
        baseHasMoved: true,
      }),
    ).toBe(false);
  });
  test("returns false when owner has open tasks", () => {
    expect(
      shouldTransitionToReady({
        ownerOpenTaskCount: 1,
        worktreeIsClean: true,
        isAheadOfBase: true,
        baseHasMoved: false,
      }),
    ).toBe(false);
  });
  test("returns false when worktree dirty", () => {
    expect(
      shouldTransitionToReady({
        ownerOpenTaskCount: 0,
        worktreeIsClean: false,
        isAheadOfBase: true,
        baseHasMoved: false,
      }),
    ).toBe(false);
  });
  test("returns false when branch not ahead", () => {
    expect(
      shouldTransitionToReady({
        ownerOpenTaskCount: 0,
        worktreeIsClean: true,
        isAheadOfBase: false,
        baseHasMoved: false,
      }),
    ).toBe(false);
  });
});

// ---------- state graph adjacency ----------

describe("isValidTransition — adjacency matrix", () => {
  // ---------- accepted forward transitions per ADR-134 §state-machine

  test("open → in_progress (task-done event)", () => {
    expect(isValidTransition("open", "in_progress")).toBe(true);
  });

  test("in_progress → ready_to_merge (gate passed)", () => {
    expect(isValidTransition("in_progress", "ready_to_merge")).toBe(true);
  });

  test("in_progress → in_progress (gate failed, cron re-tick self-loop)", () => {
    expect(isValidTransition("in_progress", "in_progress")).toBe(true);
  });

  test("ready_to_merge → rebasing (base moved during work)", () => {
    expect(isValidTransition("ready_to_merge", "rebasing")).toBe(true);
  });

  test("ready_to_merge → merging (base stable)", () => {
    expect(isValidTransition("ready_to_merge", "merging")).toBe(true);
  });

  test("rebasing → ready_to_merge (clean rebase)", () => {
    expect(isValidTransition("rebasing", "ready_to_merge")).toBe(true);
  });

  test("rebasing → conflict (rebase hit conflict)", () => {
    expect(isValidTransition("rebasing", "conflict")).toBe(true);
  });

  test("merging → tested (ADR-134 — merge clean, run testCommand post-merge)", () => {
    expect(isValidTransition("merging", "tested")).toBe(true);
  });

  test("merging → conflict (merge hit conflict)", () => {
    expect(isValidTransition("merging", "conflict")).toBe(true);
  });

  test("merging → merged (ADR-091 v1 + ADR-144 — direct terminal after merge)", () => {
    // ADR-091 v1 epic-team flow skips the post-merge `tested` step
    // (reviewer-trunk-signoff Task absorbs the gate) and ADR-144's
    // pre-merge gate path also lands on `merging → merged` after
    // the merge step itself completes.
    expect(isValidTransition("merging", "merged")).toBe(true);
  });

  test("tested → merged (ADR-134 — testCommand passed post-merge)", () => {
    expect(isValidTransition("tested", "merged")).toBe(true);
  });

  test("tested → test_failed (testCommand failed)", () => {
    expect(isValidTransition("tested", "test_failed")).toBe(true);
  });

  test("tested → merging (ADR-144 — pre-merge tests passed, proceed to actual merge)", () => {
    // ADR-144 §Decision T2: epic-team scope tests BEFORE the merge.
    // After tests pass, transition tested → merging so the git
    // merge --no-ff step fires next. Gated by canEnterMerging on the
    // row's test_outcome — the state machine's adjacency map allows
    // the edge unconditionally; the gate refusal lives at the caller.
    expect(isValidTransition("tested", "merging")).toBe(true);
  });

  test("test_failed → reverted (revertOnFail: true path)", () => {
    expect(isValidTransition("test_failed", "reverted")).toBe(true);
  });

  test("test_failed → in_progress (revertOnFail: false + operator recovery / ADR-144 §test_failed recovery)", () => {
    expect(isValidTransition("test_failed", "in_progress")).toBe(true);
  });

  test("ready_to_merge → tested (ADR-144 — pre-merge test-gate entry)", () => {
    // ADR-144 §Decision T2: the epic-team scope runs tests BEFORE
    // merging so a failing test never lands on parent-trunk.
    expect(isValidTransition("ready_to_merge", "tested")).toBe(true);
  });

  // ---------- accepted backward / recovery transitions

  test("conflict → in_progress (operator manual reset after resolution)", () => {
    expect(isValidTransition("conflict", "in_progress")).toBe(true);
  });

  test("reverted → in_progress (operator manual reset after fix)", () => {
    expect(isValidTransition("reverted", "in_progress")).toBe(true);
  });

  test("merged → open (ADR-134 amendment recovery after new commits land)", () => {
    expect(isValidTransition("merged", "open")).toBe(true);
  });

  // ---------- forbidden transitions (sample of representative edges)

  test("open → merged FORBIDDEN (cannot skip the machine)", () => {
    expect(isValidTransition("open", "merged")).toBe(false);
  });

  test("open → ready_to_merge FORBIDDEN (must pass through in_progress)", () => {
    expect(isValidTransition("open", "ready_to_merge")).toBe(false);
  });

  test("in_progress → merging FORBIDDEN (must pass through ready_to_merge)", () => {
    expect(isValidTransition("in_progress", "merging")).toBe(false);
  });

  test("merged → in_progress FORBIDDEN (next cycle starts from fresh `open`)", () => {
    expect(isValidTransition("merged", "in_progress")).toBe(false);
  });

  test("merged → conflict FORBIDDEN", () => {
    expect(isValidTransition("merged", "conflict")).toBe(false);
  });

  test("conflict → merged FORBIDDEN (must reset through in_progress + re-run)", () => {
    expect(isValidTransition("conflict", "merged")).toBe(false);
  });

  test("conflict → reverted FORBIDDEN (different failure class)", () => {
    expect(isValidTransition("conflict", "reverted")).toBe(false);
  });

  test("reverted → merged FORBIDDEN (must reset through in_progress)", () => {
    expect(isValidTransition("reverted", "merged")).toBe(false);
  });

  test("rebasing → merging FORBIDDEN (must pass back through ready_to_merge)", () => {
    expect(isValidTransition("rebasing", "merging")).toBe(false);
  });

  test("test_failed → merged FORBIDDEN (must reset)", () => {
    expect(isValidTransition("test_failed", "merged")).toBe(false);
  });
});

// ---------- TEST_OUTCOMES enum (ADR-144 T2) ----------

describe("TEST_OUTCOMES", () => {
  test("contains exactly 3 outcomes — pass / fail / bypass", () => {
    expect(TEST_OUTCOMES).toHaveLength(3);
    const expected: ReadonlyArray<TestOutcome> = ["pass", "fail", "bypass"];
    for (const o of expected) expect(TEST_OUTCOMES).toContain(o);
  });

  test("preserves declaration order — pass first (most common gate-pass result)", () => {
    expect(TEST_OUTCOMES[0]).toBe("pass");
    expect(TEST_OUTCOMES[1]).toBe("fail");
    expect(TEST_OUTCOMES[2]).toBe("bypass");
  });
});

// ---------- canEnterMerging — ADR-144 §Decision test-gate ----------

describe("canEnterMerging — test-gate guard", () => {
  test("non-merging targets always allowed (gate doesn't apply)", () => {
    // No matter what the source state or outcome is, transitions to
    // anything other than `merging` skip the gate entirely.
    expect(canEnterMerging("ready_to_merge", "rebasing", null)).toBe(true);
    expect(canEnterMerging("tested", "merged", null)).toBe(true);
    expect(canEnterMerging("tested", "test_failed", "fail")).toBe(true);
    expect(canEnterMerging("merging", "merged", null)).toBe(true);
    expect(canEnterMerging("conflict", "in_progress", "fail")).toBe(true);
  });

  test("ADR-134 path — ready_to_merge → merging skips the gate (test happens post-merge)", () => {
    // Intra-team scope: tests run AFTER merging, so the gate doesn't
    // apply to the entry-into-merging edge. testOutcome stays null on
    // ADR-134 rows; this confirms the gate doesn't reject them.
    expect(canEnterMerging("ready_to_merge", "merging", null)).toBe(true);
    expect(canEnterMerging("ready_to_merge", "merging", "pass")).toBe(true);
  });

  test("ADR-144 path — tested → merging requires outcome = 'pass'", () => {
    expect(canEnterMerging("tested", "merging", "pass")).toBe(true);
  });

  test("ADR-144 path — tested → merging accepts outcome = 'bypass' (driver override)", () => {
    expect(canEnterMerging("tested", "merging", "bypass")).toBe(true);
  });

  test("ADR-144 path — tested → merging REFUSED on outcome = 'fail'", () => {
    expect(canEnterMerging("tested", "merging", "fail")).toBe(false);
  });

  test("ADR-144 path — tested → merging REFUSED on null outcome (no test recorded)", () => {
    // Caller is expected to record an outcome (pass/fail/bypass) at
    // the ready_to_merge → tested transition. Null means "test never
    // ran" — refuse the merge by default.
    expect(canEnterMerging("tested", "merging", null)).toBe(false);
  });

  test("pure — same inputs yield same output (no I/O, no clock)", () => {
    const a = canEnterMerging("tested", "merging", "pass");
    const b = canEnterMerging("tested", "merging", "pass");
    expect(a).toEqual(b);
  });
});

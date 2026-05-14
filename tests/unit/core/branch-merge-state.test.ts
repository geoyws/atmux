// Unit tests for src/core/branch-merge-state.ts — pure state machine
// per ADR-091 + ADR-134 shared module. 100% branch coverage on the
// pure transition function + every adjacency edge in the state graph.

import { describe, expect, test } from "bun:test";
import {
  BRANCH_MERGE_STATES,
  type BranchMergeState,
  isTerminalState,
  isValidTransition,
  type PreMergeGateInput,
  shouldTransitionFromInProgress,
  shouldTransitionToReady,
  TERMINAL_STATES,
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

  test("merging → tested (merge clean, run testCommand)", () => {
    expect(isValidTransition("merging", "tested")).toBe(true);
  });

  test("merging → conflict (merge hit conflict)", () => {
    expect(isValidTransition("merging", "conflict")).toBe(true);
  });

  test("tested → merged (testCommand passed)", () => {
    expect(isValidTransition("tested", "merged")).toBe(true);
  });

  test("tested → test_failed (testCommand failed)", () => {
    expect(isValidTransition("tested", "test_failed")).toBe(true);
  });

  test("test_failed → reverted (revertOnFail: true path)", () => {
    expect(isValidTransition("test_failed", "reverted")).toBe(true);
  });

  test("test_failed → in_progress (revertOnFail: false + operator recovery)", () => {
    expect(isValidTransition("test_failed", "in_progress")).toBe(true);
  });

  // ---------- accepted backward / recovery transitions

  test("conflict → in_progress (operator manual reset after resolution)", () => {
    expect(isValidTransition("conflict", "in_progress")).toBe(true);
  });

  test("reverted → in_progress (operator manual reset after fix)", () => {
    expect(isValidTransition("reverted", "in_progress")).toBe(true);
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

  test("ready_to_merge → tested FORBIDDEN (must pass through merging)", () => {
    expect(isValidTransition("ready_to_merge", "tested")).toBe(false);
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

  test("tested → merging FORBIDDEN (no backwards edge)", () => {
    expect(isValidTransition("tested", "merging")).toBe(false);
  });

  test("test_failed → merged FORBIDDEN (must reset)", () => {
    expect(isValidTransition("test_failed", "merged")).toBe(false);
  });
});

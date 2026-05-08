// Unit tests for src/core/lane-drift.ts (ADR-062 §Decision (5) + §OQ5).
//
// Two surfaces under test:
//   - `checkLaneDrift` — pure helper that emits per-task decisions
//     across the 8 (a/b/c) combinations. Only AAA → "revert"; any
//     single criterion false → "skip" with a reason.
//   - `formatFlagBody` + `formatDurationCompact` — pure rendering
//     helpers; assert format-shape against the ADR-062 §OQ5
//     prescription + the CLAUDE.md duration convention.
//
// Verb-side --dry-run vs --reset behavior + flag-write integration
// are covered in tests/unit/verbs/lane-drift-check.test.ts.

import { describe, expect, test } from "bun:test";
import {
  checkLaneDrift,
  type DriftDecision,
  formatDurationCompact,
  formatFlagBody,
} from "../../../src/core/lane-drift.ts";
import type { PaneClassification } from "../../../src/core/pane-state.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";

// ---------- Fixture builders ----------

const NOW_SEC = 1_700_000_000;
const THRESHOLD_MIN = 30;

/** A claim aged "claimedAgoMin" minutes ago. Use values like 10
 *  (criterion-a false) and 60 (criterion-a true). */
function task(opts: {
  id: string;
  owner: string;
  claimedAgoMin: number;
}): KanbanTask {
  return {
    id: opts.id,
    owner: opts.owner,
    status: "in-progress",
    claimedAt: NOW_SEC - opts.claimedAgoMin * 60,
  };
}

function paneReady(): PaneClassification {
  return { state: "READY", evidence: ">", capturedAt: NOW_SEC * 1000 };
}

function paneCompacting(): PaneClassification {
  return {
    state: "COMPACTING",
    evidence: "Compacting conversation",
    capturedAt: NOW_SEC * 1000,
  };
}

function paneRateLimit(): PaneClassification {
  return { state: "RATE-LIMIT", evidence: "hit your limit", capturedAt: NOW_SEC * 1000 };
}

function fixedClassify(
  byMember: Record<string, PaneClassification | null>,
): (m: string) => Promise<PaneClassification | null> {
  return async (m: string) => byMember[m] ?? null;
}

// ---------- 8-combination matrix ----------

describe("checkLaneDrift — (a/b/c) combination matrix", () => {
  // Naming: a/b/c are 0 or 1. 1 = criterion satisfied (drift evidence).
  // Only 1/1/1 reverts.
  // a=1: claimedAt > 30min ago (use 60min)
  // a=0: claimedAt ≤ 30min ago (use 10min)
  // b=1: pane non-READY (COMPACTING)
  // b=0: pane READY
  // c=1: no commit ref (recentCommitsText doesn't include the id)
  // c=0: commit ref present (recentCommitsText DOES include id)

  test("000 (a=0,b=0,c=0): claimed-recently + READY + commit ref → skip:claimed-recently", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 10 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneReady() }),
      recentCommitsText: "feat(scope): touched t-aaaaaaaa",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("skip");
    // First-failing criterion wins reason — (a) is checked first.
    expect(decisions[0]?.reason).toBe("claimed-recently");
  });

  test("100 (a=1,b=0,c=0): old + READY + commit ref → skip:pane-ready", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneReady() }),
      recentCommitsText: "feat: t-aaaaaaaa landed",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("pane-ready");
  });

  test("010 (a=0,b=1,c=0): claimed-recently + non-READY + commit ref → skip:claimed-recently (a checked first)", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 5 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "feat: t-aaaaaaaa",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("claimed-recently");
  });

  test("001 (a=0,b=0,c=1): claimed-recently + READY + no ref → skip:claimed-recently", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 5 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneReady() }),
      recentCommitsText: "unrelated commit",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("claimed-recently");
  });

  test("110 (a=1,b=1,c=0): drift signals on (a)+(b) but commit ref → skip:commit-ref-found", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "feat(scope): work in progress on t-aaaaaaaa",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("commit-ref-found");
  });

  test("101 (a=1,b=0,c=1): READY → skip:pane-ready (b is the deciding fail)", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneReady() }),
      recentCommitsText: "unrelated",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("pane-ready");
  });

  test("011 (a=0,b=1,c=1): claimed-recently → skip:claimed-recently", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 10 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "unrelated",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("claimed-recently");
  });

  test("111 (a=1,b=1,c=1): all three drift signals → REVERT with flag body", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 165 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "unrelated work elsewhere",
      commitsScanned: 30,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("revert");
    expect(decisions[0]?.flagBody).toBeDefined();
    expect(decisions[0]?.flagBody).toContain("lane-drift-revert: t-aaaaaaaa");
    expect(decisions[0]?.flagBody).toContain("claimed by alice for 2h45m");
    expect(decisions[0]?.flagBody).toContain("pane COMPACTING");
    expect(decisions[0]?.flagBody).toContain("auto-reverted to todo");
  });
});

// ---------- Owner / pane-classify edge cases ----------

describe("checkLaneDrift — owner + pane edge cases", () => {
  test("Task without owner → skip:no-owner; classifyMember NOT called", async () => {
    let calls = 0;
    const decisions = await checkLaneDrift({
      inProgressTasks: [{ id: "t-noowner", status: "in-progress", claimedAt: NOW_SEC - 60 * 60 } as KanbanTask],
      classifyMember: async (_m: string) => {
        calls++;
        return null;
      },
      recentCommitsText: "",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("no-owner");
    expect(calls).toBe(0);
  });

  test("classifyMember returns null → skip:pane-unclassifiable (NOT revert)", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: async () => null,
      recentCommitsText: "unrelated",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("pane-unclassifiable");
  });

  test("Task with claimedAt absent → criterion (a) false → skip:claimed-recently", async () => {
    const decisions = await checkLaneDrift({
      inProgressTasks: [{ id: "t-aaaaaaaa", owner: "alice", status: "in-progress" } as KanbanTask],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "unrelated",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("claimed-recently");
    expect(decisions[0]?.evidence.claimedAtSec).toBe(null);
    expect(decisions[0]?.evidence.claimedAgoMin).toBe(null);
  });

  test("RATE-LIMIT pane is non-READY → counts as criterion (b) satisfied", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneRateLimit() }),
      recentCommitsText: "no ref here",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("revert");
    expect(decisions[0]?.flagBody).toContain("pane RATE-LIMIT");
  });

  test("threshold override — 60min lifts the bar; 50min-aged claim no longer drifts", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 50 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "no ref",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: 60,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("claimed-recently");
  });

  test("multiple tasks: each evaluated independently", async () => {
    const t1 = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const t2 = task({ id: "t-bbbbbbbb", owner: "bob", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t1, t2],
      classifyMember: fixedClassify({ alice: paneCompacting(), bob: paneReady() }),
      recentCommitsText: "no refs",
      commitsScanned: 5,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions).toHaveLength(2);
    const byId = new Map<string, DriftDecision>(decisions.map((d) => [d.taskId, d]));
    expect(byId.get("t-aaaaaaaa")?.action).toBe("revert");
    expect(byId.get("t-bbbbbbbb")?.action).toBe("skip");
    expect(byId.get("t-bbbbbbbb")?.reason).toBe("pane-ready");
  });

  test("commit ref matches even when task id appears in body (not just subject)", async () => {
    const t = task({ id: "t-deadbeef", owner: "alice", claimedAgoMin: 60 });
    // Body-only mention.
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "feat(scope): unrelated subject\n\nBody mentions t-deadbeef in passing.\n--END--",
      commitsScanned: 1,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.action).toBe("skip");
    expect(decisions[0]?.reason).toBe("commit-ref-found");
    expect(decisions[0]?.evidence.hasCommitRef).toBe(true);
  });

  test("evidence.commitsScanned passed through from input", async () => {
    const t = task({ id: "t-aaaaaaaa", owner: "alice", claimedAgoMin: 60 });
    const decisions = await checkLaneDrift({
      inProgressTasks: [t],
      classifyMember: fixedClassify({ alice: paneCompacting() }),
      recentCommitsText: "no ref",
      commitsScanned: 42,
      nowSec: NOW_SEC,
      claimedAtThresholdMin: THRESHOLD_MIN,
    });
    expect(decisions[0]?.evidence.commitsScanned).toBe(42);
  });
});

// ---------- formatFlagBody snapshot ----------

describe("formatFlagBody — ADR-062 §OQ5 prescription", () => {
  test("formats per the canonical body", () => {
    const body = formatFlagBody({
      taskId: "t-deadbeef",
      member: "alice",
      claimedAtSec: NOW_SEC - 60 * 165,
      claimedAgoMin: 165,
      pane: { state: "COMPACTING", evidence: "Compacting", capturedAt: NOW_SEC * 1000 },
      hasCommitRef: false,
      commitsScanned: 30,
    });
    expect(body).toBe(
      "lane-drift-revert: t-deadbeef claimed by alice for 2h45m, pane COMPACTING, no commit ref — auto-reverted to todo",
    );
  });

  test("null pane → renders as UNKNOWN", () => {
    const body = formatFlagBody({
      taskId: "t-1",
      member: "bob",
      claimedAtSec: NOW_SEC - 60 * 60,
      claimedAgoMin: 60,
      pane: null,
      hasCommitRef: false,
      commitsScanned: 30,
    });
    expect(body).toContain("pane UNKNOWN");
  });

  test("null claimedAgoMin → renders as ?min", () => {
    const body = formatFlagBody({
      taskId: "t-1",
      member: "bob",
      claimedAtSec: null,
      claimedAgoMin: null,
      pane: { state: "RATE-LIMIT", evidence: "hit your limit", capturedAt: NOW_SEC * 1000 },
      hasCommitRef: false,
      commitsScanned: 30,
    });
    expect(body).toContain("for ?min");
  });
});

// ---------- formatDurationCompact ----------

describe("formatDurationCompact — CLAUDE.md global convention", () => {
  test("under 60m → Nmin", () => {
    expect(formatDurationCompact(0)).toBe("0min");
    expect(formatDurationCompact(1)).toBe("1min");
    expect(formatDurationCompact(47)).toBe("47min");
    expect(formatDurationCompact(59)).toBe("59min");
  });

  test("exactly on the hour → Hh (no minutes suffix)", () => {
    expect(formatDurationCompact(60)).toBe("1h");
    expect(formatDurationCompact(120)).toBe("2h");
    expect(formatDurationCompact(2880)).toBe("48h"); // never days
  });

  test("over an hour with minutes → HhMm", () => {
    expect(formatDurationCompact(165)).toBe("2h45m");
    expect(formatDurationCompact(405)).toBe("6h45m");
    expect(formatDurationCompact(1549)).toBe("25h49m");
  });
});

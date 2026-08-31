// Unit tests for src/core/superdoctor-hygiene/drain.ts (ADR-131 T3
// drain-loop integration / t-247b4b35).
//
// Coverage:
//   - detectAll aggregates across all 5 classes
//   - drainTick happy-path: upserts → picks top-1 → applies → marks fixed
//   - One-fix-per-tick: 5 issues detected, only 1 drained per tick
//   - Severity ordering: P0 fires before P1, P1 before P3
//   - Confidence ladder:
//       high → applies on first detection
//       medium → defers on first detection, applies on 2nd-tick
//       low → defers while P0/P1 present, applies once blocking drained
//   - Fix failure (verb throws): row still marked fixed (fix_successful=0)
//     to prevent infinite-retry; drained.result.applied=false
//   - Skip reasons:
//       no-unfixed when zero detected
//       ladder-defer when all unfixed but none eligible

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../../src/abstractions/sqlite-migrations.ts";
import { HygieneRepo, type HygieneRow } from "../../../../src/core/repositories/hygiene-repo.ts";
import type { FixDeps, TeamState } from "../../../../src/core/superdoctor-hygiene/_shared.ts";
import { detectAll, drainTick } from "../../../../src/core/superdoctor-hygiene/drain.ts";
import type { KanbanTask } from "../../../../src/schema/kanban.ts";

let scratch: string;
let db: Database;
let repo: HygieneRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-drain-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new HygieneRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

function task(o: Partial<KanbanTask>): KanbanTask {
  return { id: o.id ?? "t-x", status: o.status ?? "todo", ...o };
}

function recorderDeps(): FixDeps & { calls: { verb: string; arg: string }[] } {
  const calls: { verb: string; arg: string }[] = [];
  return {
    calls,
    assignVerb: async (id, m) => {
      calls.push({ verb: `assign:${id}`, arg: m });
    },
    laneVerb: async (id, lane) => {
      calls.push({ verb: `lane:${id}`, arg: lane });
    },
    priorityVerb: async (id, p) => {
      calls.push({ verb: `priority:${id}`, arg: String(p) });
    },
  };
}

function throwingDeps(): FixDeps {
  return {
    assignVerb: async () => {
      throw new Error("verb boom");
    },
    laneVerb: async () => {
      throw new Error("verb boom");
    },
    priorityVerb: async () => {
      throw new Error("verb boom");
    },
  };
}

// ---------- detectAll ----------

describe("detectAll", () => {
  test("returns issues from all 5 detectors", () => {
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-ghost", owner: "fe-ghost", lane: "fe" }), // ghost-owner P0
      task({ id: "t-lane", owner: "fe-1", lane: "be", claimedAt: null }), // lane-mismatch P0
      task({ id: "t-prio", priority: null }), // prio-null P3
    ];
    const issues = detectAll(team, kanban);
    const classes = new Set(issues.map((i) => i.fingerprintClass));
    expect(classes.has("ghost-owner")).toBe(true);
    expect(classes.has("lane-mismatch")).toBe(true);
    expect(classes.has("prio-null")).toBe(true);
  });
});

// ---------- drainTick happy path ----------

describe("drainTick — happy path", () => {
  test("zero detected → skipReason='no-unfixed', drained=null", async () => {
    const team: TeamState = { members: [{ name: "fe-1", lane: "fe" }] };
    const r = await drainTick({
      team,
      kanban: [],
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.detected).toBe(0);
    expect(r.unfixedAfter).toBe(0);
    expect(r.drained).toBeNull();
    expect(r.skipReason).toBe("no-unfixed");
  });

  test("single ghost-owner → drained + assign verb invoked", async () => {
    const team: TeamState = {
      members: [
        { name: "fe-1", role: "member", lane: "fe" },
        { name: "fe-2", role: "member", lane: "fe" },
      ],
    };
    // priority: 1 prevents the prio-null detector from double-firing on
    // the same row (t-5251b666 sibling-E). Applies to every fixture
    // below that's meant to trip ONLY the targeted detector class.
    const kanban: KanbanTask[] = [
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", status: "todo", priority: 1 }),
    ];
    const deps = recorderDeps();
    const r = await drainTick({ team, kanban, repo, deps, now: 1000 });
    expect(r.detected).toBe(1);
    expect(r.drained?.row.taskId).toBe("t-001");
    expect(r.drained?.row.fingerprintClass).toBe("ghost-owner");
    expect(r.drained?.result.applied).toBe(true);
    // alphabetical tiebreak: fe-1
    expect(deps.calls).toEqual([{ verb: "assign:t-001", arg: "fe-1" }]);
    // Row marked fixed in DB
    const stored = repo.getFingerprint("t-001", "ghost-owner");
    expect(stored?.fixAppliedAt).toBe(1000);
    expect(stored?.fixSuccessful).toBe(true);
  });

  test("lane-null-orphan → drained + lane verb invoked", async () => {
    const team: TeamState = {
      members: [
        { name: "fe-1", role: "member", lane: "fe" },
        { name: "be-1", role: "member", lane: "be" },
      ],
    };
    const kanban: KanbanTask[] = [
      task({
        id: "t-002",
        owner: null,
        lane: null,
        status: "todo",
        priority: 1,
      }),
    ];
    const deps = recorderDeps();
    const r = await drainTick({ team, kanban, repo, deps, now: 1000 });
    expect(r.detected).toBe(1);
    expect(r.drained?.row.fingerprintClass).toBe("lane-null-orphan");
    expect(r.drained?.result.applied).toBe(true);
    expect(deps.calls).toEqual([{ verb: "lane:t-002", arg: "be" }]);
    const stored = repo.getFingerprint("t-002", "lane-null-orphan");
    expect(stored?.fixAppliedAt).toBe(1000);
    expect(stored?.fixSuccessful).toBe(true);
  });
});

// ---------- one fix per tick ----------

describe("drainTick — one-fix-per-tick", () => {
  test("5 fingerprints detected, only 1 drained, others remain unfixed", async () => {
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", priority: 1 }), // ghost P0
      task({ id: "t-002", owner: "fe-ghost-2", lane: "fe", priority: 1 }), // ghost P0
      task({ id: "t-003", lane: "fe", priority: null }), // prio P3
      task({ id: "t-004", lane: "fe", priority: null }), // prio P3
      task({ id: "t-005", lane: "fe", priority: null }), // prio P3
    ];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.detected).toBe(5);
    expect(r.drained).not.toBeNull();
    // 4 still unfixed (5 detected - 1 fixed - 1 dropped from listUnfixed since marked fixed).
    // Actually, listUnfixed is called BEFORE the markFixed of the drained row, so
    // unfixedAfter reflects pre-mark state. Confirming this with a re-read instead.
    const remainingAfter = repo.listUnfixed();
    expect(remainingAfter).toHaveLength(4);
  });
});

// ---------- severity ordering ----------

describe("drainTick — severity ordering", () => {
  test("P0 ghost-owner fires before P3 prio-null even when prio detected first", async () => {
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-prio-first", lane: "fe", priority: null }), // P3
      task({ id: "t-ghost", owner: "fe-ghost", lane: "fe", priority: 1 }), // P0
    ];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.drained?.row.fingerprintClass).toBe("ghost-owner");
    expect(r.drained?.row.severity).toBe("P0");
  });

  test("P1 role-mismatch fires before P3 prio-null", async () => {
    const team: TeamState = {
      members: [
        { name: "planner", role: "planner" },
        { name: "fe-1", role: "member", lane: "fe" },
      ],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-prio", lane: "fe", priority: null }), // P3
      task({ id: "t-role", owner: "planner", lane: "fe", priority: 1 }), // P1
    ];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.drained?.row.fingerprintClass).toBe("role-mismatch");
    expect(r.drained?.row.severity).toBe("P1");
  });
});

// ---------- confidence ladder ----------

describe("drainTick — confidence ladder", () => {
  test("high → applies on first detection", async () => {
    // ghost-owner is high-confidence
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", priority: 1 }),
    ];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.drained?.result.applied).toBe(true);
  });

  test("medium → defers on first detection, applies on 2nd-tick (flap dampener)", async () => {
    // lane-mismatch is medium-confidence
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({
        id: "t-001",
        owner: "fe-1",
        lane: "be",
        claimedAt: null,
        status: "todo",
        priority: 1,
      }),
    ];
    // Tick 1: detected, last_seen_at = detected_at = 1000 → ladder defers
    const r1 = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r1.detected).toBe(1);
    // unfixedAfter is the pre-fix listUnfixed count; since deferred (no drain), all 1 still unfixed
    expect(r1.unfixedAfter).toBe(1);
    expect(r1.drained).toBeNull();
    expect(r1.skipReason).toBe("ladder-defer");

    // Tick 2: re-detected; last_seen_at bumped to 2000, detected_at still 1000 → eligible
    const r2 = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 2000,
    });
    expect(r2.drained?.result.applied).toBe(true);
    expect(r2.drained?.row.fingerprintClass).toBe("lane-mismatch");
  });

  test("low → defers while P0 present, applies once P0 drained", async () => {
    // lane-null-orphan + prio-null are low-confidence
    const team: TeamState = {
      members: [
        { name: "fe-1", role: "member", lane: "fe" },
        { name: "fe-2", role: "member", lane: "fe" },
      ],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-ghost", owner: "fe-ghost", lane: "fe", priority: 1 }), // P0/high
      task({ id: "t-prio", lane: "fe", priority: null }), // P3/low
    ];
    // Tick 1: P0 ghost picked; P3 prio sat
    const r1 = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r1.drained?.row.severity).toBe("P0");

    // Tick 2: kanban now has the ghost reassigned (synthesise: drop it from kanban),
    // leaving only the prio. With no blocking, low becomes eligible.
    const kanban2: KanbanTask[] = [task({ id: "t-prio", lane: "fe", priority: null })];
    const r2 = await drainTick({
      team,
      kanban: kanban2,
      repo,
      deps: recorderDeps(),
      now: 2000,
    });
    expect(r2.drained?.row.severity).toBe("P3");
    expect(r2.drained?.row.fingerprintClass).toBe("prio-null");
  });

  test("ladder-defer when only medium (first-tick) exists → skipReason='ladder-defer'", async () => {
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-001", owner: "fe-1", lane: "be", claimedAt: null, priority: 1 }),
    ];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.drained).toBeNull();
    expect(r.skipReason).toBe("ladder-defer");
  });
});

// ---------- fix failure path ----------

describe("drainTick — fix failure", () => {
  test("verb throws → result.applied=false, row marked fixed (no infinite-retry)", async () => {
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    const kanban: KanbanTask[] = [
      task({ id: "t-001", owner: "fe-ghost", lane: "fe", priority: 1 }),
    ];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: throwingDeps(),
      now: 1000,
    });
    expect(r.drained?.result.applied).toBe(false);
    expect(r.drained?.result.reason).toBe("verb-failed");
    // Row marked fixed (fix_applied_at set) so next listUnfixed doesn't re-pick it
    const stored = repo.getFingerprint("t-001", "ghost-owner")!;
    expect(stored.fixAppliedAt).toBe(1000);
    expect(stored.fixSuccessful).toBe(false);
    expect(repo.listUnfixed()).toHaveLength(0);
  });

  test("malformed unfixed row with attemptedFix=null → result.applied=false, reason='verb-failed'", async () => {
    const markFixedCalls: Array<{
      taskId: string;
      fingerprintClass: string;
      now: number;
      successful: boolean;
    }> = [];
    const stubRepo = {
      upsertFingerprint: () => {},
      listUnfixed: (): HygieneRow[] => [
        {
          taskId: "t-bad",
          fingerprintClass: "lane-null-orphan",
          severity: "P3",
          confidence: "low",
          diagnosis: "corrupt row",
          detectedAt: 1000,
          lastSeenAt: 1000,
          attemptedFix: null,
          fixAppliedAt: null,
          fixSuccessful: null,
        },
      ],
      markFixed: (taskId: string, fingerprintClass: string, now: number, successful: boolean) => {
        markFixedCalls.push({ taskId, fingerprintClass, now, successful });
      },
    } as unknown as HygieneRepo;
    const r = await drainTick({
      team: { members: [] },
      kanban: [],
      repo: stubRepo,
      deps: recorderDeps(),
      now: 2000,
    });
    expect(r.drained?.result.applied).toBe(false);
    expect(r.drained?.result.reason).toBe("verb-failed");
    expect(markFixedCalls).toEqual([
      {
        taskId: "t-bad",
        fingerprintClass: "lane-null-orphan",
        now: 2000,
        successful: false,
      },
    ]);
  });

  test("escalate fingerprint (zero candidates) → result.applied=false, reason='escalate'", async () => {
    const team: TeamState = {
      members: [{ name: "planner", role: "planner" }],
    };
    const kanban: KanbanTask[] = [task({ id: "t-001", owner: "fe-ghost", lane: "fe" })];
    const r = await drainTick({
      team,
      kanban,
      repo,
      deps: recorderDeps(),
      now: 1000,
    });
    expect(r.drained?.result.applied).toBe(false);
    expect(r.drained?.result.reason).toBe("escalate");
  });
});

// ---------- idempotence ----------

describe("drainTick — idempotence + persistence", () => {
  test("re-detection on 2nd tick bumps lastSeenAt without duplicating row", async () => {
    const team: TeamState = {
      members: [{ name: "fe-1", role: "member", lane: "fe" }],
    };
    // Use a medium-confidence fingerprint so 2nd-tick doesn't fix it
    // and we can inspect the row state.
    const kanban: KanbanTask[] = [
      task({ id: "t-lane", owner: "fe-1", lane: "be", claimedAt: null }),
    ];
    await drainTick({ team, kanban, repo, deps: recorderDeps(), now: 1000 });
    // Inspect after tick 1: row exists with detected=last=1000
    const after1 = repo.getFingerprint("t-lane", "lane-mismatch")!;
    expect(after1.detectedAt).toBe(1000);
    expect(after1.lastSeenAt).toBe(1000);
    // tick 2 — same kanban; row should still be ONE row with bumped last_seen_at
    // (but eligible to drain on 2nd tick, so we use throwing deps then check pre-mark)
    await drainTick({ team, kanban, repo, deps: throwingDeps(), now: 2000 });
    // After tick 2: row was eligible (medium 2nd-tick), drained + marked fixed (failed via throw)
    const after2 = repo.getFingerprint("t-lane", "lane-mismatch")!;
    expect(after2.detectedAt).toBe(1000); // preserved
    expect(after2.lastSeenAt).toBe(2000); // bumped before drain
    expect(after2.fixAppliedAt).toBe(2000);
    expect(after2.fixSuccessful).toBe(false);
  });
});

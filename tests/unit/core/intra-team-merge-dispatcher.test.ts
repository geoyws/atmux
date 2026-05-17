// Unit tests for src/core/intra-team-merge-dispatcher.ts (ADR-134 T9
// / t-6987392a).
//
// Five-cell coverage matrix per the Task body:
//   1. eligible branch, no in-flight  → fires open → in_progress
//      (and walks further on a clean gate)
//   2. eligible branch, in-flight     → no-op + reason includes
//      'in-flight'
//   3. clean merge succeeds           → walks ready_to_merge →
//      merging → tested (base advanced via mergeMember)
//   4. merge conflict                 → walks ready_to_merge →
//      merging → conflict (terminal)
//   5. stale base, needs rebase       → walks ready_to_merge →
//      rebasing
//
// Strategy: real SQLite (fresh per test), real performMerge, mocked
// `git` GitSpawn + injected KanbanRepo with seeded open-task rows for
// the gate-input resolver.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { BranchMergeState } from "../../../src/core/branch-merge-state.ts";
import {
  deriveMember,
  type ProductionDispatcherDeps,
  productionQueueMergeAttempt,
  resolvePreMergeGate,
} from "../../../src/core/intra-team-merge-dispatcher.ts";
import { KanbanRepo } from "../../../src/core/repositories/kanban-repo.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";
import type { Logger } from "../../../src/core/tui.ts";

// ---------- Fixture wiring ----------

let scratch: string;
let db: Database;
let mergerRepo: MergerStateRepo;
let kanbanRepo: KanbanRepo;
let logs: string[];
let logger: Logger;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-merge-dispatcher-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  mergerRepo = new MergerStateRepo(db);
  kanbanRepo = new KanbanRepo(db);
  logs = [];
  logger = {
    log: (s: string) => logs.push(s),
    ok: () => {},
    warn: () => {},
    err: () => {},
  };
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

// ---------- git spawn factory ----------

function spawnOk(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function spawnFail(stdout: string, stderr: string, code: number): SpawnResult {
  return {
    exitCode: code,
    stdout,
    stderr,
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

/** Build a `GitSpawn` that covers BOTH the pre-merge gate's probes
 *  (`status --porcelain`, `merge-base`, `rev-parse <base>`) AND the
 *  mergeMember probes (`status`, branch-verify rev-parse, rev-list
 *  --count, fetch, checkout, merge --no-ff, post-merge rev-parse
 *  HEAD).
 *
 *  `behavior` mirrors intra-team-merge.test.ts:
 *    - 'success'  → merge clean, HEAD = 'mergedSha123'
 *    - 'conflict' → merge fails with conflicting paths
 *    - 'no-op'    → 0 commits ahead (mergeMember early-returns) */
function makeGitStub(opts: {
  behavior: "success" | "no-op" | "conflict";
  baseMoved?: boolean;
  baseSha?: string;
  mergeBaseSha?: string;
}): GitSpawn {
  const baseSha = opts.baseSha ?? "baseTip123";
  const mergeBaseSha =
    opts.mergeBaseSha ?? (opts.baseMoved === true ? "oldDivergenceSha" : baseSha);
  let mergeFired = false;
  let abortFired = false;
  return async (argv) => {
    // ---- pre-merge gate probes ----

    // worktree clean check
    if (argv.includes("status") && argv.includes("--porcelain")) {
      if (abortFired) return spawnOk("");
      if (mergeFired && opts.behavior === "conflict") {
        return spawnOk("UU file1.ts\nUU file2.ts\n");
      }
      return spawnOk("");
    }

    // merge-base lookup: `git merge-base <baseRef> <member>` (no --is-
    // ancestor flag) returns the merge-base SHA.
    if (argv.includes("merge-base") && !argv.includes("--is-ancestor")) {
      return spawnOk(`${mergeBaseSha}\n`);
    }

    // merge-base ancestry check
    if (argv.includes("merge-base") && argv.includes("--is-ancestor")) {
      return spawnOk("");
    }

    // rev-parse on the base ref (gate probe to detect base movement)
    if (argv.includes("rev-parse") && !argv.includes("--verify") && !argv.includes("HEAD")) {
      return spawnOk(`${baseSha}\n`);
    }

    // ---- mergeMember probes ----

    if (argv.includes("rev-parse") && argv.includes("--verify")) {
      return spawnOk("branchExists\n");
    }
    if (argv.includes("rev-list") && argv.includes("--count")) {
      return spawnOk(opts.behavior === "no-op" ? "0\n" : "2\n");
    }
    if (argv.includes("fetch")) {
      return spawnOk("");
    }
    if (argv.includes("checkout")) {
      return spawnOk("");
    }
    if (argv.includes("merge") && argv.includes("--no-ff")) {
      mergeFired = true;
      if (opts.behavior === "conflict") {
        return spawnFail("", "Merge conflict in file1.ts", 1);
      }
      return spawnOk("");
    }
    if (argv.includes("merge") && argv.includes("--abort")) {
      abortFired = true;
      return spawnOk("");
    }
    if (argv.includes("rev-parse") && argv.includes("HEAD")) {
      return spawnOk("mergedSha123\n");
    }
    return spawnOk("");
  };
}

// ---------- deps factory ----------

function makeDeps(overrides: Partial<ProductionDispatcherDeps> = {}): ProductionDispatcherDeps {
  return {
    teamRoot: "/tmp/fake-repo",
    baseBranch: "geoyws",
    mergerRepo,
    kanbanRepo,
    git: async () => spawnOk(""),
    logger,
    now: () => 1000,
    fetch: false,
    ...overrides,
  };
}

const MEMBER_BRANCH = "geoyws-fe-1";

function seedState(state: BranchMergeState, t = 100, branch = MEMBER_BRANCH): void {
  mergerRepo.transition({
    memberBranch: branch,
    next: state,
    note: "seed",
    by: "operator",
    transitionedAt: t,
  });
}

// ---------- deriveMember ----------

describe("deriveMember — `<base>-<member>` parsing", () => {
  test("strips base prefix and returns the member name", () => {
    expect(deriveMember("geoyws-fe-1", "geoyws")).toBe("fe-1");
    expect(deriveMember("geoyws-up-impl", "geoyws")).toBe("up-impl");
  });

  test("returns null when branch doesn't carry the `<base>-` prefix", () => {
    expect(deriveMember("main", "geoyws")).toBeNull();
    expect(deriveMember("geoyws", "geoyws")).toBeNull();
    expect(deriveMember("geoyws-", "geoyws")).toBeNull();
  });

  test("base with hyphens is handled (first hyphen after base wins)", () => {
    expect(deriveMember("rel-v1-up-impl", "rel-v1")).toBe("up-impl");
  });
});

// ---------- resolvePreMergeGate ----------

describe("resolvePreMergeGate", () => {
  test("clean fixture → all four gate fields populated", async () => {
    const gate = await resolvePreMergeGate(
      "geoyws-fe-1",
      3,
      makeDeps({ git: makeGitStub({ behavior: "success" }) }),
    );
    expect(gate.ownerOpenTaskCount).toBe(0);
    expect(gate.worktreeIsClean).toBe(true);
    expect(gate.isAheadOfBase).toBe(true);
    expect(gate.baseHasMoved).toBe(false);
  });

  test("dirty worktree → worktreeIsClean=false", async () => {
    const dirtyGit: GitSpawn = async (argv) => {
      if (argv.includes("status") && argv.includes("--porcelain")) {
        return spawnOk(" M file.ts\n");
      }
      return spawnOk("");
    };
    const gate = await resolvePreMergeGate("geoyws-fe-1", 1, makeDeps({ git: dirtyGit }));
    expect(gate.worktreeIsClean).toBe(false);
  });

  test("base moved → baseHasMoved=true", async () => {
    const gate = await resolvePreMergeGate(
      "geoyws-fe-1",
      1,
      makeDeps({
        git: makeGitStub({ behavior: "success", baseMoved: true }),
      }),
    );
    expect(gate.baseHasMoved).toBe(true);
  });

  test("aheadCount 0 → isAheadOfBase=false (pass-through, no git rev-list)", async () => {
    const gate = await resolvePreMergeGate(
      "geoyws-fe-1",
      0,
      makeDeps({ git: makeGitStub({ behavior: "success" }) }),
    );
    expect(gate.isAheadOfBase).toBe(false);
  });

  test("non-derivable branch → ownerOpenTaskCount > 0 (gate holds)", async () => {
    const gate = await resolvePreMergeGate(
      "non-conforming-branch",
      1,
      makeDeps({ git: makeGitStub({ behavior: "success" }) }),
    );
    // Member derivation fails → conservative gate-hold sentinel.
    expect(gate.ownerOpenTaskCount).toBeGreaterThan(0);
  });
});

// ---------- 5-cell dispatcher matrix ----------

describe("productionQueueMergeAttempt — 5-cell matrix", () => {
  // ----- Cell 1: eligible + no in-flight → started-merge -----

  test("cell 1: open + clean gate → walks open → in_progress → ready_to_merge → merging → tested", async () => {
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(true);
    // Final state should be `tested` (the dispatcher stops at the
    // test-gate per ADR-144 deferral).
    expect(mergerRepo.getState(MEMBER_BRANCH)?.state).toBe("tested");
    expect(r.reason).toContain("tested");
    // Base advanced — merger_state row carries the merge SHA.
    expect(mergerRepo.getState(MEMBER_BRANCH)?.baseSha).toBe("mergedSha123");
  });

  // ----- Cell 2: eligible + already in-flight → refuse -----

  test("cell 2: row in `merging` at entry → refuse with reason='in-flight: merging'", async () => {
    seedState("merging");
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(false);
    expect(r.reason).toContain("in-flight");
    expect(r.reason).toContain("merging");
    // State unchanged.
    expect(mergerRepo.getState(MEMBER_BRANCH)?.state).toBe("merging");
  });

  test("cell 2b: row in `tested` at entry (caller-driven) → refuse", async () => {
    seedState("tested");
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(false);
    expect(r.reason).toContain("in-flight");
    expect(r.reason).toContain("tested");
  });

  test("cell 2c: row in `merged` at entry (terminal) → refuse with reason='terminal: merged'", async () => {
    seedState("merged");
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(false);
    expect(r.reason).toContain("terminal");
    expect(r.reason).toContain("merged");
  });

  // ----- Cell 3: clean merge succeeds (already covered by Cell 1) -----

  test("cell 3: clean merge advances base; cron 'by' attribution lands in row", async () => {
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    const row = mergerRepo.getState(MEMBER_BRANCH);
    expect(row?.state).toBe("tested");
    expect(row?.baseSha).toBe("mergedSha123");
    expect(row?.transitionedBy).toBe("cron");
  });

  // ----- Cell 4: merge conflict → conflict transition -----

  test("cell 4: conflict during merge → ready_to_merge → merging → conflict (terminal)", async () => {
    const fn = productionQueueMergeAttempt(
      makeDeps({ git: makeGitStub({ behavior: "conflict" }) }),
    );
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(true);
    expect(mergerRepo.getState(MEMBER_BRANCH)?.state).toBe("conflict");
    expect(mergerRepo.getState(MEMBER_BRANCH)?.note).toContain("conflict");
    expect(r.reason).toContain("conflict");
  });

  // ----- Cell 5: stale base → rebasing detour -----

  test("cell 5: baseHasMoved=true → walks open → in_progress → rebasing", async () => {
    const fn = productionQueueMergeAttempt(
      makeDeps({
        git: makeGitStub({ behavior: "success", baseMoved: true }),
      }),
    );
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(true);
    // Stops at `rebasing` — caller (T9 follow-up OR T2-T3 rebase
    // wiring) drives the rebase + transition back to ready_to_merge.
    // From the dispatcher's POV, `rebasing` is caller-driven once we
    // arrive there, so the walk stops on the next iteration when the
    // state-check sees `rebasing`. But the walk SHOULD have
    // transitioned in_progress → rebasing in this invocation.
    expect(mergerRepo.getState(MEMBER_BRANCH)?.state).toBe("rebasing");
  });
});

// ---------- Owner open-task gate ----------

describe("productionQueueMergeAttempt — owner-tasks gate-hold", () => {
  test("owner has open tasks → walks open → in_progress, then gate holds", async () => {
    // Seed an in-progress kanban task assigned to `fe-1` so the
    // gate-input resolver counts ≥1 open task.
    kanbanRepo.addTask({
      id: "t-fixture-001",
      subject: "fixture in-progress task",
      body: "",
      status: "in-progress",
      owner: "fe-1",
      deps: [],
      priority: null,
      epic: null,
      story: null,
      lane: null,
      deliverable: null,
      staleMin: null,
      driverOnly: false,
      createdAt: 100,
      claimedAt: 150,
      completedAt: null,
      claimedFrom: null,
      createdFrom: null,
      note: null,
    });
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    // First tick fires open → in_progress (progress made), so queued=true.
    expect(r.queued).toBe(true);
    // Row should be in_progress (gate held there).
    expect(mergerRepo.getState(MEMBER_BRANCH)?.state).toBe("in_progress");
    expect(mergerRepo.getState(MEMBER_BRANCH)?.note).toContain("open task");
  });
});

// ---------- Cap safety ----------

describe("productionQueueMergeAttempt — safety cap", () => {
  test("maxIterations=1 → walks exactly one transition, returns queued=true", async () => {
    const fn = productionQueueMergeAttempt(
      makeDeps({
        git: makeGitStub({ behavior: "success" }),
        maxIterations: 1,
      }),
    );
    const r = await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(r.queued).toBe(true);
    // Single tick from null/open → in_progress.
    expect(mergerRepo.getState(MEMBER_BRANCH)?.state).toBe("in_progress");
  });
});

// ---------- Logger surface ----------

describe("productionQueueMergeAttempt — logger evidence", () => {
  test("each tick emits a structured log line", async () => {
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    const tickLines = logs.filter((l) => l.includes("[dispatcher]"));
    expect(tickLines.length).toBeGreaterThan(0);
    expect(tickLines[0]).toContain(MEMBER_BRANCH);
    expect(tickLines[0]).toContain("tick=1");
  });

  test("refuse-terminal emits the refuse line", async () => {
    seedState("conflict");
    const fn = productionQueueMergeAttempt(makeDeps({ git: makeGitStub({ behavior: "success" }) }));
    await fn({ memberBranch: MEMBER_BRANCH, aheadCount: 2 });
    expect(logs.some((l) => l.includes("refuse-terminal"))).toBe(true);
  });
});

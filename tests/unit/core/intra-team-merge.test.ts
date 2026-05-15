// Unit tests for src/core/intra-team-merge.ts (ADR-134 §state-machine
// / t-b5f12ab1).
//
// Coverage focus: each branch of `performMerge` — the seeding path
// (no row → upsertOpen → in_progress), the gate-driven advance from
// in_progress, the merge-attempt path from ready_to_merge (no-op /
// merged / conflict), terminal short-circuits, caller-driven
// holding states (rebasing / merging / tested / test_failed), and
// the concurrency-loss branch on each transition site.
//
// Strategy: real SQLite DB (fresh per test), real
// branch-merge-state.ts state machine, mocked `mergeMember` via
// the `git` GitSpawn injection (we route mergeMember through a
// stub by overriding the abstraction's spawn rather than mocking
// the module). Tests stay narrow + deterministic — no tmux, no
// disk-level git ops.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import {
  closeDatabase,
  type Database,
  openDatabase,
} from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import type { PreMergeGateInput } from "../../../src/core/branch-merge-state.ts";
import {
  type IntraTeamMergeContext,
  performMerge,
} from "../../../src/core/intra-team-merge.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";

let scratch: string;
let db: Database;
let repo: MergerStateRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-intra-merge-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new MergerStateRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

// ---------- Helpers ----------

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

/** Build a `GitSpawn` that responds to mergeMember's expected probe
 *  sequence. `behavior` controls the merge outcome:
 *
 *    - 'success' → status-clean, branch-exists, 1-commit-ahead,
 *      fetch ok, checkout ok, merge ok, rev-parse returns
 *      `'newSha'`.
 *    - 'no-op' → same shape but 0 commits ahead (early return
 *      from mergeMember).
 *    - 'conflict' → merge step returns non-zero; status returns
 *      conflict-marker porcelain; merge --abort succeeds. */
function makeGitStub(behavior: "success" | "no-op" | "conflict"): GitSpawn {
  let mergeFired = false;
  let abortFired = false;
  return async (argv) => {
    // status --porcelain (first call: empty = clean)
    if (argv.includes("status") && argv.includes("--porcelain")) {
      if (abortFired) return spawnOk(""); // post-abort clean
      if (mergeFired && behavior === "conflict") {
        // Conflict marker. mergeMember's extractConflictPaths
        // looks for `UU `, `AA `, etc. at line start.
        return spawnOk("UU file1.ts\nUU file2.ts\n");
      }
      return spawnOk("");
    }
    // rev-parse --verify refs/heads/<branch> — branch exists.
    if (argv.includes("rev-parse") && argv.includes("--verify")) {
      return spawnOk("aaa\n");
    }
    // rev-list --count <base>..<branch> — commits ahead probe.
    if (argv.includes("rev-list") && argv.includes("--count")) {
      return spawnOk(behavior === "no-op" ? "0\n" : "1\n");
    }
    // fetch — always ok in tests.
    if (argv.includes("fetch")) {
      return spawnOk("");
    }
    // checkout — always ok.
    if (argv.includes("checkout")) {
      return spawnOk("");
    }
    // merge --no-ff — conflict path returns non-zero.
    if (argv.includes("merge") && argv.includes("--no-ff")) {
      mergeFired = true;
      if (behavior === "conflict") {
        return spawnFail("", "Merge conflict in file1.ts", 1);
      }
      return spawnOk("");
    }
    // merge --abort — cleanup path.
    if (argv.includes("merge") && argv.includes("--abort")) {
      abortFired = true;
      return spawnOk("");
    }
    // rev-parse HEAD — final SHA.
    if (argv.includes("rev-parse") && argv.includes("HEAD")) {
      return spawnOk("newMergedSha\n");
    }
    return spawnOk("");
  };
}

/** Build a `PreMergeGateInput` with sensible defaults; tests override
 *  only the fields they care about. Default profile = gate PASSES
 *  (owner has zero open tasks, worktree clean, branch ahead, base
 *  stable → next == ready_to_merge). */
function gate(over: Partial<PreMergeGateInput> = {}): PreMergeGateInput {
  return {
    ownerOpenTaskCount: 0,
    worktreeIsClean: true,
    isAheadOfBase: true,
    baseHasMoved: false,
    ...over,
  };
}

function baseCtx(overrides: Partial<IntraTeamMergeContext> = {}): IntraTeamMergeContext {
  return {
    team: "t1",
    branchKey: "geoyws-whip-impl",
    base: "geoyws",
    repoPath: "/tmp/fake-repo",
    gate: gate(),
    repo,
    now: () => 1000,
    git: async () => spawnOk(""),
    fetch: false,
    ...overrides,
  };
}

// ---------- Seeding path (no row + open) ----------

describe("performMerge — seeding path", () => {
  test("no row → upsertOpen + advance to in_progress (one tick)", async () => {
    const r = await performMerge(baseCtx());
    expect(r).toEqual({
      state: "in_progress",
      changed: true,
      reason: "owner started work — fan-in pending",
    });
    const row = repo.load("t1", "geoyws-whip-impl");
    expect(row?.state).toBe("in_progress");
  });

  test("existing `open` row → transitions to in_progress", async () => {
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 500 });
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true);
  });
});

// ---------- in_progress → gate decisions ----------

describe("performMerge — in_progress branch (gate decisions)", () => {
  beforeEach(() => {
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "open",
      toState: "in_progress",
      note: "seed",
      now: 200,
    });
  });

  test("owner has open tasks → stays in_progress, note refreshed", async () => {
    const r = await performMerge(
      baseCtx({ gate: gate({ ownerOpenTaskCount: 3 }) }),
    );
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true); // note was refreshed
    expect(r.reason).toContain("3 open tasks");
    expect(repo.load("t1", "geoyws-whip-impl")?.note).toContain("3 open tasks");
  });

  test("worktree dirty → stays in_progress with dirty reason", async () => {
    const r = await performMerge(
      baseCtx({ gate: gate({ worktreeIsClean: false }) }),
    );
    expect(r.state).toBe("in_progress");
    expect(r.reason).toContain("worktree dirty");
  });

  test("branch not ahead → stays in_progress with nothing-to-merge reason", async () => {
    const r = await performMerge(
      baseCtx({ gate: gate({ isAheadOfBase: false }) }),
    );
    expect(r.state).toBe("in_progress");
    expect(r.reason).toContain("not ahead of base");
  });

  test("gate clear, base stable → ready_to_merge", async () => {
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("ready_to_merge");
    expect(r.changed).toBe(true);
    expect(repo.load("t1", "geoyws-whip-impl")?.state).toBe("ready_to_merge");
  });

  test("gate clear, base moved → rebasing", async () => {
    const r = await performMerge(
      baseCtx({ gate: gate({ baseHasMoved: true }) }),
    );
    expect(r.state).toBe("rebasing");
    expect(r.reason).toContain("base moved");
  });
});

// ---------- ready_to_merge → merge attempts ----------

describe("performMerge — ready_to_merge branch (merge attempts)", () => {
  beforeEach(() => {
    // Seed directly into ready_to_merge.
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "open",
      toState: "in_progress",
      note: null,
      now: 110,
    });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "in_progress",
      toState: "ready_to_merge",
      note: null,
      now: 120,
    });
  });

  test("successful merge → tested + mergedSha set", async () => {
    const r = await performMerge(baseCtx({ git: makeGitStub("success") }));
    expect(r.state).toBe("tested");
    expect(r.changed).toBe(true);
    expect(r.mergedSha).toBe("newMergedSha");
    expect(r.reason).toContain("newMergedSha");
    expect(repo.load("t1", "geoyws-whip-impl")?.state).toBe("tested");
  });

  test("no-op merge (no commits ahead) → merged terminal", async () => {
    const r = await performMerge(baseCtx({ git: makeGitStub("no-op") }));
    expect(r.state).toBe("merged");
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("no commits ahead");
    expect(r.mergedSha).toBeUndefined();
  });

  test("merge conflict → conflict terminal with paths in note", async () => {
    const r = await performMerge(baseCtx({ git: makeGitStub("conflict") }));
    expect(r.state).toBe("conflict");
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("file1.ts");
    const row = repo.load("t1", "geoyws-whip-impl");
    expect(row?.state).toBe("conflict");
    expect(row?.note).toContain("file1.ts");
  });
});

// ---------- Terminal states (no-op short-circuit) ----------

describe("performMerge — terminal state short-circuit", () => {
  test.each([["merged"], ["conflict"], ["reverted"]] as const)(
    "terminal '%s' → no-op return, row untouched",
    async (terminal) => {
      repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
      repo.transition({
        team: "t1",
        branchKey: "geoyws-whip-impl",
        fromState: "open",
        toState: terminal,
        note: "terminal",
        now: 200,
      });
      const r = await performMerge(baseCtx());
      expect(r.state).toBe(terminal);
      expect(r.changed).toBe(false);
      expect(r.reason).toContain("terminal state");
      // Row untouched.
      expect(repo.load("t1", "geoyws-whip-impl")?.updatedAt).toBe(200);
    },
  );
});

// ---------- Concurrency-loss edges ----------

describe("performMerge — concurrency-loss edges", () => {
  test("open → in_progress loses to sibling writer: returns no-op with observed state", async () => {
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
    // Spy: intercept the repo's transition call so the first call
    // (matching open→in_progress) reports `applied: false` simulating
    // a sibling writer that beat us to the row.
    const original = repo.transition.bind(repo);
    let fired = 0;
    repo.transition = ((args) => {
      fired += 1;
      // Force a concurrency loss on the first transition.
      if (fired === 1) {
        return { applied: false, observedFrom: "in_progress" };
      }
      return original(args);
    }) as typeof repo.transition;
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("concurrency lost");
  });

  test("in_progress → ready_to_merge loses to sibling writer", async () => {
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "open",
      toState: "in_progress",
      note: null,
      now: 200,
    });
    const original = repo.transition.bind(repo);
    repo.transition = ((args) => {
      if (args.toState === "ready_to_merge") {
        return { applied: false, observedFrom: "merging" };
      }
      return original(args);
    }) as typeof repo.transition;
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("merging");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("concurrency lost");
  });

  test("ready_to_merge → merging entry loses to sibling: short-circuit before merge fires", async () => {
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "open",
      toState: "in_progress",
      note: null,
      now: 110,
    });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "in_progress",
      toState: "ready_to_merge",
      note: null,
      now: 120,
    });
    const original = repo.transition.bind(repo);
    let gitCalls = 0;
    repo.transition = ((args) => {
      if (args.fromState === "ready_to_merge" && args.toState === "merging") {
        return { applied: false, observedFrom: "merging" };
      }
      return original(args);
    }) as typeof repo.transition;
    const gitSpy: GitSpawn = async () => {
      gitCalls += 1;
      return spawnOk("");
    };
    const r = await performMerge(baseCtx({ git: gitSpy }));
    expect(r.state).toBe("merging");
    expect(r.changed).toBe(false);
    // Concurrency-loss short-circuited BEFORE the actual merge —
    // no git calls fired.
    expect(gitCalls).toBe(0);
  });

  test("upsertOpen succeeds but reload returns null → defensive 'row vanished' return", async () => {
    // Override load() to return null on second call, after the
    // initial null + upsertOpen. Mimics a concurrent deleter
    // (impossible in practice; the repo has no delete method, but
    // the defensive branch exists in the code).
    const originalLoad = repo.load.bind(repo);
    let loadCount = 0;
    repo.load = ((team: string, branch: string) => {
      loadCount += 1;
      if (loadCount === 2) return null;
      return originalLoad(team, branch);
    }) as typeof repo.load;
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("open");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("row vanished");
  });
});

// ---------- Non-conflict merge throw ----------

describe("performMerge — non-conflict merge throw", () => {
  test("git failure that ISN'T a MergeConflictError propagates after merging-state durable write", async () => {
    repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "open",
      toState: "in_progress",
      note: null,
      now: 110,
    });
    repo.transition({
      team: "t1",
      branchKey: "geoyws-whip-impl",
      fromState: "in_progress",
      toState: "ready_to_merge",
      note: null,
      now: 120,
    });
    // Git stub that fails the BRANCH-EXISTS guard (rev-parse
    // --verify returns non-zero) — mergeMember throws ConfigError,
    // NOT MergeConflictError. The wrapper rethrows; row stays in
    // `merging` for operator inspection.
    const gitFail: GitSpawn = async (argv) => {
      if (argv.includes("rev-parse") && argv.includes("--verify")) {
        return spawnFail("", "fatal: ambiguous", 128);
      }
      return spawnOk("");
    };
    await expect(performMerge(baseCtx({ git: gitFail }))).rejects.toThrow();
    // Row left in `merging` per the durable-signal-first invariant
    // (ADR-134 §Conflict surface §1).
    expect(repo.load("t1", "geoyws-whip-impl")?.state).toBe("merging");
  });
});

// ---------- Caller-driven holding states ----------

describe("performMerge — caller-driven holding states", () => {
  test.each([["rebasing"], ["tested"], ["test_failed"]] as const)(
    "'%s' is caller-driven → no-op with 'waiting on outer wiring' reason",
    async (holding) => {
      repo.upsertOpen({ team: "t1", branchKey: "geoyws-whip-impl", now: 100 });
      // Multi-step seed to reach the holding state. open →
      // in_progress → ready_to_merge → merging → <holding>.
      const seedPath: ReadonlyArray<[string, string]> = [
        ["open", "in_progress"],
        ["in_progress", "ready_to_merge"],
        ["ready_to_merge", "merging"],
      ];
      let t = 200;
      for (const [from, to] of seedPath) {
        repo.transition({
          team: "t1",
          branchKey: "geoyws-whip-impl",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fromState: from as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toState: to as any,
          note: null,
          now: t,
        });
        t += 10;
      }
      // Now advance from merging to the target holding state.
      const lastFrom = holding === "rebasing" ? "ready_to_merge" : "merging";
      if (holding === "rebasing") {
        // Rewire: rebasing reachable from ready_to_merge (per
        // FORWARD_TRANSITIONS), so back the row out one step.
        repo.transition({
          team: "t1",
          branchKey: "geoyws-whip-impl",
          fromState: "merging",
          toState: "tested",
          note: null,
          now: t,
        });
        // tested isn't reachable to rebasing — for this test we
        // just inject the row directly via re-seed.
        db.prepare("UPDATE merger_state SET state = ? WHERE team = ? AND branch_key = ?")
          .run(holding, "t1", "geoyws-whip-impl");
      } else if (holding === "tested") {
        repo.transition({
          team: "t1",
          branchKey: "geoyws-whip-impl",
          fromState: "merging",
          toState: "tested",
          note: null,
          now: t,
        });
      } else {
        // test_failed via tested first.
        repo.transition({
          team: "t1",
          branchKey: "geoyws-whip-impl",
          fromState: "merging",
          toState: "tested",
          note: null,
          now: t,
        });
        repo.transition({
          team: "t1",
          branchKey: "geoyws-whip-impl",
          fromState: "tested",
          toState: "test_failed",
          note: null,
          now: t + 10,
        });
      }
      void lastFrom;
      const r = await performMerge(baseCtx());
      expect(r.state).toBe(holding);
      expect(r.changed).toBe(false);
      expect(r.reason).toContain("caller-driven");
    },
  );
});

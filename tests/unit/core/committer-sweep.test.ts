// Unit tests for src/core/committer-sweep.ts (ADR-134 T4 / t-64e52aac).
//
// Coverage matrix (per CLAUDE.md "100% coverage with narrowed
// denominator"):
//   - listMemberBranches via `git branch --list <base>-*` mock —
//     empty / multi / git-failure
//   - countAhead — 0 / >0 / non-numeric / non-zero exit
//   - per-branch eligibility decision tree:
//     - 0 ahead → skipped-zero-ahead
//     - in-flight state → skipped-in-flight
//     - terminal state + commits after → queued (fresh tip)
//     - never-transitioned (null state) → queued
//     - dispatcher refuses → queue-refused
//   - aggregate result counts: checked / queued / skipped / refused
//   - idempotence — second sweep with same git output but populated
//     state.db reflects "in-flight" → skipped on second pass

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import type { BranchMergeState } from "../../../src/core/branch-merge-state.ts";
import {
  type CommitterSweepDeps,
  committerSweep,
  type QueueMergeFn,
} from "../../../src/core/committer-sweep.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";

// ---------- Fixture helpers ----------

interface GitCall {
  argv: ReadonlyArray<string>;
}

function fakeSpawnResult(stdout: string, exitCode = 0): SpawnResult {
  return {
    cmd: "git",
    argv: [],
    exitCode,
    signalled: null,
    stdout,
    stderr: "",
    durationMs: 1,
  };
}

/** Build a GitSpawn mock keyed on the first three argv elements
 *  (`-C <root> <subcmd>`). Each entry returns a `(rest) => stdout`
 *  responder so tests can differentiate `branch --list` from
 *  `rev-list --count <range>`. */
function makeGitSpawn(
  responders: Record<
    string,
    (rest: ReadonlyArray<string>) => { stdout: string; exitCode?: number }
  >,
  calls: GitCall[] = [],
): GitSpawn {
  return async (argv) => {
    calls.push({ argv });
    // Find matching responder — match by `subcmd` (4th argv element
    // after `-C <root> <subcmd>`).
    const subcmd = argv[2];
    if (subcmd === undefined) return fakeSpawnResult("", 1);
    const responder = responders[subcmd];
    if (responder === undefined) return fakeSpawnResult("", 1);
    const r = responder(argv.slice(3));
    return fakeSpawnResult(r.stdout, r.exitCode ?? 0);
  };
}

const TEAM_ROOT = "/srv/demo";
const BASE_BRANCH = "geoyws";

let scratch: string;
let db: Database;
let repo: MergerStateRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-committer-sweep-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new MergerStateRepo(db);
});

afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

function seedRepoRow(
  memberBranch: string,
  state: BranchMergeState,
  transitionedAt = 1_700_000_000,
): void {
  repo.transition({
    memberBranch,
    next: state,
    transitionedAt,
    by: "operator",
  });
}

function buildDeps(opts: {
  branches: string[];
  aheadBy: Record<string, number>;
  queue?: QueueMergeFn;
  calls?: GitCall[];
  gitOverrides?: Partial<Parameters<typeof makeGitSpawn>[0]>;
  /** Roster gate (t-911c9314). Defaults to the union of every member
   *  named in `opts.branches` (suffix-after-`<base>-`) so existing
   *  tests don't have to thread roster explicitly — they continue to
   *  exercise the post-glob path. Tests targeting the roster gate
   *  itself pass an explicit subset. */
  rosterMembers?: ReadonlyArray<string>;
}): CommitterSweepDeps {
  const branchesStdout = opts.branches.join("\n") + (opts.branches.length > 0 ? "\n" : "");
  const calls = opts.calls ?? [];
  const responders: Parameters<typeof makeGitSpawn>[0] = {
    branch: () => ({ stdout: branchesStdout }),
    "rev-list": (rest) => {
      // rest = ["--count", "<base>..<member>"]
      const range = rest[1] ?? "";
      const member = range.replace(`${BASE_BRANCH}..`, "");
      const count = opts.aheadBy[member] ?? 0;
      return { stdout: `${count}\n` };
    },
    ...(opts.gitOverrides ?? {}),
  };
  const queue: QueueMergeFn = opts.queue ?? (async () => ({ queued: true }));
  const prefix = `${BASE_BRANCH}-`;
  const defaultRoster = opts.branches
    .filter((b) => b.startsWith(prefix))
    .map((b) => b.slice(prefix.length));
  return {
    teamRoot: TEAM_ROOT,
    baseBranch: BASE_BRANCH,
    rosterMembers: opts.rosterMembers ?? defaultRoster,
    mergerStateRepo: repo,
    queueMergeAttempt: queue,
    git: makeGitSpawn(responders, calls),
  };
}

// ---------- listMemberBranches ----------

describe("committerSweep — branch enumeration", () => {
  test("empty branch list → 0 candidates, 0 queued", async () => {
    const deps = buildDeps({ branches: [], aheadBy: {} });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(0);
    expect(result.queued).toBe(0);
    expect(result.entries).toEqual([]);
  });

  test("uses `git branch --list <base>-*` format", async () => {
    const calls: GitCall[] = [];
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
      calls,
    });
    await committerSweep(deps);
    const branchCall = calls.find((c) => c.argv[2] === "branch");
    expect(branchCall).toBeDefined();
    expect(branchCall?.argv).toContain("--list");
    expect(branchCall?.argv).toContain(`${BASE_BRANCH}-*`);
    // `-C <teamRoot>` prefix is the cwd anchor.
    expect(branchCall?.argv[0]).toBe("-C");
    expect(branchCall?.argv[1]).toBe(TEAM_ROOT);
  });

  test("git branch failure → empty candidate set (graceful, not crash)", async () => {
    const deps: CommitterSweepDeps = {
      teamRoot: TEAM_ROOT,
      baseBranch: BASE_BRANCH,
      rosterMembers: ["fe-1"],
      mergerStateRepo: repo,
      queueMergeAttempt: async () => ({ queued: true }),
      git: makeGitSpawn({
        branch: () => ({ stdout: "", exitCode: 1 }),
      }),
    };
    const result = await committerSweep(deps);
    expect(result.checked).toBe(0);
    expect(result.entries).toEqual([]);
  });

  test("roster gate drops non-member branches matching the glob (t-911c9314)", async () => {
    // Repro: git branch --list `geoyws-*` returns 3 branches; only
    // `fe-1` and `be-2` are in team.json. `planner-rebased-backup`
    // (operator safety backup) MUST NOT be queued — that's the
    // 2026-05-17 geoyws-planner-rebased-backup stuck-state class.
    const deps = buildDeps({
      branches: ["geoyws-fe-1", "geoyws-be-2", "geoyws-planner-rebased-backup"],
      aheadBy: {
        "geoyws-fe-1": 1,
        "geoyws-be-2": 1,
        "geoyws-planner-rebased-backup": 4,
      },
      rosterMembers: ["fe-1", "be-2"],
    });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(2);
    expect(result.queued).toBe(2);
    const branches = result.entries.map((e) => e.memberBranch).sort();
    expect(branches).toEqual(["geoyws-be-2", "geoyws-fe-1"]);
    // The backup branch is silently excluded — no entry, no state-row
    // transition, no log line. That's the contract: roster-gated
    // branches never enter the dispatcher pipeline.
    expect(branches).not.toContain("geoyws-planner-rebased-backup");
  });

  test("roster gate excludes epic-team `<base>-epic-<id>` branches (handled by epic-merge)", async () => {
    // Per ADR-091 the parent committer doesn't merge `<base>-epic-<id>`
    // branches — that's the `atmux epic-merge tick` cron's job. The
    // roster gate is the upstream defense: epic branches are never in
    // team.json.members so they're naturally excluded.
    const deps = buildDeps({
      branches: ["geoyws-fe-1", "geoyws-epic-e-abc12345"],
      aheadBy: { "geoyws-fe-1": 1, "geoyws-epic-e-abc12345": 3 },
      rosterMembers: ["fe-1"],
    });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(1);
    expect(result.entries[0]?.memberBranch).toBe("geoyws-fe-1");
  });

  test("empty roster disables the gate (carve-out for misconfigured team.json)", async () => {
    // The JSDoc carve-out: empty `rosterMembers` array reverts to the
    // pre-t-911c9314 behavior — every prefix-matching branch becomes a
    // candidate. Prevents a typo-empty team.json from silently dropping
    // every member branch on the floor.
    const deps = buildDeps({
      branches: ["geoyws-fe-1", "geoyws-be-2"],
      aheadBy: { "geoyws-fe-1": 1, "geoyws-be-2": 1 },
      rosterMembers: [],
    });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(2);
    expect(result.queued).toBe(2);
  });
});

// ---------- countAhead + zero-ahead skip ----------

describe("committerSweep — ahead-of-base check", () => {
  test("branch with 0 commits ahead → skipped-zero-ahead", async () => {
    const deps = buildDeps({
      branches: ["geoyws-stable"],
      aheadBy: { "geoyws-stable": 0 },
    });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]?.action).toBe("skipped-zero-ahead");
  });

  test("rev-list returning non-numeric → treats as 0 ahead", async () => {
    const deps: CommitterSweepDeps = {
      teamRoot: TEAM_ROOT,
      baseBranch: BASE_BRANCH,
      rosterMembers: ["fe-1"],
      mergerStateRepo: repo,
      queueMergeAttempt: async () => ({ queued: true }),
      git: makeGitSpawn({
        branch: () => ({ stdout: "geoyws-fe-1\n" }),
        "rev-list": () => ({ stdout: "garbage\n" }),
      }),
    };
    const result = await committerSweep(deps);
    expect(result.entries[0]?.action).toBe("skipped-zero-ahead");
  });

  test("rev-list non-zero exit → treats as 0 ahead (skip)", async () => {
    const deps: CommitterSweepDeps = {
      teamRoot: TEAM_ROOT,
      baseBranch: BASE_BRANCH,
      rosterMembers: ["fe-1"],
      mergerStateRepo: repo,
      queueMergeAttempt: async () => ({ queued: true }),
      git: makeGitSpawn({
        branch: () => ({ stdout: "geoyws-fe-1\n" }),
        "rev-list": () => ({ stdout: "", exitCode: 128 }),
      }),
    };
    const result = await committerSweep(deps);
    expect(result.entries[0]?.action).toBe("skipped-zero-ahead");
  });

  test("branch ahead by 3, never-transitioned state → queued", async () => {
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 3 },
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(1);
    expect(result.entries[0]?.action).toBe("queued");
    expect(result.entries[0]?.aheadCount).toBe(3);
    expect(result.entries[0]?.observedState).toBeNull();
  });
});

// ---------- In-flight state skip ----------

describe("committerSweep — in-flight state recognition", () => {
  test.each([
    "ready_to_merge",
    "rebasing",
    "merging",
    "tested",
    "test_failed",
  ] as const)("state=%s → skipped-in-flight", async (state) => {
    seedRepoRow("geoyws-fe-1", state);
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.entries[0]?.action).toBe("skipped-in-flight");
    expect(result.entries[0]?.observedState).toBe(state);
  });

  test("state=open with commits ahead → queued (open is initial, not in-flight)", async () => {
    seedRepoRow("geoyws-fe-1", "open");
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 1 },
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(1);
    expect(result.entries[0]?.action).toBe("queued");
  });

  test("state=in_progress with commits ahead → queued (re-eval gate per t-f4088323 P1 fix)", async () => {
    // Pre-fix: `in_progress` was in IN_FLIGHT_STATES → branches got
    // trapped because the dispatcher pre-merge gate (held at first-
    // tick when worker was dirty) never re-evaluated when the worker
    // became task-clean. Post-fix: in_progress is queued every cycle
    // so the dispatcher re-runs the gate. Dispatcher idempotence is
    // guaranteed by BEGIN IMMEDIATE in MergerStateRepo.transition.
    seedRepoRow("geoyws-fe-1", "in_progress");
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.entries[0]?.action).toBe("queued");
    expect(result.entries[0]?.observedState).toBe("in_progress");
  });

  test("state=in_progress + dispatcher refuses (gate-held) → queue-refused with reason", async () => {
    // Worker still dirty → dispatcher walks `in_progress → in_progress`
    // (self-loop, no progress), returns `{queued:false, reason:"gate-held: ..."}`.
    // Sweep records `queue-refused` so operators can see WHY the branch
    // didn't advance this tick.
    seedRepoRow("geoyws-fe-1", "in_progress");
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
      queue: async () => ({
        queued: false,
        reason: "gate-held: worker has 2 in-progress tasks",
      }),
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(0);
    expect(result.refused).toBe(1);
    expect(result.entries[0]?.action).toBe("queue-refused");
    expect(result.entries[0]?.note).toContain("gate-held");
    expect(result.entries[0]?.observedState).toBe("in_progress");
  });
});

// ---------- Terminal-state + new commits ----------

describe("committerSweep — terminal state with fresh tip", () => {
  test.each([
    "merged",
    "conflict",
    "reverted",
  ] as const)("state=%s + commits ahead → queued (fresh work after terminal)", async (state) => {
    seedRepoRow("geoyws-fe-1", state);
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 5 },
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(1);
    expect(result.entries[0]?.action).toBe("queued");
    expect(result.entries[0]?.observedState).toBe(state);
  });

  test("state=merged + 0 ahead → skipped-zero-ahead (terminal stays terminal)", async () => {
    seedRepoRow("geoyws-fe-1", "merged");
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 0 },
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(0);
    expect(result.entries[0]?.action).toBe("skipped-zero-ahead");
  });
});

// ---------- Dispatcher refusal ----------

describe("committerSweep — dispatcher refusal", () => {
  test("queue returns {queued:false, reason} → queue-refused with note", async () => {
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
      queue: async () => ({ queued: false, reason: "rate-limit cap reached" }),
    });
    const result = await committerSweep(deps);
    expect(result.queued).toBe(0);
    expect(result.refused).toBe(1);
    expect(result.entries[0]?.action).toBe("queue-refused");
    expect(result.entries[0]?.note).toBe("rate-limit cap reached");
  });

  test("queue returns {queued:false} without reason → queue-refused, no note", async () => {
    const deps = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
      queue: async () => ({ queued: false }),
    });
    const result = await committerSweep(deps);
    expect(result.refused).toBe(1);
    expect(result.entries[0]?.action).toBe("queue-refused");
    expect(result.entries[0]?.note).toBeUndefined();
  });
});

// ---------- Multi-branch aggregate behaviour (task body acceptance) ----------

describe("committerSweep — multi-branch aggregate", () => {
  test("3 branches: 2 ahead (1 in-flight, 1 fresh), 1 zero-ahead → 1 queued, 2 skipped", async () => {
    // Mirrors the task body acceptance: "synthetic 3-member team, 2
    // branches ahead, 1 already merging → assert sweep queues
    // exactly the 1 missing".
    seedRepoRow("geoyws-busy", "merging"); // already in-flight
    // geoyws-stale: never transitioned, 0 ahead — skip-zero-ahead
    // geoyws-fresh: never transitioned, 4 ahead — queue
    const deps = buildDeps({
      branches: ["geoyws-busy", "geoyws-stale", "geoyws-fresh"],
      aheadBy: {
        "geoyws-busy": 2,
        "geoyws-stale": 0,
        "geoyws-fresh": 4,
      },
    });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(3);
    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.refused).toBe(0);

    const queued = result.entries.find((e) => e.action === "queued");
    expect(queued?.memberBranch).toBe("geoyws-fresh");
    expect(queued?.aheadCount).toBe(4);

    const inFlight = result.entries.find((e) => e.action === "skipped-in-flight");
    expect(inFlight?.memberBranch).toBe("geoyws-busy");

    const zeroAhead = result.entries.find((e) => e.action === "skipped-zero-ahead");
    expect(zeroAhead?.memberBranch).toBe("geoyws-stale");
  });
});

// ---------- Idempotence ----------

describe("committerSweep — idempotence", () => {
  test("second sweep after dispatcher records merging transition skips the branch", async () => {
    // First sweep — branch fresh, dispatcher records a deep-mid-walk
    // transition (`merging` is genuinely active — the actual git merge
    // is mid-walk). Post-t-f4088323 fix, `in_progress` no longer
    // qualifies (sweep re-queues to re-eval gate); a `merging` row
    // exercises the same idempotent-no-op path the original test
    // intended.
    const deps1 = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
      queue: async ({ memberBranch }) => {
        repo.transition({
          memberBranch,
          next: "merging",
          transitionedAt: 1_700_000_000,
          by: "cron",
        });
        return { queued: true };
      },
    });
    const first = await committerSweep(deps1);
    expect(first.queued).toBe(1);

    // Second sweep — same git output, but state.db now has the
    // mid-walk row → must skip.
    const deps2 = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
    });
    const second = await committerSweep(deps2);
    expect(second.queued).toBe(0);
    expect(second.entries[0]?.action).toBe("skipped-in-flight");
    expect(second.entries[0]?.observedState).toBe("merging");
  });

  test("post-fix: second sweep on `in_progress` re-queues (gate re-eval, not skip)", async () => {
    // Companion to the above — explicitly pins the t-f4088323 fix:
    // back-to-back sweeps on `in_progress` MUST re-queue every cycle
    // (the dispatcher is responsible for idempotence on gate-held
    // self-loops).
    const deps1 = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
      queue: async ({ memberBranch }) => {
        repo.transition({
          memberBranch,
          next: "in_progress",
          transitionedAt: 1_700_000_000,
          by: "cron",
        });
        return { queued: true };
      },
    });
    const first = await committerSweep(deps1);
    expect(first.queued).toBe(1);

    const deps2 = buildDeps({
      branches: ["geoyws-fe-1"],
      aheadBy: { "geoyws-fe-1": 2 },
    });
    const second = await committerSweep(deps2);
    // Pre-fix this would have been skipped-in-flight; post-fix it's
    // re-queued (the dispatcher will run the gate again).
    expect(second.queued).toBe(1);
    expect(second.entries[0]?.action).toBe("queued");
    expect(second.entries[0]?.observedState).toBe("in_progress");
  });

  test("all-branches-merged + 0 ahead → fully no-op", async () => {
    seedRepoRow("geoyws-a", "merged");
    seedRepoRow("geoyws-b", "merged");
    const deps = buildDeps({
      branches: ["geoyws-a", "geoyws-b"],
      aheadBy: { "geoyws-a": 0, "geoyws-b": 0 },
    });
    const result = await committerSweep(deps);
    expect(result.checked).toBe(2);
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.refused).toBe(0);
  });
});

// Unit tests for src/core/intra-team-rebase.ts (ADR-134 T3+T4 /
// t-2b7572d7).
//
// Closes the rebasing → ready_to_merge | conflict outer-wiring gap.
// Coverage matrix matches the Task body's acceptance criteria:
//
//   1. clean rebase → rebasing → ready_to_merge (new baseSha written)
//   2. rebase conflict → rebasing → conflict (terminal, paths in note)
//   3. missing worktree → rebasing → conflict (terminal, descriptive)
//   4. TOCTOU guard — row not in rebasing → no-op with concurrency-loss
//   5. fetch=false path uses local <base> (not origin/<base>)
//   6. fetch failure throws (dispatcher leaves row in rebasing)
//
// Strategy: real SQLite DB (fresh per test), MergerStateRepo seeded
// to `rebasing`, GitSpawn injected per-test. The performRebase
// function is the unit; the dispatcher's wiring is covered by the
// dispatcher test file's cell-5 + new rebase tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import {
  type IntraTeamRebaseContext,
  performRebase,
} from "../../../src/core/intra-team-rebase.ts";
import { MergerStateRepo } from "../../../src/core/repositories/merger-state-repo.ts";

let scratch: string;
let db: Database;
let repo: MergerStateRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-intra-rebase-"));
  db = openDatabase(join(scratch, "state.db"), migrations);
  repo = new MergerStateRepo(db);
});
afterEach(async () => {
  closeDatabase(db);
  await rm(scratch, { recursive: true, force: true });
});

const MEMBER_BRANCH = "geoyws-fe-1";
const BASE = "geoyws";
const WT_PATH = "/tmp/fake-worktree/geoyws-fe-1";

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

function spawnFail(stderr: string, code = 1): SpawnResult {
  return {
    exitCode: code,
    stdout: "",
    stderr,
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  };
}

function seedRebasing(): void {
  repo.transition({
    memberBranch: MEMBER_BRANCH,
    next: "rebasing",
    note: "base moved during work — rebase before merge",
    by: "cron",
    transitionedAt: 100,
  });
}

/** Build a GitSpawn that handles the full probe sequence performRebase
 *  expects in the named scenario. */
function makeGitStub(opts: {
  worktreeExists?: boolean;
  rebaseOutcome: "clean" | "conflict";
  fetchOk?: boolean;
  newHeadSha?: string;
}): GitSpawn {
  const worktreeExists = opts.worktreeExists ?? true;
  const fetchOk = opts.fetchOk ?? true;
  const newHeadSha = opts.newHeadSha ?? "newRebaseTip0123";
  let abortFired = false;

  return async (argv) => {
    // Worktree existence probe.
    if (argv.includes("rev-parse") && argv.includes("--git-dir")) {
      return worktreeExists ? spawnOk(".git\n") : spawnFail("not a git repository", 128);
    }
    // Fetch.
    if (argv.includes("fetch")) {
      return fetchOk ? spawnOk("") : spawnFail("Could not resolve host", 128);
    }
    // Rebase main op.
    if (argv.includes("rebase") && !argv.includes("--abort")) {
      if (opts.rebaseOutcome === "clean") return spawnOk("");
      return spawnFail("CONFLICT (content): Merge conflict in src/foo.ts", 1);
    }
    // Status — porcelain conflict markers when mid-rebase.
    if (argv.includes("status") && argv.includes("--porcelain")) {
      if (opts.rebaseOutcome === "conflict" && !abortFired) {
        return spawnOk("UU src/foo.ts\nUU src/bar.ts\n");
      }
      return spawnOk("");
    }
    // Abort.
    if (argv.includes("rebase") && argv.includes("--abort")) {
      abortFired = true;
      return spawnOk("");
    }
    // Post-rebase HEAD lookup.
    if (argv.includes("rev-parse") && argv.includes("HEAD")) {
      return spawnOk(`${newHeadSha}\n`);
    }
    return spawnOk("");
  };
}

function makeCtx(overrides: Partial<IntraTeamRebaseContext> = {}): IntraTeamRebaseContext {
  return {
    memberBranch: MEMBER_BRANCH,
    base: BASE,
    memberWorktreePath: WT_PATH,
    repo,
    by: "cron",
    now: () => 200,
    git: makeGitStub({ rebaseOutcome: "clean" }),
    fetch: false,
    ...overrides,
  };
}

// ---------- Clean rebase ----------

describe("performRebase — clean rebase", () => {
  test("rebasing → ready_to_merge with new baseSha", async () => {
    seedRebasing();
    const result = await performRebase(
      makeCtx({ git: makeGitStub({ rebaseOutcome: "clean", newHeadSha: "freshTip123" }) }),
    );
    expect(result.state).toBe("ready_to_merge");
    expect(result.changed).toBe(true);
    expect(result.newBaseSha).toBe("freshTip123");
    expect(result.reason).toContain("clean");

    const row = repo.getState(MEMBER_BRANCH);
    expect(row?.state).toBe("ready_to_merge");
    expect(row?.baseSha).toBe("freshTip123");
    expect(row?.transitionedBy).toBe("cron");
  });

  test("rev-parse HEAD failure after clean rebase rejects and leaves row rebasing", async () => {
    seedRebasing();
    const argvLog: ReadonlyArray<string>[] = [];
    const tracingGit: GitSpawn = async (argv) => {
      argvLog.push(argv);
      if (argv.includes("rev-parse") && argv.includes("--git-dir")) {
        return spawnOk(".git\n");
      }
      if (argv.includes("rebase") && !argv.includes("--abort")) {
        return spawnOk("");
      }
      if (argv.includes("rev-parse") && argv.includes("HEAD")) {
        return spawnFail("fatal: ambiguous argument 'HEAD': unknown revision", 128);
      }
      return spawnOk("");
    };

    const ctx = makeCtx({ git: tracingGit });
    delete (ctx as Partial<IntraTeamRebaseContext>).now;

    await expect(performRebase(ctx)).rejects.toThrow(
      /perform-rebase: 'git rev-parse HEAD' failed after clean rebase \(exit 128\): fatal: ambiguous argument 'HEAD': unknown revision/,
    );
    expect(repo.getState(MEMBER_BRANCH)?.state).toBe("rebasing");
    expect(argvLog).toEqual([
      ["-C", WT_PATH, "rev-parse", "--git-dir"],
      ["-C", WT_PATH, "rebase", BASE],
      ["-C", WT_PATH, "rev-parse", "HEAD"],
    ]);
  });

  test("default `by` is 'cron'", async () => {
    seedRebasing();
    const ctx = makeCtx();
    delete (ctx as Partial<IntraTeamRebaseContext>).by;
    await performRebase(ctx);
    expect(repo.getState(MEMBER_BRANCH)?.transitionedBy).toBe("cron");
  });

  test("operator `by` override lands in row", async () => {
    seedRebasing();
    await performRebase(makeCtx({ by: "operator" }));
    expect(repo.getState(MEMBER_BRANCH)?.transitionedBy).toBe("operator");
  });
});

// ---------- Rebase conflict ----------

describe("performRebase — conflict", () => {
  test("rebase conflict → terminal conflict with paths in note", async () => {
    seedRebasing();
    const result = await performRebase(
      makeCtx({ git: makeGitStub({ rebaseOutcome: "conflict" }) }),
    );
    expect(result.state).toBe("conflict");
    expect(result.changed).toBe(true);
    expect(result.conflictPaths).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(result.reason).toContain("conflict");
    expect(result.reason).toContain("src/foo.ts");

    const row = repo.getState(MEMBER_BRANCH);
    expect(row?.state).toBe("conflict");
    expect(row?.note).toContain("src/foo.ts");
    expect(row?.note).toContain("src/bar.ts");
  });

  test("rebase --abort fires after conflict (restores worktree)", async () => {
    seedRebasing();
    const argvLog: ReadonlyArray<string>[] = [];
    const baseGit = makeGitStub({ rebaseOutcome: "conflict" });
    const tracingGit: GitSpawn = async (argv) => {
      argvLog.push(argv);
      return baseGit(argv);
    };
    await performRebase(makeCtx({ git: tracingGit }));
    const abortCall = argvLog.find(
      (a) => a.includes("rebase") && a.includes("--abort"),
    );
    expect(abortCall).toBeDefined();
  });
});

// ---------- Missing worktree ----------

describe("performRebase — missing worktree", () => {
  test("worktree probe fails → terminal conflict with descriptive reason", async () => {
    seedRebasing();
    const result = await performRebase(
      makeCtx({
        memberWorktreePath: "/tmp/does-not-exist",
        git: makeGitStub({ worktreeExists: false, rebaseOutcome: "clean" }),
      }),
    );
    expect(result.state).toBe("conflict");
    expect(result.changed).toBe(true);
    expect(result.reason).toContain("missing worktree");
    expect(result.reason).toContain("/tmp/does-not-exist");
    expect(repo.getState(MEMBER_BRANCH)?.state).toBe("conflict");
  });
});

// ---------- TOCTOU guard ----------

describe("performRebase — TOCTOU guard", () => {
  test("row not in rebasing → no-op with concurrency-loss reason", async () => {
    // Seed row directly to ready_to_merge (sibling tick / operator
    // already advanced past rebasing).
    repo.transition({
      memberBranch: MEMBER_BRANCH,
      next: "ready_to_merge",
      note: "sibling already rebased",
      by: "operator",
      transitionedAt: 100,
    });
    const result = await performRebase(
      makeCtx({ git: makeGitStub({ rebaseOutcome: "clean" }) }),
    );
    expect(result.state).toBe("ready_to_merge");
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("concurrency lost");
    // State unchanged.
    expect(repo.getState(MEMBER_BRANCH)?.note).toBe("sibling already rebased");
  });

  test("no row at all → no-op (observed='open')", async () => {
    const result = await performRebase(
      makeCtx({ git: makeGitStub({ rebaseOutcome: "clean" }) }),
    );
    expect(result.state).toBe("open");
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("concurrency lost");
  });
});

// ---------- fetch flag ----------

describe("performRebase — fetch flag", () => {
  test("fetch=false → rebases against local <base> (no origin/ prefix)", async () => {
    seedRebasing();
    const argvLog: ReadonlyArray<string>[] = [];
    const baseGit = makeGitStub({ rebaseOutcome: "clean" });
    const tracingGit: GitSpawn = async (argv) => {
      argvLog.push(argv);
      return baseGit(argv);
    };
    await performRebase(makeCtx({ fetch: false, git: tracingGit }));
    const rebaseCall = argvLog.find((a) => a.includes("rebase") && !a.includes("--abort"));
    expect(rebaseCall).toBeDefined();
    expect(rebaseCall).toContain(BASE);
    expect(rebaseCall).not.toContain(`origin/${BASE}`);
    // No fetch fired.
    expect(argvLog.find((a) => a.includes("fetch"))).toBeUndefined();
  });

  test("fetch=true → fetches origin/<base> first, rebases against origin/<base>", async () => {
    seedRebasing();
    const argvLog: ReadonlyArray<string>[] = [];
    const baseGit = makeGitStub({ rebaseOutcome: "clean" });
    const tracingGit: GitSpawn = async (argv) => {
      argvLog.push(argv);
      return baseGit(argv);
    };
    await performRebase(makeCtx({ fetch: true, git: tracingGit }));
    expect(argvLog.find((a) => a.includes("fetch"))).toBeDefined();
    const rebaseCall = argvLog.find((a) => a.includes("rebase") && !a.includes("--abort"));
    expect(rebaseCall).toContain(`origin/${BASE}`);
  });

  test("fetch failure throws (dispatcher leaves row in rebasing)", async () => {
    seedRebasing();
    await expect(
      performRebase(
        makeCtx({
          fetch: true,
          git: makeGitStub({ rebaseOutcome: "clean", fetchOk: false }),
        }),
      ),
    ).rejects.toThrow(/fetch.*failed/);
    // Row stays in rebasing — next tick retries.
    expect(repo.getState(MEMBER_BRANCH)?.state).toBe("rebasing");
  });
});

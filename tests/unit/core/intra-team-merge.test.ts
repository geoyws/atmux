// Unit tests for src/core/intra-team-merge.ts (ADR-134 §state-machine
// / t-2aae8a4c port).
//
// Coverage focus: each branch of `performMerge` — the seeding path
// (no row → in_progress, existing open → in_progress), the gate-
// driven advance from in_progress, the merge-attempt path from
// ready_to_merge (no-op / merged / conflict), terminal short-
// circuits, caller-driven holding states (rebasing / merging /
// tested / test_failed), the concurrency-loss TOCTOU edges, and the
// trunk-API attribution surfaces (transitioned_by + base_sha).
//
// Strategy: real SQLite DB (fresh per test), real
// branch-merge-state.ts state machine, mocked `mergeMember` via
// the `git` GitSpawn injection. Tests stay narrow + deterministic
// — no tmux, no disk-level git ops.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { PreMergeGateInput } from "../../../src/core/branch-merge-state.ts";
import { type IntraTeamMergeContext, performMerge } from "../../../src/core/intra-team-merge.ts";
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
 *      `'newMergedSha'`.
 *    - 'no-op' → same shape but 0 commits ahead (early return
 *      from mergeMember).
 *    - 'conflict' → merge step returns non-zero; status returns
 *      conflict-marker porcelain; merge --abort succeeds. */
function makeGitStub(behavior: "success" | "no-op" | "conflict"): GitSpawn {
  let mergeFired = false;
  let abortFired = false;
  return async (argv) => {
    if (argv.includes("status") && argv.includes("--porcelain")) {
      if (abortFired) return spawnOk("");
      if (mergeFired && behavior === "conflict") {
        return spawnOk("UU file1.ts\nUU file2.ts\n");
      }
      return spawnOk("");
    }
    if (argv.includes("rev-parse") && argv.includes("--verify")) {
      return spawnOk("aaa\n");
    }
    if (argv.includes("rev-list") && argv.includes("--count")) {
      return spawnOk(behavior === "no-op" ? "0\n" : "1\n");
    }
    if (argv.includes("fetch")) {
      return spawnOk("");
    }
    if (argv.includes("checkout")) {
      return spawnOk("");
    }
    if (argv.includes("merge") && argv.includes("--no-ff")) {
      mergeFired = true;
      if (behavior === "conflict") {
        return spawnFail("", "Merge conflict in file1.ts", 1);
      }
      return spawnOk("");
    }
    if (argv.includes("merge") && argv.includes("--abort")) {
      abortFired = true;
      return spawnOk("");
    }
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

const MEMBER_BRANCH = "geoyws-whip-impl";

function baseCtx(overrides: Partial<IntraTeamMergeContext> = {}): IntraTeamMergeContext {
  return {
    memberBranch: MEMBER_BRANCH,
    base: "geoyws",
    repoPath: "/tmp/fake-repo",
    gate: gate(),
    repo,
    by: "event",
    now: () => 1000,
    git: async () => spawnOk(""),
    fetch: false,
    ...overrides,
  };
}

/** Seed a row at the requested state, skipping the state-machine
 *  validation (tests need to inject mid-flight states directly). */
function seedState(state: string, t = 100, note: string | null = null): void {
  repo.transition({
    memberBranch: MEMBER_BRANCH,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next: state as any,
    note,
    by: "operator",
    transitionedAt: t,
  });
}

// ---------- Seeding path (no row + open) ----------

describe("performMerge — seeding path", () => {
  test("no row → advance to in_progress (implicit open)", async () => {
    const r = await performMerge(baseCtx());
    expect(r).toEqual({
      state: "in_progress",
      changed: true,
      reason: "owner started work — fan-in pending",
    });
    expect(repo.getState(MEMBER_BRANCH)?.state).toBe("in_progress");
  });

  test("existing `open` row → transitions to in_progress", async () => {
    seedState("open", 500);
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true);
  });
});

// ---------- in_progress → gate decisions ----------

describe("performMerge — in_progress branch (gate decisions)", () => {
  beforeEach(() => {
    seedState("in_progress", 200, "seed");
  });

  test("owner has open tasks → stays in_progress, note refreshed", async () => {
    const r = await performMerge(baseCtx({ gate: gate({ ownerOpenTaskCount: 3 }) }));
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(true); // note refreshed
    expect(r.reason).toContain("3 open tasks");
    expect(repo.getState(MEMBER_BRANCH)?.note).toContain("3 open tasks");
  });

  test("worktree dirty → stays in_progress with dirty reason", async () => {
    const r = await performMerge(baseCtx({ gate: gate({ worktreeIsClean: false }) }));
    expect(r.state).toBe("in_progress");
    expect(r.reason).toContain("worktree dirty");
  });

  test("branch not ahead → stays in_progress with nothing-to-merge reason", async () => {
    const r = await performMerge(baseCtx({ gate: gate({ isAheadOfBase: false }) }));
    expect(r.state).toBe("in_progress");
    expect(r.reason).toContain("not ahead of base");
  });

  test("gate clear, base stable → ready_to_merge", async () => {
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("ready_to_merge");
    expect(r.changed).toBe(true);
    expect(repo.getState(MEMBER_BRANCH)?.state).toBe("ready_to_merge");
  });

  test("gate clear, base moved → rebasing", async () => {
    const r = await performMerge(baseCtx({ gate: gate({ baseHasMoved: true }) }));
    expect(r.state).toBe("rebasing");
    expect(r.reason).toContain("base moved");
  });
});

// ---------- ready_to_merge → merge attempts ----------

describe("performMerge — ready_to_merge branch (merge attempts)", () => {
  beforeEach(() => {
    seedState("ready_to_merge", 120);
  });

  test("successful merge → tested + mergedSha set", async () => {
    const r = await performMerge(baseCtx({ git: makeGitStub("success") }));
    expect(r.state).toBe("tested");
    expect(r.changed).toBe(true);
    expect(r.mergedSha).toBe("newMergedSha");
    expect(r.reason).toContain("newMergedSha");
    const row = repo.getState(MEMBER_BRANCH);
    expect(row?.state).toBe("tested");
    // trunk schema: base_sha column gets the post-merge SHA on success
    expect(row?.baseSha).toBe("newMergedSha");
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
    const row = repo.getState(MEMBER_BRANCH);
    expect(row?.state).toBe("conflict");
    expect(row?.note).toContain("file1.ts");
  });
});

// ---------- Terminal states (no-op short-circuit) ----------

describe("performMerge — terminal state short-circuit", () => {
  test.each([
    ["merged"],
    ["conflict"],
    ["reverted"],
  ] as const)("terminal '%s' → no-op return, row untouched", async (terminal) => {
    seedState(terminal, 200, "terminal");
    const r = await performMerge(baseCtx());
    expect(r.state).toBe(terminal);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("terminal state");
    // Row's transitioned_at untouched — no transition fired.
    expect(repo.getState(MEMBER_BRANCH)?.transitionedAt).toBe(200);
  });
});

// ---------- Concurrency-loss edges (TOCTOU guard) ----------

describe("performMerge — concurrency-loss edges", () => {
  test("open → in_progress loses to sibling writer: re-read shows different state", async () => {
    // Seed in_progress so the wrapper's initial read sees that state
    // (the wrapper would route to gate-decision, not seed). But for
    // this test we want to exercise the guarded-transition branch
    // where the EXPECTED fromState is `open` but the re-read shows
    // a sibling writer already advanced. We achieve this by spying
    // on `getState`: first call (top-of-tick) returns null (implicit
    // open), second call (inside guardedTransition) returns
    // in_progress.
    const original = repo.getState.bind(repo);
    let calls = 0;
    repo.getState = ((branch: string) => {
      calls += 1;
      if (calls === 1) return null;
      if (calls === 2) {
        // Sibling raced past us — return a different state.
        return {
          memberBranch: branch,
          state: "in_progress",
          note: null,
          transitionedAt: 50,
          transitionedBy: "cron",
          baseSha: null,
          conflictSha: null,
        };
      }
      return original(branch);
    }) as typeof repo.getState;
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("in_progress");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("concurrency lost");
  });

  test("in_progress → ready_to_merge loses to sibling writer (re-read shows merging)", async () => {
    seedState("in_progress", 200);
    const original = repo.getState.bind(repo);
    let calls = 0;
    repo.getState = ((branch: string) => {
      calls += 1;
      if (calls === 1) return original(branch); // top-of-tick: real
      if (calls === 2) {
        return {
          memberBranch: branch,
          state: "merging",
          note: null,
          transitionedAt: 50,
          transitionedBy: "cron",
          baseSha: null,
          conflictSha: null,
        };
      }
      return original(branch);
    }) as typeof repo.getState;
    const r = await performMerge(baseCtx());
    expect(r.state).toBe("merging");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("concurrency lost");
  });

  test("ready_to_merge → merging entry loses to sibling: short-circuit before merge fires", async () => {
    seedState("ready_to_merge", 120);
    const original = repo.getState.bind(repo);
    let calls = 0;
    repo.getState = ((branch: string) => {
      calls += 1;
      if (calls === 1) return original(branch); // top-of-tick: real
      if (calls === 2) {
        return {
          memberBranch: branch,
          state: "merging",
          note: null,
          transitionedAt: 50,
          transitionedBy: "cron",
          baseSha: null,
          conflictSha: null,
        };
      }
      return original(branch);
    }) as typeof repo.getState;
    let gitCalls = 0;
    const gitSpy: GitSpawn = async () => {
      gitCalls += 1;
      return spawnOk("");
    };
    const r = await performMerge(baseCtx({ git: gitSpy }));
    expect(r.state).toBe("merging");
    expect(r.changed).toBe(false);
    // Concurrency-loss short-circuited BEFORE the actual merge.
    expect(gitCalls).toBe(0);
  });

  test("transitioned_by attribution: ctx.by flows through to merger_state row", async () => {
    // Custom `by` value should land in the row's transitioned_by
    // column. Cron-backstop attribution surface.
    const r = await performMerge(baseCtx({ by: "cron" }));
    expect(r.changed).toBe(true);
    const row = repo.getState(MEMBER_BRANCH);
    expect(row?.transitionedBy).toBe("cron");
  });
});

// ---------- Non-conflict merge throw ----------

describe("performMerge — non-conflict merge throw", () => {
  test("git failure that ISN'T a MergeConflictError propagates after merging-state durable write", async () => {
    seedState("ready_to_merge", 120);
    // Git stub that fails the BRANCH-EXISTS guard (rev-parse
    // --verify returns non-zero) — mergeMember throws ConfigError,
    // NOT MergeConflictError. The wrapper rethrows; row stays in
    // `merging` for operator inspection.
    const gitFail: GitSpawn = async (argv) => {
      if (argv.includes("status") && argv.includes("--porcelain")) {
        return spawnOk("");
      }
      if (argv.includes("rev-parse") && argv.includes("--verify")) {
        return spawnFail("", "fatal: ambiguous", 128);
      }
      return spawnOk("");
    };
    await expect(performMerge(baseCtx({ git: gitFail }))).rejects.toThrow();
    // Row left in `merging` per the durable-signal-first invariant
    // (ADR-134 §Conflict surface §1).
    expect(repo.getState(MEMBER_BRANCH)?.state).toBe("merging");
  });
});

// ---------- Caller-driven holding states ----------

describe("performMerge — caller-driven holding states", () => {
  test.each([
    ["rebasing"],
    ["tested"],
    ["test_failed"],
  ] as const)("'%s' is caller-driven → no-op with 'waiting on outer wiring' reason", async (holding) => {
    seedState(holding, 200);
    const r = await performMerge(baseCtx());
    expect(r.state).toBe(holding);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("caller-driven");
  });
});

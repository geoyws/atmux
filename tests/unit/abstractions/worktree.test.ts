// Unit tests for src/abstractions/worktree.ts (ADR-082 W1 / t-0b25c26b).
//
// Coverage strategy:
//   - resolveWorktreePath / listManagedWorktrees — pure (or fs-only),
//     test via tmp dirs + the actual exported function.
//   - provisionWorktree / pruneWorktree / isWorktreeDirty — git-bound,
//     test via injected `GitSpawn` mocks asserting argv shape + each
//     branch of the decision tree (idempotent no-op, wrong-branch
//     throw, dirty-skip, missing-no-op, real `git --version` smoke).
//   - One real-git integration in defaultGitSpawn to prove the wire
//     spawns + returns SpawnResult shape (mirrors auto-done.test.ts).
//
// No real `git worktree add` invocations — those would need a tmp repo
// with commits, branches, AND a worktree directory; the mock-injected
// argv/exit shape covers the same decision logic at lower cost.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import {
  defaultGitSpawn,
  deleteWorktreeBranch,
  type GitSpawn,
  initSubmodules,
  isWorktreeDirty,
  listManagedWorktrees,
  provisionWorktree,
  pruneWorktree,
  resolveWorktreePath,
  sanitizeBranchSegment,
} from "../../../src/abstractions/worktree.ts";
import { ConfigError } from "../../../src/errors.ts";

// ---------- Helpers ----------

function ok(stdout = ""): SpawnResult {
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

function fail(stderr: string, code = 128): SpawnResult {
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

/** Build a porcelain `git worktree list` block for a single worktree
 *  on `branch` (or detached when `branch` is null). Used to stub the
 *  initial branch-detection call in provisionWorktree tests. */
function porcelainBlock(path: string, branch: string | null): string {
  const head = "HEAD 0000000000000000000000000000000000000000";
  return branch === null
    ? `worktree ${path}\n${head}\ndetached\n`
    : `worktree ${path}\n${head}\nbranch refs/heads/${branch}\n`;
}

// ---------- defaultGitSpawn (smoke) ----------

describe("defaultGitSpawn", () => {
  test("real-spawn round-trip — `git --version` returns exit 0 + non-empty stdout", async () => {
    const r = await defaultGitSpawn(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/^git version /);
  });
});

// ---------- resolveWorktreePath ----------

describe("resolveWorktreePath", () => {
  test("default worktreeRoot resolves under <projectRoot>/.atmux/worktrees/<member>/", () => {
    const path = resolveWorktreePath({}, "alice", "/srv/repo/.atmux");
    expect(path).toBe("/srv/repo/.atmux/worktrees/alice");
  });

  test("explicit relative worktreeRoot anchors at project root, not atmuxDir", () => {
    // worktreeRoot is documented as relative-to-project-root, so a
    // value of `.worktrees-custom` resolves to `<projectRoot>/.worktrees-custom/<member>/`
    // — NOT `<projectRoot>/.atmux/.worktrees-custom/<member>/`.
    const path = resolveWorktreePath(
      { worktreeRoot: ".worktrees-custom" },
      "bob",
      "/srv/repo/.atmux",
    );
    expect(path).toBe("/srv/repo/.worktrees-custom/bob");
  });

  test("absolute worktreeRoot passes through verbatim", () => {
    const path = resolveWorktreePath(
      { worktreeRoot: "/scratch/worktrees" },
      "carol",
      "/srv/repo/.atmux",
    );
    expect(path).toBe("/scratch/worktrees/carol");
  });

  test("atmuxDir without trailing /.atmux still resolves member subdir under root", () => {
    // Edge case: atmuxDir is the canonical `.atmux/` form but a caller
    // might hand-craft a different shape. The replacement regex strips
    // a trailing /.atmux/? only — paths that don't match degrade to
    // joining the relative root verbatim, which the caller can audit.
    const path = resolveWorktreePath({}, "dave", "/srv/repo");
    expect(path).toBe("/srv/repo/.atmux/worktrees/dave");
  });
});

// ---------- provisionWorktree ----------

describe("provisionWorktree", () => {
  // ADR-084: per-member branch model. provisionWorktree is now
  // 5-arg `(repoPath, baseBranch, wtBranch, worktreePath, opts)`:
  // each member's worktree lives on its own branch
  // `${baseBranch}-${sanitizeBranchSegment(member.name)}` forked off
  // the operator's base branch. Decision sequence is:
  //   (a) `worktree list --porcelain` → check for existing worktree at path.
  //   (b) if absent: `rev-parse --verify --quiet refs/heads/<wtBranch>` →
  //       branch exists?
  //   (c) `worktree add -b <wtBranch> <path> <baseBranch>` when fresh,
  //       OR `worktree add <path> <wtBranch>` when wtBranch already exists
  //       from a prior run (idempotence across `atmux stop` + `start`).
  //
  // The mock matrix below mirrors that three-call shape for the absent
  // path and short-circuits at (a) for the present-on-wtBranch reuse.

  test("worktree absent + wtBranch absent → `worktree add -b` creates branch + worktree atomically", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) {
        // Branch doesn't exist yet — exit non-zero (matches git's
        // `rev-parse --verify --quiet` contract on missing ref).
        return fail("", 1);
      }
      // list → empty; add → success.
      return ok("");
    };
    const result = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      { git },
    );
    expect(result).toEqual({ created: true, path: "/repo/.atmux/worktrees/alice" });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["-C", "/repo", "worktree", "list", "--porcelain"]);
    expect(calls[1]).toEqual([
      "-C",
      "/repo",
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/heads/geoyws-alice",
    ]);
    // Fresh-branch path: `-b <wtBranch> <wtPath> <baseBranch>` so git
    // forks `geoyws-alice` off `geoyws` and checks it out at the wt
    // path in one atomic call.
    expect(calls[2]).toEqual([
      "-C",
      "/repo",
      "worktree",
      "add",
      "-b",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      "geoyws",
    ]);
  });

  test("worktree absent + wtBranch exists → `worktree add` reuses the existing branch (no -b)", async () => {
    // Idempotence across runs: if a prior `atmux start` created
    // `geoyws-alice` and then `atmux stop --force` pruned the worktree
    // but left the branch (default per ADR-084 OQ-2), the next start
    // re-attaches the existing branch — no `-b` flag (git would error
    // `fatal: A branch named '<wtBranch>' already exists`).
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return ok(""); // branch exists
      return ok("");
    };
    const result = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      { git },
    );
    expect(result).toEqual({ created: true, path: "/repo/.atmux/worktrees/alice" });
    expect(calls).toHaveLength(3);
    // Reuse path: bare `worktree add <wtPath> <wtBranch>` — no -b.
    expect(calls[2]).toEqual([
      "-C",
      "/repo",
      "worktree",
      "add",
      "/repo/.atmux/worktrees/alice",
      "geoyws-alice",
    ]);
  });

  test("worktree present on correct wtBranch → idempotent no-op {created:false}", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok(porcelainBlock("/repo/.atmux/worktrees/alice", "geoyws-alice"));
    };
    const result = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      { git },
    );
    expect(result).toEqual({ created: false, path: "/repo/.atmux/worktrees/alice" });
    // Only the list call — no rev-parse, no add.
    expect(calls).toHaveLength(1);
  });

  test("worktree present on baseBranch (operator hand-attached) → throws ConfigError naming the wtBranch", async () => {
    // Worktree exists but checked out on the operator's root branch
    // (e.g. operator ran `git checkout geoyws` inside the worktree).
    // Treat as drift — won't auto-reconcile per ADR-082 §3.
    const git: GitSpawn = async () => ok(porcelainBlock("/repo/.atmux/worktrees/alice", "geoyws"));
    await expect(
      provisionWorktree("/repo", "geoyws", "geoyws-alice", "/repo/.atmux/worktrees/alice", {
        git,
      }),
    ).rejects.toThrow(ConfigError);
    await expect(
      provisionWorktree("/repo", "geoyws", "geoyws-alice", "/repo/.atmux/worktrees/alice", {
        git,
      }),
    ).rejects.toThrow(/expected branch 'geoyws-alice'/);
  });

  test("worktree present on a DIFFERENT branch → ConfigError surfaces the detected branch", async () => {
    const git: GitSpawn = async () => ok(porcelainBlock("/repo/.atmux/worktrees/alice", "main"));
    await expect(
      provisionWorktree("/repo", "geoyws", "geoyws-alice", "/repo/.atmux/worktrees/alice", {
        git,
      }),
    ).rejects.toThrow(/branch 'main'/);
  });

  test("worktree present on detached HEAD → ConfigError surfaces 'detached HEAD'", async () => {
    const git: GitSpawn = async () => ok(porcelainBlock("/repo/.atmux/worktrees/alice", null));
    await expect(
      provisionWorktree("/repo", "geoyws", "geoyws-alice", "/repo/.atmux/worktrees/alice", {
        git,
      }),
    ).rejects.toThrow(/detached HEAD/);
  });

  test("`git worktree list` failure → throws ConfigError with stderr hint", async () => {
    const git: GitSpawn = async () => fail("fatal: not a git repository");
    await expect(
      provisionWorktree("/not-a-repo", "geoyws", "geoyws-alice", "/not-a-repo/wt/alice", {
        git,
      }),
    ).rejects.toThrow(/`git worktree list` failed/);
  });

  test("`git worktree add` failure → throws ConfigError surfacing stderr", async () => {
    let call = 0;
    const git: GitSpawn = async () => {
      call += 1;
      // 1: list (empty), 2: rev-parse (branch absent), 3: add (fails).
      if (call === 1) return ok("");
      if (call === 2) return fail("", 1);
      return fail("fatal: invalid reference: geoyws");
    };
    await expect(
      provisionWorktree("/repo", "geoyws", "geoyws-alice", "/repo/wt/alice", { git }),
    ).rejects.toThrow(/`git worktree add` failed/);
  });

  test("porcelain list with multiple worktrees finds the matching one by path", async () => {
    // alice + bob are atmux-provisioned per-member worktrees on their
    // own branches; `/repo` is the operator's root checkout on `geoyws`.
    const stdout = [
      porcelainBlock("/repo", "geoyws"),
      porcelainBlock("/repo/.atmux/worktrees/alice", "geoyws-alice"),
      porcelainBlock("/repo/.atmux/worktrees/bob", "geoyws-bob"),
    ].join("\n");
    const git: GitSpawn = async () => ok(stdout);
    const result = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-bob",
      "/repo/.atmux/worktrees/bob",
      { git },
    );
    expect(result).toEqual({ created: false, path: "/repo/.atmux/worktrees/bob" });
  });
});

// ---------- sanitizeBranchSegment ----------

describe("sanitizeBranchSegment", () => {
  test("kebab-case ASCII passes through unchanged", () => {
    expect(sanitizeBranchSegment("up-impl")).toBe("up-impl");
    expect(sanitizeBranchSegment("parity-state-impl")).toBe("parity-state-impl");
    expect(sanitizeBranchSegment("reviewer")).toBe("reviewer");
  });

  test("alphanumeric + underscore + hyphen passes through unchanged", () => {
    expect(sanitizeBranchSegment("worker_1")).toBe("worker_1");
    expect(sanitizeBranchSegment("w1-impl")).toBe("w1-impl");
    expect(sanitizeBranchSegment("ABC-xyz_42")).toBe("ABC-xyz_42");
  });

  test("emoji + unicode → replaced with `-` (git refuses invalid refnames)", () => {
    expect(sanitizeBranchSegment("🐝w1")).toBe("--w1"); // emoji is 2 UTF-16 units
    expect(sanitizeBranchSegment("café-runner")).toBe("caf--runner");
  });

  test("spaces + dots + slashes → replaced with `-`", () => {
    expect(sanitizeBranchSegment("name with spaces")).toBe("name-with-spaces");
    expect(sanitizeBranchSegment("a.b.c")).toBe("a-b-c");
    expect(sanitizeBranchSegment("nested/path")).toBe("nested-path");
  });
});

// ---------- initSubmodules (ADR-088) ----------

describe("initSubmodules", () => {
  test("invokes `git submodule update --init --recursive` at wtPath", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    await initSubmodules("/wt/alice", { git });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["-C", "/wt/alice", "submodule", "update", "--init", "--recursive"]);
  });

  test("non-zero exit warns but does NOT throw (best-effort)", async () => {
    const warnings: string[] = [];
    const git: GitSpawn = async () => fail("fatal: clone failed for submodule 'foo'", 1);
    // Should NOT throw — we want warn-and-continue semantics.
    await expect(
      initSubmodules("/wt/alice", {
        git,
        warn: (m) => {
          warnings.push(m);
        },
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("initSubmodules");
    expect(warnings[0]).toContain("rc=1");
    expect(warnings[0]).toContain("clone failed for submodule 'foo'");
    expect(warnings[0]).toContain("/wt/alice");
  });

  test("rc=0 + empty stdout (no submodules in repo) is a silent no-op", async () => {
    const warnings: string[] = [];
    const git: GitSpawn = async () => ok("");
    await initSubmodules("/wt/alice", {
      git,
      warn: (m) => {
        warnings.push(m);
      },
    });
    expect(warnings).toHaveLength(0);
  });

  test("idempotent — second call also runs submodule update (git short-circuits internally)", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    await initSubmodules("/wt/alice", { git });
    await initSubmodules("/wt/alice", { git });
    expect(calls).toHaveLength(2);
    // Same argv both times — caller signature is idempotent.
    expect(calls[0]).toEqual(calls[1]);
  });
});

// ---------- provisionWorktree + initSubmodules opt-in (ADR-088) ----------

describe("provisionWorktree initSubmodules opt-in", () => {
  test("provisionWorktree({initSubmodules: false}) does NOT call submodule update", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return fail("", 1); // branch absent
      return ok("");
    };
    const r = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      { git, initSubmodules: false },
    );
    expect(r.created).toBe(true);
    expect(calls.some((c) => c.includes("submodule"))).toBe(false);
  });

  test("provisionWorktree({initSubmodules: true}) calls submodule update once after worktree-add", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return fail("", 1);
      return ok("");
    };
    const r = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      { git, initSubmodules: true },
    );
    expect(r.created).toBe(true);
    const subCalls = calls.filter((c) => c.includes("submodule"));
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]).toEqual([
      "-C",
      "/repo/.atmux/worktrees/alice",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    // Submodule call comes AFTER worktree add (it's the last call).
    expect(calls[calls.length - 1]).toBe(subCalls[0]);
  });

  test("provisionWorktree idempotent no-op path (worktree already present on wtBranch) does NOT call submodule update", async () => {
    // Pre-existing worktree on the requested branch → `created: false`.
    // ADR-088 §"Implementation surface": don't reach into operator state.
    const stdout = porcelainBlock("/repo/.atmux/worktrees/bob", "geoyws-bob");
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok(stdout);
    };
    const r = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-bob",
      "/repo/.atmux/worktrees/bob",
      { git, initSubmodules: true },
    );
    expect(r.created).toBe(false);
    expect(calls.some((c) => c.includes("submodule"))).toBe(false);
  });

  test("submodule update failure does NOT abort the provision (warn-and-continue)", async () => {
    const warnings: string[] = [];
    const git: GitSpawn = async (argv) => {
      if (argv.includes("rev-parse")) return fail("", 1);
      if (argv.includes("submodule")) return fail("fatal: clone failed for submodule 'bar'", 1);
      return ok("");
    };
    const r = await provisionWorktree(
      "/repo",
      "geoyws",
      "geoyws-alice",
      "/repo/.atmux/worktrees/alice",
      {
        git,
        initSubmodules: true,
        warn: (m) => {
          warnings.push(m);
        },
      },
    );
    expect(r.created).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("clone failed for submodule 'bar'");
  });
});

// ---------- pruneWorktree ----------

describe("pruneWorktree", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-worktree-prune-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("path absent → idempotent no-op {pruned:false, reason:'missing'}", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    const result = await pruneWorktree("/repo", join(scratch, "ghost"), { git });
    expect(result).toEqual({ pruned: false, reason: "missing" });
    // No git invocation — the existence check short-circuits.
    expect(calls).toHaveLength(0);
  });

  test("path present + dirty + dirty='skip' (default) → {pruned:false, reason:'dirty'}", async () => {
    const wt = join(scratch, "alice");
    await mkdir(wt, { recursive: true });
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      // status --porcelain returns a single dirty entry → non-empty stdout.
      return ok("?? new-file.txt\n");
    };
    const result = await pruneWorktree("/repo", wt, { git });
    expect(result).toEqual({ pruned: false, reason: "dirty" });
    // Only the status call — no `worktree remove`.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["-C", wt, "status", "--porcelain"]);
  });

  test("path present + clean + skip → fires `git worktree remove` (no --force)", async () => {
    const wt = join(scratch, "alice");
    await mkdir(wt, { recursive: true });
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    const result = await pruneWorktree("/repo", wt, { git });
    expect(result).toEqual({ pruned: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["-C", wt, "status", "--porcelain"]);
    expect(calls[1]).toEqual(["-C", "/repo", "worktree", "remove", wt]);
  });

  test("path present + dirty + dirty='force' → fires `git worktree remove --force` (skips status check)", async () => {
    const wt = join(scratch, "alice");
    await mkdir(wt, { recursive: true });
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("");
    };
    const result = await pruneWorktree("/repo", wt, { git, dirty: "force" });
    expect(result).toEqual({ pruned: true });
    // Force mode skips the status pre-check.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["-C", "/repo", "worktree", "remove", "--force", wt]);
  });

  test("`git worktree remove` failure → throws ConfigError surfacing stderr", async () => {
    const wt = join(scratch, "alice");
    await mkdir(wt, { recursive: true });
    let call = 0;
    const git: GitSpawn = async () => {
      call += 1;
      // status clean, then remove fails.
      return call === 1 ? ok("") : fail("fatal: 'alice' is locked");
    };
    await expect(pruneWorktree("/repo", wt, { git })).rejects.toThrow(
      /`git worktree remove` failed/,
    );
  });
});

// ---------- isWorktreeDirty ----------

describe("isWorktreeDirty", () => {
  test("clean worktree (empty status output) → false", async () => {
    const git: GitSpawn = async () => ok("");
    expect(await isWorktreeDirty("/wt/alice", { git })).toBe(false);
  });

  test("dirty worktree (one modified path) → true", async () => {
    const git: GitSpawn = async () => ok(" M src/foo.ts\n");
    expect(await isWorktreeDirty("/wt/alice", { git })).toBe(true);
  });

  test("dirty worktree (untracked only) → true", async () => {
    const git: GitSpawn = async () => ok("?? scratch.log\n");
    expect(await isWorktreeDirty("/wt/alice", { git })).toBe(true);
  });

  test("trailing whitespace + blank lines don't false-positive (porcelain output trimmed)", async () => {
    const git: GitSpawn = async () => ok("\n   \n");
    expect(await isWorktreeDirty("/wt/alice", { git })).toBe(false);
  });

  test("`git status` failure → throws ConfigError", async () => {
    const git: GitSpawn = async () => fail("fatal: not a git repository");
    await expect(isWorktreeDirty("/not-a-wt", { git })).rejects.toThrow(ConfigError);
    await expect(isWorktreeDirty("/not-a-wt", { git })).rejects.toThrow(/`git status` failed/);
  });
});

// ---------- deleteWorktreeBranch ----------

describe("deleteWorktreeBranch", () => {
  test("`git branch -d` exits 0 → {deleted:true}", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("Deleted branch geoyws-alice (was abc1234).\n");
    };
    const result = await deleteWorktreeBranch("/repo", "geoyws-alice", { git });
    expect(result).toEqual({ deleted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["-C", "/repo", "branch", "-d", "geoyws-alice"]);
  });

  test("`not fully merged` stderr → {deleted:false, reason:'unmerged'} (no throw)", async () => {
    const git: GitSpawn = async () =>
      fail(
        "error: the branch 'geoyws-alice' is not fully merged.\n" +
          "If you are sure you want to delete it, run 'git branch -D geoyws-alice'.\n",
        1,
      );
    const result = await deleteWorktreeBranch("/repo", "geoyws-alice", { git });
    expect(result).toEqual({ deleted: false, reason: "unmerged" });
  });

  test("`branch not found` stderr → {deleted:false, reason:'missing'} (idempotent re-run)", async () => {
    const git: GitSpawn = async () => fail("error: branch 'geoyws-alice' not found.\n", 1);
    const result = await deleteWorktreeBranch("/repo", "geoyws-alice", { git });
    expect(result).toEqual({ deleted: false, reason: "missing" });
  });

  test("unrecognised git failure → throws ConfigError surfacing stderr", async () => {
    const git: GitSpawn = async () => fail("fatal: not a git repository", 128);
    await expect(deleteWorktreeBranch("/not-a-repo", "geoyws-alice", { git })).rejects.toThrow(
      ConfigError,
    );
    await expect(deleteWorktreeBranch("/not-a-repo", "geoyws-alice", { git })).rejects.toThrow(
      /`git branch -d geoyws-alice` failed/,
    );
  });

  test("safe-mode: argv never includes -D (destructive) — only -d", async () => {
    // Documents the ADR-084 OQ2 invariant: this helper only offers safe
    // delete. `-D` is operator-manual per
    // feedback_destructive_ops_need_explicit_auth.md.
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok();
    };
    await deleteWorktreeBranch("/repo", "geoyws-alice", { git });
    expect(calls[0]).toContain("-d");
    expect(calls[0]).not.toContain("-D");
  });
});

// ---------- listManagedWorktrees ----------

describe("listManagedWorktrees", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-list-managed-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("worktrees dir absent → returns [] (no-error)", async () => {
    // No `.atmux/worktrees/` yet — pre-first-`atmux start` on an
    // isolation team. Must NOT throw.
    const result = await listManagedWorktrees("/repo", scratch);
    expect(result).toEqual([]);
  });

  test("worktrees dir empty → returns []", async () => {
    await mkdir(join(scratch, "worktrees"), { recursive: true });
    const result = await listManagedWorktrees("/repo", scratch);
    expect(result).toEqual([]);
  });

  test("returns absolute paths for each immediate subdirectory", async () => {
    const wtRoot = join(scratch, "worktrees");
    await mkdir(join(wtRoot, "alice"), { recursive: true });
    await mkdir(join(wtRoot, "bob"), { recursive: true });
    const result = await listManagedWorktrees("/repo", scratch);
    expect(result.sort()).toEqual([join(wtRoot, "alice"), join(wtRoot, "bob")]);
  });

  test("ignores files (only immediate subdirectories returned)", async () => {
    const wtRoot = join(scratch, "worktrees");
    await mkdir(wtRoot, { recursive: true });
    await mkdir(join(wtRoot, "alice"), { recursive: true });
    await writeFile(join(wtRoot, "stray.txt"), "not a worktree");
    const result = await listManagedWorktrees("/repo", scratch);
    expect(result).toEqual([join(wtRoot, "alice")]);
  });
});

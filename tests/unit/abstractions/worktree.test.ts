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
import {
  defaultGitSpawn,
  type GitSpawn,
  isWorktreeDirty,
  listManagedWorktrees,
  provisionWorktree,
  pruneWorktree,
  resolveWorktreePath,
} from "../../../src/abstractions/worktree.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
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
  test("worktree absent → fires `git worktree add` and returns {created:true}", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      // First call: `worktree list` → empty (nothing managed yet).
      // Second call: `worktree add` → success.
      return ok("");
    };
    const result = await provisionWorktree("/repo", "geoyws", "/repo/.atmux/worktrees/alice", {
      git,
    });
    expect(result).toEqual({ created: true, path: "/repo/.atmux/worktrees/alice" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["-C", "/repo", "worktree", "list", "--porcelain"]);
    expect(calls[1]).toEqual([
      "-C",
      "/repo",
      "worktree",
      "add",
      "/repo/.atmux/worktrees/alice",
      "geoyws",
    ]);
  });

  test("worktree present on correct branch → idempotent no-op {created:false}", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok(porcelainBlock("/repo/.atmux/worktrees/alice", "geoyws"));
    };
    const result = await provisionWorktree("/repo", "geoyws", "/repo/.atmux/worktrees/alice", {
      git,
    });
    expect(result).toEqual({ created: false, path: "/repo/.atmux/worktrees/alice" });
    // Only the list call — no `worktree add` followup.
    expect(calls).toHaveLength(1);
  });

  test("worktree present on WRONG branch → throws ConfigError (no auto-checkout per ADR-082 §3)", async () => {
    const git: GitSpawn = async () =>
      ok(porcelainBlock("/repo/.atmux/worktrees/alice", "main"));
    await expect(
      provisionWorktree("/repo", "geoyws", "/repo/.atmux/worktrees/alice", { git }),
    ).rejects.toThrow(ConfigError);
    await expect(
      provisionWorktree("/repo", "geoyws", "/repo/.atmux/worktrees/alice", { git }),
    ).rejects.toThrow(/branch 'main'/);
  });

  test("worktree present on detached HEAD treated as wrong-branch (mismatch from requested branch)", async () => {
    const git: GitSpawn = async () =>
      ok(porcelainBlock("/repo/.atmux/worktrees/alice", null));
    await expect(
      provisionWorktree("/repo", "geoyws", "/repo/.atmux/worktrees/alice", { git }),
    ).rejects.toThrow(ConfigError);
  });

  test("`git worktree list` failure → throws ConfigError with stderr hint", async () => {
    const git: GitSpawn = async () => fail("fatal: not a git repository");
    await expect(
      provisionWorktree("/not-a-repo", "geoyws", "/not-a-repo/wt/alice", { git }),
    ).rejects.toThrow(/`git worktree list` failed/);
  });

  test("`git worktree add` failure → throws ConfigError surfacing stderr", async () => {
    let call = 0;
    const git: GitSpawn = async () => {
      call += 1;
      // First call (list) succeeds with empty output; second (add) fails.
      return call === 1 ? ok("") : fail("fatal: invalid reference: geoyws");
    };
    await expect(
      provisionWorktree("/repo", "geoyws", "/repo/wt/alice", { git }),
    ).rejects.toThrow(/`git worktree add` failed/);
  });

  test("porcelain list with multiple worktrees finds the matching one by path", async () => {
    const stdout = [
      porcelainBlock("/repo", "main"),
      porcelainBlock("/repo/.atmux/worktrees/alice", "geoyws"),
      porcelainBlock("/repo/.atmux/worktrees/bob", "feature-x"),
    ].join("\n");
    const git: GitSpawn = async () => ok(stdout);
    const result = await provisionWorktree(
      "/repo",
      "feature-x",
      "/repo/.atmux/worktrees/bob",
      { git },
    );
    expect(result).toEqual({ created: false, path: "/repo/.atmux/worktrees/bob" });
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

// Unit tests for src/abstractions/branch-merge.ts (ADR-179 W1 / t-bed51da2).
//
// Coverage strategy mirrors worktree.test.ts:
//   - Mock GitSpawn that records every argv it sees and scripts the
//     exit code / stdout / stderr per-call so each test pins the exact
//     decision-tree branch.
//   - One real-git smoke against `defaultGitSpawn` to prove the wire.
//
// The decision tree under test:
//   (A) dirty repoPath          → ConfigError
//   (B) missing wtBranch        → ConfigError
//   (C) 0 commits ahead         → { status: 'no-op', reason: 'no-commits-ahead' }
//   (D) clean fast-forward      → { status: 'merged', sha }
//   (E) clean --no-ff (default) → { status: 'merged', sha }
//   (F) conflict                → MergeConflictError + abort fired
//
// Mock-injected GitSpawn covers (A)–(F); no real `git merge` runs in
// the unit suite (an end-to-end merge would need a tmp repo with
// branches + commits + a worktree, which W8's e2e test owns).

import { describe, expect, test } from "bun:test";
import {
  defaultGitSpawn,
  type GitSpawn,
  MergeConflictError,
  mergeMember,
} from "../../../src/abstractions/branch-merge.ts";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { ConfigError } from "../../../src/errors.ts";

// ---------- SpawnResult helpers ----------

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

function fail(stderr: string, code = 128, stdout = ""): SpawnResult {
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

/** Build a scripted GitSpawn from a matcher function. The function
 *  receives the argv and returns a SpawnResult — the test author
 *  branches on argv contents. Returns the mock + a calls array so
 *  tests can assert the full call sequence. */
function scriptedGit(matcher: (argv: ReadonlyArray<string>) => SpawnResult): {
  git: GitSpawn;
  calls: ReadonlyArray<string>[];
} {
  const calls: ReadonlyArray<string>[] = [];
  const git: GitSpawn = async (argv) => {
    calls.push(argv);
    return matcher(argv);
  };
  return { git, calls };
}

const TEAM_BASE = "geoyws";
const WT_BRANCH = "geoyws-alpha";
const REPO_PATH = "/srv/repo";
const POST_MERGE_SHA = "abc123def4567890abc123def4567890abc123de";

// ---------- defaultGitSpawn smoke ----------

describe("defaultGitSpawn", () => {
  test("real-spawn round-trip — `git --version` returns exit 0 + non-empty stdout", async () => {
    const r = await defaultGitSpawn(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
  });
});

// ---------- (A) guardBaseWorktreeClean ----------

describe("guardBaseWorktreeClean — dirty repoPath refuses", () => {
  test("staged change → ConfigError with 'uncommitted changes'", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("M  src/foo.ts\n");
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  test("unstaged change → ConfigError refuses merge", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok(" M src/foo.ts\n");
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(ConfigError);
  });

  test("untracked file → ConfigError refuses merge", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("?? scratch.md\n");
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  test("status command itself fails → ConfigError with non-zero exit detail", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return fail("fatal: not a git repository", 128);
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/'git status' failed/);
  });

  test("clean repoPath proceeds past the first guard", async () => {
    // Drive ALL the way through to the no-commits-ahead exit so we
    // know the first guard didn't trip.
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok(""); // clean
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok(""); // branch exists
      if (argv.includes("rev-list")) return ok("0\n"); // 0 commits ahead → no-op
      return fail("unexpected call", 1);
    });
    const r = await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    expect(r.status).toBe("no-op");
    // Verify the first call WAS the status guard (so the function did
    // exercise it before reaching no-op).
    expect(calls[0]).toContain("status");
  });
});

// ---------- (B) guardBranchExists ----------

describe("guardBranchExists — missing wtBranch refuses", () => {
  test("rev-parse non-zero → ConfigError with branch name", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return fail("", 1);
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/branch 'geoyws-alpha' not found/);
  });

  test("guard fires AFTER clean-worktree guard (sequencing)", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse")) return fail("", 1);
      return ok("");
    });
    try {
      await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    } catch {
      // expected
    }
    // Call order: status (clean) → rev-parse --verify (fail) → stop.
    expect(calls[0]).toContain("status");
    expect(calls[1]).toContain("rev-parse");
    expect(calls.length).toBe(2);
  });

  test("rev-parse 'refs/heads/<branch>' shape — argv carries full ref path", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse")) return fail("", 1);
      return ok("");
    });
    try {
      await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    } catch {
      // expected
    }
    const revParseCall = calls.find((c) => c.includes("rev-parse"));
    expect(revParseCall).toContain(`refs/heads/${WT_BRANCH}`);
    expect(revParseCall).toContain("--verify");
  });
});

// ---------- (C) guardCommitsAhead → no-op ----------

describe("guardCommitsAhead — zero commits ahead returns no-op without mutation", () => {
  test("rev-list count=0 → { status: 'no-op', reason: 'no-commits-ahead' }", async () => {
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("0\n");
      return fail("should not have been called", 1);
    });
    const r = await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    expect(r).toEqual({ status: "no-op", reason: "no-commits-ahead" });
    // Verify NO checkout / merge / fetch followed
    const verbs = calls.map((c) => c[1]).filter((v) => v !== "-C");
    // Argv shape is ["-C", "<path>", "<verb>", ...] so verb is index 2;
    // grab via index after the path filter:
    const ranVerbs = calls.map((c) => c[2]);
    expect(ranVerbs).not.toContain("checkout");
    expect(ranVerbs).not.toContain("merge");
    expect(ranVerbs).not.toContain("fetch");
    void verbs;
  });

  test("rev-list failure → ConfigError", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return fail("fatal: bad revision", 128);
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/'git rev-list --count geoyws\.\.geoyws-alpha' failed/);
  });
});

// ---------- (D)+(E) clean merge path ----------

describe("mergeMember — clean merge path", () => {
  function happyPathGit(opts: { aheadCount: number; sha: string }): {
    git: GitSpawn;
    calls: ReadonlyArray<string>[];
  } {
    return scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok(`${opts.aheadCount}\n`);
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("checkout")) return ok("");
      if (argv.includes("merge") && !argv.includes("--abort")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("HEAD")) return ok(`${opts.sha}\n`);
      return fail("unexpected call", 1);
    });
  }

  test("commits ahead → checkout + merge --no-ff + rev-parse HEAD → { status: 'merged', sha }", async () => {
    const { git } = happyPathGit({ aheadCount: 3, sha: POST_MERGE_SHA });
    const r = await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    expect(r.status).toBe("merged");
    if (r.status === "merged") {
      expect(r.sha).toBe(POST_MERGE_SHA);
    }
  });

  test("call sequence — status → rev-parse-verify → rev-list → checkout → merge → rev-parse-HEAD", async () => {
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    const verbs = calls.map((c) => c[2]);
    expect(verbs).toEqual([
      "status",
      "rev-parse", // --verify guard
      "rev-list",
      "checkout",
      "merge",
      "rev-parse", // HEAD post-merge
    ]);
  });

  test("--no-ff flag is on the merge invocation", async () => {
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    const mergeCall = calls.find((c) => c.includes("merge") && !c.includes("--abort"));
    expect(mergeCall).toContain("--no-ff");
    expect(mergeCall).toContain(WT_BRANCH);
  });

  test("merge commit message follows ADR-179 shape", async () => {
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    const mergeCall = calls.find((c) => c.includes("merge") && !c.includes("--abort"));
    // argv after -m holds the message
    const msgIdx = (mergeCall ?? []).indexOf("-m");
    expect(msgIdx).toBeGreaterThan(-1);
    const msg = mergeCall?.[msgIdx + 1] ?? "";
    expect(msg).toBe(`merge(alpha): fan-in ${WT_BRANCH} per ADR-179`);
  });

  test("wtBranch that doesn't follow `<base>-<member>` shape — member derives to full wtBranch", async () => {
    const customBranch = "feature-X";
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, customBranch, REPO_PATH, { git, fetch: false });
    const mergeCall = calls.find((c) => c.includes("merge") && !c.includes("--abort"));
    const msgIdx = (mergeCall ?? []).indexOf("-m");
    const msg = mergeCall?.[msgIdx + 1] ?? "";
    expect(msg).toBe(`merge(feature-X): fan-in feature-X per ADR-179`);
  });

  test("every git call routes through `-C <repoPath>`", async () => {
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    for (const call of calls) {
      expect(call[0]).toBe("-C");
      expect(call[1]).toBe(REPO_PATH);
    }
  });

  test("fetch=true (default) fires `git fetch origin <base>` before checkout", async () => {
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git /* fetch defaults true */ });
    const fetchCall = calls.find((c) => c.includes("fetch"));
    expect(fetchCall).toBeDefined();
    expect(fetchCall).toContain("origin");
    expect(fetchCall).toContain(TEAM_BASE);
  });

  test("fetch=false skips the network call", async () => {
    const { git, calls } = happyPathGit({ aheadCount: 1, sha: POST_MERGE_SHA });
    await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    expect(calls.find((c) => c.includes("fetch"))).toBeUndefined();
  });

  test("fetch failure → ConfigError surfaces the stderr", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("fetch")) return fail("fatal: could not resolve hostname", 128);
      return ok("");
    });
    await expect(mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git })).rejects.toThrow(
      /'git fetch origin geoyws' failed/,
    );
  });

  test("checkout failure → ConfigError surfaces the stderr", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("checkout")) return fail("error: pathspec did not match", 1);
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/'git checkout geoyws' failed/);
  });

  test("rev-parse HEAD post-merge failure → ConfigError", async () => {
    const { git } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("checkout")) return ok("");
      if (argv.includes("merge") && !argv.includes("--abort")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("HEAD")) return fail("oops", 128);
      return ok("");
    });
    await expect(
      mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false }),
    ).rejects.toThrow(/post-merge 'git rev-parse HEAD' failed/);
  });
});

// ---------- (F) Conflict path ----------

describe("mergeMember — conflict path", () => {
  test("merge non-zero rc → MergeConflictError with conflict paths + abort fired", async () => {
    let abortFired = false;
    let statusCallCount = 0;
    const git: GitSpawn = async (argv) => {
      if (argv.includes("status")) {
        statusCallCount += 1;
        // First status = clean-guard (returns clean).
        // Second status = post-merge porcelain capture (conflict markers).
        return statusCallCount === 1
          ? ok("")
          : ok("UU src/foo.ts\nAA src/bar.ts\nM  src/clean.ts\n");
      }
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("2\n");
      if (argv.includes("fetch")) return ok("");
      if (argv.includes("checkout")) return ok("");
      if (argv.includes("merge") && argv.includes("--abort")) {
        abortFired = true;
        return ok("");
      }
      if (argv.includes("merge")) return fail("CONFLICT (content)", 1);
      return fail("unexpected call", 1);
    };

    let caught: unknown;
    try {
      await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MergeConflictError);
    if (caught instanceof MergeConflictError) {
      expect(caught.wtBranch).toBe(WT_BRANCH);
      expect(caught.conflictPaths).toContain("src/foo.ts");
      expect(caught.conflictPaths).toContain("src/bar.ts");
      // Modified-but-not-conflicted file is NOT in conflictPaths
      expect(caught.conflictPaths).not.toContain("src/clean.ts");
    }
    expect(abortFired).toBe(true);
  });

  test("conflict + status fails post-merge → MergeConflictError with empty conflict paths (defensive)", async () => {
    // Defense: if porcelain status fails after the conflict, still
    // throw the error (with an empty path list) AND fire abort, not
    // crash with a secondary status error.
    let statusCallCount = 0;
    const git: GitSpawn = async (argv) => {
      if (argv.includes("status")) {
        statusCallCount += 1;
        // First status = clean-guard (clean). Second = post-merge fails.
        return statusCallCount === 1 ? ok("") : fail("oops", 128);
      }
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("checkout")) return ok("");
      if (argv.includes("merge") && argv.includes("--abort")) return ok("");
      if (argv.includes("merge")) return fail("CONFLICT", 1);
      return ok("");
    };
    let caught: unknown;
    try {
      await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MergeConflictError);
    if (caught instanceof MergeConflictError) {
      expect(caught.conflictPaths).toEqual([]);
    }
  });

  test("conflict paths include all six conflict marker codes (UU/AA/DD/AU/UA/DU/UD)", async () => {
    let statusCallCount = 0;
    const git: GitSpawn = async (argv) => {
      if (argv.includes("status")) {
        statusCallCount += 1;
        if (statusCallCount === 1) return ok(""); // clean-guard
        return ok(
          [
            "UU src/uu.ts",
            "AA src/aa.ts",
            "DD src/dd.ts",
            "AU src/au.ts",
            "UA src/ua.ts",
            "DU src/du.ts",
            "UD src/ud.ts",
            "M  src/m.ts", // not a conflict marker
            "?? src/qq.ts", // not a conflict marker
            "", // blank tail line
          ].join("\n"),
        );
      }
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("1\n");
      if (argv.includes("checkout")) return ok("");
      if (argv.includes("merge") && argv.includes("--abort")) return ok("");
      if (argv.includes("merge")) return fail("CONFLICT", 1);
      return ok("");
    };

    let caught: MergeConflictError | undefined;
    try {
      await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    } catch (e) {
      if (e instanceof MergeConflictError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught?.conflictPaths).toEqual([
      "src/uu.ts",
      "src/aa.ts",
      "src/dd.ts",
      "src/au.ts",
      "src/ua.ts",
      "src/du.ts",
      "src/ud.ts",
    ]);
  });

  test("MergeConflictError extends ConfigError + carries wtBranch + conflictPaths", () => {
    const err = new MergeConflictError({
      wtBranch: "geoyws-bob",
      conflictPaths: ["a.ts", "b.ts"],
    });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.wtBranch).toBe("geoyws-bob");
    expect(err.conflictPaths).toEqual(["a.ts", "b.ts"]);
    expect(err.message).toContain("geoyws-bob");
    expect(err.message).toContain("2 path(s)");
  });
});

// ---------- Idempotence ----------

describe("mergeMember — idempotence", () => {
  test("re-fire after successful merge returns no-op when ahead==0", async () => {
    // Simulate: first mergeMember ran successfully; on re-fire the
    // merger asks again. The wt-branch now reachable from base, so
    // rev-list count returns 0 → no-op. No checkout/merge runs.
    const { git, calls } = scriptedGit((argv) => {
      if (argv.includes("status")) return ok("");
      if (argv.includes("rev-parse") && argv.includes("--verify")) return ok("");
      if (argv.includes("rev-list")) return ok("0\n");
      return fail("should not run", 1);
    });
    const r = await mergeMember(TEAM_BASE, WT_BRANCH, REPO_PATH, { git, fetch: false });
    expect(r).toEqual({ status: "no-op", reason: "no-commits-ahead" });
    const ranVerbs = calls.map((c) => c[2]);
    expect(ranVerbs).not.toContain("checkout");
    expect(ranVerbs).not.toContain("merge");
  });
});

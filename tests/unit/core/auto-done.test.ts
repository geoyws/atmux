// Unit tests for src/core/auto-done.ts (ADR-080 §B1).
//
// Coverage (per ADR test plan + 100%-on-new-code rule):
//   - commit present in `git log --grep` → returns SHA.
//   - commit absent → returns null.
//   - malformed repoDir (does not exist) → throws ConfigError.
//   - sinceMs filter — `--since=<iso>` arg is shaped from sinceMs and
//     a no-match window resolves to null.
//   - not-a-git-repo (`git log` exit != 0) → throws ConfigError.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "../../../src/abstractions/spawn.ts";
import { defaultGitSpawn, findCommitForTask, type GitSpawn } from "../../../src/core/auto-done.ts";
import { ConfigError } from "../../../src/errors.ts";

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "atmux-auto-done-"));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

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

// ---------- defaultGitSpawn (smoke) ----------

describe("defaultGitSpawn", () => {
  test("real-spawn round-trip — `git --version` returns exit 0 + non-empty stdout", async () => {
    const r = await defaultGitSpawn(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).toMatch(/^git version /);
  });
});

// ---------- findCommitForTask ----------

describe("findCommitForTask", () => {
  test("commit present in `git log --grep` → returns SHA", async () => {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      return ok("abc123def456789012345678901234567890abcd\n");
    };
    const sha = await findCommitForTask(repoDir, "t-abc12345", Date.now() - 60_000, { git });
    expect(sha).toBe("abc123def456789012345678901234567890abcd");
    // Verify argv shape — `-C <repoDir> log --grep=<taskId> --since=<iso> -1 --format=%H`.
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv[0]).toBe("-C");
    expect(argv[1]).toBe(repoDir);
    expect(argv[2]).toBe("log");
    expect(argv).toContain("--grep=t-abc12345");
    expect(argv).toContain("-1");
    expect(argv).toContain("--format=%H");
  });

  test("commit absent → returns null", async () => {
    const git: GitSpawn = async () => ok("");
    const sha = await findCommitForTask(repoDir, "t-no-such", Date.now() - 60_000, { git });
    expect(sha).toBeNull();
  });

  test("malformed repoDir (does not exist) → throws ConfigError", async () => {
    const git: GitSpawn = async () => ok("should-not-be-called");
    const bogus = join(tmpdir(), "atmux-auto-done-nonexistent-xyz-123");
    await expect(
      findCommitForTask(bogus, "t-x", Date.now() - 60_000, { git }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("sinceMs filter — `--since=<iso>` is shaped from sinceMs; no-match window → null", async () => {
    const captured: { since: string | null } = { since: null };
    const sinceMs = Date.parse("2026-05-09T06:09:00.000Z");
    const git: GitSpawn = async (argv) => {
      const sinceArg = argv.find((a) => a.startsWith("--since="));
      captured.since = sinceArg ? sinceArg.slice("--since=".length) : null;
      // Simulate git's own --since filter: commit older than window → empty stdout.
      return ok("");
    };
    const sha = await findCommitForTask(repoDir, "t-old", sinceMs, { git });
    expect(sha).toBeNull();
    expect(captured.since).toBe(new Date(sinceMs).toISOString());
  });

  test("not-a-git-repo (git log exit != 0) → throws ConfigError", async () => {
    const git: GitSpawn = async () =>
      fail("fatal: not a git repository (or any of the parent directories): .git", 128);
    await expect(
      findCommitForTask(repoDir, "t-x", Date.now() - 60_000, { git }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("git failure with empty stderr — ConfigError message falls back to exit code", async () => {
    const git: GitSpawn = async () => fail("", 129);
    await expect(findCommitForTask(repoDir, "t-x", Date.now() - 60_000, { git })).rejects.toThrow(
      /exit 129/,
    );
  });
});

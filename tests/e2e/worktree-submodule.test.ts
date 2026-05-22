// e2e: ADR-088 — provisionWorktree({initSubmodules: true}) against a
// real fixture repo with one submodule. Verifies the submodule's
// committed content lands in the new worktree after provisioning.
//
// Uses real `git` against tmpdir; no network — the submodule is a
// sibling tmp repo, added by absolute path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSubmodules, provisionWorktree } from "../../src/abstractions/worktree.ts";

let root: string;
let parent: string;
let child: string;

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      // Force HTTP for any internal protocol normalization.
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (rc=${r.status}): ${r.stderr}`);
  }
}

// Modern git (>= 2.38) blocks `file://` submodule transport by default
// (CVE-2022-39253) — `git submodule update --init --recursive` fails
// with `fatal: transport 'file' not allowed` when the parent registered
// a submodule by local path. Two paths fix this:
//   - per-repo: `git -C <repo> config protocol.file.allow always`
//   - per-process: `GIT_CONFIG_COUNT=1 / KEY_0 / VALUE_0` env override
// We already set the per-repo config on `parent` (line below), but the
// worktree created via provisionWorktree spawns its own `git submodule`
// process whose effective config lookup did NOT pick up the parent's
// `protocol.file.allow` reliably across git versions. Pin via env so
// every defaultGitSpawn child inherits the override.
const priorGitConfigEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
    priorGitConfigEnv[k] = process.env[k];
  }
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";

  root = await mkdtemp(join(tmpdir(), "atmux-adr088-"));
  parent = join(root, "parent");
  child = join(root, "child");

  // Build the child (submodule) repo first — must have at least one commit.
  await mkdir(child, { recursive: true });
  git(["init", "-q", "-b", "main"], child);
  git(["config", "commit.gpgsign", "false"], child);
  // Allow file:// path-based submodule add via -c protocol.file.allow=always.
  await writeFile(join(child, "README.md"), "child-content\n");
  git(["add", "README.md"], child);
  git(["commit", "-q", "-m", "init child"], child);

  // Build the parent repo + add child as submodule via local path.
  await mkdir(parent, { recursive: true });
  git(["init", "-q", "-b", "main"], parent);
  git(["config", "commit.gpgsign", "false"], parent);
  git(["config", "protocol.file.allow", "always"], parent);
  await writeFile(join(parent, "README.md"), "parent-content\n");
  git(["add", "README.md"], parent);
  git(["commit", "-q", "-m", "init parent"], parent);
  git(["-c", "protocol.file.allow=always", "submodule", "add", child, "vendor/child"], parent);
  git(["commit", "-q", "-m", "add child submodule"], parent);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(priorGitConfigEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ADR-088 e2e: provisionWorktree initSubmodules", () => {
  test("provisionWorktree({initSubmodules: true}) populates submodule contents in the new worktree", async () => {
    const wtPath = join(root, "wt-alice");
    const r = await provisionWorktree(parent, "main", "main-alice", wtPath, {
      initSubmodules: true,
    });
    expect(r.created).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
    // The submodule directory must exist with its committed README.
    const submoduleReadme = join(wtPath, "vendor/child/README.md");
    expect(existsSync(submoduleReadme)).toBe(true);
    expect(readFileSync(submoduleReadme, "utf8")).toBe("child-content\n");
  });

  test("provisionWorktree without initSubmodules leaves submodule directory empty (parity baseline)", async () => {
    const wtPath = join(root, "wt-bob");
    const r = await provisionWorktree(parent, "main", "main-bob", wtPath);
    expect(r.created).toBe(true);
    expect(existsSync(wtPath)).toBe(true);
    // Submodule directory exists (it's a tracked path) but content is empty.
    const submoduleReadme = join(wtPath, "vendor/child/README.md");
    expect(existsSync(submoduleReadme)).toBe(false);
  });

  test("initSubmodules() on already-populated worktree is a no-op (idempotent)", async () => {
    const wtPath = join(root, "wt-alice"); // pre-populated above
    // Re-run; should not change content + should not throw.
    await initSubmodules(wtPath);
    const submoduleReadme = join(wtPath, "vendor/child/README.md");
    expect(readFileSync(submoduleReadme, "utf8")).toBe("child-content\n");
  });
});

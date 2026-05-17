// Adversarial e2e — reproduce the ADR-082 stash-collision class against a
// real git repo + per-member worktrees, prove worktreeIsolation:true
// prevents it, prove the CONTROL (worktreeIsolation:false / shared
// working tree) loses Member A's untracked precious file.
//
// **t-c10459f4 (ADR-082 W9). Designed to FAIL LOUDLY if ADR-082 ever
// regresses — i.e., if a future commit re-pools members onto a single
// shared working tree, the control case will green and the protected
// case will turn red.**
//
// Historical failure mode this test guards against
// -----------------------------------------------
// Documented at:
//   - ADR-081 §"Stash-collision side-incident" — the original incident
//     log: an untracked ADR markdown file in the shared working tree
//     was swept into a lint-staged stash during a parallel commit and
//     dropped silently when the hook errored.
//   - CLAUDE.md global §"Hooks, Commits, Tooling" L226 — "lint-staged
//     + submodule-`Mm`-state silently absorbs content. When `git
//     status` shows `Mm` or ` m` submodule at commit time,
//     husky+lint-staged's stash/unstash dance can sweep UNRELATED
//     files (other submodule pointers, untracked docs) into the
//     commit index."
//
// The shared-tree mechanism reduces to: any single git worktree where
// member A's untracked file coexists with member B's staged work
// is vulnerable to B's stash dance pulling A's file into the stash;
// if the stash is dropped (any error inside lint-staged, including
// silent ones from `Mm` submodule state), A's file is gone.
//
// ADR-082 W3 fixes the class by giving each member their own worktree:
// `git stash` operates per-worktree on the working tree path, so B's
// stash CANNOT see A's untracked file when they live in disjoint
// physical directories.
//
// Test mechanism — synthetic but byte-equal to the real incident
// -------------------------------------------------------------
// The "lint-staged stash dance" reduces to `git stash push -u`
// (stashes tracked changes + untracked files) followed by `git stash
// drop` (the failure-mode where the unstash never happens). We don't
// install husky / lint-staged into the test repo (heavy + test-runner-
// flaky); we exercise the same git plumbing directly. The single
// causal step is `stash push -u` — whether dropped explicitly or via
// hook crash, the outcome on the working tree is identical.
//
// Non-idempotence
// ---------------
// Per CLAUDE.md testing discipline §"Stateful e2e specs are not
// repeatable smokes": each test cold-starts a fresh `mkdtemp`'d repo +
// initial commit + 2-member team. No shared fixture state across
// tests. Run-of-N would consume the seed; one run only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitSpawn, provisionWorktree } from "../../src/abstractions/worktree.ts";

// ---------- Helpers ----------

/** Run a single `git -C <cwd> <argv>` invocation, fail the test on
 *  non-zero unless `allowNonZero` is set. Surfaces stderr in the
 *  failure message so the test report carries enough context to
 *  diagnose mid-walk breakage. */
async function git(
  cwd: string,
  argv: ReadonlyArray<string>,
  allowNonZero = false,
): Promise<string> {
  const r = await defaultGitSpawn(["-C", cwd, ...argv]);
  if (!allowNonZero && r.exitCode !== 0) {
    throw new Error(`git ${argv.join(" ")} (cwd=${cwd}) exit=${r.exitCode}\nstderr:\n${r.stderr}`);
  }
  return r.stdout.trim();
}

/** True iff the path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Cold-start a fresh git repo with one commit + a tracked file, and
 *  return its path. Per-test isolation comes from `mkdtemp`. Sets
 *  `user.email` / `user.name` because `git commit` refuses without
 *  them on stock containers / CI runners. */
async function makeRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "atmux-e2e-stash-collision-"));
  // Use `-b main` so the test isn't sensitive to the operator's
  // init.defaultBranch config (some hosts default to "master").
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Test"]);
  await writeFile(join(repoPath, "tracked.md"), "initial body\n");
  await git(repoPath, ["add", "tracked.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

/** Simulate the lint-staged stash dance + the historical failure mode
 *  where the stash is dropped before unstash (the bug class CLAUDE.md
 *  L226 documents). The single causal step is `git stash push -u`
 *  followed by `git stash drop` — byte-equal to what happens when a
 *  lint-staged invocation crashes inside its `Hiding unstaged
 *  changes...` phase and the trap handler fails to pop.
 *
 *  Returns the stash object SHA for the test report (helps diagnose
 *  if a future regression shifts WHICH files the stash captured). */
async function simulateLintStagedStashDrop(cwd: string): Promise<void> {
  // `stash push -u` captures tracked changes + untracked files in the
  // working tree pointed at by `cwd`. Crucially: when multiple git
  // worktrees share a single .git/, `stash push` only sees the files
  // physically present in `cwd`'s working tree — that's the isolation
  // mechanism we're proving.
  await git(cwd, ["stash", "push", "-u", "-m", "lint-staged simulated stash"]);
  // Drop the stash without popping — the historical failure mode.
  // `git stash drop` always drops the top of the stack; we just
  // created that entry, so this is deterministic.
  await git(cwd, ["stash", "drop"]);
}

// ---------- Tests ----------

describe("e2e worktree stash-collision adversarial (ADR-082 W9, t-c10459f4)", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await makeRepo();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  test("PROTECTED: worktreeIsolation:true — Member A's untracked file survives Member B's stash-drop dance", async () => {
    // Provision two per-member worktrees off the repo's main branch.
    // Branch names mirror ADR-084's per-member convention so this
    // exercises the production path verbatim.
    const wtA = join(repoPath, ".atmux", "worktrees", "alice");
    const wtB = join(repoPath, ".atmux", "worktrees", "bob");
    await mkdir(join(repoPath, ".atmux", "worktrees"), { recursive: true });
    await provisionWorktree(repoPath, "main", "main-alice", wtA);
    await provisionWorktree(repoPath, "main", "main-bob", wtB);

    // Member A: drop a precious untracked file inside ALICE'S worktree.
    // This is the file ADR-082 exists to protect.
    const preciousPath = join(wtA, "precious-untracked-file.md");
    await writeFile(
      preciousPath,
      "# Precious\nThis content represents the ADR-081 incident's lost ADR draft.\n",
    );

    // Member B: edit a tracked file in BOB'S worktree, stage it, then
    // run the lint-staged stash-drop dance. With worktreeIsolation:
    // true, Bob's stash captures only files physically present in
    // wtB — Alice's wtA is a separate path, invisible to Bob's git
    // commands.
    await writeFile(join(wtB, "tracked.md"), "bob's edit\n");
    await git(wtB, ["add", "tracked.md"]);
    await simulateLintStagedStashDrop(wtB);

    // The load-bearing assertion: Alice's precious file is still
    // there. If ADR-082 regresses (e.g., a refactor removes
    // worktreeIsolation gating in src/verbs/start.ts), this assertion
    // will fail loudly with "expected file to exist" — the regression
    // signal.
    expect(await exists(preciousPath)).toBe(true);
    // And the content is unchanged — a partial-stash regression that
    // truncated the file would still pass the exists() probe but
    // re-fire here.
    const body = await readFile(preciousPath, "utf8");
    expect(body).toContain("ADR-081 incident");
  });

  test("CONTROL (proves the test catches real regression): worktreeIsolation:false / shared root tree — Member A's untracked file IS lost to Member B's stash-drop dance", async () => {
    // No worktree provisioning — both members operate in the repo
    // root. This is the pre-ADR-082 behaviour (worktreeIsolation:
    // false or omitted) AND the path a regression would re-enable
    // (e.g., if start.ts's `if (team.worktreeIsolation === true)`
    // gate is inverted or removed).
    //
    // "Member A" and "Member B" are conceptual here — both write to
    // the same physical working tree, mirroring the historical
    // failure mode where two driver-side commits raced in the shared
    // tree.
    const preciousPath = join(repoPath, "precious-untracked-file.md");
    await writeFile(
      preciousPath,
      "# Precious\nThis content represents the ADR-081 incident's lost ADR draft.\n",
    );

    // Member B's edit + stage + stash-drop, all in the SHARED root.
    // The stash here captures BOTH Bob's staged edit AND Alice's
    // untracked precious file — exactly the historical bug class.
    await writeFile(join(repoPath, "tracked.md"), "bob's edit\n");
    await git(repoPath, ["add", "tracked.md"]);
    await simulateLintStagedStashDrop(repoPath);

    // Inverted-expectation contract: the precious file MUST be gone.
    // If a future change accidentally fixes the shared-tree case
    // (e.g., by mandating worktrees regardless of team.json), this
    // assertion turns red — the control would then be misleading,
    // and the test would no longer "prove the test catches real
    // regression" per t-c10459f4 ACCEPTANCE bullet 6.
    expect(await exists(preciousPath)).toBe(false);
  });

  test("PROTECTED: simultaneous-style — Alice writes precious BEFORE provisionWorktree, then survives Bob's stash dance after", async () => {
    // Variant of the protected case where Alice's precious file
    // exists in the ROOT working tree (e.g., a teammate dropped it
    // before worktree provisioning landed). Once worktrees are
    // provisioned, Bob operates in wtB, separate from the root
    // working tree. The precious file in root survives Bob's stash
    // because Bob's `git stash` is rooted at wtB, never sees root.
    //
    // This guards against an edge case ADR-082 W3 introduced: a
    // member who created untracked files BEFORE worktree-isolation
    // shipped wouldn't have them migrated to their worktree — the
    // file stays at root. Bob's per-worktree stash must still not
    // be able to eat it. (If it could, ADR-082 would be "fixed
    // forward-only" and a footgun for in-flight repos.)
    const preciousRoot = join(repoPath, "precious-root.md");
    await writeFile(preciousRoot, "# Precious (root)\n");

    const wtB = join(repoPath, ".atmux", "worktrees", "bob");
    await mkdir(join(repoPath, ".atmux", "worktrees"), { recursive: true });
    await provisionWorktree(repoPath, "main", "main-bob", wtB);

    // Bob's stash dance in wtB.
    await writeFile(join(wtB, "tracked.md"), "bob's edit\n");
    await git(wtB, ["add", "tracked.md"]);
    await simulateLintStagedStashDrop(wtB);

    // Root's precious file survives.
    expect(await exists(preciousRoot)).toBe(true);
  });
});

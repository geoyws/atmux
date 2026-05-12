// ADR-082 §1: per-member git worktree abstraction (W1 / t-0b25c26b).
//
// Five helpers that wrap `git worktree {add,list,remove}` + `git status`
// behind a spawn-injectable surface so:
//
//   * W3 (`start.ts`)  — can provision a member's worktree before tmux
//                        spawns the pane that will cd into it.
//   * W4 (`stop.ts`)   — can prune worktrees on `--force` teardown
//                        without yanking dirty work out from under the
//                        operator (default `dirty: 'skip'`).
//   * W5 (`doctor.ts`) — can enumerate managed worktrees + flag drift.
//
// No raw `child_process` here: every git invocation routes through the
// `GitSpawn` typedef wrapping `abstractions/spawn.spawn`. Mirrors the
// pattern in `core/auto-done.ts` + `core/auto-push.ts` so the test path
// has one shape across the codebase (mock the GitSpawn, assert argv).
//
// Idempotence is the controlling discipline — `provisionWorktree` must
// be safe to call on every `atmux start` even when the worktree already
// exists, and `pruneWorktree` must be safe to call when the worktree
// has already been removed by a previous teardown. The "dirty" check
// on prune exists precisely because in shared-tree teams a prune
// at-stop-time of a member's dirty worktree silently destroyed unstashed
// work (CLAUDE.md global L226 "lint-staged + submodule-Mm" trap class,
// at the worktree boundary instead of the index boundary).

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./fs.ts";
import { spawn as defaultSpawn, type SpawnResult } from "./spawn.ts";
import { ConfigError } from "../errors.ts";
import { DEFAULT_WORKTREE_ROOT, type Team } from "../schema/team.ts";

// ---------- Spawn-injected git wrapper ----------

export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

/** Default git spawner — `git <argv>` with 30s timeout + accept-any-rc
 *  (callers branch on exit code). Mirrors `auto-done.ts::defaultGitSpawn`
 *  / `auto-push.ts::defaultGitSpawn` so the codebase carries one shape
 *  for "shell out to git" across helpers. */
export const defaultGitSpawn: GitSpawn = async (argv) =>
  await defaultSpawn({
    cmd: "git",
    argv,
    timeoutMs: 30_000,
    expectExitCode: "any",
  });

// ---------- (1) resolveWorktreePath ----------

/** Subset of the `Team` shape needed for path resolution. Pick'd from
 *  `Team` so the optional-property semantics line up exactly with the
 *  Zod-inferred shape under `exactOptionalPropertyTypes: true` —
 *  callers can pass the full `Team` object directly, and bare literal
 *  callers can omit the field. */
export type WorktreePathTeam = Pick<Team, "worktreeRoot">;

/**
 * Compute the worktree path for `<member>` under `team.worktreeRoot`
 * (default {@link DEFAULT_WORKTREE_ROOT} = `.atmux/worktrees`).
 *
 * Relative `worktreeRoot` values are anchored under `atmuxDir`'s parent
 * (the project root) so the default expands to
 * `<projectRoot>/.atmux/worktrees/<member>/` — same physical path as
 * the W1 task brief's "default `<atmuxDir>/worktrees/<member>/`"
 * shorthand. Absolute `worktreeRoot` values pass through verbatim.
 */
export function resolveWorktreePath(
  team: WorktreePathTeam,
  member: string,
  atmuxDir: string,
): string {
  const root = team.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
  // The W2 schema doc'd `worktreeRoot` as relative-to-project-root; the
  // project root is the directory containing `.atmux/`. The shortcut
  // `<atmuxDir>/worktrees/<member>/` works for the default root only
  // because `.atmux/worktrees` resolves to the same physical path.
  if (root.startsWith("/")) {
    return join(root, member);
  }
  // atmuxDir is `<projectRoot>/.atmux`; strip the trailing segment.
  const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
  return join(projectRoot, root, member);
}

// ---------- (2) provisionWorktree ----------

export interface ProvisionWorktreeResult {
  /** True iff `git worktree add` actually fired this call. False on the
   *  idempotent no-op path (worktree already exists on `branch`). */
  created: boolean;
  /** The worktree path — echoes the caller's input for fluent chaining. */
  path: string;
}

export interface ProvisionOpts {
  /** Git spawn override (test injection). */
  git?: GitSpawn;
}

/**
 * Provision a git worktree at `worktreePath` checked out at `branch`,
 * rooted at `repoPath`. Idempotent:
 *
 *   - Worktree absent → `git worktree add <path> <branch>` → returns
 *     `{ created: true, path }`.
 *   - Worktree present AND on `branch` → returns `{ created: false }`.
 *   - Worktree present AND on a DIFFERENT branch → throws `ConfigError`.
 *
 * Auto-checkout on branch mismatch is deliberately disabled per
 * ADR-082 §3 — operators who hand-edit a worktree to a different branch
 * may have unstashed work tied to that branch; silent re-checkout would
 * destroy state. Caller must reconcile manually.
 */
export async function provisionWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
  opts: ProvisionOpts = {},
): Promise<ProvisionWorktreeResult> {
  const git = opts.git ?? defaultGitSpawn;
  const existing = await findWorktreeBranch(repoPath, worktreePath, git);
  if (existing !== null) {
    if (existing === branch) {
      return { created: false, path: worktreePath };
    }
    throw new ConfigError({
      what:
        `provisionWorktree: ${worktreePath} exists on branch '${existing}', ` +
        `expected '${branch}'`,
      hint: "operator-managed mismatch — reconcile via `git -C <wt> checkout <branch>` or remove the worktree manually",
    });
  }
  const result = await git(["-C", repoPath, "worktree", "add", worktreePath, branch]);
  if (result.exitCode !== 0) {
    throw new ConfigError({
      what: `provisionWorktree: \`git worktree add\` failed (rc=${result.exitCode})`,
      hint: result.stderr.trim() || "(no stderr)",
    });
  }
  return { created: true, path: worktreePath };
}

/** Parse `git worktree list --porcelain` and return the checked-out
 *  branch name for `worktreePath`, or null if no managed worktree
 *  matches. Branch is reported without the `refs/heads/` prefix. */
async function findWorktreeBranch(
  repoPath: string,
  worktreePath: string,
  git: GitSpawn,
): Promise<string | null> {
  const r = await git(["-C", repoPath, "worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `findWorktreeBranch: \`git worktree list\` failed (rc=${r.exitCode})`,
      hint: r.stderr.trim() || "(no stderr)",
    });
  }
  // --porcelain emits blocks separated by blank lines, each starting
  // with `worktree <path>` then `HEAD <sha>` then optional `branch <ref>`
  // or `detached`. Match on the worktree-line path equality.
  const blocks = r.stdout.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (wtLine === undefined) continue;
    if (wtLine.slice("worktree ".length) !== worktreePath) continue;
    const branchLine = lines.find((l) => l.startsWith("branch "));
    if (branchLine === undefined) return ""; // detached HEAD
    return branchLine.slice("branch refs/heads/".length);
  }
  return null;
}

// ---------- (3) pruneWorktree ----------

export interface PruneOpts {
  /** Behavior when the worktree has uncommitted changes:
   *   - `skip` (default): leave the worktree intact, return
   *     `{ pruned: false, reason: 'dirty' }`. Caller surfaces the
   *     skip to the operator.
   *   - `force`: pass `--force` to `git worktree remove`, destroying
   *     uncommitted work. Operator must opt in (matches the
   *     `atmux stop --force` posture). */
  dirty?: "skip" | "force";
  git?: GitSpawn;
}

export interface PruneResult {
  pruned: boolean;
  /** Populated on the no-op path so the caller can surface the cause
   *  ('dirty' → uncommitted changes blocked the skip-mode remove;
   *   'missing' → worktree path didn't exist on disk). */
  reason?: "dirty" | "missing";
}

/**
 * Remove a managed worktree. Idempotent — returns
 * `{ pruned: false, reason: 'missing' }` when the path is already gone.
 *
 * Dirty-skip is the default to mirror the operator's "I didn't ask to
 * destroy work" expectation at `atmux stop` time. `--force` (which
 * destroys uncommitted work) requires `opts.dirty === 'force'`.
 */
export async function pruneWorktree(
  repoPath: string,
  worktreePath: string,
  opts: PruneOpts = {},
): Promise<PruneResult> {
  const git = opts.git ?? defaultGitSpawn;
  const mode = opts.dirty ?? "skip";

  if (!(await exists(worktreePath))) {
    return { pruned: false, reason: "missing" };
  }

  if (mode === "skip") {
    const dirty = await isWorktreeDirty(worktreePath, { git });
    if (dirty) return { pruned: false, reason: "dirty" };
  }

  const argv =
    mode === "force"
      ? ["-C", repoPath, "worktree", "remove", "--force", worktreePath]
      : ["-C", repoPath, "worktree", "remove", worktreePath];
  const r = await git(argv);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `pruneWorktree: \`git worktree remove\` failed (rc=${r.exitCode})`,
      hint: r.stderr.trim() || "(no stderr)",
    });
  }
  return { pruned: true };
}

// ---------- (4) isWorktreeDirty ----------

export interface DirtyCheckOpts {
  git?: GitSpawn;
}

/**
 * `git -C <worktreePath> status --porcelain` returns one line per
 * modified / staged / untracked path; the trim-empty check
 * differentiates clean (`""`) from dirty. Throws when `git status` itself
 * fails (e.g., path is not a git worktree).
 */
export async function isWorktreeDirty(
  worktreePath: string,
  opts: DirtyCheckOpts = {},
): Promise<boolean> {
  const git = opts.git ?? defaultGitSpawn;
  const r = await git(["-C", worktreePath, "status", "--porcelain"]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `isWorktreeDirty: \`git status\` failed (rc=${r.exitCode}) at ${worktreePath}`,
      hint: r.stderr.trim() || "(no stderr)",
    });
  }
  return r.stdout.trim().length > 0;
}

// ---------- (5) listManagedWorktrees ----------

/**
 * Enumerate every immediate subdirectory of `<atmuxDir>/worktrees/`.
 * Returns absolute paths. Returns `[]` when the worktrees directory
 * doesn't exist yet (pre-first-`atmux start` on an isolation team).
 *
 * Naming: "managed" because the path is the atmux-owned root —
 * worktrees provisioned outside this root by the operator aren't
 * tracked by this enumeration (intentional; out-of-tree state is
 * out-of-scope per ADR-082).
 */
export async function listManagedWorktrees(
  _repoPath: string,
  atmuxDir: string,
): Promise<string[]> {
  const worktreesDir = join(atmuxDir, "worktrees");
  let entries: Dirent[];
  try {
    entries = (await readdir(worktreesDir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    // ENOENT → worktrees root not provisioned yet; treat as empty set.
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(worktreesDir, String(e.name)));
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

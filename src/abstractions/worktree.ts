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
import { ConfigError } from "../errors.ts";
import { DEFAULT_WORKTREE_ROOT, type Team } from "../schema/team.ts";
import { exists } from "./fs.ts";
import {
  DEFAULT_GIT_SPAWN_TIMEOUT_MS,
  spawn as defaultSpawn,
  resolveGitTimeoutMs,
  type SpawnResult,
} from "./spawn.ts";

// ---------- Spawn-injected git wrapper ----------

/** Injected `git <argv>` wrapper. `timeoutMs` (optional) overrides the
 *  per-call timeout; omit for the {@link resolveGitTimeoutMs} default
 *  (env `ATMUX_GIT_TIMEOUT_MS` ?? {@link DEFAULT_GIT_SPAWN_TIMEOUT_MS}). */
export type GitSpawn = (
  argv: ReadonlyArray<string>,
  opts?: { timeoutMs?: number },
) => Promise<SpawnResult>;

/** Default git spawner — `git <argv>` with accept-any-rc (callers branch
 *  on exit code) and a {@link resolveGitTimeoutMs}-resolved timeout
 *  (per-call `opts.timeoutMs` > env `ATMUX_GIT_TIMEOUT_MS` >
 *  {@link DEFAULT_GIT_SPAWN_TIMEOUT_MS}). Mirrors
 *  `auto-done.ts::defaultGitSpawn` / `auto-push.ts::defaultGitSpawn` so
 *  the codebase carries one shape for "shell out to git" across helpers. */
export const defaultGitSpawn: GitSpawn = async (argv, opts) =>
  await defaultSpawn({
    cmd: "git",
    argv,
    timeoutMs: resolveGitTimeoutMs(opts?.timeoutMs),
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
  /** ADR-088: when `true`, runs `initSubmodules(worktreePath)` after a
   *  successful `git worktree add`. No-op on the idempotent path
   *  (`created === false`) — an existing worktree may have intentionally
   *  not initialized submodules; we don't reach in. Default `false`. */
  initSubmodules?: boolean;
  /** Warn-sink for non-fatal init failures. Defaults to `process.stderr.write`.
   *  Test injection point. */
  warn?: (msg: string) => void;
}

/**
 * Provision a git worktree at `worktreePath` checked out on `wtBranch`
 * (per-member branch), forked off `baseBranch` if `wtBranch` does not
 * yet exist. Rooted at `repoPath`. Idempotent:
 *
 *   - Worktree absent AND `wtBranch` absent → `git worktree add -b
 *     <wtBranch> <path> <baseBranch>` creates the branch + worktree
 *     atomically. Returns `{ created: true, path }`.
 *   - Worktree absent AND `wtBranch` exists from a previous run →
 *     fall through to `git worktree add <path> <wtBranch>` (re-use
 *     the existing branch). Returns `{ created: true, path }`.
 *   - Worktree present AND on `wtBranch` → idempotent no-op,
 *     `{ created: false }`.
 *   - Worktree present AND on a DIFFERENT branch (or detached) →
 *     throws `ConfigError`.
 *
 * Per-member branch is the controlling fix for the 2026-05-12 ADR-082
 * regression (`fatal: '<baseBranch>' is already used by worktree at
 * <root>`). Git's worktree model is one-branch-per-worktree; running
 * `worktree add` against a branch already checked out elsewhere
 * refuses. ADR-084 resolves this by giving each member its own branch
 * `<baseBranch>-<memberName>`, so the parent worktree keeps `<baseBranch>`
 * while the per-member worktrees each own their own ref. Caller derives
 * the wtBranch name via {@link sanitizeBranchSegment}.
 *
 * Auto-recovery on branch mismatch is deliberately disabled per
 * ADR-082 §3 — operators who hand-edit a worktree to a different branch
 * may have unstashed work tied to that branch; silent re-checkout would
 * destroy state. Caller must reconcile manually.
 */
export async function provisionWorktree(
  repoPath: string,
  baseBranch: string,
  wtBranch: string,
  worktreePath: string,
  opts: ProvisionOpts = {},
): Promise<ProvisionWorktreeResult> {
  const git = opts.git ?? defaultGitSpawn;
  const existing = await findWorktreeBranch(repoPath, worktreePath, git);
  if (existing !== null) {
    if (existing === wtBranch) {
      return { created: false, path: worktreePath };
    }
    const stateLabel = existing === "" ? "detached HEAD" : `branch '${existing}'`;
    throw new ConfigError({
      what:
        `provisionWorktree: ${worktreePath} exists on ${stateLabel}, ` +
        `expected branch '${wtBranch}'`,
      hint: `operator-managed mismatch — reconcile via \`git -C <wt> checkout ${wtBranch}\` or remove the worktree manually`,
    });
  }
  // Detect whether wtBranch already exists as a ref. `git
  // rev-parse --verify --quiet refs/heads/<wtBranch>` exits 0 if it
  // does, non-zero otherwise. Cheaper + more reliable than parsing
  // `git branch --list`.
  const verify = await git([
    "-C",
    repoPath,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${wtBranch}`,
  ]);
  const wtBranchExists = verify.exitCode === 0;
  const argv = wtBranchExists
    ? ["-C", repoPath, "worktree", "add", worktreePath, wtBranch]
    : ["-C", repoPath, "worktree", "add", "-b", wtBranch, worktreePath, baseBranch];
  const result = await git(argv);
  if (result.exitCode !== 0) {
    throw new ConfigError({
      what: `provisionWorktree: \`git worktree add\` failed (rc=${result.exitCode})`,
      hint: result.stderr.trim() || "(no stderr)",
    });
  }
  // ADR-088: opt-in submodule init. Only when the worktree was actually
  // created this call — operator-managed existing worktrees may have
  // intentionally not initialized submodules.
  if (opts.initSubmodules === true) {
    const subOpts: { git: GitSpawn; warn?: (msg: string) => void } = { git };
    if (opts.warn !== undefined) subOpts.warn = opts.warn;
    await initSubmodules(worktreePath, subOpts);
  }
  return { created: true, path: worktreePath };
}

/**
 * ADR-088: initialize git submodules under `wtPath` via
 * `git submodule update --init --recursive`.
 *
 * **Idempotent.** Re-running short-circuits on already-initialized
 * submodules.
 *
 * **No-op on submodule-less repos.** `git submodule update` exits 0
 * with no output when `.gitmodules` is absent; we don't pre-check.
 *
 * **Best-effort.** A non-zero exit logs a warning to `opts.warn`
 * (default `process.stderr.write`) and returns — does NOT throw.
 * Rationale: a single failing transitive submodule shouldn't abort
 * the entire worktree provision. Operator can recover with
 * `git -C <wtPath> submodule update --init <path>` after the fact.
 */
export async function initSubmodules(
  wtPath: string,
  opts: { git?: GitSpawn; warn?: (msg: string) => void } = {},
): Promise<void> {
  const git = opts.git ?? defaultGitSpawn;
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(msg));
  const result = await git(["-C", wtPath, "submodule", "update", "--init", "--recursive"]);
  if (result.exitCode !== 0) {
    const errLine = result.stderr.trim() || "(no stderr)";
    warn(
      `initSubmodules: \`git submodule update --init --recursive\` rc=${result.exitCode} ` +
        `at ${wtPath} — ${errLine}\n` +
        `  → operator can reconcile with \`git -C ${wtPath} submodule update --init <path>\` ` +
        `for any specific submodule\n`,
    );
  }
}

/**
 * Sanitize a member name into a git-branch-safe segment.
 *
 * Replaces any character outside `[A-Za-z0-9_-]` with `-`. Used by
 * callers (start.ts, doctor.ts) to derive the per-member worktree
 * branch name as `${baseBranch}-${sanitizeBranchSegment(member.name)}`
 * per ADR-084 §"Per-member branch naming convention".
 *
 * Today's atmux + sopx-guild members are all kebab-case ASCII, so this
 * is a no-op for the current names. Defensive for future emoji-suffixed
 * or unicode-named members (`🐝w1`, etc.) — those would otherwise produce
 * branch names git refuses (`fatal: invalid reference name`).
 */
export function sanitizeBranchSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
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

// ---------- (5) deleteWorktreeBranch ----------

export interface DeleteBranchOpts {
  git?: GitSpawn;
}

export interface DeleteBranchResult {
  /** True iff `git branch -d` succeeded. False on the unmerged-refuse
   *  path or when the branch was already absent. */
  deleted: boolean;
  /** Populated on the no-op path:
   *   - `unmerged` — git refused because the branch has commits not
   *     present in its upstream / HEAD (`error: the branch 'X' is not
   *     fully merged`). Caller surfaces the skip; operator decides
   *     whether to `git branch -D` manually.
   *   - `missing` — the branch did not exist (`error: branch 'X' not
   *     found`). Idempotent re-run path. */
  reason?: "unmerged" | "missing";
}

/**
 * Delete a per-member worktree branch via `git branch -d <wtBranch>`.
 * Safe-mode only — `git branch -d` refuses unmerged branches; `-D`
 * (destructive) is intentionally NOT exposed here. Operator handles
 * unmerged-branch cleanup manually, mirroring the dirty-skip discipline
 * of {@link pruneWorktree} and `feedback_destructive_ops_need_explicit_auth.md`.
 *
 * Used by ADR-084 OQ2 follow-up — `atmux stop --force --prune-branch`
 * pairs the `git worktree remove` step with this branch cleanup. The
 * helper is callable in isolation for any worktree-branch cleanup
 * workflow.
 *
 * Idempotent: re-running on an already-deleted branch returns
 * `{ deleted: false, reason: 'missing' }` (no throw).
 */
export async function deleteWorktreeBranch(
  repoPath: string,
  wtBranch: string,
  opts: DeleteBranchOpts = {},
): Promise<DeleteBranchResult> {
  const git = opts.git ?? defaultGitSpawn;
  const r = await git(["-C", repoPath, "branch", "-d", wtBranch]);
  if (r.exitCode === 0) {
    return { deleted: true };
  }
  // Parse stderr for the two recoverable failure modes. Git's wording
  // is stable across versions covered by atmux's `git >= 2.20` floor:
  //   `error: the branch 'X' is not fully merged.`
  //   `error: branch 'X' not found.`
  const stderr = r.stderr;
  if (/not fully merged/i.test(stderr)) {
    return { deleted: false, reason: "unmerged" };
  }
  if (/not found|no such branch/i.test(stderr)) {
    return { deleted: false, reason: "missing" };
  }
  throw new ConfigError({
    what: `deleteWorktreeBranch: \`git branch -d ${wtBranch}\` failed (rc=${r.exitCode})`,
    hint: stderr.trim() || "(no stderr)",
  });
}

// ---------- (6) listManagedWorktrees ----------

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
export async function listManagedWorktrees(_repoPath: string, atmuxDir: string): Promise<string[]> {
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

// ADR-179 §Decision-3 W1 (Task t-bed51da2) — per-member branch fan-in primitive.
//
// `mergeMember(base, wtBranch, repoPath, opts)` merges `<base>-<member>`
// into `<base>` from the base worktree. Hard-refuses on the three
// failure modes that would corrupt operator-in-progress work:
//
//   1. `guardBaseWorktreeClean`  — `repoPath` has unstaged or staged
//      changes. Refuse rather than commit on top of an operator's WIP.
//   2. `guardBranchExists`       — `wtBranch` not found locally.
//      Refuse rather than create an empty merge of a non-existent branch.
//   3. `guardCommitsAhead`       — `wtBranch` has zero commits ahead of
//      `<base>`. Idempotent no-op exit (success, no git mutation).
//
// On conflict: `git merge --abort` to restore the worktree to clean
// state, then throw `MergeConflictError` with the conflicted-path list
// extracted from porcelain status BEFORE the abort fired. Semantic
// conflicts are not auto-resolvable — the caller surfaces to the
// operator (ADR-179 §Decision-3 line 64: "leave <base>-<m> untouched,
// surface via `atmux flag add --severity high`").
//
// No raw `child_process` — all git invocations route through the
// `GitSpawn` typedef mirroring `abstractions/worktree.ts` so the test
// path has one shape across the codebase. `git -C <repoPath>` carries
// the cwd in argv (no spawn-cwd override needed); keeps the GitSpawn
// signature single-arg the same way the W1/W3/W4/W5 worktree
// abstractions land their cwd.

import { ConfigError } from "../errors.ts";
import { spawn as defaultSpawn, type SpawnResult } from "./spawn.ts";

// ---------- Spawn-injected git wrapper ----------

export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

/** Default git spawner — `git <argv>` with 30s timeout + accept-any-rc.
 *  Branches on exit code so the caller decides what counts as failure.
 *  Mirrors `worktree.ts::defaultGitSpawn` + `auto-push.ts::defaultGitSpawn`
 *  for one shape across the codebase. */
export const defaultGitSpawn: GitSpawn = async (argv) =>
  await defaultSpawn({
    cmd: "git",
    argv,
    timeoutMs: 30_000,
    expectExitCode: "any",
  });

// ---------- Errors ----------

/** Thrown when `git merge --no-ff` exits non-zero. The wrapper has
 *  already fired `git merge --abort` so `repoPath` is back to clean
 *  (caller never has to do cleanup). `conflictPaths` is the list of
 *  paths from porcelain status taken BEFORE the abort — used by the
 *  caller (`atmux flag add --severity high`, `atmux reply`) to
 *  surface to the operator without re-deriving the list. */
export class MergeConflictError extends ConfigError {
  readonly wtBranch: string;
  readonly conflictPaths: ReadonlyArray<string>;

  constructor(opts: { wtBranch: string; conflictPaths: ReadonlyArray<string> }) {
    super({
      what: `merge-member: conflict merging ${opts.wtBranch} — ${opts.conflictPaths.length} path(s) need human triage`,
    });
    this.wtBranch = opts.wtBranch;
    this.conflictPaths = opts.conflictPaths;
  }
}

// ---------- Public types ----------

export interface MergeMemberOpts {
  /** Git spawn override (test injection). Default: {@link defaultGitSpawn}. */
  git?: GitSpawn;
  /** When true, run `git fetch origin <base>` before checkout — required
   *  in production (cron / merger member) so remote drift doesn't cause
   *  silent partial-merge. Tests pass `false` to keep their git fixtures
   *  local-only. Default: `true`. */
  fetch?: boolean;
}

/** Result of a successful `mergeMember` call. Conflict path throws
 *  `MergeConflictError`; the union is intentionally narrow (no
 *  `conflict` variant) because the contract surface for callers is
 *  "you either get a result back, or you catch the error". */
export type MergeMemberResult =
  | { status: "no-op"; reason: "no-commits-ahead" }
  | { status: "merged"; sha: string };

// ---------- Guards (private) ----------

/** Refuse if `<base>` worktree has unstaged or staged changes. */
async function guardBaseWorktreeClean(git: GitSpawn, repoPath: string): Promise<void> {
  const r = await git(["-C", repoPath, "status", "--porcelain"]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-member: 'git status' failed in ${repoPath} (exit ${r.exitCode}): ${r.stderr.trim()}`,
    });
  }
  const dirty = r.stdout.trim();
  if (dirty.length > 0) {
    throw new ConfigError({
      what: `merge-member: ${repoPath} has uncommitted changes — refusing merge over operator work`,
    });
  }
}

/** Refuse if `wtBranch` doesn't exist locally. We require local
 *  presence (not just `origin/<branch>`) because the fan-in target is
 *  a local branch the merger walks across. */
async function guardBranchExists(git: GitSpawn, repoPath: string, branch: string): Promise<void> {
  const r = await git(["-C", repoPath, "rev-parse", "--verify", `refs/heads/${branch}`]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-member: branch '${branch}' not found in ${repoPath}`,
    });
  }
}

/** Count commits on `wtBranch` not on `base`. Zero → idempotent no-op.
 *  Non-zero → proceed with merge. Throws on git failure (rev-list itself
 *  shouldn't fail post-branch-exists-guard except on a corrupted repo). */
async function guardCommitsAhead(
  git: GitSpawn,
  repoPath: string,
  base: string,
  branch: string,
): Promise<number> {
  const r = await git(["-C", repoPath, "rev-list", "--count", `${base}..${branch}`]);
  if (r.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-member: 'git rev-list --count ${base}..${branch}' failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
    });
  }
  return Number.parseInt(r.stdout.trim(), 10);
}

/** Parse porcelain `git status` output for conflicted-path stanzas.
 *  The conflict marker codes are: `UU` / `AA` / `DD` (both sides
 *  modified the same change-kind) and the `AU` / `UA` / `DU` / `UD`
 *  asymmetric pairs. Returned to {@link MergeConflictError} so the
 *  caller can surface paths without re-running git. */
function extractConflictPaths(porcelainOut: string): string[] {
  const out: string[] = [];
  for (const line of porcelainOut.split("\n")) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    if (
      code === "UU" ||
      code === "AA" ||
      code === "DD" ||
      code === "AU" ||
      code === "UA" ||
      code === "DU" ||
      code === "UD"
    ) {
      // Porcelain format: "XY <path>"; path starts at column 3.
      out.push(line.slice(3).trim());
    }
  }
  return out;
}

/** Derive the member name from `wtBranch`. wtBranch is the literal
 *  `${base}-${sanitizedMember}` shape produced by ADR-082 W1's
 *  `sanitizeBranchSegment`; if it doesn't start with `${base}-` we
 *  fall back to the full branch name (covers caller-passes-anything
 *  edge cases without crashing). Used only for the merge commit
 *  message's `merge(<member>): ...` prefix. */
function deriveMemberFromBranch(base: string, wtBranch: string): string {
  return wtBranch.startsWith(`${base}-`) ? wtBranch.slice(base.length + 1) : wtBranch;
}

// ---------- Public API ----------

/**
 * Merge `wtBranch` (typically `<base>-<member>`) into `base` from the
 * `repoPath` worktree. Returns the post-merge HEAD sha on success, a
 * `no-op` discriminator on idempotent re-fire, OR throws
 * `MergeConflictError` after restoring the worktree to clean state.
 *
 * Step-by-step (matches ADR-179 §Decision-3 pseudocode):
 *
 *   1. `guardBaseWorktreeClean(repoPath)` — refuse on dirty.
 *   2. `guardBranchExists(repoPath, wtBranch)` — refuse on missing.
 *   3. `guardCommitsAhead(repoPath, base, wtBranch)` — return no-op
 *      result when count == 0 (no git mutation; safe to re-fire).
 *   4. `opts.fetch !== false` → `git -C <repoPath> fetch origin <base>`.
 *      Caller-injectable for tests with local-only fixtures.
 *   5. `git -C <repoPath> checkout <base>`.
 *   6. `git -C <repoPath> merge --no-ff <wtBranch> -m "merge(<member>):
 *      fan-in <wtBranch> per ADR-179"`.
 *   7. On non-zero rc → capture porcelain status for conflictPaths →
 *      `git merge --abort` → throw `MergeConflictError`.
 *   8. On success → `git -C <repoPath> rev-parse HEAD` → return
 *      `{ status: 'merged', sha }`.
 *
 * Idempotence: re-firing on an already-merged branch produces
 * `{ status: 'no-op', reason: 'no-commits-ahead' }` (the post-merge
 * state has the per-member tip reachable from base, so commits-ahead
 * is 0). This is the property cron-mode + retry-on-flag depend on.
 *
 * Pushes are NOT performed here — the verb layer (`src/verbs/
 * merge-member.ts`, ADR-179 W2) wires push policy + `guardPushTarget`
 * on top of this primitive. Keeping push-policy out of the abstraction
 * matches the ADR's "primitives vs policy" split.
 */
export async function mergeMember(
  base: string,
  wtBranch: string,
  repoPath: string,
  opts: MergeMemberOpts = {},
): Promise<MergeMemberResult> {
  const git = opts.git ?? defaultGitSpawn;
  const doFetch = opts.fetch !== false;

  await guardBaseWorktreeClean(git, repoPath);
  await guardBranchExists(git, repoPath, wtBranch);
  const ahead = await guardCommitsAhead(git, repoPath, base, wtBranch);
  if (ahead === 0) {
    return { status: "no-op", reason: "no-commits-ahead" };
  }

  if (doFetch) {
    const fr = await git(["-C", repoPath, "fetch", "origin", base]);
    if (fr.exitCode !== 0) {
      throw new ConfigError({
        what: `merge-member: 'git fetch origin ${base}' failed (exit ${fr.exitCode}): ${fr.stderr.trim()}`,
      });
    }
  }

  const cr = await git(["-C", repoPath, "checkout", base]);
  if (cr.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-member: 'git checkout ${base}' failed (exit ${cr.exitCode}): ${cr.stderr.trim()}`,
    });
  }

  const member = deriveMemberFromBranch(base, wtBranch);
  const mergeMsg = `merge(${member}): fan-in ${wtBranch} per ADR-179`;
  const mr = await git(["-C", repoPath, "merge", "--no-ff", wtBranch, "-m", mergeMsg]);
  if (mr.exitCode !== 0) {
    // Capture conflict paths BEFORE aborting — the abort restores the
    // worktree to clean, which empties the porcelain output. We swallow
    // any error from the abort itself; the worktree may already be
    // clean if git's internal abort fired during the failed merge.
    const sr = await git(["-C", repoPath, "status", "--porcelain"]);
    const conflictPaths = sr.exitCode === 0 ? extractConflictPaths(sr.stdout) : [];
    await git(["-C", repoPath, "merge", "--abort"]);
    throw new MergeConflictError({ wtBranch, conflictPaths });
  }

  const hr = await git(["-C", repoPath, "rev-parse", "HEAD"]);
  if (hr.exitCode !== 0) {
    throw new ConfigError({
      what: `merge-member: post-merge 'git rev-parse HEAD' failed (exit ${hr.exitCode})`,
    });
  }
  return { status: "merged", sha: hr.stdout.trim() };
}

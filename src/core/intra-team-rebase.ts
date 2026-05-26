// ADR-134 T3+T4 (t-2b7572d7): intra-team rebase primitive.
//
// Closes the `rebasing → ready_to_merge | conflict` outer-wiring gap
// left by `intra-team-merge.ts:357-364` ("caller-driven states.
// Wrapper returns no-op so the dispatcher can defer to T3+T4 wiring").
// Before this module, any branch entering `rebasing` was stranded —
// `performMerge` returned no-op on rebasing-state ticks and no other
// caller advanced the row. Observed 2026-05-17: `geoyws-planner-
// rebased-backup` wedged in rebasing for 7h26m; the roster-gate
// (t-911c9314) is the upstream defense, this module closes the
// underlying wiring gap.
//
// Sibling to `src/abstractions/branch-merge.ts::mergeMember` but
// scoped narrower: rebase runs INSIDE the member's worktree (not the
// base worktree), so it never touches the operator's WIP on `<base>`.
// Conflict surface: `git rebase --abort` restores the worktree to the
// pre-rebase HEAD; the caller never has to clean up. Path list comes
// from porcelain status captured BEFORE the abort, mirroring
// `mergeMember`'s extractConflictPaths contract.
//
// Concurrency: every state-mutation routes through `repo.transition()`
// which wraps `BEGIN IMMEDIATE` (per ADR-134 §state-machine race-
// protection). The TOCTOU guard re-reads state before each write and
// short-circuits when the row isn't in `rebasing` — a sibling cron
// tick or operator-driven reset has stolen the row.

import type { GitSpawn } from "../abstractions/branch-merge.ts";
import { defaultGitSpawn } from "../abstractions/branch-merge.ts";
import { ConfigError } from "../errors.ts";
import type { BranchMergeState } from "./branch-merge-state.ts";
import type { MergerStateRepo } from "./repositories/merger-state-repo.ts";

// ---------- Context + result types ----------

export interface IntraTeamRebaseContext {
  /** Per-member branch (e.g. `geoyws-fe-1`). Primary key into the
   *  `merger_state` table; the row MUST be in `rebasing` state at
   *  entry (the dispatcher's TOCTOU guard re-reads + short-circuits
   *  if not). */
  memberBranch: string;
  /** Base branch (e.g. `geoyws`). The rebase target — `git rebase
   *  origin/<base>` when fetch=true, `git rebase <base>` when
   *  fetch=false. */
  base: string;
  /** Absolute path to the MEMBER's worktree (NOT the base worktree).
   *  This is where `git rebase` runs — keeps the operator's WIP on
   *  `<base>` untouched. The dispatcher resolves this via the
   *  team's worktreeIsolation config or `git worktree list`. */
  memberWorktreePath: string;
  /** Repo for the merger_state ledger — same handle the dispatcher
   *  passes to `performMerge`. Reused so writes serialize via the
   *  same BEGIN IMMEDIATE wrapper. */
  repo: MergerStateRepo;
  /** Caller identity for `merger_state.transitioned_by`. Defaults
   *  to `"cron"` since the dispatcher is the primary call-site. */
  by?: string;
  /** Clock — unix epoch seconds. Defaults to `Math.floor(Date.now()
   *  / 1000)`. Tests pin to a fixed value for reproducible
   *  `transitioned_at` columns. */
  now?: () => number;
  /** Git spawn override (test injection). Defaults to
   *  `defaultGitSpawn`. */
  git?: GitSpawn;
  /** When false, skip the `git fetch origin <base>` step before
   *  rebase. Default `true`. Tests pass `false` for local-only
   *  git fixtures. */
  fetch?: boolean;
}

export interface PerformRebaseResult {
  /** Post-rebase state — `ready_to_merge` on clean, `conflict` on
   *  failure / missing worktree. Equal to `rebasing` only when the
   *  TOCTOU guard short-circuited. */
  state: BranchMergeState;
  /** True iff the state CHANGED during this call. False on
   *  concurrency-loss no-ops (the re-read state wasn't `rebasing`). */
  changed: boolean;
  /** Operator-facing reason — set on every successful transition,
   *  mirrored into `merger_state.note` for `atmux status` / Discord
   *  surfacing. */
  reason: string;
  /** Post-rebase HEAD sha on clean rebase. Set ONLY when
   *  `state === 'ready_to_merge'` AND the rebase actually moved the
   *  branch tip. */
  newBaseSha?: string;
  /** Conflicted paths (truncated to 5) when state === 'conflict' AND
   *  the cause was a rebase conflict (NOT a missing worktree). */
  conflictPaths?: ReadonlyArray<string>;
}

// ---------- Internal helpers ----------

/** Parse porcelain `git status` output for conflict markers. Mirrors
 *  `branch-merge.ts::extractConflictPaths` exactly — rebase conflicts
 *  use the same `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD` codes that merge
 *  conflicts do. Kept module-local so the rebase module doesn't
 *  re-export `mergeMember`'s internal helper. */
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
      out.push(line.slice(3).trim());
    }
  }
  return out;
}

// ---------- Public API ----------

/**
 * Advance a `rebasing`-state row to `ready_to_merge` (clean) or
 * `conflict` (terminal). One invocation = one rebase attempt; the
 * dispatcher break-after-rebase loop control ensures this only fires
 * once per cron tick per branch.
 *
 * Step-by-step:
 *
 *   1. TOCTOU guard — re-read the row, refuse with `changed: false`
 *      if state !== 'rebasing' (a sibling tick / operator reset
 *      stole the row).
 *   2. Verify the member worktree exists (`git -C <wt> rev-parse
 *      --git-dir`). Missing → terminal `conflict` with reason
 *      "missing worktree: <path>".
 *   3. `opts.fetch !== false` → `git -C <wt> fetch origin <base>`.
 *   4. `git -C <wt> rebase <baseRef>` (origin/<base> when fetched,
 *      <base> otherwise).
 *   5. On exit 0 → `git -C <wt> rev-parse HEAD` for the new tip sha
 *      → transition `rebasing → ready_to_merge` with
 *      `baseSha=<new tip>`.
 *   6. On non-zero rc → capture conflict paths from porcelain
 *      status → `git rebase --abort` → transition `rebasing →
 *      conflict` with conflict paths in note.
 *
 * Idempotence: the TOCTOU guard short-circuits when the row has
 * already moved past `rebasing`, so a re-fire after a successful
 * rebase produces `{ state: 'ready_to_merge', changed: false,
 * reason: 'concurrency lost...' }` — safe to call as part of a
 * dispatcher walk.
 *
 * Pushes are NOT performed here — the dispatcher's downstream
 * `mergeMember` call handles fan-in + push policy. Keeping push
 * out of the rebase module matches the "primitives vs policy"
 * split from `mergeMember`.
 */
export async function performRebase(ctx: IntraTeamRebaseContext): Promise<PerformRebaseResult> {
  const now = ctx.now ?? (() => Math.floor(Date.now() / 1000));
  const by = ctx.by ?? "cron";
  const git = ctx.git ?? defaultGitSpawn;
  const doFetch = ctx.fetch !== false;
  const t = now();

  // TOCTOU guard — refuse if a sibling writer moved the row off rebasing.
  const row = ctx.repo.getState(ctx.memberBranch);
  const observed: BranchMergeState = row?.state ?? "open";
  if (observed !== "rebasing") {
    return {
      state: observed,
      changed: false,
      reason: `concurrency lost: row was '${observed}', expected 'rebasing'`,
    };
  }

  // Worktree existence guard — `rev-parse --git-dir` is the cheapest
  // probe that fails on both "directory missing" AND "not a git
  // worktree at all" (e.g. operator pruned the worktree but the
  // merger_state row survived). Either case → terminal conflict.
  const wtCheck = await git(["-C", ctx.memberWorktreePath, "rev-parse", "--git-dir"]);
  if (wtCheck.exitCode !== 0) {
    const reason = `missing worktree: ${ctx.memberWorktreePath}`;
    ctx.repo.transition({
      memberBranch: ctx.memberBranch,
      next: "conflict",
      note: reason,
      by,
      transitionedAt: t,
    });
    return { state: "conflict", changed: true, reason };
  }

  // Optional fetch — required in production so remote drift doesn't
  // cause a stale-base rebase. Tests pin fetch=false for local fixtures.
  if (doFetch) {
    const fr = await git(["-C", ctx.memberWorktreePath, "fetch", "origin", ctx.base]);
    if (fr.exitCode !== 0) {
      // Fetch failure is NOT a rebase conflict — surface as a generic
      // runtime error so the dispatcher's outer try/catch logs it
      // and leaves the row in rebasing for the next tick to retry.
      throw new ConfigError({
        what: `perform-rebase: 'git fetch origin ${ctx.base}' failed (exit ${fr.exitCode}): ${fr.stderr.trim()}`,
      });
    }
  }

  const baseRef = doFetch ? `origin/${ctx.base}` : ctx.base;
  const rr = await git(["-C", ctx.memberWorktreePath, "rebase", baseRef]);

  if (rr.exitCode !== 0) {
    // Capture conflict paths BEFORE aborting (abort restores the
    // worktree to clean, which empties porcelain output). Best-effort
    // — a status failure here still leaves the conflict transition
    // accurate, just without a path list.
    const sr = await git(["-C", ctx.memberWorktreePath, "status", "--porcelain"]);
    const conflictPaths = sr.exitCode === 0 ? extractConflictPaths(sr.stdout) : [];
    // Abort always — even if status failed, the worktree is mid-rebase
    // and must be restored. Swallow the abort's own errors (worktree
    // may already be clean if git's internal abort fired).
    await git(["-C", ctx.memberWorktreePath, "rebase", "--abort"]);
    const t2 = now();
    const pathList = conflictPaths.slice(0, 5).join(", ");
    const reason =
      conflictPaths.length > 0
        ? `rebase conflict on ${ctx.memberBranch}: ${pathList}`
        : `rebase failed on ${ctx.memberBranch} (exit ${rr.exitCode})`;
    ctx.repo.transition({
      memberBranch: ctx.memberBranch,
      next: "conflict",
      note: reason,
      by,
      transitionedAt: t2,
    });
    const result: PerformRebaseResult = { state: "conflict", changed: true, reason };
    if (conflictPaths.length > 0) result.conflictPaths = conflictPaths;
    return result;
  }

  // Clean rebase — read the new HEAD sha so the row's baseSha
  // reflects the post-rebase tip. The next tick's mergeMember runs
  // from this new tip against base.
  const rp = await git(["-C", ctx.memberWorktreePath, "rev-parse", "HEAD"]);
  if (rp.exitCode !== 0) {
    throw new ConfigError({
      what: `perform-rebase: 'git rev-parse HEAD' failed after clean rebase (exit ${rp.exitCode}): ${rp.stderr.trim()}`,
    });
  }
  const newBaseSha = rp.stdout.trim();
  const t2 = now();
  const reason = `rebase clean — new tip ${newBaseSha.slice(0, 7)}`;
  ctx.repo.transition({
    memberBranch: ctx.memberBranch,
    next: "ready_to_merge",
    note: reason,
    by,
    transitionedAt: t2,
    baseSha: newBaseSha,
  });
  return { state: "ready_to_merge", changed: true, reason, newBaseSha };
}

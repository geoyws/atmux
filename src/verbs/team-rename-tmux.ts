// ADR-027 T5 — orchestration steps 4 + 8 for `atmux team rename`.
//
// Lives in its OWN file (not team-rename.ts) to dodge the
// shared-worktree file-overwrite race observed mid-EPIC e-1e223687
// (T2/T3/T4/T5 all editing team-rename.ts in parallel; sibling Write
// snapshots clobbered each others' work). The pattern is propagated
// across T3/T4 too — team-rename-fs.ts (T3) + team-rename-cockpit.ts
// (T4) — so each lane ships its own file in parallel. Re-fold or
// keep split during T6/T7; the export surface here is stable.
//
// Step 4 — `renameTeamViewerWindow` — cockpit team-viewer window
// rename (single tmux rename-window against the cockpit socket per
// ADR-162). ADR-027's original §step 3 text (`__<old>__*` per-pane
// rename) is pre-ADR-135 and no longer applies: in-cage per-member
// windows live under the per-team socket and don't carry the team
// name in their window-name. The only post-ADR-135 surface that
// carries the bare team-name as a window-name is the cockpit
// team-viewer window. T7 captures this in the ADR-027 §Deviations
// section.
//
// Step 8 — `renamePerMemberBranches` — opt-in (via `--force-branches`)
// per-member branch rename `<oldName>-<member>` → `<newName>-<member>`
// both locally + (optionally) on origin. Atomic-multi-ref push
// preferred to keep the remote ref-namespace consistent in a single
// round-trip; per-branch fallback on atomic-unsupported / hook-rejected.

import { defaultGitSpawn, type GitSpawn } from "../abstractions/branch-merge.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import { ConfigError } from "../errors.ts";
import type { RollbackStep } from "./team-rename.ts";

// ============================================================
// Step 4 — cockpit team-viewer window rename
// ============================================================

export interface RenameTeamViewerWindowOpts {
  /** Cockpit-pinned tmux namespace (caller passes
   *  `createTmux({ socket: "atmux-cockpit" })`). */
  tmux: TmuxNamespace;
  /** Cockpit session name (from `cockpit.json :: cockpitSession`,
   *  typically `"atmux_cockpit"`). */
  cockpitSession: string;
  oldName: string;
  newName: string;
}

/** Locate the team-viewer window in the cockpit session whose name
 *  equals `oldName` (ADR-135 contract: team-viewer windows carry the
 *  bare team name), rename it to `newName`, and return a
 *  `RollbackStep` whose `undo()` renames back. Returns an identity
 *  step (no-op undo) if either:
 *
 *   - `listWindows` throws (cockpit unreachable / socket missing) —
 *     same orphan-tolerance the cron step takes.
 *   - the team-viewer window is absent (cockpit was rebuilt without
 *     this team enabled; legitimate state, not an error).
 *
 *  Only the FIRST window matching `oldName` is renamed. Cockpit
 *  shouldn't host multiple team-viewer windows for the same team
 *  (ADR-089 cockpit-rebuild dedupes); if it does, the orchestrator
 *  call site can re-invoke after one rename to sweep duplicates. */
export async function renameTeamViewerWindow(
  opts: RenameTeamViewerWindowOpts,
): Promise<RollbackStep> {
  const { tmux, cockpitSession, oldName, newName } = opts;
  let windows: Awaited<ReturnType<TmuxNamespace["window"]["listWindows"]>>;
  try {
    windows = await tmux.window.listWindows(cockpitSession);
  } catch {
    return {
      label: `step 4 — rename-team-viewer-window ${oldName} → ${newName} (cockpit unreachable; skipped)`,
      undo: async () => {},
    };
  }
  const target = windows.find((w) => w.name === oldName);
  if (target === undefined) {
    return {
      label: `step 4 — rename-team-viewer-window ${oldName} → ${newName} (window not found; skipped)`,
      undo: async () => {},
    };
  }
  const windowTarget = `${cockpitSession}:${target.index}`;
  await tmux.window.renameWindow(windowTarget, newName);
  return {
    label: `step 4 — rename-team-viewer-window ${oldName} → ${newName}`,
    undo: async () => {
      await tmux.window.renameWindow(windowTarget, oldName);
    },
  };
}

// ============================================================
// Step 8 — per-member branch rename (--force-branches)
// ============================================================
//
// Per ADR-082 the per-member branch shape is `<base>-<member>` where
// `<base>` is the team's trunk-base; in steady state the team name ===
// the trunk-base, so renaming the team renames the base. Atomic
// multi-ref push (one round-trip handling create + delete) is
// preferred per ADR-027 §OQ H3 spirit — minimize the window of
// cross-ref inconsistency. Fall back to per-branch push (create
// first, delete second) when `--atomic` is rejected so sibling
// fetches mid-rename always see ≥1 branch per member.
//
// Rollback restores both local + remote shape to the original
// `<oldName>-<member>` names. Best-effort: per-step throws in the
// rollback engine are collected, not aborted; partial restore is
// logged for operator audit.

/** Minimal member shape consumed by branch rename — only `name` is
 *  required. The full `TeamMember` (label, role, lane, ...) is
 *  irrelevant to branch addressing; accept the narrow shape so
 *  callers can pass arbitrary `{ name }` records (test fixtures +
 *  production team.json members alike). */
export interface BranchRenameMember {
  name: string;
}

export interface RenamePerMemberBranchesOpts {
  /** Path to the team's git repo (worktree root or bare-repo).
   *  Threaded through to `git -C <path>` on every invocation. */
  teamDir: string;
  members: ReadonlyArray<BranchRenameMember>;
  oldName: string;
  newName: string;
  /** When true, push the rename to `origin` (create new ref + delete
   *  old ref). Atomic-multi-ref preferred; per-branch fallback on
   *  atomic-unsupported. Default `false`. */
  push: boolean;
  /** Git spawn override for test injection. Default
   *  {@link defaultGitSpawn}. */
  git?: GitSpawn;
}

export type BranchRenameOutcome =
  /** Local rename succeeded; `pushed` describes the remote outcome. */
  | { member: string; status: "renamed"; pushed: "atomic" | "per-branch" | "skipped" }
  /** Old branch absent + new branch absent → nothing to do for this member. */
  | { member: string; status: "skipped-missing" }
  /** Old branch absent BUT new branch present — manual rename already
   *  happened OOB. Treat as success (no-op locally + no-op remotely). */
  | { member: string; status: "skipped-already-renamed" };

export interface RenamePerMemberBranchesResult {
  rollback: RollbackStep;
  outcomes: ReadonlyArray<BranchRenameOutcome>;
}

/** Per-member branch rename — local + (optionally) remote. Returns a
 *  combined `RollbackStep` that restores every successful rename in
 *  this batch. Caller pushes the returned step onto the `completed[]`
 *  stack so the orchestrator's `rollbackWalk` can call `undo()` if a
 *  downstream step fails.
 *
 *  Per-member outcomes are aggregated for the dogfood transcript
 *  (T6) + reviewer-grep — every member name appears exactly once in
 *  `outcomes` regardless of which branch shape it had on entry. */
export async function renamePerMemberBranches(
  opts: RenamePerMemberBranchesOpts,
): Promise<RenamePerMemberBranchesResult> {
  const git = opts.git ?? defaultGitSpawn;
  const { teamDir, members, oldName, newName, push } = opts;
  const outcomes: BranchRenameOutcome[] = [];
  const renamedMembers: string[] = [];

  for (const m of members) {
    const oldBranch = `${oldName}-${m.name}`;
    const newBranch = `${newName}-${m.name}`;

    const oldExists = await git([
      "-C",
      teamDir,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${oldBranch}`,
    ]);
    if (oldExists.exitCode !== 0) {
      const newExists = await git([
        "-C",
        teamDir,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${newBranch}`,
      ]);
      outcomes.push({
        member: m.name,
        status: newExists.exitCode === 0 ? "skipped-already-renamed" : "skipped-missing",
      });
      continue;
    }

    const renameRes = await git(["-C", teamDir, "branch", "-m", oldBranch, newBranch]);
    if (renameRes.exitCode !== 0) {
      throw new ConfigError({
        what: `team rename: 'git branch -m ${oldBranch} ${newBranch}' failed (exit ${renameRes.exitCode}): ${renameRes.stderr.trim()}`,
      });
    }
    renamedMembers.push(m.name);

    let pushed: "atomic" | "per-branch" | "skipped";
    if (push) {
      const atomicRes = await git([
        "-C",
        teamDir,
        "push",
        "origin",
        "--atomic",
        `${newBranch}:${newBranch}`,
        `:${oldBranch}`,
      ]);
      if (atomicRes.exitCode === 0) {
        pushed = "atomic";
      } else {
        // Atomic unsupported / rejected — fall back to per-branch.
        // Create first, then delete, so cross-tree fetches always see
        // ≥1 branch per member during the transition window.
        await git(["-C", teamDir, "push", "origin", `${newBranch}:${newBranch}`]);
        await git(["-C", teamDir, "push", "origin", `:${oldBranch}`]);
        pushed = "per-branch";
      }
    } else {
      pushed = "skipped";
    }
    outcomes.push({ member: m.name, status: "renamed", pushed });
  }

  const rollback: RollbackStep = {
    label: `step 8 — rename-per-member-branches ${oldName} → ${newName} (${renamedMembers.length} branch${renamedMembers.length === 1 ? "" : "es"})`,
    undo: async () => {
      for (const memberName of renamedMembers) {
        const oldBranch = `${oldName}-${memberName}`;
        const newBranch = `${newName}-${memberName}`;
        await git(["-C", teamDir, "branch", "-m", newBranch, oldBranch]);
        if (push) {
          const atomicRes = await git([
            "-C",
            teamDir,
            "push",
            "origin",
            "--atomic",
            `${oldBranch}:${oldBranch}`,
            `:${newBranch}`,
          ]);
          if (atomicRes.exitCode !== 0) {
            await git(["-C", teamDir, "push", "origin", `${oldBranch}:${oldBranch}`]);
            await git(["-C", teamDir, "push", "origin", `:${newBranch}`]);
          }
        }
      }
    },
  };

  return { rollback, outcomes };
}

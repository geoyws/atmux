---
name: ghostbuster
description: Sweep mergeable epic-team branches in the CURRENT cage's repo — merges what's ahead of trunk, deletes what's fully merged, leaves active worktrees alone. Scoped to the calling team only (NOT cross-cage). `/atmux:ghostbuster [--dry-run] [--no-merge] [--no-delete]`.
argument-hint: [--dry-run] [--no-merge] [--no-delete]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:ghostbuster — Mergeable-epic sweep + stale-branch cleanup

## How to invoke

Run the script and emit its stdout **verbatim**. The script does everything — branch enumeration, merge classification, conflict-aware merge attempts, push to origin, and stale-branch deletion. **Do not re-run sub-commands yourself; do not re-format the output.**

```bash
${CLAUDE_PLUGIN_ROOT}/skills/ghostbuster/scripts/ghostbuster.sh $ARG
```

Pass `$ARG` through verbatim — the script handles `--dry-run`, `--no-merge`, `--no-delete`.

If `${CLAUDE_PLUGIN_ROOT}` is unset (legacy install), fall back to `~/.claude/plugins/atmux/skills/ghostbuster/scripts/ghostbuster.sh`.

### Attention-header prepend (after script emits)

The script emits per-branch verdicts (✅ MERGED / 🟡 DEFERRED / 🗑 DELETED / ⏭ SKIPPED). The operator scans these but needs a *single sentence at the top* telling them whether the report needs their action or is just FYI.

**Before the verbatim script output, prepend exactly one of these three header lines** based on what the script did:

- `**👁 Needs your call** — <N branches deferred: <reasons>>` — when ANY branch was DEFERRED due to merge conflicts, design-level work needed, or other blockers requiring a human decision
- `**⚠ Watching** — <N branches merged, M deferred>` — when at least one branch merged cleanly AND at least one was deferred
- `**✅ Sweep clean** — <N branches merged, M stale branches deleted, trunk pushed>` — when everything either merged cleanly or was a routine stale-branch delete

If the script's verdict was "nothing to do" (no mergeable branches, no stale branches), prepend:
- `**✅ All clean** — no mergeable epic-team branches; no stale branches to prune.`

## Arguments

- `--dry-run`: report what WOULD happen without merging or deleting anything. Always safe to run.
- `--no-merge`: skip the merge step (still does the stale-branch delete).
- `--no-delete`: skip the stale-branch delete step (still does the merge).

## What it does (1-line summary per step)

1. **Detects calling cage** — reads `.atmux/team.json` or falls back to `git config --get remote.origin.url` to determine the team name; refuses if `git rev-parse --git-dir` fails.
2. **Determines trunk branch** — `$GHOSTBUSTER_TRUNK` env override wins; otherwise resolves via `origin/HEAD` (the repo's default branch), then falls back to local `main` / `master`, then the current branch if it's not an `*-epic-*` branch.
3. **Enumerates epic-team branches** — `git branch -l "${TRUNK}-epic-*"` (matches the spawn-epic naming convention per ADR-090).
4. **Excludes active worktrees** — branches with checkouts under `git worktree list` are NEVER deleted (would orphan the worktree); they CAN be merged if ahead.
5. **Excludes deploy/e2e variants** — branches matching `*-e2e` or `*-staging` are deploy targets; skipped entirely.
6. **Classifies each remaining branch:**
   - **MERGEABLE** (+commits ahead, no conflicts) → merge with `--no-ff`, commit, queue for push
   - **DEFERRED** (+commits ahead, conflicts present) → report, leave for human
   - **CONTENTLESS-MERGE** (+1 ahead but the single commit is a merge whose parents are both already in trunk) → delete branch, nothing to merge
   - **STALE** (0 ahead, fully merged) → delete branch
   - **ACTIVE** (has worktree) → skip
7. **Pushes** `${TRUNK}` to `origin/${TRUNK}` if any merges landed (respects a push-policy gate — refuses if the trunk name matches `*-staging` / `main` / `master`, which require explicit operator authorization).
8. **Emits final markdown report** on stdout.

## Key invariants (so the model knows what it's reading)

- **Single-team scope.** Operates ONLY on branches matching `${TRUNK}-epic-*`. Does NOT touch other teams' branch namespaces. Does NOT cross cages.
- **Worktree-safety.** Branches with active worktrees are never deleted — would orphan the working tree. Merge IS attempted from a worktree branch if the worktree is clean (no uncommitted state per `git status --porcelain`). If the worktree is dirty, the branch is DEFERRED with reason "team has uncommitted changes" — operator/team must commit or stash before re-running.
- **Submodule presence.** When merging an epic branch, submodule pointer conflicts are reported but NOT auto-resolved — they need cross-product coordination.
- **Conflict-aware.** If `git merge --no-ff` produces conflicts, the script aborts that merge and marks the branch as DEFERRED. Does NOT attempt `-X ours/theirs` heuristics. Sweep continues with the next branch.
- **Push gate.** Refuses to push to `${TRUNK}` if `${TRUNK}` matches `*-staging` / `master` / `main` (those require explicit operator authorization). Per-developer feature branches auto-push.
- **Worktree placement** for any merge work goes in `.claude/worktrees/ghostbuster-YYYYMMDD-HHMMSS/` and is cleaned up at end. Merges always happen in a worktree, never via stash.

## When the script fails or surprises

- If not in a git repo → script exits 1 with a one-line error.
- If trunk branch can't be determined → script asks the operator to set `GHOSTBUSTER_TRUNK=<branch>` and exits 1.
- If a branch with a worktree has commits ahead → reports it but doesn't attempt to merge (worktree may have uncommitted state).
- If all epic branches are already merged + no stale ones → reports "all clean" and exits 0.
- Branches outside the `${TRUNK}-epic-*` convention (e.g. peer feature branches) are not in scope — handle those via direct `git merge` invocation, not `/atmux:ghostbuster`.

## Examples

```
/atmux:ghostbuster              # full sweep — merge + delete + push
/atmux:ghostbuster --dry-run    # report what WOULD happen, take no action
/atmux:ghostbuster --no-merge   # delete stale branches only, no merges
/atmux:ghostbuster --no-delete  # merge mergeable branches only, no deletes
```

## What it does NOT do

- Cross-cage scope (use `atmux cockpit list` then per-cage invocation if you need that).
- Dispatch follow-up tasks for DEFERRED merges (file via `atmux tell-lead` if needed — that's the operator's call).
- Spawn epic teams (use `atmux team spawn-epic` directly).
- Dissolve epic teams in cockpit (use `atmux team dissolve-epic` directly).
- Touch `*-e2e` / `*-staging` branches (those are deploy carve-outs).

The script is the source of truth for behaviour. If the output looks wrong, read `scripts/ghostbuster.sh`. Do NOT re-implement the procedure in this skill prompt.

## Performance

Single bash invocation; per-branch classification fanned out where possible. Wall-clock typically **2-15s** for a cage with 20-30 epic branches. Most time is in `git rev-list --count` per branch.

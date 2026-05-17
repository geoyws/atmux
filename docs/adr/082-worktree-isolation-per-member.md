# ADR-082: Per-member git worktree isolation — concurrency safety at 20+ member scale

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-12
**Driver-ref**: 2026-05-12 07:15 MYT cockpit driver — *"can we prioritise the git worktree feature? its dangerous to stash right now with over 20members working at the same time"*. Tracked on the kanban as `t-eee0a7f6` (P100, lane=ops).

## Context

### Current state — single shared working tree per team

Every team member in a given atmux team operates with `member.cwd` pointing at the same project directory (e.g. `/root/work/src/atmux` for atmux-team, `/root/work/src/sopx-root` for sopx-guild). Concrete evidence: `.atmux/team.json` has eleven members with identical `cwd: "/root/work/src/atmux"` (enumerated in `atmux::resolveTmuxConfig` consumers). No member-level isolation exists.

This is fine for ≤3-member teams. It fails at 11+ in three observed ways:

1. **`lint-staged` + submodule-`m`-state silently absorbs unrelated content** (CLAUDE.md global rule, line 226). When `git status` shows `Mm` or ` m` for a submodule at commit time, husky's stash/unstash dance during a single member's commit can sweep up another member's untracked-or-unstaged edits into the index. The 2026-05-08 SOPX session lost a `docs/adr/` draft this way.
2. **`git stash push` for hook-bypass / branch-switch sweeps other members' WIP** into the stash entry. Recovering then requires `git stash show -p` archaeology.
3. **`git checkout`/`git pull` on member A invalidates member B's mid-edit state on the same path** — TS strict mode treats the file as truncated, IDE clients reload mid-typing, etc.

### The 2026-05-12 ADR-081 incident demonstrated the failure shape live

While ADR-081 (bootstrap-brief-paste-bug) was being drafted as an untracked file, *another member's commit + auxiliary `git reset` operation in the same working tree erased the file* between the `Write` tool call and the next `git status` check. ADR-081 §"Stash-collision side-incident" documents this — it is the exact bug class this ADR exists to prevent, observed at 11 members. Wednesday's sopx-guild demo runs at 19 members concurrent.

### Demo-week constraint

sopx-guild demo runs **2026-05-13** (tomorrow) with 19 concurrent members. atmux-team runs 11 concurrent. Cockpit will spawn a third team mid-week. Aggregate concurrency: 30+. The MVP for Wednesday is "stash-collisions can no longer eat untracked files." The full design (submodule-level worktrees, branch-per-member, cockpit integration nuance) can land post-demo if the MVP exposes gaps.

### Pre-decomp source-state audit

| Concern | Source-state finding | Scope adjustment |
|---|---|---|
| Worktree provision | No `src/abstractions/worktree.ts` exists; `git worktree` is never shelled today. | Net-new abstraction. |
| Member `cwd` resolution | `team.json` writes `cwd` literally; `start.ts` passes it verbatim to `tmux new-window`. | Net-new resolver: if `team.worktreeIsolation === true`, override `cwd` to `<repo>/.atmux/worktrees/<member>/`. |
| Doctor integrity check | `doctor.ts` checks tmux/cron/socket/cursor parity but not worktree-vs-team.json drift. | Net-new probe. |
| Cockpit topology | ADR-018 isolates per-team tmux sockets; ADR-063 manages cage rebuild. Neither knows about worktrees. | No cockpit changes for MVP — worktree provision happens at `atmux start` time, transparent to cockpit. |
| Stop teardown | `stop.ts` kills the tmux session and archives state; no per-member fs cleanup. | Net-new `git worktree remove --force` loop on `--force`-mode stop. |
| Existing teams | All current `team.json` files default to shared-tree behaviour. | New `team.worktreeIsolation` field defaults `false` — no breaking change. |

## Schema additions

| Field | Default | Used by | Read-site |
|---|---|---|---|
| `team.worktreeIsolation` | `false` | §1 (start), §3 (stop), §5 (doctor) | `src/verbs/start.ts` cwd-resolver; `src/verbs/stop.ts --force` teardown; `src/verbs/doctor.ts` integrity probe |
| `team.worktreeRoot` | `<atmuxDir>/worktrees` | §1 (start) | `src/abstractions/worktree.ts::resolveWorktreePath` |

Both fields default to current-behaviour-preserving values (no isolation). Existing teams pick them up at next `atmux start` schema-load with no `team.json` migration required. Opt-in by appending `"worktreeIsolation": true` to a team's `team.json`.

## Decision

### (1) Per-member git worktree at `<atmuxDir>/worktrees/<member>/`

When `team.worktreeIsolation === true`, `atmux start` provisions one worktree per member at `<atmuxDir>/worktrees/<member>/` BEFORE spawning the claude TUI. Worktree branches off the team's currently-checked-out branch (e.g. `geoyws` for atmux). All members share the `.git` directory; isolation is at the working-tree level only.

```bash
# Pseudocode
for member in team.members:
  wt_path = "${atmuxDir}/worktrees/${member.name}"
  if not exists(wt_path):
    git -C <repo> worktree add --detach "$wt_path" HEAD
    # OR with branch: git -C <repo> worktree add "$wt_path" "$current_branch"
  member.cwd = wt_path  # in-memory override; team.json on disk unchanged
```

**Branch model for MVP — all members on the SAME branch.** Each worktree is created with `git worktree add <path> <current-branch>`, so members A and B both point at e.g. `geoyws`. Concurrent commits to the same branch behave exactly like two developers on two machines: each commits locally, pushes when ready, conflicts surface at push time as visible-and-resolvable rebase conflicts. **What this fixes**: silent stash/lint-staged content theft. **What this does NOT fix**: same-file merge conflicts at push (those were always broken; they just become visible instead of silent).

### (2) `team.json` schema extension

Add at team root level (sibling to `members`, `tmuxTmpdir`, etc.):

```json
{
  "name": "atmux",
  "worktreeIsolation": true,
  "worktreeRoot": ".atmux/worktrees",
  "members": [...]
}
```

`worktreeRoot` is a relative path (resolved against `atmuxDir`), so the same `team.json` is portable across machines. Default `.atmux/worktrees` keeps everything under the dotdir.

### (3) `atmux start` integration

`src/verbs/start.ts` gains a `provisionWorktrees(team, atmuxDir)` step BEFORE the per-member spawn loop:

1. Skip if `team.worktreeIsolation !== true`.
2. Resolve repo root via `git -C <repo> rev-parse --show-toplevel`.
3. Resolve current branch via `git -C <repo> branch --show-current`.
4. For each member, `git -C <repo> worktree add <path> <branch>` if `<path>` does not already exist. If it exists and is on the wrong branch, log a warning + skip (operator decides — don't auto-checkout).
5. Override member's runtime `cwd` to the worktree path.
6. Continue with normal `tmux new-window` + claude spawn against the new `cwd`.

Failure surface: if `worktree add` errors (locked .git, dirty path, network mount), log per-member warning + fall back to shared-tree `cwd` for that one member. Do NOT abort the whole team start.

### (4) `atmux stop --force` teardown

Add a `pruneWorktrees(team, atmuxDir)` step BEFORE the tmux kill-session call (so members are still alive to commit anything pending — though stop --force isn't really for clean exits):

1. Skip if `team.worktreeIsolation !== true`.
2. For each member: if `<atmuxDir>/worktrees/<member>/` exists AND is dirty, log a warning + SKIP that worktree (don't `--force` over uncommitted work — operator handles).
3. For each member with a clean worktree: `git -C <repo> worktree remove <path>`. Idempotent.
4. Log summary: `pruned N/M worktrees; K dirty (left for operator)`.

`atmux stop` (no `--force`) does NOT prune. Worktrees survive normal stop+start cycles.

### (5) `atmux doctor` worktree probe

New doctor check class `worktree-isolation`:

- `worktree-missing` — `team.worktreeIsolation === true` but `<atmuxDir>/worktrees/<member>/` does not exist for some member. (Auto-fixable — re-run §3 provision.)
- `worktree-orphan` — `<atmuxDir>/worktrees/<dir>/` exists but `<dir>` is not in `team.members[].name`. (Suggest `git worktree remove`; auto-fixable with `--fix`.)
- `worktree-wrong-branch` — worktree exists but is on a different branch than the team's current branch. (Surface only; do NOT auto-checkout.)
- `worktree-disabled-but-present` — `worktreeIsolation` is false but `<atmuxDir>/worktrees/` has entries. (Suggest cleanup; do NOT auto-delete.)

Same `--fix` policy as existing doctor classes: `--fix` resolves the auto-fixable subset, surfaces the rest.

### (6) Documentation + tests

- README + `docs/HANDOFF.md` get a "Per-member worktree isolation" section explaining when to opt in, the trade-off (push-conflict visibility), and the cleanup model.
- bats/bun tests exercise: provision idempotence, dirty-worktree skip on stop, doctor's four anomaly classes, schema-default behaviour for legacy `team.json`.

## Resolved open questions (recommended defaults from kanban Epic body)

OQ1, OQ2, OQ6, OQ7, OQ8 resolved here. OQ3 + OQ4 + OQ5 deferred (see Out of scope). Each resolution registered separately via `atmux decisions add` for driver override visibility.

| OQ | Resolution | Reversibility | Rationale |
|---|---|---|---|
| OQ1 lifecycle | Created on `atmux start`, idempotent | low | Simplest; survives rotate; deterministic operator surface |
| OQ2 path | `<atmuxDir>/worktrees/<member>/` | low | Co-located with state; survives reboot; same disk quota |
| OQ6 branch model | All members on the team's current branch (shared) | **high** | Trade-off: visible push-conflicts vs invisible stash-conflicts. MVP picks visible. Override = per-member feature branches (separate ADR). |
| OQ7 cleanup on rotate | Worktree survives `rotate-lead` and `rotate <member>` | low | Rotation re-briefs context, doesn't touch workspace |
| OQ8 dirty handling on stop | Skip dirty worktrees on `--force` stop, log warning | medium | Matches `feedback_destructive_ops_need_explicit_auth.md` — never silently destroy unpushed work |

## Out of scope (deferred — separate ADR if needed)

- **OQ3 commit batching** — gitter pattern vs per-member commits. Independent of worktree isolation; existing teams already exhibit both patterns. Defer to a separate "commit-funneling policy" ADR.
- **OQ4 submodule worktrees** — sopx has 5+ submodules; per-member submodule worktrees would 5x the disk + provisioning cost. **MVP keeps submodules shared.** If sopx-guild demo prep on Wed exposes submodule-level collisions, file a follow-up ADR for per-member submodule worktrees (see decisions log entry).
- **OQ5 cockpit topology integration** — cockpit's `cockpit rebuild` defers to `atmux start` per team; no special hook needed for MVP. Revisit only if cockpit-cycling exposes a worktree race.
- **Branch-per-member feature branches** — would convert "shared-branch with push-conflicts" to "merge-train with PR fan-in." Larger lift; demo-week unaffordable; defer.

## Consequences

- **One round of edits across `src/abstractions/worktree.ts` (new), `src/verbs/start.ts`, `src/verbs/stop.ts`, `src/verbs/doctor.ts`, `src/core/team-config.ts` (Zod).** Estimate: ~250 LOC additions + ~30 LOC modifications + ~120 LOC tests.
- **Existing teams unaffected by default** — `worktreeIsolation: false` is the default. atmux + sopx-guild + future teams opt in by appending one field to `team.json`.
- **Demo-Wed sopx-guild gets a clean MVP** — provision-on-start + dirty-skip-on-stop + doctor probe. Submodule isolation deferred but visible as a known gap.
- **Push conflicts become visible** — two members editing the same file under the SAME shared branch will discover the conflict at `git push` rather than at silent-stash-eaten time. Net-positive for ops visibility; net-negative for "everything just merges" muscle memory.
- **Disk cost** — N members × repo size. atmux is small (~50MB tracked); 11 members = ~550MB. sopx is larger (~1.2GB tracked); 19 members = ~22GB shared `.git` dedup'd by hardlinks within `git worktree add`. Acceptable on hax (2TB free).
- **Rollback** — set `worktreeIsolation: false` in team.json + `atmux stop --force` (which prunes) + `atmux start`. One-line revert.

## Cross-references

- `t-eee0a7f6` — kanban Epic (P100, lane=ops) — this ADR resolves its open questions.
- ADR-018 — per-team tmux socket isolation. Same blast-radius framing (per-team vs per-member).
- ADR-035 — per-member-branch recursive ops. Branch-model precedent (different scope: recursion, not worktrees).
- ADR-063 — cockpit verb port. Worktree-aware cockpit deferred per OQ5.
- ADR-081 — bootstrap-brief-paste bug. The "Stash-collision side-incident" section is the live demo of why this ADR matters.
- CLAUDE.md global "Hooks, Commits, Tooling" §"lint-staged + submodule-`m`-state silently absorbs content" — the operator-side rule this ADR makes structurally unnecessary.

## Bundle history

For future `git bisect` / `git blame` walkers landing on the W1 commit:

- **`99e4879` feat(worktree): src/abstractions/worktree.ts — ADR-082 W1 helpers** (2026-05-12) bundled two **independent** task scopes via a concurrent `git add` race on the shared worktree (the exact bug class this ADR exists to eliminate).
  - **`t-0b25c26b` (ADR-082 W1, this ADR's first impl Task)** — `src/abstractions/worktree.ts` + `tests/unit/abstractions/worktree.test.ts`. ~665 LOC.
  - **`t-75e20e29` (SPEC-063 Pending-decision Discord watcher, unrelated)** — `src/core/whip-decisions-check.ts` + `tests/unit/core/whip-decisions-check.test.ts` + `src/core/common.ts::decisionsLogPath` helper + `src/verbs/whip.ts` Check 0 wiring. ~395 LOC. Authored by up-impl-2 in parallel; their `git add <files>` raced with the W1 author's `git add -A` and got absorbed pre-`git commit`.
- The bundle was already pushed when the absorb surfaced, so `git reset --soft HEAD~1` + re-split was not safe per the "no force-push without explicit auth" rule (`feedback_destructive_ops_need_explicit_auth.md`). Attribution is recorded here instead.
- The structural fix for this exact race is **this ADR's MVP itself** — per-member worktrees give each teammate an isolated `.git/index` so a sibling's `git add -A` cannot reach into another teammate's staged files. The bundle is a self-referential demo: W1 shipped the abstraction that, once W3+ wire it into `atmux start`, would have prevented its own bundle.
- Filed via `t-bce89843`. Third parallel-`git add` bundle observed this session — pattern documented under memory `feedback_parallel_git_race_bundles.md`.

# CONVENTION-067 — `develop` branch for integration

> **Status**: accepted 2026-05-14 · George Yong  
> **Source**: driver-inbox.md 2026-05-07 21:42 entry · kanban Task `t-221eb576`  
> **Authored by**: docs worker, 2026-05-14, during a session that hit the
> cross-branch dep problem this convention prevents.  
> **Not an ADR** — this is a workflow process, not an architectural decision.
> ADR-066 (worktree-per-member) is the architectural anchor; this convention
> sits on top of it.

## TL;DR

```
feat/<topic>           ──┐
<account>-<role>       ──┼──→  develop  ──→  main
geoyws-<role>          ──┘                   (release cuts only)
```

- Branch off `develop`, not `main`.
- Push to your own `<account>-<role>` (or `feat/<topic>`) branch.
- Merge to `develop` once your slice is green; **never push to `main`**.
- `main` only advances on a release-cut PR from `develop`.

If you are a worker member (atmux team-of-teams), the team-lead is
responsible for routing your branch onto `develop` — but the actual
integration is owner-of-the-branch work (no gitter; see CLAUDE.md
"workers commit + push own work"). When your branch is green AND has
landed on `develop`, the lead's role is just to record it in the
kanban.

## Why this exists

**The problem**: worker branches accumulate kanban tasks marked `done`
even though sibling workers can't see the code. Example observed
2026-05-14:

- Task `t-289119f2` (whip velocity-gate kernel) was marked `done` on the
  kanban — `src/core/velocity.ts` + `src/core/whip-strikes.ts` ship from
  commit `2a7db33`.
- Follow-up task `t-5d85dddb` claimed by the `docs` worker assumed those
  files existed locally and depended on them.
- But `2a7db33` lives on `geoyws-parity-cron-impl`, not `geoyws-docs`.
  The follow-up task was blocked the moment it was claimed.

This is the integration gap. The kanban-state ("task is done") was true
in one branch's view of the world, but every other worker had a divergent
view. Without an integration rhythm, the kanban silently drifts from any
single working-copy reality.

`develop` is the cure: a single branch where "done" actually means "every
worker can see the code on next pull."

## Topology

| Branch                           | Purpose                                                   | Push policy                       |
|----------------------------------|-----------------------------------------------------------|-----------------------------------|
| `main`                           | Released code. Tagged at version cuts.                    | **Manual only** — release process.|
| `develop`                        | Integration tip. All worker work converges here.          | Merge-via-PR or fast-forward only.|
| `<account>-<role>`               | Per-worker per-team-role branch (e.g. `geoyws-docs`,    `geoyws-parity-cron-impl`). Long-lived in atmux's team-of-teams model. | Worker auto-push allowed (per `<product>-<dev>-staging` convention in global CLAUDE.md). |
| `feat/<topic>`                   | Short-lived topical branch (e.g. `feat/sqlite-state`).   | Worker auto-push allowed; squashed into `develop` at merge. |

The `<account>-<role>` naming pattern is enforced by ADR-066's
worktree-per-member layout — `.atmux/worktrees/<role>/` is the worker's
working copy, and `<account>-<role>` is the upstream tracking branch.

## Lifecycle

### Worker branch

1. **Create**: branch from `develop` (`git checkout -b geoyws-docs origin/develop`).
   If your worktree is already on the branch from a previous session,
   first `git pull --ff-only origin develop` then `git merge develop`
   into your branch (or rebase) to refresh.
2. **Work**: claim tasks via `atmux claim --next --as <role>`, commit on
   your branch, push to `origin/<branch>` freely. Workers commit and
   push their own work — there is no gitter (per CLAUDE.md
   "atmux team has no gitter").
3. **Integrate**: when a slice is green (typecheck + tests + your
   target acceptance gates), open a PR `<your-branch>` → `develop`.
   For solo-operator flows you can fast-forward merge locally and push
   `develop`; CI gates the same way regardless.
4. **Continue**: after integrating, `git merge develop` (or `rebase`)
   back into your branch to absorb sibling commits. This is the
   moment that prevents the gap CONVENTION-067 exists for — your
   branch now has every other worker's `done` work.

### `develop` branch

Behaves like a tip: worker PRs land in fast-forward or merge-commit
style (project preference). No direct commits — every change comes from
a worker branch. Treat `develop` as **always-green** — failing tests on
`develop` are a P0 because every active worker depends on its tip.

### `main` branch

Advances only at release boundaries. Release process:
1. PR `develop` → `main` (review + CI).
2. Tag `vX.Y.Z` on the merge commit.
3. Cut release notes from CHANGELOG `[Unreleased]` section.
4. Reset CHANGELOG `[Unreleased]` to empty.

## Integration rhythm

**As a worker**: integrate **before claiming the next task** when:

- Your previous commit just shipped a slice (natural integration boundary).
- You're about to claim a task whose body references a sibling task's
  output (e.g. "depends t-XXXX" or "extends the kernel from T1").
- You've been on the branch ≥ a day without merging from `develop`.

The driver/lead may also explicitly nudge ("integrate before
continuing") via `atmux tell-lead` or `atmux reply`.

**As a lead**: when dispatching a Task whose body says "depends on
t-XXXX", state explicitly whether the worker should integrate from
`develop` first OR cherry-pick the specific commit. Both are valid —
develop-integration is preferred when t-XXXX is already on `develop`;
cherry-pick is preferred when t-XXXX is on a sibling branch not yet
merged.

## How this interacts with the kanban

The kanban tracks task lifecycle (`todo` / `in-progress` / `done` /
`blocked`). It does **not** track integration state. A task is `done`
when the worker's branch has the work committed + pushed — it is **not**
a guarantee that the work is visible on `develop`.

Two concrete implications:

1. **Reading `done` is a one-branch statement.** "Task t-XXXX is done"
   means "task t-XXXX's code exists on the branch where it was
   committed." If you need t-XXXX's code to do your own work, check
   `git log <sha> --branches` or read the commit-ping in the lead-outbox
   to find out which branch carries it.
2. **Blocked-by-integration is a valid block.** If you claim a task,
   discover its dep's code isn't on your branch, and decide
   integration is out of scope: `atmux task move <id> blocked`, surface
   to lead with the specific dep + the source branch, and pick the next
   claimable task. The current docs worker did exactly this on
   `t-5d85dddb` (2026-05-14): released to `todo`, `atmux reply`'d the
   driver, picked the next operator-named docs task.

## Migration from current state

As of 2026-05-14, `origin/develop` is ~45 commits ahead of `origin/main`
and ~100 commits behind every active worker branch. This is the legacy
state that CONVENTION-067 codifies a fix for.

**No big-bang merge.** The clean path is:

1. Each worker, on a natural pause point (after their current slice
   ships), opens a PR `<their-branch>` → `develop` with the cherry-pick
   subset that's mergeable now. The rest stays on the worker branch
   for follow-up.
2. `develop` absorbs the workers' work piecewise.
3. After ~1 week of this rhythm, `main` PRs from `develop` cut a
   release that catches up the public history.

The atmux project's own `atmux task list --status done` is the
authoritative index of what each worker has shipped — workers and lead
walk it together when negotiating which task IDs land in the first
catch-up PR.

## What this convention does NOT prescribe

- **PR review policy.** Solo operator + agent workforce means
  conventional code review is replaced by reviewer-agent gating
  (per ADR-077 §F2 complaint flow and the reviewer-vs-auditor split
  in CLAUDE.md). When external contributors arrive, this convention
  gets a §"External PR review" addendum.
- **Conventional-commits style.** Already covered by global CLAUDE.md
  "Commits: conventional commits".
- **Rebase vs merge-commit on `develop` integration.** Project
  preference is merge-commit (preserves the per-worker branch shape in
  history); rebase-and-fast-forward is also acceptable for short-lived
  `feat/<topic>` branches. Either is fine — pick one per PR.

## Refs

- ADR-066 — worktree-per-member layout (the architectural anchor).
- CLAUDE.md §Push Policy — push-to-primary-staging is George-manual;
  this convention is orthogonal (governs which dev branch to push from).
- CLAUDE.md §"atmux team has no gitter" — workers own their pushes.
- Kanban tasks `t-221eb576` (this convention) + `t-5d85dddb` (the
  symptom that motivated writing it down).

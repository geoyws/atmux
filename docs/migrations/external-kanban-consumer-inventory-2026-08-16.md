# External Kanban consumer inventory — 2026-08-16

This is the removal checklist for ADR-275. It is a source inventory, not a cutover receipt. The external backend remains off by default.

## Current receipts

- Kanban authority branch: `/root/work/src/kanban`, `main` at `f95675b` (local only).
- atmux migration branch: `atmux-kanban-cutover` at `00094cc` (local isolated worktree only).
- Kanban gate: 25 tests pass, TypeScript clean.
- atmux adapter gate: 7 focused tests pass, 34 assertions, TypeScript clean.
- Read-only production import probe: 114 epics, 91 stories, 1,138 tasks; one preserved dangling dependency and no missing parents.
- Production activation, merge, push, dual writes, and legacy deletion: not performed.

## Migrated behind `ATMUX_KANBAN_BACKEND=external`

- Task list/show/add/move/update, dependencies, assignment, lane, deliverable, driver-only, claim, done, and blocker notes.
- Normalized task-to-story-to-epic hierarchy updates.
- Epic add/list/show/readiness/dependencies/eligibility/basic advance.
- Story add/list/show/body/acceptance-criteria update.
- Installed-CLI integration and proof that focused external writes do not create `.atmux/state.db`.

## Known parity gaps

- Story advance, signoff/unsignoff, reviewer dispatch, merge dispatch, and parent-epic flip need one Kanban transaction.
- Epic review summary dispatch and legacy event emissions are not yet parity-complete.
- Task removal needs an explicit archive/history policy; it must not silently destroy the durable ledger.
- Durable prepare/activate/status/rollback commands and an observation-period no-legacy-write receipt do not exist yet.
- Secondary automation readers and writers below still require conversion or retirement.

## Direct `KanbanRepo` consumers (15 files)

- `src/core/epic.ts`
- `src/core/gitter-merge-handler.ts`
- `src/core/inbox.ts`
- `src/core/intra-team-merge-dispatcher.ts`
- `src/core/kanban.ts`
- `src/core/orchd-dispatch/epic-merge.ts`
- `src/core/orchd-dissolve-solo-worker.ts`
- `src/core/orchd-spawn.ts`
- `src/core/release-notes-sweep.ts`
- `src/core/repositories/kanban-repo.ts`
- `src/core/story.ts`
- `src/verbs/committer.ts`
- `src/verbs/doctor/state.ts`
- `src/verbs/hygiene-tick.ts`
- `src/verbs/migrate-state.ts`

## Indirect import surface

The source scan found 70 files importing the task/epic/story core or schema surfaces. These group into:

- operator verbs: task, claim, dispatch, epic, story, status, report, dashboard, doctor, groom, improve, hygiene, lane ticks, pulse, poke, handoff, team lifecycle;
- orchestration: spawn, dissolve, sweep, merge, post-merge flips, lead handoff/stall, release-note sweep;
- hygiene/repair: cursor self-heal, phantom pruning, lane drift, owner/role/priority repairs;
- projections: inbox, status, dashboard, topo, approvals, budget/fallback briefs;
- schema and migration compatibility.

Re-run the inventory before deletion:

```sh
rg -l 'KanbanRepo' src | sort
rg -l 'from ".*core/(kanban|epic|story)|from "\.\.?/.*(kanban|epic|story)' src | sort
```

## Deletion gate

Do not remove `KanbanRepo`, the work-state tables, or legacy verbs until every direct consumer is gone, every indirect behavior has an external-mode test or an explicit retirement decision, rollback has been exercised, and an observed real run produces no legacy work-state writes.

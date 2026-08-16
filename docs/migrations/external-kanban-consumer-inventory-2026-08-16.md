# External Kanban consumer inventory — 2026-08-16

This is the removal checklist for ADR-275. It is a source inventory, not a cutover receipt. The external backend remains off by default.

## Current receipts

- Kanban authority branch: `/root/work/src/kanban`, `main` at `12e8d49` (local only).
- atmux migration is fast-forwarded into local `atmux-geoyws` through `82f2766`; it is not pushed or activated.
- Kanban gate: 27 tests pass, 137 assertions, TypeScript clean.
- atmux focused adapter, orchestration, projection, and lifecycle suites pass; the latest projection batch passed 416 tests and the lifecycle batch passed 127 focused tests. TypeScript is clean.
- Full-suite receipt is not green: tmux integration fixtures cannot create sockets in the current sandbox, and `epic-auto-merge` has an independent spawn-eligibility fixture failure (`is_ready=0`) before the migrated merge gate.
- Read-only production import probe: 114 epics, 91 stories, 1,138 tasks; one preserved dangling dependency and no missing parents.
- Production activation, push, dual writes, and legacy deletion: not performed. Three live atmux panes were observed, so the stopped-writer acknowledgement could not honestly be supplied.

## Real preparation receipt

The non-activating preparation completed at `2026-08-16T03:00:35.756Z`:

- source `/root/work/src/atmux/.atmux/state.db` remained at its original mtime and SHA-256 `2cd08b599507e0658155b47c888b8999250dd6a83b04d1ad3f9ec7b301e77fd5`;
- the serialized source backup has the same SHA-256 and mode `0600`;
- the private receipt is `/root/work/src/atmux/.atmux/backups/kanban-cutover/2026-08-16T03-00-35.340Z/receipt.json`, mode `0600`;
- the private atmux board is `/root/.local/share/kanban/boards/a876a3a6-8d19-4aa0-aeb0-98badd242565.db`;
- registry and both private boards report SQLite integrity `ok`;
- 1,343 rows imported: 114 epics, 91 stories, and 1,138 tasks;
- one dangling legacy dependency was preserved as warning metadata; no parents were missing;
- activation remains explicitly `not-activated`.

## Migrated behind the durable backend marker

- Task list/show/add/move/update, dependencies, assignment, lane, deliverable, driver-only, claim, done, and blocker notes.
- Normalized task-to-story-to-epic hierarchy updates.
- Epic add/list/show/readiness/dependencies/eligibility/basic advance.
- Story add/list/show/body/acceptance-criteria update.
- Atomic story advance/signoff/reviewer dispatch/merge dispatch/parent-epic completion.
- Orchd task reads, epic spawn state, merge reads, unattended merge sweep, blocker projections, merge gates, dissolve gates, and epic sweep reads.
- Topology, dashboard, status, report, doctor inbox marks, pulse, and Discord progress/heartbeat projections.
- `init`, `stop`, and `groom` lifecycle fences: external mode does not seed, archive, summarize, delete, cull recovery backups, or archive rows from legacy Kanban state.
- Legacy `atmux handoff` is refused in external mode because it cannot atomically checkpoint, release, and transfer a lease; the error routes agents to `kanban handoff create/accept`.
- Durable private marker discovery and `atmux migrate-kanban status`.
- Receipt-gated `activate` and no-data-loss `rollback`: activation requires an unchanged, integrity-checked source backup, exact task/epic/story ID parity, a healthy external board, and an explicit stopped-writer acknowledgement. Rollback refuses once the external board has changed.
- Automatic preparation and activation parity checks for both SQLite-backed and JSON-only legacy projects. JSON imports preserve task-to-story-to-epic hierarchy rather than flattening tasks.
- Installed-CLI integration and proof that focused external writes do not create `.atmux/state.db`.

## Known parity gaps

- Epic review summary dispatch and legacy event emissions are not yet parity-complete.
- Task removal needs an explicit archive/history policy; it must not silently destroy the durable ledger.
- Activate and rollback are implemented and fixture-tested, but neither has been exercised against the live fleet. A stopped-writer/restart protocol and per-project receipts remain required.
- Fleet inventory and migration orchestration remain incomplete. At least one observed project (`auditx-root`) is JSON-only, so the old SQLite-only preparation receipt is not fleet evidence.
- External-mode integration still needs a broad no-legacy-work-state-write receipt, including daemon restart behavior.
- Legacy fallback implementations remain compiled for rollback and must not be deleted before activation, observation, and rollback receipts.

## Remaining direct `KanbanRepo` references (10 files)

- `src/core/epic.ts`
- `src/core/kanban.ts`
- `src/core/orchd-bootstrap.ts`
- `src/core/orchd-dispatch/epic-merge.ts`
- `src/core/orchd-dissolve-solo-worker.ts`
- `src/core/orchd-spawn.ts`
- `src/core/release-notes-sweep.ts`
- `src/core/repositories/kanban-repo.ts`
- `src/core/story.ts`
- `src/verbs/migrate-state.ts`

Most of these are the centralized legacy fallback, injected orchd fallback stores, a type-only documentation reference, or migration-only code. They remain a deletion gate until external activation and rollback are observed.

## Remaining direct work-state SQL

- `src/core/blockers.ts`, `src/core/orchd-merge.ts`, `src/core/orchd-merge-sweep.ts`, and `src/core/dissolve-epic.ts` retain guarded legacy fallback queries.
- `src/core/repositories/kanban-repo.ts` is the centralized legacy implementation.
- `src/verbs/migrate-state.ts` and `src/verbs/migrate-hex-ids.ts` are migration-only.
- Other `state.db` consumers store non-Kanban atmux state such as events, complaints, merge state, refusal telemetry, and inbox transport; they are not automatically candidates for deletion with the work-state tables.

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

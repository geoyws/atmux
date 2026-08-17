# ADR-275 — atmux stops owning work state; `@geoyws/kanban` does

Status: proposed
Date: 2026-08-16
Supersedes in effect: [ADR-060](060-kanban-storage-sqlite.md) (kanban in `state.db`), [ADR-076](076-inbox-in-tasks-table.md) (inbox as a tasks view), and the orchd phase ADRs — [ADR-202](202-orchd-event-loop.md), [ADR-203](203-event-topic-taxonomy.md), [ADR-226](226-orchd-auto-merge.md), [ADR-227](227-orchd-auto-dissolve.md), [ADR-229](229-orchd-auto-push.md), [ADR-250](250-orchd-stale-epic-team-reaper.md)
Relates: [ADR-267](267-agent-continuity-contract.md) (the continuity contract atmux specified and never built), [ADR-219](219-cockpit-mirror.md) (a bus consumer that SURVIVES this), [ADR-266](266-shim-sunset-policy-and-first-sweep.md), [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md)

## Context

atmux grew its own work ledger: tasks, epics, stories, claims, an inbox, and an event bus, all in a per-team `.atmux/state.db`. On top of that sits `orchd`, a daemon that reacts to task and epic events by merging branches, pushing them, spawning epic-team cages and reaping dead ones.

`@geoyws/kanban` (`/root/work/src/kanban`) is a purpose-built replacement for the ledger half: atomic claims with **expiring leases**, dependency-aware pull scheduling, append-only plan/progress/blocker/decision/evidence notes, structured checkpoints, and transactional token-pressure handoffs. It is designed around one failure condition atmux never addressed — *an agent may disappear at any token boundary, and a replacement must resume without conversation history*.

That is not a coincidence. It is [ADR-267](267-agent-continuity-contract.md)'s contract, which atmux specified and **never implemented**: `task_notes`, `checkpoints`, `handoffs`, `task_claims` and `task_dependencies` are all absent from the live database, verified by inspection. **This migration is atmux adopting the thing it decided it needed and did not build.**

### The operating model changed, and that is what makes this tractable

The decisive context is not in the code. Per the operator:

> *"tmux lifecycles are much more minimal now since we don't spawn tuis anymore and we just use a few drivers in each cage."*

A read-only audit measured ~3,100 LoC in orchd with no equivalent in the runtime and recommended defending it. That measurement is correct and its conclusion was right **for the model it assumed**. But the bulk of that capability — epic-team cage spawning, dead-cage reaping, auto-dissolve, and pane-statusline scraping to produce `member.context-high` for auto-rotation — exists to manage *a fleet of spawned TUIs*. With a few drivers per cage and no spawning, it is machinery for a world that is gone.

**Recording that explicitly, because the audit is on file and a future reader will find it and think this ADR ignored it.** It did not. The audit was measured against the previous operating model; this decision is made against the current one.

## Decision

### D1 — The runtime owns the ledger; atmux keeps the verbs

`@geoyws/kanban` becomes the authoritative store for tasks, epics, stories, claims and dependencies. atmux's `task` / `claim` / `epic` / `story` verbs **remain**, as shims over the runtime library.

The verbs stay because the alternative costs more than it buys: every brief, runbook, cron arm and member habit across the cages says `atmux claim --next`. Changing the storage is a code change; changing the operator surface is a retraining exercise on a fleet that is running. atmux stops *owning* work state without anyone having to learn a new command.

The `claim` shim is a straight upgrade rather than a translation: the runtime's claim already covers atmux's full flag surface and adds leases, expiry and atomicity that atmux never had.

### D2 — orchd is retired entirely

All of it, not the kanban-driven subset. The capabilities that die are named honestly in §Consequences rather than discovered later.

Where a capability is still wanted, it returns as an **operator-invoked verb**, not a daemon reacting to an event. `src/verbs/epic-merge.ts` already exists and demonstrates the shape: the mechanics were always separable from the automation on top of them.

### D3 — The task-topic event bus is not migrated. It is orphaned, and that is the point.

This is the finding that decides whether D2 is contained or a rewrite, so it is stated precisely.

Today a task write and its event emit are **one transaction in one file** (`src/core/kanban.ts:462`), and orchd wakes on raw commits to that file (`rust/atmux-orchd/src/main.rs:933`). Moving tasks to a runtime board while emitting events to `state.db` would be a two-phase write across two databases with no shared transaction — crash between them and a task is `done` with no `task.done` event: a silently stalled epic and no error anywhere.

**That problem does not arise, because after D2 nothing consumes those topics.** Verified: the only consumers of the per-team `events` table and `subscriber_offsets` outside orchd are `events-prune.ts` (which prunes), `migrate-hex-ids.ts` (a migration), and `abstractions/events.ts` (the infrastructure itself). The task/epic topic set — `task.done`, `epic.merged`, `epic.ready`, `story.ready` and the rest — has exactly one real subscriber, and D2 deletes it.

So the same-transaction emit becomes a **dead write we stop making**, not a distributed-transaction problem to solve.

**What survives, and must not be swept up with it:** [ADR-219](219-cockpit-mirror.md)'s `atmux-cockpit-mirror` is a separate singleton daemon reading a **different database** (`~/.atmux/cockpit-events.db`), consuming `budget.warning`, `budget.recovered`, `gitter.escalated`, `team.spawned`, `team.dissolved` — **no kanban topic among them**. It is cockpit/cage infrastructure, it is on the keep side of D2, and the Honker substrate it depends on stays.

### D4 — Migration is additive and reversible by construction

The runtime writes to its own registry-managed board and opens the source **`readonly: true`** during import — atmux's `state.db` is never written. Therefore: migrate = `kanban init` + `kanban import`; **rollback = delete the board file**, with no effect on atmux. Both stores can run in parallel indefinitely.

Two things must be true before anything load-bearing lives there: `~/.local/share/kanban` is currently in **no repo and no backup**, and the runtime's own commit must be **pinned** — it moved twice during the audit and its importer more than tripled in size mid-read.

### D5 — Three known data hazards are handled explicitly, not discovered

1. **`auditx-root` has 50 tasks, 2 epics and 5 stories in `kanban.json` and no `state.db` at all.** The sqlite importer requires a `tasks` table, so a sqlite-only migration **drops that team entirely and reports success.** It needs the JSON import path. This is the single most dangerous item here: a silent, successful-looking loss.
2. **`store.ts:487` nulls `completed_at` on any row whose status is not `done`** — 11 live atmux tasks today — with no warning and no line in the import receipt. Either the importer warns, or the migration records the affected ids before running.
3. **`ifca-docs` has two disagreeing boards** (JSON 20/1/5, DB 24/0/0). Migrating either loses what the other holds; reconcile before, not during.

Also carried, lossy but recoverable: the 7-state epic/story workflow collapses to 6 (`testing` and `merging` both land on `review`), preserved at `metadata.workflowStatus` but **no longer queryable** — "which epics are merging?" stops being a status query. And `acceptance_criteria`, `review_signoff`, `merge_task_id` and `merge_mode` demote from first-class fields to metadata.

## Consequences

**Retired with orchd, named so nobody is surprised:** automatic `git push` behind its seven gates; epic-completeness detection and merge dispatch, including the backstop sweep that caught what the event chain missed; epic-team cage spawning with dedup and host-pressure deferral; auto-dissolve of teams and solo workers; dead-cage reaping; the `__orchd__` service window; event/offset/log pruning; cross-cage LOCAL-vs-REMOTE routing; and pane-statusline scraping — **the only producer of `member.context-high`, so ADR-009/139/167 auto-rotation loses its trigger.**

Most of that is TUI-fleet machinery and is obsolete under the current model. Auto-push and auto-rotation are the two an operator might genuinely miss; both become manual, and both can return as verbs if missed in practice.

**Not retired:** everything cage- and tmux-shaped, `atmux vox` ([ADR-272](272-voice-operator-interface.md)/[ADR-274](274-atmux-vox-rename.md)), the Honker substrate, and `atmux-cockpit-mirror`.

**Gained, on day one:** leased atomic claims; dependency-aware pull scheduling; and notes, checkpoints and handoffs — the ADR-267 continuity contract, arriving four ADRs after it was written.

**Scale:** 164 of 335 source files (49%) and 158 of 385 test files (41%) are kanban-coupled. The chokepoint leaks: 10 files outside the repository layer issue 27 raw SQL statements against `tasks`/`epics`/`stories`, **9 of them writes**. A repository swap alone does not capture the surface.

**Live data:** 6 teams hold anything (8 of 15 `state.db` are empty) — 2,591 tasks, 182 epics, 212 stories, of which only **66 tasks are actually open work**. atmux and unum hold 86%. Zero dependency cycles anywhere, which matters because one cycle aborts an entire import transaction.

## What this ADR does not decide

- **The `groom` verb has no shim target.** Eight sub-operations including git-log reconciliation and `state.db → archive.db` row movement. It either keeps owning storage or is rewritten; it is not a thin shim over anything.
- **The epic/story state machines are not a ledger concern.** `epic advance/ready/unready`, `story advance/signoff`, and the `review → merging` hook that synthesises a gitter merge-Task are workflow, and the runtime has no concept of them. They stay in atmux over `metadata.workflowStatus`, or they go — not decided here.
- **Flags, decisions and the lead-outbox** are markdown appends with no table and no runtime equivalent (~8 MB fleet-wide). Out of scope; they are prose, not work state.
- **[ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) plans to delete the `kanban.json` path.** It must land before or with this, or two backends get migrated instead of one — and per D5 item 1, the JSON path is the one holding a team that sqlite cannot see.

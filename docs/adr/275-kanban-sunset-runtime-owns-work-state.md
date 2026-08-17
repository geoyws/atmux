# ADR-275 — atmux stops owning work state; `@geoyws/kanban` does

Status: proposed
Date: 2026-08-16
**Runtime version this was written against: `@geoyws/kanban` at the Bun implementation, pre-`414bfdd`. SUPERSEDED WITHIN A DAY — see §Amendment 2026-08-17 before implementing anything below.**
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

---

## Amendment 2026-08-17 — the runtime was rewritten in Rust; the D5 hazards were fixed upstream

**Read this before acting on anything above.** `@geoyws/kanban` moved to `414bfdd feat!: replace Bun runtime with Rust ledger` (v0.3.0). `src/store.ts`, `src/import-atmux.ts`, `src/cli.ts` and `src/db.ts` **no longer exist**. Every file-and-line citation in D5 and in the audit this ADR was built on describes an implementation that has been replaced.

**The three D5 hazards appear to have been fixed upstream, by the team working in that repo:**

| Hazard | Upstream commit |
|---|---|
| D5.2 silent `completed_at` drop | `ec1a73d` — *fix: preserve anomalous legacy completion times* |
| D5.1 `auditx-root` JSON-only, no `state.db` | `12e8d49` — *feat: import json-only atmux hierarchies* |
| The 7-state workflow collapse | `0105017`, `f95675b` — atomic story + workflow-metadata transitions |

There is also `4f029a0 docs: record atmux fleet preparation`: that team is actively preparing for this migration.

**Those are commit subjects, not verified behaviour.** They must be confirmed against the running implementation before D5 is treated as closed — a subject line is a claim, and the whole point of D5 was that one of these failure modes *reports success*.

**What does not change:** D1 (runtime owns the ledger, atmux keeps the verbs), D2 (orchd retired), D3 (the task-topic bus is orphaned because orchd is its only consumer, and `atmux-cockpit-mirror` reads a different database and survives), and D4 (additive, reversible). Those rest on facts about **atmux**, which are unaffected by a rewrite on the other side.

**Operational constraint, added here because it is easy to get wrong:** `/root/work/src/kanban` has a **live atmux cage working in it** (session `atmux-kanban`, driver and driver-2). Do not edit that repo as part of this migration — read it, run it, but coordinate rather than commit into another team's tree.

**Standing lesson, third occurrence:** the audit behind this ADR warned *"pin a commit before writing the ADR"* after watching the repo move twice mid-investigation. It then moved a third time, with a breaking rewrite, within a day of the ADR being written. **Anything written about this runtime must name the commit it was true for**, and any plan built on its internals should assume a shelf life measured in days until it stabilises.

---

## Amendment 2026-08-17-b — Phase 1: the D5 hazards were measured, not taken on trust

The amendment above said the upstream fixes were *"commit subjects, not verified behaviour"* and had to be confirmed against the running implementation. They now have been.

**Method:** every import was run against `/root/atmux-worksnap-2026-08-17`, the Phase 0 archive (18 `VACUUM INTO` snapshots + 16 `kanban.json`, 2,591 tasks), into throwaway boards — **never against a live `state.db` or a live board**. Runtime: `kanban` on `PATH` at `/root/.local/bin/kanban`. The scratch boards and their registry rows were removed afterwards.

### The three D5 hazards

| | Claim | Verified behaviour |
|---|---|---|
| **D5.1** `auditx-root` JSON-only | sqlite-only migration drops the team and reports success | **Fixed.** `kanban import atmux-json` produced `{epics:2, stories:5, tasks:50}`, 57 created, and all 57 read back with correct `type` and `parentID`. |
| **D5.2** `completed_at` nulled on 11 rows | silent loss, no line in the receipt | **Fixed, and better than D5.2 asked for** — see below. |
| **D5.3** `ifca-docs` two disagreeing boards | "migrating either loses what the other holds; reconcile before" | **Not a conflict at all** — see below. |

**D5.2 — the fix is better than the ask, and a careless check reports it as broken.** The `completedAt` *column* still reads null on all 11 rows. That is correct, not a defect: the column means "this task is done", and writing a completion time onto a `todo` row would corrupt it. The value is preserved in two places — `metadata.legacyCompletedAt` (purpose-named) and `metadata.atmuxExtra.completed_at` (the entire original row, verbatim) — and all 11 ids are named in the import receipt under `warnings.nonterminalCompletions`, with the exact timestamps, seconds correctly widened to milliseconds. Recording this because reading only the column produces a confident false negative; the first readback in this investigation did exactly that.

**D5.3 — the two boards share zero ids.** They are not two versions of one board; they are two disjoint generations. The DB holds 24 tasks, all `done`, all documentation-sweep work, no epics or stories. The JSON holds a *different* 20 tasks — 6 of them still `todo` — under epic `e-392dc1ac` with 5 stories. Intersection: **0**. So there is nothing to reconcile; the union is simply correct. Verified by importing both into one board: 44 tasks + 1 epic + 5 stories, `updated=0` on the second import (no collisions), 6 open tasks preserved.

**The workflow collapse is near-zero exposure.** Fleet-wide, across all 18 databases and 16 JSON boards, exactly **one** row is in `testing` or `merging` (a single `rentx-root` story). The lossy 7→6 state collapse is real and costs one row.

### Fleet-wide, the JSON hazard is bounded to two teams

18 teams have a `state.db`, 16 have a `kanban.json`, 12 have both. Only **two** teams hold JSON content the sqlite path cannot see:

| Team | Rows only in JSON | Open |
|---|---|---|
| `auditx-root` | 50 tasks (no `state.db` at all) | 3 |
| `ifca-docs` | 20 tasks + 1 epic + 5 stories | 6 |

Every other team's JSON is empty or absent. **Total exposure of a sqlite-only migration: 70 tasks, 9 of them open work.** That converts D5.1 and D5.3 from two narrative hazards into one mechanical rule: import JSON for those two teams, sqlite for the rest, both for `ifca-docs`.

### D5.4 (NEW, and the most dangerous item now) — `--workspace` is silently ignored; cwd decides the board

`kanban` resolves the target board from the **current working directory**, not from `--workspace`. The flag is accepted, reported in `--help`, and does nothing.

Reproduced with a single-row control: from `cwd=<docs board>`, `kanban task add … --workspace <auditx board>` landed the row in the **docs** board (1393 → 1394) and left the auditx board untouched (57 → 57). Earlier in the same session it silently redirected a 1,343-row atmux import into the ifca-docs board, which is how it was noticed.

This is **D5.1's failure class exactly**: an operation that reports success while doing the wrong thing. A migration driven the obvious way —

```sh
for t in "${teams[@]}"; do kanban import atmux-sqlite "$db" --workspace "$dir"; done
```

— from one fixed cwd pours **all 2,591 tasks into whichever single board the loop happened to start in**, printing a clean receipt at every step. **Mitigation until upstream fixes it: `cd` into the target root before every `kanban` invocation and never pass `--workspace`**, then assert the row delta landed in the expected board file before moving to the next team.

### D5.5 — one dangling dependency, warned and non-fatal

`t-ca78326b` depends on `t-be01fc89`, which does not exist. It appears in `warnings.danglingDependencies` and does not abort the transaction. One row, fleet-wide.

### What the runtime gets right, recorded because it removes work

Re-import is **guarded, not silently duplicating**. A plain second import refuses:

> `Error: import overlaps 57 existing task(s), including e-7c591557, … ; rerun with --reconcile only after source writers are stopped`

— naming the overlap count, sample ids, and the precondition. With `--reconcile` it is idempotent: `created=0, updated=57`, row count unchanged. D4's "reversible by construction" holds.

### One live consequence, actionable now

The kanban team has already pre-imported 8 teams (`4f029a0 docs: record atmux fleet preparation`). Their `auditx-root` board is correct at 57 rows via the JSON path. **Their `ifca-docs` board holds 24 rows — the sqlite side only.** The JSON side is absent, so `e-392dc1ac`, its 5 stories, and these 6 open tasks are currently missing from the prepared board:

`t-747e405a` · `t-f109324d` · `t-bb7484f7` · `t-028e6d63` · `t-e281276a` · `t-3d6e21ac`

Fixing it is one command from `/root/work/ifca/src/ifca-docs`. Per the operational constraint above, that is a hand-off to whoever owns that board, not an edit made from here.

### D1's integration surface has changed — there is no library to shim over

D1 says atmux's verbs remain "as shims over the runtime **library**". That was true of the Bun implementation. It is not true now, and the correction is not cosmetic.

At `414bfdd` the repo has **no `package.json` at all**, `src/` is empty, and the entire implementation is `rust/{main,store,db,model,registry,import,context}.rs`. `@geoyws/kanban` is no longer an npm package; it is a binary named `kanban`. **A Bun process cannot import it.**

Two integration surfaces remain, and only one is acceptable:

1. **Shell out to the `kanban` binary.** Every verb takes `--json`, and the receipts observed in this Phase 1 pass are well-formed and information-dense — the import receipt names its warnings, the overlap guard names its ids. atmux already owns the right seam for this: `src/abstractions/spawn.ts`, with `ATMUX_SPAWN_TIMEOUT_MS` and `ATMUX_GIT_TIMEOUT_MS` as precedent for a per-integration timeout knob.
2. **Open the board's SQLite file directly from Bun.** Rejected. It bypasses the runtime's claim/lease/dependency invariants, which would then have to be reimplemented on the atmux side — which is the thing this whole ADR exists to stop doing.

So D1 stands as a decision (the runtime owns the ledger; the verbs stay) and changes only in mechanism: **the shims are subprocess calls with a JSON protocol, not library calls.**

**Consequence for sequencing.** A CLI is a contract with no type checker across it, and this runtime moved three times in a week including a breaking rewrite. So the shim layer lands **behind a flag, defaulting off**, with the CLI's shape captured as **fixture tests** — the same drift-guard pattern already used for the vox protocol. Then a runtime change breaks a named fixture test on a known commit, instead of surfacing as a wrong answer in a verb an operator is relying on. Per D4 this keeps the migration additive and reversible: the flag off means nothing changed.

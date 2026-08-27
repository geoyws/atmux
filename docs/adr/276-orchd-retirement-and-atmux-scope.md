# ADR-276 — orchd is retired; atmux's scope narrows to tmux cages and `atmux vox`

Status: accepted — operator-direct (quoted in §Context, 2026-08-16; reconfirmed verbatim by George 2026-08-27: "i thought it wasn't needed a long time ago in atmux")
Date: 2026-08-16 (renumbered from a colliding `275-*` on 2026-08-17 — see §Provenance)
Builds on: [ADR-275](275-external-private-kanban-authority.md) — **accepted, operator-direct.** That ADR decides the work-state question. This one does not re-decide it.
Supersedes in effect: the orchd phase ADRs — [ADR-202](202-orchd-event-loop.md), [ADR-203](203-event-topic-taxonomy.md), [ADR-226](226-orchd-auto-merge.md), [ADR-227](227-orchd-auto-dissolve.md), [ADR-229](229-orchd-auto-push.md), [ADR-250](250-orchd-stale-epic-team-reaper.md)
Relates: [ADR-219](219-cockpit-mirror.md) (a bus consumer that SURVIVES this), [ADR-272](272-voice-operator-interface.md) / [ADR-274](274-atmux-vox-rename.md) (`atmux vox` — the other half of the narrowed scope), [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md)

## Provenance — this ADR was written in ignorance of an accepted sibling, and is corrected here

This file was first written as `275-kanban-sunset-runtime-owns-work-state.md` and made decisions about work-state ownership that [ADR-275](275-external-private-kanban-authority.md) had **already decided and shipped** the previous day: an accepted, operator-direct ADR plus eight implementation commits (`af657ea`, `00094cc`, `2356a5c`, `5c1485d`, `d42d264`, `488c355`, `9779d24`, `82f2766`, `6c68406`) landing `src/adapters/kanban-cli.ts`, `src/core/kanban-backend.ts`, `src/core/external-kanban-cutover.ts` and `src/verbs/migrate-kanban.ts`.

Two files claimed number 275, and the newer one restated accepted decisions as if they were open. Recorded rather than quietly fixed, because the failure is instructive and this repo has seen it before (`feedback_adr_number_pin_collision_with_parallel_epics`): **the pre-write check must be `ls docs/adr/NNN-*` on the trunk tip, and a topic search of the ADR tree, not just the highest number.** A number is not free merely because nothing on your branch used it.

What that leaves. The work-state decisions — one authority, a process-adapter boundary, no dual writes, staged migration with receipts, handoffs as kanban records, private scope, a deletion gate — are ADR-275's and are cited, never restated. What remains here is what ADR-275 does **not** decide: the fate of orchd, and where atmux's boundary now sits.

## Context

ADR-275 makes the external `kanban` CLI the sole authority for tasks, epics, stories, claims, checkpoints and handoffs, with atmux as a client. It says nothing about `orchd` — the daemon that *reacts* to task and epic events by merging branches, pushing them, spawning epic-team cages and reaping dead ones. Its D4 stage 6 permits removing "verbs that merely duplicate Kanban" after the receipts pass; a daemon that consumes work-state events is neither obviously duplicated nor obviously retained.

The operator has since answered both questions directly:

> *"orchd will be passed onto kanban if needed, right now it will be sunset entirely"*
>
> *"all tasks management and state will be managed by kanban.... atmux entirely handles tmux cages and the management of it and atmux vox"*
>
> *"tmux lifecycles are much more minimal now since we don't spawn tuis anymore and we just use a few drivers in each cage."*

### The operating model changed, and that is what makes retiring orchd tractable

A read-only audit measured ~3,100 LoC in orchd with no equivalent in the runtime, and recommended defending it. **That measurement is correct and its conclusion was right for the model it assumed.** But the bulk of that capability — epic-team cage spawning, dead-cage reaping, auto-dissolve, and pane-statusline scraping to produce `member.context-high` for auto-rotation — exists to manage *a fleet of spawned TUIs*. With a few drivers per cage and no spawning, it is machinery for a world that is gone.

Recording that explicitly, because the audit is on file and a future reader will find it and think this ADR ignored it. It did not; the audit was measured against the previous operating model.

## Decision

### D1 — orchd is retired entirely

All of it, not the kanban-driven subset. The capabilities that die are named in §Consequences rather than discovered later.

Where a capability is still wanted, it returns as an **operator-invoked verb**, not a daemon reacting to an event. `src/verbs/epic-merge.ts` already exists and demonstrates the shape: the mechanics were always separable from the automation on top of them.

### D2 — atmux's scope is tmux cages and `atmux vox`

Per the operator. atmux owns the cage lifecycle — sessions, windows, panes, sockets, spawning, addressing, verification, the cockpit — and it owns the voice operator interface ([ADR-272](272-voice-operator-interface.md) / [ADR-274](274-atmux-vox-rename.md)). Work state belongs to ADR-275's authority. This is a boundary statement, not a deletion schedule; ADR-275 D4/D7 govern what may actually be removed and when.

### D3 — The task-topic event bus is orphaned by D1, and that is what makes D1 contained

This is the finding that decides whether D1 is a bounded change or a rewrite, so it is stated precisely.

Today a task write and its event emit are **one transaction in one file** (`src/core/kanban.ts:462`), and orchd wakes on raw commits to that file (`rust/atmux-orchd/src/main.rs:933`). Moving tasks to an external board while still emitting events into `state.db` would be a two-phase write across two databases with no shared transaction — crash between them and a task is `done` with no `task.done` event: a silently stalled epic, and no error anywhere.

**That problem does not arise, because after D1 nothing consumes those topics.** Verified: the only consumers of the per-team `events` table and `subscriber_offsets` outside orchd are `events-prune.ts` (which prunes), `migrate-hex-ids.ts` (a migration), and `abstractions/events.ts` (the infrastructure itself). The task/epic topic set — `task.done`, `epic.merged`, `epic.ready`, `story.ready` and the rest — has exactly one real subscriber, and D1 deletes it.

So the same-transaction emit becomes a **dead write we stop making**, not a distributed-transaction problem to solve. This is also why ADR-275's D3 ("no dual writes") is satisfiable at all on the event side.

**What survives, and must not be swept up with it:** [ADR-219](219-cockpit-mirror.md)'s `atmux-cockpit-mirror` is a separate singleton daemon reading a **different database** (`~/.atmux/cockpit-events.db`), consuming `budget.warning`, `budget.recovered`, `gitter.escalated`, `team.spawned`, `team.dissolved` — **no kanban topic among them**. It is cage infrastructure, it is on the keep side of D1 and D2, and the Honker substrate it depends on stays.

## Consequences

**Retired with orchd, named so nobody is surprised:** automatic `git push` behind its seven gates; epic-completeness detection and merge dispatch, including the backstop sweep that caught what the event chain missed; epic-team cage spawning with dedup and host-pressure deferral; auto-dissolve of teams and solo workers; dead-cage reaping; the `__orchd__` service window; event/offset/log pruning; cross-cage LOCAL-vs-REMOTE routing; and pane-statusline scraping — **the only producer of `member.context-high`, so ADR-009/139/167 auto-rotation loses its trigger.**

Most of that is TUI-fleet machinery and is obsolete under the current model. Auto-push and auto-rotation are the two an operator might genuinely miss; both become manual, and both can return as verbs if missed in practice.

**Not retired:** everything cage- and tmux-shaped, `atmux vox`, the Honker substrate, and `atmux-cockpit-mirror`.

## What this ADR does not decide

- **Anything ADR-275 decides.** Work-state authority, the adapter boundary, dual writes, migration staging, receipts, handoffs, privacy, and the deletion gate are all ADR-275's, and this ADR is subordinate to it wherever they touch.
- **The `groom` verb's fate.** Eight sub-operations including git-log reconciliation and `state.db → archive.db` row movement. It is not a thin shim over anything, and ADR-275 D4 stage 1 (inventory every reader/writer) is where it should be classified.
- **The epic/story state machines.** `epic advance/ready/unready`, `story advance/signoff`, and the `review → merging` hook that synthesises a gitter merge-Task are workflow, not a ledger concern. They stay in atmux over kanban metadata, or they go — not decided here.
- **Flags, decisions and the lead-outbox** — markdown appends with no table and no runtime equivalent (~8 MB fleet-wide). They are prose, not work state.

---

## Evidence — the ADR-275 D4 hazards, measured 2026-08-17

ADR-275 D4 stage 3 requires parity proved "against isolated fixtures", and D7 requires that "imported record counts and relationships reconcile, with dangling legacy references explicitly reported". This section is that evidence, recorded here because it was produced here.

**Method.** Every import was run against `/root/atmux-worksnap-2026-08-17` — 18 `VACUUM INTO` snapshots and 16 `kanban.json`, 2,591 tasks — into throwaway boards. **No live `state.db` and no live board was ever written.** Runtime: `kanban` at commit **`414bfdd`**, on `PATH` at `/root/.local/bin/kanban`. Scratch boards and their registry rows were removed afterwards.

### H1 — JSON-only teams import correctly

`auditx-root` holds 50 tasks, 2 epics and 5 stories in `kanban.json` and **has no `state.db` at all**, so a sqlite-only migration would drop the team and report success. The JSON path handles it: `{epics: 2, stories: 5, tasks: 50}`, 57 created, all 57 read back with correct `type` and `parentID`.

### H2 — anomalous completion times are preserved, and a careless check reports otherwise

11 atmux tasks carry `completed_at` with a status that is not `done`. The `completedAt` **column** reads null on all 11 after import. **That is correct, not a defect** — the column means "this task is done", and writing a completion time onto a `todo` row would corrupt it. The value is preserved twice: `metadata.legacyCompletedAt`, and `metadata.atmuxExtra.completed_at` (the entire original row, verbatim). All 11 ids appear in the import receipt under `warnings.nonterminalCompletions` with correct timestamps, seconds widened to milliseconds.

Recorded because reading only the column produces a confident false negative. The first readback in this investigation did exactly that.

### H3 — `ifca-docs`'s two boards are disjoint generations, not a conflict

The DB holds 24 tasks, all `done`, all documentation-sweep work, no epics or stories. The JSON holds a **different** 20 tasks — 6 still `todo` — under epic `e-392dc1ac` with 5 stories. **Intersection: zero.** There is nothing to reconcile; the union is simply correct. Verified by importing both into one board: 44 tasks + 1 epic + 5 stories, `updated=0` on the second import, 6 open tasks preserved.

### The JSON hazard is bounded to exactly two teams

18 teams have a `state.db`, 16 have a `kanban.json`, 12 have both. Only two hold JSON content the sqlite path cannot see:

| Team | Rows only in JSON | Open |
|---|---|---|
| `auditx-root` | 50 tasks (no `state.db` at all) | 3 |
| `ifca-docs` | 20 tasks + 1 epic + 5 stories | 6 |

Every other team's JSON is empty or absent. **Total exposure of a sqlite-only migration: 70 tasks, 9 of them open work.** One mechanical rule replaces two narrative hazards: JSON for those two teams, sqlite for the rest, both for `ifca-docs`.

### H4 — `--workspace` works on two verbs and is silently ignored by the rest; cwd decides the board

The most dangerous item found, and it is not in either ADR.

**Corrected 2026-08-17 — the first version of this section said `--workspace` "is accepted, documented in `--help`, and does nothing". That is an overstatement, and the truth is worse.** At `414bfdd` the flag is real for exactly two verbs and inert for every other:

| Verb | `--workspace` | Source |
|---|---|---|
| `init` | **honoured** | `rust/main.rs:217` — `args.one("workspace")…unwrap_or(cwd()?)` |
| `workspace attach` | **honoured** | `rust/main.rs:232` — same shape |
| `task *`, `import *`, `story *`, `dashboard`, `context`, … | **accepted and ignored** — board resolved from cwd | `rust/main.rs:157` |

Both halves verified by control, not by reading:

- `kanban init --name h4b-probe --workspace <target>` run from `<here>` registered **`<target>`**. The flag works.
- `kanban task add … --workspace <board B>` run from `cwd=<board A>` added the row to **A** (1393→1394) and left **B** untouched (57→57). The flag does nothing.

**A flag that works at two call sites and is silently inert at the rest is more dangerous than one that never works**, because the operator learns it works and then reaches for it where it does not. That is not hypothetical: this investigation used `init --workspace`, watched it succeed, then passed `--workspace` to `import` — and 1,343 rows landed in a different board than the one named, with a clean success receipt. The error was found only by counting rows in the board files directly.

Two env vars outrank cwd — `KANBAN_DB` (`rust/main.rs:149`) and `KANBAN_DATA_DIR` (`rust/registry.rs:19`) — so an ambient export silently redirects every call.

**This lands directly on ADR-275's shipped adapter.** `src/adapters/kanban-cli.ts` pins `cwd` correctly on its calls, but:

1. **`initialize()` passes `--workspace root`.** That one call is *correct* — `init` is one of the two verbs that honours the flag. It is removed anyway, because the call also pins `cwd: root` and so does not need it, and leaving it there models a selector that is real at exactly one call site. The next reader who reaches for `--workspace` somewhere `cwd` is not also pinned writes to another operator's board with a clean receipt — which is precisely how this investigation lost 1,343 rows.
2. **`defaultRunner` forwards the whole ambient `process.env`.** `KANBAN_DB` (`rust/main.rs:149`) and `KANBAN_DATA_DIR` (`rust/registry.rs:19`) both outrank cwd, so an operator with either exported redirects every atmux work-state read and write to a foreign board while the adapter believes it pinned the project root. Under ADR-275 D1 ("one authority") and D3 ("no dual writes") that is exactly the forbidden failure.

Both are fixed in the adapter: the flag is dropped with a comment naming why, and the two board-selecting variables are stripped from the inherited environment with a warning when either was present.

### H5 — one dangling dependency

`t-ca78326b` depends on `t-be01fc89`, which does not exist. Reported in `warnings.danglingDependencies`; it does not abort the transaction. One row, fleet-wide. This is the "dangling legacy references explicitly reported" that ADR-275 D7 asks for.

### What the runtime gets right

Re-import is **guarded, not silently duplicating**. A plain second import refuses — *"import overlaps 57 existing task(s), including e-7c591557, …; rerun with `--reconcile` only after source writers are stopped"* — naming the count, sample ids and the precondition. With `--reconcile` it is idempotent: `created=0, updated=57`, row count unchanged. ADR-275 D4's staged-and-reversible property holds.

### One live gap, actionable now

Eight teams are already pre-imported. `auditx-root` is correct at 57 rows via the JSON path. **`ifca-docs` holds 24 rows — the sqlite side only**, so `e-392dc1ac`, its 5 stories, and these 6 open tasks are absent from the prepared board:

`t-747e405a` · `t-f109324d` · `t-bb7484f7` · `t-028e6d63` · `t-e281276a` · `t-3d6e21ac`

One command from `/root/work/ifca/src/ifca-docs` fixes it. Per H4, it must be run **from that directory**, without `--workspace`, with `KANBAN_DB` and `KANBAN_DATA_DIR` unset.

### Standing lesson on this runtime

The audit behind this work warned *"pin a commit before writing the ADR"* after watching the repo move twice mid-investigation. It then moved a third time, with a breaking Bun→Rust rewrite, within a day. **Anything written about this runtime must name the commit it was true for** — everything above is true at `414bfdd` — and any plan built on its internals should assume a shelf life measured in days until it stabilises.

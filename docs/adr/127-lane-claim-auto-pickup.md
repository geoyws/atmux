# ADR-127: Lane-claim auto-pickup cron + universal supervision

**Status**: accepted (George 14:13 MYT 2026-05-08 — paperwork catch-up; T1/T2/T3 already shipped @c0dbcb4 + @af5e8ae + @e624592)
**Date**: 2026-05-08

## Context

The atmux team coordinates work via a kanban (`state.db`, ADR-126). Today
the lead `dispatch`-es Tasks one-by-one to named members; members read
their inbox and claim. This is *push-driven*: the lead picks the
member, the member acks, the lead tracks the ack. As the team scales
beyond 6–8 members the lead's coordination cost grows linearly: per-
member health probes, per-member dispatch ordering, per-member
unblock surfacing, per-member rotation. The lead becomes the
bottleneck.

The driver explicitly asked (`driver-inbox.md` 2026-05-07 21:28) to
flip this to a **pull model**: workers self-select Tasks from a shared
queue. The lead stops dispatching individual cards; it routes Epics
into the queue (via the planner) and reports up. Workers wake on a
cron tick, classify their own pane, and claim the next eligible Task
from the queue.

The kanban already grew the substrate in commit
`7721045 feat(task): --lane flag` (2026-05-07): every Task can be
tagged with a lane (`fe`/`be`/`db`/`ops`/`test`/`review`/`misc`),
filtered by lane, and re-tagged via `task lane <id> <lane>`. Members
in `team.json` already carry their own `lane` field (free-form
`z.string()`). The schema work is done. What's missing is the
*orchestration* layer that turns "lane-tagged Tasks + lane-tagged
workers" into "workers automatically claim what they should".

This is the kanban-as-queue model. The lead curates the queue
(reviewer + planner); the queue routes itself.

## Decision

Ship a **lane-claim auto-pickup** orchestrator that runs on cron and
matches Tasks to workers by lane. Six concrete pieces:

1. **`atmux claim --next` mode** (new). Lane-aware pull. Selects the
   highest-priority `todo` Task whose `deps[]` are all `done` AND whose
   `lane` matches the caller's lane in `team.json` (with cross-lane
   fallback per OQ4 below). Atomic: claim + inbox-mirror + audit, same
   transaction as today's `atmux claim <id>`. Returns the claimed Task
   id on stdout, or empty + non-zero exit when no eligible Task exists.

2. **`atmux pane-state --member <m>` verb** (new). Thin verb wrapper
   over the existing `classifyPane` classifier in
   `src/core/pane-state.ts`. Captures the member's pane via the team-
   tmux abstraction, classifies, prints `READY` / `TYPING` / `MODAL` /
   `RATE-LIMIT` / `COMPACTING` / `SHELL` / `UNKNOWN` (with `--json`
   variant for the orchestrator). The classifier already exists; this
   exposes it as a CLI surface so the orchestrator can ask
   "is `<m>`'s pane READY?" without re-implementing capture.

3. **`atmux lane-tick` orchestrator verb** (new). Single-pass loop:
   for each member with a `lane`, capture+classify the pane; if state
   is `READY`, inject `atmux claim --next --as <member>` via the
   send-keys path (gated by `safeSendKeys`). Idempotent — if the pane
   is non-READY OR no eligible Task exists, the tick is a no-op.
   Bounded: stops after one Task per member per tick (no loops).

4. **`atmux start` cron template extension**. Add a new line to
   `src/core/cron.ts::renderCronLines` for `lane-tick`, gated on
   `team.members[].lane` being set on at least one member (teams that
   don't use the lane model skip the line). Cadence: `*/2 * * * *`
   (per OQ2). Same fence-replace idempotence as the existing five
   managed cron lines.

5. **`lane-drift-check` helper + verb**. Scan `in-progress` Tasks; for
   each, check `claimedAt` age + the claiming worker's pane state +
   recent commit references. Tasks claimed >30 min with the worker's
   pane stuck non-READY (>5 min) AND no commit/flag activity referring
   to the Task → revert to `todo`, raise a flag. Stand-alone verb
   today; absorbed into `atmux groom` when the groom port lands. Per
   OQ5.

6. **ADR-127 itself** (this doc).

## Consequences

**FE/docs lane**: `verbs/README.md` + the planner brief (`templates/
briefs/planner.md`) document `claim --next` / `pane-state` / `lane-
tick` / `lane-drift-check`. The lead brief grows a "stop dispatching
lane-tagged Tasks" section: dispatch becomes the exception (cross-lane
escalations, member-specific routing) rather than the norm.

**BE lane**: three new verbs (`claim --next`, `pane-state`,
`lane-tick`) + one helper (`lane-drift-check`). All read-only against
team.json + state.db; only `claim --next` mutates state, and it
delegates to the existing `claimTask` core function (which already
holds the SQLite transaction + inbox-mirror invariants).

**DB lane**: no schema change. `lane` field already on `kanban.tasks`
(commit 7721045). `team.members[].lane` already free-form
`z.string()`.

**OPS lane**: cron block grows by one line on lane-using teams
(`*/2 lane-tick`). Crontab fence-replace stays atomic. Teams without
lane-tagged members are unaffected. The lane-drift-check eventually
folds into the `*/0 4` daily groom line; while groom isn't ported,
operators run it manually or via a one-off cron line.

**TEST lane**: each new verb ships unit tests in the same Task. No
e2e — the orchestrator is observable via the kanban transitions
(claimed-at, owner, status), so unit-level coverage is sufficient
for the v1 cut.

**REVIEW lane**: reviewer gates each Task at commit time. Per the
review brief, this ADR is in scope for review-pre-land sweep.

**What we give up.** Push-mode dispatch loses its monopoly on Task
routing. The lead can still `dispatch <member> <task-id>` for
exceptional cases; but for the common case, the lead curates the
queue (sets lane + priority + deps) and walks away. Less granular
control over *which* member gets *which* Task — but priority + deps
already encode the ordering, and lanes encode the routing, so the
control was illusory.

**Rollback path.** Set the cron line off via `team.json::
crons.laneTickEnabled=false` (a new flag this ADR adds). Workers
fall back to inbox-driven push; the schema fields stay; nothing
unwinds. Reversible.

## Open questions

Resolved at decompose-time via `atmux decisions add`. All
overrideable until the relevant Task lands.

1. **OQ1 — orchestrator placement**: new `lane-tick` verb vs. fold
   into existing `whip`. **Default**: new verb.
   *Why*: whip is already ~1.5K LOC + per-tick budget probe + member
   health probes; adding pickup loops bloats it further and couples
   two unrelated concerns. Separation lets cron run lane-tick at a
   different cadence than whip without forcing whip's `*/5` into
   `*/2`.
2. **OQ2 — cron cadence**: `*/2 * * * *` for lane-tick. **Default**:
   `*/2`.
   *Why*: balances responsiveness (worker waits ≤2 min for next Task
   after finishing) against cron-storm risk (a misbehaving lane-tick
   would amplify 2.5× vs whip's `*/5`). Tighten to `*/1` if the wait
   becomes a coordination cost.
3. **OQ3 — pane-state gate**: pickup gated on `READY` only. **Default**:
   yes. *Why*: injecting into MODAL would dismiss the modal silently;
   into COMPACTING would lose the keystroke; into RATE-LIMIT would
   queue against a paused agent. Only `READY` accepts input cleanly.
4. **OQ4 — cross-lane fallback**: when no eligible Task in worker's
   own lane. **Default**: yes — fall back to lane-less Tasks; do NOT
   cross into another worker's lane.
   *Why*: lane-less Tasks (`lane=null`) are the legacy population +
   small misc work; pulling them keeps idle workers useful. Crossing
   into another worker's lane (e.g. `be` worker pulling a `db` Task)
   risks routing work to the wrong skill set + producing low-quality
   output the reviewer catches at commit time. Strict-lane mode
   available via `team.json::kanban.crossLaneClaim=false`.
   **Implementation note (2026-05-08)**: shipped under
   `team.json::kanban.crossLaneClaim` (boolean, default `true`)
   rather than the ADR's originally-drafted `lanePickup.strict` —
   inverse semantics, same control surface. Member chose
   `crossLaneClaim` to match `templates/briefs/member.md` + bash
   `lib/claim.sh:200` precedent (workers read the brief; one
   canonical name beats two equivalent ones). Mapping:
   `crossLaneClaim=true` ≡ `lanePickup.strict=false` (cross-lane
   fallback ON, the default); `crossLaneClaim=false` ≡
   `lanePickup.strict=true` (strict-lane mode). See
   `src/schema/team.ts::TeamKanban`.
5. **OQ5 — drift threshold**: stuck-claim revert criteria. **Default**:
   `claimedAt > 30min` AND pane non-READY > 5min AND no commit
   referencing `<task-id>` in last 30min → revert to `todo` + raise
   flag with claim history note.
   *Why*: 30 min is longer than any normal work cycle for an atomic
   Task (most are <15 min); pane-state corroboration prevents false
   positives during deep-thinking READY pauses; commit-reference
   check prevents reverting Tasks that ARE making progress but
   haven't called `done` yet.

## §Amendment 2026-05-20 — partial supersession by ADR-176 (§OQ5 gains 4th criterion)

§OQ5's 3-criterion stuck-claim revert algorithm (`claimedAt > 30min` AND pane non-READY > 5min AND no commit referencing `<task-id>` in last 30min) is extended by [ADR-176](./176-epic-aware-lane-drift-revert.md) (`Supersedes (in part): ADR-127 §OQ5 — the 3-criterion auto-revert algorithm gains a 4th criterion (epic-children-progressing). Original 3 criteria remain; this ADR tightens the algorithm, never relaxes it`).

The supersession is **scoped to OQ5 only**. The original three criteria stand verbatim; ADR-176 adds a 4th — `epic-children-progressing` — that prevents reverting a parent EPIC-class Task while its child Tasks in the same Epic are still making commits. The 4-criterion algorithm is strictly **tighter** than the 3-criterion baseline: a Task that would have reverted under the 3-criterion check may now be held under the 4-criterion check if an epic-team child is still shipping. ADR-176 never relaxes a revert — only delays one when there's evidence the epic is still alive.

All other §OQ resolutions (OQ1 ladder-mode rollback, OQ2 backoff-noise budget, OQ3 first-claim-wins race, OQ4 cross-lane fallback default) stand verbatim — ADR-176 doesn't touch them. The §Decision's lane-pickup core (worker-driven auto-claim + cross-lane fallback default + first-claim-wins) is unchanged.

**Filed via** t-2d750500 (T2 sweep of [docs/audits/adr-supersession-audit-2026-05-20.md](../audits/adr-supersession-audit-2026-05-20.md) D1 drift #10, 2026-05-20).

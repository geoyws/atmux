# ADR-007: Pull-based kanban (Epic / Story / Task)

**Status**: accepted
**Date**: 2026-04-25

## Context

The atmux team-lead currently runs a **push-coordinated** model: it decomposes asks, dispatches each task to a member, tracks per-task state, and reports back to the driver. In practice the lead's context burns out 30–40 min in — it is juggling driver-inbox triage, kanban maintenance, dispatch, Discord, AND per-task tracking simultaneously. The lead's cognitive budget is the bottleneck on team throughput.

We want a **pull-based, board-is-truth** model: workers self-organise by pulling from their lane; cross-role coordination (FE → BE → DB → TEST → REVIEW → MERGE) flows through Epic / Story / Task state transitions on the kanban, not through lead micromanagement. The lead's job shrinks to (a) routing Epics to the planner and (b) writing the Epic summary at the end.

This is the established XP / Mike Cohn hierarchy (predates Jira): **Epic → User Story → Task** — user-centric vocabulary, not project-management vocabulary.

Full plan: `/root/.claude/plans/pure-pondering-crane.md`.

## Decision

### Hierarchy

- **Epic** — large initiative a driver hands over (`"Email + password auth"`).
- **Story** — a user-facing scenario that ships as a unit (`"As a user, I can register with email + password"`). **Optional** — small Epics skip the Story layer.
- **Task** — atomic unit (hours, not days), one worker, one lane, one deliverable.

### Schema additions to `kanban.json`

Add `epics[]` + `stories[]` top-level arrays. Add `epic`, `story`, `lane`, `deliverable` fields to each `task`. Backwards-compat: tasks without these fields keep working as legacy / ad-hoc.

### Lane enum

`fe | be | db | ops | test | review | misc` — lowercase in identifiers (member name prefixes, kanban field values, jq filters), **UPPER-CASE in prose** (briefs, README, status display, Discord). Member `team.json` gets `.lane`; wizard infers from name prefix (`fe-auth` → `fe`).

### State machines (manual transitions for MVP)

- **Story**: `planning → ready → in-progress → testing → review → merging → done`
- **Epic**: `planning → ready → in-progress → review → done`

Transitions are explicit verb calls (`atmux story advance <id>`, `atmux epic advance <id>`); validation enforced at transition time. **Auto-promotion is deferred** (deferred item #1).

### Commit flow

**One commit per Task.** Member calls `atmux done <task-id>` → kanban auto-dispatches a `commit t-xxx` Task to gitter's inbox → gitter writes a conventional-commit message from the Task's subject + body + note, commits, lands. Reviewer signs off the **cumulative Story diff**, not each commit.

### New verbs

- `atmux epic add | list | show | advance`
- `atmux story add | list | show | advance`
- `atmux task add … --epic --story --lane --deliverable`
- `atmux claim --next [--lane <lane>]`

### Atomic updates

Multi-entity transitions (e.g. `story advance` flipping parent Epic from `ready → in-progress`) go through a single `atmux::jq_update` call so concurrent ops never see torn state. Reuse the existing `lib/common.sh:189` helper.

### Data store: stay on JSON for the MVP

Considered SQLite vs. JSON+jq+flock. JSON wins for the MVP because human-readability + git-diffability + zero-effort `jq` introspection is genuinely valuable for atmux's operator persona. SQLite revisit threshold (deferred item #9): kanban mutations >100ms p95 OR flock contention >5% OR >500 active tasks per team.

## Resolutions to plan §"Open questions"

The plan left four questions for the team. Planner resolves them with recommended defaults; reviewer overrides at sign-off if needed.

1. **`claim --next` cross-lane fallback** — Configurable: `team.kanban.crossLaneClaim` (default `true`). Small teams want the fallback (avoids idle workers); large teams turn it off to enforce lane discipline. Documented in member brief.

2. **Story without acceptance criteria** — Planner can create a Story with empty `acceptanceCriteria`, but reviewer **MUST reject merging if AC is empty at sign-off**. Opt-in discipline. Reviewer brief enforces.

3. **`epic advance` / `story advance` validation** — Validate at transition; error with a clear message if children are still open (e.g. `"cannot advance s-111 to review: 2 tasks still in-progress (t-aaa, t-bbb)"`). Idempotent for re-advance to the same state.

4. **Auto-dispatched `commit t-xxx` Tasks to gitter** — Lane = `misc` (gitter is role-scoped, not lane-scoped). Body references the source Task id so gitter can `task show <src-id>` to compose the commit message. These tasks are **not Epic-scoped** themselves (their `.epic` is null) so they don't trigger recursive auto-dispatch.

## Bootstrapping note

The `epic` and `story` verbs do not exist at the start of this Epic — they are what this Epic builds. To avoid chicken-and-egg, **all Tasks for this Epic are added via the existing `atmux task add`** with subject prefixes `[E1/S1] …` encoding hierarchy. Future Epics use the new verbs once they ship. Single shape of tasks across the whole Epic = cleaner audit trail.

## Consequences

### What we gain

- **Lead's per-Epic cognitive load drops ~80%** — only touches the board at start (route to planner) and end (Epic summary).
- **Workers self-organise.** `claim --next` lets a worker pick up the next claimable thing in their lane without lead intervention.
- **Story is the natural review gate.** Reviewer audits one cumulative diff per Story instead of per-commit nitpicking.
- **Deps encode handoffs.** FE → BE → TEST handoff inside an Epic is just a dep chain; no human routing.
- **Backwards compatible.** Existing dispatch + ad-hoc `task add` flows still work for one-off bug fixes.

### What we give up

- **Verb surface grows.** New users see `epic`, `story`, `task`, `claim --next` — more to learn than the old single-tier model.
- **Schema expands.** `kanban.json` is busier; debugging requires `jq` filters scoped by Epic/Story.
- **State-machine validation must be airtight.** A wrong-state transition that slips through corrupts the board for the rest of the Epic. Shellcheck + bats coverage on every transition is non-negotiable.
- **Manual transitions for MVP** — workers must remember to `story advance` / `epic advance`. Forgotten transitions stall the Epic until someone notices. Auto-promotion (deferred item #1) closes this.

### What we explicitly defer

Items 1–9 from plan §"Deferred scope" — auto-promotion, `epic report`, whip retrofit, idle-aware rotation, token-aware preclear, agent fallback chain, cross-Epic deps, AC-driven test scaffolding, SQLite migration. Each becomes its own future Epic. **Final Task of this Epic** persists them as numbered JSON files at `/root/.claude/tasks/atmux/001..009.json` so they survive `/clear`.

## Alternatives considered

- **Push model with better tools** — Add a "decomposition templates" lib so the lead burns less context per dispatch. Rejected: solves a symptom, not the root (lead is on the critical path of every task).
- **Two-tier (Epic + Task only, no Story)** — Simpler schema, but loses the natural review unit. Stories are also optional in this design, so cost is zero if you don't use them.
- **Three-tier with Sprints** — Adds a time-box layer. Rejected: atmux is event-driven, not time-boxed; sprints are cargo-culted from Scrum and don't fit the operator persona.
- **SQLite backing store** — See "Data store" above + plan §"Data format". Deferred until profiling justifies.

## Amendment 2026-05-18 — ADR-175 surfaces the §OQ2 reviewer-signoff CLI

[ADR-175](175-story-signoff-verb-and-trunk-direct-merge-mode.md) (`atmux story signoff` verb + `trunk-direct` `mergeMode` field) makes the §OQ2 reviewer-signoff gate settable via CLI and introduces a `mergeMode` branching that skips the `merging` state for trunk-direct stories. The §OQ2 manual-discretion model (reviewer rejects when AC is empty) is unchanged — ADR-175 closes the missing CLI surface that previously forced reviewers to either rely on a planner-side hand-edit of `stories.review_signoff` or fall back to raw SQL bypass (observed on rentx E1, operator-authorized 2026-05-17 13:55 MYT for `s-425249d0` / `s-dc19b96e` / `s-f5797a08` / `s-cb99f131`). Cross-reference: [docs/adr/175-story-signoff-verb-and-trunk-direct-merge-mode.md](175-story-signoff-verb-and-trunk-direct-merge-mode.md).

This is an **append-only amendment header** per the CLAUDE.md append-only ADR rule; the existing ADR-007 body above is canonical and unchanged.

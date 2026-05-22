# ADR-221: Solo-worker scope — small standalone tasks via 1-2 member epic-team

**Status:** Proposed
**Date:** 2026-05-22
**Deciders:** geoyws (driver)
**Related:** [ADR-090](090-epic-team-spawn.md), [ADR-091](091-epic-team-auto-merge.md), [ADR-033](033-driver-scope-only-gates.md), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md), [t-8c8ce51c](../tasks/t-8c8ce51c.md), [t-9aa2f8cb](../tasks/t-9aa2f8cb.md), [t-0542595c](../tasks/t-0542595c.md)

## Context

Today's session (2026-05-22) shipped multiple small, single-commit fixes (merger-gate `c-6ca1ff2`, boot-claude strip, terminal-state recovery `c-baa0b8a`, backend-heavy roster). Each one fit the shape: 1-2 commits + 1 ADR amendment + a few tests. The team structure they CAN ride is:

- **Drop on long-lived member queue** — works but pollutes that member's branch with unrelated work; gate-bug risk (until [t-9aa2f8cb](../tasks/t-9aa2f8cb.md) shipped, long-lived members' fan-in was structurally wedged); review semantics blurred when one member ships ten unrelated commits.
- **Spawn a full epic-team** ([ADR-090](090-epic-team-spawn.md), 5-7 members) — wasteful: lead + planner + reviewer + fe-1/2 + be-1/2 + committer for a single commit. Account-pool budget pressure under concurrent epics.
- **Driver direct commit** — blocked by classifier (correct guardrail; trunk pushes bypass review).

None of these fit "one-off small task." The gap is observable: today's driver-direct trunk commits (6ca1ff2 + baa0b8a + 3d923c7) each required operator-authorized `!`-prefix push.

## Decision

Introduce a **solo-worker** scope — an ephemeral 1-2 member team built on existing ADR-090 epic-team infrastructure (shared worktree, cockpit registration, `epicTeam` block in `team.json`, auto-merge via ADR-091 epic-merge). The "worker" semantic is a CONVENTION layered on top, not a new schema or verb class.

### v1 surface (this ADR, ship today)

Two new roster presets under `templates/epic-rosters/`:

1. **`solo.json`** — 1 member (`solo`, role=`member`, lane=`misc`). For pure-docs / trivial fixes. Worker does the work, commits, pushes, marks task done, operator manually dissolves.

2. **`solo+committer.json`** — 2 members (`solo` + `committer`). For load-bearing changes (dispatcher / schema / security gates) where a separate committer review pass adds value. Solo does the work; committer reviews + drives the fan-in merge.

Spawn via existing `atmux team spawn-epic`:

```
ATMUX_CALLER_SCOPE=driver atmux team spawn-epic w-<task-id> --from <parent> --roster solo
```

Convention: epic-id prefix `w-` distinguishes worker-teams from regular epics in cockpit + `atmux epic list` enumeration. The `parentEpicKanbanId` falls back to `e-w-<task-id>` per spawn-epic default; operator can override with `--parent-epic-kanban-id` if they want to attach the worker to an existing kanban EPIC instead of synthesizing a new one.

### v2 surface (follow-up Task, NOT in this ADR)

A future ADR will add convenience verbs:

- `atmux team spawn-worker <task-id>` — auto-creates a wrapper epic, then spawn-epic; epic-id derived from task-id.
- `atmux team dissolve-worker <task-id>` — alias for dissolve-epic.
- `atmux team list-workers` — filters cockpit sessions[] for type=epic-team with name starting with `w-`.
- **Auto-dissolve on task.done** — Honker subscription that calls dissolve-worker when the worker's only task transitions to done. The current event-driven substrate (ADR-202) supports this; v2 wires the consumer.

v2 is gated on: (a) v1 dogfood validating the smaller-roster ergonomics; (b) Honker substrate maturity (relayd already shipped per ADR-202 §Amendment 2026-05-22, but the `task.done → dissolve-worker` consumer is new).

## Carve-outs

- **NOT a new team scope.** Workers are epic-teams with smaller rosters. The schema, lifecycle, fan-in semantics, and cockpit topology are unchanged from ADR-090.
- **NOT auto-dissolving in v1.** Operator manually runs `atmux team dissolve-epic w-<task-id>` after the task ships. Auto-dissolve is the v2 killer feature.
- **NOT a replacement for epic-teams.** Multi-story EPICs with cross-cuts continue to use the default 7-member roster (or backend-heavy 5-member). Workers are explicitly for SINGLE-task, self-contained scopes — anything that decomposes into 2+ stories belongs in an epic-team.
- **NOT a substitute for long-lived members.** Routine work that belongs to a long-lived member (docs continuously ADR-amending, gitter continuously fan-in-ing) stays on those members' branches. Workers are for ONE-OFF tasks the operator doesn't want polluting a long-lived branch.

## Consequences

**Easier:**

- Small tasks can spawn a tight, scoped cage without burning a full epic-team budget.
- Operator-direct-commit blast radius drops (the worker IS the review pass).
- Dogfoodable today via spawn-epic + new roster preset; zero new verb code required.

**Harder:**

- Operator must remember to manually dissolve workers in v1 — orphan worker cages will accumulate until v2 auto-dissolve lands. The [[project_epic_team_dissolve_cron_leak]] reaper class still applies.
- `atmux epic list` and cockpit observability show worker-teams interleaved with real epics; v2 surfaces a dedicated filter.
- Pre-existing host-pressure gate (ADR-184) applies — workers count against the same RAM/CPU budget as epic-teams. Worker is lighter (1-2 members vs 7) but not free.

## References

- [t-8c8ce51c](../tasks/t-8c8ce51c.md) — filing Task that motivated this ADR
- [ADR-090 §`spawn-epic` verb](090-epic-team-spawn.md) — substrate this builds on
- [ADR-091 §`epic-merge`](091-epic-team-auto-merge.md) — fan-in semantics shared with workers
- [ADR-202 §Amendment 2026-05-22](202-honker-pubsub-substrate.md) — event substrate for v2 auto-dissolve
- 2026-05-22 session log — multiple small-fix commits motivating the gap analysis

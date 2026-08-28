# ADR-221: Solo-worker scope — small standalone tasks via 1-2 member epic-team

**Status:** Accepted — v1 substrate (`templates/epic-rosters/solo.json` + `solo+committer.json`) via merge `fe6bcda` 2026-05-22; v2 convenience verbs (spawn-worker / dissolve-worker / list-workers) via this commit 2026-05-23. Auto-dissolve folded into orchd lifecycle [e-a946af69](../tasks/t-0db3f393.md) Phase 4 / ADR-227.
**Date:** 2026-05-22 (v1) · 2026-05-23 (§v2 amendment)
**Deciders:** geoyws (driver)
**Related:** [ADR-090](090-epic-team-lifecycle.md), [ADR-091](091-kanban-driven-auto-merge.md), [ADR-033](033-kanban-driver-only-flag.md), [ADR-170](170-sweep-epics-verb.md), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md), [t-8c8ce51c](../tasks/t-8c8ce51c.md), [t-9aa2f8cb](../tasks/t-9aa2f8cb.md), [t-0542595c](../tasks/t-0542595c.md)

## Context

Today's session (2026-05-22) shipped multiple small, single-commit fixes (merger-gate `c-6ca1ff2`, boot-claude strip, terminal-state recovery `c-baa0b8a`, backend-heavy roster). Each one fit the shape: 1-2 commits + 1 ADR amendment + a few tests. The team structure they CAN ride is:

- **Drop on long-lived member queue** — works but pollutes that member's branch with unrelated work; gate-bug risk (until [t-9aa2f8cb](../tasks/t-9aa2f8cb.md) shipped, long-lived members' fan-in was structurally wedged); review semantics blurred when one member ships ten unrelated commits.
- **Spawn a full epic-team** ([ADR-090](090-epic-team-lifecycle.md), 5-7 members) — wasteful: lead + planner + reviewer + fe-1/2 + be-1/2 + committer for a single commit. Account-pool budget pressure under concurrent epics.
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

### v2 surface (§Amendment 2026-05-23, this ADR)

Promoted from the original "follow-up Task" outline. Three convenience verbs land in `src/verbs/team/` and route through the existing `team` subverb dispatcher; the worker-team convention from §v1 is the substrate, these verbs are ergonomic wrappers.

1. **`atmux team spawn-worker <task-id> --from <parent> [--roster <preset>] [--parent-base <branch>] [--no-init-submodules] [--force-spawn]`**

   Pipeline:

   1. Resolve caller-scope (driver-only — fails closed BEFORE any disk mutation so members can't pollute the parent kanban with half-formed worker rows).
   2. Normalise the task-id positional into a canonical worker-id (`w-<tail>`):
       - `t-abc123` → `w-abc123`  (strip task prefix, swap)
       - `w-abc123` → `w-abc123`  (already canonical — pass through)
       - `abc123`   → `w-abc123`  (bare id — prefix `w-`)
   3. Resolve the parent team's root via the cockpit (required — `--from` is mandatory; no walk-up inference). Refuse if the parent isn't in `cockpit.json::sessions[]`.
   4. Auto-create a wrapper kanban EPIC in the parent's `state.db` via `addEpic`. Title is `worker: <task-id>` for forensic traceability; `driverRef` pins the origin task-id for downstream tooling. The returned `e-XXXXXXXX` id becomes the worker's `parentEpicKanbanId` — so `dissolve-worker` / `dissolve-epic` later mark THIS row done at teardown, instead of synthesizing `e-w-<tail>` which doesn't exist.
   5. Synthesize spawn-epic argv (worker-id, `--from`, `--roster <preset>` defaulting to `solo`, `--parent-epic-kanban-id <new-epic-id>`, plus any pass-through flags) and delegate to `spawnEpic`.

   Carve-out: this verb does NOT roll back the wrapper kanban EPIC if `spawnEpic` fails mid-pipeline. The row is small + harmless; the operator can `atmux epic advance <id> --to wontfix` if needed. Aligns with spawn-epic's own "partial state on failure" philosophy (it leaves cockpit-mutate step un-rolled-back too).

2. **`atmux team dissolve-worker <worker-id-or-task-id> [--skip-checks] [--force-prune]`**

   Pipeline:

   1. Resolve caller-scope (driver-only).
   2. Worker-id gate — refuses generic `e-` epic ids with a hint pointing to `dissolve-epic`. Accepted forms (`t-`/bare/`w-`) normalise to `w-<tail>` via the same routine as `spawn-worker`.
   3. Delegate to `dissolveEpic` with the normalised id + pass-through flags.

   Why a separate verb (vs. running `dissolve-epic w-<tail>` directly):
       - Symmetry with `spawn-worker` — operators reach for the matching pair.
       - Visible audit-trail — log + history grep separates worker teardown from generic epic-team teardown.
       - Future-proofing — when the §v3 auto-dissolve consumer (carve-out below) lands, it calls THIS verb so the prefix-check guard stays single-sourced.

3. **`atmux team list-workers [--parent <team>] [--json]`**

   Enumerates worker-teams from `loadCockpit() → enabledTeams() → filter (type=epic-team AND name.startsWith("w-"))`. Read-only — for activity-based classification (idle, drainable, dissolve-safe) operators continue to use `atmux team sweep-epics` (ADR-170); `list-workers` is enumeration, not housekeeping.

### Carve-outs (§v2 §Amendment 2026-05-23)

- **Auto-dissolve on `task.done` — NOT in this ADR.** The Honker subscription that calls `dissolve-worker` when the worker's only task transitions to `done` is folded into **EPIC e-a946af69 Phase 4 (orchd lifecycle)**. The event-driven substrate (ADR-202, relayd shipped 2026-05-22) supports it; the consumer wiring belongs with the broader lifecycle work in e-a946af69, not as a sibling of these three thin verbs.
- **`dissolve-worker` is NOT a no-op on non-worker epic-team ids.** It refuses with a hint, never silently passes through. The `e-` vs `w-` distinction is a load-bearing convention; eroding it via silent fallthrough would break the future auto-dissolve path's prefix-based subscription filter.

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
- [ADR-090 §`spawn-epic` verb](090-epic-team-lifecycle.md) — substrate this builds on
- [ADR-091 §`epic-merge`](091-kanban-driven-auto-merge.md) — fan-in semantics shared with workers
- [ADR-170 §`sweep-epics`](170-sweep-epics-verb.md) — companion read-only enumerator + housekeeping path (workers count against the same sweep)
- [ADR-202 §Amendment 2026-05-22](202-honker-in-db-messaging-substrate.md) — event substrate for §v3 auto-dissolve consumer (consumer wiring deferred to EPIC e-a946af69 Phase 4)
- 2026-05-22 session log — multiple small-fix commits motivating the gap analysis
- 2026-05-23 §v2 amendment — e-678dd038 epic-team shipped the 3 convenience verbs + tests; dogfood validation outstanding (operator self-spawn of a worker via the new verb)

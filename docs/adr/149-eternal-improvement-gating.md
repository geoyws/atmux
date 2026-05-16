# ADR-149: Eternal-improvement gating — config disable toggle + backlog non-emptiness gate

**Status**: Proposed
**Date**: 2026-05-15
**Author**: atmux team (whip-impl / t-496348ea)
**Parent EPIC**: t-7c1c50f8
**Driver-ref**: 2026-05-15 16:46 MYT cockpit driver — eternal-improvement is opt-in busy-work; the existing substrate (ADR-052) fires `openCycle` whenever the cron tick lands, even when the team has real backlog or has decided it doesn't want improvement cycles at all.
**Relates**: ADR-052 (eternal-improvement substrate — fires the cron tick; this ADR gates its entry path), ADR-148 (cadence-as-truth — sibling principle: real-work signals dominate proxy signals), ADR-126 (SQLite state store — canonical kanban state read by the backlog gate), ADR-077 (medic — consumes the doctor probes added here), ADR-132 (martinet — observation pipeline parallel; eternal-improvement gating is the per-tick analog at the substrate layer).

> Cross-reference clarification (not load-bearing): the Task body t-496348ea §Acceptance cited "ADR-005 (kanban-source-of-truth)" but ADR-005 is `doctor-preflight`. The substantive kanban-canonical-state ADRs are ADR-126 (SQLite state store) and ADR-007 (pull-kanban); both are cited above in lieu.

## Context

`atmux improve` (ADR-052) runs cycle-loop mechanics over `<atmuxDir>/state/eternal-improvement.json`. Each cron tick walks `tickCycle` (`src/verbs/improve.ts:505`), which calls `openCycle` (`src/core/improve-cycle.ts:67`) whenever the predicate chain — `state.active && currentCycle == null && !isDriverPreempt(tasks) && isCycleClosable(...)` — clears. Today every entry to `openCycle` is unconditional: no consultation of operator opt-out, no check that the team has unresolved real work the improvement cycle would compete with.

Two operator-side gaps surface from this design:

### Issue 1 — No per-team / fleet-wide opt-out

Eternal improvement is opt-in busy-work by design (ADR-052 §Mode A vs Mode B). Some teams legitimately want it always; some want it never; some want it on for a sprint then off for a release window. Today the only way to disable is `atmux improve --status` + `atmux stop` per team, which is verb-mode, not config-mode — the next cron tick re-arms the run if state-file `active=true` persists.

A config-driven kill switch (declarative, per-team, fleet-default-capable) is the missing layer. Members of the team should NOT need to remember to `atmux stop` after every restart; the team's `team.json` should declare its eternal-improvement posture, and the substrate should respect it at entry without further verb intervention.

### Issue 2 — Improvement cycles compete with real backlog

When a team has 30+ todo Tasks (real work the planner already decomposed; operators / drivers / sibling teams created), kicking off a new improvement cycle that spawns MORE Tasks (per ADR-052 §Loop step 2 "planner lands eternal-improvement Tasks into kanban") amplifies the backlog rather than burning it down. The cron-tick's "open a cycle" decision is structurally biased toward more work, not less.

Per ADR-148's cadence-as-truth principle (D1): real-work signals dominate proxy signals. The "improve cron tick fired" signal is a proxy for "team is idle and wants enrichment"; the "kanban has 30 todo Tasks" signal is the real measurement of "team is NOT idle and definitely doesn't want enrichment". The latter must override the former.

### Why one ADR, two coupled gates

Both gates fire at the SAME chokepoint (`openCycle` entry) and share the same consequence (defer the cycle, observable via doctor probes, no Discord noise, no EPIC spawn-children). Splitting them across two ADRs would create two parallel-but-distinct gating mechanisms; one ADR keeps the entry semantics coherent and gives the doctor probes a single source ADR to cite.

## Decision

### (D1) Config gate — declarative per-team enable / disable

`team.json::eternalImprovement.enabled` is the master switch. Default `true` for backward-compat (existing teams running ADR-052 see no behaviour change). When the resolved value is `false`:

1. `tickCycle` (or its `openCycle`-invoking call-site at `src/verbs/improve.ts:299` / `:568`) short-circuits before `openCycle` runs.
2. NO Discord ping (`🌱 [eternal-improvement-start]` / `[eternal-improvement-progress]` suppressed at the gate; no template-level guard required).
3. NO EPIC spawn-children (the planner-driven `openCycle` path that "lands eternal-improvement Tasks" never fires).
4. Doctor probe row emitted (§D3).

Disable is **idempotent** — a tick that hits the disabled gate is a no-op; subsequent ticks behave identically until the operator flips the flag back. The state-file (`<atmuxDir>/state/eternal-improvement.json`) is NOT mutated by the disabled gate — `active` retains its prior value so a flip-to-`true` resumes from the same posture. Operators flipping `enabled: false → true` see the next tick's `openCycle` behave normally.

### (D2) Backlog gate — defer when real work is pending

When the config gate clears (`enabled === true`), the second gate counts kanban Tasks meeting BOTH:

- `status ∈ {todo, in-progress}`, AND
- NOT improvement-spawned: `task.epic !== IMPROVEMENT_EPIC_ID` (where `IMPROVEMENT_EPIC_ID === "e-a25968cc"` per `src/core/improve-cycle.ts:50`) AND `task.id` NOT in the in-flight `currentCycle.tasksLanded` / `currentCycle.tasksDispatched` set (defense-in-depth for cycles where the EPIC-id marker wasn't set on a spawned Task — should not happen, but the dual check costs O(N) iteration with no false positives).

If the count is **> 0**: `openCycle` is deferred. The substrate logs a single-line defer reason at the tick (`improve-cycle: deferring openCycle — backlog non-empty (N tasks)`) and returns without state-file mutation. No Discord, no children. Doctor probe row emitted (§D3).

If the count is **0**: `openCycle` proceeds as today.

The count is **fresh per tick** — no caching. ADR-052 cycle ticks fire on `team.improve.intervalMins` cadence (default hourly in the ADR's example; per-team configurable); the budget impact of one extra `loadKanban()` call (already loaded by `tickCycle` for the `isDriverPreempt` check at `src/verbs/improve.ts:520`) is zero.

### (D3) Doctor probes — surface both states explicitly

`src/verbs/doctor.ts` (per ADR-005 doctor-preflight machinery; lands in T4 — out of T1 scope) gains two new probe rows:

| Probe id | Class | Trigger | Hint |
|---|---|---|---|
| `eternal-improvement-disabled-per-config` | `warn` | resolved `enabled === false` for the team | "team.json::eternalImprovement.enabled = false; cron tick is no-op. Flip the flag (or remove the key) to re-enable." |
| `eternal-improvement-deferred-backlog` | `info` | last tick deferred via §D2 backlog gate | "deferred — N kanban Tasks (status todo|in-progress, non-improvement-spawned). Drain the backlog OR flip enabled=false to silence." |

Class rationale: **disabled = `warn`** because it's a visible operator choice that operators want surfaced (catches the "forgot to re-enable after release window" failure mode); **deferred = `info`** because it's transient and self-resolves the moment the backlog clears (no operator action required; surfaced for awareness, not for action).

Wiring: the probes read the same resolution path as `tickCycle` (§D4) — no separate gate logic in doctor; doctor reads the resolved config + a small state-file annotation (e.g. `eternal-improvement.json::lastTickDeferReason: "backlog: N tasks"`, surfaced when the most-recent tick fired the deferral, NULL/unset otherwise — out-of-scope detail for T4 to design).

### (D4) Config schema — `team.eternalImprovement` + `cockpit.defaultEternalImprovement`

Per the existing `TeamWhip` precedent (`src/schema/team.ts:92` — strict block, fields-required-by-impl carried as defaulted optionals, drift-ping on typo):

```ts
// src/schema/team.ts
export const TeamEternalImprovement = z
  .object({
    /** Master switch. Default true — existing teams running ADR-052
     *  see no behaviour change. Operator flips to false to disable the
     *  substrate at openCycle entry (no Discord, no children spawned). */
    enabled: z.boolean().default(true),

    /** Reserved for future per-cycle overrides — undefined-default
     *  on purpose so a later ADR can wire runtime without schema
     *  migration. Per the TeamWhip.velocityGate precedent
     *  (schema/team.ts:183) for placeholder-knobs-without-impl. */
    modeOverride: z.enum(["user-invoked", "idle-fallback"]).optional(),
    budgetOverride: z.string().optional(),     // raw spec string, e.g. "30%-wk"
    cadenceOverride: z.number().int().positive().optional(),  // minutes
  })
  .strict()
  .optional();
export type TeamEternalImprovement = z.infer<typeof TeamEternalImprovement>;
```

```ts
// src/schema/cockpit.ts
export const CockpitDefaultEternalImprovement = z
  .object({
    /** Fleet-wide default for teams whose team.json omits the block.
     *  Resolution order: team.eternalImprovement.enabled (when present)
     *  → cockpit.defaultEternalImprovement.enabled (when present)
     *  → hard-coded default `true`. Mirrors the
     *  cockpit.defaultMartinet pattern (schema/cockpit.ts:465). */
    enabled: z.boolean().default(true),
  })
  .strict()
  .optional();
```

**Resolution order** (operative function: `resolveEternalImprovementEnabled(team, cockpit) => boolean`, lands in T2):

1. `team.eternalImprovement.enabled` (when defined; presence wins regardless of value)
2. `cockpit.defaultEternalImprovement.enabled` (when defined)
3. Schema default `true`

The "presence wins regardless of value" rule matters: a team that has explicitly set `enabled: false` overrides the cockpit default `true`. This is the standard precedent-chain shape (per ADR-132 §D6 martinet resolution) — closest scope wins.

Future fields (`modeOverride` / `budgetOverride` / `cadenceOverride`) are declared in the schema with `undefined`-defaults; they do NOT participate in resolution today. A future ADR can wire them without forcing a schema migration — operators who set the field early on a config see the value persist through the `loadTeam` round-trip but with no runtime effect until the corresponding ADR ships.

### (D5) Sibling principle with ADR-148 — real-work signals dominate

ADR-148 D1 establishes: "commit-cadence is THE canonical truth signal for 'is this member shipping?'". The corollary for eternal improvement is: **kanban backlog is THE canonical truth signal for 'does this team need more work?'**. The cron tick's "fire openCycle" decision is a proxy for "team is idle and wants enrichment"; the backlog count is the real measurement.

Where the two signals conflict, the real signal wins:

| Cron tick signal | Backlog signal | Decision |
|---|---|---|
| `tickCycle` armed (state.active=true) | backlog == 0 | proceed (today's behaviour) |
| `tickCycle` armed (state.active=true) | backlog > 0 | **defer per §D2** (this ADR) |

Same shape as ADR-148 §D4 lane-stall gate: the cron signal is the necessary-but-not-sufficient condition; the real-work signal is the sufficiency check. Eternal improvement should never compete with real work — backlog count is the dominant directive.

### (D6) Backward compat — missing config defaults to enabled=true

Existing teams have no `eternalImprovement` block in their `team.json`. The schema declares the block `.optional()`; `loadTeam` parses missing-block as `undefined`. The resolver (§D4 chain) hits the schema default `true` and returns `true` — same as today's unconditional behaviour. Existing teams see no observable change until they explicitly opt in to `enabled: false`.

This is the same back-compat posture as ADR-148's `team.json::cadence` block (defaults applied when absent) and ADR-132's martinet block (default `claude` impl when absent).

### (D7) Migration shim — none needed

The block is purely additive; existing `team.json` and `cockpit.json` parse unchanged. No state-file migration (`eternal-improvement.json` is untouched by the gates; its only annotation, `lastTickDeferReason`, is added in T4 as a `.passthrough()`-compatible additive field). No cron-template churn (the cron line still fires `atmux improve --tick`; the verb itself now hits the gates internally).

## Tradeoffs

### Bounded vs unbounded — same philosophy as ADR-148

| Choice | Risk shape | Pick? |
|---|---|---|
| Config gate (declarative `enabled` toggle) + backlog gate (real-work dominance) | **Bounded**: a misconfigured `enabled: false` makes improvement silent; doctor probe surfaces the choice as `warn` so operators see it. A misconfigured backlog count that under-counts (false `enabled=true` path) costs one extra cycle's worth of spawned-but-unused Tasks; self-corrects next tick. | ✅ |
| No gate (today's behaviour) | **Unbounded**: every team is locked into opt-in busy-work whether they want it or not; improvement cycles compete with real backlog and amplify it rather than burn it down. | ❌ |
| Verb-level gate (`atmux improve --check-backlog` before tick) | Couples operator UX to a manual flag every operator must remember; fails the "structurally enforced, not memory-enforced" bar from ADR-148's D1 framing. | ❌ |
| Runtime override via CLI flag (`atmux improve --skip-backlog-gate`) | Adds a verb-mode escape hatch that competes with the declarative config; risks operators leaving the flag set in cron and silently re-enabling improvement during real backlog. | ❌ deferred to operator-ask (§Out of scope) |

### Cost — one extra count per tick

The backlog gate requires one full kanban scan per tick. `tickCycle` already calls `loadKanban` for the `isDriverPreempt` check (`src/verbs/improve.ts:520`); the gate iterates the resulting array once. O(N) over kanban length per tick — at N=50 tasks × hourly cadence × 10 teams = 500 iterations per hour fleet-wide — negligible.

No SQL touch beyond what `loadKanban` already executes (the SQLite read is the dominant cost; the in-memory filter is free).

### Schema strictness blast radius — D4

The `team.eternalImprovement` block is `.strict()` per the TeamWhip precedent. Typo'd keys (`enable: false` instead of `enabled: false`) get rejected at config-load with a drift-ping rather than silently using the default — matching the existing operator-config UX. Teams that hand-edit `team.json` to set `enabled: false` and typo the key will see a hard load error pointing at the field; this is the intended behaviour (preferable to silent-no-op).

### Future-fields placeholder reserve — D4

`modeOverride` / `budgetOverride` / `cadenceOverride` are declared but unwired. The `undefined`-default pattern (precedent: `TeamWhip.velocityGate`, `team.ts:183`) avoids schema migration when a future ADR wires them. Risk: an operator sets the field optimistically and waits for it to take effect; mitigation: doctor probe `eternal-improvement-config-field-unwired` is a future addition (out of T1 scope) that surfaces a per-field warn-row.

## Cross-references

- **ADR-052 — eternal-improvement substrate**. This ADR gates the substrate's `openCycle` entry; the substrate's state-machine, cycle-loop mechanics, and Mode A / Mode B termination semantics are unchanged. (Note: ADR-052's filename is not present in the worktree — the substrate is captured in `src/core/improve-cycle.ts` + `src/schema/eternal-improvement.ts` headers + `improve-cycle.ts:50`'s `IMPROVEMENT_EPIC_ID` constant. The ADR number is referenced in code comments throughout.)
- **ADR-148 — cadence-as-truth**. D5 names ADR-148 as the sibling principle: real-work signals dominate proxy signals. ADR-148 applies the principle to per-member shipping verdicts; ADR-149 applies it to per-team eternal-improvement entry.
- **ADR-126 — SQLite state store**. The backlog gate reads from the canonical kanban store; the count is a `loadKanban()` filter, not a separate query.
- **ADR-007 — pull-kanban**. Backlog count semantics align with pull-kanban claim-eligibility filter (status ∈ {todo, in-progress}).
- **ADR-077 — medic**. Medic's event-driven pickup consumes the `eternal-improvement-disabled-per-config` and `eternal-improvement-deferred-backlog` probes for fleet-wide observability (medic's hourly diagnose loop reads doctor output).
- **ADR-132 — martinet**. Parallel pattern: the per-tick observation pipeline. Martinet observes member-level signals; eternal-improvement gating observes team-level signals; both feed back into the per-tick decision point.

## Open questions

**OQ-1 — Per-cycle bypass via verb flag (`atmux improve --skip-backlog-gate`)?**

A driver-only escape hatch that bypasses the backlog gate for a single tick (NOT the config gate — `enabled: false` always wins). Useful for the rare case where the operator wants improvement to fire DESPITE non-empty backlog (e.g. running a one-off improvement cycle to ingest a new ADR's spawn-children even while real work is pending).

**Recommended default**: **defer** to operator-ask. The declarative config is sufficient for v1; a verb-flag adds escape-hatch surface area that competes with the config and risks operators leaving the flag set in cron lines.

Driver override path today: edit `team.json` → set `eternalImprovement.enabled: true` (or remove block to revert to cockpit default) → drain backlog by completing pending Tasks OR by reassigning them to a different epic that the backlog count would exclude. None of these are great; if operators ask for `--skip-backlog-gate`, a follow-up ADR can wire it.

**OQ-2 — Backlog count denominator: include / exclude `blocked` status?**

§D2 specifies `status ∈ {todo, in-progress}` as the count denominator. `blocked` Tasks are real work but can't currently be picked up — should they count or not?

**Recommended default**: **exclude `blocked`**. A blocked Task is a Task waiting on an external resolution (cross-lane handoff, decision, dep); it shouldn't suppress improvement cycles because it doesn't represent claimable work the team would otherwise be doing. If the count was `blocked` Tasks only and zero `todo`/`in-progress`, the team IS idle from a do-able-work perspective; improvement should proceed.

Counter-argument: blocked Tasks are still "team backlog" in a project-management sense; suppressing improvement when there's any unfinished work (regardless of state) is the more conservative bar.

Driver override via decisions log when concrete demand emerges.

**OQ-3 — Cross-team coordination on eternal-improvement?**

Today the gate is per-team. A fleet of N teams with `enabled: true` each fires its own cycle independently; no super-driver coordination prevents two teams from running cycles in the same window (consuming the shared planner / reviewer budget if those roles cross teams).

**Recommended default**: **out of scope for v1** — per-team config block only. Super-driver level coordination defers to a future super-* hierarchy ADR (currently tracked as ADR-274 candidate per the parent EPIC's framing). The cockpit `defaultEternalImprovement` block (§D4) is the v1 fleet-wide knob; finer coordination (e.g. "at most M teams running improvement concurrently") is a Phase-2 concern.

## Implementation plan

This ADR commits the **specification only**. Implementation lands across sub-tasks (per the parent EPIC's expected shape; sub-task filing alongside this commit is the parent EPIC's responsibility, NOT T1's):

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-149 (this ADR) | — | review (planner-equivalent for ADR drafts) |
| T2 | Schema impl: `TeamEternalImprovement` + `CockpitDefaultEternalImprovement` + `resolveEternalImprovementEnabled` resolver | T1 | be |
| T3 | `src/core/improve-cycle.ts` gate impl: both gates fire in `tickCycle` before `openCycle` invocation; defer-reason annotation on state-file | T1, T2 | be |
| T4 | Doctor probe impl: `eternal-improvement-disabled-per-config` (warn) + `eternal-improvement-deferred-backlog` (info) | T1, T2, T3 | be |
| T5 | Doc updates: `docs/RUNBOOK-eternal-improvement.md` operator-opt-in flow + `templates/briefs/lead.md` cross-ref (lead's whip-turn awareness of disabled-per-config + deferred-backlog states) | T1 | docs |
| T6 | e2e: synthetic team with `enabled: false` (tick fires, no-op, doctor warn) + `enabled: true` with backlog (tick defers, doctor info, no Discord) + `enabled: true` with empty backlog (tick proceeds as today) | T3, T4 | test |

Sub-task IDs filed alongside this commit per the parent EPIC's decomp pass — out of T1's scope per the Task body's "Single ADR draft commit, no impl" framing. Reviewer flips this ADR Proposed → Accepted in follow-up after T2-T6 land green.

## Acceptance gates

For T1 specifically:

- [x] `docs/adr/149-eternal-improvement-gating.md` exists with `Status: Proposed`.
- [x] Both gates (config + backlog) mapped to decision pieces D1+D2.
- [x] Schema documented (§D4) — `team.eternalImprovement` block + `cockpit.defaultEternalImprovement` block + resolution order + future-field placeholders.
- [x] Doctor probe rows specified (§D3) with class rationale (warn vs info).
- [x] Sibling principle to ADR-148 named explicitly (§D5).
- [x] Back-compat posture stated (§D6).
- [x] Cross-refs to ADR-052 / ADR-148 / ADR-126 / ADR-007 / ADR-077 / ADR-132.
- [x] 3 OQs with recommended defaults (per-cycle bypass; blocked-status inclusion; cross-team coordination).
- [x] Out-of-scope §explicit on per-cycle overrides + manual bypass + cross-team coordination + schema impl.
- [ ] Single commit; reviewer-gated.

Wider EPIC acceptance gates T2-T6 — those are out of T1's scope.

## Out of scope

- **Schema impl** (T2 — `src/schema/team.ts` + `src/schema/cockpit.ts` field additions + resolver).
- **Gate impl** (T3 — `src/core/improve-cycle.ts` and/or `src/verbs/improve.ts` short-circuit wiring + defer-reason state annotation).
- **Doctor probe impl** (T4 — `src/verbs/doctor.ts` row emission + state-file-annotation read path).
- **Doc updates** (T5 — `docs/RUNBOOK-eternal-improvement.md` + `templates/briefs/lead.md`).
- **e2e** (T6 — synthetic team across all three gate-states).
- **Per-cycle CLI bypass** (`atmux improve --skip-backlog-gate`) — OQ-1; deferred to operator-ask.
- **Cross-team coordination** (super-driver level) — OQ-3; deferred to super-* hierarchy ADR.
- **Future scheduling overrides** (`modeOverride` / `budgetOverride` / `cadenceOverride` runtime wiring) — schema placeholders only in v1; future ADR wires them without schema migration.
- **Manual `atmux improve --reset` semantics** — orthogonal to gating; the gates do NOT touch state-file `active` flag, so reset-by-operator behaviour is unchanged.
- **Fleet-wide N-teams-concurrent throttle** — OQ-3; super-driver scope.

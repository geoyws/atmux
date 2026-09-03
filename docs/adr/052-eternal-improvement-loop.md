# ADR-052: Eternal-improvement loop — Mode A / Mode B autonomous cycle substrate

**Status**: accepted (2026-05-16, retrospective backfill per `t-75a79d7c`; substrate shipped in `src/core/improve.ts` + `src/core/improve-cycle.ts` + `src/core/eternal-improvement.ts` + `src/schema/eternal-improvement.ts` + `src/verbs/improve.ts` across T1–T8 + R1-T5 + §Whip-integration during 2026-05 — written here to close the citation gap flagged at `aaa5689` and resolve the "ghost ADR" referenced by ADR-081 / ADR-115 / ADR-149.)
**Date**: 2026-05-06 (original implementation start) — backfilled 2026-05-16
**Author**: atmux team (substrate authored across multiple members; backfill drafted by `whip-impl` per planner-routed task body's option (a) "Write docs/adr/052-eternal-improvement-loop.md backfilling from code + sibling ADRs")
**Relates**: ADR-022 (whip — fires the intercept), historical decision number 049 (no surviving ADR file) (budget caps — supplies token quantities), ADR-005 (errors — `SchemaError` on invalid state-file), ADR-016 (schemaVersion deferral — burn-in carve-out), ADR-077 (medic — observes the run via doctor probes), ADR-126 (SQLite kanban — read by cycle-closability checks), ADR-148 (cadence-as-truth — sibling principle), ADR-149 (eternal-improvement gating — extends this ADR's `openCycle` entry path)

## Context

`atmux whip` runs every 5min via cron on each team. When a team has been idle long enough that members would otherwise hit the ADR-043 auto-stop path (whip detects a sustained-no-commit window and tears down the cage to release the Claude Max budget), the team's remaining budget window goes unused — operators consistently lose 30–90min of 5h-window budget per quiescent stretch, and on weekly-window terms the cumulative loss across a fleet of 10 teams is significant.

The natural mitigation is an **autonomous self-improvement loop**: instead of letting the cage idle to auto-stop, fire `atmux improve --idle-fallback --default-budget` to spawn a planner-driven cycle where each lane proposes its top "improvement candidate" (refactor, test backfill, doc gap, observability gap), the planner ranks impact-vs-cost and lands 1–3 Tasks, members claim + ship them normally, gitter merges, the loop closes; rinse + repeat until the team's budget envelope for the run is exhausted, at which point Mode B fires `atmux stop` to release the cage cleanly.

Mode A is the same loop but **user-invoked** (`atmux improve --budget <spec>`): operator wants a deliberate improvement cycle, not an idle-fallback. Same state-file + same cycle mechanics; Mode A does NOT auto-stop on exhaustion (operator-driven run; operator decides when to wind down).

The substrate landed across multiple T-tasks during 2026-05 (commits referenced in the §Implementation status table). The ADR file slot at 052 was created in the sequence but the file itself was never committed — sibling ADRs (081, 115, 149) wrote up against the substrate by code-pointer instead. This ADR closes the gap retrospectively.

## Decision

### Verb surface

```
atmux improve [--budget <spec>] [--status] [--tick] [--dry-run] [--default-budget] [--idle-fallback] [--force]
```

| Flag | Semantics |
|---|---|
| `--budget <spec>` | Budget envelope for this run. Spec grammar in §Budget formula. Mutually exclusive with `--default-budget`. |
| `--default-budget` | Resolve budget via precedence cascade (CLI → env → team.json → built-in `30%-wk`) without an explicit value. |
| `--idle-fallback` | Set state `mode: "idle-fallback"` (Mode B). Auto-stops on budget exhaust. |
| `--status` | Print current state-file shape + exit 0. |
| `--tick` | Run one cycle-loop iteration. Idempotent — safe to call on quiescent state. Cron-fired. |
| `--dry-run` | Print resolved budget + planned `runId` + planned mode without writing state. |
| `--force` | Override stale-state guard (clear `active: true` even when `< 24h`). Operator-only escape hatch. |

Verb skeleton + arg parser at `src/verbs/improve.ts`; pure helpers at `src/core/improve.ts` (budget) + `src/core/improve-cycle.ts` (cycle) + `src/core/eternal-improvement.ts` (state-file IO).

### Mode A vs Mode B

| | Mode A — user-invoked | Mode B — idle-fallback |
|---|---|---|
| Trigger | Operator runs `atmux improve --budget <spec>` | Whip auto-detects sustained idle + invokes `atmux improve --idle-fallback --default-budget` |
| State-file `mode` | `"user-invoked"` | `"idle-fallback"` |
| Budget-exhaust action | Set `active: false`, fire 🌱 done ping, **leave cage running** | Set `active: false`, fire 🌱 done ping, **invoke `atmux stop`** to tear down the cage |
| Mid-run preempt | Pause + resume when driver Task lands | Same |
| Termination cause | Operator decision OR budget exhaust (no auto-stop) | Budget exhaust OR kanban-non-empty (Mode B exits on first real-work signal) |

Both modes share the same cycle mechanics, state-file shape, idempotence guard, and Discord template surface. The only divergence is the post-termination action.

### Budget formula

`<spec>` grammar (parsed by `parseBudgetSpec` in `src/core/improve.ts`):

| Form | Meaning | Example |
|---|---|---|
| `<int>` | Raw token count | `2000000` → 2M tokens |
| `<int>%` | Bare percent = `<int>%-wk` | `30%` → 30% of weekly remaining |
| `<int>%-5h` | Fraction of 5h-window remaining | `50%-5h` |
| `<int>%-wk` | Fraction of weekly remaining | `30%-wk` |

Built-in default: `DEFAULT_BUDGET_SPEC = "30%-wk"`.

Resolved by `resolveBudget(spec, opts)`:

- `kind: "raw"` → `{ total: spec.tokens, formula: "raw=<n>" }`
- `kind: "pct-5h"` → reads `.atmux/state/budget-probe-<team>.json` (historical decision number 049 (no surviving ADR file)) for `h5_util`; computes `<pct>/100 × (1 - h5_util) × DEFAULT_5H_CAP_TOKENS` (5_000_000 default; operator-overrideable per historical decision number 049 (no surviving ADR file)).
- `kind: "pct-wk"` → same shape against `wk_util` + `DEFAULT_WK_CAP_TOKENS` (100_000_000 default).

**Fail-closed rule**: when `kind:pct-*` is requested but no probe file exists, `resolveBudget` returns `null` and the verb maps to `UsageError`. Operators with cold probe state must either run `atmux budget probe` first, switch to raw token spec, or use `--default-budget` (which also fails until probe lands — the default itself is pct-based).

Precedence cascade (per `resolveBudgetSpec`):

1. CLI `--budget <spec>`
2. env `ATMUX_IMPROVE_BUDGET`
3. `team.json::improve.defaultBudget`
4. Built-in `DEFAULT_BUDGET_SPEC = "30%-wk"`

First non-empty wins.

### State-file schema

Path: `<atmuxDir>/state/eternal-improvement.json` (mirrors bash `_atmux_improve_state_path`). Lock sidecar: `<path>.lock` — matches the `whip-idle-state.json.lock` pattern. Bash and TS both write the same file (per ADR-016 burn-in carve-out, `schemaVersion` is omitted until post-bash-decommission).

Top-level fields (Zod schema at `src/schema/eternal-improvement.ts::EternalImprovementState`):

| Field | Type | Meaning |
|---|---|---|
| `active` | `boolean` | True during an active run; false between runs (file persists for audit). |
| `runId` | `string` | `ei-<8-hex>` — `generateRunId()` in `src/core/improve.ts`. |
| `startedAt` | `int` (epoch seconds, UTC) | Run start timestamp. |
| `mode` | enum `"user-invoked" \| "idle-fallback"` | See §Mode A vs Mode B. Closed-set; wider strings rejected (unlike kanban `lane` which carries free-form strings). |
| `budgetSpec` | `string` | Raw spec string as resolved (e.g. `"30%-wk"`). |
| `budgetTotal` | `int` | Token total computed at start. |
| `budgetRemaining` | `int` | Decremented per cycle close. May go negative briefly during fully-built mid-cycle overage. |
| `cycleN` | `int` | Cycle counter (1-indexed). 0 before the first cycle starts. |
| `currentCycle` | object \| null | In-flight cycle, OR null between cycles. Shape below. |
| `lastCycleClosedAt` | `int` \| null | Null until the first cycle closes. |
| `history` | array | Append-only ring; capped at `HISTORY_RING_MAX = 50` (oldest dropped). |

`currentCycle` shape (`EternalImprovementCurrentCycle`):

| Field | Type | Meaning |
|---|---|---|
| `startedAt` | `int` (epoch seconds, UTC) | Cycle start. |
| `tasksLanded` | `string[]` | Task IDs the planner created this cycle. |
| `tasksDispatched` | `string[]` | Task IDs dispatched to members this cycle. |
| `tasksDone` | `string[]` | Task IDs completed this cycle. |
| `tokensSpent` | `int` | Running tally finalized at cycle close. |
| `paused` | `boolean?` | Mid-run preempt flag — true when driver Tasks land mid-cycle. Optional; bash may write it without TS knowing. |

`history[]` entry shape (`EternalImprovementHistoryEntry`):

| Field | Type | Meaning |
|---|---|---|
| `cycleN` | `int` | Cycle counter as it was. |
| `startedAt` | `int` | Cycle start. |
| `closedAt` | `int` | Cycle close. |
| `tasksLanded` | `int` | **COUNT**, not array (array→count compaction to bound file growth as the ring fills). |
| `tasksDone` | `int` | COUNT. |
| `tokensSpent` | `int` | Tokens spent in the closed cycle. |

`.passthrough()` posture on all three schemas — matches the inbox/team/kanban pattern. Bash may write fields the TS port hasn't modeled yet; strict-rejection would break burn-in parity.

### Loop mechanics

Per cycle (driven by `tickCycle` in `src/verbs/improve.ts`, helpers in `src/core/improve-cycle.ts`):

1. **Arm** — `openCycle(state, nowSec)` increments `cycleN`, resets `currentCycle` to a fresh entry. `armCycle(atmuxDir, state)` appends a `🌱 eternal-improvement cycle N requested. Route to planner with: ask each lane member their top improvement candidate; score by impact-vs-cost; land top 1-3 Tasks; dispatch normally.` line to `<atmuxDir>/improve-directives.md`. Lead reads the file each whip turn; routes to planner.
2. **Land** — Planner authors 1–3 Tasks, tags `epic: IMPROVEMENT_EPIC_ID` (`e-a25968cc`), files them. Each filing increments `tasksLanded` via `recordLanded(state, taskId)`.
3. **Dispatch + claim** — Standard pull-kanban flow (per ADR-007). Members claim improvement Tasks normally; `recordDispatch(state, taskId)` runs at the dispatch event.
4. **Done detection** — `tickCycle` polls each cron tick:
   - `loadKanban` reads canonical state.
   - `isDriverPreempt(tasks)` returns true if any `in-progress` Task has `epic !== IMPROVEMENT_EPIC_ID` — pause the cycle (write `paused: true`, log + return).
   - `isCycleClosable(state, tasks, commitChecker)` returns true when every id in `tasksDispatched` is `status: 'done'` AND passes the commit-checker (default: non-null `completedAt`, a proxy for "gitter committed the back-side merge").
5. **Close** — `closeCycle(state, nowSec)` moves `currentCycle` to `history` (capped at 50), sets `lastCycleClosedAt`, decrements `budgetRemaining` by the cycle's `tokensSpent`. Fires 🌱 `[eternal-improvement-progress]` Discord ping.
6. **Terminate or re-arm** — `shouldTerminate(closed)` checks `budgetRemaining <= 0`:
   - **Terminate** — set `active: false`, write, fire 🌱 `[eternal-improvement-done]`. Mode B invokes `onTerminate` callback which fires `atmux stop`; Mode A leaves the cage running.
   - **Re-arm** — `openCycle` again, write, arm directive, fire 🌱 `[eternal-improvement-start]` for the new cycle.

Mid-cycle overage is allowed (budget can go briefly negative during the cycle-fully-built window before the next close). Termination is checked **post-cycle-close**, not mid-cycle, to avoid stranding partially-shipped improvement Tasks.

### Mid-run preemption

`isDriverPreempt(kanbanTasks, improvementEpicId = IMPROVEMENT_EPIC_ID)` returns true if any task has `status: 'in-progress'` AND `epic !== improvementEpicId`. When true, `tickCycle` calls `pauseCycle(state)` (sets `currentCycle.paused: true`) and returns without advancing. This lets driver-dispatched real work take priority over improvement Tasks without aborting the in-flight cycle.

`resumeCycle(state)` clears the `paused` flag when the driver Task lands and the team returns to quiescent. Implemented via destructure (strips the key rather than writing `paused: false`) to keep the file shape minimal between runs.

`IMPROVEMENT_EPIC_ID = "e-a25968cc"` — constant in `src/core/improve-cycle.ts:50`. Reserved at the source; never reused for non-improvement EPICs. Parameterised in the `isDriverPreempt` signature so future-rename cases (different epic per cage) can swap it.

### Idempotence

A second `atmux improve` invocation while a run is already active is **benign**:

- `isActive(state, nowSec)` = `state.active === true` AND `nowSec - state.startedAt < 24h` → the verb logs "improve: already active (runId=<id>, started <Hh ago>)" and exits 0. No state mutation.
- `isStale(state, nowSec)` = `state.active === true` AND `startedAt > 24h ago` AND no `currentCycle.startedAt` within last 6h → run is presumed crashed / abandoned. Next `atmux improve` may clear the file + start fresh; `--force` bypasses the stale check entirely.

Thresholds (24h active window, 6h cycle-quiescence window) are conservative — a real improvement run shouldn't go 6h between cycle closes; if it has, something has wedged + a fresh start is safer than recovering.

`writeState({ skipOnContention: true })` swaps the flock budget to 250ms and returns `false` on `LockTimeoutError` (with a non-fatal stderr log) — used by mid-cycle accounting (per-tick token-spend updates) where losing a tick is preferable to wedging the caller. Matches the bash-side `_atmux_improve_state_write_jq` non-blocking flock posture.

### Discord templates

Three typed templates rendered by `src/abstractions/discord.ts` (§"Eternal-improvement template renderers"):

| Template | Fires | Bullets |
|---|---|---|
| `[eternal-improvement-start]` | Run start + each re-arm | budget spec + total; mode; runId |
| `[eternal-improvement-progress]` | Each cycle close | cycle N closed + tasksShipped; tokens spent / total; remaining; next cycle |
| `[eternal-improvement-done]` | Run terminate | cycle count; total tasks shipped; tokens consumed / total; duration. Mode B appends `🛑 (Mode B) team will now atmux stop` |

Category emoji 🌱 across all three (the "growth" pivot). `formatTokens(n)` renders human-readable counts (`200000` → `"200k"`, `1500000` → `"1.5M"`, `2000000` → `"2M"`).

### Whip-integration

Per `src/core/whip-budget-check.ts:8` + ADR-115 §61, the bash-side `_atmux_whip_check_auto_stop` on `atmux-geoyws` carries an eternal-improvement intercept:

- **Pre-stop check** on `<atmuxDir>/state/eternal-improvement.json::active`.
- If `active !== true` (i.e. no run in progress) AND whip's auto-stop predicate has fired, invoke `atmux improve --idle-fallback --default-budget`. On success (exit 0), `return 0` — auto-stop is preempted; the improvement loop will run until its budget exhausts (then Mode B will fire `atmux stop` itself).
- If `active === true`, do not invoke (idempotent guard); auto-stop proceeds as normal if the improvement run is currently quiescent.

When the TS port re-enables the auto-stop check (per ADR-115's deferred row), the intercept must be ported alongside (lives in the same function, not a separate helper). Until then, the bash-side carries the intercept and the TS-side relies on it being present.

### Improvement EPIC reservation

`IMPROVEMENT_EPIC_ID = "e-a25968cc"` is the reserved EPIC id for all improvement-spawned Tasks. The planner stamps this id on every Task it lands during a cycle; `isDriverPreempt` keys off "any non-improvement in-progress Task" by checking `task.epic !== IMPROVEMENT_EPIC_ID`. The id is hard-coded (not generated) so the substrate doesn't need to track a per-team registry of "which EPIC is the active improvement EPIC right now" — there is exactly one, forever, per atmux deploy.

Operators MUST NOT manually file Tasks under this EPIC; doing so would trigger the wrong code path in `isDriverPreempt` (driver work would be misclassified as improvement, the cycle would not pause). The constant is owned by the substrate; planner reads it via import.

## Implementation status

The substrate landed across these commits (Task ID → commit SHA → file slice):

| T | Task ID | Commit | Lands |
|---|---|---|---|
| T1 | `t-a7a3b7dd` (R1-T1 budget probe + Fix C) / `t-49…` (impl skeleton) | `acf37ba` | `atmux improve` verb skeleton — args + budget-resolve + state-file write (`src/verbs/improve.ts`, `src/core/improve.ts`). |
| T2 | `t-…` (read/write/idempotence) | `89eaeb6` | State-file IO + idempotence-guard primitives (`src/core/eternal-improvement.ts`, `src/schema/eternal-improvement.ts`). |
| T3 | `t-97041dfb` (ADR-052 T3) | `da1d34d` | Discord templates `eternal-improvement-{start,progress,done}` + `DiscordEventType` union. |
| T4 | `t-…` (full-coverage tests) | `e8ba5b5` | TS + bats parity tests for verb + helpers. |
| T6 | `t-a3a0e5b1` (ADR-052 T6 whip-hook Mode B) | `9d08d42` + `620afd4` | Whip-integration — intercept ADR-043 auto-stop with `atmux improve`. |
| T7 | `t-…` (cycle-loop mechanics) | `8f2eada` | Cycle-loop mechanics (open / close / terminate / preempt + `--tick`). |
| T8 | `t-816a5104` (ADR-052 T8 e2e) | `1e838d1` | e2e — synthetic 1-cycle eternal-improvement run from start to termination. |
| R1-T5 | `t-19ce70d9` (historical decision number 053 (no surviving ADR file) budget-pause integration) | `8160d71` | Wire `runBudgetCheck` into whip-tick for the §Whip-integration intercept. |
| Doc | `t-7a8be5f` | `7a8be5f` | ADR-022 annotation noting the bash-side intercept. |

Discord cross-template renderers + `formatTokens` shipped alongside T3. The `IMPROVEMENT_EPIC_ID` constant landed with T7 (the first consumer in `isDriverPreempt`).

Test coverage at the source modules is 100% line + branch as of this backfill — `src/core/improve.ts`, `src/core/eternal-improvement.ts`, `src/core/improve-cycle.ts`, `src/schema/eternal-improvement.ts`. Verb-level coverage in `src/verbs/improve.ts` is the standard verb-test bar (parser + control-flow branches; the verb's spawn/IO seams stubbed via dep injection).

## Cross-references

- **ADR-022** — whip cron + pulse machinery. ADR-052's §Whip-integration intercepts whip's ADR-043 auto-stop path.
- **historical decision number 049 (no surviving ADR file)** — budget caps (5h, weekly). Supplies the `h5_util` / `wk_util` probe values consumed by `resolveBudget` for `kind:pct-*` specs.
- **ADR-005** — error hierarchy. `SchemaError` thrown on invalid state-file; `UsageError` on bad budget spec or contention with stale state-file (without `--force`).
- **ADR-016** — schema versioning. Burn-in carve-out: `schemaVersion` is omitted from the state-file schema until post-bash-decommission (Phase 6).
- **ADR-077** — medic / superdoctor. Consumes doctor probes derived from the state-file (active run / stale run / cycle-stuck). Diagnose loop reads the state and surfaces anomalies.
- **ADR-126** — SQLite kanban canonical store. Read by `tickCycle` for cycle-closability + driver-preempt checks.
- **ADR-148** — cadence-as-truth. Sibling principle: real-work signals dominate proxy signals. Applied here as "driver Task in-progress trumps in-flight improvement cycle".
- **ADR-149** — eternal-improvement gating. Extends ADR-052's `openCycle` entry path with a config gate (`team.eternalImprovement.enabled`) + backlog gate (defer when team has unresolved real work). ADR-149 explicitly states it does NOT touch ADR-052's state-machine, cycle-loop mechanics, or Mode A / Mode B termination semantics — those are this ADR's territory.
- **ADR-081** — bootstrap brief-paste bug. References ADR-052 as the auto-detect-then-fix pattern its §E extends.
- **ADR-115** — whip port scope. Defers the TS-side auto-stop check; calls out that ADR-052's intercept must be ported alongside when the TS path re-enables.

## Open questions

(Resolved in subsequent ADRs; tracked here for historical completeness.)

**OQ-1 — Gate the `openCycle` entry path on operator opt-in + real-work backlog?** — **Resolved by ADR-149** (config gate + backlog gate). Until ADR-149 landed, every cron tick that found the predicate chain clear opened a new cycle; ADR-149 narrows the entry to teams that have explicitly opted in AND have an empty backlog.

**OQ-2 — Per-member budget min vs team-level probe?** — Substrate approximates `min(remaining_wk_tokens_per_active_member)` via the team-level probe (historical decision number 049 (no surviving ADR file) emits one file per team capturing the bottleneck member). Precise per-member min lands when the loop wiring needs it; deferred.

**OQ-3 — Cross-team coordination?** — Out of scope. Each team's eternal-improvement run is independent. Super-driver-level "at most M teams running concurrently" coordination defers to a future super-* hierarchy ADR (currently tracked as ADR-274 candidate).

## Out of scope

- **The gating layer** (config opt-out + backlog defer) — ADR-149's territory.
- **Per-member budget min** — team-level probe approximation is sufficient for v1; per-member is OQ-2.
- **Cross-team coordination** — OQ-3; super-* hierarchy concern.
- **Manual `atmux improve --reset` semantics** — `--force` covers the operator-override case; a dedicated reset verb is not specified here.
- **Schema versioning** — deferred per ADR-016 until post-bash-decommission.

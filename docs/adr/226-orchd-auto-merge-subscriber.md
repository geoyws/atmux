# ADR-226: orchd auto-merge subscriber (Phase 3) — `task.done` → `atmux epic-merge` → `epic.merged`

**Status**: accepted
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban Epic `e-a946af69` ("orchd lifecycle Phase 3-5") + driver-inbox 08:27 MYT 2026-05-23 (lead relay)
**Parent EPIC (this team)**: `e-a946af69` (orchd Phase 3-5)
**Hard gate**: [`e-60e16169`](../../README.md) (orchd Phase 1+2 — rename relayd→orchd + auto-spawn subscriber pattern). Phase 3 mounts onto the daemon Phase 1+2 ships.
**Sibling cross-refs**: [ADR-090](090-epic-team-lifecycle.md) (`spawn-epic` / `dissolve-epic` primitives), [ADR-134](134-in-team-auto-merger.md) (in-team auto-merger two-trigger pattern), [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker substrate), [ADR-203](203-event-topic-taxonomy.md) (topic taxonomy v1).

## Context

ADR-090 ships `atmux epic-merge` as the imperative verb that fans an epic-team's branch into its parent base. Today the verb is invoked two ways:

1. **Cron backstop** — `atmux epic-merge tick` fires every N minutes, walks every live epic-team, gates on "all Tasks done + worktree clean + ahead-of-parent + reviewer-trunk-signoff" (ADR-090 §Decision-anchor #5), invokes `performMerge` per eligible epic.
2. **Operator manual** — driver/lead/planner runs `atmux epic-merge <eid>` directly.

The cron path has the canonical "shipped but eventually-consistent" gap [ADR-134](134-in-team-auto-merger.md) §triggers documented: a member moves the last Task to `done` at 14:02:11; cron tick fires at 14:05:00; the operator sees a 2m49s lag before the merge lands. Operators don't watch the gap, but downstream automations (epic-dissolved, follow-up Task transfers via ADR-195) inherit the delay.

Phase 1+2 of the orchd EPIC (`e-60e16169`) lifts relayd → orchd: per-team daemon already subscribed to `task.unclaimed` (lane-tick auto-dispatch) and `epic.added` (auto-spawn). The substrate (ADR-202 Honker + ADR-203 topic taxonomy) is shipped; the daemon is gaining responsibility for the EPIC lifecycle one phase at a time.

Phase 3 closes the merge-trigger gap end-to-end: when a `task.done` event lands AND it was the last open Task in the epic, orchd invokes `atmux epic-merge` directly — sub-second instead of cron-tick-windowed. The cron backstop stays installed as resilience fallback (catches missed events when the substrate is unavailable; mirror of ADR-134 §triggers two-trigger pattern).

### Why a separate ADR (not folded into ADR-091/ADR-134)

ADR-091 and ADR-134 cover the **in-team** auto-merger that fans **per-member branches** (`<base>-<member>`) into the team's trunk. ADR-090 covers **epic-team** merge (the EPIC's shared branch into its parent base). The two are DIFFERENT scopes:

| Layer | Source branch | Target | ADR | Today |
|---|---|---|---|---|
| in-team | `<base>-<member>` (per-member) | team trunk `<base>` | ADR-091/ADR-134 | event-driven (ADR-134 T3 / T4) |
| epic-team | epic-team shared branch | parent base | ADR-090 | cron-only (`epic-merge tick`) |

Phase 3 closes the second row. Following ADR-134's already-shipped pattern at a different scope is intentional: the architectural shape is proven; the consumer is new.

### Subscription seam — cross-team contract with `e-60e16169`

This EPIC's roster owns `src/core/orchd-merge.ts` (handler implementation + idempotency + epic-completeness query). The sibling EPIC `e-60e16169` owns `src/verbs/orchd.ts` (daemon entry + subscription wiring + per-tick loop). The seam between the two MUST be a stable exported function signature so the sibling can wire without our cage merging — i.e. our module ships first; sibling integrates on next tick.

The seam is the **same shape** as `src/core/gitter-consumer.ts::gitterConsume` (per ADR-145 / ADR-212), which is already in production. That gives us a canonical template — operators reading the code don't have to learn a second pattern.

## Decision

### §D1 — Trigger contract

Orchd subscribes to topic `task.done` (already in [ADR-203](203-event-topic-taxonomy.md) §D2 v1 topic set; no taxonomy amendment needed for the trigger). Per `task.done` event:

1. Resolve `epic` from event payload (`TaskDonePayload.epicId` if present; otherwise look up the Task's `epic` column; otherwise parse the `[e-XXXXXXXX...]` subject prefix — see §OQ2/§OQ4 resolution below).
2. If `epic` is `null` (Task wasn't bound to an Epic) → outcome `skipped-no-epic`. Continue draining.
3. Run epic-completeness query — **§OQ4-aware variant** (be-1 2026-05-23): `SELECT COUNT(*) FROM tasks WHERE (epic = :eid OR subject LIKE '[' || :eid || ']%' OR subject LIKE '[' || :eid || ' %' OR subject LIKE '[' || :eid || '/%') AND status NOT IN ('done', 'wontfix')`. The three `subject LIKE` branches catch the canonical EPIC-bound subject-prefix shapes — `[e-XXX]`, `[e-XXX T1]`, `[e-XXX/s-YYY]`. Without these branches the query returns `0` for every epicId today (since `tasks.epic IS NULL` universally per §OQ4) and orchd-merge spurious-merges every `task.done` instead of gating. If non-zero → outcome `skipped-epic-not-complete`. Continue draining.
4. If zero → invoke the merge dispatcher. Default-stub returns `skipped-not-mine`; the production wiring (this ADR's T1 / module impl Task) injects `performEpicMerge` from `src/core/epic-merge.ts`.
5. On dispatcher outcome:
   - `merged` → emit `epic.merged` event (Phase 4 consumer); outcome `merged`.
   - `merge-conflict` / `gate-held` → emit `epic.merge-blocked` (operator-observable); outcome `escalated`.
   - any throw → idempotency layer catches, offset is NOT advanced, next sweep retries. Handler never throws upstream.

### §D2 — Topic taxonomy amendment (ADR-203 §D2)

Two new topics added to [ADR-203](203-event-topic-taxonomy.md) §D2 v1 topic set in the same commit as `src/core/orchd-merge.ts`:

- `epic.merged` — fires after `performEpicMerge` returns success. Payload: `{topic, epicId, parentBase, mergeSha, mergedAtSec}`. Consumed by Phase 4 (ADR-227).
- `epic.merge-blocked` — fires when merge dispatcher returns conflict / gate-held. Payload: `{topic, epicId, reason, blockedAtSec}`. Operator-observable; no consumer in v1.

Both extend the existing `BasePayloadFields` discriminator. Zod schemas land in `src/schema/events.ts` alongside the topic-list entries.

**Carve-out vs reusing `epic.merge-ready`** (existing topic): `epic.merge-ready` semantically means "epic is ELIGIBLE to merge" (pre-condition); `epic.merged` means "epic HAS been merged" (post-condition). Different lifecycle phase; conflating them couples Phase 3 emit to whatever future "merge-ready" consumer might land. Add a new topic.

### §D3 — Idempotency + offset contract

Reuse the existing `withIdempotency` wrapper from `src/abstractions/events.ts` — same as `gitter-consumer.ts::gitterConsume`. Per-event outcome:

- Handler returns synchronously (any outcome string) → offset advances past this event.
- Handler throws → offset stays; next sweep re-attempts.
- Handler returns `merged` for an already-merged epic → no-op (merger_state.state='merged' is permanent-terminal per memory `project_merger_state_merged_terminal_design_gap`; dispatcher refuses with `state-stuck` outcome that we map to `skipped-already-merged`).

The epic-completeness query in §D1 step 3 is read-only + safe to repeat: if two `task.done` events fire for the same epic (e.g. a transient `done → todo → done` flap), the second one still sees `COUNT(*) = 0` and re-invokes the dispatcher, which short-circuits on `merger_state`.

### §D4 — Cron backstop coordination

`atmux epic-merge tick` cron stays installed during the **transition period** (2 weeks per ADR-202 §X cron decommission protocol). Sequence:

1. T+0 (this Task ships): orchd primary path live; cron still installed; both compete for the same `merger_state` row; first one wins via `BEGIN IMMEDIATE` (existing serialization).
2. T+2 weeks (operator verifies sub-second median via Honker event-log query): mark cron line deprecated in `team.json::epicMerge.cron` template. Follow-up Task to remove the install in `lib/cron.sh` per ADR-202 §X.
3. CHANGELOG entry per ADR-202 §X protocol naming the deprecation date + removal date.

### §D5 — Subscription seam (cross-team contract with `e-60e16169`)

Module surface mirrors `src/core/gitter-consumer.ts` exactly. Exported by `src/core/orchd-merge.ts`:

```ts
export type AutoMergeOutcome =
  | "merged"
  | "escalated"
  | "skipped-no-epic"
  | "skipped-epic-not-complete"
  | "skipped-already-merged"
  | "skipped-honker-off"
  | "skipped-not-mine";

export interface OrchdMergeConsumeDeps {
  db: Database;
  consumerName?: string;        // default "atmux:orchd-merge"
  topics?: ReadonlyArray<string>; // default ["task.done"]
  handler?: (event: TaskDonePayload) => Promise<AutoMergeOutcome>;
  nowSec?: () => number;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export async function orchdMergeConsume(
  deps: OrchdMergeConsumeDeps,
): Promise<{ processed: number; escalated: number }>;
```

Default handler is `skipped-not-mine` (stubbed-default-with-injected-resolver per memory `feedback_stubbed_default_with_injected_resolver`). Production wiring lives in this ADR's T1 (the module Task) — injects `performEpicMerge` from `src/core/epic-merge.ts`.

Sibling EPIC `e-60e16169` consumes the seam from `src/verbs/orchd.ts` daemon main-loop:

```ts
// sibling-owned — illustrative only
import { orchdMergeConsume, createAutoMergeHandler } from "../core/orchd-merge.ts";

const handler = createAutoMergeHandler({ db, performEpicMerge });
await orchdMergeConsume({ db, handler, logger });
```

Sibling does NOT need to import internals; the `createAutoMergeHandler` factory bundles the production wiring. This keeps the seam narrow: one function the sibling calls per tick, one factory to construct the handler.

## Consequences

- **Sub-second EPIC merge** on the happy path (member's last `task move done` → orchd tick → merge lands within Honker NOTIFY latency, ~50-200ms typical).
- **Two-trigger resilience** stays — cron backstop catches missed events for 2 weeks before decommission.
- **Topic taxonomy grows by 2** (`epic.merged`, `epic.merge-blocked`). ADR-203 §D2 amended in same commit.
- **Cross-team contract** with `e-60e16169` planner. Seam shape MUST agree before sibling integrates. Coordination via lead-outbox until sibling spawns.
- **Solo-worker v2 unlock** — workers are epic-teams (ADR-221 §v1, `w-` prefix). Same `task.done → orchd-merge` flow handles worker last-Task transitions. Phase 4 (ADR-227) closes auto-dissolve.
- **Rollback** — `ATMUX_HONKER=off` disables the substrate; consumer short-circuits; cron-only path resumes. Same kill-switch as gitter / all Phase-1 consumers.

## Open questions

1. **Topic name `epic.merged` vs `epic.merge-completed`?** Defaulted to `epic.merged` for symmetry with existing `epic.dissolved` + `epic.created`. Reversibility: low (rename is a search-and-replace inside Phase 3-4 scope; nothing external consumes yet). **Decided-by**: planner; surface to reviewer for ADR-203 amendment review.
2. **Should `task.done` payload carry `epicId` natively, or always re-query?** **RESOLVED 2026-05-23 (be-1, t-05f368d6)** — `TaskDonePayload.epicId` is **already present** as `z.string().optional()` at `src/schema/events.ts:60`, and the emitter at `src/core/kanban.ts:478-479` populates it when the kanban task's `epic` column is a string. **Decision: keep schema as-is — DO NOT amend.** Rationale: the schema is already correct, and making `epicId` required would be a medium-rev breaking change rippling to every `task.done` consumer (gitter, lane-router, future Phase-3/4/5 consumers) for zero functional gain — handler still needs the `null` branch because tasks legitimately ship without an epic binding. Implementation: T1's `resolveEpicId(event, db)` reads `event.epicId` first (preferred path); falls back to DB lookup on `tasks.epic` column; final fallback parses the `[e-XXXXXXXX...]` subject prefix (see §OQ4 — the prefix fallback is load-bearing TODAY because `tasks.epic` is universally `NULL` until §OQ4 is resolved). Reversibility: low (no schema change committed). **Decided-by**: be-1 verification (per Task t-05f368d6 deliverable) — surface to reviewer as a medium-rev DECISION for parent `.atmux/decisions.md` (verb `atmux decisions add` aspirational per `feedback_brief_aspirational_verbs`; landing via driver reply).
3. **Backpressure when many epics complete simultaneously?** If a flag-day operator-batch marks 20 epics as `task move done` at once, orchd processes them serially via the idempotency wrapper. Latency degrades linearly — no parallelism. Worth a follow-up benchmark Task; not a v1 blocker (cron backstop already serial too). **Decided-by**: defer to operator dogfood feedback.
4. **NEW (be-1, t-05f368d6 §OQ2-spinoff): `tasks.epic` column is universally `NULL` in real kanbans — Phase 3 is data-broken until subject-prefix parser lands.** Probe results 2026-05-23: parent `atmux` kanban has 0/1044 tasks with `tasks.epic IS NOT NULL`; this epic-team's kanban has 0/26. All EPIC-bound tasks today encode their epic via the `[e-XXXXXXXX...]` subject prefix only (164 such tasks parent-side). Root cause: `atmux task add` lost `--epic` / `--story` / `--deliverable` flags in 0.8.9 (per memory `feedback_atmux_task_add_lost_epic_story_deliverable_flags` 2026-05-20); planners can only embed the epic id in the subject. Impact on Phase 3: the §D1 step-1 fallback to `tasks.epic` column ALSO returns `null`, so the handler would emit `skipped-no-epic` for EVERY `task.done` in practice — Phase 3 ships dead code. Resolution: T1 (`src/core/orchd-merge.ts`, t-b235b1be) MUST include a subject-prefix parser as the final fallback in `resolveEpicId` — regex `/\[e-([0-9a-f]+)\b/` against `tasks.subject` (epic-id charset is hex per ADR-058). Follow-up Tasks (separate, lower priority): (a) restore `atmux task add --epic` flag, (b) backfill `tasks.epic` for historic subject-prefix tasks. T1 should NOT block on (a) or (b) — the prefix parser is the load-bearing fix. Reversibility: low (parser is one regex + 4 lines of code). **Decided-by**: be-1 verification; surface to planner as a binding scope-addition to T1.

## Decision-anchors

> **§DA1** — Topic `task.done` reused (no taxonomy amendment for trigger). New topics `epic.merged` + `epic.merge-blocked` ADDED for downstream (Phase 4 consumer + operator-observability). ADR-203 §D2 amended in T1's same commit.
>
> **§DA2** — Module surface = exact mirror of `src/core/gitter-consumer.ts::gitterConsume`. Same `withIdempotency` wrapper, same stubbed-default-with-injected-resolver pattern, same Honker kill-switch short-circuit. Operators learn one shape, not two.
>
> **§DA3** — Cron backstop (`atmux epic-merge tick`) STAYS installed 2 weeks post-ship per ADR-202 §X. Decommission CHANGELOG entry filed in T1's same commit; removal in a follow-up Task gated on operator dogfood verification.
>
> **§DA4** — Cross-team seam ownership: `src/core/orchd-merge.ts` = this EPIC. `src/verbs/orchd.ts` = sibling EPIC `e-60e16169`. Seam shape pinned by §D5 + factory pattern; sibling integrates via single import + single call site.
>
> **§DA5 (2026-05-23, t-05f368d6)** — `TaskDonePayload.epicId` schema unchanged (already optional per `src/schema/events.ts:60`); resolver in T1 is **three-stage** (payload → `tasks.epic` column → `[e-XXXXX]` subject-prefix regex). Subject-prefix fallback is load-bearing TODAY because `tasks.epic` is universally `NULL` until `atmux task add --epic` is restored (memory `feedback_atmux_task_add_lost_epic_story_deliverable_flags`). See §OQ2 + §OQ4 resolutions.

## §Amendment 2026-05-23 — Reviewer-pass (t-cd2c3c42)

Status flipped `proposed → accepted` after reviewer audit of commit `89fcab8` (T1 module impl) against §D1-§D5 + §DA1-§DA5. Three impl-doc parity patches landed in the same commit as the status flip:

1. §D2 payload field names corrected `mergedAt` → `mergedAtSec`, `blockedAt` → `blockedAtSec` to match ADR-203 §D2 entries + the actual emitted shape in `src/core/orchd-merge.ts:244-263` (impl + ADR-203 already use the `*Sec` suffix; §D2 here was the outlier).
2. §D5 `AutoMergeOutcome` union added `"skipped-not-mine"` literal — impl exports 7 variants (`src/core/orchd-merge.ts:57-64`) since the dispatcher-stub passes its `skipped-not-mine` state through as a handler-visible outcome; the ADR §D5 example mistakenly listed only 6.
3. Reviewer-pass audit verdict appended here so future readers see the doc-impl parity history.

Cumulative diff audit:
- Seam shape: exact mirror of `gitter-consumer.ts` confirmed (`withIdempotency` + Honker kill-switch + injected-handler default).
- Test coverage: 62 unit tests across 5 describe blocks (resolver 3-stage, completeness query, handler 6 outcomes, kill-switch, happy-path, failure-mode).
- Schema parity: `EpicMergedPayload` + `EpicMergeBlockedPayload` added to `src/schema/events.ts` discriminated union + TOPICS list (40 → 42).
- Cross-team seam (sibling EPIC `e-60e16169`): `createAutoMergeHandler` factory + `orchdMergeConsume` consumer = single import + single call-site integration. No reach into module internals required.

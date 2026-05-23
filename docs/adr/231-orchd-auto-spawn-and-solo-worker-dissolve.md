# ADR-231: orchd auto-spawn + solo-worker dissolve loop semantics — Honker consumer of ADR-224 §D6 registry + ADR-225 eligibility substrate

**Status**: proposed (deferred: implementation lands across e-60e16169 Phase 2 tasks under Epic e-1-118d16a9; status flips to `accepted` at reviewer trunk-signoff per the standard ADR lifecycle for this team)
**Date**: 2026-05-23
**Renumber note (2026-05-23 14:00 MYT)**: this ADR was originally committed as ADR-226 at 029ae9c (P2.T1 on branch atmux-geoyws-epic-e-60e16169). Renumbered to ADR-231 after parent trunk's ADR-226 ('orchd auto-merge subscriber', Phase 3 of sibling EPIC e-a946af69) shipped concurrently at trunk commit 8d75360 (0.8.13 deployed 2026-05-23). Driver-confirmed reconcile via planner OQ-PLANNER1 (Option A): renumber + merge parent base + cross-ref sweep. Parent trunk now reserves 224 (rename/Phase1+2 frame) / 225 (deps+isReady substrate) / 226 (auto-merge P3) / 227 (auto-dissolve P4) / 228 (spawn-queue+pressure-monitor P5) / 229 (auto-push) / 230 (cockpit-mirror); 231 is the next free slot.
**Driver-ref**: EPIC e-60e16169 Phase 2 (master design-task t-10d9f702 in parent atmux kanban; OQ-PLANNER1 reconcile resolution 2026-05-23 14:00 MYT via lead-outbox). Split decision per ADR-224 §D4 heuristic: §Phase 2 introduced a new top-level concept (consumption pattern for sibling ADR-225's eligibility substrate) AND the per-decision narrative is cleaner in two ADRs than one. ADR-225 (sibling EPIC e-cf8a6195, accepted) became available on trunk via commit 4870833 — making it possible to write this consumer ADR concretely instead of speculatively. Title sharpened from "auto-spawn + auto-dissolve" to "auto-spawn + solo-worker dissolve" to disambiguate from parent's ADR-227 (Phase 4 'orchd auto-dissolve epic-team subscriber') which dissolves epic-teams on `epic.merged` — distinct from this ADR's `task.done`-triggered solo-worker dissolve (closes ADR-221 §Phase 2).
**Cross-refs**: [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) §D6 (Subscription registry seam — this ADR's consumer plugs into ORCHD_SUBSCRIPTIONS), [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) §D4 (Phase 2 forward-ref — superseded by THIS ADR's §D1–§D7), [ADR-225](225-epic-dependencies-and-is-ready-toggle.md) (epic dependencies + is_ready substrate — this ADR's primary eligibility source; consumes the `epicIsEligible()` predicate + `epic.ready` / `epic.unblocked` events verbatim), [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker substrate — orchd's event source), [ADR-203](203-event-topic-taxonomy.md) §D2 (closed v1 topic set — sibling ADR-225 already amended to add `epic.ready` + `epic.unblocked`; this ADR adds no new topics), [ADR-090](090-epic-team-lifecycle.md) (`atmux team spawn-epic` — orchd's RPC target, already integrates ADR-225's eligibility predicate per ADR-225 §"Eligibility consumers"), [ADR-091](091-kanban-driven-auto-merge.md) (kanban-driven auto-merge — adjacent state-machine pattern), [ADR-134](134-in-team-auto-merger.md) §Triggers (event-driven + cron-backstop two-trigger pattern — this ADR's §D4 mirrors it exactly), [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-wide cap — this ADR's §D5 transient-carve-out), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) (claude account pool — orchd-spawned epic-teams consume the pool), [ADR-221](221-solo-worker-scope.md) §Phase 2 (solo-worker v2 close-out — this ADR's §D6 task.done dissolve handler closes it).

## Context

Phase 2 of EPIC e-60e16169 is the orchestration loop on top of two substrates that landed independently:

1. **ADR-224 §D6 Subscription registry seam** (shipped Phase 1 — `src/core/orchd-registry.ts` with `OrchdSubscription` interface + empty `ORCHD_SUBSCRIPTIONS` array). The seam is plug-shaped; handlers register by appending to the array.
2. **ADR-225 epic dependencies + is_ready substrate** (sibling EPIC e-cf8a6195, accepted, merged to parent trunk at commit 4870833). Provides `depends_on` JSON-array column, `is_ready` INTEGER boolean column, `epicIsEligible(id)` predicate, `epic.ready` event (0→1 transition), `epic.unblocked` event (last-dep-cleared transition), and pre-existing integration of the predicate into `atmux team spawn-epic --force` refusal logic.

Phase 2 is the **consumer** that glues these two together with three additional concerns:

- **autoSpawn opt-in** — per-epic config in `epics.extra.autoSpawn` plus per-team defaults in `team.json::autoSpawn.defaults`. ADR-225's `is_ready=1` is operator authorization to *spawn at all*; `autoSpawn=true` is operator authorization to *let orchd do it automatically without manual `atmux team spawn-epic` keystroke*.
- **Dedup** — `epics.spawned_at` Unix-epoch timestamp column (migration v15→v16, sequenced after ADR-228 spawn_queue v14→v15 + ADR-225 deps/is_ready v13→v14; renumbered from the original v14→v15 at impl time, t-6-8db78adf, since the spawn_queue migration claimed v14→v15 at sibling EPIC e-a946af69 fan-in 8d75360). orchd skips epics where IS NOT NULL.
- **Failure recovery** — operator-visible flag emission for spawn failures, with a host-pressure transient carve-out (ADR-184 cap refusal is not a real failure, just defer).

The original Phase 2 sketch in ADR-224 §D4 specified `epic.added` as the trigger. **Sibling ADR-225 makes this obsolete**: `epic.added` fires on decomposition land (epic may not be ready); `epic.ready` + `epic.unblocked` fire on the actual eligibility transition. Using the ADR-225 events avoids a race window where orchd would otherwise spawn-epic an epic whose `is_ready=0` (and waste a spawn-epic invocation on the predicate refusal). This ADR adopts the ADR-225 events as the canonical triggers.

solo-worker v2 auto-dissolve (ADR-221 §Phase 2) is folded into orchd because the same daemon already owns Honker subscriptions + dispatch lifecycle — adding a `task.done` subscriber to the existing registry is a thinner footprint than a separate daemon.

## Decision

### D1 — Subscribe to `epic.ready` AND `epic.unblocked` (NOT `epic.added`)

Two `ORCHD_SUBSCRIPTIONS` entries register the spawn handler:

```ts
// src/core/orchd-registry.ts — Phase 2 appends to ORCHD_SUBSCRIPTIONS
{ topic: "epic.ready",     consumerId: "atmux:orchd:spawn:on-ready",     handler: spawnEpicHandler },
{ topic: "epic.unblocked", consumerId: "atmux:orchd:spawn:on-unblocked", handler: spawnEpicHandler },
```

Distinct `consumerId`s for the same handler keep Honker per-consumer offsets isolated — a missed wake on `epic.ready` does not stall `epic.unblocked` delivery, and vice versa. Both events route to the same `spawnEpicHandler` because the eligibility join (`is_ready=1 AND all deps done`) is the same downstream check regardless of which side flipped.

**Why not `epic.added`**: `epic.added` fires on decomposition completion, which may be hours or days before the operator flips `is_ready=1`. Subscribing to `epic.added` would cause orchd to invoke spawn-epic immediately + receive the eligibility refusal + flag-or-no-op + wait — wasted work on every newly-decomposed epic. Subscribing to `epic.ready` + `epic.unblocked` aligns orchd's wake with the eligibility transition.

### D2 — `spawnEpicHandler` algorithm

On wake (event payload contains `epicId`):

1. Load epic via `KanbanEpic.findById(epicId)`. If row missing (race-deleted), exit silently.
2. **Dedup gate**: if `epic.spawned_at IS NOT NULL`, exit silently (already spawned; at-least-once delivery covered).
3. **autoSpawn gate**: resolve `effectiveAutoSpawn(epic)` = per-epic `extra.autoSpawn.enabled` (explicit win) OR first matching `team.json::autoSpawn.defaults[].match` regex against `epic.title` (per-team policy). If `false`, exit silently.
4. **Eligibility gate**: call `epicIsEligible(atmuxDir, epicId)` from ADR-225. If `eligible=false`, exit silently (operator's `is_ready=0` is intentional; deps may not be done yet — let the next `epic.ready` or `epic.unblocked` event re-fire when conditions change).
5. **Spawn**: invoke `atmux team spawn-epic --epic <eid> --roster <resolved-roster>` as a subprocess. Roster resolves to per-epic `extra.autoSpawn.roster` OR per-team default OR `default` literal.
6. **Result**:
   - Exit 0 → `UPDATE epics SET spawned_at = unixepoch() WHERE id = ?`. orchd done; epic-team is now live + dispatching itself.
   - Exit non-zero with stderr matching ADR-184 host-pressure-refusal signature → **TRANSIENT**. Leave `spawned_at=NULL`. Increment `epic.extra.spawnPressureDeferred` counter. If counter ≥3 across consecutive attempts, emit `host-pressure-deferred` flag. Cron `--sweep` (§D4) will re-attempt.
   - Exit non-zero otherwise → `UPDATE epics SET extra = json_set(extra, '$.spawnFailed', json_object('at', unixepoch(), 'stderrTail', ?))` AND `atmux flag add "orchd: spawn failed for epic <eid>: <stderrTail>"`. NO retry — operator triages via flag.

### D3 — autoSpawn config home

**Per-epic** (`epics.extra.autoSpawn` JSON object):

```ts
type AutoSpawnConfig = {
  enabled: boolean;
  roster?: string;        // e.g. "solo", "backend-heavy"; falls back to per-team default then "default"
  forceSpawn?: boolean;   // pass --force to atmux team spawn-epic (bypass ADR-225 predicate)
};
```

Set via `atmux epic add --auto-spawn [--roster solo] [--force-spawn]` flags (Phase 2 P2.T3 lands the flags) — the flags populate `extra.autoSpawn`. Zod validation in `src/schema/kanban.ts` extends the passthrough `extra` slot with this typed sub-shape.

**Per-team** (`team.json::autoSpawn.defaults[]` array):

```ts
type AutoSpawnDefault = {
  match: string;          // regex source string, compiled at read with `new RegExp(match)`
  roster: string;
  autoSpawn: true;        // literal true (entries imply opt-in by inclusion)
  forceSpawn?: boolean;
};
```

Resolution precedence: per-epic explicit `enabled` wins (true OR false — explicit false disables even if per-team would match). If per-epic is absent, first matching `defaults[]` entry wins. If no match, default off.

**Why explicit-false per-epic wins**: prevents a per-team default from auto-spawning an epic where the operator explicitly typed `--no-auto-spawn` (planned flag for the inverse case).

### D4 — Two-trigger model: event-driven primary + cron `--sweep` backstop

Mirrors ADR-134 §Triggers two-trigger pattern verbatim.

**Event-driven primary**: ADR-225 emits `epic.ready` or `epic.unblocked` on the relevant transition. orchd wakes within ~1s of the Honker NOTIFY (per ADR-202 §Context latency table). Spawn handler fires; epic-team is live within seconds.

**Cron `--sweep` backstop**: `atmux orchd --sweep` (single-shot subcommand, no daemon loop) walks the kanban every 5min by default (cron-managed via sandwich-marker block per ADR-026):

```ts
// pseudocode for orchd --sweep
for (const epic of KanbanEpic.findAll()) {
  if (epic.spawned_at !== null) continue;                 // already spawned
  if (!effectiveAutoSpawn(epic)) continue;                // operator not opted in
  const eligibility = epicIsEligible(atmuxDir, epic.id);
  if (!eligibility.eligible) continue;                    // ADR-225 says no
  spawnEpicHandler({ epicId: epic.id });                  // reuse handler, NOT duplicate logic
}
for (const member of resolveSoloWorkerMembers()) {
  if (allTasksDone(member)) dissolveSoloWorkerHandler({ member });
}
```

**Why both, not one**:

- Event-only: vulnerable to Honker socket churn, NOTIFY/LISTEN gaps, orchd restarts that lose in-flight wakes.
- Cron-only: imposes a 5min latency floor on every spawn — feels sluggish + masks Honker substrate value.
- Both: ~1s typical (event), ≤5min worst-case (sweep). Resilience + low-latency.

**Sweep cadence configurability** (resolves OQ-C from ADR-224): default `*/5 * * * *` cron line. `team.json::autoSpawn.sweepCron` overrides per-team if operator needs faster cadence (e.g. demo prep). Sandwich-marker block re-emits the configured value on `atmux start`.

### D5 — Failure recovery: mark + emit flag; transient carve-out for ADR-184 host-pressure

OQ4 resolution (per `.atmux/decisions.md` D4). Three classes:

| Class | Detection | Action |
|---|---|---|
| **Hard failure** (invalid roster, malformed args, spawn-epic crashed) | exit non-zero + stderr does NOT match host-pressure signature | `epics.extra.spawnFailed = { at, stderrTail }` + `atmux flag add` + NO retry |
| **Transient — host-pressure** | exit non-zero + stderr matches ADR-184 refusal signature (`/host-wide cap (\d+) reached/`) | Increment `epics.extra.spawnPressureDeferred` counter; leave `spawned_at=NULL`; cron `--sweep` retries; if counter ≥3 emit `host-pressure-deferred` flag (separate from spawnFailed; operator triages differently — "wait for capacity" vs "fix my config") |
| **Transient — eligibility race** | exit non-zero + stderr matches ADR-225 refusal signature (`/eligible=false: /`) | Exit silently. Next `epic.ready` / `epic.unblocked` event re-fires the handler. Common case: operator flipped `is_ready=1` then immediately flipped `is_ready=0` — race window collapses on next operator action. |

**Why no exponential backoff**: ADR-132 §Amendment sentinel-cron-deprecation lesson — retry storms hide root causes. Operator-visible flag beats silent retry every time.

**Why a separate host-pressure-deferred flag**: operator triage diverges. Hard failure = "look at the config / fix something". host-pressure = "wait for capacity OR raise the cap". Conflating them confuses the operator interrupt model.

### D6 — `dissolveSoloWorkerHandler` — task.done subscriber, closes ADR-221 §Phase 2

`ORCHD_SUBSCRIPTIONS` append:

```ts
{ topic: "task.done", consumerId: "atmux:orchd:dissolve-worker", handler: dissolveSoloWorkerHandler },
```

**IMPORTANT**: sibling EPIC e-a946af69 Phase 3 (auto-merge) ALSO subscribes to `task.done` with consumerId `atmux:orchd:auto-merge`. Honker per-consumer offsets isolate the two. Different handler, different offset, no coordination required beyond consumerId namespace discipline.

Algorithm:

1. Load task via `KanbanTask.findById(taskId)`. If row missing (race-deleted), exit silently.
2. Resolve the task's owning member's team scope. If the member is NOT in a solo-worker-spawned team (per ADR-221 §D-solo-worker-classifier — implementation detail, lives in `src/core/solo-worker.ts`), exit silently.
3. If solo-worker AND `KanbanTask.findAllByOwner(member).filter(t => t.status !== 'done').length > 0`, exit silently (pending work).
4. If solo-worker AND ALL their tasks are done, invoke `atmux team stop --team <worker-team-name>` to dissolve.
5. Failure: emit flag `orchd: dissolve failed for worker-team <name>: <stderrTail>`. No retry (mirrors §D5).

Idempotency: re-delivery is no-op. `atmux team stop` is idempotent per ADR-090 (second invocation on already-stopped team is a clean no-op). Honker offset advance only on handler-success ensures re-delivery happens if the handler throws.

### D7 — Implementation file layout (handler-as-data; orchd.ts stays thin)

| File | Responsibility |
|---|---|
| `src/verbs/orchd.ts` | CLI entrypoint: `--start` (daemon loop iterating ORCHD_SUBSCRIPTIONS), `--drain` (one-pass + exit), `--sweep` (cron backstop entrypoint). No handler logic. |
| `src/core/orchd-registry.ts` | `OrchdSubscription` interface + `ORCHD_SUBSCRIPTIONS` array. Phase 2 appends 3 entries (2 spawn-triggers + 1 dissolve). |
| `src/core/orchd-spawn.ts` | `spawnEpicHandler` + `effectiveAutoSpawn` + host-pressure classifier. |
| `src/core/orchd-dissolve.ts` | `dissolveSoloWorkerHandler`. |
| `src/core/orchd-sweep.ts` | `--sweep` walker. Imports + reuses handlers from orchd-spawn.ts + orchd-dissolve.ts (NOT duplicate logic). |
| `src/abstractions/sqlite-migrations.ts` | Migration v15→v16: `ALTER TABLE epics ADD COLUMN spawned_at INTEGER`. (Renumbered from v14→v15 at impl time, t-6-8db78adf, since ADR-228 spawn_queue claimed v14→v15 at sibling EPIC e-a946af69 fan-in 8d75360.) |
| `src/schema/kanban.ts` | Extend `KanbanEpic.extra.autoSpawn` Zod sub-shape; add `spawnedAt: z.number().nullable().optional()`. (Do NOT touch `dependsOn` / `isReady` — those are ADR-225 territory.) |
| `src/schema/team.ts` (or wherever team.json is parsed) | Add `autoSpawn.defaults[]` + `autoSpawn.sweepCron` Zod shape. |
| `src/verbs/epic.ts` | Add `--auto-spawn` / `--roster` / `--force-spawn` flags to `atmux epic add`. |

orchd.ts remains <100 LOC after Phase 2 (the handlers ARE the substance; orchd.ts is the dispatcher). This is the same layout pattern sibling EPIC e-a946af69 Phases 3-5 will follow (their handlers in `src/core/orchd-auto-merge.ts`, `orchd-auto-dissolve.ts`, `orchd-spawn-throttle.ts` — appending to ORCHD_SUBSCRIPTIONS without editing orchd.ts).

## Consequences

**What changes** (relative to ADR-224 §D4 forward-ref):

- Trigger topics revised: `epic.added` (original sketch) → `epic.ready` + `epic.unblocked` (this ADR). Aligns with ADR-225 eligibility model; no wasted spawn-epic invocations on un-ready epics.
- `epicIsEligible()` predicate (ADR-225 export) becomes a hard dependency. orchd no longer carries cycle-detection or dep-walking logic — defers entirely to ADR-225's predicate.
- New `spawned_at` migration sequenced AFTER both ADR-225's v13→v14 (deps + is_ready) AND ADR-228's v14→v15 (spawn_queue, sibling EPIC e-a946af69 fan-in 8d75360); this lands as v15→v16. Renumbered from the original v14→v15 at impl time (t-6-8db78adf) per ADR-126 §single-ladder append-only invariant.
- Failure recovery model gains 3-way classification: hard / host-pressure / eligibility-race. The eligibility-race class is silent (let next event re-fire); host-pressure has its own flag distinct from hard-failure flag.

**What workers see**:

- BE lane (Phase 2 tasks): 4 new files in `src/core/` (spawn / dissolve / sweep + registry already from Phase 1), 1 migration step, 1 Zod schema extension, 3 new `epic add` flags.
- OPS lane: cron sandwich-marker block grows by one line (`*/5 * * * * cd <atmux-dir> && atmux orchd --sweep`).
- TEST lane: handler unit tests + integration test exercising the trigger matrix (event-only / cron-only / both-fire / dedup-race / eligibility-race / host-pressure-deferred / hard-failure).
- DOC lane: ADR-224 §D4 amended to forward-ref THIS ADR (no more "forthcoming"); CHANGELOG entry for Phase 2 ship.

**What breaks**:

Nothing. Phase 1 shipped behind no-behavior-change posture; Phase 2 ships behind opt-in (autoSpawn=false default) — no existing epic gets auto-spawned without explicit per-epic OR per-team opt-in. Operators continue running `atmux team spawn-epic` manually for epics where autoSpawn=false.

**What we give up**:

- Handler complexity in `src/core/orchd-spawn.ts` vs the "ship-it-thin" alternative of always-spawning-and-letting-spawn-epic-refuse. The thin alternative would burn a spawn-epic subprocess per epic.ready event regardless of dedup — measurably more expensive at scale.

**Rollback path**:

Per-handler kill-switch via the registry: remove entries from `ORCHD_SUBSCRIPTIONS` + restart orchd → falls back to relay-only behavior. Hot rollback per-handler does NOT exist (no in-process toggle) — full-process restart is required. This is acceptable because the trade-off lives in §D4 of ADR-202 (substrate kill-switch is per-process not per-runtime-flag).

Schema rollback: `epics.spawned_at` column stays in place (additive migration per ADR-126); handler skips it once disabled. No data loss.

## Open questions

1. **OQ-1 (carry-forward from ADR-224 OQ-B): deprecation alias `atmux relayd` survives one release or two?** — default 1 release; reviewer may extend at Phase 1 trunk-signoff time. Status: deferred to Phase 1 reviewer decision.
2. **OQ-2: should `autoSpawn.defaults[]` per-team policy support negative-match (regex match → DISABLE auto-spawn for matched titles)?** — punted. Default: only positive matches in v1. If operator surfaces a use case (e.g. "match `[do-not-spawn]` title prefix to disable"), file an amendment Task. Status: deferred until operator demand.
3. **OQ-3: should `spawnPressureDeferred` counter reset to 0 on successful spawn-epic?** — lean: yes (counter is "consecutive failures"; success resets). Resolve at P2.T4 (`t-13acce38`) impl time. Status: deferred to implementation review.
4. **OQ-4: should orchd emit its own observability events (`orchd.spawn_attempted`, `orchd.spawn_succeeded`, `orchd.spawn_failed`) for cockpit-mirror consumption?** — deferred. ADR-203 §D2 closed v1 topic set; adding orchd-domain topics needs its own ADR amendment per the same gate ADR-225 §"Events" used. Punt until sibling EPIC e-a946af69 Phase 5 (throttle) lands and the throttle layer needs the visibility. Status: deferred to sibling EPIC.

Resolve OQ-1 + OQ-3 before flipping `Status: accepted`. OQ-2 + OQ-4 may flip to `Status: accepted` while deferred (low-rev; explicit "we'll decide when it matters").

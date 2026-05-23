# ADR-228: orchd spawn queue + pressure-monitor loop (Phase 5) — refuse → enqueue → drain on load drop

**Status**: accepted
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban Epic `e-a946af69` ("orchd lifecycle Phase 3-5") + driver-inbox 08:27 MYT 2026-05-23 (lead relay)
**Parent EPIC (this team)**: `e-a946af69` (orchd Phase 3-5)
**Substrate**: [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-wide epic-team cap + queue + dormancy audit) + [`src/core/host-pressure.ts`](../../src/core/host-pressure.ts) (load/RAM probe).
**Sibling cross-refs**: [ADR-090](090-epic-team-lifecycle.md) (spawn-epic verb), [ADR-202](202-honker-in-db-messaging-substrate.md) §X (cron decommission protocol), [ADR-203](203-event-topic-taxonomy.md) (topic taxonomy).

## Context

### Today's behavior

`atmux team spawn-epic` runs a host-pressure pre-check (per [`src/core/host-pressure.ts`](../../src/core/host-pressure.ts)). On over-threshold it throws `ConfigError` with formatted reasons:

```
host under pressure — refusing spawn:
  - load 15min 9.20 > 6.00 (8 cores × 0.75)
  - MemAvailable 7800MB < 8192MB threshold
```

The operator's only recourse is **manual retry** — eyeball `top`, wait for load to drop, re-run `spawn-epic`. In practice this fails three ways:

1. **Operator forgets**, the EPIC sits in driver-inbox indefinitely.
2. **Multiple operators spawning concurrently** (or operator-initiated batch-from-CLI) all hit the gate, all retry at once, all collide again.
3. **Load drops at 3am**, operator is asleep, spawn window passes.

### What ADR-184 already covers — what's still missing

[ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) shipped a **host-cap queue** (`~/.atmux/state/host-registry.json`, JSON+flock, cap=8) that addresses **count-based** over-spawn (too many concurrent epic-teams alive). The queue triggers on `live.length ≥ hostCap` with explicit `--queue` flag.

What's missing is **load/RAM-pressure** queuing — the dimension `host-pressure.ts` already gates. ADR-184's queue does NOT cover this case; spawning when `live.length < hostCap` but `load > threshold` still throws `ConfigError` with no queueing. Phase 5 closes this gap.

### Why orchd is the right owner

orchd is the only per-team daemon with a long-running event loop (Phase 1+2 substrate `e-60e16169`). The pressure-monitor wake-on-load-drop pattern is naturally a daemon loop — periodic `probeHostPressure()` check, conditional drain. Putting this in a cron tick (every N minutes) wastes the daemon's already-running event loop. Putting it in the spawn-epic verb itself isn't viable: the verb is short-lived; there's no "wait for load to drop and retry" loop a one-shot verb can run without blocking the operator's terminal.

## Decision

### §D1 — Refuse-then-queue path

Modify `atmux team spawn-epic`'s host-pressure gate flow:

```
spawn-epic <eid>:
  1. probe host pressure
  2. if verdict.ok → spawn (today's behavior)
  3. if !verdict.ok:
     3a. if --no-queue flag passed → throw ConfigError (today's behavior, escape hatch)
     3b. if queue admission test fails (queue full, see §D3) → throw ConfigError with "queue full" reason
     3c. otherwise → INSERT row in spawn_queue → emit `epic.spawn-queued` event → exit cleanly with operator hint:
         "host pressure too high — queued <queueId> (queue depth N/M).
         orchd will retry when load drops. Override with --no-queue."
```

Default is queue-on-pressure. Operators wanting the old refuse-immediately behavior pass `--no-queue`.

### §D2 — `spawn_queue` table (per-team state.db)

NEW SQLite migration in `src/abstractions/sqlite-migrations.ts`. Version slot: **next available** (currently tip is v12→v13 per `prune_state`; sibling EPIC `e-cf8a6195` deps+isReady may consume v13→v14 first — this migration claims `v(N)→v(N+1)` where N is determined at fan-in; the migration object is written but the from/to integers are set at fan-in alignment per [ADR-091 §pre-flag #4](091-kanban-driven-auto-merge.md) committer-side renumber pattern, to avoid pre-claiming numbers).

Schema:

```sql
CREATE TABLE spawn_queue (
  queue_id TEXT PRIMARY KEY,              -- q-<8 hex>; matches ADR-184 §queueId regex
  epic_id TEXT NOT NULL,                  -- the epic being spawned; e-<id>
  spawn_args TEXT NOT NULL,               -- JSON-encoded full argv to replay on dequeue
  queued_at_sec INTEGER NOT NULL,         -- unix seconds (test-clock injectable)
  queued_by TEXT NOT NULL,                -- requester identity (member/driver)
  priority INTEGER NOT NULL DEFAULT 5,    -- 1-5 (1=highest); FIFO within same priority
  attempts INTEGER NOT NULL DEFAULT 0,    -- drain re-attempts; abandoned after MAX_ATTEMPTS
  last_attempt_at_sec INTEGER,            -- null until first drain attempt
  last_failure_reason TEXT,               -- null on success path; populated on drain failure
  state TEXT NOT NULL DEFAULT 'queued'    -- queued | spawning | abandoned
    CHECK (state IN ('queued','spawning','abandoned'))
);

CREATE INDEX idx_spawn_queue_priority_queued
  ON spawn_queue(state, priority, queued_at_sec);
```

**Why per-team state.db (not cockpit ~/.atmux/state/host-registry.json):**
- Per-team scope matches orchd's daemon scope (one orchd per team consumes the team's spawn_queue).
- SQLite gives us `BEGIN IMMEDIATE` serialization for free — no JSON+flock fragility (memory `project_merger_state_merged_terminal_design_gap` documents the flock race class).
- The `~/.atmux/state/host-registry.json` queue is **cockpit-level** + **count-cap-dimensional** — different scope + different gating dimension. Two queues, two responsibilities, both legitimate. The reviewer may push back here (see §OQ1 below); the deferred response is "merge in v2 if dogfood reveals duplication."

### §D3 — Admission test + bounded queue

```ts
// in src/core/spawn-queue.ts
export interface SpawnQueueLimits {
  maxDepth: number;        // env ATMUX_SPAWN_QUEUE_MAX_DEPTH; default 20
  maxAttempts: number;     // env ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS; default 5
  pressureCheckIntervalSec: number; // cockpit.json::spawnQueue.checkIntervalSec; default 60
}

export interface AdmissionVerdict {
  admitted: boolean;
  reason: string | null;  // null when admitted; populated with refusal reason otherwise
}

export function admit(db: Database, limits: SpawnQueueLimits): AdmissionVerdict;
```

Refusal modes:
- `"queue full: depth N ≥ maxDepth M"` → operator gets ConfigError with hint to wait + the current depth.
- `"epic already queued: <queueId>"` → operator gets ConfigError (idempotent surface; the same epic can't double-queue).

### §D4 — Pressure-monitor loop

orchd's daemon loop wakes every `checkIntervalSec` seconds (default 60s) and runs:

```ts
// in src/core/spawn-queue.ts
export interface PressureMonitorTickDeps {
  db: Database;
  probeHostPressure: () => Promise<HostPressureVerdict>;
  spawnEpic: (args: string[]) => Promise<{success: boolean; reason?: string}>;
  limits: SpawnQueueLimits;
  nowSec?: () => number;
  logger?: Logger;
}

export async function pressureMonitorTick(
  deps: PressureMonitorTickDeps,
): Promise<{drained: number; remaining: number; verdict: HostPressureVerdict}>;
```

Tick logic:

1. Probe host pressure. If `!verdict.ok` → log + return `{drained: 0, remaining: <queue depth>, verdict}`. Try again next tick.
2. If `verdict.ok` → select next row by `(priority ASC, queued_at_sec ASC)` where `state='queued' AND attempts < maxAttempts`. Mark `state='spawning'` via `BEGIN IMMEDIATE`.
3. Replay `spawn_args` through `spawnEpic` dispatcher.
4. Per outcome:
   - success → DELETE row; emit `epic.added` event (which Phase 2 auto-spawn already consumes per `e-60e16169`); log + continue (drain one per tick to spread load).
   - failure → set `state='queued'`, `attempts += 1`, `last_attempt_at_sec = now`, `last_failure_reason = err.msg`. If `attempts >= maxAttempts` → `state='abandoned'` + emit `epic.spawn-abandoned` (operator-observable, no consumer in v1).
   - throw → idempotency wrapper catches; row stays `spawning` until next tick re-checks (the `BEGIN IMMEDIATE` re-acquires).
5. Return totals.

**Drain-one-per-tick:** intentional throttle. A flag-day operator dump of 50 queued epics shouldn't all-spawn at once the moment load drops — that re-trips the pressure gate within 1-2 ticks. One per tick lets the load probe re-evaluate between dequeues.

### §D5 — Topic taxonomy amendments (ADR-203 §D2)

Three new topics added to ADR-203 §D2 in same commit as T9:

- `epic.spawn-queued` — fires on enqueue. Payload: `{topic, queueId, epicId, queuedBy, queuedAtSec, depth}`. Operator-observable in cockpit-mirror feed (ADR-219).
- `epic.spawn-abandoned` — fires when attempts exhaust. Payload: `{topic, queueId, epicId, attempts, lastFailureReason}`. Operator must inspect manually.
- `epic.added` — fires on successful drain (sibling EPIC `e-60e16169` Phase 2 ALREADY consumes this for auto-spawn). Per reviewer-pass grep 2026-05-23, `epic.added` is **NOT** present in ADR-203 §D2 v1 topic set (only `epic.spawn-blocked` lives there for the spawn family); this ADR's T9 amendment ADDS it alongside the two new topics above.

Note: `epic.spawn-blocked` is already in ADR-203 §D2 v1 topic list — it's distinct from `epic.spawn-queued` here; the former is "blocked, won't queue" (terminal refusal — ADR-199 D3 cockpit consumer) and the latter is "queued, will retry" (this ADR's mechanism). Both kept for the two distinct surfaces.

### §D6 — Tunables

- **`ATMUX_SPAWN_MAX_LOAD_RATIO`** (env, existing) — load/cores threshold. Default 0.75.
- **`ATMUX_SPAWN_MIN_FREE_MB`** (env, existing) — RAM floor. Default 8192.
- **`ATMUX_SPAWN_QUEUE_MAX_DEPTH`** (env, NEW) — bounded queue. Default 20. Set to 0 to disable queueing (fall back to ConfigError on pressure).
- **`ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS`** (env, NEW) — give up after N drain failures. Default 5. Prevents poison-pill epics from re-trying forever.
- **`cockpit.json::spawnQueue.{maxDepth, checkIntervalSec, maxAttempts}`** (cockpit config, NEW) — cockpit-level defaults that env vars override per-team.

### §D7 — Subscription seam (cross-team contract with `e-60e16169`)

Mirror of ADR-226 §D5 / ADR-227 §D6. Exported by `src/core/spawn-queue.ts`:

```ts
// drain-loop consumer (replaces "consume" since Phase 5 is timer-driven, not topic-driven)
export interface SpawnQueueDrainDeps extends PressureMonitorTickDeps {}
export const SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC = 60;

// orchd daemon imports + invokes per pressureCheckIntervalSec:
// while (running) {
//   await pressureMonitorTick(deps);
//   await sleep(deps.limits.pressureCheckIntervalSec * 1000);
// }
```

Additionally, `src/verbs/team-spawn-epic.ts` gains a thin `enqueueIfPressured` integration point (same module, owned by this EPIC). The verb itself is sibling territory technically, but the **enqueue branch** is this EPIC's logic — separated cleanly via an exported `enqueueIfPressured(db, args, verdict)` helper that the verb's main path calls when `!verdict.ok`. Sibling integrates one call site.

## Consequences

- **Operator no longer babysits spawn timing**. Queue + monitor handle the wait.
- **Two queues coexist** — ADR-184's host-cap JSON queue + this ADR's pressure SQLite queue. Different dimensions, both legitimate. Reviewer may push back (§OQ1); deferred to v2 dogfood.
- **New SQLite migration** — version slot deferred until fan-in (sibling deps EPIC may take v13→v14 first).
- **3 new topics** added to ADR-203 §D2 (`epic.spawn-queued`, `epic.spawn-abandoned`, `epic.added` if not already present).
- **No cron** introduced. The pressure-monitor lives in orchd's daemon loop (Phase 1+2 substrate).
- **Discord pings** via ADR-219 cockpit-mirror — `epic.spawn-queued` at thresholds {depth=3, 5, 10} (mirrors ADR-184 §queue-grew template), `epic.spawn-abandoned` immediately (operator must act).
- **Rollback** — `ATMUX_HONKER=off` disables orchd's loop; spawn-epic falls back to today's throw-on-pressure behavior. The queue table stays in the DB; operators can drain manually with `atmux team spawn-queue drain` (follow-up verb, not v1 scope).
- **Poison-pill protection** — `maxAttempts` cap + `epic.spawn-abandoned` emit prevent infinite-retry storms.

## Open questions

1. **JSON queue (ADR-184) vs SQLite queue (this ADR) — should they merge?** Two queues serving different gating dimensions feels duplicative. **Default**: ship separate. Reasoning: ADR-184's queue is cockpit-scope (cross-team coordination); ours is per-team-scope (orchd's responsibility). Merging requires promoting orchd to cockpit-scope or demoting host-cap queue to per-team — both bigger redesigns than warranted. Reversibility: medium (a v2 EPIC could collapse the two if dogfood shows real friction). **Decided-by**: planner pending reviewer signal.
2. **SQLite migration version — pre-claim v13→v14 or defer to fan-in?** Sibling EPIC `e-cf8a6195` (deps + isReady) is already in flight and may take v13→v14 first. **Default**: write the migration object but leave from/to as placeholders for the fan-in committer to renumber, per [ADR-091 §pre-flag #4](091-kanban-driven-auto-merge.md). Reversibility: low (renumber is mechanical). **Decided-by**: committer at fan-in.
3. **Default `--queue` or `--no-queue`?** This ADR makes queue the default (refuse → enqueue). Operator opts out with `--no-queue` for one-shot scripts that need synchronous failure. **Alternative**: keep refuse as default, require `--queue` to opt in (ADR-184's pattern). **Default chosen**: queue-default. Reasoning: the whole point of Phase 5 is "operator no longer manages spawn timing"; opt-in queue would leave the babysitting cost in place. Reversibility: low (flipped via flag-default flip + one-release deprecation). **Decided-by**: planner; surface to driver via DECISION (high-rev — affects operator UX). **HIGH-REVERSIBILITY**, so will fire `atmux decisions add --reversibility high` with all 4 fields before T9 lands.
4. **Bounded queue cap depth — 20 default, sane?** Pulled from ADR-184 §queue-grew thresholds 10× headroom. **Default**: 20. Reversibility: low (tunable per env). **Decided-by**: planner; will revisit if dogfood shows over/under.
5. **Worker (`w-` prefix) queueing?** Workers spawn with `--roster solo` (ADR-221) — same `spawn-epic` verb. They go through this queue when host is pressured. Same behavior as full epic-teams. **Default**: yes, workers queue. Reversibility: low. **Decided-by**: planner; no special-casing needed.

## Decision-anchors

> **§DA1** — Two queues coexist by design (ADR-184 host-cap JSON queue + this ADR pressure SQLite queue). Different gating dimensions; deferred merge to v2 dogfood per §OQ1.
>
> **§DA2** — Queue lives in **per-team state.db** (not cockpit registry). SQLite `BEGIN IMMEDIATE` serializes drain; no flock fragility.
>
> **§DA3** — Default behavior is **queue on pressure**. Operator opts out with `--no-queue`. HIGH-REV decision; surfaces via `atmux decisions add` before T9 lands.
>
> **§DA4** — Drain throttle is **one-per-tick** to prevent re-trip storms on flag-day batches.
>
> **§DA5** — Poison-pill protection via `maxAttempts` (default 5) + `epic.spawn-abandoned` emit. Operator must inspect abandoned entries manually.
>
> **§DA6** — Cross-team seam: `src/core/spawn-queue.ts` exports `pressureMonitorTick` + `admit` + `enqueueIfPressured`. Sibling EPIC `e-60e16169` integrates daemon loop call site; spawn-epic verb integrates one helper call.

## §Amendment 2026-05-23 — Reviewer-pass (t-25a56d5e)

Status flipped `proposed → accepted`. Three impl-doc parity patches landed in the same commit as the status flip:

1. §D5 `epic.spawn-queued` payload field `queuedAt` → `queuedAtSec` — matches the `*Sec` suffix convention across ADR-203 + ADR-226 §D2 (`mergedAtSec` / `blockedAtSec`) + ADR-227 §D2 (`blockedAtSec` per reviewer-pass `t-e24e9351`). Convention is now uniform across all four lifecycle ADRs.
2. §D5 `epic.added` definitive answer — pre-amendment text said "if not already present, this ADR adds it" (indefinite). Reviewer grep against `docs/adr/203-event-topic-taxonomy.md` confirms `epic.added` is **NOT** in v1 topic set today (only `epic.spawn-blocked` from the spawn family). T9 amendment will ADD it alongside the two new topics. Made definitive.
3. §D2 broken inline link — pre-amendment cited `[feedback memory \`feedback_brief_aspirational_verbs\`](../../README.md)` (text references operator-side memory file; link target points to README.md). Memory files live in operator-personal scope (not tracked in repo), so the link was always going to misdirect. Replaced with the canonical in-repo pointer: [ADR-091 §pre-flag #4](091-kanban-driven-auto-merge.md) which is the actual committer-side renumber pattern this section follows.
4. §D5 first-person voice cleanup — pre-amendment had "(Note: I see `epic.spawn-blocked`...)". ADR house style is third-person; rephrased to plain `Note:` form + made the distinction between `epic.spawn-blocked` (terminal, ADR-199 D3) and `epic.spawn-queued` (this ADR's retryable) explicit.

Audit summary:
- §D1 refuse-then-queue path clean; `--no-queue` escape hatch matches §OQ3 HIGH-REV decision flag (high-rev decision still pending `atmux decisions add` per §OQ3 caveat + memory `feedback_brief_aspirational_verbs` aspirational verb gap). ✅
- §D2 `spawn_queue` table well-scoped (per-team state.db; `BEGIN IMMEDIATE` serialization; state CHECK constraint; (state, priority, queued_at_sec) index for drain ordering). Migration version slot deferred to fan-in committer renumber per ADR-091 §pre-flag #4 — correct pattern. ✅
- §D3 admission test bounded by env-tunable `maxDepth` + `maxAttempts` with sane defaults (20 / 5). Idempotent surface (epic-already-queued refusal). ✅
- §D4 pressure-monitor tick throttled to one-drain-per-tick — explicitly motivated as anti-storm; correct concern. ✅
- §D5 three topics (queued + abandoned + added) — taxonomy additions appropriately scoped; T9 commit ADR-203 §D2 amendment expected. ✅
- §D6 tunables documented with env vars + cockpit.json overrides — cockpit-level defaults are correct scope. ✅
- §D7 cross-team seam mirrors ADR-226 / ADR-227 pattern; sibling EPIC integrates daemon loop + one verb helper call. ✅

Pending T9 impl (`src/core/spawn-queue.ts` + migration + ADR-203 §D2 amendment) will land in a downstream Task; this reviewer-pass scope is doc-only. Reviewer notes the §OQ3 HIGH-REV decision still owes an `atmux decisions add` row at the parent atmux team's `.atmux/decisions.md` (aspirational verb today — operator-direct edit acceptable substitute per memory `feedback_brief_aspirational_verbs`).

## §Amendment 2026-05-23 — Phase 5b impl landed (driver P0 step 4/5)

T9 impl shipped (epic-team `e-a946af69` Story `s-4-1b9d3950`):

- `src/core/spawn-queue.ts` — exports `admit`, `enqueueIfPressured`, `pressureMonitorTick`, `resolveSpawnQueueLimits`, `generateSpawnQueueId`, plus `SPAWN_QUEUE_DEFAULT_{MAX_DEPTH,MAX_ATTEMPTS,TICK_INTERVAL_SEC}` constants. Story AC bumps `maxDepth` default from §D6's 20 to 32 (matches the AC #2 cap test in `s-4-1b9d3950`); other defaults unchanged.
- `src/verbs/team/spawn-epic.ts` — adds `--no-queue` flag + refuse→enqueue branch. Default path opens the parent's `state.db`, calls `enqueueIfPressured`, exits 0 with operator-hint on admission OR `ConfigError` on cap-refusal. `--no-queue` flag matches §OQ3 escape hatch.
- `src/verbs/orchd.ts` — `--start` path installs a `setInterval`-driven loop firing every `limits.pressureCheckIntervalSec` (default 60s per §D6), calling `pressureMonitorTick` with the spawn-epic verb as dispatcher. Loop owns its own `state.db` connection; `unref()` so SIGINT/SIGTERM exit isn't blocked by the timer reference. Cleanup on shutdown via `try/finally` around the daemon delegation.
- `src/schema/events.ts` — three new topics added to `TOPICS` + `EventPayload` discriminated union: `epic.spawn-queued`, `epic.spawn-abandoned`, `epic.added`. Sibling `docs/adr/203-event-topic-taxonomy.md` §D2 §Epic-lifecycle list amended to match.

Tests in `tests/unit/core/spawn-queue.test.ts` — 20 cases across admit / enqueueIfPressured / pressureMonitorTick / resolveSpawnQueueLimits / generateSpawnQueueId; coverage on `src/core/spawn-queue.ts` at 99.45% line / 100% func. The §OQ3 HIGH-REV `atmux decisions add` row is still operator-side homework — pinned forward to S11 (step 5/5 ADR status flips).

Deferred to follow-up (Story s-5 / S11 scope):
- e2e dogfood test (spawn N=40 with cap=32, observe queue saturation + drain on load drop) — too expensive for unit suite; lands as a manual test against a scratch cage.
- Cockpit-mirror Discord template wire for `epic.spawn-queued` depth thresholds (ADR-219 §queue-grew).
- `team.json::spawnQueue.checkIntervalSec` per-team override — today env-only (`ATMUX_SPAWN_QUEUE_TICK_SEC`).

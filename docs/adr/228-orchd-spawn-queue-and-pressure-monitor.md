# ADR-228: orchd spawn queue + pressure-monitor loop (Phase 5)

**Status**: proposed
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban `t-0db3f393` (orchd lifecycle EPIC body — Phase 3+4+5) + EPIC `e-a946af69`
**Sibling ADRs**: [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) (Phase 1+2 — spawn handler this Phase wraps with throttle), [ADR-226](226-orchd-auto-merge-subscriber.md) (Phase 3 — independent merge layer), [ADR-227](227-orchd-auto-dissolve-subscriber.md) (Phase 4 — independent dissolve layer)
**Cross-refs**: [ADR-184](184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (host-pressure gate this Phase queue-ifies rather than refuses), [ADR-202](202-honker-in-db-messaging-substrate.md) (event substrate + state.db tables), [ADR-225](225-epic-dependencies-and-is-ready-toggle.md) §epicIsEligible (spawn gate Phase 5 composes with), [ADR-090](090-epic-team-lifecycle.md) §spawn-epic (target verb)

## Context

ADR-184 ships a host-pressure gate at `atmux team spawn-epic`: refuses with `ConfigError` when load-avg > 0.75 ratio OR free-RAM < `ATMUX_SPAWN_MIN_FREE_MB`. Operator retries manually.

Failure modes today:

1. **Lost spawn intent.** A `task.done` cascade emits `epic.added` → orchd spawn handler (Phase 2) refuses due to pressure → epic never spawns until operator notices. orchd handler returns success (offset advances), so the event is gone.
2. **No queue depth.** Operator can pile a dozen epics with `--auto-spawn` AND have pressure spike halfway through. No-one notices which subset didn't spawn.
3. **No drain signal.** Load drops to 0.30 ratio + 50GB free → no automated process picks up the deferred spawns.

Phase 5 fixes all three with: persistent spawn queue (FIFO with admission test) + pressure-monitor loop in orchd (wakes on load-avg drop + drains the queue).

## Decision

### Schema migration v15→v16 (after Phase 2's v14→v15)

```sql
CREATE TABLE spawn_queue (
  epic_id      TEXT NOT NULL PRIMARY KEY,
  queued_at    INTEGER NOT NULL,
  requested_by TEXT NOT NULL,       -- 'orchd:spawn' (Phase 2 handler) | 'orchd:sweep' (S5 cron) | 'cli' (--force-queue)
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  INTEGER,
  last_attempt_reason TEXT          -- e.g. 'load-avg=0.91' / 'free-mb=4096' / 'queue-depth-cap'
);
CREATE INDEX idx_spawn_queue_queued_at ON spawn_queue (queued_at);
```

### Phase 2 spawn handler — refuse → enqueue refactor

Phase 2's `spawnHandler` (ADR-224 §D6 / EPIC e-60e16169 S3) gains a wrapping layer:

1. Pre-flight: eligibility check (ADR-225 §epicIsEligible — `is_ready=1 AND all deps done AND spawned_at IS NULL`). If fail → skip (out-of-scope for queue).
2. Host-pressure check (ADR-184 thresholds).
3. **If under threshold**: invoke spawn-epic directly. On success → `spawned_at = now`, delete from `spawn_queue` if present. On failure → flag + queue.
4. **If over threshold**: INSERT (or UPDATE) `spawn_queue` row. Emit `epic.spawn_queued` event (operator-observable; ADR-230 cockpit-mirror surfaces it).

### Pressure-monitor loop in orchd

New goroutine-shaped loop in `src/verbs/orchd.ts`:

- Wake every `checkIntervalSec` (default 30s; configurable via `team.json::spawnQueue.checkIntervalSec`).
- Compute current host-pressure (same probe as ADR-184).
- If under threshold AND `spawn_queue` non-empty:
  - SELECT 1 row ordered by `queued_at` ASC.
  - Invoke spawn-epic.
  - On success → delete row + emit `epic.added` (re-fires Phase 2 spawn handler ON the now-spawned epic — handler is idempotent via `spawned_at` check).
  - On failure → `UPDATE spawn_queue SET attempts=attempts+1, last_attempt_at=?, last_attempt_reason=? WHERE epic_id=?`.
- Per-loop dequeue rate: ONE epic per loop tick (avoid pressure spike from concurrent spawns).

### Bounded queue depth

- `ATMUX_SPAWN_QUEUE_MAX_DEPTH` env (default 32); `team.json::spawnQueue.maxDepth` override.
- When `SELECT COUNT(*) FROM spawn_queue >= maxDepth`: refuse enqueue with operator flag (`spawn-queue-saturated`). Epic stays unqueued; operator clears flag (or raises cap) before next spawn-attempt.

### CLI surface

- `atmux orchd queue list [--json]` — list queued epics with attempts + last-attempt reason.
- `atmux orchd queue drain` — one-shot drain attempt (same code path as monitor loop tick; useful for manual recovery after raising cap).
- `atmux orchd queue clear <epic-id>` — operator override to drop an epic from the queue (escape hatch).

## Consequences

### What changes

- **DB lane**: migration v15→v16 (new `spawn_queue` table + index).
- **BE lane**: spawn handler wraps with refuse→enqueue; new pressure-monitor loop; new `atmux orchd queue *` subcommands.
- **OPS lane**: pressure-monitor loop runs inside the orchd daemon process — NO new cron line (orchd is already long-running per ADR-202 §VII).
- **TEST lane**: queue admission matrix (under-cap / at-cap / over-cap); pressure-monitor matrix (queue-empty-noop / queue-non-empty-under-threshold-drain / queue-non-empty-over-threshold-skip); end-to-end (spawn N>maxDepth epics → assert queue cap respected, drain happens as load drops); idempotency (handler re-fire on same epic — no double-spawn).
- **DOC lane**: this ADR + RUNBOOK-orchd.md queue-ops section + ADR-184 §Status amendment noting the queue-ify pivot.

### What breaks

ADR-184's refuse-with-ConfigError shape changes: spawn-attempts via the orchd handler ENQUEUE instead of refusing. Direct CLI invocations of `atmux team spawn-epic` still refuse (unchanged) — the queue is an orchd-handler-only path. Operator scripts that catch `ConfigError` from manual spawn-epic see no change.

### What we give up

Crisp "no" answer for spawn attempts during pressure spikes. Trade-off: persistent intent (queued) beats lost intent (refused + forgotten).

### Rollback path

`team.json::spawnQueue.enabled` (default `true`) — flip to `false` to revert handler to pure refuse-on-pressure behavior. Queue rows can be drained manually or dropped via `queue clear`. Migration is additive; no rollback of schema needed.

## Open questions

1. **OQ-A**: Pressure-monitor check interval — 30s default, OR pegged to whip cadence (5min)? Default: 30s (faster than 5min for operator UX; cheap because no fork — in-daemon loop).
2. **OQ-B**: Queue ordering — strict FIFO (`queued_at`) OR priority-aware (epic.extra.spawnPriority)? Default: FIFO. Priority-aware deferred unless dogfood shows the head-of-queue problem.
3. **OQ-C**: Per-attempt exponential backoff between dequeue tries on the same epic, OR fixed retry on each pressure-drop? Default: fixed retry (each pressure-drop re-attempts head). Backoff overcomplicates the loop; epics that fail consistently are flagged for operator anyway.

Resolve OQ-A, OQ-B, OQ-C before flipping `Status: accepted`. OQ-A is the most likely to need driver override — operator may want longer cadence for cost reasons.

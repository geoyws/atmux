# ADR-226: orchd auto-merge subscriber (Phase 3)

**Status**: proposed
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban `t-0db3f393` (orchd lifecycle EPIC body — Phase 3+4+5) + EPIC `e-a946af69`
**Sibling ADRs**: [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) (Phase 1+2 — registry seam this Phase mounts onto), [ADR-227](227-orchd-auto-dissolve-subscriber.md) (Phase 4 — consumes the `epic.merged` event this handler emits), [ADR-228](228-orchd-spawn-queue-and-pressure-monitor.md) (Phase 5 — independent throttle layer)
**Cross-refs**: [ADR-091](091-kanban-driven-auto-merge.md) (kanban-driven auto-merge state-machine — Phase 3 reuses verbatim; no state-machine churn), [ADR-134](134-in-team-auto-merger.md) §Triggers (two-trigger event + cron-backstop pattern — Phase 3 mirrors), [ADR-182](182-auto-reap-epic-team-on-epic-merge.md) (auto-reap-on-merge emits `epic.merged` — same event-emit surface), [ADR-202](202-honker-in-db-messaging-substrate.md) §IX-A (Honker subscription contract), [ADR-219](219-dissolve-epic-completeness.md) (epic-completeness check semantics — shared predicate)

## Context

Phase 1+2 (ADR-224) lands orchd as the per-team orchestrator daemon with a subscription registry seam (§D6). The seam ships with `task.done` and `epic.added` handlers in Phase 2. Phase 3 adds a SECOND `task.done` subscriber — same topic, distinct `consumerId`, distinct handler — for auto-merge.

Today's auto-merge path is cron-driven: `atmux epic-merge tick` runs every N minutes per ADR-134 §Triggers, walks `merger_state` rows in `ready_to_merge` state, dispatches one at a time. Latency averages half the cron interval; in-flight epics with shipped work wait minutes for a merge that could happen sub-second.

Phase 3's value: cut latency from cron-period to event-period (~1s under Honker NOTIFY/LISTEN). Cron stays as backstop per ADR-134 §Triggers two-trigger pattern.

## Decision

Add ORCHD_SUBSCRIPTIONS entry:

```ts
{
  topic: "task.done",
  consumerId: "atmux:orchd:auto-merge",
  handler: autoMergeHandler,
}
```

**Handler semantics** (`src/core/orchd-auto-merge-handler.ts`, new):

1. Extract `epic` from event payload.
2. If `epic` is null (lane-tick task with no epic) → skip.
3. Query: `SELECT COUNT(*) FROM tasks WHERE epic=? AND status NOT IN ('done','wontfix')`. If count > 0 → skip (epic not complete).
4. Look up `merger_state` for this epic. If row exists and `state IN ('merging', 'merged')` → skip (idempotent).
5. Invoke `atmux epic-merge <eid>` (or its module-level entry point directly to avoid process fork — match ADR-202 §IX-A lean-dispatch shape).
6. On success → emit `epic.merged` event (Phase 4 consumes; cockpit-mirror per ADR-230 consumes for fleet observability).
7. On failure → set `merger_state.state = 'failed'` with reason; emit operator flag via `atmux flag add` (NO silent retry storms — mirrors ADR-224 §D5 OQ4 lesson).

**Idempotency**: existing `merger_state` table + `BEGIN IMMEDIATE` serializes re-fires. Re-firing on `merged` state is a no-op — handler returns success, Honker advances the consumer offset.

**Backstop**: existing `atmux epic-merge tick` cron stays installed (ADR-134 §Triggers). Phase 3 doesn't remove it — primary path is event-driven; cron is resilience for missed NOTIFY events. ADR-202 §X cron-decommission pattern applies AFTER Phase 3 lands stable on trunk for ~2 weeks (deferred decision; reviewer + driver can decommission at that point).

## Consequences

### What changes

- **BE lane**: 1 new module (`orchd-auto-merge-handler.ts`), 1 SUBSCRIPTIONS entry append (`orchd-registry.ts`). No churn to `epic-merge` verb itself — handler invokes the existing entry point.
- **OPS lane**: no cron change (backstop stays).
- **TEST lane**: handler matrix (epic-not-complete / merger-state-merging / clean-merge / merge-failure-flag-emitted). Regression: ADR-134 cron backstop still fires + idempotent against event-driven primary.
- **DOC lane**: this ADR + RUNBOOK-orchd.md handler-list section.

### What breaks

Nothing immediate. Cron remains, so a Honker outage degrades gracefully to today's behavior.

### What we give up

Half-cron-interval merge latency budget (we now pay sub-second instead). Trade-off is event delivery cost (negligible vs. cron-spawn cost).

### Rollback path

Remove the SUBSCRIPTIONS entry; cron backstop fully covers existing semantics. Per-handler feature flag (`team.json::autoMerge.enabled`, default `true`) for surgical disable without code change.

## Open questions

1. **OQ-A**: Should the handler accept a `merge` event-level dedupe (Honker payload check on `event_id`) on TOP of `merger_state` row-level dedupe? Default: no — `merger_state` is authoritative; double-dedupe is belt-and-suspenders.
2. **OQ-B**: Cron decommission timing — fixed 2-week soak per ADR-202 §X, or driven by zero-failed-merge metric? Default: fixed 2-week soak; revisit at decommission window.

Resolve OQ-A and OQ-B before flipping `Status: accepted`. Either resolved inline at Phase 3 reviewer signoff or carved out explicitly.

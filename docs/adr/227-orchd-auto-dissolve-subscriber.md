# ADR-227: orchd auto-dissolve subscriber (Phase 4)

**Status**: proposed
**Date**: 2026-05-23
**Driver-ref**: parent atmux kanban `t-0db3f393` (orchd lifecycle EPIC body — Phase 3+4+5) + EPIC `e-a946af69`
**Sibling ADRs**: [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) (Phase 1+2 — registry seam this Phase mounts onto + solo-worker dissolve handler this Phase composes with), [ADR-226](226-orchd-auto-merge-subscriber.md) (Phase 3 — emits the `epic.merged` event this handler consumes), [ADR-228](228-orchd-spawn-queue-and-pressure-monitor.md) (Phase 5 — independent throttle layer)
**Cross-refs**: [ADR-090](090-epic-team-lifecycle.md) §dissolve-epic (target verb), [ADR-182](182-auto-reap-epic-team-on-epic-merge.md) (today's auto-reap-on-merge path Phase 4 supersedes / unifies), [ADR-219](219-dissolve-epic-completeness.md) (dissolve-epic completeness invariants Phase 4 inherits), [ADR-221](221-solo-worker-scope.md) §Phase 2 (solo-worker v2 auto-dissolve — composes with this handler under the same daemon), [ADR-087](087-soft-stop.md) (`atmux team stop --soft` graceful path)

## Context

Phase 3 (ADR-226) lands the auto-merge subscriber. On successful merge it emits `epic.merged`. Today there's no consumer — the merger calls dissolve-epic inline at end-of-merge (per ADR-182). Phase 4 moves that responsibility OUT of the merger and INTO orchd as a discrete Honker subscriber on `epic.merged`.

Decoupling rationale:

1. **Cleaner failure modes.** If dissolve fails (dirty worktree, stale lock), the failure surfaces as an operator-facing flag at the orchd boundary instead of half-rolling-back the merger.
2. **Single-daemon-owns-lifecycle (ADR-224 OQ5).** orchd owns spawn (Phase 2), solo-worker dissolve (Phase 2), auto-merge (Phase 3), AND auto-dissolve (Phase 4). Cohesive ownership; no cross-daemon coordination.
3. **Audit trail.** Per-subscriber `consumerId` in Honker offsets gives operator a single grep for "what dissolved this epic" — handler logs to `.atmux/logs/orchd-dissolve.log` per ADR-090 audit pattern.

## Decision

Add ORCHD_SUBSCRIPTIONS entry:

```ts
{
  topic: "epic.merged",
  consumerId: "atmux:orchd:auto-dissolve",
  handler: autoDissolveHandler,
}
```

**Handler semantics** (`src/core/orchd-auto-dissolve-handler.ts`, new):

1. Extract `epic` from event payload.
2. Pre-flight gates (ADR-090 §dissolve-epic + ADR-219):
   - All tasks `done` (post-merge invariant; assertion).
   - Worktree clean (no untracked files / no unmerged commits beyond the merge SHA).
   - No `--no-auto-dissolve` flag on epic at spawn-time (operator inspection override; stored at `epics.extra.noAutoDissolve = true`).
3. If any gate fails → set `epics.extra.dissolveBlocked = {at, reason}` + `atmux flag add` for operator. Return success (offset advances; operator clears the flag).
4. Invoke `atmux team dissolve-epic <eid> --soft` (per ADR-087). On success → emit `epic.dissolved` event (operator-observable; no consumer in this Phase but ADR-230 cockpit-mirror picks it up).
5. On failure (process error mid-dissolve) → flag + return success (offset advances; operator drives manual cleanup).

**Solo-worker v2 fold-in**: ADR-221 §v1 makes solo-workers structurally epic-teams (`w-<task-id>` epic id prefix). The `task.done` subscriber from Phase 2 (ADR-224 §D6) handles the FIRST half — when a solo-worker's only task moves to `done`, it triggers Phase 3's auto-merge (worker's epic completes) → emits `epic.merged` → Phase 4 dissolves. End-to-end solo-worker v2 auto-dissolve closes via Phase 3+4 composition; no extra handler needed.

**Idempotency**: handler checks team-still-exists before stop (race: a manual dissolve raced the event). At-least-once delivery tolerance via existence check.

## Consequences

### What changes

- **BE lane**: 1 new module (`orchd-auto-dissolve-handler.ts`), 1 SUBSCRIPTIONS entry append. ADR-182's inline-dissolve-at-merge path is REMOVED from the merger (refactor — merger becomes single-responsibility).
- **OPS lane**: no cron change. ADR-182's pre-Phase-4 cron-fallback line stays installed for ~2-week soak per ADR-202 §X, then decommissioned.
- **TEST lane**: handler matrix (no-auto-dissolve-flag / dirty-worktree / clean-dissolve / dissolve-failure-flag); solo-worker v2 e2e (file solo-worker task → mark done → assert auto-merge → auto-dissolve → team gone within ~2s).
- **DOC lane**: this ADR + ADR-182 §Status update pointing at supersession.

### What breaks

ADR-182's inline-dissolve path is removed mid-flight. Bridge: Phase 4 ships AFTER Phase 3 (so the event is emitted), AND the cron-fallback line remains for the 2-week soak window — manual dissolve via `atmux team dissolve-epic` always works as escape hatch.

### What we give up

Single-process atomicity of merge+dissolve. Trade-off: cleaner failure isolation + operator-facing flag on dissolve-only failures (was previously masked under "merge error").

### Rollback path

Remove the SUBSCRIPTIONS entry + re-instate ADR-182's inline-dissolve path. Per-handler feature flag (`team.json::autoDissolve.enabled`, default `true`).

## Open questions

1. **OQ-A**: Should `--no-auto-dissolve` flag location be `epics.extra.noAutoDissolve` (per-epic) OR `team.json::autoDissolve.skipPatterns[]` (per-team)? Default: per-epic via `extra` — operators inspect specific epics, not class-wide.
2. **OQ-B**: Audit log location — `.atmux/logs/orchd-dissolve.log` (per-team) OR cockpit-level aggregate? Default: per-team (mirrors ADR-090 audit pattern); cockpit-mirror (ADR-230) provides fleet aggregation downstream.

Resolve OQ-A and OQ-B before flipping `Status: accepted`.

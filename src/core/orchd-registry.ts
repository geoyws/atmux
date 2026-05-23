// ADR-224 §D6 — orchd subscription registry seam (Phase 1 zero-handler scaffold).
//
// Pins the contract that Phase 2 + sibling EPIC e-a946af69 (Phases 3-5)
// register Honker subscribers against. Phase 1 ships the *interface* +
// an empty `ORCHD_SUBSCRIPTIONS` array — daemon load is no-op, behavior
// unchanged. Phase 2 appends `{ topic: "epic.added", ... }` and
// `{ topic: "task.done", ... }` entries; sibling EPIC appends auto-merge
// / auto-dissolve / throttle-queue handlers WITHOUT touching the daemon
// scaffolding (orchd.ts iterates this array; no hard-coded topic list).
//
// Idempotency contract (binding on every handler registered here):
//   At-least-once delivery from Honker. The registry persists per-
//   `consumerId` offsets ONLY after the handler returns successfully —
//   if the handler throws, the offset stays put and Honker re-delivers
//   on the next tick. Handlers that mutate state MUST check pre-existing
//   state (e.g. `epics.spawned_at IS NOT NULL` before calling spawn-epic)
//   so re-delivery is a safe no-op, not a duplicate side-effect.
//
// Multi-handler-per-topic is supported: two subscribers on `task.done`
// (e.g. solo-worker dissolve + auto-merge) ride distinct `consumerId`s
// — Honker's per-consumer offset model gives each its own dispatch
// cursor. No coordination between handlers; ordering across topics is
// not guaranteed.

import type { EventPayload } from "../schema/events.ts";

/**
 * A single orchd subscriber registration. Phase 2 + sibling EPIC append
 * entries to {@link ORCHD_SUBSCRIPTIONS} matching this shape.
 */
export interface OrchdSubscription {
  /** Honker topic to subscribe to (e.g. `"epic.added"`, `"task.done"`). */
  topic: string;
  /** Honker subscriber-offset key — must be unique per handler so the
   *  per-consumer offset model gives this handler its own dispatch
   *  cursor. Convention: `"atmux:orchd:<verb>"` (e.g.
   *  `"atmux:orchd:spawn"`, `"atmux:orchd:dissolve-worker"`). */
  consumerId: string;
  /** Event handler — MUST be idempotent under at-least-once delivery.
   *  Returns a resolved promise on success (offset advances); throws to
   *  signal failure (offset stays + Honker re-delivers next tick). */
  handler: (event: EventPayload) => Promise<void>;
}

/**
 * The canonical orchd subscription list. Phase 1: empty (daemon iterates
 * a 0-element array, no handlers fire — daemon load is a no-op, behavior
 * matches pre-rename). Phase 2 + sibling EPIC e-a946af69 append entries
 * here.
 *
 * Mutability: this is a plain mutable array so Phase 2's static-import
 * code can `ORCHD_SUBSCRIPTIONS.push({ ... })` at module-load time
 * (idiomatic for plugin-style registration in TS). Tests should snapshot
 * + restore the array around assertions to avoid cross-test leakage.
 */
export const ORCHD_SUBSCRIPTIONS: OrchdSubscription[] = [
  // Phase 2: append { topic: "epic.added",  consumerId: "atmux:orchd:spawn",            handler: spawnHandler }
  // Phase 2: append { topic: "task.done",   consumerId: "atmux:orchd:dissolve-worker",  handler: dissolveSoloWorkerHandler }
  // Sibling EPIC e-a946af69 Phase 3: append { topic: "task.done",   consumerId: "atmux:orchd:auto-merge",     handler: autoMergeHandler }
  // Sibling EPIC e-a946af69 Phase 4: append { topic: "epic.merged", consumerId: "atmux:orchd:auto-dissolve",  handler: autoDissolveHandler }
  // Sibling EPIC e-a946af69 Phase 5: append { topic: "epic.added",  consumerId: "atmux:orchd:spawn-throttle", handler: throttleHandler }
];

/**
 * Idempotent registration helper. Pushes the subscription onto
 * {@link ORCHD_SUBSCRIPTIONS} unless an entry with the same
 * `consumerId` is already present — re-registering the same consumer
 * (e.g. via hot-reload during dev) is a no-op rather than a duplicate.
 *
 * Returns `true` when the subscription was newly registered, `false`
 * when skipped (duplicate `consumerId`).
 */
export function registerOrchdSubscription(sub: OrchdSubscription): boolean {
  if (ORCHD_SUBSCRIPTIONS.some((s) => s.consumerId === sub.consumerId)) {
    return false;
  }
  ORCHD_SUBSCRIPTIONS.push(sub);
  return true;
}

/**
 * Lookup-by-topic — returns every subscription whose `topic` matches.
 * Multi-handler-per-topic is supported by design (see file header), so
 * the return is always an array; callers iterate.
 */
export function findOrchdSubscriptionsByTopic(topic: string): OrchdSubscription[] {
  return ORCHD_SUBSCRIPTIONS.filter((s) => s.topic === topic);
}

/**
 * Visit every registered subscription, calling `visit` once per entry.
 * Returns the visit count (= `ORCHD_SUBSCRIPTIONS.length`). Phase 1 ships
 * with an empty array so the count is 0 and the daemon does nothing
 * additional on startup — no behavior change vs pre-rename. Phase 2's
 * `--start` path uses this seam to register each handler's Honker
 * subscription (offset row init + per-handler dispatch task).
 */
export function visitOrchdSubscriptions(
  visit: (sub: OrchdSubscription) => void,
): number {
  for (const sub of ORCHD_SUBSCRIPTIONS) {
    visit(sub);
  }
  return ORCHD_SUBSCRIPTIONS.length;
}

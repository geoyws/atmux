// ADR-224 §D6 + ADR-226/227/229 wire-up — orchd subscription bootstrap.
//
// One call-site registers all three orchd handlers (auto-merge,
// auto-dissolve, auto-push) against {@link ORCHD_SUBSCRIPTIONS} via
// {@link registerOrchdSubscription}. Phase 2-step-2/5 (driver P0
// 2026-05-23): production audit found `ORCHD_SUBSCRIPTIONS` empty in
// 0.8.13, leaving the three handler modules as dead code. This module
// closes that gap.
//
// Layering note: this is the seam where `src/core/*` (handler factories)
// meets the registry. Each `createAutoXxxHandler` returns a typed
// per-event function (`Promise<XxxOutcome>`); the registry contract is
// `(event: EventPayload) => Promise<void>`. The wrappers below adapt
// outcome-returning factories to void-returning subscriptions, dropping
// outcome on the floor since downstream observability (audit log + emit)
// already records terminal states.
//
// Sibling injection (per ADR-226/227/229 stubbed-default-with-injected-
// resolver pattern): callers pass `mergeDeps` / `dissolveDeps` /
// `pushDeps` to override the stubbed dispatchers. Production wiring
// (sibling EPIC `e-60e16169`) supplies real dispatchers; this bootstrap
// accepts whichever shape the caller provides and registers the
// resulting handlers.
//
// Idempotency: {@link registerOrchdSubscription} is idempotent per
// consumerId — re-bootstrapping the same set is a no-op (returns
// `isNew: false` for duplicates). Tests that snapshot/restore
// `ORCHD_SUBSCRIPTIONS` around assertions should clear via
// `ORCHD_SUBSCRIPTIONS.length = 0` between cases.
//
// Wiring (step 3/5 follow-up per driver P0 chain): the daemon-side
// dispatch loop (`src/verbs/orchd.ts::orchd()` `--start` path) walks
// {@link ORCHD_SUBSCRIPTIONS} via `visitOrchdSubscriptions`. Step 3
// refactors `cron --drain` to iterate the registry single-path; this
// bootstrap stays purely about population.

import type { Database } from "bun:sqlite";
import type { EpicMergedPayload, EventPayload, TaskDonePayload } from "../schema/events.ts";
import {
  type AutoDissolveHandlerDeps,
  createAutoDissolveHandler,
  type DissolveTriggerPayload,
} from "./orchd-dissolve.ts";
import { type AutoMergeHandlerDeps, createAutoMergeHandler } from "./orchd-merge.ts";
import { type AutoPushHandlerDeps, createAutoPushHandler } from "./orchd-push.ts";
import { registerOrchdSubscription } from "./orchd-registry.ts";

/** Consumer IDs — exported so step 3/5's drain iterator + tests can
 *  reference the canonical strings without typos. Per ADR-224 §D6
 *  naming convention (`atmux:orchd:<verb>`). */
export const ORCHD_MERGE_CONSUMER_ID = "atmux:orchd:auto-merge";
export const ORCHD_DISSOLVE_CONSUMER_ID = "atmux:orchd:auto-dissolve";
export const ORCHD_PUSH_CONSUMER_ID = "atmux:orchd:auto-push";

/** Topics — exported for the same reason. Mirrors each handler module's
 *  documented trigger:
 *  - merge: `task.done` (per ADR-226 §D1)
 *  - dissolve: `epic.pushed` (per ADR-227 §Amendment 2026-05-23 trigger flip)
 *  - push: `epic.merged` (per ADR-229 §D1) */
export const ORCHD_MERGE_TOPIC = "task.done";
export const ORCHD_DISSOLVE_TOPIC = "epic.pushed";
export const ORCHD_PUSH_TOPIC = "epic.merged";

/**
 * Per-handler dep overrides — partial of the underlying
 * `createAutoXxxHandler` deps, minus `db` (sourced from
 * {@link BootstrapOrchdDeps.db}). Sibling-EPIC injection supplies the
 * real dispatchers (e.g. `dispatchEpicMerge` for merge, `dispatchGitPush`
 * for push); absent injection, the handler factories' stubbed defaults
 * apply (return `skipped-not-mine`, no side effects) — safe under
 * at-least-once delivery.
 */
export interface BootstrapOrchdDeps {
  /** Open Database (per-team `state.db`). Captured into each handler
   *  closure — caller MUST keep this open for the lifetime of the
   *  daemon process. */
  db: Database;
  /** Optional overrides for {@link createAutoMergeHandler}. */
  mergeDeps?: Omit<AutoMergeHandlerDeps, "db">;
  /** Optional overrides for {@link createAutoDissolveHandler}. */
  dissolveDeps?: Omit<AutoDissolveHandlerDeps, "db">;
  /** Optional overrides for {@link createAutoPushHandler}. */
  pushDeps?: Omit<AutoPushHandlerDeps, "db">;
}

/** Per-subscription registration result for caller observability. */
export interface OrchdRegistrationEntry {
  consumerId: string;
  topic: string;
  /** `true` on first registration; `false` when re-bootstrap found an
   *  existing entry under the same consumerId (idempotent no-op). */
  isNew: boolean;
}

/** Return shape of {@link bootstrapOrchd}. */
export interface BootstrapOrchdResult {
  /** Ordered by registration order: merge, dissolve, push. */
  registered: ReadonlyArray<OrchdRegistrationEntry>;
}

/**
 * Register the three orchd handlers (auto-merge, auto-dissolve,
 * auto-push) against {@link ORCHD_SUBSCRIPTIONS}. Idempotent under
 * repeat invocation with the same `deps.db` (consumerId match) — safe
 * to call from both `--start` and `--drain` entry points without
 * duplicate-registration concern.
 *
 * Type-narrowing note: {@link registerOrchdSubscription} accepts
 * `(event: EventPayload) => Promise<void>` per the registry contract.
 * Each handler factory returns a per-topic narrow type. The wrappers
 * below cast the incoming `EventPayload` to the expected narrow shape;
 * the cast is safe because step 3/5's drain iterator filters by topic
 * before dispatching (`findOrchdSubscriptionsByTopic(event.topic)`),
 * guaranteeing each handler sees only events of its registered topic.
 *
 * Returns the registration entries so callers (and tests) can confirm
 * which subscriptions were newly added vs already-present.
 */
export function bootstrapOrchd(deps: BootstrapOrchdDeps): BootstrapOrchdResult {
  const mergeHandlerFn = createAutoMergeHandler({
    db: deps.db,
    ...(deps.mergeDeps ?? {}),
  });
  const dissolveHandlerFn = createAutoDissolveHandler({
    db: deps.db,
    ...(deps.dissolveDeps ?? {}),
  });
  const pushHandlerFn = createAutoPushHandler({
    db: deps.db,
    ...(deps.pushDeps ?? {}),
  });

  const mergeIsNew = registerOrchdSubscription({
    topic: ORCHD_MERGE_TOPIC,
    consumerId: ORCHD_MERGE_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await mergeHandlerFn(event as TaskDonePayload);
    },
  });
  const dissolveIsNew = registerOrchdSubscription({
    topic: ORCHD_DISSOLVE_TOPIC,
    consumerId: ORCHD_DISSOLVE_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await dissolveHandlerFn(event as unknown as DissolveTriggerPayload);
    },
  });
  const pushIsNew = registerOrchdSubscription({
    topic: ORCHD_PUSH_TOPIC,
    consumerId: ORCHD_PUSH_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await pushHandlerFn(event as EpicMergedPayload);
    },
  });

  return {
    registered: [
      { consumerId: ORCHD_MERGE_CONSUMER_ID, topic: ORCHD_MERGE_TOPIC, isNew: mergeIsNew },
      {
        consumerId: ORCHD_DISSOLVE_CONSUMER_ID,
        topic: ORCHD_DISSOLVE_TOPIC,
        isNew: dissolveIsNew,
      },
      { consumerId: ORCHD_PUSH_CONSUMER_ID, topic: ORCHD_PUSH_TOPIC, isNew: pushIsNew },
    ],
  };
}

// Event-subscription registry + bootstrap (ADR-224 §D6 seam, slimmed
// by ADR-276).
//
// This module is what remains of `orchd-registry.ts` + `orchd-bootstrap.ts`
// after the orchd retirement (ADR-276): the daemon, its Rust ticker and
// the epic-machinery handlers (auto-merge, auto-dissolve — ADR-226/227,
// stub-dispatched since ADR-280 stage 3) are gone, and so is the ADR-229
// auto-push subscriber — nothing emits its `epic.merged` trigger once the
// auto-merge handler (the only emitter) is deleted, so the seven-gate
// engine + `dispatchGitPush` transport were removed rather than kept as
// dead code (they re-derive from git history when ADR-276 §D1's
// operator-invoked push verb is built). The registry itself survives
// because `committer --drain` — the one-shot, operator-invoked backstop
// ADR-276 §D1 describes — still drains the registered subscriptions:
//
//   - complaint-consumer (ADR-214 §D2; `complaint.filed` → tell-lead
//                       inbox routing. Emitter: the live `complaints`
//                       verb).
//   - lead-stall watchdog (ADR-247 §D2; `story.ready` /
//                       `story.unclaimed` / `task.unclaimed` → rate-
//                       limited lead ping. Registered only when the
//                       caller wires `leadStallDeps` and the operator
//                       has not disabled it).
//
// Idempotency contract (binding on every handler registered here):
// at-least-once delivery from Honker. Per-`consumerId` offsets persist
// ONLY after the handler returns successfully — a throw leaves the
// offset put and the event is re-delivered on the next drain. Handlers
// that mutate state MUST check pre-existing state so re-delivery is a
// safe no-op.
//
// Consumer-id strings keep their historical values VERBATIM: they are
// durable keys in every team's `subscriber_offsets` table, and renaming
// them would reset offsets and re-deliver old events fleet-wide.

import type { ComplaintFiledPayload, EventPayload } from "../schema/events.ts";
import {
  type ComplaintConsumerDeps,
  createComplaintConsumerHandler,
} from "./complaint-consumer.ts";
import {
  createLeadStallWatchdogHandler,
  type LeadStallWatchdogDeps,
  type LeadStallWatchdogEvent,
} from "./lead-stall-watchdog.ts";

/**
 * A single event-bus subscriber registration (formerly
 * `OrchdSubscription`).
 */
export interface EventSubscription {
  /** Honker topic to subscribe to (e.g. `"complaint.filed"`). */
  topic: string;
  /** Honker subscriber-offset key — unique per handler so the
   *  per-consumer offset model gives each handler its own dispatch
   *  cursor. Values are durable DB keys — never rename. */
  consumerId: string;
  /** Event handler — MUST be idempotent under at-least-once delivery.
   *  Resolves on success (offset advances); throws to signal failure
   *  (offset stays; re-delivered next drain). */
  handler: (event: EventPayload) => Promise<void>;
}

/**
 * The canonical subscription list. Populated by
 * {@link bootstrapEventSubscriptions}; iterated by
 * `committer --drain`. Plain mutable array; tests should reset via
 * `EVENT_SUBSCRIPTIONS.length = 0` between cases.
 */
export const EVENT_SUBSCRIPTIONS: EventSubscription[] = [];

/**
 * Idempotent registration helper — a duplicate `consumerId` is a no-op.
 * Returns `true` when newly registered, `false` when skipped.
 */
export function registerEventSubscription(sub: EventSubscription): boolean {
  if (EVENT_SUBSCRIPTIONS.some((s) => s.consumerId === sub.consumerId)) {
    return false;
  }
  EVENT_SUBSCRIPTIONS.push(sub);
  return true;
}

/** Consumer IDs — exported so the drain iterator + tests reference the
 *  canonical strings. Historical values, kept verbatim (see header).
 *  ADR-214 §D2 — complaint consumer. */
export const COMPLAINT_CONSUMER_ID = "atmux:complaint-consumer";
/** ADR-247 §D2 — lead-stall watchdog (three topics, one handler,
 *  distinct consumerIds so each topic's offset stays independent). */
export const LEAD_STALL_ON_STORY_READY_CONSUMER_ID = "atmux:lead-stall-watchdog:story-ready";
export const LEAD_STALL_ON_STORY_UNCLAIMED_CONSUMER_ID =
  "atmux:lead-stall-watchdog:story-unclaimed";
export const LEAD_STALL_ON_TASK_UNCLAIMED_CONSUMER_ID = "atmux:lead-stall-watchdog:task-unclaimed";

/** Topics. */
export const COMPLAINT_TOPIC = "complaint.filed";
export const LEAD_STALL_ON_STORY_READY_TOPIC = "story.ready";
export const LEAD_STALL_ON_STORY_UNCLAIMED_TOPIC = "story.unclaimed";
export const LEAD_STALL_ON_TASK_UNCLAIMED_TOPIC = "task.unclaimed";

/** Deps for {@link bootstrapEventSubscriptions}. */
export interface BootstrapEventSubscriptionsDeps {
  /** ADR-214 §D2: optional overrides for the complaint consumer.
   *  Absent → real-process spawn of `atmux tell-lead`. */
  complaintDeps?: ComplaintConsumerDeps;
  /** ADR-247 §D2: deps for the lead-stall watchdog. REQUIRED for the
   *  watchdog subscriptions to register; when absent they are skipped
   *  (safe no-op), and when `team.leadStallWatchdog.enabled === false`
   *  they are skipped per the §D6 operator off-switch. */
  leadStallDeps?: LeadStallWatchdogDeps;
}

/** Per-subscription registration result for caller observability. */
export interface EventSubscriptionRegistrationEntry {
  consumerId: string;
  topic: string;
  /** `true` on first registration; `false` on idempotent re-bootstrap. */
  isNew: boolean;
}

/** Return shape of {@link bootstrapEventSubscriptions}. */
export interface BootstrapEventSubscriptionsResult {
  registered: ReadonlyArray<EventSubscriptionRegistrationEntry>;
}

/**
 * Register the surviving subscriptions (complaint consumer, and — when
 * deps are wired — the lead-stall watchdog) against
 * {@link EVENT_SUBSCRIPTIONS}. Idempotent under repeat invocation
 * (consumerId match).
 *
 * Type-narrowing note: the registry contract is
 * `(event: EventPayload) => Promise<void>`; each handler factory
 * returns a per-topic narrow type. The wrappers cast because the drain
 * iterator filters by topic before dispatching, so each handler sees
 * only events of its registered topic.
 */
export function bootstrapEventSubscriptions(
  deps: BootstrapEventSubscriptionsDeps,
): BootstrapEventSubscriptionsResult {
  const complaintHandlerFn = createComplaintConsumerHandler(deps.complaintDeps ?? {});

  const complaintIsNew = registerEventSubscription({
    topic: COMPLAINT_TOPIC,
    consumerId: COMPLAINT_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await complaintHandlerFn(event as ComplaintFiledPayload);
    },
  });

  // ADR-247 §D2 — lead-stall watchdog: three subscriptions sharing one
  // handler closure, ONLY when deps are wired AND the operator hasn't
  // disabled it. The `task.unclaimed` topic is shared with lane-router;
  // the distinct consumerId isolates the offset (ADR-202 §VIII).
  const leadStallEntries: EventSubscriptionRegistrationEntry[] = [];
  if (
    deps.leadStallDeps !== undefined &&
    deps.leadStallDeps.team.leadStallWatchdog?.enabled !== false
  ) {
    const leadStallHandlerFn = createLeadStallWatchdogHandler(deps.leadStallDeps);
    const watchdogSubs: ReadonlyArray<{ topic: string; consumerId: string }> = [
      {
        topic: LEAD_STALL_ON_STORY_READY_TOPIC,
        consumerId: LEAD_STALL_ON_STORY_READY_CONSUMER_ID,
      },
      {
        topic: LEAD_STALL_ON_STORY_UNCLAIMED_TOPIC,
        consumerId: LEAD_STALL_ON_STORY_UNCLAIMED_CONSUMER_ID,
      },
      {
        topic: LEAD_STALL_ON_TASK_UNCLAIMED_TOPIC,
        consumerId: LEAD_STALL_ON_TASK_UNCLAIMED_CONSUMER_ID,
      },
    ];
    for (const { topic, consumerId } of watchdogSubs) {
      const isNew = registerEventSubscription({
        topic,
        consumerId,
        handler: async (event: EventPayload) => {
          // The watchdog re-reads the kanban at handle-time (ADR-247
          // §OQ3); the event is just a wake nudge.
          await leadStallHandlerFn(event as unknown as LeadStallWatchdogEvent);
        },
      });
      leadStallEntries.push({ consumerId, topic, isNew });
    }
  }

  return {
    registered: [
      {
        consumerId: COMPLAINT_CONSUMER_ID,
        topic: COMPLAINT_TOPIC,
        isNew: complaintIsNew,
      },
      ...leadStallEntries,
    ],
  };
}

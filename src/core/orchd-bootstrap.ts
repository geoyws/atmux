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
import { KanbanCliAdapter } from "../adapters/kanban-cli.ts";
import type {
  ComplaintFiledPayload,
  EpicMergedPayload,
  EpicReadyPayload,
  EpicUnblockedPayload,
  EventPayload,
  MemberContextHighPayload,
  TaskDonePayload,
} from "../schema/events.ts";
import {
  type ComplaintConsumerDeps,
  createComplaintConsumerHandler,
} from "./complaint-consumer.ts";
import { listTasks, showTask } from "./kanban.ts";
import { externalKanbanEnabled } from "./kanban-backend.ts";
import {
  createLeadStallWatchdogHandler,
  type LeadStallWatchdogDeps,
  type LeadStallWatchdogEvent,
} from "./lead-stall-watchdog.ts";
import {
  type AutoDissolveHandlerDeps,
  createAutoDissolveHandler,
  type DissolveTriggerPayload,
} from "./orchd-dissolve.ts";
import { type AutoMergeHandlerDeps, createAutoMergeHandler } from "./orchd-merge.ts";
import { type AutoPushHandlerDeps, createAutoPushHandler } from "./orchd-push.ts";
import { registerOrchdSubscription } from "./orchd-registry.ts";
import { KanbanRepo } from "./repositories/kanban-repo.ts";
import { createRotationConsumerHandler, type RotationConsumerDeps } from "./rotation-consumer.ts";

/** Consumer IDs — exported so step 3/5's drain iterator + tests can
 *  reference the canonical strings without typos. Per ADR-224 §D6
 *  naming convention (`atmux:orchd:<verb>`). */
export const ORCHD_MERGE_CONSUMER_ID = "atmux:orchd:auto-merge";
export const ORCHD_DISSOLVE_CONSUMER_ID = "atmux:orchd:auto-dissolve";
export const ORCHD_PUSH_CONSUMER_ID = "atmux:orchd:auto-push";
/** ADR-214 §D2 — complaint consumer. Wakes on `complaint.filed` and
 *  routes to the lead's tell-lead inbox. */
export const ORCHD_COMPLAINT_CONSUMER_ID = "atmux:complaint-consumer";
/** ADR-212 / e-cc3728bf — rotation consumer. Wakes on
 *  `member.context-high` (and future `pane.stuck` / `member.no-progress`
 *  / `cage.starving` as their observers ship) and routes structured
 *  decision-matrix to lead's tell-lead inbox. */
export const ORCHD_ROTATION_CONSUMER_ID = "atmux:rotation-consumer";
/** ADR-247 §D2 — lead-stall watchdog. Subscribes to THREE topics
 *  (`story.ready` / `story.unclaimed` / `task.unclaimed`) with distinct
 *  consumerIds so each topic's per-consumer offset stays independent
 *  (ADR-202 §VIII). All three share the SAME handler closure (one
 *  factory). The shared `task.unclaimed` topic is a parallel
 *  subscription to lane-router's — distinct consumerId, different
 *  handler, per ADR-247 §D2. Registered only when
 *  `team.leadStallWatchdog.enabled !== false`. */
export const ORCHD_LEAD_STALL_ON_STORY_READY_CONSUMER_ID = "atmux:lead-stall-watchdog:story-ready";
export const ORCHD_LEAD_STALL_ON_STORY_UNCLAIMED_CONSUMER_ID =
  "atmux:lead-stall-watchdog:story-unclaimed";
export const ORCHD_LEAD_STALL_ON_TASK_UNCLAIMED_CONSUMER_ID =
  "atmux:lead-stall-watchdog:task-unclaimed";

/** Topics — exported for the same reason. Mirrors each handler module's
 *  documented trigger:
 *  - merge: `task.done` (per ADR-226 §D1)
 *  - dissolve: `epic.pushed` (per ADR-227 §Amendment 2026-05-23 trigger flip)
 *  - push: `epic.merged` (per ADR-229 §D1)
 *
 *  ADR-280 stage 3 removed the ADR-231 §D2 spawn subscriptions
 *  (`epic.ready` / `epic.unblocked` → `atmux team spawn-epic`) and the
 *  §D6 solo-worker dissolve subscription (`task.done` → `atmux team
 *  dissolve-worker`): both shelled verbs that no longer exist, so both
 *  were dead machinery that would have failed inside a loop that
 *  tolerates non-zero exits. The merge / dissolve / push handlers are
 *  KEPT — their dispatchers are injected and default to stubs, and
 *  ADR-276 owns the orchd retirement. */
export const ORCHD_MERGE_TOPIC = "task.done";
export const ORCHD_DISSOLVE_TOPIC = "epic.pushed";
export const ORCHD_PUSH_TOPIC = "epic.merged";
/** ADR-214 §D2 — complaint topic. */
export const ORCHD_COMPLAINT_TOPIC = "complaint.filed";
/** ADR-212 / e-cc3728bf — rotation observer signal (v1: context-high
 *  only; future topics layer in additively). */
export const ORCHD_ROTATION_TOPIC = "member.context-high";
/** ADR-247 §D2 — lead-stall watchdog topics. */
export const ORCHD_LEAD_STALL_ON_STORY_READY_TOPIC = "story.ready";
export const ORCHD_LEAD_STALL_ON_STORY_UNCLAIMED_TOPIC = "story.unclaimed";
export const ORCHD_LEAD_STALL_ON_TASK_UNCLAIMED_TOPIC = "task.unclaimed";

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
  /** Kanban root for the cage this daemon serves. Feeds the auto-merge
   *  handler's `loadTasks`; absent → the handler falls back to its own
   *  default. Was named `spawnDeps.atmuxDir` until ADR-280 stage 3
   *  removed the spawn handler that owned it. */
  atmuxDir?: string;
  /** ADR-214 §D2: optional overrides for the complaint consumer. Absent
   *  → real-process spawn of `atmux tell-lead`. Tests inject a mock
   *  `spawnTellLead` to assert on argv. */
  complaintDeps?: ComplaintConsumerDeps;
  /** ADR-212 / e-cc3728bf: optional overrides for the rotation
   *  consumer. Absent → real `atmux tell-lead` spawn. */
  rotationDeps?: RotationConsumerDeps;
  /** ADR-247 §D2: deps for the lead-stall watchdog. REQUIRED for the
   *  watchdog subscriptions to register — the factory needs `atmuxDir`
   *  (rate-limit state + kanban read), `team` (roster + tell-lead
   *  routing + the `leadStallWatchdog` config), and `loadSnapshot` (the
   *  ping-time kanban read per ADR-247 §OQ3). When ABSENT, the three
   *  watchdog subscriptions are NOT registered (no host wired) — safe
   *  no-op. When PRESENT but `team.leadStallWatchdog.enabled === false`,
   *  they are also skipped (operator off-switch per ADR-247 §D6).
   *  Production wire-up (`verbs/orchd.ts`) passes the running cage's
   *  atmuxDir + team + a `loadKanban`-backed snapshot reader. */
  leadStallDeps?: LeadStallWatchdogDeps;
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
  const workAtmuxDir = deps.atmuxDir;
  const mergeHandlerFn = createAutoMergeHandler({
    db: deps.db,
    ...(workAtmuxDir ? { loadTasks: async () => await loadKanbanTasks(workAtmuxDir) } : {}),
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
  // ADR-214 §D2 — complaint consumer. Always builds; deps optional
  // (defaults to real-process spawn of `atmux tell-lead`).
  const complaintHandlerFn = createComplaintConsumerHandler(deps.complaintDeps ?? {});
  // ADR-212 / e-cc3728bf — rotation consumer.
  const rotationHandlerFn = createRotationConsumerHandler(deps.rotationDeps ?? {});

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
  // ADR-214 §D2 — complaint consumer.
  const complaintIsNew = registerOrchdSubscription({
    topic: ORCHD_COMPLAINT_TOPIC,
    consumerId: ORCHD_COMPLAINT_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await complaintHandlerFn(event as ComplaintFiledPayload);
    },
  });
  // ADR-212 / e-cc3728bf — rotation consumer.
  const rotationIsNew = registerOrchdSubscription({
    topic: ORCHD_ROTATION_TOPIC,
    consumerId: ORCHD_ROTATION_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await rotationHandlerFn(event as MemberContextHighPayload);
    },
  });

  // ADR-247 §D2 — lead-stall watchdog. Registers THREE subscriptions
  // (story.ready / story.unclaimed / task.unclaimed) sharing one handler
  // closure, ONLY when deps are wired AND the operator hasn't disabled
  // it (`team.leadStallWatchdog.enabled !== false` per ADR-247 §D6).
  // Absent deps → no host → skip (the watchdog needs atmuxDir + team +
  // a kanban-snapshot reader the bare bootstrap can't synthesize). The
  // `task.unclaimed` topic is shared with lane-router; the distinct
  // consumerId isolates the per-consumer offset (ADR-202 §VIII).
  const leadStallEntries: OrchdRegistrationEntry[] = [];
  if (
    deps.leadStallDeps !== undefined &&
    deps.leadStallDeps.team.leadStallWatchdog?.enabled !== false
  ) {
    const leadStallHandlerFn = createLeadStallWatchdogHandler(deps.leadStallDeps);
    const watchdogSubs: ReadonlyArray<{ topic: string; consumerId: string }> = [
      {
        topic: ORCHD_LEAD_STALL_ON_STORY_READY_TOPIC,
        consumerId: ORCHD_LEAD_STALL_ON_STORY_READY_CONSUMER_ID,
      },
      {
        topic: ORCHD_LEAD_STALL_ON_STORY_UNCLAIMED_TOPIC,
        consumerId: ORCHD_LEAD_STALL_ON_STORY_UNCLAIMED_CONSUMER_ID,
      },
      {
        topic: ORCHD_LEAD_STALL_ON_TASK_UNCLAIMED_TOPIC,
        consumerId: ORCHD_LEAD_STALL_ON_TASK_UNCLAIMED_CONSUMER_ID,
      },
    ];
    for (const { topic, consumerId } of watchdogSubs) {
      const isNew = registerOrchdSubscription({
        topic,
        consumerId,
        handler: async (event: EventPayload) => {
          // The watchdog re-reads the kanban at handle-time (ADR-247
          // §OQ3); the event itself is just a wake nudge. Narrow to the
          // slim {topic, team} the handler needs — all three subscribed
          // topics carry `team`.
          await leadStallHandlerFn(event as unknown as LeadStallWatchdogEvent);
        },
      });
      leadStallEntries.push({ consumerId, topic, isNew });
    }
  }

  return {
    registered: [
      { consumerId: ORCHD_MERGE_CONSUMER_ID, topic: ORCHD_MERGE_TOPIC, isNew: mergeIsNew },
      {
        consumerId: ORCHD_DISSOLVE_CONSUMER_ID,
        topic: ORCHD_DISSOLVE_TOPIC,
        isNew: dissolveIsNew,
      },
      { consumerId: ORCHD_PUSH_CONSUMER_ID, topic: ORCHD_PUSH_TOPIC, isNew: pushIsNew },
      {
        consumerId: ORCHD_COMPLAINT_CONSUMER_ID,
        topic: ORCHD_COMPLAINT_TOPIC,
        isNew: complaintIsNew,
      },
      {
        consumerId: ORCHD_ROTATION_CONSUMER_ID,
        topic: ORCHD_ROTATION_TOPIC,
        isNew: rotationIsNew,
      },
      // ADR-247 §D2 — zero entries when the watchdog deps are absent or
      // the operator disabled it; three entries (one per topic) otherwise.
      ...leadStallEntries,
    ],
  };
}

async function loadKanbanTasks(atmuxDir: string) {
  return (await import("./kanban.ts")).loadKanban(atmuxDir).then((kanban) => kanban.tasks);
}

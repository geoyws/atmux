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
import {
  createDissolveSoloWorkerHandler,
  type DissolveSoloWorkerHandlerDeps,
} from "./orchd-dissolve-solo-worker.ts";
import { type AutoMergeHandlerDeps, createAutoMergeHandler } from "./orchd-merge.ts";
import { type AutoPushHandlerDeps, createAutoPushHandler } from "./orchd-push.ts";
import { registerOrchdSubscription } from "./orchd-registry.ts";
import { createSpawnEpicHandler, type SpawnEpicHandlerDeps } from "./orchd-spawn.ts";
import { createRotationConsumerHandler, type RotationConsumerDeps } from "./rotation-consumer.ts";

/** Consumer IDs — exported so step 3/5's drain iterator + tests can
 *  reference the canonical strings without typos. Per ADR-224 §D6
 *  naming convention (`atmux:orchd:<verb>`). */
export const ORCHD_MERGE_CONSUMER_ID = "atmux:orchd:auto-merge";
export const ORCHD_DISSOLVE_CONSUMER_ID = "atmux:orchd:auto-dissolve";
export const ORCHD_PUSH_CONSUMER_ID = "atmux:orchd:auto-push";
/** ADR-231 §D6: distinct from {@link ORCHD_DISSOLVE_CONSUMER_ID} (which
 *  handles parent's Phase 4 epic-team dissolve per ADR-227). Honker
 *  per-consumer offsets isolate the two subscriptions on the shared
 *  `task.done` topic. */
export const ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID = "atmux:orchd:dissolve-solo-worker";
/** ADR-231 §D2: spawnEpicHandler subscribes to BOTH `epic.ready` and
 *  `epic.unblocked` (per ADR-225 §Events) — two consumerIds isolate
 *  the per-topic offsets so a backlog on one topic doesn't shadow the
 *  other. The handler closure is the same factory (`createSpawnEpicHandler`);
 *  only the subscription bookkeeping differs. */
export const ORCHD_SPAWN_ON_READY_CONSUMER_ID = "atmux:orchd:spawn:on-ready";
export const ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID = "atmux:orchd:spawn:on-unblocked";
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
 *  - dissolve-solo-worker: `task.done` (per ADR-231 §D6) */
export const ORCHD_MERGE_TOPIC = "task.done";
export const ORCHD_DISSOLVE_TOPIC = "epic.pushed";
export const ORCHD_PUSH_TOPIC = "epic.merged";
export const ORCHD_DISSOLVE_SOLO_WORKER_TOPIC = "task.done";
/** ADR-231 §D2 — both events trigger the same spawn handler per
 *  ADR-225 §Events (deps-graph + operator-flip transitions). */
export const ORCHD_SPAWN_ON_READY_TOPIC = "epic.ready";
export const ORCHD_SPAWN_ON_UNBLOCKED_TOPIC = "epic.unblocked";
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
  /** ADR-231 §D6: optional overrides for
   *  {@link createDissolveSoloWorkerHandler}. Absent ⇒ handler factory
   *  builds with `db` only + applies its own defaults
   *  ({@link isSoloWorkerTeamName} classifier, real spawn, no-op
   *  logger). */
  dissolveSoloWorkerDeps?: Omit<DissolveSoloWorkerHandlerDeps, "db">;
  /** ADR-231 §D2: REQUIRED overrides for {@link createSpawnEpicHandler}
   *  when the spawn subscriptions should fire. The factory needs
   *  `atmuxDir` + `team` (NOT derivable from `db` alone), so absent →
   *  spawn subscriptions register with a stub that returns
   *  `skipped-row-missing` for every event (safe no-op). Production
   *  wire-up (`verbs/committer.ts`) passes the running cage's
   *  atmuxDir + team config. */
  spawnDeps?: Omit<SpawnEpicHandlerDeps, "db">;
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
  const workAtmuxDir = deps.spawnDeps?.atmuxDir;
  const dissolveSoloWorkerHandlerFn = createDissolveSoloWorkerHandler({
    db: deps.db,
    ...(workAtmuxDir
      ? {
          taskReader: {
            showTask: (id: string) => showTask(workAtmuxDir, id),
            listTasks: (filter: { owner: string }) =>
              listTasks(workAtmuxDir, { assignee: filter.owner }),
          },
        }
      : {}),
    ...(deps.dissolveSoloWorkerDeps ?? {}),
  });
  // ADR-231 §D2 — spawn handler. When `spawnDeps` is absent (no caller
  // wire-up), build a stub that returns `skipped-row-missing` for every
  // event — safe no-op under at-least-once delivery + matches the
  // pre-T-S2.5 behavior. Production callers (committer.ts) pass
  // atmuxDir + team config so the real factory builds.
  const spawnHandlerFn =
    deps.spawnDeps !== undefined
      ? createSpawnEpicHandler({
          db: deps.db,
          ...deps.spawnDeps,
          ...(process.env.ATMUX_KANBAN_BACKEND === "external"
            ? {
                epicStore: externalEpicStore(deps.spawnDeps.atmuxDir),
              }
            : {}),
        })
      : async (_event: { epicId: string }) => "skipped-row-missing" as const;
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
  // ADR-231 §D6 — solo-worker auto-dissolve subscriber. Shares the
  // `task.done` topic with the auto-merge handler; per-consumer
  // offsets (ADR-202 §VIII) isolate the two.
  const dissolveSoloWorkerIsNew = registerOrchdSubscription({
    topic: ORCHD_DISSOLVE_SOLO_WORKER_TOPIC,
    consumerId: ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await dissolveSoloWorkerHandlerFn(event as TaskDonePayload);
    },
  });
  // ADR-231 §D2 — spawn subscriber. Registers TWICE (epic.ready +
  // epic.unblocked) with distinct consumerIds so per-topic offsets
  // stay independent. Handler closure is shared (same factory).
  const spawnOnReadyIsNew = registerOrchdSubscription({
    topic: ORCHD_SPAWN_ON_READY_TOPIC,
    consumerId: ORCHD_SPAWN_ON_READY_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await spawnHandlerFn(event as EpicReadyPayload);
    },
  });
  const spawnOnUnblockedIsNew = registerOrchdSubscription({
    topic: ORCHD_SPAWN_ON_UNBLOCKED_TOPIC,
    consumerId: ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID,
    handler: async (event: EventPayload) => {
      await spawnHandlerFn(event as EpicUnblockedPayload);
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
        consumerId: ORCHD_DISSOLVE_SOLO_WORKER_CONSUMER_ID,
        topic: ORCHD_DISSOLVE_SOLO_WORKER_TOPIC,
        isNew: dissolveSoloWorkerIsNew,
      },
      {
        consumerId: ORCHD_SPAWN_ON_READY_CONSUMER_ID,
        topic: ORCHD_SPAWN_ON_READY_TOPIC,
        isNew: spawnOnReadyIsNew,
      },
      {
        consumerId: ORCHD_SPAWN_ON_UNBLOCKED_CONSUMER_ID,
        topic: ORCHD_SPAWN_ON_UNBLOCKED_TOPIC,
        isNew: spawnOnUnblockedIsNew,
      },
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

function externalEpicStore(atmuxDir: string): NonNullable<SpawnEpicHandlerDeps["epicStore"]> {
  const adapter = new KanbanCliAdapter();
  return {
    getEpic: async (id) =>
      (await adapter.loadKanban(atmuxDir)).epics.find((epic) => epic.id === id) ?? null,
    saveEpic: async (epic) => {
      const extra = epic.extra ?? {};
      await adapter.patchMetadata(atmuxDir, epic.id, "atmux", {
        workflowStatus: epic.status ?? null,
        driverRef: epic.driverRef ?? null,
        isReady: epic.isReady,
        spawnedAt: epic.spawnedAt ?? null,
        autoSpawn: extra.autoSpawn ?? null,
        spawnFailed: extra.spawnFailed ?? null,
        spawnPressureDeferred: extra.spawnPressureDeferred ?? null,
        atmuxExtra: extra,
      });
    },
  };
}

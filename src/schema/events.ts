// ADR-203: Event topic taxonomy — Zod payload schemas for the Honker
// in-DB messaging substrate (ADR-202).
//
// Phase-1 substrate scope: BasePayloadFields shell + the discriminated-
// union skeleton. Topic-specific payloads land additively as consumer
// EPICs ship (e-honker-jury, e-honker-gitter, etc.) — each consumer's
// commit adds the topic schemas it needs to this union. The closed v1
// topic set is enumerated in ADR-203 §D2.
//
// Pinned conventions per ADR-203 §D1/§D3:
//   - Topic names are lowercase dotted hierarchical past-tense:
//     `task.claimed`, `story.jury.ratified`, `epic.merge-ready`.
//   - Every payload extends BasePayloadFields (topic discriminator,
//     UUIDv7 event_id, emittedAtSec, schemaVersion).
//   - `.passthrough()` for forward-compat with unknown fields per the
//     kanban schema precedent ([[reference_kanbantask_passthrough_extra_json]]).
//   - Field names camelCase to match the kanban convention; snake_case
//     stays out of the wire shape (column names in the events table
//     are snake_case per SQLite convention but the JSON payload is
//     camelCase — `src/abstractions/events.ts` mediates).

import { z } from "zod";

// ---------- Base ----------

/** Fields every event carries — the discriminator + ID + clock + version. */
export const BasePayloadFields = {
  topic: z.string(),
  eventId: z.string(),
  emittedAtSec: z.number(),
  schemaVersion: z.literal(1).default(1),
} as const;

// ---------- v1 topic payloads (additive — consumer EPICs extend) ----------

/** `task.claimed` — member claimed an unclaimed task. ADR-203 §D2 (Task lifecycle). */
export const TaskClaimedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("task.claimed"),
    taskId: z.string(),
    member: z.string(),
    team: z.string(),
    lane: z.enum(["FE", "BE", "DB", "OPS", "TEST", "REVIEW", "MISC"]).optional(),
    epicId: z.string().optional(),
    storyId: z.string().optional(),
  })
  .passthrough();

/** `task.done` — member moved task to done. ADR-203 §D2 (Task lifecycle). */
export const TaskDonePayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("task.done"),
    taskId: z.string(),
    member: z.string(),
    team: z.string(),
    doneAtSec: z.number(),
    commitSha: z.string().optional(),
    epicId: z.string().optional(),
    storyId: z.string().optional(),
  })
  .passthrough();

/**
 * `task.unclaimed` — task landed in `todo` with a lane set + no owner.
 * ADR-203 §D2 (Task lifecycle). ADR-202 §Amendment 2026-05-22 (IV) wires
 * this to a lane-router consumer that runs the existing `lane-tick`
 * claim-injection for the named lane immediately rather than waiting
 * for the 5-min cron tick (latency: 5min to ~1sec).
 */
export const TaskUnclaimedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("task.unclaimed"),
    taskId: z.string(),
    team: z.string(),
    lane: z.enum(["fe", "be", "db", "ops", "test", "review", "misc"]),
    priority: z.number().nullable().optional(),
    epicId: z.string().optional(),
    storyId: z.string().optional(),
  })
  .passthrough();

/** `commit.landed` — post-commit hook fired. ADR-203 §D5 hook contract. */
export const CommitLandedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("commit.landed"),
    commitSha: z.string(),
    branch: z.string(),
    author: z.string(),
    message: z.string(),
  })
  .passthrough();

/**
 * `gitter.escalated` — gitter consumer hit a failure class it cannot
 * auto-resolve (merge conflict, test-failed-on-trunk, missing worktree,
 * dispatcher refusal) and is handing off to lead-gated judgment per
 * ADR-212 §D2 (canonical lead-gated destructive action pattern) +
 * ADR-145 §"escalate via flag/reply on conflict". The payload carries
 * enough context for the lead's Claude to decide between rebase / squash
 * / revert / handoff-to-author without re-investigating the worktree.
 */
export const GitterEscalatedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("gitter.escalated"),
    taskId: z.string(),
    member: z.string(),
    team: z.string(),
    branch: z.string(),
    commitSha: z.string(),
    conflictFiles: z.array(z.string()).optional(),
    suggestedResolution: z.enum(["rebase", "squash", "revert", "handoff-to-author"]).optional(),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
    failureClass: z.enum([
      "merge-conflict",
      "test-failed-on-trunk",
      "missing-worktree",
      "dispatcher-refused",
    ]),
  })
  .passthrough();

/**
 * `epic.unblocked` — the dep-graph event. Fires when an epic A's LAST
 * unmet dep just transitioned to `status='done'`. Carries `byEpicId`
 * = the dep id whose transition cleared the last blocker, so consumers
 * (orchd, cockpit-mirror) can render "A is unblocked by B done".
 *
 * Critically NOT gated on `isReady` — the event reports the dep-graph
 * fact. Consumers that want the combined eligibility predicate
 * (deps-done + is_ready=1) join with `is_ready` at read time.
 *
 * ADR-225 §Events + §D2 amendment per ADR-203 §D2 closed-set rule.
 */
export const EpicUnblockedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.unblocked"),
    epicId: z.string(),
    byEpicId: z.string(),
    transitionedAt: z.number(),
  })
  .passthrough();

/**
 * `epic.ready` — operator (or workflow) flipped is_ready from 0 to 1.
 * Fires only on the 0→1 transition; 1→0 downgrades are silent (orchd
 * polls vs. event-driven for the is_ready=0 case per ADR-225).
 *
 * ADR-225 §Events + §D2 amendment per ADR-203 §D2 closed-set rule.
 */
export const EpicReadyPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.ready"),
    epicId: z.string(),
    transitionedAt: z.number(),
  })
  .passthrough();

/**
 * `epic.merged` — orchd-merge handler successfully merged an epic-team
 * branch into its parent base. ADR-203 §D2 (Epic lifecycle, ADR-226
 * §D2 addition 2026-05-23). Consumed by Phase 4 (ADR-227 auto-dissolve).
 */
export const EpicMergedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.merged"),
    epicId: z.string(),
    parentBase: z.string(),
    mergeSha: z.string(),
    mergedAtSec: z.number(),
  })
  .passthrough();

/**
 * `epic.merge-blocked` — orchd-merge handler's dispatcher returned a
 * conflict or gate-held outcome. ADR-203 §D2 (Epic lifecycle, ADR-226
 * §D2 addition 2026-05-23). Operator-observable; no consumer in v1.
 */
export const EpicMergeBlockedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.merge-blocked"),
    epicId: z.string(),
    reason: z.string(),
    blockedAtSec: z.number(),
  })
  .passthrough();

/**
 * `epic.pushed` — orchd-push handler successfully pushed the merged
 * commit to `origin/<parentBase>`. ADR-203 §D2 (Epic lifecycle,
 * ADR-229 §D3 addition 2026-05-23). Consumed by Phase 4 (ADR-227
 * §Amendment 2026-05-23 trigger flip from `epic.merged` to
 * `epic.pushed`).
 */
export const EpicPushedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.pushed"),
    epicId: z.string(),
    base: z.string(),
    headSha: z.string(),
    beforeSha: z.string().optional(),
    pushedAtSec: z.number(),
    durationMs: z.number().optional(),
  })
  .passthrough();

/**
 * `epic.push-blocked` — orchd-push handler's pre-flight gate refused
 * (any Gate-{2,3a,3b,4,5,7} failure). ADR-203 §D2 (Epic lifecycle,
 * ADR-229 §D3 addition 2026-05-23). Operator-observable; no consumer
 * in v1; surfaces in cockpit-mirror Discord feed per ADR-219. Gate-1
 * upstream-advanced is a distinct topic ({@link EpicPushConflictPayload})
 * because the actionable rebase/pull metadata warrants a distinct
 * Discord template.
 */
export const EpicPushBlockedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.push-blocked"),
    epicId: z.string(),
    base: z.string(),
    gateBlocked: z.enum(["1", "2", "3a", "3b", "4", "5", "7"]),
    reason: z.string(),
    blockedAtSec: z.number(),
  })
  .passthrough();

/**
 * `epic.push-conflict` — orchd-push handler's Gate-1 upstream-advanced
 * refusal. Distinct from `epic.push-blocked` because it carries
 * actionable rebase/pull metadata (ahead, behind, divergenceSha) +
 * a distinct Discord template per ADR-219. ADR-203 §D2 (Epic
 * lifecycle, ADR-229 §D3 addition 2026-05-23).
 */
export const EpicPushConflictPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.push-conflict"),
    epicId: z.string(),
    base: z.string(),
    ahead: z.number(),
    behind: z.number(),
    divergenceSha: z.string().optional(),
    blockedAtSec: z.number(),
  })
  .passthrough();

/**
 * `epic.dissolved` — orchd-dissolve handler completed the cage reap
 * for an epic-team. ADR-203 §D2 (Epic lifecycle; topic existed in v1
 * but the Zod payload schema landed alongside ADR-227 T5 dissolve
 * module 2026-05-23). Operator-observable; no consumer in v1 — the
 * cron-based sweep-epics reaper (`e-db13ac01`) used to handle this
 * with disk-state probes pre-Phase-4.
 */
export const EpicDissolvedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.dissolved"),
    epicId: z.string(),
    dissolvedAtSec: z.number(),
    dissolvedSha: z.string().optional(),
  })
  .passthrough();

/**
 * `epic.dissolve-blocked` — orchd-dissolve handler's pre-flight gate
 * refused (worktree dirty, in-flight sessions, ADR-090 §dissolve-epic
 * gate held). ADR-203 §D2 (Epic lifecycle, ADR-227 §D2 addition
 * 2026-05-23). Operator-observable; no consumer in v1; surfaces in
 * cockpit-mirror Discord feed per ADR-219.
 */
export const EpicDissolveBlockedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.dissolve-blocked"),
    epicId: z.string(),
    reason: z.string(),
    blockedAtSec: z.number(),
  })
  .passthrough();

/** Substrate self-monitoring: extension loaded + smoke passed. ADR-203 §D8. */
export const InternalHonkerLoadedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("internal.honker.loaded"),
    extensionPath: z.string(),
  })
  .passthrough();

/** Substrate self-monitoring: extension load failed → poll-mode fallback. ADR-203 §D8. */
export const InternalHonkerFallbackPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("internal.honker.fallback"),
    fallbackReason: z.string(),
    extensionPath: z.string().nullable(),
  })
  .passthrough();

/**
 * `epic.spawn-queued` — orchd queued a spawn request because the host
 * was over pressure threshold. ADR-228 §D5. Operator-observable;
 * surfaces in cockpit-mirror at depth thresholds {3, 5, 10} per
 * ADR-219 §queue-grew template (mirrors ADR-184 cadence).
 */
export const EpicSpawnQueuedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.spawn-queued"),
    queueId: z.string(),
    epicId: z.string(),
    queuedBy: z.string(),
    queuedAtSec: z.number(),
    depth: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * `epic.spawn-abandoned` — orchd's drain attempts exhausted
 * `maxAttempts` for a queued spawn request. ADR-228 §D5. Operator
 * must inspect manually (no automated consumer in v1).
 */
export const EpicSpawnAbandonedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.spawn-abandoned"),
    queueId: z.string(),
    epicId: z.string(),
    attempts: z.number().int().nonnegative(),
    lastFailureReason: z.string(),
  })
  .passthrough();

/**
 * `epic.added` — a new epic-team was added (either via direct spawn
 * OR via spawn-queue drain). Sibling EPIC `e-60e16169` Phase 2 auto-
 * spawn consumes this for downstream automation. ADR-228 §D5 added
 * this topic to the v1 closed set alongside `epic.spawn-queued` /
 * `epic.spawn-abandoned`.
 */
export const EpicAddedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("epic.added"),
    epicId: z.string(),
    addedAtSec: z.number(),
  })
  .passthrough();

// ---------- Discriminated union ----------

/**
 * The full v1 event payload type — discriminated union over `topic`.
 *
 * Consumer EPICs add their topic schemas here; the union grows
 * additively. Adding a new topic without updating consumers becomes
 * a TS exhaustive-switch error at consumer-handler call sites — that's
 * the load-bearing safety per ADR-203 §D1.
 */
export const EventPayload = z.discriminatedUnion("topic", [
  TaskClaimedPayload,
  TaskDonePayload,
  TaskUnclaimedPayload,
  CommitLandedPayload,
  GitterEscalatedPayload,
  EpicUnblockedPayload,
  EpicReadyPayload,
  EpicMergedPayload,
  EpicMergeBlockedPayload,
  EpicPushedPayload,
  EpicPushBlockedPayload,
  EpicPushConflictPayload,
  EpicDissolvedPayload,
  EpicDissolveBlockedPayload,
  EpicSpawnQueuedPayload,
  EpicSpawnAbandonedPayload,
  EpicAddedPayload,
  InternalHonkerLoadedPayload,
  InternalHonkerFallbackPayload,
]);

export type EventPayload = z.infer<typeof EventPayload>;
export type TaskClaimedPayload = z.infer<typeof TaskClaimedPayload>;
export type TaskDonePayload = z.infer<typeof TaskDonePayload>;
export type TaskUnclaimedPayload = z.infer<typeof TaskUnclaimedPayload>;
export type CommitLandedPayload = z.infer<typeof CommitLandedPayload>;
export type GitterEscalatedPayload = z.infer<typeof GitterEscalatedPayload>;
export type EpicUnblockedPayload = z.infer<typeof EpicUnblockedPayload>;
export type EpicReadyPayload = z.infer<typeof EpicReadyPayload>;
export type EpicMergedPayload = z.infer<typeof EpicMergedPayload>;
export type EpicMergeBlockedPayload = z.infer<typeof EpicMergeBlockedPayload>;
export type EpicPushedPayload = z.infer<typeof EpicPushedPayload>;
export type EpicPushBlockedPayload = z.infer<typeof EpicPushBlockedPayload>;
export type EpicPushConflictPayload = z.infer<typeof EpicPushConflictPayload>;
export type EpicDissolvedPayload = z.infer<typeof EpicDissolvedPayload>;
export type EpicDissolveBlockedPayload = z.infer<typeof EpicDissolveBlockedPayload>;
export type EpicSpawnQueuedPayload = z.infer<typeof EpicSpawnQueuedPayload>;
export type EpicSpawnAbandonedPayload = z.infer<typeof EpicSpawnAbandonedPayload>;
export type EpicAddedPayload = z.infer<typeof EpicAddedPayload>;
export type InternalHonkerLoadedPayload = z.infer<typeof InternalHonkerLoadedPayload>;
export type InternalHonkerFallbackPayload = z.infer<typeof InternalHonkerFallbackPayload>;

// ---------- Topic registry ----------

/**
 * Closed v1 topic set per ADR-203 §D2. Adding a topic here requires an
 * ADR amendment (the discipline is the point — see ADR-203 §D2 last
 * paragraph). Reserved namespace `internal.*` is for substrate self-
 * monitoring only; operator code MUST NOT emit into `internal.*`.
 *
 * The Topic type is the union of every legal published topic name.
 * Used by emit() + subscribe() helpers to reject unknown topic strings
 * at the type-system layer before they reach the database.
 */
export const TOPICS = [
  // Task lifecycle (team-scope)
  "task.claimed",
  "task.done",
  "task.stalled",
  "task.unclaimed",
  "task.role-mismatched",
  // Story lifecycle (team-scope)
  "story.created",
  "story.tested",
  "story.test-failed",
  "story.jury.ratified",
  "story.jury.pending",
  "story.jury.verdict",
  "story.jury.escalated",
  "story.merge-ready",
  // Epic lifecycle (team-scope + cockpit-mirror)
  "epic.created",
  "epic.dissolved",
  "epic.merge-ready",
  "epic.merged",
  "epic.merge-blocked",
  "epic.pushed",
  "epic.push-blocked",
  "epic.push-conflict",
  "epic.dissolve-blocked",
  "epic.spawn-blocked",
  // ADR-228 §D5 (Phase 5b spawn-queue): refuse→enqueue + drain-loop
  // lifecycle. `epic.spawn-queued` fires on admission; `epic.spawn-
  // abandoned` fires when attempts hit `maxAttempts`; `epic.added`
  // fires on successful drain (sibling EPIC e-60e16169 auto-spawn
  // consumer).
  "epic.spawn-queued",
  "epic.spawn-abandoned",
  "epic.added",
  // ADR-225 amendment per ADR-203 §D2 closed-set rule: dep-graph event
  // (`epic.unblocked`) + operator-kick-off event (`epic.ready`). Both
  // team-scope; cockpit-mirror joins them with the parent's epic row
  // for cross-team awareness (same routing as `epic.merge-ready`).
  "epic.unblocked",
  "epic.ready",
  // Commit lifecycle (team-scope)
  "commit.landed",
  "commit.pushed",
  "commit.merge-staged",
  // Gitter lifecycle (team-scope) — lead-gated escalation per ADR-212 §D2
  "gitter.escalated",
  // Pane lifecycle (team-scope)
  "pane.classifier.completed",
  "pane.wedged",
  "pane.refusal-detected",
  // Coordination + hygiene (mixed scope)
  "complaint.filed",
  "flag.raised",
  "decision.added",
  "hygiene.violated",
  // Cockpit-scope (cross-team fanout)
  "team.idle",
  "team.recovered",
  "team.stopped",
  "medic.hygiene-drained",
  "budget.warning",
  "budget.recovered",
  "disk.warning",
  // Substrate self-monitoring (internal namespace)
  "internal.honker.loaded",
  "internal.honker.fallback",
  "internal.subscriber.crash",
  "internal.smoke.tick",
] as const;

export type Topic = (typeof TOPICS)[number];

/** Runtime check — true iff `name` is a known v1 topic per ADR-203 §D2. */
export function isKnownTopic(name: string): name is Topic {
  return (TOPICS as readonly string[]).includes(name);
}

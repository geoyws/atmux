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
    suggestedResolution: z
      .enum(["rebase", "squash", "revert", "handoff-to-author"])
      .optional(),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
    failureClass: z.enum([
      "merge-conflict",
      "test-failed-on-trunk",
      "missing-worktree",
      "dispatcher-refused",
    ]),
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
  CommitLandedPayload,
  GitterEscalatedPayload,
  InternalHonkerLoadedPayload,
  InternalHonkerFallbackPayload,
]);

export type EventPayload = z.infer<typeof EventPayload>;
export type TaskClaimedPayload = z.infer<typeof TaskClaimedPayload>;
export type TaskDonePayload = z.infer<typeof TaskDonePayload>;
export type CommitLandedPayload = z.infer<typeof CommitLandedPayload>;
export type GitterEscalatedPayload = z.infer<typeof GitterEscalatedPayload>;
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
  "epic.spawn-blocked",
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
  "sentinel.escalated",
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

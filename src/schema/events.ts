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
//     `task.claimed`, `commit.landed`, `gitter.escalated`.
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
 * `complaint.filed` — a new complaint was filed against a team, OR an
 * existing OPEN complaint was bumped (dedup re-arm). Consumer
 * (`atmux:complaint-consumer`, registered via bootstrapOrchd) wakes ~1ms
 * after INSERT/UPDATE and calls `atmux tell-lead` per ADR-214 §D2.
 *
 * `bumped` distinguishes fresh complaints from dedup re-arms — the
 * consumer rate-limits bumps differently from new filings (a bumped
 * complaint signals "this is still broken N times now" rather than a
 * new incident).
 */
export const ComplaintFiledPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("complaint.filed"),
    complaintId: z.string(),
    targetTeam: z.string(),
    sourceKind: z.string().nullable(),
    sourceId: z.string().nullable(),
    incidentSummary: z.string(),
    openedBy: z.string().nullable(),
    severity: z.string().nullable(),
    sourceCount: z.number().int().positive().default(1),
    bumped: z.boolean().default(false),
    filedAtSec: z.number(),
  })
  .passthrough();

/**
 * `member.context-high` — orchd's 15-min context-saturation scan
 * (e-13-04c8b3bf) detected a member pane whose Claude TUI statusline
 * reports context-used percent at or above the team's threshold
 * (default 40%). Lead consumer (ADR-212 / e-cc3728bf) wakes and
 * decides: preclear / rotate-member / leave-alone.
 *
 * Not autonomous — lead-gated per ADR-212. The event is a signal,
 * not an instruction.
 */
export const MemberContextHighPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("member.context-high"),
    team: z.string(),
    member: z.string(),
    percent: z.number().int().min(0).max(100),
    threshold: z.number().int().min(0).max(100),
    matchedSegment: z.string(),
    capturedAtSec: z.number(),
  })
  .passthrough();

/**
 * `member.rate-limited` — the claude-agent-sdk backend observed a 429
 * (rate-limit / budget-cap) response on a member's turn. Per ADR-258
 * §D6b (member-health telemetry, Amendment 2026-06-08) the SDK backend
 * emits this so the cockpit budget-aware account-pool reroute (ADR-199
 * §D6) and lead-visibility surfaces can react. Phase 1 has NO consumer
 * — emit-only; the future SDK backend produces it.
 *
 * `httpStatus` is the observed status (429); `retryAfterSec` mirrors the
 * server's `Retry-After` when present; `h5Util` / `wkUtil` are the 5-hour
 * and weekly budget utilisations (0..1) when the SDK knows them.
 */
export const MemberRateLimitedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("member.rate-limited"),
    team: z.string(),
    member: z.string(),
    account: z.string(),
    httpStatus: z.number().int(),
    retryAfterSec: z.number().optional(),
    h5Util: z.number().min(0).max(1).optional(),
    wkUtil: z.number().min(0).max(1).optional(),
    capturedAtSec: z.number(),
  })
  .passthrough();

/**
 * `member.overloaded` — the claude-agent-sdk backend observed a 529
 * (transient upstream capacity / "Overloaded") response on a member's
 * turn. Per ADR-258 §D6b (member-health telemetry, Amendment
 * 2026-06-08). Distinct from `member.rate-limited` (429 budget) — 529 is
 * a transient backend-capacity signal that warrants backoff-and-retry,
 * not account reroute. Phase 1 has NO consumer — emit-only.
 *
 * `httpStatus` is pinned to 529; `retryAfterSec` mirrors the server's
 * `Retry-After` when present.
 */
export const MemberOverloadedPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("member.overloaded"),
    team: z.string(),
    member: z.string(),
    account: z.string(),
    httpStatus: z.literal(529),
    retryAfterSec: z.number().optional(),
    capturedAtSec: z.number(),
  })
  .passthrough();

/**
 * `member.usage-snapshot` — per-turn-end usage telemetry from the
 * claude-agent-sdk backend. Per ADR-258 §D6b (member-health telemetry,
 * Amendment 2026-06-08). Carries token counts (+ optional cost estimate
 * + budget utilisations) so cockpit-scope spend/throughput dashboards
 * can aggregate without re-deriving from raw transcripts. Phase 1 has NO
 * consumer — emit-only; the future SDK backend produces one per turn end.
 *
 * `estimatedUsd` is the SDK's best-effort cost estimate when known;
 * `h5Util` / `wkUtil` are the 5-hour / weekly budget utilisations (0..1).
 */
export const MemberUsageSnapshotPayload = z
  .object({
    ...BasePayloadFields,
    topic: z.literal("member.usage-snapshot"),
    team: z.string(),
    member: z.string(),
    account: z.string(),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    estimatedUsd: z.number().optional(),
    h5Util: z.number().min(0).max(1).optional(),
    wkUtil: z.number().min(0).max(1).optional(),
    capturedAtSec: z.number(),
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
  ComplaintFiledPayload,
  MemberContextHighPayload,
  MemberRateLimitedPayload,
  MemberOverloadedPayload,
  MemberUsageSnapshotPayload,
  InternalHonkerLoadedPayload,
  InternalHonkerFallbackPayload,
]);

export type EventPayload = z.infer<typeof EventPayload>;
export type TaskClaimedPayload = z.infer<typeof TaskClaimedPayload>;
export type TaskDonePayload = z.infer<typeof TaskDonePayload>;
export type TaskUnclaimedPayload = z.infer<typeof TaskUnclaimedPayload>;
export type CommitLandedPayload = z.infer<typeof CommitLandedPayload>;
export type GitterEscalatedPayload = z.infer<typeof GitterEscalatedPayload>;
export type ComplaintFiledPayload = z.infer<typeof ComplaintFiledPayload>;
export type MemberContextHighPayload = z.infer<typeof MemberContextHighPayload>;
export type MemberRateLimitedPayload = z.infer<typeof MemberRateLimitedPayload>;
export type MemberOverloadedPayload = z.infer<typeof MemberOverloadedPayload>;
export type MemberUsageSnapshotPayload = z.infer<typeof MemberUsageSnapshotPayload>;
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
  // e-13-04c8b3bf — member context-saturation signal (lead-gated
  // preclear/rotate consumer per ADR-212 / e-cc3728bf).
  "member.context-high",
  // ADR-258 §D6b (Amendment 2026-06-08) — member-health telemetry from
  // the future claude-agent-sdk backend. Emit-only in Phase 1 (no
  // consumer yet): `member.rate-limited` = 429 / budget cap;
  // `member.overloaded` = 529 transient upstream capacity;
  // `member.usage-snapshot` = per-turn-end token/cost usage.
  "member.rate-limited",
  "member.overloaded",
  "member.usage-snapshot",
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

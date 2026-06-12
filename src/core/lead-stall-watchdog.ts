// ADR-247 §D2/D3/D4/D5 — lead-stall watchdog (orchd consumer).
//
// Closes the agile-loop stall reproduced 2026-05-28 in mx-root
// (complaint c-b2c8418e): the planner advances stories `planning →
// ready` but the lead then sits idle with an empty composer — there is
// no autonomous trigger that converts a ready-but-undispatched story
// into a lead dispatch. This module is the trigger.
//
// Layering (mirrors src/core/lane-stall.ts):
//
//   - {@link decideLeadStall} is the PURE decision over a kanban
//     snapshot + clock + config + last-ping epoch. No IO, no clock
//     reads — fixture-driven unit tests pass `nowSec` directly. This is
//     the unit-testable core; it gates on the configured threshold and
//     the rate-limit window so a test can prove below-threshold does NOT
//     fire and re-delivery within the window emits no second ping.
//   - {@link formatLeadStallPing} renders the §D4 concrete-dispatch ping
//     from REAL story/task ids + REAL lanes resolved from the kanban at
//     ping-time (NO LIES: never a fabricated id or placeholder target).
//   - {@link readLastPingSec} / {@link recordPing} are the per-cage
//     rate-limit dedup-state R/W (§D5 first bullet) — same posture as
//     budget-warning-state.ts (`<atmuxDir>/state/<file>.json`).
//   - {@link createLeadStallWatchdogHandler} is the orchd consumer
//     factory: on a `story.ready` / `story.unclaimed` / `task.unclaimed`
//     event, evaluate over the current kanban, and — if it fires AND the
//     rate-limit allows — send the concrete ping to the lead via
//     `atmux tell-lead` (same dispatch shape as rotation-consumer.ts /
//     complaint-consumer.ts).
//
// SCOPE (ADR-247 Phase-1 task 2): W1 (ready-stories-no-claimant) + W2
// (unclaimed-tasks) + the concrete-dispatch ping + the per-cage
// rate-limit.
//
// DEFERRED (NOT built here — see `deferred` in the structured report):
//   - W3 (composer-idle-plus-actionable) per ADR-247 §D3: depends on
//     introspecting the lead pane's composer state (empty + no thinking
//     spinner). Pane-content polling is racy and there is no clean
//     pane-state verb available to a consumer (ADR-155 §pane-state
//     proposed/deferred). W1+W2 cover the actionable-work half without
//     it; W3 layers in once a non-racy pane-state seam lands.
//   - D5 no-ack escalation backoff per ADR-247 §D5 second bullet:
//     `atmux tell-lead --escalate` to the parent driver-inbox depends on
//     ADR-150 cross-cage routing, which has not landed. Until it does,
//     this watchdog stays single-tier (ping the local lead only).
//   - D7 doctor probe (`lead-stall-watchdog-consumer-present`) per
//     ADR-247 §D7: depends on the ADR-246 cockpit registry to enumerate
//     active epic cages. Not built here.

import { join } from "node:path";
import { spawn } from "node:child_process";

import { atomicWrite, ensureDir, readTextOrNull } from "../abstractions/fs.ts";
import type { KanbanStory, KanbanTask } from "../schema/kanban.ts";
import type { TeamMember } from "../schema/team.ts";

// ---------- Pure decision inputs/outputs ----------

/** Minimal story shape the decision consumes. The consumer derives
 *  these from `KanbanStory` rows read at ping-time. `lane` rides the
 *  story's passthrough `extra` JSON (stories have no first-class lane
 *  column) — null when the planner left it unset. */
export interface LeadStallStoryInput {
  id: string;
  /** Lifecycle status (`ready` is the W1 trigger state). */
  status: string;
  /** Member name when claimed; null/undefined when no claimant. */
  owner?: string | null;
  /** Lane hint from the story `extra` JSON; null when unset (the ping
   *  falls back to a placeholder-free "unassigned-lane" render that
   *  still names a real dispatch target via roster fallback). */
  lane?: string | null;
  /** Human title for the ping bullet. */
  title?: string | null;
  /** Epoch seconds the story entered `ready` (advancedAt preferred,
   *  createdAt fallback). Age = nowSec - readySinceSec. */
  readySinceSec: number;
}

/** Minimal task shape the decision consumes (the W2 candidates). */
export interface LeadStallTaskInput {
  id: string;
  status: string;
  owner?: string | null;
  lane?: string | null;
  subject?: string | null;
  /** Epoch seconds the task was created (proxy for "unclaimed since"). */
  createdAt: number;
}

/** One concrete dispatch item the lead should act on. Carries the REAL
 *  kanban id + REAL (or roster-resolved) lane + the exact member the
 *  `atmux dispatch <member> <id>` verb targets. NO placeholders. */
export interface LeadStallDispatchItem {
  /** `"story"` (W1) or `"task"` (W2). */
  kind: "story" | "task";
  /** Real kanban id (`s-…` / `t-…`). */
  id: string;
  /** Resolved lane (story/task lane, else `"misc"` fallback). */
  lane: string;
  /** Human title/subject for the bullet. Empty string when the row
   *  carried none — never a fabricated placeholder. */
  title: string;
  /** The member name the dispatch verb targets — a REAL roster member
   *  whose `.lane` matches, lowest-indexed; null when the roster has no
   *  member for this lane (the ping then names the lane + flags
   *  "no <lane> member — assign one" instead of inventing a target). */
  targetMember: string | null;
  /** Seconds the item has been idle (past the threshold). */
  idleForSec: number;
}

/** The decision verdict. `fire: true` means at least one of W1/W2 holds
 *  AND the rate-limit window has elapsed; `items` is the concrete
 *  dispatch list (always real ids). When `fire` is false, `reason`
 *  explains why (below-threshold / rate-limited / nothing-actionable). */
export interface LeadStallDecision {
  fire: boolean;
  /** Which wake conditions contributed (subset of {"W1","W2"}). Empty
   *  when nothing actionable. */
  conditions: ReadonlyArray<"W1" | "W2">;
  /** Concrete dispatch items — real ids/lanes/targets. Populated even
   *  on a rate-limited non-fire so callers/tests can inspect what WOULD
   *  have been pinged; the gate is `fire`. */
  items: ReadonlyArray<LeadStallDispatchItem>;
  reason: string;
}

/** Input bundle for {@link decideLeadStall}. Pure over this snapshot —
 *  no IO, no clock reads. */
export interface DecideLeadStallInput {
  stories: ReadonlyArray<LeadStallStoryInput>;
  tasks: ReadonlyArray<LeadStallTaskInput>;
  /** Roster members (name + lane) for resolving a real dispatch target
   *  per lane. */
  members: ReadonlyArray<{ name: string; lane?: string | null }>;
  nowSec: number;
  /** ADR-247 §D6 `idleThresholdMin` (minutes); the decision converts to
   *  seconds internally. */
  idleThresholdMin: number;
  /** ADR-247 §D5 `rateLimitPerCageMin` (minutes). */
  rateLimitPerCageMin: number;
  /** Epoch seconds of the last ping sent for this cage; null when the
   *  watchdog has never pinged (first-run). */
  lastPingSec: number | null;
}

// ---------- Pure decision ----------

/**
 * Pure decision per ADR-247 §D3 W1 + W2 + §D5 rate-limit.
 *
 *   - W1 (ready-stories-no-claimant): ≥1 story `status === "ready"` AND
 *     no owner AND `nowSec - readySinceSec >= thresholdSec`.
 *   - W2 (unclaimed-tasks): ≥1 task `status === "unclaimed"` OR (`todo`
 *     with a concrete lane and no owner) AND aged `>= thresholdSec`.
 *   - Rate-limit (§D5): even when W1/W2 hold, `fire` is false if a ping
 *     was sent within `rateLimitPerCageMin` — at-least-once event
 *     re-delivery must NOT multiply pings.
 *
 * Threshold is `>=` (at/above the boundary fires; strictly below does
 * not). The `items` list is built from the REAL story/task ids + lanes
 * and a roster-resolved real dispatch target — never fabricated.
 */
export function decideLeadStall(input: DecideLeadStallInput): LeadStallDecision {
  const thresholdSec = input.idleThresholdMin * 60;
  const rateLimitSec = input.rateLimitPerCageMin * 60;

  // Build a lane → lowest-indexed member name map so each item resolves
  // a REAL dispatch target. Member names follow the `<lane>-<n>`
  // convention (e.g. be-1) but we don't parse the index out of the
  // name — we sort by name so be-1 < be-2 deterministically and pick
  // the first. Members with no lane are skipped (lead/planner/reviewer
  // carry no lane affinity).
  const laneToMember = buildLaneTargetMap(input.members);

  const items: LeadStallDispatchItem[] = [];
  const conditions = new Set<"W1" | "W2">();

  // ---- W1: ready stories with no claimant, aged past threshold ----
  for (const s of input.stories) {
    if (s.status !== "ready") continue;
    const hasOwner = typeof s.owner === "string" && s.owner.length > 0;
    if (hasOwner) continue;
    const idleForSec = input.nowSec - s.readySinceSec;
    if (idleForSec < thresholdSec) continue;
    const lane = normalizeLane(s.lane);
    conditions.add("W1");
    items.push({
      kind: "story",
      id: s.id,
      lane,
      title: typeof s.title === "string" ? s.title : "",
      targetMember: laneToMember.get(lane) ?? null,
      idleForSec,
    });
  }

  // ---- W2: unclaimed tasks (status=unclaimed OR todo+lane+no-owner),
  //          aged past threshold ----
  for (const t of input.tasks) {
    const hasOwner = typeof t.owner === "string" && t.owner.length > 0;
    const hasConcreteLane = typeof t.lane === "string" && t.lane.length > 0;
    const isUnclaimedStatus = t.status === "unclaimed";
    const isTodoConcrete = t.status === "todo" && hasConcreteLane && !hasOwner;
    if (!isUnclaimedStatus && !isTodoConcrete) continue;
    // A status=unclaimed task with an owner is contradictory; require
    // no-owner for either branch so the ping never tells the lead to
    // dispatch an already-claimed row.
    if (hasOwner) continue;
    const idleForSec = input.nowSec - t.createdAt;
    if (idleForSec < thresholdSec) continue;
    const lane = normalizeLane(t.lane);
    conditions.add("W2");
    items.push({
      kind: "task",
      id: t.id,
      lane,
      title: typeof t.subject === "string" ? t.subject : "",
      targetMember: laneToMember.get(lane) ?? null,
      idleForSec,
    });
  }

  if (items.length === 0) {
    return {
      fire: false,
      conditions: [],
      items: [],
      reason: "no actionable work (no ready-no-claimant story or aged unclaimed task past threshold)",
    };
  }

  // Rate-limit gate (§D5): suppress when a ping landed within the
  // window. This is what makes at-least-once re-delivery idempotent —
  // re-evaluating the SAME stall on a re-delivered event finds the
  // recent ping and stays silent.
  if (input.lastPingSec !== null) {
    const sincePingSec = input.nowSec - input.lastPingSec;
    if (sincePingSec < rateLimitSec) {
      return {
        fire: false,
        conditions: [...conditions].sort(),
        items,
        reason: `rate-limited: last ping ${sincePingSec}s ago (window ${rateLimitSec}s)`,
      };
    }
  }

  return {
    fire: true,
    conditions: [...conditions].sort(),
    items,
    reason: `${items.length} actionable item(s) idle past ${thresholdSec}s threshold`,
  };
}

/** Resolve lane → REAL dispatch target member name. Lowest member name
 *  per lane wins (be-1 sorts before be-2). Laneless members (lead /
 *  planner / reviewer) are skipped. Exported for direct testing. */
export function buildLaneTargetMap(
  members: ReadonlyArray<{ name: string; lane?: string | null }>,
): Map<string, string> {
  const byLane = new Map<string, string[]>();
  for (const m of members) {
    if (typeof m.lane !== "string" || m.lane.length === 0) continue;
    const bucket = byLane.get(m.lane);
    if (bucket === undefined) byLane.set(m.lane, [m.name]);
    else bucket.push(m.name);
  }
  const out = new Map<string, string>();
  for (const [lane, names] of byLane) {
    const sorted = [...names].sort();
    const first = sorted[0];
    if (first !== undefined) out.set(lane, first);
  }
  return out;
}

/** Normalize a possibly-null lane to a non-empty string. Falls back to
 *  `"misc"` (a real lane) — never an empty/placeholder value. */
function normalizeLane(lane: string | null | undefined): string {
  return typeof lane === "string" && lane.length > 0 ? lane : "misc";
}

// ---------- §D4 concrete-dispatch ping format ----------

/**
 * Render the ADR-247 §D4 concrete-dispatch ping. The header carries the
 * 🔔 marker; each bullet lists the REAL id, lane, title, and the exact
 * runnable dispatch verb.
 *
 * Dispatch verb note: ADR-247 §D4's example shows `atmux dispatch
 * s-<id> --to be-1`, but the SHIPPED `dispatch` verb signature is
 * `atmux dispatch <member> <task-id>` (src/verbs/dispatch.ts) — member
 * first, no `--to` flag. NO LIES: we render the verb that actually runs,
 * not the ADR's illustrative-but-wrong form. When the lane has no roster
 * member, we name the lane and flag "no <lane> member" rather than
 * inventing a target.
 */
export function formatLeadStallPing(items: ReadonlyArray<LeadStallDispatchItem>): string {
  const stories = items.filter((i) => i.kind === "story");
  const tasks = items.filter((i) => i.kind === "task");
  const lines: string[] = ["🔔 [lead-stall-watchdog] Idle with actionable work — dispatch these:"];
  if (stories.length > 0) {
    lines.push("Ready stories (W1):");
    for (const s of stories) lines.push(bullet(s));
  }
  if (tasks.length > 0) {
    lines.push("Unclaimed tasks (W2):");
    for (const t of tasks) lines.push(bullet(t));
  }
  lines.push("Next: dispatch the items above, or unready/unblock any that are not yet actionable.");
  return lines.join("\n");
}

/** One ping bullet for a dispatch item. Renders the real runnable
 *  `atmux dispatch <member> <id>` verb, or a no-member flag when the
 *  lane has no roster member. */
function bullet(item: LeadStallDispatchItem): string {
  const title = item.title.length > 0 ? ` — ${item.title}` : "";
  if (item.targetMember === null) {
    return `  • ${item.id} [lane=${item.lane}]${title} — no ${item.lane} member; assign one then dispatch`;
  }
  return `  • ${item.id} [lane=${item.lane}]${title} — dispatch: atmux dispatch ${item.targetMember} ${item.id}`;
}

// ---------- §D5 per-cage rate-limit dedup-state ----------
//
// State file `<atmuxDir>/state/lead-stall-watchdog.json` holds the
// epoch-seconds of the last ping for this cage. One number per cage —
// the rate-limit is per-cage (§D5 first bullet), and the orchd consumer
// runs in exactly one cage, so a single `lastPingSec` field suffices.
// Same atomic-write + tolerant-read posture as budget-warning-state.ts
// (losing the file just re-arms a fresh window — never a hard error).

const STATE_FILENAME = "lead-stall-watchdog.json";

export function leadStallStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** Read the last-ping epoch for this cage. Returns null when the file
 *  is absent (first run) or malformed (re-arm fresh). */
export async function readLastPingSec(atmuxDir: string): Promise<number | null> {
  const txt = await readTextOrNull(leadStallStatePath(atmuxDir));
  if (txt === null) return null;
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const v = (parsed as Record<string, unknown>).lastPingSec;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null; // corrupt — re-arm fresh
  }
}

/** Persist the last-ping epoch for this cage (atomic write). */
export async function recordPing(atmuxDir: string, nowSec: number): Promise<void> {
  await ensureDir(join(atmuxDir, "state"));
  await atomicWrite(leadStallStatePath(atmuxDir), JSON.stringify({ lastPingSec: nowSec }));
}

// ---------- Kanban-snapshot → decision-input adapters ----------

/** Map a `KanbanStory` row to the decision's story input. `lane` rides
 *  the passthrough `extra` JSON (no first-class column); `readySinceSec`
 *  prefers `advancedAt` (the planning→ready transition stamp) and falls
 *  back to `createdAt`, then 0. */
export function storyToInput(story: KanbanStory): LeadStallStoryInput {
  // Stories have no first-class `owner`/`lane` column — both ride the
  // passthrough `extra` JSON when set (the planner's `story.ready`
  // emitter reads them the same way in src/core/story.ts). A ready
  // story with no `owner` in extra is "unclaimed" for W1 purposes.
  const extra = story as unknown as Record<string, unknown>;
  const lane = typeof extra.lane === "string" ? extra.lane : null;
  const owner = typeof extra.owner === "string" ? extra.owner : null;
  const readySinceSec =
    typeof story.advancedAt === "number"
      ? story.advancedAt
      : typeof story.createdAt === "number"
        ? story.createdAt
        : 0;
  return {
    id: story.id,
    status: story.status ?? "",
    owner,
    lane,
    title: story.title ?? null,
    readySinceSec,
  };
}

/** Map a `KanbanTask` row to the decision's task input. */
export function taskToInput(task: KanbanTask): LeadStallTaskInput {
  return {
    id: task.id,
    status: task.status ?? "",
    owner: task.owner ?? null,
    lane: task.lane ?? null,
    subject: task.subject ?? null,
    createdAt: typeof task.createdAt === "number" ? task.createdAt : 0,
  };
}

// ---------- Orchd consumer factory ----------

export type LeadStallWatchdogTopic = "story.ready" | "story.unclaimed" | "task.unclaimed";

/** The slim event shape the handler needs — every subscribed topic
 *  carries `team`. We re-read the kanban at handle-time (ADR-247 §OQ3
 *  ping-time lookup), so the event payload itself is just a wake nudge. */
export interface LeadStallWatchdogEvent {
  topic: LeadStallWatchdogTopic;
  team: string;
}

export type LeadStallWatchdogOutcome =
  | "pinged"
  | "skip-no-actionable-work"
  | "skip-rate-limited"
  | "skip-disabled"
  | "tell-lead-failed";

export interface LeadStallWatchdogDeps {
  /** Cage atmux dir — root for the rate-limit state file + kanban read. */
  atmuxDir: string;
  /** Team name (passed to `atmux tell-lead --team`) + roster + config. */
  team: {
    name: string;
    members: ReadonlyArray<TeamMember>;
    leadStallWatchdog?: {
      enabled?: boolean;
      idleThresholdMin?: number;
      rateLimitPerCageMin?: number;
    };
  };
  /** Read the current kanban snapshot (stories + tasks) at ping-time.
   *  Production: a thin wrapper over `loadKanban(atmuxDir)`. Injected so
   *  tests fixture the snapshot without a DB. */
  loadSnapshot: () => Promise<{
    stories: ReadonlyArray<KanbanStory>;
    tasks: ReadonlyArray<KanbanTask>;
  }>;
  /** Spawn `atmux tell-lead`. Default: real subprocess (same shape as
   *  rotation-consumer.ts). Resolves the exit code. */
  spawnTellLead?: (args: ReadonlyArray<string>) => Promise<number>;
  /** Clock — epoch seconds. Default `Date.now()/1000`. Injected so
   *  tests pin the threshold + rate-limit boundaries. */
  nowSec?: () => number;
  /** Optional logger. */
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
}

const NOOP_LOGGER = { log: () => {}, warn: () => {} };
const DEFAULT_IDLE_THRESHOLD_MIN = 5;
const DEFAULT_RATE_LIMIT_PER_CAGE_MIN = 5;

/**
 * Factory — returns the orchd handler for the lead-stall-watchdog
 * subscriptions (`story.ready` / `story.unclaimed` / `task.unclaimed`).
 *
 * On each event: read the CURRENT kanban (ADR-247 §OQ3 ping-time
 * lookup), evaluate {@link decideLeadStall}, and — when it fires —
 * persist the ping epoch + send the concrete §D4 ping to the lead via
 * `atmux tell-lead`. The rate-limit (§D5) is enforced inside the
 * decision against the persisted `lastPingSec`, so a re-delivered event
 * within the window resolves to `skip-rate-limited` (no second ping).
 *
 * `enabled !== false` gating is also done at registration time in
 * bootstrapOrchd; this defensive in-handler check keeps the factory
 * safe if called directly.
 */
export function createLeadStallWatchdogHandler(
  deps: LeadStallWatchdogDeps,
): (event: LeadStallWatchdogEvent) => Promise<LeadStallWatchdogOutcome> {
  const spawnTellLead = deps.spawnTellLead ?? defaultSpawnTellLead;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const logger = deps.logger ?? NOOP_LOGGER;
  const cfg = deps.team.leadStallWatchdog ?? {};
  const idleThresholdMin = cfg.idleThresholdMin ?? DEFAULT_IDLE_THRESHOLD_MIN;
  const rateLimitPerCageMin = cfg.rateLimitPerCageMin ?? DEFAULT_RATE_LIMIT_PER_CAGE_MIN;

  return async (event) => {
    if (cfg.enabled === false) {
      logger.log("lead-stall-watchdog: disabled via team.leadStallWatchdog.enabled=false");
      return "skip-disabled";
    }

    const snapshot = await deps.loadSnapshot();
    const now = nowSec();
    const lastPingSec = await readLastPingSec(deps.atmuxDir);

    const decision = decideLeadStall({
      stories: snapshot.stories.map(storyToInput),
      tasks: snapshot.tasks.map(taskToInput),
      members: deps.team.members.map((m) => ({ name: m.name, lane: m.lane ?? null })),
      nowSec: now,
      idleThresholdMin,
      rateLimitPerCageMin,
      lastPingSec,
    });

    if (!decision.fire) {
      if (decision.reason.startsWith("rate-limited")) {
        logger.log(
          `lead-stall-watchdog: skip-rate-limited topic=${event.topic} (${decision.reason})`,
        );
        return "skip-rate-limited";
      }
      logger.log(`lead-stall-watchdog: skip topic=${event.topic} (${decision.reason})`);
      return "skip-no-actionable-work";
    }

    // Persist the ping epoch BEFORE the send so a crash mid-send still
    // arms the rate-limit (fail toward fewer pings — re-delivery after a
    // crash won't double-ping). The send itself is best-effort durable
    // via tell-lead's own inbox append.
    await recordPing(deps.atmuxDir, now);

    const msg = formatLeadStallPing(decision.items);
    const code = await spawnTellLead(["tell-lead", "--team", deps.team.name, msg]);
    if (code !== 0) {
      logger.warn(
        `lead-stall-watchdog: tell-lead exited rc=${code} for team=${deps.team.name} topic=${event.topic}`,
      );
      return "tell-lead-failed";
    }
    logger.log(
      `lead-stall-watchdog: pinged team=${deps.team.name} topic=${event.topic} ` +
        `items=${decision.items.length} conditions=${decision.conditions.join("+")}`,
    );
    return "pinged";
  };
}

/** Default real-process spawn of `atmux tell-lead`. Inherits stdio so
 *  logs surface in the orchd pane log. */
function defaultSpawnTellLead(args: ReadonlyArray<string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("atmux", [...args], { stdio: "inherit", env: process.env });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

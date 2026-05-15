// ADR-148 §D4 / T3: lane-stall decision module.
//
// Pure logic + dedup-state R/W for the `lane-stall-watch` cron rule.
// The verb (`src/verbs/lane-stall-tick.ts`) wires this to the actual
// tmux pane probe + send-keys + flag-file path; everything decision-
// shaped lives here so the verb stays thin + testable.
//
// **Decision rule (per ADR-148 §D4)** — fire lane-stall when ALL of:
//   1. `Task.status === "todo"`
//   2. `Task.lane === X` (concrete, not null)
//   3. `now - Task.createdAt > laneStallMinAgeSec` (default 1800 = 30min)
//   4. Every member with `lane === X` has `cadence.verdict ∈
//      {idle, dormant, ship-zero-window}` (NOT `shipping`)
//   5. No prior fire for `(taskId, lane)` within
//      `laneStallMinAgeSec / 2` (dedup window)
//
// **Cadence-verdict source** — T5's `src/core/cadence-classifier.ts`
// is not yet on this branch (ADR-148 §Implementation plan T5 is
// parallel). Until T5 lands, the verb-side wire-up passes a stub that
// classifies every member as `idle` (the safest default — surfaces a
// `lane-stall` whenever the timer + age conditions trip, since the
// verdict gate becomes trivially-true). When T5 lands, the wire-up
// switches to `classifyMemberCadence`; this module's decision shape
// stays unchanged. Local literal-union for the verdict per
// [[feedback_test_impl_session_pattern_2026_05_14]] sibling-branch
// type-deps pattern.

import { join } from "node:path";
import { z } from "zod";
import { ensureDir, exists } from "../abstractions/fs.ts";
import { readJsonOr, updateJson } from "../abstractions/json.ts";

/** Cadence verdict per ADR-148 §D2. Local literal-union — T5 (the
 *  canonical home in `cadence-classifier.ts`) is parallel-shipping;
 *  values stay aligned via the ADR vocabulary. */
export type CadenceVerdict = "shipping" | "idle" | "dormant" | "ship-zero-window";

/** Verdicts that count as "this lane isn't shipping right now" — the
 *  gate condition for lane-stall to fire. Everything except
 *  `shipping`. ADR-148 §D4 names the set verbatim. */
export const STALL_VERDICTS: ReadonlySet<CadenceVerdict> = new Set<CadenceVerdict>([
  "idle",
  "dormant",
  "ship-zero-window",
]);

/** Minimal `KanbanTask` shape consumed by the decision. Mirrors the
 *  fields the cron-tick verb extracts before calling
 *  {@link decideLaneStall} — keeping the input narrow makes the
 *  unit tests trivially fixture-able without spinning a kanban
 *  storage layer. */
export interface LaneStallTaskInput {
  id: string;
  /** Non-null lane (caller filters out `lane:null` Tasks before
   *  passing in). The decision treats `lane=null` as out-of-scope
   *  even if it slipped through. */
  lane: string;
  /** Epoch seconds. The verb fills this from
   *  `KanbanTask.createdAt`. */
  createdAt: number;
}

/** Per-member input — verdict + lane-affinity. The verb resolves
 *  these via:
 *    - `lane` from `team.members[].lane`
 *    - `verdict` from the injected cadence-classifier
 *    - `lastActivityAt` from optional pane-activity probe (for the
 *      most-recently-active member-picking heuristic). Omit when
 *      unavailable — the decision falls back to roster order. */
export interface LaneStallMemberInput {
  name: string;
  lane: string;
  verdict: CadenceVerdict;
  /** Epoch seconds of the member's last pane activity OR last commit.
   *  When set, the highest value wins as `targetMember` on a fire
   *  decision. */
  lastActivityAt?: number;
}

/** One dedup-state entry — written when a fire decision actually
 *  surfaces (the verb persists after pane-state-check + send). */
export interface LaneStallDedupEntry {
  taskId: string;
  lane: string;
  /** Epoch seconds. The decision compares
   *  `nowSec - firedAt < laneStallMinAgeSec / 2` to skip re-fire. */
  firedAt: number;
}

/** Dedup state file shape — array of entries plus version sentinel for
 *  forward-compat. Same wrapper-object posture as the ombudsman
 *  sentinel from ADR-147 T1. */
export const LaneStallDedupStateSchema = z
  .object({
    fires: z.array(
      z
        .object({
          taskId: z.string(),
          lane: z.string(),
          firedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type LaneStallDedupState = z.infer<typeof LaneStallDedupStateSchema>;

const EMPTY_DEDUP_STATE: LaneStallDedupState = { fires: [] };

/** Input bundle for {@link decideLaneStall}. */
export interface DecideLaneStallOpts {
  tasks: ReadonlyArray<LaneStallTaskInput>;
  members: ReadonlyArray<LaneStallMemberInput>;
  dedup: ReadonlyArray<LaneStallDedupEntry>;
  nowSec: number;
  laneStallMinAgeSec: number;
}

/** Outcome per stalled-Task candidate. The verb iterates the array
 *  and acts on `kind === "fire"` rows; the other kinds are
 *  informational + drive the cron log line. */
export type LaneStallDecisionKind =
  | "fire"
  | "skip-age-below-threshold"
  | "skip-some-shipping"
  | "skip-no-lane-members"
  | "skip-dedup";

export interface LaneStallDecision {
  kind: LaneStallDecisionKind;
  taskId: string;
  lane: string;
  /** Set only when `kind === "fire"`. The member receiving the
   *  Enter-push per §D4 — most-recently-active wins; tiebreak by
   *  roster order. */
  targetMember?: string;
  /** Optional one-line reason for the cron log + flag body. */
  reason?: string;
}

/**
 * Pure decision: given a snapshot of stalled-candidate Tasks +
 * per-member cadence verdicts + dedup history + clock, return one
 * decision per candidate Task per ADR-148 §D4. The verb fans out
 * the `fire` decisions to actual send-keys + dedup writes.
 *
 * No I/O. No clock reads. Fixture-driven tests pass `nowSec`
 * directly.
 */
export function decideLaneStall(opts: DecideLaneStallOpts): LaneStallDecision[] {
  const out: LaneStallDecision[] = [];
  const dedupWindowSec = Math.floor(opts.laneStallMinAgeSec / 2);

  // Build per-lane member buckets once so each task lookup is O(1)
  // on member-count.
  const byLane = new Map<string, LaneStallMemberInput[]>();
  for (const m of opts.members) {
    if (m.lane.length === 0) continue;
    const bucket = byLane.get(m.lane);
    if (bucket === undefined) {
      byLane.set(m.lane, [m]);
    } else {
      bucket.push(m);
    }
  }

  for (const t of opts.tasks) {
    // Defensive: skip lane:null / empty (caller should pre-filter,
    // but the decision stays self-protecting).
    if (t.lane.length === 0) continue;

    // Gate 1: age threshold.
    const ageSec = opts.nowSec - t.createdAt;
    if (ageSec <= opts.laneStallMinAgeSec) {
      out.push({
        kind: "skip-age-below-threshold",
        taskId: t.id,
        lane: t.lane,
        reason: `task age ${ageSec}s ≤ threshold ${opts.laneStallMinAgeSec}s`,
      });
      continue;
    }

    // Gate 2: lane has at least one affinity member.
    const laneMembers = byLane.get(t.lane) ?? [];
    if (laneMembers.length === 0) {
      out.push({
        kind: "skip-no-lane-members",
        taskId: t.id,
        lane: t.lane,
        reason: `no team member has lane='${t.lane}'`,
      });
      continue;
    }

    // Gate 3: every lane-affinity member non-shipping.
    const shippingMember = laneMembers.find((m) => m.verdict === "shipping");
    if (shippingMember !== undefined) {
      out.push({
        kind: "skip-some-shipping",
        taskId: t.id,
        lane: t.lane,
        reason: `member '${shippingMember.name}' is shipping (verdict=shipping)`,
      });
      continue;
    }
    // Defensive: all members must carry a stall-verdict, not some
    // unknown literal. Treat unknown verdicts as "not shipping" via
    // the set check — keeps the decision permissive in the face of
    // T5 adding new verdicts without breaking the gate.
    const allInStallSet = laneMembers.every((m) =>
      STALL_VERDICTS.has(m.verdict) || m.verdict === "shipping"
        ? STALL_VERDICTS.has(m.verdict)
        : true,
    );
    if (!allInStallSet) {
      // Unreachable in practice: the shipping branch above caught
      // shipping; this only fires if a future verdict were added
      // outside the set AND outside shipping. Leave as a placeholder
      // skip kind for forward-compat.
      out.push({
        kind: "skip-some-shipping",
        taskId: t.id,
        lane: t.lane,
        reason: "unknown verdict in lane — treating as non-stall",
      });
      continue;
    }

    // Gate 4: dedup window.
    const recentFire = opts.dedup.find(
      (d) => d.taskId === t.id && d.lane === t.lane && opts.nowSec - d.firedAt < dedupWindowSec,
    );
    if (recentFire !== undefined) {
      const ageSec2 = opts.nowSec - recentFire.firedAt;
      out.push({
        kind: "skip-dedup",
        taskId: t.id,
        lane: t.lane,
        reason: `recent fire ${ageSec2}s ago (window ${dedupWindowSec}s)`,
      });
      continue;
    }

    // Fire: pick most-recently-active member; tiebreak by roster order.
    const target = pickTargetMember(laneMembers);
    out.push({
      kind: "fire",
      taskId: t.id,
      lane: t.lane,
      targetMember: target.name,
      reason: `lane-stall: task age ${ageSec}s, ${laneMembers.length} non-shipping member(s)`,
    });
  }

  return out;
}

/** Most-recently-active wins; ties broken by roster-order (input
 *  array order). Members without `lastActivityAt` rank last. */
function pickTargetMember(members: ReadonlyArray<LaneStallMemberInput>): LaneStallMemberInput {
  let best = members[0];
  if (best === undefined) {
    throw new Error("pickTargetMember called on empty member list");
  }
  let bestActivity = best.lastActivityAt ?? -1;
  for (let i = 1; i < members.length; i++) {
    const m = members[i];
    if (m === undefined) continue;
    const activity = m.lastActivityAt ?? -1;
    if (activity > bestActivity) {
      best = m;
      bestActivity = activity;
    }
  }
  return best;
}

// ---------- Dedup-state R/W ----------

/** Path resolver — pure (no IO). Per task body: `~/.atmux/state/
 *  lane-stall-fires.json`. The home dir is injectable via opts (so
 *  tests don't write into the operator's real `~/.atmux/`). */
export function dedupStatePath(homeDir: string): string {
  return join(homeDir, ".atmux", "state", "lane-stall-fires.json");
}

/** Read the dedup state. Returns the empty default when the file is
 *  absent (first-run case — never a hard error). Existing-but-
 *  malformed throws SchemaError per the ADR-005 "never silent
 *  fallback to defaults" rule. */
export async function readDedupState(homeDir: string): Promise<LaneStallDedupState> {
  return await readJsonOr(dedupStatePath(homeDir), LaneStallDedupStateSchema, EMPTY_DEDUP_STATE);
}

/** Append a fire entry to the dedup state under flock. Idempotent on
 *  `(taskId, lane)`: if a row for that pair already exists, its
 *  `firedAt` is bumped to `nowSec`. */
export async function appendDedupFire(homeDir: string, entry: LaneStallDedupEntry): Promise<void> {
  await ensureDir(join(homeDir, ".atmux", "state"));
  await updateJson(
    dedupStatePath(homeDir),
    LaneStallDedupStateSchema,
    (cur) => {
      const idx = cur.fires.findIndex((f) => f.taskId === entry.taskId && f.lane === entry.lane);
      if (idx === -1) {
        return { fires: [...cur.fires, entry] };
      }
      const next = cur.fires.slice();
      next[idx] = entry;
      return { fires: next };
    },
    { initial: EMPTY_DEDUP_STATE },
  );
}

/** Drop entries older than the dedup window. Run periodically by the
 *  verb to keep the state file bounded — without this, every long-
 *  lived task accumulates fire entries indefinitely. The verb calls
 *  this BEFORE the decision so stale entries don't gate fresh fires. */
export async function pruneDedupState(
  homeDir: string,
  nowSec: number,
  laneStallMinAgeSec: number,
): Promise<number> {
  const dedupWindowSec = Math.floor(laneStallMinAgeSec / 2);
  if (!(await exists(dedupStatePath(homeDir)))) return 0;
  let pruned = 0;
  await updateJson(
    dedupStatePath(homeDir),
    LaneStallDedupStateSchema,
    (cur) => {
      const kept = cur.fires.filter((f) => nowSec - f.firedAt < dedupWindowSec);
      pruned = cur.fires.length - kept.length;
      if (pruned === 0) return cur;
      return { fires: kept };
    },
    { initial: EMPTY_DEDUP_STATE },
  );
  return pruned;
}

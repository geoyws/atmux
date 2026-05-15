// ADR-132 §D5 / T6 (t-a6a1c9ab): the load-bearing escalation gate.
//
// Sole authority on whether a Martinet impl's (Observation,
// ObservationHistory) pair warrants waking the Claude lead. This
// classifier sits BETWEEN every Martinet impl and the cockpit-W3
// dispatcher — without it, non-Claude impls could under-escalate
// judgment-class scenarios (the "0 commits overnight while panes
// stay green" failure mode pinned in global CLAUDE.md "Don't make
// a dormant team look like a working team" + whip §0.05).
//
// Six §D5 triggers — file-scope canonical mapping kept in sync
// with `EscalationReason` in src/abstractions/martinet.ts:
//   E1 wedged-after-nudge      — member queued-text >15min after
//                                an enter-push attempt
//   E2 hygiene-blocker-p0      — P0 ADR-131 fingerprint (ghost-
//                                owner | lane-mismatch) wedged ≥4h
//   E3 merge-conflict-or-push  — pending git-permission denial
//                                surfaced by apply() (force-push
//                                refused, destructive op refused)
//   E4 inbox-unprocessed       — .atmux/driver-inbox.md entry
//                                unread for ≥2 ticks
//   E5 low-confidence-streak   — impl decide() flagged low-
//                                confidence on 3+ consecutive ticks
//   E6 ship-zero-2hr           — 0 commits across root + submodules
//                                in last 2hr (MANDATORY — T2 header
//                                guarantees the floor regardless
//                                of which impl is active)
//
// Misclassification posture (per task body):
//   - Over-escalation is acceptable (cheap: one extra lead ping).
//   - Under-escalation is the failure mode that ends up on Reddit
//     (whip §0.05). Detector defaults err on the over-fire side.
//
// `ObservationHistory` is intentionally exported here, not in
// martinet.ts, because it is a *dispatcher-owned* contract — the
// cockpit-W3 tick loop maintains the history across calls. Each
// Martinet impl is stateless within its own observe()/decide()
// pair; the dispatcher threads history in alongside the per-tick
// Observation. This keeps `Martinet` cage-portable and serialisable.

import type { EscalationReason, Observation } from "../abstractions/martinet.ts";

// ---------- Thresholds (file-scope so tests can pin against the
// SAME numbers the implementation enforces) ----------

/** E1 gate — minutes of queued-text-after-enter-push before fire.
 *  Task body: "member queued-text >15min after Enter-push". */
const E1_WEDGED_AFTER_NUDGE_MIN = 15;

/** E2 gate — minutes of P0 hygiene wedge before fire. T2 header
 *  comment on `WedgeFingerprint.wedgedMin` names this as the
 *  "P0 wedge ≥4h" gate. */
const E2_HYGIENE_P0_WEDGED_MIN = 240;

/** E4 gate — driver-inbox tick-age (count of ticks an entry has
 *  been present without operator-ack) before fire. Task body:
 *  "unread for >2 ticks" → ≥2 inclusive. */
const E4_INBOX_TICK_AGE_THRESHOLD = 2;

/** E5 gate — consecutive low-confidence ticks before fire. Task
 *  body: "low-confidence output 3+ ticks in a row". */
const E5_LOW_CONFIDENCE_STREAK_THRESHOLD = 3;

/** ADR-131 §D2 severity-P0 fingerprint classes. Only these classes
 *  trigger the E2 gate; role-mismatch (P1), lane-null-orphan (P3),
 *  and prio-null (P3) are auto-fixed by the superdoctor hygiene
 *  drain without surfacing to the lead. Co-located here rather
 *  than imported from `superdoctor-hygiene/_shared.ts` so the
 *  classifier remains free of detector-side coupling. */
const P0_HYGIENE_CLASSES: ReadonlyArray<string> = ["ghost-owner", "lane-mismatch"];

// ---------- Public types ----------

/** Per-member git-permission denial recorded by the dispatcher
 *  after `apply()` refused a destructive op (force-push, branch
 *  delete, etc.). Cleared by the dispatcher once the operator
 *  unblocks the team. Drives E3. */
export interface GitDenialEvent {
  member: string;
  op: string;
}

/** Driver-inbox entry tracked by the dispatcher across ticks.
 *  `tickAge` is incremented each tick the entry remains visible
 *  without operator acknowledgement. Drives E4. */
export interface InboxEntryAgeEvent {
  /** Stable identifier — typically the entry header (timestamp +
   *  first-line excerpt) so the dispatcher can match across ticks
   *  even when the file is reordered. */
  id: string;
  /** Tick count since first observation. 0 on the tick the entry
   *  was first seen; increments by 1 on every subsequent tick
   *  while the entry is still present. */
  tickAge: number;
}

/** Cross-tick state the dispatcher threads into classify() so the
 *  classifier can resolve temporal gates (E1, E3, E4, E5). E2 and
 *  E6 are pure functions of the current Observation and do not
 *  read history — they are documented here for completeness only.
 *
 *  The dispatcher mutates history between ticks; the classifier
 *  treats history as immutable input. */
export interface ObservationHistory {
  /** Member-name → epoch-ms map. Records the timestamp of the most
   *  recent successful `apply({ kind: "enter-push", member })`.
   *  Cleared per-member when the dispatcher observes the member's
   *  composer-buffer change (queue-text drift = the nudge took
   *  effect, no longer wedged). Drives E1. */
  readonly enterPushedAt: Readonly<Record<string, number>>;
  /** Consecutive trailing-tick count of "low-confidence" decide()
   *  emissions from the active Martinet impl. Reset to 0 on any
   *  high-confidence tick. Drives E5. The dispatcher determines
   *  the low-confidence flag from the impl's `NudgeAction.reason`
   *  text or out-of-band signal — the classifier just consumes
   *  the running count. */
  readonly lowConfidenceStreak: number;
  /** Driver-inbox entries pending operator-ack, with their tick
   *  ages. The classifier fires E4 when ANY entry has tickAge
   *  ≥ E4_INBOX_TICK_AGE_THRESHOLD. */
  readonly inboxEntries: ReadonlyArray<InboxEntryAgeEvent>;
  /** Active git-permission denials surfaced by apply(). Non-empty
   *  triggers E3 unconditionally. */
  readonly pendingGitDenials: ReadonlyArray<GitDenialEvent>;
}

// ---------- Classifier ----------

/** Derive the set of §D5 escalation triggers active on a given
 *  (Observation, ObservationHistory) pair. Returned array is
 *  deduplicated and ordered E1→E6 for log-readability. Empty
 *  array means no escalation; caller should still gate via
 *  shouldEscalate() for forward-compat (additional reasons may
 *  be added later without changing the boolean contract).
 *
 *  E6 (`ship-zero-2hr`) is enforced unconditionally — per the
 *  T2 header guarantee that the classifier hard-codes the
 *  mandatory floor above per-impl judgment. */
export function classify(
  obs: Observation,
  history: ObservationHistory,
): EscalationReason[] {
  const reasons: EscalationReason[] = [];

  // E1: wedged-after-nudge
  const nowMs = obs.lastTickAt;
  const e1WindowMs = E1_WEDGED_AFTER_NUDGE_MIN * 60 * 1000;
  for (const m of obs.members) {
    // Must still be enter-pushable AND still have queued text. If
    // either has cleared, the nudge took effect (or the pane state
    // changed in a way that supersedes the wedge).
    if (m.queuedComposerText == null) continue;
    if (!m.lastEnterPushable) continue;
    const pushedAt = history.enterPushedAt[m.name];
    if (pushedAt == null) continue;
    if (nowMs - pushedAt > e1WindowMs) {
      reasons.push("wedged-after-nudge");
      break;
    }
  }

  // E2: hygiene-blocker-p0
  const p0Set = new Set(P0_HYGIENE_CLASSES);
  for (const w of obs.kanbanDelta.wedgedClaims) {
    if (p0Set.has(w.class) && w.wedgedMin >= E2_HYGIENE_P0_WEDGED_MIN) {
      reasons.push("hygiene-blocker-p0");
      break;
    }
  }

  // E3: merge-conflict-or-push
  if (history.pendingGitDenials.length > 0) {
    reasons.push("merge-conflict-or-push");
  }

  // E4: inbox-unprocessed
  if (
    history.inboxEntries.some((e) => e.tickAge >= E4_INBOX_TICK_AGE_THRESHOLD)
  ) {
    reasons.push("inbox-unprocessed");
  }

  // E5: low-confidence-streak
  if (history.lowConfidenceStreak >= E5_LOW_CONFIDENCE_STREAK_THRESHOLD) {
    reasons.push("low-confidence-streak");
  }

  // E6: ship-zero-2hr — MANDATORY floor (T2 header).
  // Two complementary paths fire E6:
  //
  //   (a) Team-aggregate gate (pre-ADR-148): `obs.commitCadence
  //       .last2hr === 0` — zero commits across root + submodules
  //       in the last 2 hours. The original `ship-zero-2hr` shape.
  //
  //   (b) Per-member cadence verdict (ADR-148 T5 / t-ac95b267):
  //       ANY member's `cadence.verdict === "ship-zero-window"`
  //       (commitsInWindow === 0 AND ageOfLastCommitSec ≥
  //       shipZeroWindowSec; default 2hr per
  //       DEFAULT_CADENCE_THRESHOLDS.shipZeroWindowSec). This is
  //       the canonical ground-truth signal per ADR-148 §D1 + §D2
  //       — a member's cadence verdict directly maps to the
  //       escalation channel.
  //
  // Both paths share the `ship-zero-2hr` reason literal because the
  // closed `EscalationReason` enum doesn't grow per-source variants
  // (the EscalationReason set is intentionally bounded per §D5).
  // The dispatcher's logged evidence threads the FIRST source that
  // fires so operators can see which path tripped (status.ts surfaces
  // both via the cadence column + the commitCadence sweep counts).
  if (obs.commitCadence.last2hr === 0) {
    reasons.push("ship-zero-2hr");
  } else if (
    obs.members.some(
      (m) =>
        m.cadence !== undefined && m.cadence.verdict === "ship-zero-window",
    )
  ) {
    reasons.push("ship-zero-2hr");
  }

  return reasons;
}

/** Aggregate the classify() output into the boolean the dispatcher
 *  branches on. Returns true iff at least one §D5 trigger fired.
 *  Sole authority on the pre-empt-and-escalate path — Martinet
 *  impls MUST funnel their escalation decisions through this
 *  function (the impl's own `shouldEscalateToClaudeLead` may
 *  escalate ABOVE this floor but never below). */
export function shouldEscalate(
  reasons: ReadonlyArray<EscalationReason>,
): boolean {
  return reasons.length > 0;
}

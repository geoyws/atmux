// ADR-177: Whip Velocity-Gate — ground-truth velocity classifier.
//
// Pure module. Inputs: ground-truth signals (commits-in-window count,
// last-commit-age in minutes, in-progress task count). Output: a
// verdict tag + reason string that whip.ts consumes to decide whether
// to nudge the lead pane (BAD) or pass quietly (OK / STANDBY).
//
// Why a pure classifier separate from the whip orchestrator: the
// existing whip pattern (1826 LOC at HEAD) couples I/O + classify +
// dispatch in `runTick`. ADR-177 §Spec splits the classify step out
// so the verdict logic is unit-testable against mocked inputs (Task
// body: "bun-test unit on classifier (mocked inputs)"), the wiring
// can iterate independently of the rule, and a future sibling probe
// (cockpit-pulse / superdoctor) can reuse the same classifier.
//
// The classifier is OUT OF SCOPE for fake-liveness signal sources
// (lead self-report tokens / "analysis" prose / `thinking with` pane
// banners). Per the operator-observed failure mode that drove
// ADR-177 (10 zero-commit heartbeats over 4.5h on 2026-05-14): the
// whole point is to NOT consume lead self-report — only ground-truth
// post-fact evidence (commits landed + kanban transitions). The
// pane-state input is included not as a velocity signal but as an
// idle-gate guard (don't classify BAD on a wedged pane — those
// strikes are noise; whip's existing checkMember logic surfaces
// wedge separately).

/** Verdict tag emitted by the classifier. Maps 1:1 to Task body
 *  classification:
 *  - `OK`     — ≥1 ground-truth commit in window
 *  - `STANDBY` — recent ship within standby grace, idle lead
 *  - `BAD`    — 0 commits in window AND nothing progressing
 *
 *  Tag is the only field whip.ts switches on; the reason string is
 *  for log / strike-counter audit. */
export type VelocityVerdict = "OK" | "STANDBY" | "BAD";

/** Idle-gate / classifier-swallow guard tags surfaced via the
 *  `paneSignal` input. Mirrors a thin subset of `core/pane-state.ts`
 *  classifications — the classifier doesn't need the full taxonomy,
 *  only "is the lead pane reachable for keystroke injection." */
export type PaneSignal =
  /** Lead pane is at a ready prompt — safe to send keystrokes. */
  | "READY"
  /** Lead pane is mid-think / mid-rate-limit / compacting — keystroke
   *  injection would be swallowed or merge with queued text. Skip the
   *  BAD nudge this tick (still bump strikes if velocity is BAD —
   *  classifier-swallow is itself a wedge symptom per Task body §3). */
  | "BUSY"
  /** Lead pane unreachable (no tmux window, no `claude` in pane).
   *  Treat as wedge — escalate via existing checkMember path, NOT
   *  velocity-gate. Classifier still returns its verdict but whip.ts
   *  should NOT send keystrokes on UNREACHABLE. */
  | "UNREACHABLE";

export interface VelocityInputs {
  /** Count of ground-truth commits within `windowMin` lookback. Source
   *  of truth is `git log --all --since=<windowMin>m` (or a kanban
   *  query for `commits` tasks, depending on caller). Zero is the
   *  trigger for BAD. */
  commitsInWindow: number;
  /** Minutes since the most recent ground-truth commit. `null` when
   *  the repo has zero commits (fresh team, pre-bootstrap) — treated
   *  as "infinitely stale" by the classifier. */
  lastCommitAgeMin: number | null;
  /** Count of in-progress kanban tasks across the team. Non-zero
   *  in-progress with zero commits is the "lead self-reports thinking
   *  for 4h" failure mode the classifier exists to surface. */
  inProgressTaskCount: number;
  /** Lead pane reachability signal — see {@link PaneSignal} for the
   *  thin classification. Only affects whether whip.ts ACTS on BAD,
   *  not whether the classifier returns BAD. */
  paneSignal: PaneSignal;
  /** Sliding window in minutes (matches `team.whip.velocityGate.windowMin`
   *  schema default 60). */
  windowMin: number;
  /** Standby grace window in minutes (matches
   *  `team.whip.velocityGate.standbyGraceMin` schema default 30).
   *  When `lastCommitAgeMin <= standbyGraceMin`, a 0-commit-in-window
   *  case is downgraded from BAD to STANDBY — the team just shipped
   *  and the lead is reading the next Task. */
  standbyGraceMin: number;
}

export interface VelocityClassification {
  verdict: VelocityVerdict;
  /** Human-readable rationale for log + strike-counter audit. Short,
   *  one line. Format: `"<verdict>: <fact list separated by ' · '>"`. */
  reason: string;
}

/** Default sliding window — matches `TeamWhip.velocityGate.windowMin`
 *  default. Exported so whip.ts call-sites that haven't loaded the
 *  team config yet (defensive fallback) can use the same constant. */
export const DEFAULT_VELOCITY_WINDOW_MIN = 60;

/** Default standby grace — matches `TeamWhip.velocityGate.standbyGraceMin`. */
export const DEFAULT_STANDBY_GRACE_MIN = 30;

/** Default strike threshold — matches
 *  `TeamWhip.velocityGate.strikeThreshold`. Surfaced here so the
 *  whip-strikes module can reuse the same number when no team
 *  config is in scope. */
export const DEFAULT_STRIKE_THRESHOLD = 3;

/**
 * Pure classifier. Resolution order:
 *
 * 1. `commitsInWindow >= 1`                              → OK
 * 2. `lastCommitAgeMin !== null && <= standbyGraceMin`   → STANDBY
 *    (someone shipped recently — assume lead is reading next task,
 *    don't strike for the brief silence between Tasks)
 * 3. `inProgressTaskCount === 0 && commitsInWindow === 0` → STANDBY
 *    (nothing claimed → nothing to ship → quiet is correct; no work
 *    queued is a planner concern, not a velocity-gate concern)
 * 4. otherwise                                            → BAD
 *
 * Pane signal does NOT affect the verdict — only whether whip.ts
 * acts on BAD this tick. Per Task body §3 the wedge case (paneSignal
 * !== READY) is itself a strike symptom (classifier-swallow):
 * keystrokes get dropped, so the *fact* of BAD is unchanged; whip.ts
 * skips the keystroke this tick and increments strikes (the existing
 * checkMember wedge path handles the pane-state escalation
 * separately).
 */
export function classifyVelocity(inputs: VelocityInputs): VelocityClassification {
  const { commitsInWindow, lastCommitAgeMin, inProgressTaskCount, windowMin, standbyGraceMin } =
    inputs;

  if (commitsInWindow >= 1) {
    return {
      verdict: "OK",
      reason: `OK: ${commitsInWindow} commit${commitsInWindow === 1 ? "" : "s"} in last ${windowMin}min`,
    };
  }

  if (lastCommitAgeMin !== null && lastCommitAgeMin <= standbyGraceMin) {
    return {
      verdict: "STANDBY",
      reason: `STANDBY: last commit ${lastCommitAgeMin}min ago (within ${standbyGraceMin}min grace) · ${inProgressTaskCount} in-progress`,
    };
  }

  if (inProgressTaskCount === 0) {
    return {
      verdict: "STANDBY",
      reason: `STANDBY: 0 commits in ${windowMin}min · 0 in-progress (nothing to ship)`,
    };
  }

  const ageFact =
    lastCommitAgeMin === null ? "no prior commits" : `last commit ${lastCommitAgeMin}min ago`;
  return {
    verdict: "BAD",
    reason: `BAD: 0 commits in ${windowMin}min · ${ageFact} · ${inProgressTaskCount} in-progress (stalled)`,
  };
}

/** Convenience: true when whip.ts should attempt the keystroke this
 *  tick. Centralized so the caller doesn't restate the condition
 *  (verdict === BAD && paneSignal === READY) at every wire-up site. */
export function shouldNudgeLeadPane(
  classification: VelocityClassification,
  paneSignal: PaneSignal,
): boolean {
  return classification.verdict === "BAD" && paneSignal === "READY";
}

/** Convenience: true when whip.ts should bump the strike counter
 *  this tick. Distinct from {@link shouldNudgeLeadPane} because BAD
 *  on a non-READY pane is ALSO a strike (classifier-swallow per Task
 *  body §3). Only OK + STANDBY suppress the bump. */
export function shouldIncrementStrike(classification: VelocityClassification): boolean {
  return classification.verdict === "BAD";
}

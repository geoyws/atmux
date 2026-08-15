// ADR-273 D4/D5: `pane_nudge` — the BOUNDED half of pane input.
//
// This module is the ACTION ALLOW-LIST, the after-state classifier, and
// the receipt renderer. It performs no IO: `src/verbs/nudge.ts` reads the
// pane and delivers the keystroke, then hands the observations here. Same
// split as `src/core/voice/fleet.ts` (classifier) vs `src/verbs/fleet.ts`
// (sweep), and for the same reason — every rule below is testable against
// a fixture rather than against whatever the live fleet is doing.
//
// ---------------------------------------------------------------------
// D4 — why this tool can ship while `pane_send` cannot
// ---------------------------------------------------------------------
//
// ADR-273 D4 splits pane input in two by BLAST RADIUS, not by verb shape:
// `pane_send` types operator-supplied text into an agent with full tool
// access, which is a request for arbitrary action and inherits ADR-272
// §Deferred's second-factor requirement (OQ-1, an operator decision that
// has not been made). `pane_nudge` sends either a bare submit or ONE
// string chosen from {@link NUDGE_ACTION_SPECS} — a frozen, in-code table.
//
// **There is no free-text escape hatch here, and adding one would silently
// convert this tool into `pane_send`.** The bound is structural: the voice
// catalog declares `action` as a zod ENUM, and the argv the verb receives
// carries the enum NAME, never a phrase. The pasted text is a compile-time
// constant looked up from that name.
//
// ---------------------------------------------------------------------
// D5 — delivery is a RECEIPT, not a claim
// ---------------------------------------------------------------------
//
// "I pressed Enter" is a claim; "the composer cleared and the agent is now
// working" is a receipt. The verb therefore reads the pane AFTER the send
// and classifies it with the fleet classifier — the same observation the
// survey already makes, so a nudge's verdict and a sweep's verdict cannot
// disagree about the same pane.
//
// {@link classifyAfterNudge} is the one place that classifier is NOT used
// verbatim, and the reason is load-bearing: see its doc comment.

import {
  ATTENTION_REASON,
  classifyPaneObservation,
  extractComposerResidue,
  type PaneObservation,
  type PaneVerdict,
  QUIET_LABEL,
  tailWindow,
} from "./fleet.ts";
import { stripAnsi } from "./summarize.ts";

// ---------- The allow-list ----------

/** Every action `pane_nudge` can perform. Frozen, and the voice catalog
 *  declares it as a zod enum — so a transcript can select one, never
 *  author one. */
export const NUDGE_ACTIONS = ["submit", "continue"] as const;

export type NudgeAction = (typeof NUDGE_ACTIONS)[number];

export interface NudgeActionSpec {
  /**
   * Text pasted into the composer before the submit, or `null` for a
   * BARE submit (no paste at all — `atmux send --submit-only`).
   *
   * A constant. Nothing an operator says reaches this field.
   */
  text: string | null;
  /** The clause the operator hears inside the confirm preview. */
  preview: string;
  /** The clause the receipt uses to say what was done. */
  did: string;
  /** The `fleet_attention` classes this action is the answer to — so a
   *  reader can see the allow-list is derived from observed findings
   *  rather than from imagination. */
  answers: ReadonlyArray<string>;
}

/**
 * The frozen action table.
 *
 * Two entries, and each exists because a `fleet_attention` class exists
 * that it answers. A third would be speculative: an action nothing on the
 * fleet asks for is an unbounded capability bought for nothing.
 *
 * - **`submit`** answers `idle-residue` (the 2am wedge: text sitting in a
 *   composer nobody submitted) and `permission-prompt` (Claude Code's
 *   modals are dismissed by the default selection — `Enter to confirm` is
 *   literally one of the strings the classifier matches on). It pastes
 *   NOTHING, so it cannot corrupt the residue it is submitting.
 * - **`continue`** answers a pane that stopped with an EMPTY composer
 *   (`dormant`, and some `frozen` cases). Pasting one word into an empty
 *   composer is safe; pasting it onto residue would concatenate, which is
 *   why `submit` exists as a separate action rather than as `continue`
 *   with an empty string.
 */
export const NUDGE_ACTION_SPECS: Readonly<Record<NudgeAction, NudgeActionSpec>> = Object.freeze({
  submit: {
    text: null,
    preview:
      "press Enter to submit whatever is already sitting in that pane's composer; nothing is typed",
    did: "pressed Enter to submit what was already in the composer",
    answers: ["idle-residue", "permission-prompt"],
  },
  continue: {
    text: "continue",
    preview: 'type the single word "continue" into that pane and submit it',
    did: 'typed "continue" and submitted it',
    answers: ["dormant", "frozen"],
  },
});

/** Type guard for an operator-supplied action name. */
export function isNudgeAction(s: string): s is NudgeAction {
  return (NUDGE_ACTIONS as ReadonlyArray<string>).includes(s);
}

// ---------- Confirm preview (ADR-272 D7) ----------

/**
 * The preview the model reads aloud VERBATIM before redeeming a token.
 *
 * It names the exact TARGET (team + member) and the exact ACTION, because
 * the failure this gate exists to catch is a misheard team or member name
 * nudging the wrong agent — and a preview that says only "confirm pane
 * nudge" would let that through unnoticed.
 *
 * Falls back to the default action rather than throwing: this runs on
 * ALREADY-VALIDATED args, and a preview that threw would strand the
 * provider's tool turn.
 */
export function nudgeConfirmPreview(args: Record<string, unknown>, team: string | null): string {
  const member =
    typeof args.member === "string" && args.member.length > 0 ? args.member : "unnamed";
  const raw = typeof args.action === "string" ? args.action : "";
  const action: NudgeAction = isNudgeAction(raw) ? raw : "submit";
  const where = team === null ? `member ${member}` : `${member} on team ${team}`;
  return `Confirm nudge: ${where} — ${NUDGE_ACTION_SPECS[action].preview}. Say yes to proceed.`;
}

// ---------- After-state classification ----------

/** Longest speakable evidence marker (mirrors the fleet renderer's cap). */
const MARKER_MAX_CHARS = 70;

function cap(raw: string): string {
  return raw.length > MARKER_MAX_CHARS ? `${raw.slice(0, MARKER_MAX_CHARS - 1)}…` : raw;
}

/**
 * Classify the pane AFTER a nudge.
 *
 * **Not `classifyPaneObservation` unmodified, and this is the difference
 * between a receipt and a lie.** That classifier treats composer residue
 * in a window tmux saw activity in within the last minute as *someone is
 * typing* (`RESIDUE_FRESH_SEC`) and files it under `quiet: idle`. For a
 * survey that is correct — it stops the tool reporting the pane the
 * operator is mid-sentence in. Here it is exactly wrong: the recent
 * activity is OUR OWN paste, a second ago. Left alone, a nudge that
 * changed nothing at all would be reported as "idle and clear", i.e. the
 * tool would announce success for a failure.
 *
 * So: when the base classifier lands on `quiet: idle` and residue is
 * STILL in the composer, the verdict is `idle-residue`. The override is
 * deliberately narrow — `quiet: idle` is the only bucket the freshness
 * exemption can dump residue into, and widening it would let a genuinely
 * working pane (whose tail can carry a stale `❯` line) be reported as
 * wedged.
 */
export function classifyAfterNudge(obs: PaneObservation): PaneVerdict {
  const verdict = classifyPaneObservation(obs);
  if (verdict.bucket !== "quiet" || verdict.kind !== "idle" || obs.capture === null) {
    return verdict;
  }
  const residue = extractComposerResidue(tailWindow(stripAnsi(obs.capture)));
  if (residue === null) return verdict;
  return {
    bucket: "attention",
    kind: "idle-residue",
    marker: cap(`still unsubmitted: ${residue}`),
  };
}

// ---------- Receipt ----------

export interface NudgeReceipt {
  team: string;
  member: string;
  /** The tmux window the keystroke actually went to — evidence that the
   *  member name resolved to the pane the operator meant. */
  windowName: string;
  action: NudgeAction;
  before: PaneVerdict;
  after: PaneVerdict;
}

/** Stable key for verdict equality — the two verdict shapes carry
 *  different fields, so compare what both always have. */
function verdictKey(v: PaneVerdict): string {
  return `${v.bucket}:${v.kind}`;
}

/** One spoken clause for a verdict: what it is, plus the evidence when
 *  the verdict is a finding. */
export function describeVerdict(v: PaneVerdict): string {
  return v.bucket === "quiet" ? QUIET_LABEL[v.kind] : `${ATTENTION_REASON[v.kind]} — ${v.marker}`;
}

/**
 * The verdict sentence — the line that says whether the nudge WORKED.
 *
 * Derived entirely from the before/after pair, never from the fact that a
 * send was issued. That is the whole point of D5: a tool that appears to
 * send and silently does not is worse than no tool, so "unchanged" has to
 * be a reachable, spoken outcome.
 */
export function nudgeOutcomeLine(before: PaneVerdict, after: PaneVerdict): string {
  if (verdictKey(before) === verdictKey(after)) {
    return "the pane is unchanged — the nudge did not take";
  }
  const cleared = before.bucket === "attention" && before.kind === "idle-residue";
  if (after.bucket === "quiet") {
    const tail =
      after.kind === "working"
        ? "the agent is now working"
        : `the pane is now ${QUIET_LABEL[after.kind]}`;
    return cleared ? `the composer cleared and ${tail}` : tail;
  }
  return `the pane moved but still needs you — now ${ATTENTION_REASON[after.kind]}`;
}

/** True when the receipt records a nudge that changed nothing. The verb
 *  exits non-zero on this, so a nudge that did not take cannot read as
 *  success in a shell OR in a spoken tool envelope. */
export function nudgeDidNotTake(r: NudgeReceipt): boolean {
  return verdictKey(r.before) === verdictKey(r.after);
}

/**
 * Render the spoken receipt. Line-structural, so the voice summarizer's
 * budget truncation drops whole trailing lines — and the verdict sentence
 * is last on purpose only because the two evidence lines above it are
 * short enough that no realistic budget reaches it.
 *
 * Shape:
 *   NUDGE atmux/be-1 (window ⚙be-1) — pressed Enter to submit what was already in the composer
 *   before: idle with unsubmitted text — unsubmitted: claim --next
 *   after: working
 *   the composer cleared and the agent is now working
 */
export function renderNudgeReceipt(r: NudgeReceipt): string {
  return [
    `NUDGE ${r.team}/${r.member} (window ${r.windowName}) — ${NUDGE_ACTION_SPECS[r.action].did}`,
    `before: ${describeVerdict(r.before)}`,
    `after: ${describeVerdict(r.after)}`,
    nudgeOutcomeLine(r.before, r.after),
  ].join("\n");
}

// EPIC e-f28c2596 T1 — detect stuck queued text in a worker compose box and
// (when safe) resubmit it via an injected send-keys-with-verify dep.
//
// Background: cron-fired hot-loop verbs (poke / lane-tick) observe member panes
// where the next loop command (`/loop /whip`, `claim --next`, etc.) was typed
// into the composer but Enter never fired. Without intervention the queued text
// sits indefinitely; the cage looks alive but no progress lands. The fix
// invariably requires going through ADR-138's `safeSendKeysWithVerify` (raw
// `tmux send-keys` Enter is unreliable in that UI state — see memory
// `feedback_atmux_send_for_queued_panes`).
//
// This helper is the pure detection + dispatch core; verbs construct the
// `sendKeysFn` closure around `safeSendKeysWithVerify` and the `failureLogFn`
// closure around the send-keys-failures.log writer (ADR-168), then call us
// per-member with a fresh pane capture. No tmux / fs calls live inside.

export type QueuedResubmitActionKind = "noop" | "skip" | "fire" | "log-failure";

/** Result returned by the injected send-keys-with-verify dep. Shape matches
 *  the subset of `SafeSendKeysWithVerifyResult` (ADR-138) the helper needs
 *  to decide whether the fire succeeded. */
export interface QueuedResubmitSendResult {
  success: boolean;
  attempts: number;
  finalCapture: string;
}

export type QueuedResubmitSendKeysFn = (text: string) => Promise<QueuedResubmitSendResult>;

export type ClockFn = () => number;

/** Failure log entry payload — written when the resubmit fired but the
 *  verifier exhausted without observing a state transition (post-fire
 *  no token-delta). Caller-constructed `failureLogFn` decides the on-disk
 *  shape; we hand it the structured payload. */
export interface QueuedResubmitFailureEntry {
  /** `clockFn()` at decision time — caller formats per its log convention. */
  timestampMs: number;
  /** Text the helper observed in the composer + attempted to resubmit. */
  text: string;
  /** Pane capture as observed pre-fire — useful for post-incident triage. */
  preCapture: string;
  /** Result returned by `sendKeysFn` — attempts + finalCapture for forensics. */
  sendResult: QueuedResubmitSendResult;
}

export type QueuedResubmitFailureLogFn = (entry: QueuedResubmitFailureEntry) => Promise<void>;

export interface QueuedResubmitAction {
  kind: QueuedResubmitActionKind;
  /** Human-readable rationale — surfaces verbatim into verb logs + Discord
   *  pings so operators can disambiguate "skipped 4 panes mid-turn" from
   *  "fired 3, logged 1 stuck after retry". */
  reason: string;
  /** Captured composer text. Present for `skip` / `fire` / `log-failure`
   *  (anything where queued text was observed). Absent for `noop`. */
  text?: string;
  /** Result of the send attempt. Present for `fire` / `log-failure`. */
  sendResult?: QueuedResubmitSendResult;
  /** `clockFn()` at decision time. Always present — callers stamp their
   *  log rows from this so the helper's view of "now" stays internally
   *  consistent across the action + the failure log entry. */
  timestampMs: number;
}

/**
 * Composer prompt regex — Claude Code TUI renders the live compose box as a
 * `❯ ` glyph at start-of-line followed by the (optional) queued text. We scan
 * the capture bottom-up to find the LAST `❯ ` line (the live composer; older
 * `❯` glyphs in scrollback belong to prior turns).
 *
 * Per memory `feedback_residue_claim_text_not_queued_enter`: the composer
 * may render its glyph offset by leading whitespace inside box-drawing
 * borders (e.g. `│ ❯ claim --next`). Match `❯` anywhere on the line and
 * capture the trailing text after the first whitespace run.
 */
const COMPOSER_LINE_RE = /❯\s*(.*?)\s*$/;

/**
 * Active-turn indicators — presence of any of these in the capture means the
 * agent is mid-turn (or freshly finished within the spinner's visible window).
 * We intentionally include the spinner glyphs `✻`/`✶`/`✽` per the EPIC fix
 * sketch + T5 test contract — the helper treats glyph-presence as a recency
 * marker and skips firing.
 *
 * NOTE: this is intentionally divergent from `safe-send.ts::AGENT_THINKING_RE`,
 * which also matches PAST-tense markers (`Worked`/`Cooked`/`Crunched`) for use
 * as a post-submit verifier. Here we want only ACTIVE markers — the past-tense
 * markers indicate the agent has finished + is idle, which is precisely when
 * we want to fire.
 */
const ACTIVE_TURN_RE =
  /(?:Cooking|Schlepping|Honking|Crunching|Cogitating|Brewing|Effecting|Imagining|Sautéeing|Kneading|Misting|Puttering|Grooving|Ruminating)\.{3}|… \(\d+m?s\)|[✻✶✽]/;

/**
 * Detect a stuck-text condition in `paneCapture` and (when safe) resubmit via
 * the injected `sendKeysFn` dep.
 *
 * Decision tree:
 *   1. Composer empty / absent → `noop`.
 *   2. Composer has queued text AND active-turn indicator present → `skip`
 *      (mid-turn — firing now would land into a thinking pane and either
 *      get dropped or land late into the NEXT prompt).
 *   3. Composer has queued text AND no active indicator → `fire` via
 *      `sendKeysFn`. On verifier success the helper returns `fire`; on
 *      verifier failure the helper invokes `failureLogFn` + returns
 *      `log-failure`.
 *
 * Pure-of-direct-IO: no tmux / process / fs calls inside — all side effects
 * flow through the injected deps. Enables unit testing all four state
 * branches without spinning up a real tmux session.
 *
 * Cross-refs: ADR-138 (safeSendKeysWithVerify), ADR-168 (send-keys-failures
 * log + rotation policy), memory `feedback_atmux_send_for_queued_panes`,
 * memory `feedback_residue_claim_text_not_queued_enter`.
 */
export async function detectAndResubmit(
  paneCapture: string,
  sendKeysFn: QueuedResubmitSendKeysFn,
  clockFn: ClockFn,
  failureLogFn: QueuedResubmitFailureLogFn,
): Promise<QueuedResubmitAction> {
  const timestampMs = clockFn();
  const queued = extractQueuedText(paneCapture);

  if (queued === null) {
    return {
      kind: "noop",
      reason: "composer empty or absent — no queued text observed",
      timestampMs,
    };
  }

  if (ACTIVE_TURN_RE.test(paneCapture)) {
    return {
      kind: "skip",
      reason: "queued text observed but active-turn indicator present (mid-turn)",
      text: queued,
      timestampMs,
    };
  }

  const sendResult = await sendKeysFn(queued);

  if (sendResult.success) {
    return {
      kind: "fire",
      reason: `queued text resubmitted; verifier observed expected transition after ${sendResult.attempts} attempt(s)`,
      text: queued,
      sendResult,
      timestampMs,
    };
  }

  await failureLogFn({
    timestampMs,
    text: queued,
    preCapture: paneCapture,
    sendResult,
  });
  return {
    kind: "log-failure",
    reason: `queued text resubmit failed after ${sendResult.attempts} attempt(s) — verifier never observed expected transition`,
    text: queued,
    sendResult,
    timestampMs,
  };
}

/** Scan `capture` bottom-up for the last `❯ ` composer line and return the
 *  trailing text (trimmed). Returns `null` when no composer is present OR
 *  the composer is empty. Exported for unit-test convenience. */
export function extractQueuedText(capture: string): string | null {
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes("❯")) continue;
    const match = line.match(COMPOSER_LINE_RE);
    if (match === null) continue;
    const text = (match[1] ?? "").trim();
    return text === "" ? null : text;
  }
  return null;
}

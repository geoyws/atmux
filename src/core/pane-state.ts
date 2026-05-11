// ADR-057 §D1 R57-T1: pane-state classifier — single canonical state
// per tmux pane, derived from a regex pass over `tmux capture-pane`
// output. Drives `tmux.safeSendKeys` (added in src/abstractions/tmux.ts)
// to refuse / retry / escalate per state.
//
// Sister classifier `core/common.ts::classifyPaneState` returns a
// flag-snapshot (busy + rateLimit + compacting + contextCleared +
// queuedMessages) for callers that want to inspect each axis. THIS
// module returns a discrete enum + evidence string, intended for
// the safeSendKeys gate where a single decision is needed.
//
// 8 states (BUSY added per ADR-080 §C):
//   - READY        — prompt visible; safe to send keystrokes immediately.
//   - TYPING       — user has text in the compose box (queued message
//                    pending submit). Send would merge into the queue.
//   - BUSY         — agent mid-think (Claude Code spinner verb visible:
//                    `✻ Cooked for Ns`, `✽ Honking…`, etc.). Resolves
//                    when the turn completes; send merges into queue
//                    same as TYPING. Distinct from TYPING semantically:
//                    TYPING resolves on user submit, BUSY resolves on
//                    turn complete — different recovery paths.
//   - MODAL        — Claude Code is showing a permission / yes-no
//                    modal; sending text answers the wrong question.
//   - RATE-LIMIT   — "hit your limit" banner. Sending is futile until
//                    the budget refresh.
//   - COMPACTING   — "Compacting conversation" banner. Sending
//                    keystrokes during compaction loses the input.
//   - SHELL        — pane fell back to a shell (TUI crashed). Sending
//                    text would just type into the shell — useless.
//   - UNKNOWN      — pattern catalog didn't match anything; conservative
//                    default. Caller flags + skips.
//
// Pattern source: `core/common.ts` for the existing primitives, plus
// the TYPING / SHELL / MODAL discriminators new in this task.

import { now } from "../abstractions/time.ts";

// ---------- Public type ----------

export type PaneState =
  | "READY"
  | "TYPING"
  | "BUSY"
  | "MODAL"
  | "RATE-LIMIT"
  | "COMPACTING"
  | "SHELL"
  | "UNKNOWN";

export interface PaneClassification {
  state: PaneState;
  /** First substring of the captured text that matched the state's
   *  pattern. Empty when state === "READY" (no pattern fires there)
   *  or "UNKNOWN" (no pattern matched). */
  evidence: string;
  /** Epoch milliseconds at which the classification was made (helpful
   *  for cache-staleness checks higher in the call chain). */
  capturedAt: number;
}

// ---------- Patterns ----------
//
// Order matters — tested top-to-bottom; first match wins. The order
// reflects the safety hierarchy: a RATE-LIMIT pane is also COMPACTING
// in some cases, but RATE-LIMIT escalates first (the pane is
// fundamentally unable to accept input until budget refresh).
//
// Regexes use case-insensitive matching where the source UI text isn't
// stable — Claude Code's banners have varied casing across versions.

interface Pattern {
  state: PaneState;
  regex: RegExp;
}

const PATTERNS: ReadonlyArray<Pattern> = [
  // RATE-LIMIT — "hit your limit" or "approaching usage limit"
  { state: "RATE-LIMIT", regex: /hit your limit/i },
  { state: "RATE-LIMIT", regex: /You've hit your limit/i },
  // COMPACTING — context compaction in progress
  { state: "COMPACTING", regex: /Compacting conversation/i },
  // BUSY — agent mid-think; Claude Code spinner verbs / interrupt banner.
  // Priority: between COMPACTING and MODAL — a busy pane showing a modal
  // hint is mid-think and the modal will resolve when the turn completes
  // (per ADR-080 §C OQ-C1).
  { state: "BUSY", regex: /✻\s+\w+/ }, // "✻ Cooked for Ns" / "✻ Cooked for 12s"
  { state: "BUSY", regex: /✽\s+\w+/ }, // "✽ Honking…"
  {
    state: "BUSY",
    regex: /(Hullaball|Honking|Cogitat|Sauté|Ruminat|Computing|Thinking|Working|Cooked)(ing|ed|s)?\s*(\.\.\.|…)/i,
  },
  // Generic "esc to interrupt" banner — only appears during an active
  // turn (Claude Code does not render this when idle). 2026-05-09 ADR-080
  // §C audit: the prior `tokens.*esc to interrupt` READY pattern was
  // misclassifying busy panes as READY because the interrupt phrase only
  // ever shows up mid-turn. Removed from READY catalog below.
  { state: "BUSY", regex: /esc to interrupt/i },
  // MODAL — permission / decision modals
  // Common Claude Code modals: permission prompts, plan-mode approval,
  // auto-mode confirmation. These pause the agent until answered.
  { state: "MODAL", regex: /Do you want (Claude )?to/i },
  { state: "MODAL", regex: /Allow this tool to proceed/i },
  { state: "MODAL", regex: /\[y\/N\]:?\s*$/m },
  // Feedback survey modal (t-3e58a605 Path B). The survey blocks the
  // pane; recovery via known-modals catalog (src/core/known-modals.ts).
  { state: "MODAL", regex: /How is Claude doing this session/i },
  // TYPING — queued-message indicator (user text in compose box)
  { state: "TYPING", regex: /Press up to edit queued messages/i },
  // SHELL — pane fell back to a shell prompt (TUI crashed)
  // Patterns: bash/zsh prompt at end-of-buffer.
  { state: "SHELL", regex: /\$\s*$/m },
  { state: "SHELL", regex: /#\s*$/m },
  // READY — Claude Code's "ready for input" indicators.
  // The compose-box prompt is "❯" (U+276F HEAVY RIGHT-POINTING ANGLE
  // QUOTATION MARK ORNAMENT), NOT ASCII ">" — older versions used ">"
  // but current TUI ships "❯". The status-bar footer shows
  // "auto mode on" / "tok <N>k/<remaining>" / mode indicators when
  // the pane is awaiting input. Match either the prompt or the
  // status-line shape. (Pre-ADR-080 the catalog also had a
  // `tokens.*esc to interrupt` pattern — moved to BUSY above.)
  { state: "READY", regex: /^❯\s*$/m },
  { state: "READY", regex: /^>\s*$/m },
  // Border-prefixed bare prompt: the compose box renders as a single
  // line `│ > ` or `│ ❯ ` when the user has typed nothing. A pane in
  // this state with no `tok` footer (transient bootstrap, fresh /clear)
  // still classifies as READY — lane-tick's lead ctx-pct gate then sees
  // null and falls through to the normal claim injection per ADR-080 §A2.
  { state: "READY", regex: /^│\s+[>❯]\s*$/m },
  { state: "READY", regex: /⏵⏵\s+(auto mode|accept edits|don't ask|plan mode)/i },
  { state: "READY", regex: /^\s*tok\s+\d+(\.\d+)?k\/\d/m },
];

// ---------- Public API ----------

export type CaptureFn = (target: string) => Promise<string>;

/**
 * Classify the pane at `target` by capturing its current visible state
 * and matching against the pattern catalog. Returns READY when the
 * "ready prompt" pattern matches, UNKNOWN when nothing matches.
 *
 * `captureFn` is typically `tmux.pane.capturePane(...)` bound to a
 * target — we accept the function so the classifier stays
 * tmux-agnostic + easy to test.
 */
export async function classifyPane(
  target: string,
  captureFn: CaptureFn,
  nowMs: () => number = now,
): Promise<PaneClassification> {
  const text = await captureFn(target);
  return classifyText(text, nowMs);
}

/**
 * Synchronous classify-text helper — exposed for callers that
 * already have the pane-text in hand and don't want to redo the
 * capture (e.g., whip already runs capturePane for other checks).
 */
export function classifyText(text: string, nowMs: () => number = now): PaneClassification {
  for (const p of PATTERNS) {
    const match = p.regex.exec(text);
    if (match !== null) {
      return {
        state: p.state,
        evidence: match[0],
        capturedAt: nowMs(),
      };
    }
  }
  return { state: "UNKNOWN", evidence: "", capturedAt: nowMs() };
}

/** True when the pane state allows immediate send. */
export function isSendable(state: PaneState): boolean {
  return state === "READY";
}

/** True when the pane state is transient + retryable. */
export function isRetryable(state: PaneState): boolean {
  return state === "TYPING" || state === "COMPACTING" || state === "BUSY";
}

/** Per-state retry policy (ms between attempts, max attempts). */
export interface RetryPolicy {
  delayMs: number;
  maxAttempts: number;
}

export const RETRY_POLICY: Readonly<Record<PaneState, RetryPolicy>> = {
  READY: { delayMs: 0, maxAttempts: 1 },
  TYPING: { delayMs: 2_000, maxAttempts: 3 },
  BUSY: { delayMs: 5_000, maxAttempts: 6 }, // 30s total — agent turns finish in seconds
  COMPACTING: { delayMs: 5_000, maxAttempts: 6 }, // 30s total
  MODAL: { delayMs: 0, maxAttempts: 0 }, // no retry
  "RATE-LIMIT": { delayMs: 0, maxAttempts: 0 },
  SHELL: { delayMs: 0, maxAttempts: 0 },
  UNKNOWN: { delayMs: 0, maxAttempts: 0 },
};

/** Severity to flag at when sending refuses. Maps state → severity. */
export const REFUSAL_SEVERITY: Readonly<Record<PaneState, "p0" | "p1" | "p2" | "p3" | null>> = {
  READY: null,
  TYPING: "p3", // soft retryable; flag only if exhausted
  BUSY: "p3", // soft retryable; flag only if exhausted
  COMPACTING: "p3", // soft retryable; flag only if exhausted
  MODAL: "p3",
  "RATE-LIMIT": null, // ADR-053 budget-pause path takes over
  SHELL: "p2",
  UNKNOWN: "p2",
};

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
// 7 states per ADR-057 §D1:
//   - READY        — prompt visible; safe to send keystrokes immediately.
//   - TYPING       — user has text in the compose box (queued message
//                    pending submit). Send would merge into the queue.
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
  // MODAL — permission / decision modals
  // Common Claude Code modals: permission prompts, plan-mode approval,
  // auto-mode confirmation. These pause the agent until answered.
  { state: "MODAL", regex: /Do you want (Claude )?to/i },
  { state: "MODAL", regex: /Allow this tool to proceed/i },
  { state: "MODAL", regex: /\[y\/N\]:?\s*$/m },
  // TYPING — queued-message indicator (user text in compose box)
  { state: "TYPING", regex: /Press up to edit queued messages/i },
  // SHELL — pane fell back to a shell prompt (TUI crashed)
  // Patterns: bash/zsh prompt at end-of-buffer.
  { state: "SHELL", regex: /\$\s*$/m },
  { state: "SHELL", regex: /#\s*$/m },
  // READY — Claude Code's "ready for input" indicators. The empty-line
  // "tokens" footer + the "│ > " prompt are the canonical signals.
  { state: "READY", regex: /^>\s*$/m },
  { state: "READY", regex: /tokens.*esc to interrupt/i },
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
export function classifyText(
  text: string,
  nowMs: () => number = now,
): PaneClassification {
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
  return state === "TYPING" || state === "COMPACTING";
}

/** Per-state retry policy (ms between attempts, max attempts). */
export interface RetryPolicy {
  delayMs: number;
  maxAttempts: number;
}

export const RETRY_POLICY: Readonly<Record<PaneState, RetryPolicy>> = {
  READY: { delayMs: 0, maxAttempts: 1 },
  TYPING: { delayMs: 2_000, maxAttempts: 3 },
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
  COMPACTING: "p3", // soft retryable; flag only if exhausted
  MODAL: "p3",
  "RATE-LIMIT": null, // ADR-053 budget-pause path takes over
  SHELL: "p2",
  UNKNOWN: "p2",
};

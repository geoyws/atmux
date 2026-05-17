// Bootstrap-brief delivery verification (t-47f4425f, complaint c-fbecbf65).
//
// After `atmux cockpit rebuild` / `atmux start` send-keys the claude TUI
// command into a member pane, this probe waits for the pane to reach a
// terminal readiness state so the spawn-side can refuse to declare green
// when the TUI failed to boot or the bootstrap brief never landed.
//
// Two modes:
//
//   * `requireBriefConsumed=false` (default for current autolaunchTeam):
//     succeed as soon as a non-SHELL pane state classifies via the
//     existing pane-state catalog. Verifies the claude TUI is alive in
//     the pane — silently catches the case where `tmux send-keys` fired
//     but claude crashed at startup. Does NOT distinguish a fresh
//     welcome-screen pane from one that has consumed a brief.
//
//   * `requireBriefConsumed=true` (callers that own brief-paste, e.g.
//     ADR-081 §C once it lands): additionally insist that the welcome
//     banner / placeholder-tips have cleared (or a token counter is
//     present), proving the brief was delivered and consumed. This is
//     the structural fix for c-fbecbf65 — operator believed team was
//     running; team was actually 11 idle Claude REPLs at the welcome
//     screen with 0 tokens consumed.
//
// Stage B (ATMUX_BOOTSTRAP_OK sentinel + per-member confirmation files)
// is deliberately deferred per the task brief; this module ships Stage A.

import { type CaptureFn, classifyText, type PaneClassification } from "./pane-state.ts";

// ---------- Public types ----------

export type PaneReadinessState =
  /** Pane reached a stable "claude TUI alive" classification. When
   *  `requireBriefConsumed` was true, the welcome screen has also
   *  cleared (token counter visible OR welcome banner absent). */
  | "ready"
  /** Claude TUI is alive (READY/TYPING/BUSY classification) but the
   *  welcome screen is still showing — fresh pane that never received
   *  its bootstrap brief. Only emitted when `requireBriefConsumed=true`.
   *  Mirror of the c-fbecbf65 incident state. */
  | "starving"
  /** Pane fell back to a shell prompt — claude TUI is not running.
   *  Either it never started or crashed during boot. */
  | "absent"
  /** Deadline elapsed before any conclusive state was observed; pane
   *  capture stayed at UNKNOWN. Operator-visible warning candidate. */
  | "timeout";

export interface PaneReadinessResult {
  state: PaneReadinessState;
  /** Final pane-state classification observed at decision time. */
  paneClassification: PaneClassification;
  /** Tail of the last pane capture (≤200 chars) — small enough to log
   *  in a structured warning without flooding the rebuild output. */
  evidence: string;
  /** Wall-clock ms elapsed inside the probe loop. */
  elapsedMs: number;
  /** Number of capture attempts made. */
  attempts: number;
}

export interface AwaitClaudeReadyOpts {
  /** Wall-clock budget. Default 30_000 ms (task brief §A.1). */
  deadlineMs?: number;
  /** Poll interval between captures. Default 500 ms (task brief §A.1). */
  pollIntervalMs?: number;
  /** When true (the strict mode), success requires the welcome screen
   *  to have cleared — token counter visible OR welcome banner absent.
   *  Default `false` so callers that don't own brief-paste (today's
   *  `autolaunchTeam`) only verify TUI-aliveness. ADR-081 §C and any
   *  future brief-paste integration should pass `true`. */
  requireBriefConsumed?: boolean;
}

export interface AwaitClaudeReadyDeps {
  /** tmux capture-pane wrapper, bound to the probe's target. */
  capture: CaptureFn;
  /** Sleep override for tests; default uses `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for elapsed-ms accounting; default `Date.now`. */
  now?: () => number;
}

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Welcome-screen markers — fresh claude TUI prior to any user message.
// `Welcome to Claude Code` is the boot banner; placeholder tips show
// only on the welcome screen (`Try "create a util ..."`). Either is
// sufficient evidence of an unconsumed welcome screen.
const WELCOME_BANNER_RE = /Welcome to Claude Code/i;
const PLACEHOLDER_TIP_RE = /^\s*Try\s+["']/m;

// Token-counter footer — present once claude has processed ≥1 message.
// Mirrors the READY pattern in pane-state.ts:124, lifted out so we can
// distinguish a brief-consumed pane from a bare-prompt welcome screen.
const TOKEN_COUNT_RE = /^\s*tok\s+\d+(\.\d+)?k?\/\d/m;

// ---------- Pure decision helper ----------

/**
 * Given a pane capture + its pane-state classification + the strictness
 * mode, return the terminal readiness state OR `"pending"` if the caller
 * should keep polling.
 *
 * Pure — no IO, no sleeps. Exported for direct unit-testing without
 * spinning the polling loop.
 */
export function inspectClaudeReadiness(
  text: string,
  classification: PaneClassification,
  requireBriefConsumed: boolean,
): PaneReadinessState | "pending" {
  if (classification.state === "SHELL") return "absent";
  if (classification.state === "UNKNOWN") return "pending";
  // Any other classification means claude TUI is alive: READY/TYPING/
  // BUSY/MODAL/COMPACTING/RATE-LIMIT all imply the welcome screen has
  // been reached (the patterns target claude's own UI chrome).
  if (!requireBriefConsumed) return "ready";
  if (TOKEN_COUNT_RE.test(text)) return "ready";
  if (WELCOME_BANNER_RE.test(text) || PLACEHOLDER_TIP_RE.test(text)) return "starving";
  // Prompt visible without welcome banner or token counter — the brief
  // probably consumed (post-/clear has no banner, no tokens yet). Treat
  // as ready under strict mode to avoid false-positive starvation flags.
  return "ready";
}

// ---------- Polling probe ----------

/**
 * Probe a pane for claude-TUI readiness. Polls `deps.capture(target)`
 * every `pollIntervalMs` until `inspectClaudeReadiness` returns a
 * terminal state or `deadlineMs` elapses.
 *
 * The probe never throws — capture failures bubble through the caller's
 * `capture` implementation. Callers that want to swallow capture errors
 * (treat-as-absent) should wrap `capture` themselves.
 */
export async function awaitClaudePaneReady(
  target: string,
  opts: AwaitClaudeReadyOpts,
  deps: AwaitClaudeReadyDeps,
): Promise<PaneReadinessResult> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requireBriefConsumed = opts.requireBriefConsumed ?? false;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const startedAt = now();
  let attempts = 0;
  let lastText = "";
  let lastClass: PaneClassification = {
    state: "UNKNOWN",
    evidence: "",
    capturedAt: startedAt,
  };

  while (true) {
    attempts += 1;
    lastText = await deps.capture(target);
    lastClass = classifyText(lastText, now);

    const verdict = inspectClaudeReadiness(lastText, lastClass, requireBriefConsumed);
    const elapsedMs = now() - startedAt;
    if (verdict !== "pending") {
      return {
        state: verdict,
        paneClassification: lastClass,
        evidence: lastText.slice(-200),
        elapsedMs,
        attempts,
      };
    }
    if (elapsedMs >= deadlineMs) {
      return {
        state: "timeout",
        paneClassification: lastClass,
        evidence: lastText.slice(-200),
        elapsedMs,
        attempts,
      };
    }
    await sleep(pollIntervalMs);
  }
}

// ---------- Structured-warning formatter ----------

/**
 * Format a `PaneReadinessResult` into a single-line warning suitable for
 * the cockpit-rebuild / `atmux start` output. Mirrors the c-fbecbf65
 * preventive-ask: "log a structured warning + flag the pane as
 * 'unbootstrapped' in the cockpit-rebuild output."
 *
 * Returns `null` for the happy path (`state === "ready"`); the caller
 * checks for null and skips the log line.
 */
export function formatReadinessWarning(member: string, result: PaneReadinessResult): string | null {
  if (result.state === "ready") return null;
  const tail = result.evidence.replace(/\n/g, " ⏎ ").trim();
  return (
    `  ⚠ ${member}: ${result.state} ` +
    `(paneState=${result.paneClassification.state}, ` +
    `${result.attempts} captures over ${result.elapsedMs}ms) — tail: ${tail}`
  );
}

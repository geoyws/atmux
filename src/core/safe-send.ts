// ADR-057 §D1 R57-T1: safeSendKeys gate — uses pane-state classifier
// to refuse / retry / escalate before invoking tmux.pane.sendKeys.
//
// Replaces direct `tmux.pane.sendKeys(...)` calls in src/ — every
// keystroke injection should route through this gate so we don't
// merge into queued messages, lose input during compaction, type into
// shells, or answer modal prompts wrong.
//
// Brief lives at ADR-057 §D1 (R57-T1). Pattern catalog +
// retry/refusal policy live in src/core/pane-state.ts.

import {
  classifyPane,
  type CaptureFn,
  isRetryable,
  isSendable,
  type PaneClassification,
  type PaneState,
  REFUSAL_SEVERITY,
  RETRY_POLICY,
} from "./pane-state.ts";

// ---------- Public types ----------

export type SendKeysFn = (target: string, text: string) => Promise<void>;
export type RaiseFlagFn = (
  severity: "p0" | "p1" | "p2" | "p3",
  body: string,
) => Promise<void>;

export interface SafeSendOpts {
  /** tmux capture-pane wrapper. Required (no default — tests inject;
   *  prod callers wire tmux.pane.capturePane). */
  capture: CaptureFn;
  /** tmux send-keys wrapper. Required (same). */
  sendKeys: SendKeysFn;
  /** Optional flag-raise hook. Best-effort; failures are logged but
   *  don't change the safeSend outcome. */
  raiseFlag?: RaiseFlagFn;
  /** Optional logger. Defaults to no-op. */
  log?: (msg: string) => void;
  /** Sleep override for unit tests (avoids real timers). Default
   *  `setTimeout` polyfill. */
  sleep?: (ms: number) => Promise<void>;
}

export type SafeSendOutcome =
  | "sent"
  | "refused-shell"
  | "refused-modal"
  | "refused-rate-limit"
  | "refused-unknown"
  | "exhausted-typing"
  | "exhausted-compacting";

export interface SafeSendResult {
  outcome: SafeSendOutcome;
  /** Final classification observed before the decision was made. */
  finalClassification: PaneClassification;
  /** Number of classify+retry attempts made. */
  attempts: number;
}

// ---------- Public API ----------

/**
 * Classify the pane at `target`; on READY, send `text` immediately.
 * On retryable states (TYPING / COMPACTING), poll per RETRY_POLICY
 * and send when READY before attempts exhaust. On non-retryable
 * states (MODAL / RATE-LIMIT / SHELL / UNKNOWN), refuse + flag per
 * REFUSAL_SEVERITY.
 *
 * Always returns; never throws (capture / sendKeys errors propagate
 * the same as direct tmux.send_keys would). RATE-LIMIT does NOT flag
 * (ADR-053 budget-pause path takes over).
 */
export async function safeSendKeys(
  target: string,
  text: string,
  opts: SafeSendOpts,
): Promise<SafeSendResult> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;

  let attempts = 0;
  let classification = await classifyPane(target, opts.capture);
  attempts += 1;

  // Retry loop for transient states.
  while (isRetryable(classification.state)) {
    const policy = RETRY_POLICY[classification.state];
    if (attempts >= policy.maxAttempts) {
      const outcome: SafeSendOutcome =
        classification.state === "TYPING" ? "exhausted-typing" : "exhausted-compacting";
      await maybeFlag(
        opts.raiseFlag,
        REFUSAL_SEVERITY[classification.state],
        `safeSendKeys ${target}: ${classification.state} after ${attempts} attempts (giving up)`,
      );
      log(`safeSendKeys: ${target} → ${outcome} after ${attempts} attempts`);
      return { outcome, finalClassification: classification, attempts };
    }
    await sleep(policy.delayMs);
    classification = await classifyPane(target, opts.capture);
    attempts += 1;
  }

  // Decision per terminal state.
  if (isSendable(classification.state)) {
    await opts.sendKeys(target, text);
    log(`safeSendKeys: ${target} sent (state=${classification.state}, attempts=${attempts})`);
    return { outcome: "sent", finalClassification: classification, attempts };
  }

  // Non-retryable refusal.
  const outcome = mapRefusalOutcome(classification.state);
  await maybeFlag(
    opts.raiseFlag,
    REFUSAL_SEVERITY[classification.state],
    `safeSendKeys ${target}: ${classification.state} state — refused (evidence: ${classification.evidence})`,
  );
  log(`safeSendKeys: ${target} → ${outcome} (state=${classification.state})`);
  return { outcome, finalClassification: classification, attempts };
}

// ---------- Internals ----------

function mapRefusalOutcome(state: PaneState): SafeSendOutcome {
  switch (state) {
    case "SHELL":
      return "refused-shell";
    case "MODAL":
      return "refused-modal";
    case "RATE-LIMIT":
      return "refused-rate-limit";
    case "UNKNOWN":
      return "refused-unknown";
    default:
      // Retryable states are handled in the loop; READY is sent
      // upstream. Anything else is a programmer-error on the
      // outcome-mapping side.
      return "refused-unknown";
  }
}

async function maybeFlag(
  raiseFlag: RaiseFlagFn | undefined,
  severity: "p0" | "p1" | "p2" | "p3" | null,
  body: string,
): Promise<void> {
  if (raiseFlag === undefined || severity === null) return;
  try {
    await raiseFlag(severity, body);
  } catch {
    // Best-effort.
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

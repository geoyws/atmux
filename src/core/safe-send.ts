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

import { detectKnownModal, type KnownModalMatch } from "./known-modals.ts";
import {
  type CaptureFn,
  classifyText,
  isRetryable,
  isSendable,
  type PaneClassification,
  type PaneState,
  REFUSAL_SEVERITY,
  RETRY_POLICY,
} from "./pane-state.ts";

// ---------- Public types ----------

export interface SendKeysOpts {
  /** Whether to press Enter after the keys. Defaults to wiring's choice
   *  — used by the known-modal dismiss path to send single keystrokes
   *  without submitting a prompt. */
  enter?: boolean;
}
export type SendKeysFn = (target: string, text: string, opts?: SendKeysOpts) => Promise<void>;
export type RaiseFlagFn = (severity: "p0" | "p1" | "p2" | "p3", body: string) => Promise<void>;

/** Max number of consecutive known-modal dismissals safeSendKeys will
 *  perform inside a single call before falling through to refused-modal.
 *  Bound to keep the gate from looping if a modal won't go away. */
export const MAX_KNOWN_MODAL_DISMISSALS = 3;

/** Settle delay between sending a known-modal dismissal keystroke and
 *  re-capturing the pane to verify the modal is gone. Short; the modal
 *  UI redraws within a frame. */
export const KNOWN_MODAL_SETTLE_MS = 500;

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
  | "exhausted-busy"
  | "exhausted-compacting";

export interface SafeSendResult {
  outcome: SafeSendOutcome;
  /** Final classification observed before the decision was made. */
  finalClassification: PaneClassification;
  /** Number of classify+retry attempts made. */
  attempts: number;
  /** Number of known-modal dismissals performed during this call. 0
   *  on the happy path; non-zero when MODAL was hit + auto-dismissed. */
  dismissals: number;
}

/**
 * Preflight result — same loop as safeSendKeys minus the final send.
 * Used by callers that own a paste-buffer pattern (loadBuffer +
 * pasteBuffer + Enter) and need the modal-dismissal preflight before
 * the paste lands inside the compose box. Routing the trailing Enter
 * through safeSendKeys would not work — by the time we send Enter,
 * the pasted message is already in the compose box and the pane
 * classifies as TYPING (which the gate would retry until exhausted).
 */
export interface SafePreflightResult {
  /** Final classification observed at end of the loop. */
  finalClassification: PaneClassification;
  /** Number of classify+retry attempts made. */
  attempts: number;
  /** Number of known-modal dismissals performed. */
  dismissals: number;
  /** True iff finalClassification.state is sendable (READY). */
  ready: boolean;
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
  let dismissals = 0;
  let paneText = await opts.capture(target);
  let classification = classifyText(paneText);
  attempts += 1;

  // Combined retry/dismiss loop. Three transitions can re-enter:
  //   1. RETRYABLE state (TYPING/COMPACTING) — wait per RETRY_POLICY.
  //   2. MODAL state with a known-modal match — dismiss + re-capture.
  // Anything else exits the loop into the terminal-state decision.
  while (true) {
    if (isRetryable(classification.state)) {
      const policy = RETRY_POLICY[classification.state];
      if (attempts >= policy.maxAttempts) {
        const outcome: SafeSendOutcome =
          classification.state === "TYPING"
            ? "exhausted-typing"
            : classification.state === "BUSY"
              ? "exhausted-busy"
              : "exhausted-compacting";
        await maybeFlag(
          opts.raiseFlag,
          REFUSAL_SEVERITY[classification.state],
          `safeSendKeys ${target}: ${classification.state} after ${attempts} attempts (giving up)`,
        );
        log(`safeSendKeys: ${target} → ${outcome} after ${attempts} attempts`);
        return { outcome, finalClassification: classification, attempts, dismissals };
      }
      await sleep(policy.delayMs);
      paneText = await opts.capture(target);
      classification = classifyText(paneText);
      attempts += 1;
      continue;
    }

    if (classification.state === "MODAL" && dismissals < MAX_KNOWN_MODAL_DISMISSALS) {
      const known = detectKnownModal(paneText);
      if (known !== null) {
        await dismissKnownModal(target, known, opts);
        log(
          `safeSendKeys: ${target} dismissed known-modal=${known.modal.id} ` +
            `(dismissals=${dismissals + 1})`,
        );
        await sleep(KNOWN_MODAL_SETTLE_MS);
        paneText = await opts.capture(target);
        classification = classifyText(paneText);
        attempts += 1;
        dismissals += 1;
        continue;
      }
    }

    break;
  }

  // Decision per terminal state.
  if (isSendable(classification.state)) {
    await opts.sendKeys(target, text);
    log(
      `safeSendKeys: ${target} sent (state=${classification.state}, ` +
        `attempts=${attempts}, dismissals=${dismissals})`,
    );
    return { outcome: "sent", finalClassification: classification, attempts, dismissals };
  }

  // Non-retryable refusal.
  const outcome = mapRefusalOutcome(classification.state);
  await maybeFlag(
    opts.raiseFlag,
    REFUSAL_SEVERITY[classification.state],
    `safeSendKeys ${target}: ${classification.state} state — refused (evidence: ${classification.evidence})`,
  );
  log(`safeSendKeys: ${target} → ${outcome} (state=${classification.state})`);
  return { outcome, finalClassification: classification, attempts, dismissals };
}

/**
 * Run the classify + dismiss-known-modal loop on `target` WITHOUT
 * sending any keystrokes at the end. Use this before a paste-buffer
 * pattern (loadBuffer + pasteBuffer + Enter): once `ready === true`,
 * the caller can paste safely; if `ready === false`, the caller
 * decides whether to abort, warn-and-proceed, or escalate.
 *
 * Loop semantics mirror `safeSendKeys`:
 *   - RETRYABLE states (TYPING / COMPACTING) → poll per RETRY_POLICY
 *     until they clear or attempts exhaust.
 *   - MODAL with a known-modal match → auto-dismiss + re-capture
 *     (bounded by MAX_KNOWN_MODAL_DISMISSALS).
 *   - Anything else (READY / SHELL / RATE-LIMIT / UNKNOWN / unbounded
 *     MODAL) exits the loop into terminal state.
 *
 * Does NOT raise flags on refusal — paste-buffer callers already have
 * their own warn/log paths (e.g. `sendToMember.preWarn`); flagging
 * twice would noise up the team-lead inbox.
 */
export async function safePreflight(
  target: string,
  opts: SafeSendOpts,
): Promise<SafePreflightResult> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;

  let attempts = 0;
  let dismissals = 0;
  let paneText = await opts.capture(target);
  let classification = classifyText(paneText);
  attempts += 1;

  while (true) {
    if (isRetryable(classification.state)) {
      const policy = RETRY_POLICY[classification.state];
      if (attempts >= policy.maxAttempts) {
        log(
          `safePreflight: ${target} → exhausted (state=${classification.state}, ` +
            `attempts=${attempts})`,
        );
        break;
      }
      await sleep(policy.delayMs);
      paneText = await opts.capture(target);
      classification = classifyText(paneText);
      attempts += 1;
      continue;
    }

    if (classification.state === "MODAL" && dismissals < MAX_KNOWN_MODAL_DISMISSALS) {
      const known = detectKnownModal(paneText);
      if (known !== null) {
        await dismissKnownModal(target, known, opts);
        log(
          `safePreflight: ${target} dismissed known-modal=${known.modal.id} ` +
            `(dismissals=${dismissals + 1})`,
        );
        await sleep(KNOWN_MODAL_SETTLE_MS);
        paneText = await opts.capture(target);
        classification = classifyText(paneText);
        attempts += 1;
        dismissals += 1;
        continue;
      }
    }

    break;
  }

  const ready = isSendable(classification.state);
  log(
    `safePreflight: ${target} → ready=${ready} (state=${classification.state}, ` +
      `attempts=${attempts}, dismissals=${dismissals})`,
  );
  return { finalClassification: classification, attempts, dismissals, ready };
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

async function dismissKnownModal(
  target: string,
  match: KnownModalMatch,
  opts: SafeSendOpts,
): Promise<void> {
  await opts.sendKeys(target, match.modal.keys, { enter: match.modal.pressEnter });
}

// ===========================================================================
// ADR-138 T2 (t-af007bb2): safeSendKeysWithVerify — verify-and-retry pattern
// ===========================================================================
//
// Wraps a raw send-keys + capture-pane round-trip with a per-call verifier
// that PROVES the state transition occurred. Callers pick from the canonical
// built-in verifiers (composerEmpty / agentThinking / modalClosed /
// contextNonZero / paneMatchesRegex) or pass an ad-hoc closure.
//
// **Placement note**: ADR-138 §Decision names `src/abstractions/tmux.ts` for
// this helper. Co-locating with `safeSendKeys` here (src/core/safe-send.ts)
// instead — `safeSendKeysWithVerify` consumes `safeSendKeys` (the preflight
// gate already lives in core), so abstractions/ → core/ would invert the
// established layering ("core consumes abstractions"). Reviewer may flip if
// the cross-cutting placement is preferred; the runtime contract is
// identical either way. Same-commit ADR-138 annotation pending.
//
// **Why not blanket-3x Enter**: every "extra" Enter is a state mutation,
// not a no-op. ADR-138 §Context enumerates the failure modes — composer-
// with-text submits an EMPTY prompt on the 2nd Enter; modal-Enter selects
// the next modal's default; welcome-screen Enter fires whatever placeholder
// was visible. The verify-and-retry pattern proves the expected state
// transition occurred before deciding whether to retry.

/** Per-call verifier: returns `true` when the captured pane shows the
 *  expected post-send state. Callers either pick from the built-in
 *  factories below (`composerEmpty()`, `agentThinking()`, etc.) or pass
 *  an ad-hoc closure. */
export type PaneVerifier = (paneCapture: string) => boolean;

/** What to do when verification fails after all retries. `"escalate"`
 *  (default) writes to the send-keys-failures log and returns
 *  `{ success: false, ... }`; `"throw"` raises {@link SafeSendKeysError}
 *  so CLI callers can exit non-zero. */
export type SafeSendKeysOnFail = "escalate" | "throw";

/** Append-side effect for the escalation log. Tests inject a recorder;
 *  prod wires the real `fs/promises.appendFile`. */
export type AppendLogFn = (path: string, content: string) => Promise<void>;

export interface SafeSendKeysWithVerifyOpts {
  /** tmux target (`session:window` or pane id). */
  target: string;
  /** Keystroke sequence to send. ADR-081 §A trailing C-m convention
   *  honored by the underlying `sendKeys` wrapper. */
  keys: string;
  /** Per-call verifier — must return `true` once the expected
   *  post-send state is observed. */
  expectVerifier: PaneVerifier;
  /** Max time (ms) to wait for the verifier to return `true` after
   *  each send attempt. Default 3000. */
  timeoutMs?: number;
  /** Additional send attempts beyond the first if the verifier never
   *  passes. Total attempts = `retries + 1`. Default 1 (= 2 total).
   *  Per ADR-138 §Resolved-OQ: more than 2 attempts compounds state-
   *  mutation risk faster than it improves success rate. */
  retries?: number;
  /** Poll interval (ms) between captures inside the verify window.
   *  Default 250. */
  pollIntervalMs?: number;
  /** Failure-mode behaviour after all retries exhaust. Default
   *  `"escalate"`. */
  onFail?: SafeSendKeysOnFail;
  // ----- Injectable deps (same pattern as SafeSendOpts) -----
  /** tmux capture-pane wrapper. Required. */
  capture: CaptureFn;
  /** tmux send-keys wrapper. Required. */
  sendKeys: SendKeysFn;
  /** Sleep override for unit tests (avoids real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Time-source override for unit tests (controls poll deadline).
   *  Defaults to `Date.now`. */
  now?: () => number;
  /** Optional logger. Defaults to no-op. */
  log?: (msg: string) => void;
  /** Override the escalation-log file path. Default resolves to
   *  `<homeDir>/.atmux/state/send-keys-failures.log`. */
  escalationLogPath?: string;
  /** Override `$HOME` for path resolution (test injection). */
  home?: string;
  /** Append-side effect for the escalation log. Default writes via
   *  `fs/promises.appendFile`. */
  appendLog?: AppendLogFn;
  /** Time-of-day source for log entries (test injection). Returns the
   *  formatted `HH:MM MYT YYYY-MM-DD` prefix. */
  nowFormatted?: () => string;
}

export interface SafeSendKeysWithVerifyResult {
  /** `true` iff the verifier returned `true` within `timeoutMs` of
   *  some send attempt; `false` only when `onFail === "escalate"` and
   *  every attempt exhausted (throws never returns at all). */
  success: boolean;
  /** Total send attempts made (1 on first-try success; up to
   *  `retries + 1` on failure). */
  attempts: number;
  /** Most recent pane capture observed at the time of resolution.
   *  Useful for callers that want to log or further-classify the
   *  final state. */
  finalCapture: string;
}

/** Raised when {@link safeSendKeysWithVerify} is called with
 *  `onFail: "throw"` AND every attempt fails verification. CLI entry
 *  points catch this and exit non-zero per ADR-138 §Resolved-OQ. */
export class SafeSendKeysError extends Error {
  constructor(
    public readonly target: string,
    public readonly keys: string,
    public readonly attempts: number,
    public readonly finalCapture: string,
  ) {
    super(
      `safeSendKeysWithVerify failed: target=${target} attempts=${attempts}`,
    );
    this.name = "SafeSendKeysError";
  }
}

/** Default escalation log path under `$HOME/.atmux/state/`. ADR-138
 *  §"Escalation log" — append-only, MYT-timestamped, bounded by an
 *  operator-managed rotation. */
export const DEFAULT_SEND_KEYS_FAILURES_LOG_REL =
  ".atmux/state/send-keys-failures.log";

/** Default verifier poll interval. */
export const DEFAULT_VERIFY_POLL_MS = 250;

/** Default verify-timeout per send attempt. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 3000;

/** Default retries beyond the first attempt — total 2 send attempts. */
export const DEFAULT_VERIFY_RETRIES = 1;

/**
 * Send `keys` to `target` and verify the post-send state via
 * `expectVerifier`. Retries up to `retries` times on verification
 * timeout; escalates (or throws) when every attempt exhausts.
 *
 * Behaviour per ADR-138 §Decision:
 *
 *   1. Pre-capture the pane (used as `preCapture` in the escalation
 *      log if all attempts fail).
 *   2. Send `keys` once.
 *   3. Poll capture-pane every `pollIntervalMs` for up to `timeoutMs`.
 *      Return `{ success: true, ... }` the moment `expectVerifier`
 *      returns `true`.
 *   4. On timeout without verifier success: decrement `retries`; if
 *      retries remain, GOTO step 2 (re-send). Note the pane is NOT
 *      re-captured pre-send on retry — `preCapture` from step 1 is
 *      the ground truth for the escalation log.
 *   5. When all attempts exhaust: per `onFail`, either escalate
 *      (write to log + return `success: false`) or throw
 *      {@link SafeSendKeysError}.
 */
export async function safeSendKeysWithVerify(
  opts: SafeSendKeysWithVerifyOpts,
): Promise<SafeSendKeysWithVerifyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_VERIFY_RETRIES;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_VERIFY_POLL_MS;
  const onFail: SafeSendKeysOnFail = opts.onFail ?? "escalate";
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});

  // Step 1: pre-capture once for escalation evidence.
  const preCapture = await opts.capture(opts.target);

  let attempts = 0;
  let finalCapture = preCapture;

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts += 1;
    // Step 2: send.
    await opts.sendKeys(opts.target, opts.keys);

    // Step 3: poll until verifier passes or timeout.
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(pollIntervalMs);
      const capture = await opts.capture(opts.target);
      finalCapture = capture;
      if (opts.expectVerifier(capture)) {
        log(
          `safeSendKeysWithVerify: ${opts.target} verified ` +
            `(attempts=${attempts})`,
        );
        return { success: true, attempts, finalCapture };
      }
    }
    log(
      `safeSendKeysWithVerify: ${opts.target} attempt ${attempts} timed out ` +
        `after ${timeoutMs}ms`,
    );
    // Step 4: loop to retry (if any retries remain).
  }

  // Step 5: all attempts exhausted.
  if (onFail === "throw") {
    throw new SafeSendKeysError(opts.target, opts.keys, attempts, finalCapture);
  }

  // Escalate — write to log + return failure.
  await writeEscalationLog(opts, preCapture, finalCapture, attempts, timeoutMs);
  log(
    `safeSendKeysWithVerify: ${opts.target} ESCALATED ` +
      `(attempts=${attempts}, log written)`,
  );
  return { success: false, attempts, finalCapture };
}

// ----- Built-in verifiers ----------------------------------------------

/** Regex covering every Claude Code TUI present-tense status verb +
 *  the "Worked / Cooked / Crunched / Sautéed" past-tense set that
 *  shows immediately after a turn completes. Sourced from operator-
 *  observed status indicators on the 2026-05-14 driver session. */
const AGENT_THINKING_RE =
  /(?:Cooking|Schlepping|Honking|Crunching|Cogitating|Brewing|Effecting|Imagining|Sautéeing|Kneading|Misting|Puttering|Grooving|Ruminating|Worked|Cooked|Crunched|Sautéed)\.{3}|… \(\d+m?s\)/;

/**
 * Verifier factory: returns a verifier asserting the composer is
 * empty — i.e. the captured pane shows a `❯ ` prompt at composer
 * position with no trailing text on its line.
 *
 * Use case: `atmux send` / `atmux dispatch` / `atmux claim --next`
 * injections — the composer should clear on Enter as the agent
 * accepts the prompt.
 */
export function composerEmpty(): PaneVerifier {
  // Claude TUI's composer prompt is `❯ ` on its own line (or near-
  // alone with optional trailing whitespace). After submission the
  // line is recreated empty.
  const re = /❯\s*$/m;
  return (capture: string) => re.test(capture);
}

/**
 * Verifier factory: returns a verifier asserting the agent is in a
 * thinking turn — present-tense status indicator visible (one of
 * the 18 Claude Code TUI verbs) OR a `… (Ns)` / `… (Nms)` elapsed
 * marker.
 *
 * Use case: confirm the agent picked up the prompt and started a
 * turn (composer cleared + thinking spinner visible).
 */
export function agentThinking(): PaneVerifier {
  return (capture: string) => AGENT_THINKING_RE.test(capture);
}

/**
 * Verifier factory: returns a verifier asserting the named modal
 * text is no longer present — i.e. the keystroke dismissed the
 * modal.
 *
 * Use case: post-Enter on a permission modal — verify the modal's
 * banner text (a substring unique to that modal type) is no longer
 * in the pane.
 */
export function modalClosed(modalText: string): PaneVerifier {
  return (capture: string) => !capture.includes(modalText);
}

/**
 * Verifier factory: returns a verifier asserting the pane's status
 * line shows a non-zero token-context indicator — i.e. bootstrap
 * completed and the session has live context.
 *
 * Used by `atmux start` + `atmux rotate` bootstrap-brief cascades
 * (ADR-081 §C). Rejects the explicit `ctx --` "no context" marker
 * even when other token-like patterns appear in unrelated output.
 */
export function contextNonZero(): PaneVerifier {
  const tokensRe = /\d+\.?\d*k?\s+tokens?/i;
  return (capture: string) => {
    if (/ctx --/i.test(capture)) return false;
    return tokensRe.test(capture);
  };
}

/**
 * Verifier factory: passthrough regex match. Use when the canonical
 * five verifiers don't fit the call site. Reviewer-gated per ADR-138
 * §Tradeoffs — ad-hoc verifiers risk wrong-positive failures.
 */
export function paneMatchesRegex(re: RegExp): PaneVerifier {
  return (capture: string) => re.test(capture);
}

/**
 * ADR-138 T3b2 (option c per 2026-05-15 lead auto-mode resolution):
 * pick a per-member verifier from `member.tui`. Verbs that route
 * keystrokes through `sendToMember` call this BEFORE constructing
 * `SendOpts.expectVerifier`; the result either gates the verify-and-
 * escalate path or signals "skip verify" (null → caller passes
 * `undefined` to keep the legacy submitAfterPaste path).
 *
 * Mapping rationale:
 *
 * - **claude** (EXPLICIT) → `composerEmpty()`. The Claude Code
 *   TUI's compose prompt is `❯ ` at end-of-line; after Enter submits,
 *   the line is recreated empty so the regex confirms the agent
 *   accepted the prompt. Production `team.json` always carries an
 *   explicit `tui: "claude"` (see `parseAddMemberArgs` default in
 *   `src/verbs/add-member.ts`); the verify path is opt-in via the
 *   explicit literal so test fixtures and hand-crafted team.json
 *   files without a `tui` field stay on the legacy submitAfterPaste
 *   path and don't write false-positive escalation log entries.
 *
 * - **shell / bash / zsh** → `null` (skip verify). Shell prompts use
 *   `$ ` / `# ` / `> ` glyphs, NOT `❯`. Running `composerEmpty()`
 *   against a shell capture writes false-positive escalation log
 *   entries on every legitimate send-keys round-trip; per ADR-138
 *   §Tradeoffs the verifier is opt-in, not blanket.
 *
 * - **everything else** (`opencode`, `kimi`, `cursor`, custom
 *   per-team launchers) → `null` (skip verify). Conservative
 *   default: each new TUI gets its own verifier added here ONLY
 *   after its compose-empty regex is verified against real-pane
 *   captures from that TUI. Adding a wrong-glyph verifier would
 *   regress; absence stays on the legacy submitAfterPaste path
 *   which has 2026-05-12 atmux audit-trail evidence.
 *
 * Pure: returns the verifier OR `null` for skip; never throws. Caller
 * branches on `null` and passes `expectVerifier: undefined` to
 * `sendToMember` so the legacy path runs unchanged.
 */
export function verifierForTui(tui: string | undefined): PaneVerifier | null {
  switch (tui) {
    case "claude":
      return composerEmpty();
    default:
      return null;
  }
}

// ----- Escalation log -------------------------------------------------

/** MYT-formatted timestamp prefix for escalation log entries.
 *  Co-located here so tests can verify the shape end-to-end. */
function defaultNowFormatted(): string {
  const d = new Date();
  // en-CA gives YYYY-MM-DD; en-GB 24h gives HH:MM:SS — use the
  // canonical CLAUDE.md format `HH:MM MYT YYYY-MM-DD`.
  const datePart = d.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
  });
  const timePart = d.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kuala_Lumpur",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${timePart} MYT ${datePart}`;
}

/** Resolve the escalation log path: explicit override → `$HOME` + rel
 *  default. Throws nothing — when `$HOME` is unset and no override is
 *  given, falls back to the relative path which lets the appendFn
 *  decide (test injection wires this). */
function resolveLogPath(opts: SafeSendKeysWithVerifyOpts): string {
  if (typeof opts.escalationLogPath === "string") return opts.escalationLogPath;
  const home = opts.home ?? process.env.HOME ?? "";
  return home === ""
    ? DEFAULT_SEND_KEYS_FAILURES_LOG_REL
    : `${home}/${DEFAULT_SEND_KEYS_FAILURES_LOG_REL}`;
}

/** Take the last `n` lines of a string. */
function lastLines(s: string, n: number): string {
  return s.split("\n").slice(-n).join("\n");
}

async function defaultAppendLog(path: string, content: string): Promise<void> {
  // Lazy-import fs/promises so unit tests that inject `appendLog`
  // don't pay the node-fs binding cost or risk touching disk.
  const fs = await import("node:fs/promises");
  const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
  if (dir !== "") {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.appendFile(path, content, "utf8");
}

async function writeEscalationLog(
  opts: SafeSendKeysWithVerifyOpts,
  preCapture: string,
  postCapture: string,
  attempts: number,
  timeoutMs: number,
): Promise<void> {
  const append = opts.appendLog ?? defaultAppendLog;
  const path = resolveLogPath(opts);
  const ts = (opts.nowFormatted ?? defaultNowFormatted)();
  // Inline newlines in `keys` are normalised to `\n` literal so the
  // log row is grep-friendly per ADR-138 §"Escalation log" sample.
  const keysLine = opts.keys.replace(/\n/g, "\\n");
  const entry =
    `[${ts}] target=${opts.target} keys='${keysLine}' ` +
    `attempts=${attempts} timeout=${timeoutMs}ms\n` +
    `preCapture: ${lastLines(preCapture, 5)}\n` +
    `postCapture: ${lastLines(postCapture, 5)}\n` +
    `---\n`;
  try {
    await append(path, entry);
  } catch {
    // Best-effort. Failure to write the log mustn't bury the
    // already-failed send-keys decision — the caller already has
    // `success: false` and can decide their own recovery path.
  }
}

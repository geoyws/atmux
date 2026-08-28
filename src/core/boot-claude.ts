// ADR-081 §C completion (t-94d7ad60): readiness-poll + boot-prompt
// pattern that replaces fixed-sleep brief paste in start.ts +
// rotate.ts for claude-TUI panes. Eliminates the "undead pane"
// fingerprint observed 3rd+ time in production (memory
// `feedback_member_pane_no_atmux_member.md`): claude TUI launches
// but the boot brief lands BEFORE the compose box exists, scrolls
// past startup output into oblivion; pane is alive but composer is
// empty; auto-mode never auto-submits because there's nothing to
// submit; kanban auto-claim never fires; member sits at 0 tokens
// forever.
//
// Failure mode anatomy:
//   1. tmux spawns shell with `claude ...` cmd
//   2. Shell parses cmdline → forks → execs claude
//   3. Claude TUI cold-starts (5-15s observed in production)
//   4. atmux's fixed sleep (ATMUX_SPAWN_WAIT default 6s) fires the
//      paste BEFORE step 3 completes → brief content arrives during
//      the spinner / welcome / theme-pick phase and is consumed by
//      whatever pre-compose-box widget claude is rendering at that
//      moment. Composer never receives it.
//
// Fix per the URGENT task body §1-4:
//   - Poll capture-pane for TUI ready (`❯` prompt glyph OR `tokens`
//     footer) up to 30s before sending input.
//   - Send a SHORT single-line boot prompt via send-keys + Enter
//     (NOT paste-buffer — bracketed-paste with newlines silently
//     fails to submit per the clear-member.sh lesson, exact same
//     trap fingerprint).
//   - Sentinel detection: tokens count > 0 means the boot prompt
//     landed AND claude has begun a turn (i.e. emitting tokens).
//   - Retry once on first-attempt timeout, then surface to driver
//     via lead-outbox.md (does NOT silently leave the pane undead).
//
// The boot prompt is verbatim from the task body §3 — claude reads
// the role brief itself on first turn rather than us pasting the
// content, which avoids the bracketed-paste-newline trap and shifts
// the brief-content responsibility to claude's own file IO.

import type { SendTarget, TmuxNamespace } from "../abstractions/tmux.ts";
import { PASTE_SUBMIT_SETTLE_FLOOR_MS } from "./paste-submit.ts";
import { type AppendLogFn, composerEmpty, safeSendKeysWithVerify } from "./safe-send.ts";

// ---------- Tuning constants ----------

/** Default poll interval while waiting for the TUI to reach a
 *  ready state. 1s is the sweet spot — fast enough to catch a
 *  3-5s cold-start without burning compute, slow enough that 30
 *  polls (over a 30s window) is the typical worst case. */
export const READY_POLL_INTERVAL_MS = 1_000;

/** Default ceiling on TUI-ready wait. ADR-081 envelope. Claude TUI
 *  cold-start is genuinely 5-15s on hax under load; 30s gives
 *  generous headroom without making a real failure case
 *  uncoverable. */
export const READY_TIMEOUT_MS = 30_000;

/** Default poll interval after boot-prompt send while waiting for
 *  tokens count to move (sentinel confirming the boot prompt
 *  landed). 2s is empirically tuned — claude typically emits the
 *  first output token within 1-3s of an Enter-submitted prompt. */
export const POST_BOOT_POLL_INTERVAL_MS = 2_000;

/** Default ceiling on post-boot tokens-moved wait. 30s gives a
 *  full claude-first-turn its window to surface a token. */
export const POST_BOOT_TIMEOUT_MS = 30_000;

/** Maximum boot attempts (initial + N retries). Default 2 = one
 *  initial send + one retry on the same pane. */
export const MAX_ATTEMPTS = 2;

/** Default safeSendKeysWithVerify timeout per C-m submit attempt
 *  (t-1b45d565). 3s matches the safe-send.ts default — claude's
 *  composer clears in <500ms post-Enter on a healthy pane; 3s gives
 *  headroom for capture-pane latency without burning the outer
 *  tokens-moved budget. */
export const DEFAULT_SUBMIT_VERIFY_TIMEOUT_MS = 3_000;

/** Default safeSendKeysWithVerify retries per C-m submit cycle. 1 =
 *  two C-m sends per paste before declaring submit-not-verified.
 *  Higher retries here add wall-clock cost without changing the
 *  diagnostic; the outer maxAttempts loop handles whole-cycle
 *  retries. */
export const DEFAULT_SUBMIT_VERIFY_RETRIES = 1;

// ---------- Boot prompt + readiness regex ----------

/** ADR-081 §C task-body §3 boot prompt. Placeholders are
 *  `{team}` (team name) + `{member}` (member name). Single line so
 *  send-keys + Enter submits cleanly; no bracketed-paste mode is
 *  triggered (which is what makes this approach reliable).
 *
 *  Self-verification preamble (2026-05-19 update). The "Your role is
 *  {member}" assertion is trustworthy only when the paste reaches
 *  the intended pane. Mis-targeted pastes happen — `atmux rotate
 *  <member>` with wrong emoji/window resolution will fire this
 *  template into the wrong pane and trick the recipient into
 *  adopting the wrong role (observed 2026-05-19: driver pane received
 *  "Your role is lead" after rotate mis-resolved window 1). Recipient
 *  must `echo $ATMUX_MEMBER` first and abort + alert the operator on
 *  mismatch rather than silently bootstrap as the wrong member. The
 *  env var is set per-pane at spawn time + is not lying. */
const BOOT_PROMPT_TEMPLATE =
  "First run `echo $ATMUX_MEMBER` — if it isn't `{member}`, this paste mis-targeted (alert operator + abort, do NOT bootstrap). Otherwise read /tmp/atmux-brief-generic-{team}.md and your role brief if your role appears in templates/briefs/, then bootstrap as {member}.";

/** Render the boot prompt for a (team, member) pair. Exported for
 *  unit tests + observability — the lead-outbox failure surface
 *  echoes this string so the operator can see what was sent. */
export function renderBootPrompt(team: string, member: string, briefPath?: string): string {
  const base = BOOT_PROMPT_TEMPLATE.replaceAll("{team}", team).replaceAll("{member}", member);
  if (briefPath === undefined) return base;
  return `${base} Your exact cooperative bot contract is at ${briefPath}; read and obey it before accepting work.`;
}

/** TUI-ready detection. Matches either:
 *   - `❯` — claude's compose-box prompt glyph (rendered once the
 *     interactive input row is up)
 *   - `tokens` — the bottom-frame token-count footer (rendered
 *     after the first turn produces tokens; covers the
 *     already-booted case)
 *  Either match is sufficient evidence the TUI is past welcome
 *  rendering and ready to receive input. */
const TUI_READY_RE = /❯|tokens/;

/** Sentinel: claude has produced tokens (the `↑ Nk ↓ Mk tokens`
 *  status footer where N+M > 0). Captures the "boot prompt
 *  landed and claude is actively responding" state, distinguishing
 *  it from "TUI ready but no input received" (just a `❯` and
 *  silent footer). The regex matches `<int>k tokens` OR
 *  `tokens · <int>%`, both shapes claude's status line uses. */
const TOKENS_MOVED_RE = /(?<![0-9])\d+k\s*(?:tokens|↓)|tokens\s*·\s*\d+%/i;

/** Sentinel: claude has entered an active thinking / extended-context
 *  turn but hasn't yet emitted enough tokens for the `Nk tokens` footer
 *  to render. Matches the `✻ Churned for Xm Ys` / `✻ Worked for Xm Ys`
 *  / `✻ thinking with N` status-line shapes. Required because a member
 *  spawned into a long-thinking-on-first-turn (>2 min on xhigh + dense
 *  brief paste) can be genuinely alive + productive while the existing
 *  `tokensMoved` check still reads false — observed 2026-05-20 on sopx
 *  epic-team viewers (e-24b6b90d/planner, e-de96991b/fe-1) where medic
 *  bootstrap-verify declared false-negative `failed` on alive members
 *  (t-a1db24dd). Single-shot match — no cross-probe increment check
 *  (parity with `tokensMoved` which also accepts any positive signal). */
const THINKING_ACTIVE_RE = /[✻✶✽✺✷]\s*(?:Churned|Worked|thinking)\s+(?:for\s+\d+[hms]|with\s+\d+)/i;

export function isTuiReady(captured: string): boolean {
  return TUI_READY_RE.test(captured);
}

export function tokensMoved(captured: string): boolean {
  return TOKENS_MOVED_RE.test(captured);
}

export function thinkingActive(captured: string): boolean {
  return THINKING_ACTIVE_RE.test(captured);
}

/** Combined post-boot liveness predicate: tokens are flowing OR claude
 *  is mid-thinking. Either signal proves the boot prompt landed + a
 *  turn started; the difference is whether the turn is far enough
 *  along to render the `Nk tokens` footer (`tokensMoved`) or still in
 *  the thinking/agentic preamble (`thinkingActive`). Wraps both so the
 *  pollUntil loop's single-predicate API stays clean. */
export function bootSignalLive(captured: string): boolean {
  return tokensMoved(captured) || thinkingActive(captured);
}

// ---------- bootClaudeMember ----------

/** What happened in this boot attempt. The drain-loop / start /
 *  rotate caller uses this to log per-member outcomes + decide
 *  whether to surface to the driver. */
export interface BootResult {
  /** Terminal state:
   *   - `booted`: tokens were observed moving after send-keys (success).
   *   - `already-booted`: pre-send capture showed tokens already
   *     moving (sentinel guard — boot prompt was NOT sent again).
   *   - `failed`: every attempt timed out without tokens moving. */
  status: "booted" | "already-booted" | "failed";
  /** How many send-keys attempts fired. 0 for already-booted (no
   *  send), 1 for first-try-success, 2 for retry-success or
   *  retry-fail. */
  attempts: number;
  /** Populated on `failed` to name the failure mode. */
  reason?: "tui-not-ready" | "tokens-never-moved" | "capture-error" | "submit-not-verified";
}

export interface BootClaudeOpts {
  /** Pre-built TmuxNamespace — caller is already in possession of
   *  a configured tmux client; we shouldn't double-create. */
  tmux: TmuxNamespace;
  /** ADR-025 typed send target (kind: 'member'|'lead' + audit
   *  metadata). Pre-built by caller from team + member shape. */
  sendTarget: SendTarget;
  /** String tmux target (`<session>:<window>`) for capture-pane.
   *  Distinct from sendTarget because capture-pane doesn't need
   *  the ADR-025 type-system gate (read-only, no audit metadata
   *  required). */
  paneTargetString: string;
  /** Team name + member name for the boot prompt template. */
  team: string;
  member: string;
  /** Optional exact role-brief path. Used by the cooperative `_bot`
   *  seat because it is deliberately absent from `team.members[]`. */
  briefPath?: string;
  // --- tunables (test injection) ---
  readyPollIntervalMs?: number;
  readyTimeoutMs?: number;
  postBootPollIntervalMs?: number;
  postBootTimeoutMs?: number;
  maxAttempts?: number;
  /** Sleep injection (tests pass no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection (tests fast-forward). Returns ms. */
  now?: () => number;
  // --- safeSendKeysWithVerify plumbing (t-1b45d565 — verify the C-m
  //     submit actually cleared the composer; retries on no-op + early-
  //     returns `submit-not-verified` if every attempt's C-m got eaten). ---
  /** Submit-verify timeout per attempt. Default
   *  {@link DEFAULT_SUBMIT_VERIFY_TIMEOUT_MS} (3s). */
  submitVerifyTimeoutMs?: number;
  /** Submit-verify retries-per-boot-attempt (the outer maxAttempts
   *  loop multiplies this). Default
   *  {@link DEFAULT_SUBMIT_VERIFY_RETRIES} (1 — i.e. 2 C-m sends per
   *  paste). */
  submitVerifyRetries?: number;
  /** Submit-verify poll interval. Default 250ms. */
  submitVerifyPollIntervalMs?: number;
  /** Escalation-log append (test injection — production wires
   *  `appendFile`). Default fires the safe-send.ts built-in. */
  appendLog?: AppendLogFn;
  /** `$HOME` override for escalation-log path resolution (test injection). */
  home?: string;
  /** EPIC e-f28c2596 T7: when `true`, skip the (1) already-booted
   *  sentinel and unconditionally proceed to readiness wait + boot
   *  prompt. Rotate.ts passes `true` post-`/clear` because the
   *  brief context has DEFINITIVELY been wiped regardless of what
   *  tmux scrollback shows (tokens visible in `capturePane(start:
   *  -40)` after `/clear` reflect stale scrollback, NOT live session
   *  state — `/clear` resets the Claude session but tmux's own
   *  scrollback persists, so the sentinel mis-fires and skips the
   *  brief re-paste, leaving the rotated lead at 0 tok of brief
   *  context).
   *
   *  Default `false` — start.ts and other first-spawn callers keep
   *  the double-submit guard since they don't precede the call with
   *  a `/clear`.
   *
   *  Operator-visible fingerprint of the pre-T7 bug:
   *    `rotate: <role>: already booted — boot prompt skipped`
   *  followed by 0-token <role> in the next `/bau` scan. */
  forceBootPrompt?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const defaultNow = () => Date.now();

/** Poll loop primitive shared between the two readiness windows.
 *  Returns `{ found: true, capture }` on first match; returns
 *  `{ found: false }` on `now() - start >= timeoutMs`. Exported
 *  for test access — drives both pre-boot (TUI-ready) and
 *  post-boot (tokens-moved) gates with the same shape. */
async function pollUntil(
  predicate: (captured: string) => boolean,
  opts: {
    tmux: TmuxNamespace;
    target: string;
    intervalMs: number;
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
  },
): Promise<{ found: boolean; capture: string; error?: string }> {
  const deadline = opts.now() + opts.timeoutMs;
  let lastCapture = "";
  while (opts.now() < deadline) {
    try {
      lastCapture = await opts.tmux.pane.capturePane({
        target: opts.target,
        start: -40,
      });
    } catch (e) {
      return {
        found: false,
        capture: lastCapture,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (predicate(lastCapture)) {
      return { found: true, capture: lastCapture };
    }
    await opts.sleep(opts.intervalMs);
  }
  return { found: false, capture: lastCapture };
}

/**
 * Boot a claude-TUI member pane.
 *
 * Sequence (per ADR-081 §C completion):
 *
 *   1. Pre-send sentinel: if the pane already shows tokens moving
 *      (e.g. rotation re-entry where the member was already
 *      productive before /clear landed mid-thought), return
 *      `already-booted` and skip everything else. Prevents the
 *      "double boot prompt" double-submit risk flagged by the
 *      reviewer pre-flag.
 *
 *   2. Poll capture-pane for TUI ready state (`❯` or `tokens`
 *      glyph) up to `readyTimeoutMs`. If never ready, return
 *      `failed` with `tui-not-ready`. No boot prompt sent.
 *
 *   3. Send boot prompt via send-keys with enter:true. Short
 *      single-line payload — no paste-buffer involvement, no
 *      bracketed-paste mode triggering.
 *
 *   4. Post-send poll: watch capture-pane for tokens moving up to
 *      `postBootTimeoutMs`. If observed → return `booted`.
 *
 *   5. Retry: if not seen within timeout, increment attempts, send
 *      the boot prompt again, poll again. Up to `maxAttempts`
 *      total attempts.
 *
 *   6. Exhausted: return `failed` with `tokens-never-moved`. The
 *      caller (start.ts / rotate.ts) writes a driver-inbox /
 *      lead-outbox entry per the task body §4.
 *
 * NOT exported as a tmux primitive — this is coordination logic
 * tied to the boot lifecycle, not a general send pattern.
 */
export async function bootClaudeMember(opts: BootClaudeOpts): Promise<BootResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? defaultNow;
  const readyInterval = opts.readyPollIntervalMs ?? READY_POLL_INTERVAL_MS;
  const readyTimeout = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const postBootInterval = opts.postBootPollIntervalMs ?? POST_BOOT_POLL_INTERVAL_MS;
  const postBootTimeout = opts.postBootTimeoutMs ?? POST_BOOT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const submitVerifyTimeoutMs = opts.submitVerifyTimeoutMs ?? DEFAULT_SUBMIT_VERIFY_TIMEOUT_MS;
  const submitVerifyRetries = opts.submitVerifyRetries ?? DEFAULT_SUBMIT_VERIFY_RETRIES;
  const submitVerifyPollIntervalMs = opts.submitVerifyPollIntervalMs ?? 250;

  // (1) Already-booted sentinel: tokens already moving at entry.
  // Captures the "rotation re-entry mid-turn" + "double-call
  // protection" cases. Per reviewer pre-flag: don't double-submit.
  //
  // EPIC e-f28c2596 T7 carve-out: `forceBootPrompt: true` (set by
  // rotate.ts after `/clear`) bypasses this sentinel entirely. `/clear`
  // resets the live Claude session but NOT the tmux scrollback —
  // capturePane(start: -40) post-`/clear` may still show pre-clear
  // tokens, causing this sentinel to mis-fire as already-booted and
  // skip the brief re-paste, leaving the rotated pane at 0 tok of
  // brief context. The forceBootPrompt path treats `/clear` as
  // definitive ground truth and proceeds straight to readiness wait +
  // boot prompt.
  if (opts.forceBootPrompt !== true) {
    let initialCapture = "";
    try {
      initialCapture = await opts.tmux.pane.capturePane({
        target: opts.paneTargetString,
        start: -40,
      });
    } catch {
      // capture failure → degrade-to-poll (the readiness loop will
      // retry the capture). Don't short-circuit; the pane may
      // recover momentarily.
    }
    if (bootSignalLive(initialCapture)) {
      return { status: "already-booted", attempts: 0 };
    }
  }

  // (2) Readiness wait for the TUI to render.
  const ready = await pollUntil(isTuiReady, {
    tmux: opts.tmux,
    target: opts.paneTargetString,
    intervalMs: readyInterval,
    timeoutMs: readyTimeout,
    sleep,
    now,
  });
  if (!ready.found) {
    if (ready.error !== undefined) {
      return { status: "failed", attempts: 0, reason: "capture-error" };
    }
    return { status: "failed", attempts: 0, reason: "tui-not-ready" };
  }

  // (3-5) Boot prompt loop.
  const prompt = renderBootPrompt(opts.team, opts.member, opts.briefPath);
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    // t-1b45d565: split pasteAndSubmit into its three steps so the
    // C-m submit can be wrapped in safeSendKeysWithVerify
    // (composerEmpty). Previously the bundled pasteAndSubmit fired
    // C-m fire-and-forget; on the 8 occurrences observed
    // 2026-05-16 the C-m got eaten by a bracketed-paste-Enter
    // swallow OR a modal-state composer (operator-visible
    // fingerprint: "compose box pre-loaded with brief text +
    // cursor"). Verified-send-keys' verifier+retry catches this:
    // it detects composer-still-has-text post-C-m and re-fires the
    // C-m up to submitVerifyRetries times. Empirically reliable
    // per [[feedback_atmux_send_for_queued_panes]] — `atmux send`
    // (which already uses safeSendKeysWithVerify) unwedged the 11
    // queued panes a raw Enter could not.
    const bufferName = `atmux_boot_${process.pid}_${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    try {
      await opts.tmux.buffer.loadBuffer({ name: bufferName, data: prompt });
      await opts.tmux.buffer.pasteBuffer({
        name: bufferName,
        target: opts.sendTarget,
        deleteAfter: true,
      });
    } catch {
      // paste-buffer failure on attempt N: try once more if we have
      // budget; otherwise surface as capture-error (the only existing
      // bucket for a tmux-side IO fault).
      if (attempts >= maxAttempts) {
        return { status: "failed", attempts, reason: "capture-error" };
      }
      continue;
    }

    // ADR-081 §A: settle ≥500ms before C-m so bracketed-paste mode
    // has fully digested the paste-buffer envelope. Without this,
    // the C-m races the paste and gets interpreted as "newline
    // inside pasted body" rather than "submit composer".
    await sleep(PASTE_SUBMIT_SETTLE_FLOOR_MS);

    // ADR-138 verified-send-keys: confirm the C-m actually cleared
    // the composer (composerEmpty matches `❯ ` at end-of-line). On
    // verify failure within submitVerifyTimeoutMs, re-fire C-m up
    // to submitVerifyRetries times. After exhaustion, return
    // submit-not-verified — skip the (otherwise wasted) tokensMoved
    // poll since the prompt never made it past the composer.
    const submitVerifyOpts: Parameters<typeof safeSendKeysWithVerify>[0] = {
      target: opts.paneTargetString,
      keys: "C-m",
      capture: (t) => opts.tmux.pane.capturePane({ target: t, start: -40 }),
      sendKeys: async (_t, keys) => {
        await opts.tmux.pane.sendKeys({ target: opts.sendTarget, keys, enter: false });
      },
      expectVerifier: composerEmpty(),
      timeoutMs: submitVerifyTimeoutMs,
      retries: submitVerifyRetries,
      pollIntervalMs: submitVerifyPollIntervalMs,
      onFail: "escalate",
      sleep,
      now,
    };
    if (opts.appendLog !== undefined) submitVerifyOpts.appendLog = opts.appendLog;
    if (opts.home !== undefined) submitVerifyOpts.home = opts.home;
    let submitVerify: Awaited<ReturnType<typeof safeSendKeysWithVerify>>;
    try {
      submitVerify = await safeSendKeysWithVerify(submitVerifyOpts);
    } catch {
      // safeSendKeysWithVerify throws only on onFail:"throw"; we
      // pass "escalate" so this branch is defensive against future
      // shape changes. Treat as capture-error (tmux-side IO fault).
      if (attempts >= maxAttempts) {
        return { status: "failed", attempts, reason: "capture-error" };
      }
      continue;
    }
    if (!submitVerify.success) {
      // C-m never cleared the composer across all
      // safeSendKeysWithVerify retries — escalation log already
      // written by safe-send.ts. Don't burn the 30s tokensMoved
      // window; surface the distinct reason so renderBootFailureNotice
      // can guide the operator to the right intervention (atmux send
      // — which uses verified-send-keys — vs another atmux rotate
      // pass).
      if (attempts >= maxAttempts) {
        return { status: "failed", attempts, reason: "submit-not-verified" };
      }
      continue;
    }

    // Post-send: watch tokens. C-m verified to have cleared the
    // composer at this point; tokensMoved confirms claude actually
    // started a turn (vs. composer-cleared-but-then-stuck).
    const moved = await pollUntil(bootSignalLive, {
      tmux: opts.tmux,
      target: opts.paneTargetString,
      intervalMs: postBootInterval,
      timeoutMs: postBootTimeout,
      sleep,
      now,
    });
    if (moved.found) {
      return { status: "booted", attempts };
    }
    // Not moved within window → loop iteration retries the whole
    // paste+submit+poll cycle (composer-cleared but claude went
    // catatonic — rare; whole-cycle retry handles it).
  }

  return { status: "failed", attempts, reason: "tokens-never-moved" };
}

// ---------- Driver-inbox failure surface ----------

/** Compose a single-line markdown notice for the lead-outbox /
 *  driver-inbox documenting one undead-pane boot failure. Format
 *  follows the global CLAUDE.md Discord/notice rules but adapted
 *  to markdown — verdict-first, timestamped, member-named.
 *
 *  Exported so the test suite can assert exact wording without
 *  flaky string-search. The HH:MM MYT stamp is intentionally
 *  caller-supplied so tests fix time for determinism. */
export function renderBootFailureNotice(args: {
  team: string;
  member: string;
  result: BootResult;
  nowIso: string;
}): string {
  const reasonLabel =
    args.result.reason === "tui-not-ready"
      ? "TUI never reached ready state"
      : args.result.reason === "tokens-never-moved"
        ? "boot prompt sent but tokens never moved"
        : args.result.reason === "capture-error"
          ? "tmux capture-pane / send-keys error"
          : args.result.reason === "submit-not-verified"
            ? "boot prompt pasted but C-m submit was eaten (composer still loaded) — try `atmux send` (uses verified-send-keys) before another rotate"
            : "unknown failure";
  return (
    `## 🚨 [boot-failure] · \`${args.team}\` · \`${args.member}\` · ${args.nowIso}\n\n` +
    `**🔴 Stalled** — member pane undead after ${args.result.attempts} boot attempts: ${reasonLabel}.\n\n` +
    `Suggest: \`atmux rotate ${args.member}\` to retry, OR \`tmux capture-pane -p -t <window>\` to inspect manually.\n\n`
  );
}

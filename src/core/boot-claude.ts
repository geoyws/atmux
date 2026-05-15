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

// ---------- Boot prompt + readiness regex ----------

/** ADR-081 §C task-body §3 verbatim boot prompt. Placeholders are
 *  `{team}` (team name) + `{member}` (member name). Single line so
 *  send-keys + Enter submits cleanly; no bracketed-paste mode is
 *  triggered (which is what makes this approach reliable). */
const BOOT_PROMPT_TEMPLATE =
  "Read /tmp/atmux-brief-generic-{team}.md and your role brief if your role appears in templates/briefs/, then bootstrap as that team member. Your role is {member}.";

/** Render the boot prompt for a (team, member) pair. Exported for
 *  unit tests + observability — the lead-outbox failure surface
 *  echoes this string so the operator can see what was sent. */
export function renderBootPrompt(team: string, member: string): string {
  return BOOT_PROMPT_TEMPLATE.replace("{team}", team).replace("{member}", member);
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

export function isTuiReady(captured: string): boolean {
  return TUI_READY_RE.test(captured);
}

export function tokensMoved(captured: string): boolean {
  return TOKENS_MOVED_RE.test(captured);
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
  reason?: "tui-not-ready" | "tokens-never-moved" | "capture-error";
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

  // (1) Already-booted sentinel: tokens already moving at entry.
  // Captures the "rotation re-entry mid-turn" + "double-call
  // protection" cases. Per reviewer pre-flag: don't double-submit.
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
  if (tokensMoved(initialCapture)) {
    return { status: "already-booted", attempts: 0 };
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
  const prompt = renderBootPrompt(opts.team, opts.member);
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      await opts.tmux.pane.sendKeys({
        target: opts.sendTarget,
        keys: prompt,
        enter: true,
      });
    } catch {
      // send-keys failure on attempt N: try once more if we have
      // budget; otherwise surface.
      if (attempts >= maxAttempts) {
        return { status: "failed", attempts, reason: "capture-error" };
      }
      continue;
    }

    // Post-send: watch tokens.
    const moved = await pollUntil(tokensMoved, {
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
    // Not moved within window → loop iteration retries the send.
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
          : "unknown failure";
  return (
    `## 🚨 [boot-failure] · \`${args.team}\` · \`${args.member}\` · ${args.nowIso}\n\n` +
    `**🔴 Stalled** — member pane undead after ${args.result.attempts} boot attempts: ${reasonLabel}.\n\n` +
    `Suggest: \`atmux rotate ${args.member}\` to retry, OR \`tmux capture-pane -p -t <window>\` to inspect manually.\n\n`
  );
}


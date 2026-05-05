// ADR-003 + ADR-004 amend: src/core/send.ts — multi-line message
// delivery to a teammate's tmux pane.
//
// Ports the per-member delivery pipeline from bash `lib/send.sh::
// atmux::send_to_member` (HEAD `2aadc3f`). The verb-level layer (`send`,
// `broadcast`, `tell-lead` in Phase 2 `src/verbs/*`) handles flag
// parsing + iteration; this core lib handles the per-target
// "capture, classify, load-buffer, paste, sleep, Enter, log, verify"
// sequence.
//
// Layer rule (ADR-003): core libs take dependencies as args. The
// caller passes a socket-pinned `tmux` namespace from `createTmux(...)`
// per ADR-004 amend. There is no implicit socket fallback.
//
// Parity contract (PLAN.md §4.1, ADR-013) — source-cited per
// `feedback_lead_task_desc_source_grep.md`:
//
// - lib/send.sh:86 — `atmux::capture_pane "$member" 40` BEFORE send
// - lib/send.sh:91 — heuristic grep for not-ready markers
//   (Compacting, queued, rate-limit) → WARN, but proceed (line 92)
// - lib/send.sh:96-105 — write tmpfile, `tmux load-buffer -b <buf>`.
//   The TS port skips the tmpfile by piping data directly via
//   `tmux.buffer.loadBuffer({ data })` (which uses spawn's `stdin`).
// - lib/send.sh:107-108 — `tmux paste-buffer -b <buf> -d -t <target>`
//   (with `2>/dev/null || …` fallback for old tmux). The TS port pins
//   tmux ≥3.3 (ADR-004 §"Version pinning") so `-d` is always safe;
//   `tmux.buffer.pasteBuffer({ deleteAfter: true })` handles it.
// - lib/send.sh:117 — `sleep 0.3` between paste and Enter
// - lib/send.sh:118 — `tmux send-keys -t <target> Enter`
// - lib/send.sh:122-132 — `verify`: `sleep 2`, `capture_pane … 10`,
//   if msg snippet still in last 3 lines AND last line looks like a
//   prompt, return outcome 2 ("may not have consumed")
// - lib/send.sh:136-145 — append "[<iso>] sent:\n  | <msg>\n\n" to
//   `<atmuxDir>/logs/send-<member>.log`
//
// What the TS port deliberately drops:
// - lib/send.sh:64-78 — `atmux::sock_publish` event-driven supervisor
//   path (E13/Sc). That entire mechanism is Phase 5 WIP per ADR-013;
//   `ATMUX_LEGACY_SEND=1` is the bash side's escape hatch and Phase 1
//   ports the legacy direct-send path only.
// - The "wait-for-prompt-then-send" framing in Task #7's description
//   overstates bash: there is no busy-wait on prompt readiness; bash
//   captures, classifies, warns, and proceeds with a fixed 0.3s sleep.
//   The "grace window" is that 0.3s sleep, not a polling loop.

import { join } from "node:path";
import { appendText, ensureDir } from "../abstractions/fs.ts";
import { nowIso } from "../abstractions/time.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import { classifyPaneState, logsDir, type PaneStateSnapshot } from "./common.ts";

// ---------- Public API ----------

export interface SendOpts {
  /** Skip the final Enter; leaves the message queued in the pane buffer.
   *  Mirrors bash `--no-submit`. Default `false`. */
  noSubmit?: boolean;
  /** Post-send capture+grep to soft-verify the message was consumed.
   *  Mirrors bash `--verify` (default-on). Default `true`. */
  verify?: boolean;
  /** Delay between paste-buffer and Enter, in ms. Mirrors bash
   *  `sleep 0.3` at lib/send.sh:117. Default `300`. */
  preSubmitDelayMs?: number;
  /** Delay between Enter and the post-send verify capture, in ms.
   *  Mirrors bash `sleep 2` at lib/send.sh:123. Default `2000`. */
  verifyDelayMs?: number;
  /** Buffer name override. Default `atmux_msg_<pid>_<rand>`, matching
   *  bash `atmux_msg_$$_${RANDOM}` shape from lib/send.sh:100. */
  bufferName?: string;
  /** Pre-send capture lookback (lines). Default `40` (lib/send.sh:86). */
  capturePreLines?: number;
  /** Post-send verify capture lookback (lines). Default `10` (lib/send.sh:124). */
  capturePostLines?: number;
  /**
   * Sleep injection point — tests pass a no-op to skip the real delays.
   * Default uses `setTimeout`. Both pre-submit + verify-delay route
   * through the same hook so a single override silences both.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface SendTarget {
  /** tmux target spec. Built by the verb via
   *  `serializeTarget(...)` or `getSessionName + buildWindowName`. */
  target: string;
  /** Member name — used as the logging filename component
   *  (`<atmuxDir>/logs/send-<member>.log`). */
  member: string;
}

export interface SendOutcome {
  /** Final state. Mirrors bash exit-code convention (lib/send.sh:114
   *  ok / queued path, line 130 warn-not-consumed `return 2`). */
  kind: "ok" | "queued" | "warn-not-consumed";
  /** Pre-send pane snapshot. `preSnapshot.{busy, rateLimit, …}` lets
   *  callers print the bash warning ("$member: pane may not be ready")
   *  with specific detail (busy / compacting / rate-limit / etc.). */
  preSnapshot: PaneStateSnapshot;
  /**
   * True when the pre-send classifier matched ANY not-ready marker
   * (matches bash regex at lib/send.sh:91). Bash warns + proceeds; we
   * surface the boolean so the verb can render the warning at exactly
   * the same point bash does, without re-running the regex.
   */
  preWarn: boolean;
}

/**
 * Send `msg` into `target.target`'s pane.
 *
 * - tmux is socket-pinned (ADR-004 amend). Caller built it with
 *   `createTmux({ socket | socketPath })`.
 * - `atmuxDir` is used solely for the log-write path
 *   (`logsDir(atmuxDir)/send-<member>.log`).
 * - Any tmux failure (window absent, paste failed, …) propagates as
 *   `TmuxError` per ADR-006; this function does not swallow.
 */
export async function sendToMember(
  tmux: TmuxNamespace,
  atmuxDir: string,
  target: SendTarget,
  msg: string,
  opts?: SendOpts,
): Promise<SendOutcome> {
  const sleep = opts?.sleep ?? defaultSleep;
  const verify = opts?.verify ?? true;
  const noSubmit = opts?.noSubmit ?? false;
  const preLines = opts?.capturePreLines ?? 40;
  const postLines = opts?.capturePostLines ?? 10;
  const preSubmitDelayMs = opts?.preSubmitDelayMs ?? 300;
  const verifyDelayMs = opts?.verifyDelayMs ?? 2000;
  const bufferName = opts?.bufferName ?? defaultBufferName();

  // 1. Pre-send capture + classify (lib/send.sh:86-92).
  const preCapture = await tmux.pane.capturePane({
    target: target.target,
    start: -preLines,
  });
  const preSnapshot = classifyPaneState(preCapture);
  const preWarn = isPreSendWarn(preSnapshot);

  // 2. Load the body into a buffer + paste it into the target pane.
  //    Bash uses a tmpfile; we pipe directly via spawn's stdin (the
  //    tmux abstraction's `loadBuffer({ data })` shape from ADR-004
  //    amend handles this via the closure-pinned socket flag).
  await tmux.buffer.loadBuffer({ name: bufferName, data: msg });
  await tmux.buffer.pasteBuffer({
    name: bufferName,
    target: target.target,
    deleteAfter: true,
  });

  // 3. --no-submit short-circuit: leave the buffer pasted but don't
  //    press Enter. Mirrors bash lib/send.sh:111-113.
  if (noSubmit) {
    return { kind: "queued", preSnapshot, preWarn };
  }

  // 4. Brief pause, then submit with a literal Enter keyname.
  //    `enter: false` here is intentional — `keys: "Enter"` IS the
  //    keyname; without `enter: false` the wrapper would append a
  //    second Enter (`send-keys -t <target> Enter Enter`).
  await sleep(preSubmitDelayMs);
  await tmux.pane.sendKeys({
    target: target.target,
    keys: "Enter",
    enter: false,
  });

  // 5. Append to the per-member log (lib/send.sh:136-145).
  await appendSendLog(atmuxDir, target.member, msg);

  // 6. Optional post-send verify (lib/send.sh:122-132).
  if (verify) {
    await sleep(verifyDelayMs);
    const post = await tmux.pane.capturePane({
      target: target.target,
      start: -postLines,
    });
    if (looksLikeNotConsumed(post, msg)) {
      return { kind: "warn-not-consumed", preSnapshot, preWarn };
    }
  }

  return { kind: "ok", preSnapshot, preWarn };
}

// ---------- Internals ----------

/**
 * True when the pre-send snapshot indicates the pane is in a state
 * where bash would warn ("pane may not be ready"). Mirrors the regex
 * at lib/send.sh:91:
 *
 *   'Compacting conversation|Press up to edit queued messages|
 *    Now using extra usage|hit your limit|rate.?limit'
 *
 * We map those tokens onto common.ts's classifier outputs:
 * `compacting`, `queuedMessages`, `rateLimit !== "none"`. The
 * "Now using extra usage" / "rate.?limit" tokens are both subsumed
 * by `detectRateLimit` (soft + hard tiers). Busy + contextCleared
 * are NOT in bash's warn-list, so we deliberately exclude them.
 */
export function isPreSendWarn(s: PaneStateSnapshot): boolean {
  return s.compacting || s.queuedMessages || s.rateLimit !== "none";
}

/**
 * Soft-verify heuristic ported from lib/send.sh:128:
 *
 *   if echo "$post" | tail -3 | grep -qF "$snippet" \
 *      && echo "$post" | tail -1 | grep -qE '^\s*[❯>›$#]';
 *
 * Returns true when the message snippet (first 50 chars of msg, bash
 * `head -c 50`) is still visible in the last 3 lines AND the last
 * non-empty line looks like a shell/REPL prompt. Both conditions
 * must hold; either alone is too noisy to act on.
 *
 * Exported for direct unit-testing of the heuristic without needing to
 * stage a tmux pane in the exact prompt state — same testability
 * pattern as the parse helpers exported from `src/abstractions/tmux.ts`.
 */
export function looksLikeNotConsumed(postCapture: string, msg: string): boolean {
  // Strip the trailing newline tmux always tacks on, then split.
  const lines = postCapture.replace(/\n$/, "").split("\n");
  const snippet = msg.slice(0, 50);
  const last3 = lines.slice(-3).join("\n");
  // Bash's `tail -1` gives the literal last line, including blank ones.
  const lastLine = lines[lines.length - 1] ?? "";
  if (!last3.includes(snippet)) return false;
  return /^\s*[❯>›$#]/.test(lastLine);
}

/** Default buffer name shape mirrors bash `atmux_msg_$$_${RANDOM}`. */
function defaultBufferName(): string {
  const rand = Math.floor(Math.random() * 1_000_000);
  return `atmux_msg_${process.pid}_${rand}`;
}

/** Default sleep — wraps `setTimeout` in a Promise. Tests inject a no-op. */
function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Append a single send-log entry. Output shape mirrors bash
 * lib/send.sh:140-144 — timestamp line + indented msg body + blank
 * trailing line:
 *
 *   [2026-05-04T11:44:00Z] sent:
 *     | hello world
 *     | second line
 *
 *   <blank>
 *
 * Indent prefix is `"  | "` (2 spaces + bar + space) matching bash's
 * `sed 's/^/  | /'`.
 */
async function appendSendLog(atmuxDir: string, member: string, msg: string): Promise<void> {
  const path = join(logsDir(atmuxDir), `send-${member}.log`);
  await ensureDir(logsDir(atmuxDir));
  const indented = msg
    .split("\n")
    .map((line) => `  | ${line}`)
    .join("\n");
  const entry = `[${nowIso()}] sent:\n${indented}\n\n`;
  await appendText(path, entry);
}

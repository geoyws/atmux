// ADR-081 §A: post-paste submit cascade.
// ADR-231 (2026-05-23): keystroke updated from `C-m` symbolic to
// literal `\r` via `-l` mode — tmux 3.6 + Claude Code v2.1.150 eats
// both symbolic `C-m` and `Enter`; literal CR is the only submit path
// that works. ADR-081 §A's bracketed-paste-envelope rationale is
// preserved; ADR-188's 4-step canonical pattern is unaffected.
//
// Every paste-buffer-then-submit call site routes the trailing submit
// through this helper. The shape — `sleep(≥500) → tmux send-keys ... -l $'\r'`
// — exists for one reason: under claude TUIs' bracketed-paste mode the
// `tmux paste-buffer -d` envelope makes the immediately-following
// `tmux send-keys ... Enter` get interpreted as "newline inside the
// pasted message" rather than "submit the compose box." Literal CR via
// `-l` bypasses the bracketed-paste interpretation entirely AND avoids
// the tmux 3.6 + Claude TUI symbolic-key-eating regression.
//
// Proven during the 2026-05-12 atmux team manual recovery (ADR-081 §A
// "Audit trail"): the same buffer that silently starved 11 panes via
// `... Enter` was submitted by `sleep 0.8 && tmux send-keys ... C-m`
// across all 11 panes successfully. The settle delay is critical — too
// fast and the paste hasn't fully landed in the compose box; the spec
// floor is ≥500ms.
//
// Callers that need to PRE-FLIGHT for a modal before pasting (rotate /
// send) handle that themselves via `safePreflight`; this helper is the
// trailing-submit-only piece.

import type { SendTarget, TmuxNamespace } from "../abstractions/tmux.ts";

/** Minimum settle duration between paste-buffer and the C-m submit.
 *  Floor per ADR-081 §A. Callers may bump higher; bumping LOWER risks
 *  resurrecting the bracketed-paste-Enter swallowing bug. */
export const PASTE_SUBMIT_SETTLE_FLOOR_MS = 500;

export interface SubmitAfterPasteOpts {
  /** Settle delay before the C-m send-keys. Default
   *  {@link PASTE_SUBMIT_SETTLE_FLOOR_MS} (500ms). Values BELOW the
   *  floor are clamped up; values above are honored as-is. */
  settleMs?: number;
  /** Sleep override for tests (avoids real timers). Default uses
   *  `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Submit the message currently sitting in `target`'s compose box after a
 * preceding `tmux.buffer.pasteBuffer` call. Sleeps {@link settleMs} then
 * fires `tmux send-keys -t <target> -l $'\r'` (literal carriage return
 * via `-l` mode; see ADR-231 for the tmux 3.6 keystroke regression).
 *
 * Always pass the SAME `SendTarget` that was passed to `pasteBuffer` —
 * the discriminated union gates driver-pane bans at the type level
 * (ADR-025); routing the submit through a bare string target would
 * sidestep that protection.
 *
 * Returns nothing meaningful; the side effect is the keystroke. Caller
 * is responsible for any post-submit verify capture (mirroring the
 * existing `send.ts` `verify` path).
 */
export async function submitAfterPaste(
  tmux: TmuxNamespace,
  target: SendTarget,
  opts: SubmitAfterPasteOpts = {},
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const requested = opts.settleMs ?? PASTE_SUBMIT_SETTLE_FLOOR_MS;
  const settle =
    requested >= PASTE_SUBMIT_SETTLE_FLOOR_MS ? requested : PASTE_SUBMIT_SETTLE_FLOOR_MS;
  await sleep(settle);
  // ADR-231: literal CR replaces C-m symbolic — see file-header comment.
  await tmux.pane.sendKeys({ target, keys: "\r", literal: true, enter: false });
}

// ---------- ADR-138 T3b3: pasteAndSubmit bundled primitive ----------

/** Bundled text-body injection options — `pasteAndSubmit` composes
 *  loadBuffer + pasteBuffer + submitAfterPaste in one call. Callers
 *  that need just submit-after-paste (compose box already populated)
 *  still reach for {@link submitAfterPaste} directly. */
export interface PasteAndSubmitOpts extends SubmitAfterPasteOpts {
  /** Buffer name override. Default `atmux_paste_<pid>_<rand>` —
   *  matches the `sendToMember` precedent in `src/core/send.ts`. */
  bufferName?: string;
}

function defaultBufferName(): string {
  // Mirrors `src/core/send.ts`'s `bufferName` shape (`atmux_msg_$$_R`).
  // Independent randomness so concurrent lane-tick + send calls don't
  // collide on the same buffer slot.
  const pid = typeof process !== "undefined" ? process.pid : 0;
  const rand = Math.floor(Math.random() * 1_000_000).toString(36);
  return `atmux_paste_${pid}_${rand}`;
}

/**
 * ADR-138 T3b3 / ADR-081 §A: canonical text-body injection primitive.
 *
 * Bundles the three steps every text-body callsite needs to avoid the
 * bracketed-paste-Enter-swallow bug:
 *
 *   1. `tmux.buffer.loadBuffer({ name, data })`          — stage text in named buffer
 *   2. `tmux.buffer.pasteBuffer({ name, target, -d })`   — paste + auto-delete buffer
 *   3. `submitAfterPaste(tmux, target)`                  — settle ≥500ms + `C-m`
 *
 * Step 3's `C-m` is the literal carriage-return keysym — bypasses the
 * bracketed-paste-mode envelope that wraps `paste-buffer -d`, where a
 * trailing `Enter` would otherwise be interpreted as "newline inside
 * the pasted body" rather than "submit the compose box." This shape
 * was empirically validated during the 2026-05-12 atmux team manual
 * recovery (ADR-081 §A "Audit trail") + re-confirmed by the 2026-05-15
 * lane-tick claim-injection P0 (`atmux task show t-06547e2d`).
 *
 * Use this helper for ALL text-body injection (claim commands,
 * brief content, post-rotate paste, etc.). Reserve raw
 * `tmux.pane.sendKeys` for CONTROL-KEY sequences only: `C-c`, `BTab`,
 * single-character modal selections, `/clear` slash-commands. The
 * raw path is fine when the keystroke isn't passing through the
 * bracketed-paste envelope.
 *
 * No verification — callers that need post-submit verify wrap this
 * with `safeSendKeysWithVerify` (existing pattern in `src/core/send.ts`
 * step 4a) or `safeSendKeys`'s preflight loop (existing pattern in
 * `src/verbs/lane-tick.ts` post-T3b3). The bundled-but-not-verified
 * shape keeps the helper composable across both verify-on and
 * verify-off callers.
 */
export async function pasteAndSubmit(
  tmux: TmuxNamespace,
  target: SendTarget,
  text: string,
  opts: PasteAndSubmitOpts = {},
): Promise<void> {
  const bufferName = opts.bufferName ?? defaultBufferName();
  await tmux.buffer.loadBuffer({ name: bufferName, data: text });
  await tmux.buffer.pasteBuffer({ name: bufferName, target, deleteAfter: true });
  const submitOpts: SubmitAfterPasteOpts = {};
  if (opts.settleMs !== undefined) submitOpts.settleMs = opts.settleMs;
  if (opts.sleep !== undefined) submitOpts.sleep = opts.sleep;
  await submitAfterPaste(tmux, target, submitOpts);
}

// ADR-081 §A: post-paste submit cascade.
//
// Every paste-buffer-then-submit call site routes the trailing submit
// through this helper. The shape — `sleep(≥500) → tmux send-keys ... C-m`
// — exists for one reason: under claude TUIs' bracketed-paste mode the
// `tmux paste-buffer -d` envelope makes the immediately-following
// `tmux send-keys ... Enter` get interpreted as "newline inside the
// pasted message" rather than "submit the compose box." `C-m` (the
// literal carriage return keysym) bypasses the bracketed-paste
// interpretation entirely.
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
 * fires `tmux send-keys -t <target> C-m` (literal carriage return).
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
  await tmux.pane.sendKeys({ target, keys: "C-m", enter: false });
}

// e-13-04c8b3bf — pane statusline capture + Claude context-% parser.
//
// Captures the last N lines of a member pane via tmux capture-pane,
// then parses the Claude Code TUI statusline for the context-used
// percentage. Used by `atmux orchd --scan-context` every 15min to
// detect members approaching handoff-worthy saturation.
//
// Claude statusline shape (sampled 2026-05-24):
//
//   geoyws@proton.me max  │  Opus 4.7 ·1M ·xhigh  │  ████░░░░░░ 43%  │  5h 21% ↻3h29m · wk 21% ↻5d6h39m  │  tok 431.0k/855
//
// The context segment is `████░░░░░░ NN%` — block-bar + percentage.
// We anchor on that combination so other percentages in the line
// (rate-limit windows) don't false-match. Defensive: when no bar+%
// segment is found, returns null and the caller skips the emit.

import type { TmuxNamespace } from "../abstractions/tmux.ts";

/** Default lookback for capture-pane. 12 lines is enough to capture
 *  the statusline + a couple of preceding lines for context, without
 *  pulling huge transcripts. */
export const DEFAULT_CAPTURE_LINES = 12;

/** Match `████████░░░░ 43%` — Unicode block-bar followed by an
 *  integer percentage. The bar can use `█` (full) and `░` (empty);
 *  Claude's TUI may also render with `▌` etc. on narrow widths.
 *  Accept any of those chars in the bar segment. */
const CONTEXT_BAR_RE = /[█░▌▎▍▋▊▉]+\s+(\d{1,3})%/u;

/** Parsed context-usage signal extracted from a member pane. */
export interface ContextUsage {
  /** 0-100 integer percent context consumed. */
  percent: number;
  /** The exact statusline substring matched — used for debug + emit
   *  payload so operators see what the parser saw. */
  matchedSegment: string;
  /** Full captured pane text (post-trim), kept for diagnostics when
   *  the parser returns null + the caller wants to investigate. */
  rawCapture: string;
}

/** Extract the context-% from a captured pane text. Returns null when
 *  no statusline bar+% pattern matches — caller treats as "unknown,
 *  no event". Best-effort: a member running a different TUI (bash
 *  shell, vim, etc.) returns null cleanly. */
export function parseContextPercent(rawCapture: string): ContextUsage | null {
  const m = CONTEXT_BAR_RE.exec(rawCapture);
  if (m === null) return null;
  const pctStr = m[1];
  if (pctStr === undefined) return null;
  const percent = Number.parseInt(pctStr, 10);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return { percent, matchedSegment: m[0], rawCapture };
}

/** Capture a pane's last N lines via tmux capture-pane -p. Negative
 *  `start` per tmux convention = lines before the visible bottom.
 *  Returns the joined text on success, throws on tmux failure
 *  (caller's scan-context handler catches per-member errors so one
 *  bad pane doesn't halt the sweep). */
export async function capturePaneTail(
  tmux: TmuxNamespace,
  target: string,
  lines: number = DEFAULT_CAPTURE_LINES,
): Promise<string> {
  return await tmux.pane.capturePane({ target, start: -lines });
}

// SPEC-063: bun port of bash `_atmux_whip_check_decisions`
// (.archive-bash-atmux-20260507/lib/whip.sh:376-435; design in ADR-008
// §S8 D13). Surfaces a Discord ping to the team's lead+driver channel
// whenever new entries appear in `<atmuxDir>/decisions.md` since the
// last whip tick.
//
// State file `<atmuxDir>/state/decisions-cursor` holds the file mtime
// of the last decisions.md observed by whip; advance happens AFTER the
// Discord ping fires (so a ping-fail tick doesn't silently skip the
// finding next time).
//
// Foundation gap: the bun port of `atmux decisions add` / `atmux
// decisions list` is not yet ported (returns "unknown verb" today).
// The bash watcher's inline-preview path consumes
// `atmux decisions list --since <cursor> --json`; without the bun
// verb, the watcher falls back to the flag-only pointer
// `📋 N new decisions — atmux decisions list` (bash whip.sh:432
// fallback path). When the bun decisions-list verb ports, callers can
// upgrade this module's `bullet` output without changing the cursor
// state shape.
//
// Cursor convention matches bash exactly: file mtime as epoch seconds
// written to `<state>/decisions-cursor`. This means a bun-whip tick
// will respect any cursor advance the bash-whip already made (and
// vice-versa) — operationally important during the dual-runtime
// window.

import { readFile } from "node:fs/promises";
import { atomicWrite, statOrNull } from "../abstractions/fs.ts";
import { decisionsLogPath, stateDir } from "./common.ts";
import { join } from "node:path";

/** Cursor file name. Matches bash lib/whip.sh:382. */
const CURSOR_FILENAME = "decisions-cursor";

export interface DecisionsCheckArgs {
  atmuxDir: string;
}

export interface DecisionsCheckVerdict {
  /** True iff there are new entries since the cursor. */
  fire: boolean;
  /** Finding bullet when `fire === true`; `null` otherwise. */
  bullet: string | null;
  /** Number of new entries detected. */
  newCount: number;
  /** New cursor value (file mtime, epoch seconds) when `fire === true`;
   *  caller persists via {@link advanceDecisionsCursor} AFTER the
   *  Discord ping fires. `null` when no advance needed. */
  newCursor: number | null;
}

/**
 * Compute the decisions-watcher verdict for one whip tick. Pure-ish:
 * reads decisions.md + cursor file, no writes (cursor advance is
 * deferred to `advanceDecisionsCursor` so the ping/cursor ordering
 * matches bash semantics — see file header).
 *
 * Returns `fire: false` in any of these cases:
 *   - decisions.md absent (silent no-op — clean teams start without it)
 *   - decisions.md mtime ≤ cursor (no new content)
 *   - file present + mtime newer but zero entries with timestamp > cursor
 *     (e.g. someone edited the prose preamble without adding entries)
 */
export async function checkDecisions(
  args: DecisionsCheckArgs,
): Promise<DecisionsCheckVerdict> {
  const baseVerdict: DecisionsCheckVerdict = {
    fire: false,
    bullet: null,
    newCount: 0,
    newCursor: null,
  };

  const path = decisionsLogPath(args.atmuxDir);
  const st = await statOrNull(path);
  if (st === null) return baseVerdict;

  const mtimeNew = Math.floor(st.mtimeMs / 1000);
  const cursorOld = await readDecisionsCursor(args.atmuxDir);

  if (mtimeNew <= cursorOld) return baseVerdict;

  const content = await readFile(path, "utf8");
  const newCount = countEntriesSince(content, cursorOld);

  if (newCount === 0) return baseVerdict;

  // Fallback-pointer bullet — see file header on the inline-preview
  // path's `atmux decisions list --since <cursor> --json` dependency.
  const bullet = `📋 ${newCount} new decision${newCount === 1 ? "" : "s"} — atmux decisions list`;
  return { fire: true, bullet, newCount, newCursor: mtimeNew };
}

/**
 * Pure: count entries in a decisions.md body whose `- **timestamp**:`
 * line has an epoch-second value strictly greater than `cursor`.
 * Mirrors the bash awk filter at lib/whip.sh:392-401.
 *
 * The decisions.md format (per ADR-008 §S9) puts each entry's timestamp
 * field on a separate line two lines below its `### d-<id>` header.
 * We only count timestamp lines that follow a `### d-` entry header
 * (defends against stray `- **timestamp**:` lines in prose).
 */
export function countEntriesSince(content: string, cursor: number): number {
  let inEntry = false;
  let count = 0;
  const lines = content.split("\n");
  for (const line of lines) {
    if (/^### \s*d-/.test(line)) {
      inEntry = true;
      continue;
    }
    const m = line.match(/^- \*\*timestamp\*\*:\s*(\d+)\s*$/);
    if (m !== null) {
      if (inEntry) {
        const ts = Number(m[1]);
        if (Number.isFinite(ts) && ts > cursor) count += 1;
      }
      inEntry = false;
    }
  }
  return count;
}

/** Read the cursor value (epoch seconds). Returns 0 when absent or
 *  malformed — matches the bash `dcursor_old=0` default at
 *  lib/whip.sh:383-387. */
export async function readDecisionsCursor(atmuxDir: string): Promise<number> {
  const path = cursorPath(atmuxDir);
  try {
    const body = await readFile(path, "utf8");
    const trimmed = body.trim();
    if (!/^\d+$/.test(trimmed)) return 0;
    const v = Number(trimmed);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Persist the cursor. Caller invokes AFTER the Discord ping has been
 *  attempted (per bash lib/whip.sh:437-448 — fire-and-warn ordering).
 *  Atomic write so a crash mid-tick never leaves a torn cursor. */
export async function advanceDecisionsCursor(
  atmuxDir: string,
  cursor: number,
): Promise<void> {
  await atomicWrite(cursorPath(atmuxDir), `${cursor}\n`);
}

function cursorPath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), CURSOR_FILENAME);
}

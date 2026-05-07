// Sender-side heads-up dedup cursor (t-bf09aec0).
//
// Heads-up emitters (bash supervisor lib/supervisor.sh:131-161, TS
// `tell-lead`, future TS supervisor) fire on every state-file mtime
// change. Without dedup, 10 unrelated mtime touches across multiple
// teammates produce 10 `/coordination:heads-up` pings, each of which
// the lead pane processes and prints "Stale heads-up — already
// absorbed" after re-reading the source file. Each "stale" turn
// burns ~2-5k tokens.
//
// This module provides per-source mtime cursor primitives. Emitters
// call `shouldEmitHeadsUp({ atmuxDir, source, target, sourceMtimeMs })`
// before firing — if the source's current mtime is `<=` the recorded
// cursor for `(source, target)`, the emit is suppressed (the lead has
// already been pinged for this revision). After a successful emit,
// callers `recordHeadsUp(...)` to advance the cursor.
//
// State file layout: `<atmuxDir>/state/heads-up-cursor.json`
// {
//   "<source>:<target>": <last-emitted-source-mtime-ms>,
//   ...
// }
//
// Atomic-write semantics inherited from `abstractions/fs.atomicWrite`
// (mktemp + rename). Read-modify-write is best-effort; concurrent
// emitters may race and one will lose the cursor update. Acceptable
// trade-off: a lost-update means at most ONE redundant ping (the
// next emitter sees the older cursor + fires); the dedup is best-
// effort, not strict-once.

import { join } from "node:path";
import { atomicWrite, ensureDir, readTextOrNull } from "../abstractions/fs.ts";

const STATE_FILENAME = "heads-up-cursor.json";

export function headsUpCursorPath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** Cursor map: `<source>:<target>` → last-emitted source mtime (ms). */
export type HeadsUpCursor = Record<string, number>;

/** Compose the canonical map key. */
export function cursorKey(source: string, target: string): string {
  return `${source}:${target}`;
}

/** Read cursor from disk. Empty map on missing or malformed file
 *  (corruption is non-fatal — re-arms the dedup at one extra ping). */
export async function loadHeadsUpCursor(atmuxDir: string): Promise<HeadsUpCursor> {
  const path = headsUpCursorPath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: HeadsUpCursor = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic-write the full cursor map. Creates `state/` dir if missing. */
export async function writeHeadsUpCursor(
  atmuxDir: string,
  cursor: HeadsUpCursor,
): Promise<void> {
  await ensureDir(join(atmuxDir, "state"));
  await atomicWrite(headsUpCursorPath(atmuxDir), JSON.stringify(cursor));
}

export interface HeadsUpEmitOpts {
  atmuxDir: string;
  /** Identifier for the change-source (e.g. file path or logical
   *  name). Stable across calls — do NOT include process-specific
   *  bits. The same source from two emitter processes must collide
   *  on the same cursor entry. */
  source: string;
  /** Identifier for the recipient (e.g. lead pane name). */
  target: string;
  /** Current mtime of the source, in ms epoch. Caller passes
   *  `statOrNull(path).mtimeMs`. */
  sourceMtimeMs: number;
}

/**
 * Returns `true` iff the (source, target) pair has NOT been pinged
 * for `sourceMtimeMs` (or any later mtime). Caller fires the heads-up
 * IFF this returns true, then calls `recordHeadsUp` post-fire.
 *
 * Returns `false` (suppress) when:
 *   - cursor[key] >= sourceMtimeMs (already pinged for this revision)
 *   - sourceMtimeMs is not a finite number (defensive — bad mtime
 *     shouldn't fire a ping that can't be deduped later)
 */
export async function shouldEmitHeadsUp(opts: HeadsUpEmitOpts): Promise<boolean> {
  if (!Number.isFinite(opts.sourceMtimeMs)) return false;
  const cursor = await loadHeadsUpCursor(opts.atmuxDir);
  const last = cursor[cursorKey(opts.source, opts.target)] ?? 0;
  return opts.sourceMtimeMs > last;
}

/**
 * Advance the cursor for (source, target) to `sourceMtimeMs`. Idempotent:
 * a second call with the same or earlier mtime is a no-op (we never
 * regress the cursor — that would produce double-fires on recovery).
 */
export async function recordHeadsUp(opts: HeadsUpEmitOpts): Promise<void> {
  if (!Number.isFinite(opts.sourceMtimeMs)) return;
  const cursor = await loadHeadsUpCursor(opts.atmuxDir);
  const key = cursorKey(opts.source, opts.target);
  const prev = cursor[key] ?? 0;
  if (opts.sourceMtimeMs <= prev) return;
  cursor[key] = opts.sourceMtimeMs;
  await writeHeadsUpCursor(opts.atmuxDir, cursor);
}

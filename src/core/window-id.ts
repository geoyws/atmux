// ADR-057 §D5b: window-ID resolution + on-disk cache.
//
// Folds the P1 supervisor send-keys decision (option-b emoji-prefix
// glob) — STRICTLY STRONGER. Window IDs (`@N`) are immutable across
// renames + reorderings; window NAMES drift (emoji prefix flips per
// ADR-048 etc.) and break dispatch when the supervisor addresses by
// name.
//
// `resolveWindowId(opts) → "@N"` is the single primitive every
// addressing callsite goes through. First lookup populates the cache
// at `.atmux/state/window-id-cache.json`; subsequent lookups read the
// cache, validate against the current tmux session start-epoch, and
// return the cached id without re-listing windows.
//
// Cache invalidation: stamped with the tmux session's `session_created`
// epoch. When the session is killed + restarted, the new
// `session_created` differs; cache miss → relookup → repopulate. No
// TTL — staleness is structural, not temporal.
//
// Pure file I/O via abstractions/fs + abstractions/json. Tmux access
// via the TmuxNamespace passed in by the caller (per ADR-003 layer
// rule). Tests inject both.

import { join } from "node:path";
import { z } from "zod";
import { readTextOrNull, writeText } from "../abstractions/fs.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import { stateDir } from "./common.ts";

// ---------- Cache schema ----------

const PerTeamCache = z.object({
  /** tmux `session_created` epoch — invalidates the cache when the
   *  session restarts. */
  sessionStartedAt: z.number().int().nonnegative(),
  /** member-name → window-id (`@N`). */
  windows: z.record(z.string(), z.string()),
});

const Cache = z.record(z.string(), PerTeamCache);

export type WindowIdCache = z.infer<typeof Cache>;
export type PerTeamWindowIdCache = z.infer<typeof PerTeamCache>;

const CACHE_FILENAME = "window-id-cache.json";

/** Resolve `<atmuxDir>/state/window-id-cache.json`. */
export function windowIdCachePath(atmuxDir: string): string {
  return join(stateDir(atmuxDir), CACHE_FILENAME);
}

// ---------- Cache I/O ----------

/** Read the on-disk cache. Returns `{}` on absent / corrupt — corrupt
 *  cache is recoverable: next lookup repopulates. */
export async function readCache(atmuxDir: string): Promise<WindowIdCache> {
  const txt = await readTextOrNull(windowIdCachePath(atmuxDir));
  if (txt === null || txt.length === 0) return {};
  try {
    const parsed = JSON.parse(txt);
    const result = Cache.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/** Atomic write via writeText (which uses tmp+rename per ADR-057 §D3c). */
export async function writeCache(atmuxDir: string, cache: WindowIdCache): Promise<void> {
  await writeText(windowIdCachePath(atmuxDir), `${JSON.stringify(cache, null, 2)}\n`);
}

// ---------- Public API ----------

export interface ResolveWindowIdOpts {
  /** atmux dir for cache file location. */
  atmuxDir: string;
  /** Team name — namespaces the cache (one cache file per atmux dir
   *  but multi-team setups exist). */
  team: string;
  /** tmux session name. */
  sessionName: string;
  /** Member-name to resolve. Used as cache key + listWindows match. */
  member: string;
  /** Expected tmux window name — what listWindows would emit. Built
   *  by the caller via `buildWindowName(member, emoji)` (which knows
   *  the emoji-prefix convention; this module is convention-agnostic
   *  on purpose). */
  windowName: string;
  /** Tmux namespace pinned to the right socket. */
  tmux: TmuxNamespace;
  /** Override `session_created` lookup (test injection). */
  getSessionStartedAt?: (sessionName: string) => Promise<number>;
}

export type ResolveWindowIdResult =
  | { kind: "ok"; windowId: string; cacheHit: boolean }
  | { kind: "not-found" };

/**
 * Resolve a member's tmux window to its immutable `@N` ID.
 *
 * Lookup order:
 *   1. Read cache. If team entry exists AND cache.sessionStartedAt
 *      matches the current session's `session_created` AND the member
 *      key is present → return cached id (cacheHit=true).
 *   2. Else: list windows, find by name match, persist + return.
 *   3. Window name not found → `{ kind: "not-found" }`. Caller falls
 *      back to name-based addressing OR escalates per its own policy.
 */
export async function resolveWindowId(opts: ResolveWindowIdOpts): Promise<ResolveWindowIdResult> {
  const sessionStartedAt = await (
    opts.getSessionStartedAt ?? defaultGetSessionStartedAt(opts.tmux)
  )(opts.sessionName);
  const cache = await readCache(opts.atmuxDir);
  const teamEntry = cache[opts.team];

  if (
    teamEntry !== undefined &&
    teamEntry.sessionStartedAt === sessionStartedAt &&
    teamEntry.windows[opts.member] !== undefined
  ) {
    return { kind: "ok", windowId: teamEntry.windows[opts.member] ?? "", cacheHit: true };
  }

  // Cache miss / stale / restart → re-list + repopulate.
  const windows = await opts.tmux.window.listWindows(opts.sessionName);
  const match = windows.find((w) => w.name === opts.windowName);
  if (match === undefined || match.id.length === 0) return { kind: "not-found" };

  // Repopulate the team's cache slot. Stale-session entries for the
  // SAME team are wiped (sessionStartedAt mismatch invalidates ALL
  // members under that team — see header). Other-team entries are
  // untouched.
  const newWindows: Record<string, string> =
    teamEntry !== undefined && teamEntry.sessionStartedAt === sessionStartedAt
      ? { ...teamEntry.windows }
      : {};
  newWindows[opts.member] = match.id;
  const next: WindowIdCache = {
    ...cache,
    [opts.team]: { sessionStartedAt, windows: newWindows },
  };
  await writeCache(opts.atmuxDir, next);
  return { kind: "ok", windowId: match.id, cacheHit: false };
}

// ---------- Default session-started-at probe ----------

/**
 * Read the tmux session's `session_created` epoch. Used as the cache
 * invalidation key — when the session is killed + restarted, the new
 * value differs and forces a cache rebuild.
 *
 * Default impl uses `tmux display-message` against the session, which
 * works regardless of which window is active (we pass the bare session
 * name; tmux resolves it to the active pane internally).
 */
function defaultGetSessionStartedAt(tmux: TmuxNamespace) {
  return async (sessionName: string): Promise<number> => {
    try {
      const out = await tmux.pane.displayMessage({
        target: sessionName,
        format: "#{session_created}",
        print: true,
      });
      const n = Number.parseInt(out.trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      // Session absent / tmux down → treat as unknown; cache invalidates
      // on the next live read. Returning 0 is safe (matches no real
      // session_created value).
      return 0;
    }
  };
}

// ---------- Convenience: resolveTarget ----------

/**
 * Same lookup as `resolveWindowId`, but returns the addressing string
 * suitable for tmux `-t` flags. On hit returns the bare window ID
 * (`@N`); on miss falls back to `<sessionName>:<windowName>` so
 * callsites that aren't yet refactored to handle the not-found case
 * stay functional.
 *
 * Migration target: callsites currently building
 * `${sessionName}:${buildWindowName(member, emoji)}` should swap to
 * `await resolveTarget(...)` to gain rename-resilience.
 */
export async function resolveTarget(opts: ResolveWindowIdOpts): Promise<string> {
  const r = await resolveWindowId(opts);
  if (r.kind === "ok") return r.windowId;
  return `${opts.sessionName}:${opts.windowName}`;
}

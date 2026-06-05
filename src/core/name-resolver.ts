// ADR-162: src/core/name-resolver.ts — canonical session-name substrate.
//
// `buildSessionName(team, opts)` is the single source of truth for the
// HYPHEN-canonical cage session name: it consults the
// `<atmuxDir>/state/session.txt` anchor file first (single-session pin,
// also the only sanctioned route to the legacy UNDERSCORE form
// `atmux_<team>` — dogfood / sopx-style pins that predate HYPHEN
// canonicalization), then falls back to `atmux-<team.name>`.
//
// Relationship to siblings (do NOT grow a second competing resolver):
//   - src/core/common.ts::getSessionName wraps this same anchor→hyphen
//     spine with two extra policy steps it owns (env.ATMUX_SESSION
//     override + the singleSession ConfigError). getSessionName is the
//     verb-facing resolver; buildSessionName is the reusable spine.
//   - src/core/cage-session.ts::resolveCageSession (e-b84c4d48 S2) returns
//     `{ sessionName, socketPath }`; its `sessionName` is exactly this
//     function's output. resolveCageSession is expected to delegate here
//     for the name half rather than re-implement the anchor→hyphen rule.
//
// Per ADR-162 the canonical form is HYPHEN (`atmux-<team>`), matching the
// `atmux start` default. The UNDERSCORE form is only reachable via an
// explicit session.txt anchor.

import { readTextOrNull } from "../abstractions/fs.ts";
import { sessionAnchorPath } from "./common.ts";

/** Minimal team shape consumed by {@link buildSessionName} — only the
 *  `name` is load-bearing for the fallback. */
export interface SessionNameTeam {
  name: string;
}

export interface BuildSessionNameOpts {
  /** `.atmux/` directory whose `state/session.txt` anchor is consulted
   *  first. Required: name resolution is anchor-first, so callers must
   *  say which `.atmux/` they mean (no implicit cwd walk-up here — that
   *  policy lives in getSessionName). */
  atmuxDir: string;
  /** Anchor-file reader. Defaults to the real `readTextOrNull`; tests
   *  inject a fake to drive the anchor branches without touching disk.
   *  Returns the file body, or `null` when the anchor is absent. */
  readAnchor?: (path: string) => Promise<string | null>;
}

/**
 * Resolve the canonical cage session name for `team`.
 *
 * Resolution order, first hit wins:
 *   1. `<atmuxDir>/state/session.txt` anchor — trailing whitespace
 *      stripped (parity with getSessionName); used verbatim when the
 *      stripped body is non-empty. This is the only route to the legacy
 *      UNDERSCORE form `atmux_<team>`.
 *   2. `atmux-<team.name>` — HYPHEN canonical fallback (ADR-162).
 *
 * An absent anchor, an empty file, or a whitespace-only file all fall
 * through to step 2.
 */
export async function buildSessionName(
  team: SessionNameTeam,
  opts: BuildSessionNameOpts,
): Promise<string> {
  const readAnchor = opts.readAnchor ?? readTextOrNull;
  const stored = await readAnchor(sessionAnchorPath(opts.atmuxDir));
  if (stored !== null) {
    // Mirror getSessionName: strip only trailing whitespace so an anchor
    // written with a trailing newline still matches its intended value.
    const trimmed = stored.replace(/\s+$/g, "");
    if (trimmed.length > 0) return trimmed;
  }
  return `atmux-${team.name}`;
}

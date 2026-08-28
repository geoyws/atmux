// ADR-162 — cage-socket isolation. Bundles a cage's tmux session NAME
// and its socket PATH into a single anchor-aware resolver so callers
// (cockpit retry-loops, doctor probes, dissolve) resolve both halves of
// the cage handle from one source of truth.
//
// Composes the existing anchor-aware session-name resolver
// (`resolveCageSessionName` in ./cockpit.ts) with the tmuxTmpdir-aware
// socket derivation. Bug B/C root cause was the legacy synchronous
// `cageSessionName` returning UNDERSCORE `atmux_<team>` unconditionally
// while `start.ts` created HYPHEN `atmux-<team>` for any unanchored team
// — this helper inherits the canonical resolution (bare `<team>` since
// e-419553c6) and is the substrate T3/T4 refactor onto.
//
// Pure (path-resolution + a single anchor-file read) — no tmux IO.
// Tests inject a real temp `.atmux/state/session.txt` to drive every branch.

import { dirname } from "node:path";
import { resolveCageSessionName } from "./cockpit.ts";

/** A resolved cage tmux handle: both halves needed to target a cage's
 *  tmux server — the session NAME (`tmux ... -t <sessionName>`) and the
 *  socket PATH (`tmux -S <socketPath>`). */
export interface CageSession {
  /** Bare `<team>` (e-419553c6 default) or the verbatim value anchored
   *  in `<atmuxDir>/state/session.txt` (the only route to the legacy
   *  prefixed forms). */
  sessionName: string;
  /** `<team.tmuxTmpdir>/sock` when the team pins a per-team tmux tmpdir
   *  (sopx / unum / atmux dogfood); otherwise the legacy
   *  `/tmp/atmux-<team>/sock`. */
  socketPath: string;
}

/** Resolve a cage's tmux session name + socket path from one call.
 *
 *  Resolution order (mirrors `common.ts::getSessionName` for the name):
 *    1. `<atmuxDir>/state/session.txt` anchor — trimmed; used verbatim
 *       when non-empty (legacy prefixed forms like `atmux_unum` /
 *       `atmux-<team>` are ONLY honoured via this anchor).
 *    2. Default: bare `<team.name>` (e-419553c6 — what `start.ts`
 *       actually creates for any unanchored team).
 *
 *  Socket path derives from the TEAM, never from the session name
 *  (e-419553c6 decoupled them: session names dropped the `atmux-`
 *  prefix but socket paths KEEP it — the dotfiles prefix chain and
 *  /tmp namespacing depend on `/tmp/atmux-<team>/…`):
 *    - `team.tmuxTmpdir` set → `<tmuxTmpdir>/sock`
 *    - else → legacy `/tmp/atmux-<team.name>/sock` (matches
 *      `common.ts::getDefaultSocket` / `cockpit.ts::cageSocketPath` —
 *      the pre-e-419553c6 session-name-derived form was a drift from
 *      both and had no production caller).
 *
 *  @param atmuxDir absolute path to the cage's `.atmux` directory. */
export async function resolveCageSession(
  team: { name: string; tmuxTmpdir?: string },
  atmuxDir: string,
): Promise<CageSession> {
  // `resolveCageSessionName` reads the anchor at
  // `sessionAnchorPath(join(root, ".atmux"))` = `<root>/.atmux/state/session.txt`,
  // so pass the parent of `atmuxDir` as `root` to land on
  // `<atmuxDir>/state/session.txt`.
  const root = dirname(atmuxDir);
  const sessionName = await resolveCageSessionName({ name: team.name, root });
  const socketPath =
    team.tmuxTmpdir !== undefined && team.tmuxTmpdir.length > 0
      ? `${team.tmuxTmpdir}/sock`
      : `/tmp/atmux-${team.name}/sock`;
  return { sessionName, socketPath };
}

// ADR-162: src/core/tmux-paths.ts — central resolver for atmux-owned
// tmux infrastructure paths.
//
// Per ADR-162 §Reuse statement: one resolver per concept, honouring
// escape-hatch env vars for operators who explicitly want legacy
// behaviour. Sibling to `src/core/templates-dir.ts` — same single-
// resolver pattern, separate concern.
//
// TR2 landed `getCockpitSocketName()` — the cockpit socket moves
// from the operator's default tmux socket to a dedicated
// `atmux-cockpit` named socket (per §Decision-anchor #1). Per-team
// sockets stay on the existing cage-tier `-S <team-root>/.../default`
// path per ADR-058 (no change).
//
// TR4 adds `getAtmuxTmuxConfPath()` alongside the canonical
// `templates/tmux/atmux.conf` baseline. The `-f <path>` flag is
// threaded through every session-creation call-site via
// `TmuxConfig.configFile` (ADR-097), closing the operator's
// `~/.tmux.conf` inheritance path.

import { existsSync as fsExistsSync, lstatSync as fsLstatSync } from "node:fs";
import { join } from "node:path";
import { getDefaultSocket } from "./common.ts";
import { isOwnSocket, removeDeadSocketOrThrow } from "./socket-dir.ts";
import { resolveTemplatesDir } from "./templates-dir.ts";

/** Per ADR-162 §Decision-anchor #1: dedicated tmux socket name for the
 *  cockpit. Operator discoverable via `tmux -L atmux-cockpit attach`. */
export const COCKPIT_SOCKET_DEFAULT = "atmux-cockpit";

/** Per ADR-162 §Decision-anchor #2: relative path under `templates/`
 *  for the canonical atmux tmux.conf. Resolved against
 *  `resolveTemplatesDir()` so install-mode (`/opt/atmux/<v>/templates`)
 *  + dev-mode (`<repo>/templates`) topologies both work. */
export const ATMUX_TMUX_CONF_RELPATH = "tmux/atmux.conf";

/**
 * Resolve the cockpit tmux socket name. Cockpit binds to a dedicated
 * named socket via `tmux -L atmux-cockpit` per ADR-162 §Decision-anchor
 * #1; isolates cockpit windows from the operator's personal default-
 * socket tmux server (closes the foot-gun captured in
 * [[project_atmux_socket_isolation_state.md]]).
 *
 * **Escape hatch**: `ATMUX_COCKPIT_SOCKET=<name>` env var returns the
 * override verbatim. Legacy operators who want one more cycle on the
 * default socket can set `ATMUX_COCKPIT_SOCKET=default`; ADR-162's
 * TR5 doctor probe still warns, but operations proceed against the
 * legacy socket. Empty string is treated as unset (canonical default
 * returned) — matches the convention used by `resolveTemplatesDir`.
 *
 * Per-team sockets are NOT affected — they continue to use the cage-
 * tier `-S <team-root>/.atmux/tmux/tmux-0/default` path resolved via
 * `core/common.ts::resolveTeamSocket` per ADR-058.
 */
export function getCockpitSocketName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ATMUX_COCKPIT_SOCKET;
  if (override !== undefined && override.length > 0) return override;
  return COCKPIT_SOCKET_DEFAULT;
}

/**
 * Absolute path of the cockpit's socket FILE — the one `tmux -L
 * <getCockpitSocketName()>` connects to. tmux builds a `-L <name>` socket
 * as `$TMUX_TMPDIR/tmux-<uid>/<name>`, with `/tmp` standing in when
 * `TMUX_TMPDIR` is unset or empty; this is that same construction.
 *
 * For probes that must see the file BEFORE running any tmux subcommand
 * against it: a subcommand aimed at a dead socket can start a server
 * there (ADR-281 §Context), so `[ -S <path> ]` has to come first, and
 * `-L` offers no path to test.
 */
export function getCockpitSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid: number = process.getuid?.() ?? 0,
): string {
  const tmpdir = env.TMUX_TMPDIR;
  const base = tmpdir !== undefined && tmpdir.length > 0 ? tmpdir : "/tmp";
  return join(base, `tmux-${uid}`, getCockpitSocketName(env));
}

/**
 * Resolve the canonical atmux tmux.conf path. Per ADR-162 §Decision-
 * anchor #2 every atmux session-creation site threads this through
 * `TmuxConfig.configFile` (ADR-097), so every `tmux ...` invocation
 * runs with `-f <path>`. The operator's personal `~/.tmux.conf` is
 * NEVER inherited by atmux invocations.
 *
 * **Resolution chain** (in order):
 * 1. `ATMUX_TMUX_CONF` env override — operator escape hatch. Returns
 *    the override verbatim. Empty-string treated as unset.
 * 2. `${resolveTemplatesDir(env)}/tmux/atmux.conf` — the canonical
 *    shipped baseline. `resolveTemplatesDir` already handles install-
 *    mode (`/opt/atmux/<v>/templates/`) vs dev-mode (`<repo>/templates/`).
 *
 * No probe / existence check — the resolver returns a path string;
 * callers that load the file surface a "fs read failed" via the
 * downstream spawn (tmux itself surfaces `-f` load failure as stderr).
 * Mirrors `resolveTemplatesDir`'s convention to keep the surface flat.
 *
 * Operator opt-out (e.g. `ATMUX_TMUX_CONF=/dev/null`) returns to stock
 * tmux defaults; window-naming may break per ADR-162's documented
 * rollback path (`automatic-rename on` stomps ADR-135's
 * `buildWindowName` contract). Operator-acknowledged risk.
 */
export function getAtmuxTmuxConfPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ATMUX_TMUX_CONF;
  if (override !== undefined && override.length > 0) return override;
  return join(resolveTemplatesDir(env), ATMUX_TMUX_CONF_RELPATH);
}

/** Seams for {@link removeStaleLegacySocket}. `isLive` and `remove` are
 *  REQUIRED — a dead-server probe and a file deletion have no safe
 *  unit-test defaults. `exists` defaults to a pure filesystem read;
 *  `isSocket` defaults to the ADR-305 descriptor walk
 *  ({@link defaultIsLegacySocket}); `log` defaults to stderr. */
export interface StaleLegacySocketDeps {
  exists?: (path: string) => boolean;
  /** True when a tmux server responds on the socket (`hasServer`). A
   *  throw — above all the ADR-305 guard's `UnsafeSocketPathError` —
   *  means "cannot tell", never "dead": nothing is removed. */
  isLive: (path: string) => Promise<boolean>;
  /** Delete the legacy socket (a returned promise is awaited); throws
   *  to report why it did not. Production: {@link defaultRemoveLegacySocket}. */
  remove: (path: string) => unknown;
  /** True when the legacy path is OUR unix socket behind a chain that
   *  passes ADR-305 §D2. Lives on this interface — not inside
   *  {@link defaultRemoveLegacySocket} — so an injected `remove` double
   *  can never bypass the socket-type gate. */
  isSocket?: (path: string) => boolean;
  log?: (msg: string) => void;
}

/** Production socket check: the ADR-305 descriptor walk from `/` — a
 *  symlink anywhere another uid could plant it, another uid's directory
 *  or node, or a non-socket all read as "not our socket". */
export function defaultIsLegacySocket(path: string): boolean {
  return isOwnSocket(path);
}

/** Filesystem kind for the refusal log (lstat, no follow). Only words
 *  for a log line — the removal decision is the descriptor walk's. */
function describeLegacyNode(path: string): string {
  try {
    const st = fsLstatSync(path);
    if (st.isSocket()) return "socket";
    if (st.isDirectory()) return "directory";
    if (st.isFile()) return "regular file";
    if (st.isSymbolicLink()) return "symlink";
    if (st.isFIFO()) return "fifo";
    if (st.isBlockDevice()) return "block device";
    if (st.isCharacterDevice()) return "character device";
    return "non-socket node";
  } catch {
    return "unstatable node";
  }
}

/**
 * e-29 T1: delete a stale legacy socket when the `tmuxTmpdir` override
 * reroutes the team elsewhere. Removes
 * `getDefaultSocket(teamName)` (ADR-305: `/tmp/atmux-<uid>/<team>/sock`,
 * or a private pre-ADR-305 `/tmp/atmux-<team>/sock`) exactly when:
 * the override socket differs, the legacy file exists, NO server
 * responds on it, and the override socket is live or absent (an
 * existing-but-dead override socket means the situation is ambiguous —
 * leave everything alone). The legacy path must additionally BE our
 * socket behind a chain that passes ADR-305 §D2 (descriptor walk, never a
 * path lstat): a regular file, directory, symlink, another uid's node or
 * directory, or any other non-socket node is refused with a one-line log
 * and never deleted. A liveness probe that throws — the socket guard
 * refusing the path above all — is "cannot tell", never "dead"
 * (ADR-305 revision 4): the socket is left in place.
 *
 * NEVER deletes a socket with a responding server. NEVER deletes a
 * non-socket node. NEVER deletes through a path another uid can
 * re-point: the production remover acts relative to held descriptors.
 * NEVER touches the override path.
 */
export async function removeStaleLegacySocket(
  teamName: string,
  overrideSocket: string,
  deps: StaleLegacySocketDeps,
): Promise<boolean> {
  const exists = deps.exists ?? fsExistsSync;
  const log = deps.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  const isSocket = deps.isSocket ?? defaultIsLegacySocket;
  const legacy = getDefaultSocket(teamName);
  if (legacy === overrideSocket) return false;
  if (!exists(legacy)) return false;
  // ADR-305 rev 4: a probe that throws (the socket guard refusing the
  // path, above all) is "cannot tell" — never "dead". Leave it in place.
  const probe = async (path: string): Promise<boolean | string> => {
    try {
      return await deps.isLive(path);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const legacyLive = await probe(legacy);
  if (typeof legacyLive === "string") {
    log(`[atmux start] legacy socket ${legacy} left in place — cannot probe it: ${legacyLive}`);
    return false;
  }
  if (legacyLive) return false;
  const overrideLive = await probe(overrideSocket);
  if (typeof overrideLive === "string") {
    log(
      `[atmux start] legacy socket ${legacy} left in place — cannot probe ${overrideSocket}: ${overrideLive}`,
    );
    return false;
  }
  if (!overrideLive && exists(overrideSocket)) return false;
  // Socket-type gate: e-29 requires deletion only when the path IS our
  // socket behind a passing chain. The default (the descriptor walk)
  // never throws — an absent node reads as "not a socket". An injected
  // gate that throws falls through to the remover attempt below, whose
  // try/catch logs + returns false, so a refused remove is identical.
  try {
    if (!isSocket(legacy)) {
      log(
        `[atmux start] stale legacy path ${legacy} is not your socket behind a private directory chain (lstat: ${describeLegacyNode(legacy)}) — leaving in place`,
      );
      return false;
    }
  } catch {
    // Unstatable: let the remover attempt report (see above).
  }
  try {
    await deps.remove(legacy);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    log(`[atmux start] stale legacy socket ${legacy} not removed (${cause}) — leaving in place`);
    return false;
  }
  log(`[atmux start] removed stale legacy socket ${legacy} (override ${overrideSocket} active)`);
  return true;
}

/** Default legacy-socket remover (production seam wiring): ADR-305
 *  rev 4 `removeDeadSocket` — walk the chain, require the socket's own
 *  directory to be ours alone, connect() through the held descriptor
 *  (only ECONNREFUSED is dead), unlink relative to it. Throws why it
 *  left the socket in place. */
export function defaultRemoveLegacySocket(path: string): Promise<void> {
  return removeDeadSocketOrThrow(path);
}

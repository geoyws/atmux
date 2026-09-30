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

import { existsSync as fsExistsSync, lstatSync as fsLstatSync, rmSync as fsRmSync } from "node:fs";
import { join } from "node:path";
import { getDefaultSocket } from "./common.ts";
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
 *  `isSocket` defaults to a real lstat check ({@link defaultIsLegacySocket});
 *  `log` defaults to stderr. */
export interface StaleLegacySocketDeps {
  exists?: (path: string) => boolean;
  /** True when a tmux server responds on the socket (`hasServer`). */
  isLive: (path: string) => Promise<boolean>;
  /** Delete the legacy socket file. */
  remove: (path: string) => void;
  /** True when the legacy path is a unix socket (lstat, never follows
   *  symlinks). Lives on this interface — not inside
   *  {@link defaultRemoveLegacySocket} — so an injected `remove` double
   *  can never bypass the socket-type gate. */
  isSocket?: (path: string) => boolean;
  log?: (msg: string) => void;
}

/** Production socket check: lstat without following symlinks, so a
 *  symlink-to-socket still reads as `symlink`, never as `socket`. */
export function defaultIsLegacySocket(path: string): boolean {
  return fsLstatSync(path).isSocket();
}

/** One-word filesystem kind for the refusal log (lstat, no follow). */
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
 * leave everything alone). The legacy path must additionally BE a socket
 * (lstat, never following symlinks): a regular file, directory, symlink,
 * or any other non-socket node is refused with a one-line log and never
 * deleted.
 *
 * NEVER deletes a socket with a responding server. NEVER deletes a
 * non-socket node. NEVER touches the
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
  if (await deps.isLive(legacy)) return false;
  if (!(await deps.isLive(overrideSocket)) && exists(overrideSocket)) return false;
  // Socket-type gate: e-29 requires deletion only when the path IS a
  // socket (S_IFSOCK). A stat failure (ENOENT race against `exists`, or a
  // test double asserting existence for a path absent on the real fs)
  // falls through to the remover attempt below, whose try/catch already
  // logs + returns false — so a refused-by-rm outcome is identical.
  try {
    if (!isSocket(legacy)) {
      log(
        `[atmux start] stale legacy path ${legacy} is a ${describeLegacyNode(legacy)} — not a socket, leaving in place`,
      );
      return false;
    }
  } catch {
    // Unstatable: let the remover attempt report (see above).
  }
  try {
    deps.remove(legacy);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    log(`[atmux start] stale legacy socket ${legacy} not removed (${cause}) — leaving in place`);
    return false;
  }
  log(`[atmux start] removed stale legacy socket ${legacy} (override ${overrideSocket} active)`);
  return true;
}

/** Default legacy-socket remover (production seam wiring). */
export function defaultRemoveLegacySocket(path: string): void {
  fsRmSync(path);
}

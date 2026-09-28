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

import { join } from "node:path";
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

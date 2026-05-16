// ADR-162: src/core/tmux-paths.ts — central resolver for atmux-owned
// tmux infrastructure paths.
//
// Per ADR-162 §Reuse statement: one resolver per concept, honouring
// escape-hatch env vars for operators who explicitly want legacy
// behaviour. Sibling to `src/core/templates-dir.ts` — same single-
// resolver pattern, separate concern.
//
// TR2 (this commit) lands `getCockpitSocketName()` — the cockpit
// socket moves from the operator's default tmux socket to a dedicated
// `atmux-cockpit` named socket (per §Decision-anchor #1). Per-team
// sockets stay on the existing cage-tier `-S <team-root>/.../default`
// path per ADR-058 (no change).
//
// TR4 will add `getAtmuxTmuxConfPath()` alongside the canonical
// `templates/tmux/atmux.conf` baseline.

/** Per ADR-162 §Decision-anchor #1: dedicated tmux socket name for the
 *  cockpit. Operator discoverable via `tmux -L atmux-cockpit attach`. */
export const COCKPIT_SOCKET_DEFAULT = "atmux-cockpit";

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

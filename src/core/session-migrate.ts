// e-419553c6 — in-place migration for the bare-session-name change.
//
// Session names dropped the `atmux-` prefix (`atmux-<team>` → `<team>`,
// operator directive 2026-08-27). A live cage started under the old
// convention would otherwise become unreachable to every resolver the
// moment the binary flips: `resolveCageSessionName` / `getSessionName`
// return the bare name, `has-session =<team>` misses, and the operator's
// running panes read as "down". Instead the legacy session is RENAMED in
// place via `tmux rename-session` — preserving attached clients, pane
// PIDs and scroll history — exactly the ADR-264 §D4 pattern that moved
// the cockpit's `atmux_cockpit` / `atmux_teams` literals to `atx`.
//
// Callers: `verbs/start.ts` (covers `atmux start` and, through it,
// `atmux up` and the cockpit reconcile's dead-cage cycle) and
// `verbs/cockpit.ts` Phase 2 (live cages, which reconcile deliberately
// does NOT restart and therefore never routes through start).

import { exactSessionTarget, type TmuxNamespace } from "../abstractions/tmux.ts";

/** Outcome of one migration probe — surfaced for tests + logging. */
export type LegacySessionMigration =
  /** No legacy `atmux-<team>` session on the socket — nothing to do. */
  | "noop"
  /** Legacy session renamed to the bare name in place. */
  | "renamed"
  /** BOTH a legacy and a bare session exist — ambiguous; left to the
   *  operator (renaming would need a destructive kill first). */
  | "ambiguous"
  /** The resolved session name is not the bare default (anchor or env
   *  pin) — the convention change does not apply to pinned names. */
  | "not-applicable";

export interface MigrateLegacySessionNameOpts {
  /** Cage tmux namespace, already bound to the TEAM'S socket. The
   *  migration never touches any other server. */
  tmux: TmuxNamespace;
  /** The team's name — the bare target and the `atmux-<name>` probe. */
  teamName: string;
  /** The session name the caller just resolved (anchor / env aware).
   *  Migration only applies when it IS the bare default: an anchored or
   *  env-pinned name is operator intent and stays untouched. */
  resolvedSession: string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

/**
 * Rename a live legacy `atmux-<team>` session to the bare `<team>` on
 * the team's own socket. Idempotent: once renamed (or when no legacy
 * session exists) subsequent calls are a no-op. When both a legacy and
 * a bare session somehow exist, warns and leaves both alone — killing
 * either is an operator call, not a migration side effect.
 *
 * Probe failures (no server on the socket yet, tmux unreachable)
 * collapse to `"noop"` — a cold start has nothing to migrate.
 */
export async function migrateLegacySessionName(
  opts: MigrateLegacySessionNameOpts,
): Promise<LegacySessionMigration> {
  const { tmux, teamName, resolvedSession } = opts;
  const log = opts.log ?? ((): void => {});
  const warn = opts.warn ?? ((): void => {});
  if (resolvedSession !== teamName) return "not-applicable";
  const legacy = `atmux-${teamName}`;
  let hasLegacy = false;
  try {
    hasLegacy = await tmux.session.hasSession(exactSessionTarget(legacy));
  } catch {
    return "noop"; // no server on the socket — cold start
  }
  if (!hasLegacy) return "noop";
  let hasBare = false;
  try {
    hasBare = await tmux.session.hasSession(exactSessionTarget(teamName));
  } catch {
    hasBare = false;
  }
  if (hasBare) {
    warn(
      `both '${legacy}' and '${teamName}' sessions exist on this socket — ` +
        `bare-name migration ambiguous. Kill the stale one manually: ` +
        `"tmux kill-session -t '=${legacy}'" (recommended when '${teamName}' is the live cage).`,
    );
    return "ambiguous";
  }
  try {
    await tmux.session.renameSession(exactSessionTarget(legacy), teamName);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    warn(
      `failed to rename legacy session '${legacy}' → '${teamName}': ${cause} — ` +
        `rename manually with "tmux rename-session -t '=${legacy}' ${teamName}"`,
    );
    return "noop";
  }
  log(`renamed session '${legacy}' → '${teamName}' (e-419553c6 bare-name migration; one-time)`);
  return "renamed";
}

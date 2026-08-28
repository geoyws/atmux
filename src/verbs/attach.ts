// ADR-010: CLI dispatcher — `attach` verb (driver entry point).
// ADR-004 amend (2026-05-05): socket-pinned tmux factory.
// Bash spec: lib/attach.sh @ 2aadc3f.
//
// Behaviour (1:1 parity with bash):
//
//   1. Resolve `.atmux/team.json` (honors --team-dir, $ATMUX_DIR,
//      $ATMUX_TEAM_DIR, walks up from cwd — same chain as bash via
//      core/common.ts::getAtmuxDir).
//   2. Resolve the team's tmux session name (env override, single-session
//      anchor file, or the bare `<team>` default per e-419553c6).
//   3. Resolve the socket: `--socket <path>` flag if given, else default
//      `/tmp/atmux-<team>/sock` per the Phase 2 placeholder spec lifted
//      from the ADR-004 amend Consequences §"getDefaultSocket resolver"
//      (lead's task brief). When the resolver lands in core/common.ts,
//      this verb's `defaultSocketPath` collapses into a one-line call.
//   4. `tmux -S <socket> has-session -t =<session>` — exact-match per
//      bash `lib/common.sh::atmux::tmux_session_exists` (`=` prefix
//      blocks prefix-collision SEC-class bugs from t-0dbfe104).
//   5. If absent → ConfigError "session <name> does not exist (hint:
//      run 'atmux start' first)" — bash `atmux::die` text-parity.
//   6. Otherwise `tmux -S <socket> attach-session -t =<session>`.
//      Blocks until the operator detaches; on a non-tty (CI, test
//      harness) tmux exits non-zero immediately and the abstraction
//      surfaces a TmuxError.
//
// Cross-socket nesting note (bash `lib/attach.sh:6-10`).
// ------------------------------------------------------
// When the operator runs attach from inside another tmux session and the
// team's cage lives on a different socket, the inner `tmux` invocation
// MUST NOT inherit the outer `$TMUX` env var — tmux otherwise refuses
// "sessions should be nested with care, unset $TMUX to force". We unset
// $TMUX in `process.env` for the duration of the attach call and restore
// in `finally`. The unset is *belt-and-braces* — the `-S <socketPath>`
// flag baked into argv by createTmux already pins which socket tmux
// addresses; the env unset only prevents tmux's own nesting refusal.
//
// Coverage strategy. The blocking nature of `tmux attach-session` against
// a real tty is impossible to assert in `bun:test` (no controlling
// terminal). Tests follow `tests/unit/abstractions/tmux.test.ts:510-514`'s
// pattern: spin a real tmux server on an isolated socketPath, create the
// expected session, invoke `attach()` — assert it rejects with TmuxError
// (the abstraction's surfacing of tmux's "open terminal failed" exit).
// The "session does not exist" + arg-parse + default-socket branches are
// directly assertable.

import { createTmux, exactSessionTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  getDefaultSocket,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { ConfigError, UsageError } from "../errors.ts";

/** Re-export for back-compat with existing tests; new code imports
 *  `getDefaultSocket` from `core/common.ts` directly. */
export const defaultSocketPath = getDefaultSocket;

/** Parsed `attach` CLI args (post-flag-parsing). */
export interface AttachArgs {
  /** Absolute socket path for `tmux -S <path>`. Phase-2 default lives in
   *  `defaultSocketPath`; explicit `--socket` always wins. */
  socketPath?: string;
  /** `.atmux/` parent directory, mirrors bash `--team-dir` consumption
   *  in `bin/atmux::_atmux_consume_team_dir`. */
  teamDir?: string;
}

const USAGE_HINT = "atmux attach [--socket <path>] [--team-dir <dir>]";

/**
 * Parse the verb's argv (post-`attach` slice). Pure — never touches the
 * filesystem or env. Throws `UsageError` on missing flag values or
 * unknown args, matching bash's exit-64 path on bad invocation.
 *
 * Exported so unit tests cover every branch without spinning tmux.
 */
export function parseAttachArgs(argv: ReadonlyArray<string>): AttachArgs {
  const out: AttachArgs = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "attach: --socket requires a path argument",
          hint: USAGE_HINT,
        });
      }
      out.socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "attach: --team-dir requires a directory argument",
          hint: USAGE_HINT,
        });
      }
      out.teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `attach: unknown argument: ${a ?? ""}`, hint: USAGE_HINT });
  }
  return out;
}

// `exactSessionTarget` moved to `abstractions/tmux.ts` (e-419553c6 — the
// bare-session-name change made it load-bearing for core modules too,
// and core importing from a verb is the wrong dependency direction).
// Re-exported here so existing importers (up.ts, tests) keep working.
export { exactSessionTarget };

/**
 * Inner attach driver — accepts an already-constructed tmux namespace +
 * resolved session name. Extracted so tests can stub
 * `tmux.client.attachSession` to return successfully (no controlling
 * tty in `bun:test`); `attach()` proper wires `createTmux` and reads
 * team.json before delegating here. The two-function shape keeps line
 * 164 (`return 0`) reachable in coverage without forcing tests to
 * defeat the abstraction's tty-blocking semantics.
 */
export interface AttachWithTmuxOpts {
  /** ADR-180: route through `client.attachSessionInheritStdio` so the
   *  caller's controlling tty reaches tmux. Set by human-entry verbs
   *  (`atmux cockpit attach --human`). Default false keeps the
   *  agent-path piped-stdio shape that callers without a tty rely on. */
  inheritStdio?: boolean;
}

export async function attachWithTmux(
  tmux: TmuxNamespace,
  sessionName: string,
  opts: AttachWithTmuxOpts = {},
): Promise<number> {
  const target = exactSessionTarget(sessionName);

  if (!(await tmux.session.hasSession(target))) {
    throw new ConfigError({
      what: `session ${sessionName} does not exist`,
      hint: "run 'atmux start' first",
    });
  }

  // Bash `lib/attach.sh:34` runs `env -u TMUX tmux attach-session …` when
  // nested. We mirror by stripping the env var across the (blocking)
  // attach call — and always restore in `finally` so a TmuxError thrown
  // by tmux's "open terminal failed" path doesn't leak the unset state
  // back to the caller. The socket-pinning argv already guarantees we
  // address the right tmux server regardless of $TMUX; this unset only
  // disables tmux's own "sessions should be nested with care" refusal.
  const priorTmux = process.env.TMUX;
  if (priorTmux !== undefined) delete process.env.TMUX;
  try {
    if (opts.inheritStdio) {
      await tmux.client.attachSessionInheritStdio(target);
    } else {
      await tmux.client.attachSession(target);
    }
    return 0;
  } finally {
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  }
}

/**
 * `atmux attach [--socket <path>] [--team-dir <dir>]`.
 *
 * Returns 0 only on a clean detach. Any failure throws an `AtmuxError`
 * subclass; the top-level catch in `src/cli.ts::reportError` maps it
 * to a sysexit code per ADR-006 (`UsageError`→64, `ConfigError`→78,
 * `TmuxError`→1).
 */
export async function attach(args: ReadonlyArray<string>): Promise<number> {
  const parsed = parseAttachArgs(args);

  const dirOpts: ResolveDirOpts = {};
  if (parsed.teamDir !== undefined) dirOpts.teamDir = parsed.teamDir;

  const team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? defaultSocketPath(team.name);

  return attachWithTmux(createTmux({ socketPath }), sessionName);
}

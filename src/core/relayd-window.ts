// ADR-202 §Amendment 2026-05-22 (II) — `relayd` supervisor.
//
// `relayd` is the per-team event-router daemon: a long-lived Bun
// process spawned in a dedicated tmux service window during `atmux
// start`. She wraps the Rust `atmux-listener` subprocess (kernel-
// blocked NOTIFY/LISTEN) and dispatches each event to its handler.
//
// Naming convention: Unix daemon `*d` suffix (httpd, sshd, crond,
// OpenBSD's network relayd). She's a deterministic infrastructure
// process — no LLM, no judgment, just signal routing. Distinct from
// the committer persona (which actually runs `git merge`); relayd is
// the dispatch layer that hands events TO the committer's handler.
//
// The window is auto-restart-wrapped: on daemon crash, sleeps 5s and
// respawns. The cron `committer --drain` line shipped in the same
// amendment is the safety net — if the relayd window dies and stays
// dead until next `atmux start`, the drain catches events within
// ~1min.
//
// Idempotency: re-running `atmux start` on an up team skips the spawn
// when the relayd window already exists.
//
// Eligibility gate: relayd spawns ONLY when ALL of the following hold:
//   1. team.autoMerge?.enabled === true                   (same gate as committer --sweep / --drain)
//   2. team has a member with role ∈ {committer, gitter}  (someone for relayd to dispatch TO)
//   3. env.ATMUX_HONKER is not explicitly "off"           (substrate kill-switch off → no NOTIFY path)

import type { TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team } from "../schema/team.ts";
import type { Logger } from "./tui.ts";

/** Per-team service window for relayd. The `__name__` brackets mark
 *  it as a non-member service window (won't be touched by home-window
 *  cleanup, which only targets `__<team>__home`). */
export const RELAYD_WINDOW = "__relayd__";

export interface SpawnRelaydWindowDeps {
  team: Team;
  /** Tmux session name (typically `atmux::<team>` or per-team session). */
  session: string;
  /** Path to the team's `.atmux` parent dir — cwd for the spawned window. */
  teamRoot: string;
  tmux: TmuxNamespace;
  logger: Logger;
  env: NodeJS.ProcessEnv;
}

/**
 * Conditionally spawn the relayd service window. Returns `true` when
 * the window was spawned, `false` when skipped (gate failed or window
 * already exists).
 *
 * Failure modes are all non-fatal — relayd is an optimization on top
 * of the cron-driven `committer --drain` line, not a hard dependency.
 * Tmux errors are logged and swallowed.
 */
export async function maybeSpawnRelaydWindow(
  deps: SpawnRelaydWindowDeps,
): Promise<boolean> {
  const { team, session, teamRoot, tmux, logger, env } = deps;

  // Gate 1: autoMerge.enabled === true
  if (team.autoMerge?.enabled !== true) {
    return false;
  }
  // Gate 2: member with committer / gitter role
  const hasCommitter = team.members.some((m) => {
    const role = (m as { role?: string }).role;
    return role === "committer" || role === "gitter";
  });
  if (!hasCommitter) {
    return false;
  }
  // Gate 3: ATMUX_HONKER not explicitly disabled. relayd's value
  //         proposition is the Honker NOTIFY/LISTEN wake; when off,
  //         the cron `committer --drain` handles event drain and we
  //         skip relayd to avoid spinning on poll-mode.
  const honker = (env.ATMUX_HONKER ?? "").toLowerCase().trim();
  if (honker === "off" || honker === "0" || honker === "false") {
    logger.log(
      `relayd: ATMUX_HONKER=off — skipping relayd window for '${team.name}' (cron --drain handles event drain)`,
    );
    return false;
  }

  // Idempotence: skip if the window already exists.
  try {
    const windows = await tmux.window.listWindows(session);
    if (windows.some((w) => w.name === RELAYD_WINDOW)) {
      logger.log(
        `relayd: '${team.name}' service window already exists — skipping spawn`,
      );
      return false;
    }
  } catch (e) {
    logger.warn(
      `relayd: listWindows failed (${e instanceof Error ? e.message : String(e)}) — attempting spawn anyway`,
    );
  }

  // Spawn the relayd service window. The auto-restart wrapper runs
  // the daemon in a loop with a 5s back-off on exit, so transient
  // crashes self-heal without operator intervention. SIGTERM (atmux
  // stop, tmux kill-server) breaks out of the loop cleanly because
  // both `atmux committer --daemon` AND the wrapper shell receive
  // the signal — the loop's `while` test sees nothing to run.
  //
  // Logging: stderr+stdout go to a per-team log so post-mortem grep
  // can find why relayd died. `tee -a` keeps the in-pane scroll
  // visible to the operator without losing the file capture.
  //
  // Note: relayd is currently implemented as `atmux committer --daemon`
  // since that's where the gitterConsume + atmux-listener wiring
  // lives. A future amendment may add a top-level `atmux relayd` verb
  // that handles multiple topics (task.claimed, pane.wedged,
  // complaint.filed, etc.) — for now relayd dispatches task.done to
  // the committer's gitter merge handler. The window naming + verb
  // surface evolve independently.
  try {
    const winId = await tmux.window.newWindow({
      sessionName: session,
      name: RELAYD_WINDOW,
      cwd: teamRoot,
      detached: true,
    });
    logger.log(
      `relayd: spawned service window '${RELAYD_WINDOW}' for '${team.name}' (winId=${winId.windowIndex})`,
    );
    // Teardown discipline (operator 2026-05-22: "make sure relayd dies
    // alongside her team/cage"):
    //
    //   1. Explicit trap on SIGTERM / SIGINT / SIGHUP in the wrapper
    //      bash. Without the trap, bash's default behavior during
    //      `sleep` IS to exit on SIGTERM — but the trap ensures clean
    //      exit code 0 + propagation to the daemon child before bash
    //      itself exits.
    //
    //   2. `atmux committer --daemon` runs as bash's foreground child
    //      in the same process group, so SIGTERM to bash → SIGTERM
    //      to the daemon (default tmux kill-pane → SIGHUP → process
    //      group cascade).
    //
    //   3. The Rust atmux-listener subprocess (spawned BY the daemon)
    //      sets PR_SET_PDEATHSIG=SIGTERM on Linux, so even SIGKILL of
    //      the Bun parent kills the Rust child via kernel signal.
    //      Linux-only; macOS dev path stays poll-mode (no pdeathsig
    //      equivalent without kqueue gymnastics).
    //
    //   4. Clean exit (rc=0) exits the wrapper without restart — for
    //      operator-driven `atmux stop` etc. Only abnormal exits
    //      (crash, SIGKILL, panic) trigger the 5s restart loop.
    //
    // Robustness discipline (audit 2026-05-22 §16 — circuit breaker):
    //
    //   5. CRASH_COUNT + CRASH_WINDOW track immediate-restart cycles.
    //      If the daemon crashes ≥5 times within 60s, the wrapper
    //      gives up and exits with a loud log line. Prevents infinite
    //      restart spam from a broken config / missing binary / bad
    //      DB schema. Operator notices the dead window + log on next
    //      attach + fixes the underlying issue, then re-runs `atmux
    //      start` to respawn. The cron --drain line keeps event
    //      drainage running in the meantime.
    const supervisorCmd =
      `mkdir -p .atmux/logs && ` +
      `trap 'echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] relayd: SIGTERM received, exiting"; exit 0' SIGTERM SIGINT SIGHUP; ` +
      `CRASH_COUNT=0; ` +
      `CRASH_WINDOW_START=$(date +%s); ` +
      `while true; do ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] relayd: starting (crash_count=$CRASH_COUNT)"; ` +
      `atmux relayd --start 2>&1 | tee -a .atmux/logs/relayd.log; ` +
      `RC=$?; ` +
      `if [[ $RC -eq 0 ]]; then ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] relayd: clean exit, not restarting"; ` +
      `exit 0; ` +
      `fi; ` +
      `NOW=$(date +%s); ` +
      `ELAPSED=$((NOW - CRASH_WINDOW_START)); ` +
      `if [[ $ELAPSED -gt 60 ]]; then ` +
      `CRASH_COUNT=0; ` +
      `CRASH_WINDOW_START=$NOW; ` +
      `fi; ` +
      `CRASH_COUNT=$((CRASH_COUNT + 1)); ` +
      `if [[ $CRASH_COUNT -ge 5 ]]; then ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] relayd: CIRCUIT BREAKER tripped (5 crashes in <60s) — giving up; cron --drain continues; operator: investigate .atmux/logs/relayd.log + atmux start to respawn"; ` +
      `exit 42; ` +
      `fi; ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] relayd: crashed rc=$RC ($CRASH_COUNT/5 in last 60s), restart in 5s"; ` +
      `sleep 5; ` +
      `done`;
    await tmux.pane.sendKeys({
      target: {
        kind: "service",
        team: team.name,
        target: { sessionName: session, windowIndex: winId.windowIndex },
      },
      keys: supervisorCmd,
      enter: true,
    });
    return true;
  } catch (e) {
    logger.warn(
      `relayd: spawn failed (${e instanceof Error ? e.message : String(e)}) — continuing without relayd; cron --drain still active`,
    );
    return false;
  }
}

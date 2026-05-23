// ADR-202 §Amendment 2026-05-22 (II) — `orchd` supervisor.
//
// `orchd` is the per-team event-router daemon: a long-lived Bun
// process spawned in a dedicated tmux service window during `atmux
// start`. She wraps the Rust `atmux-listener` subprocess (kernel-
// blocked NOTIFY/LISTEN) and dispatches each event to its handler.
//
// Naming convention: Unix daemon `*d` suffix (httpd, sshd, crond,
// OpenBSD's network orchd). She's a deterministic infrastructure
// process — no LLM, no judgment, just signal routing. Distinct from
// the committer persona (which actually runs `git merge`); orchd is
// the dispatch layer that hands events TO the committer's handler.
//
// The window is auto-restart-wrapped: on daemon crash, sleeps 5s and
// respawns. The cron `committer --drain` line shipped in the same
// amendment is the safety net — if the orchd window dies and stays
// dead until next `atmux start`, the drain catches events within
// ~1min.
//
// Idempotency: re-running `atmux start` on an up team skips the spawn
// when the orchd window already exists.
//
// Eligibility gate: orchd spawns ONLY when ALL of the following hold:
//   1. team.autoMerge?.enabled === true                   (same gate as committer --sweep / --drain)
//   2. team has a member with role ∈ {committer, gitter}  (someone for orchd to dispatch TO)
//   3. env.ATMUX_HONKER is not explicitly "off"           (substrate kill-switch off → no NOTIFY path)

import type { TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team } from "../schema/team.ts";
import type { Logger } from "./tui.ts";

/** Per-team service window for orchd. The `__name__` brackets mark
 *  it as a non-member service window (won't be touched by home-window
 *  cleanup, which only targets `__<team>__home`). */
export const ORCHD_WINDOW = "__orchd__";

/** Legacy `__relayd__` window name from pre-ADR-224 cages. Detected and
 *  renamed in-place to {@link ORCHD_WINDOW} by {@link maybeSpawnOrchdWindow}
 *  on every `atmux start` (mirror of ADR-161 §Self-heal for member-window
 *  prefix migration). Not exported — external callers should never spawn
 *  this name; only the in-process auto-rename probe references it. Remove
 *  in the same release as the CLI `relayd` deprecation alias. */
const LEGACY_RELAYD_WINDOW = "__relayd__";

export interface SpawnOrchdWindowDeps {
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
 * Conditionally spawn the orchd service window. Returns `true` when
 * the window was spawned, `false` when skipped (gate failed or window
 * already exists).
 *
 * Failure modes are all non-fatal — orchd is an optimization on top
 * of the cron-driven `committer --drain` line, not a hard dependency.
 * Tmux errors are logged and swallowed.
 */
export async function maybeSpawnOrchdWindow(
  deps: SpawnOrchdWindowDeps,
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
  // Gate 3: ATMUX_HONKER not explicitly disabled. orchd's value
  //         proposition is the Honker NOTIFY/LISTEN wake; when off,
  //         the cron `committer --drain` handles event drain and we
  //         skip orchd to avoid spinning on poll-mode.
  const honker = (env.ATMUX_HONKER ?? "").toLowerCase().trim();
  if (honker === "off" || honker === "0" || honker === "false") {
    logger.log(
      `orchd: ATMUX_HONKER=off — skipping orchd window for '${team.name}' (cron --drain handles event drain)`,
    );
    return false;
  }

  // ADR-224 §D2 — incremental-mode auto-rename: legacy cages spawned
  // pre-rename have a `__relayd__` service window. Detect on every
  // `atmux start` + rename in-place via `tmux rename-window` (NO
  // kill-respawn — the running supervisor process keeps its pane
  // state, log file handles, child Rust binary). Mirrors ADR-161
  // §Self-heal pattern for member-window prefix migration. Idempotent:
  // re-running on an already-renamed cage finds no `__relayd__` and
  // skips silently.
  //
  // The single `listWindows` call below covers BOTH the rename probe
  // AND the spawn-idempotence check — after the rename the same array
  // (re-bound via the rename'd-name lookup) tells us whether to skip
  // spawn. Tmux-error path warns + falls through to spawn attempt,
  // same defensive shape as before this block.
  try {
    const windows = await tmux.window.listWindows(session);
    const legacy = windows.find((w) => w.name === LEGACY_RELAYD_WINDOW);
    if (legacy !== undefined) {
      try {
        await tmux.window.renameWindow(
          { sessionName: session, windowIndex: legacy.index },
          ORCHD_WINDOW,
        );
        logger.log(
          `orchd: renamed legacy '${LEGACY_RELAYD_WINDOW}' window → '${ORCHD_WINDOW}' for '${team.name}' (per ADR-224 §D2)`,
        );
        // After rename, the orchd window exists — skip spawn so we don't
        // race a fresh supervisor against the renamed one.
        return false;
      } catch (e) {
        logger.warn(
          `orchd: rename '${LEGACY_RELAYD_WINDOW}' → '${ORCHD_WINDOW}' failed (${e instanceof Error ? e.message : String(e)}) — proceeding to spawn-idempotence check`,
        );
      }
    }
    if (windows.some((w) => w.name === ORCHD_WINDOW)) {
      logger.log(
        `orchd: '${team.name}' service window already exists — skipping spawn`,
      );
      return false;
    }
  } catch (e) {
    logger.warn(
      `orchd: listWindows failed (${e instanceof Error ? e.message : String(e)}) — attempting spawn anyway`,
    );
  }

  // Spawn the orchd service window. The auto-restart wrapper runs
  // the daemon in a loop with a 5s back-off on exit, so transient
  // crashes self-heal without operator intervention. SIGTERM (atmux
  // stop, tmux kill-server) breaks out of the loop cleanly because
  // both `atmux committer --daemon` AND the wrapper shell receive
  // the signal — the loop's `while` test sees nothing to run.
  //
  // Logging: stderr+stdout go to a per-team log so post-mortem grep
  // can find why orchd died. `tee -a` keeps the in-pane scroll
  // visible to the operator without losing the file capture.
  //
  // Note: orchd is currently implemented as `atmux committer --daemon`
  // since that's where the gitterConsume + atmux-listener wiring
  // lives. A future amendment may add a top-level `atmux orchd` verb
  // that handles multiple topics (task.claimed, pane.wedged,
  // complaint.filed, etc.) — for now orchd dispatches task.done to
  // the committer's gitter merge handler. The window naming + verb
  // surface evolve independently.
  try {
    const winId = await tmux.window.newWindow({
      sessionName: session,
      name: ORCHD_WINDOW,
      cwd: teamRoot,
      detached: true,
    });
    logger.log(
      `orchd: spawned service window '${ORCHD_WINDOW}' for '${team.name}' (winId=${winId.windowIndex})`,
    );
    // Teardown discipline (operator 2026-05-22: "make sure orchd dies
    // alongside her team/cage"):
    //
    //   1. Explicit trap on SIGTERM / SIGINT / SIGHUP in the wrapper
    //      bash. Without the trap, bash's default behavior during
    //      `sleep` IS to exit on SIGTERM — but the trap ensures clean
    //      exit code 0 + propagation to the daemon child before bash
    //      itself exits.
    //
    //   2. `atmux-orchd` (Rust binary, ADR-202 §VII) runs as bash's
    //      foreground child in the same process group, so SIGTERM to
    //      bash → SIGTERM to the daemon (default tmux kill-pane →
    //      SIGHUP → process group cascade). Pre-§VII this was the
    //      Bun `atmux orchd --start` process; §VII swapped it out
    //      for the Rust binary which uses ~5MB RSS idle (vs ~30-50MB
    //      for Bun).
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
      `trap 'echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchd: SIGTERM received, exiting"; exit 0' SIGTERM SIGINT SIGHUP; ` +
      `CRASH_COUNT=0; ` +
      `CRASH_WINDOW_START=$(date +%s); ` +
      `while true; do ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchd: starting (crash_count=$CRASH_COUNT)"; ` +
      // ADR-202 §VII — spawn the Rust atmux-orchd binary directly.
      // The binary handles subscription + drain + dispatch; it spawns
      // `atmux orchd --handle-one` Bun subprocesses per event for
      // the actual handler work. Idle RSS ~5MB vs ~30-50MB for the
      // old Bun --start path. Falls back to Bun `atmux orchd --start`
      // when the Rust binary isn't on PATH (degraded mode, e.g.
      // pre-§VII installs that haven't redeployed build:install).
      `if command -v atmux-orchd >/dev/null 2>&1; then ` +
      `  ATMUX_ORCHD_TEAM_DIR=$(pwd) atmux-orchd .atmux/state.db 2>&1 | tee -a .atmux/logs/orchd.log; ` +
      `else ` +
      `  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchd: atmux-orchd Rust binary not on PATH; falling back to Bun atmux orchd --start"; ` +
      `  atmux orchd --start 2>&1 | tee -a .atmux/logs/orchd.log; ` +
      `fi; ` +
      // Use PIPESTATUS[0] not $? — the orchd is piped to tee, so $?
      // captures tee's status (almost always 0) and swallows the
      // daemon's actual exit code. Without this fix the supervisor
      // believes every orchd exit is clean and never restarts, which
      // silently disables the circuit-breaker entirely (ADR-202 §XIV
      // / T5.1 verdict, t-4eb9cd40).
      `RC=\${PIPESTATUS[0]}; ` +
      `if [[ $RC -eq 0 ]]; then ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchd: clean exit, not restarting"; ` +
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
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchd: CIRCUIT BREAKER tripped (5 crashes in <60s) — giving up; cron --drain continues; operator: investigate .atmux/logs/orchd.log + atmux start to respawn"; ` +
      `exit 42; ` +
      `fi; ` +
      `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchd: crashed rc=$RC ($CRASH_COUNT/5 in last 60s), restart in 5s"; ` +
      `sleep 5; ` +
      `done`;
    // ADR-138 T3b3 carve-out: this is a SHELL command at the freshly
    // launched service window's shell prompt (pre-Claude, no bracketed-
    // paste envelope). Same shape as `verbs/start.ts`'s launcher sends.
    // The supervisor shell loop never enters a Claude TUI compose box —
    // the bracketed-paste-Enter-swallow bug zone does not apply.
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
      `orchd: spawn failed (${e instanceof Error ? e.message : String(e)}) — continuing without orchd; cron --drain still active`,
    );
    return false;
  }
}

#!/usr/bin/env bash
# atmux stop [--force]
# Kill the team's tmux session + archive inboxes.

main() {
  atmux::require tmux
  atmux::require_team

  local force=0 archive=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force|-f) force=1; shift ;;
      --no-archive) archive=0; shift ;;
      *) atmux::die "stop: unknown arg: $1" ;;
    esac
  done

  local session; session="$(atmux::session_name)"
  if ! atmux::tmux_session_exists; then
    atmux::warn "session $session does not exist — nothing to stop"
    return 0
  fi

  # ---- Single-session detection (E7/Sa t-474255b6) ----
  # Under single-session mode, the team's windows live INSIDE the
  # driver's existing tmux session. kill-session would nuke the driver
  # shell — that's a hard-refuse path. Instead, kill ONLY the team's
  # __<team>__* windows and leave the session alive.
  local single
  single=$(jq -r '.singleSession // false' "$(atmux::team_json)" 2>/dev/null || echo false)

  # Hard refuse-gate: if the resolved kill target is the SAME session
  # the driver is currently attached to AND we're not in single-session
  # mode, the stored session.txt has drifted from reality (corrupted
  # state, manual edit, swapped sessions). atmux::die rather than
  # kill-session — losing the driver's REPL is too costly to risk on
  # ambiguous state.
  if [[ "$single" != "true" && -n "${TMUX:-}" ]]; then
    local current_session
    current_session=$(tmux display-message -p '#S' 2>/dev/null || echo "")
    if [[ -n "$current_session" && "$session" == "$current_session" ]]; then
      atmux::die "refusing to kill driver session ($session) — singleSession flag not set but resolved kill target == \$TMUX. Investigate .atmux/state/session.txt or rerun outside the driver tmux."
    fi
  fi

  local team; team="$(atmux::team_name)"
  local team_window_prefix; team_window_prefix="$(printf '__%s__' "$team")"

  # If --force, just nuke it. Otherwise politely C-c then kill.
  if [[ "$force" -ne 1 ]]; then
    # Send C-c to every window to give TUIs a chance to wind down.
    local wins; wins=$(tmux list-windows -t "$session" -F '#{window_name}' | grep "^${team_window_prefix}" || true)
    while IFS= read -r w; do
      [[ -z "$w" ]] && continue
      tmux send-keys -t "$session:$w" C-c 2>/dev/null || true
    done <<< "$wins"
    sleep 2
  fi

  if [[ "$archive" -eq 1 ]]; then
    _atmux_archive_state
  fi

  if [[ "$single" == "true" ]]; then
    # Single-session: kill team windows ONLY; leave the shared session
    # alive so the driver shell + any other team's windows survive.
    local wins; wins=$(tmux list-windows -t "$session" -F '#{window_name}' | grep "^${team_window_prefix}" || true)
    local killed=0
    while IFS= read -r w; do
      [[ -z "$w" ]] && continue
      tmux kill-window -t "$session:$w" 2>/dev/null || true
      killed=$((killed + 1))
    done <<< "$wins"
    atmux::ok "single-session: killed $killed window(s) from session $session"
  else
    tmux kill-session -t "$session" 2>/dev/null || true
    atmux::ok "session $session stopped"
  fi

  # ---- Cron auto-remove (E6/Sc t-ac7197cf) ----
  # Drop the team's marker-bounded crontab block. Idempotent — cron_remove
  # is a no-op when no markers exist (first-stop case, or when the user
  # opted out of auto-install via team.json kanban.cronAutoInstall=false).
  # Errors are non-fatal: a stop should still succeed even if crontab
  # manipulation fails (crond uninstalled, permissions, etc).
  # shellcheck source=cron.sh
  . "$ATMUX_LIB_DIR/cron.sh"
  if atmux::cron_remove "$(atmux::team_name)"; then
    atmux::ok "removed cron entries"
  fi
}

_atmux_archive_state() {
  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local adir; adir="$(atmux::dir)/archive/$ts"
  mkdir -p "$adir"
  cp -r "$(atmux::inbox_dir)" "$adir/inboxes" 2>/dev/null || true
  [[ -f "$(atmux::kanban_json)" ]] && cp "$(atmux::kanban_json)" "$adir/kanban.json"
  [[ -f "$(atmux::driver_inbox)" ]] && cp "$(atmux::driver_inbox)" "$adir/driver-inbox.md"
  atmux::log "archived state → $adir"
}

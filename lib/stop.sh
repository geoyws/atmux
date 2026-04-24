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

  # If --force, just nuke it. Otherwise politely C-c then kill.
  if [[ "$force" -ne 1 ]]; then
    # Send C-c to every window to give TUIs a chance to wind down.
    local wins; wins=$(tmux list-windows -t "$session" -F '#{window_name}' | grep "^__$(atmux::team_name)__" || true)
    while IFS= read -r w; do
      [[ -z "$w" ]] && continue
      tmux send-keys -t "$session:$w" C-c 2>/dev/null || true
    done <<< "$wins"
    sleep 2
  fi

  if [[ "$archive" -eq 1 ]]; then
    _atmux_archive_state
  fi

  tmux kill-session -t "$session" 2>/dev/null || true
  atmux::ok "session $session stopped"
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

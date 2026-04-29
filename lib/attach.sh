#!/usr/bin/env bash
# atmux attach — tmux attach-session to the team

main() {
  atmux::require tmux
  atmux::require_team
  local session; session="$(atmux::session_name)"
  if ! atmux::tmux_session_exists; then
    atmux::die "session $session does not exist — run 'atmux start' first"
  fi
  exec tmux attach-session -t "=$session"
}

#!/usr/bin/env bash
# atmux attach — tmux attach-session to the team.
#
# Cross-socket nesting note: when the operator runs `atmux attach` from inside
# another tmux session (e.g. hax daily-driver tmux on the default socket) and
# the team's cage lives on a different socket (per ADR-018 TMUX_TMPDIR), the
# inner `tmux` invocation must NOT inherit the operator's $TMUX env var —
# otherwise tmux looks for the cage session on the current socket and fails
# with "session does not exist". Clearing $TMUX makes the inner tmux respect
# TMUX_TMPDIR (set earlier by bin/atmux from team.json) and find the cage.

main() {
  atmux::require tmux
  atmux::require_team
  local session; session="$(atmux::session_name)"

  # Detect cross-socket scenario: $TMUX is set (operator inside some tmux) AND
  # the team's expected tmuxTmpdir differs from the current tmux's socket.
  # When detected, clear $TMUX before the existence check + exec so both run
  # against the cage socket.
  local need_unset_tmux=0
  if [[ -n "${TMUX:-}" && -n "${TMUX_TMPDIR:-}" ]]; then
    local current_socket="${TMUX%%,*}"
    local expected_socket="$TMUX_TMPDIR/tmux-$(id -u)/default"
    if [[ "$current_socket" != "$expected_socket" ]]; then
      need_unset_tmux=1
    fi
  fi

  if [[ "$need_unset_tmux" -eq 1 ]]; then
    if ! TMUX= atmux::tmux_session_exists; then
      atmux::die "session $session does not exist — run 'atmux start' first"
    fi
    exec env -u TMUX tmux attach-session -t "=$session"
  else
    if ! atmux::tmux_session_exists; then
      atmux::die "session $session does not exist — run 'atmux start' first"
    fi
    exec tmux attach-session -t "=$session"
  fi
}

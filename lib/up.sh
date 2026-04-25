#!/usr/bin/env bash
# atmux up — one-stop bring-up.
#
# Flow:
#   1. No team.json? Prompt (showing CWD) and run the wizard.
#   2. Doctor preflight: silent on green, full report + abort on red.
#   3. Start the tmux session if it isn't already up.
#   4. Attach, unless we're already inside tmux or not on a TTY.
#
# `atmux` with no args is aliased to this, so `atmux` alone takes you from
# nothing to attached-to-team in one command.

main() {
  atmux::require jq tmux

  # ---- 1. wizard gate ----
  if ! atmux::has_team; then
    _up_prompt_wizard || exit 1
  fi

  # ---- 2. doctor preflight ----
  if ! "$ATMUX_BIN_DIR/atmux" doctor --quiet; then
    # Re-run verbosely so the user sees what's wrong.
    "$ATMUX_BIN_DIR/atmux" doctor || true
    atmux::die "preflight failed — fix the red items above, then re-run 'atmux'"
  fi

  # ---- 3. start if not up ----
  local session; session="$(atmux::session_name)"
  if atmux::tmux_session_exists; then
    atmux::log "session $session already running — reusing"
  else
    "$ATMUX_BIN_DIR/atmux" start
  fi

  # ---- 4. attach (TTY-gated) ----
  if [[ -n "${TMUX:-}" ]]; then
    atmux::ok "already inside tmux — switch with: tmux switch-client -t $session"
    return 0
  fi
  if ! { [[ -t 0 && -t 1 ]]; }; then
    atmux::log "not on a TTY — skipping attach (session: $session)"
    return 0
  fi
  exec tmux attach-session -t "$session"
}

# Interactive prompt offering to run the wizard. Shows the CWD prominently so
# users who cd'd into the wrong directory don't accidentally scaffold there.
_up_prompt_wizard() {
  if [[ -n "${ATMUX_NO_WIZARD:-}" ]]; then
    atmux::die "no team.json here and ATMUX_NO_WIZARD is set — run 'atmux init --wizard' manually"
  fi
  if ! { [[ -t 0 && -t 2 ]]; }; then
    atmux::die "no team.json at $(atmux::team_json) and not on a TTY — run 'atmux init --wizard' first"
  fi

  printf '\n%s🧙 atmux%s  no team.json found in this directory:\n' \
    "$atmux_c_cyn" "$atmux_c_rst" >&2
  printf '            %s%s%s\n\n' "$atmux_c_bld" "$PWD" "$atmux_c_rst" >&2
  printf '  %sSet up a new atmux team here?%s %s[Y/n]%s: ' \
    "$atmux_c_cyn" "$atmux_c_rst" "$atmux_c_dim" "$atmux_c_rst" >&2

  local ans
  IFS= read -r ans || ans=""
  case "$ans" in
    ""|y|Y|yes|YES)
      "$ATMUX_BIN_DIR/atmux" init --wizard
      ;;
    *)
      atmux::warn "ok — cd into your project dir and re-run 'atmux', or run 'atmux init --wizard' when ready"
      return 1 ;;
  esac
}

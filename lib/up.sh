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

  # ---- 0. arg parsing ----
  # Mirror lib/start.sh:19-26: --force overrides topology drift refusal
  # (ADR-027). The flag is symmetric with `atmux start --force` so the
  # escape hatch works on whichever entry point the user invokes.
  local force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force|-f) force=1; shift ;;
      *) atmux::die "up: unknown arg: $1" ;;
    esac
  done

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

  # ---- 2a. Topology invariant gate (ADR-027) ----
  # Targeted topology probe after the generic preflight so drift surfaces
  # the row content + suggested fix verbatim. --force mirrors
  # lib/start.sh:88-91: red rows refuse unless --force flips the gate
  # into warn-and-proceed. Yellow rows always warn loud but never refuse.
  # shellcheck source=doctor.sh
  . "$ATMUX_LIB_DIR/doctor.sh"
  _doctor_reset
  _doctor_check_topology_invariant
  if (( _doctor_red_count > 0 )) || (( _doctor_yellow_count > 0 )); then
    local _row
    for _row in "${_doctor_rows[@]}"; do
      case "$_row" in
        red\|topology:*|yellow\|topology:*) atmux::warn "${_row//|/  }" ;;
      esac
    done
    if (( _doctor_red_count > 0 )) && [[ "$force" -ne 1 ]]; then
      atmux::die "topology drift detected (ADR-027) — fix the red row above, rerun with --force to override, or fix the drift via 'atmux team rename'"
    fi
    (( _doctor_red_count > 0 )) && atmux::warn "topology drift overridden by --force; proceeding"
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
  exec tmux attach-session -t "=$session"
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

#!/usr/bin/env bash
# atmux dashboard [--interval <s>]
# Minimal full-screen live status panel. Refreshes every N seconds using
# `watch`-style ANSI cursor control. Ctrl-C to exit.

main() {
  atmux::require jq
  atmux::require_team

  local interval=5
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --interval|-n) interval="$2"; shift 2 ;;
      *) atmux::die "dashboard: unknown arg: $1" ;;
    esac
  done

  trap 'echo; echo "dashboard: exit"; exit 0' INT TERM

  # Clear screen once, then redraw in place each tick.
  printf '\e[2J'  # clear
  while :; do
    printf '\e[H'   # home
    printf '\e[2J'  # clear
    printf '%s🎛️  atmux dashboard%s   (refresh %ss — ctrl-c to exit)\n\n' \
      "$atmux_c_bld" "$atmux_c_rst" "$interval"
    "$ATMUX_BIN_DIR/atmux" status || true
    echo ""
    echo "─── recent kanban ───"
    "$ATMUX_BIN_DIR/atmux" task list 2>/dev/null | head -10 || true
    echo ""
    echo "─── driver-inbox open ───"
    if [[ -f "$(atmux::driver_inbox)" ]]; then
      awk '/^## Open/{flag=1;next}/^## /{flag=0}flag && /^- /' "$(atmux::driver_inbox)" | head -5 || true
    fi
    echo ""
    echo "─── lead-outbox open ───"
    "$ATMUX_BIN_DIR/atmux" outbox 2>/dev/null | head -10 || true
    sleep "$interval"
  done
}

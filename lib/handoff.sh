#!/usr/bin/env bash
# atmux handoff <from> <to> [--reason <text>] [--no-native] [--pause-from]
#
# Moves all in-progress work from one member to another.
#
# Two-phase handoff:
#   1. Native attempt (unless --no-native): send the SOURCE member a prompt asking
#      it to write a handoff summary at a known path. Wait up to
#      $ATMUX_HANDOFF_WAIT seconds for that file to show up.
#   2. Fallback: tmux capture-pane on the source for the last N lines.
#
# Either way, the captured/written context is fed to the TARGET member's pane
# together with the list of in-progress tasks being transferred.

# shellcheck source=send.sh
. "$ATMUX_LIB_DIR/send.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local from="" to="" reason="" native=1 pause_from=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason)     reason="$2"; shift 2 ;;
      --no-native)  native=0; shift ;;
      --pause-from) pause_from=1; shift ;;
      -*) atmux::die "handoff: unknown flag: $1" ;;
      *)
        if   [[ -z "$from" ]]; then from="$1"
        elif [[ -z "$to"   ]]; then to="$1"
        else atmux::die "handoff: too many args"; fi
        shift ;;
    esac
  done
  [[ -n "$from" && -n "$to" ]] || atmux::die "usage: atmux handoff <from> <to> [--reason <text>]"

  atmux::member_json "$from" >/dev/null
  atmux::member_json "$to"   >/dev/null

  local ts; ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local handoff_dir; handoff_dir="$(atmux::dir)/handoff"
  mkdir -p "$handoff_dir"
  local handoff_file="$handoff_dir/${from}-to-${to}-${ts}.md"

  atmux::log "handoff: $from → $to (reason: ${reason:-unspecified})"

  # Step 1: native ask (best-effort).
  local native_ok=0
  if [[ "$native" -eq 1 ]] && atmux::tmux_window_exists "$from"; then
    local ask="📝 Please write a concise handoff summary to \`$handoff_file\` covering: (1) what you were working on, (2) current state / blockers / open questions, (3) next steps. Keep it under 50 lines. Then reply OK-HANDOFF."
    if atmux::send_to_member "$from" "$ask" 0 0; then
      local wait_s="${ATMUX_HANDOFF_WAIT:-30}"
      local i=0
      while (( i < wait_s )); do
        [[ -s "$handoff_file" ]] && { native_ok=1; break; }
        sleep 1
        i=$((i+1))
      done
    fi
  fi

  # Step 2: fallback — screen scrape.
  if [[ "$native_ok" -ne 1 ]]; then
    atmux::log "  native handoff did not produce $handoff_file — falling back to screen capture"
    if atmux::tmux_window_exists "$from"; then
      local lines="${ATMUX_HANDOFF_LINES:-500}"
      {
        printf '# Handoff via screen capture\n\n'
        printf 'from: %s\nto: %s\ntimestamp: %s\nreason: %s\nmethod: tmux capture-pane (last %s lines)\n\n' \
          "$from" "$to" "$(atmux::now_iso)" "$reason" "$lines"
        printf '## Captured pane\n\n```\n'
        tmux capture-pane -p -S "-$lines" -t "$(atmux::tmux_target "$from")" 2>/dev/null || echo "(capture failed)"
        printf '\n```\n'
      } > "$handoff_file"
    else
      {
        printf '# Handoff — source member window is gone\n\n'
        printf 'from: %s\nto: %s\ntimestamp: %s\nreason: %s\n\n(no pane to capture)\n' \
          "$from" "$to" "$(atmux::now_iso)" "$reason"
      } > "$handoff_file"
    fi
  fi

  # Step 3: migrate tasks.
  local k; k="$(atmux::kanban_json)"
  local from_ib="$(atmux::inbox_dir)/$from.json"
  local to_ib="$(atmux::inbox_dir)/$to.json"
  [[ -f "$to_ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$to_ib"

  local migrating; migrating=$(jq --arg f "$from" \
    '[.tasks[] | select(.owner == $f and (.status == "in-progress" or .status == "blocked"))]' "$k")
  local n_migrating; n_migrating=$(jq 'length' <<<"$migrating")

  if [[ "$n_migrating" != "0" ]]; then
    atmux::jq_update "$k" \
      '(.tasks[] | select(.owner == $f and (.status == "in-progress" or .status == "blocked")) | .owner) = $t' \
      --arg f "$from" --arg t "$to"

    if [[ -f "$from_ib" ]]; then
      atmux::jq_update "$from_ib" '.inProgress = []'
    fi
    atmux::jq_update "$to_ib" \
      '.inProgress = (.inProgress + $ms) | .inProgress |= unique_by(.id)' \
      --argjson ms "$migrating"
  fi

  # Step 4: brief the target.
  local brief_body
  brief_body=$(cat <<EOF
📦 HANDOFF — you are taking over from \`$from\`.

reason: ${reason:-unspecified}
handoff notes: $handoff_file
migrated tasks: $n_migrating (see \`atmux inbox $to\`)

Please read the handoff notes and continue from there. Run:
  atmux inbox $to
  cat $handoff_file
EOF
  )
  if atmux::tmux_window_exists "$to"; then
    atmux::send_to_member "$to" "$brief_body" 0 0 || atmux::warn "handoff: ping to $to failed"
  else
    atmux::warn "handoff: target pane $to is not up — briefing deferred"
  fi

  if [[ "$pause_from" -eq 1 ]]; then
    # shellcheck source=pause.sh
    . "$ATMUX_LIB_DIR/pause.sh"
    ATMUX_PAUSE_REASON="handoff-${reason:-manual}" "$ATMUX_BIN_DIR/atmux" pause "$from" >/dev/null 2>&1 || true
  fi

  atmux::ok "handoff complete: $from → $to ($n_migrating tasks, notes at $handoff_file)"
}

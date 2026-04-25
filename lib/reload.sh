#!/usr/bin/env bash
# atmux reload <subcommand> [args]
#   brief-reload  <member> [--force]
#       Re-paste the role brief into <member>'s pane WITHOUT /clear — context
#       is preserved, the brief is appended as new input. A banner header
#       calls out the reload + timestamp so the agent treats it as an
#       authoritative update going forward, not part of the prior conversation.
#
#       Skips members whose pane shows a known blocker state (Compacting, queued
#       input, near-/at-limit, mid-thinking) unless --force is passed; sending
#       text in those states either gets dropped or merges with stale input.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local sub="${1:-}"; shift || true
  case "$sub" in
    brief-reload)  _atmux_reload_brief "$@" ;;
    "") atmux::die "reload: missing subcommand (use brief-reload <member>)" ;;
    *)  atmux::die "reload: unknown subcommand: $sub (use brief-reload)" ;;
  esac
}

# Blocker patterns we refuse to paste into without --force.
# Pane-state strings that mean "this agent isn't ready to absorb new input."
_atmux_reload_detect_blocker() {
  local state="$1"
  if echo "$state" | grep -qi 'Compacting conversation';            then echo "compacting"; return; fi
  if echo "$state" | grep -qi 'Press up to edit queued messages';   then echo "queued-input"; return; fi
  if echo "$state" | grep -qi 'approaching usage limit';            then echo "approaching-limit"; return; fi
  if echo "$state" | grep -qi 'hit your limit\|rate.?limit';        then echo "rate-limited"; return; fi
  if echo "$state" | grep -qi 'thinking with';                       then echo "thinking"; return; fi
  echo ""
}

_atmux_reload_brief() {
  local member="" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) force=1; shift ;;
      -*) atmux::die "reload brief-reload: unknown flag: $1" ;;
      *)
        if [[ -z "$member" ]]; then member="$1"; shift
        else atmux::die "reload brief-reload: too many args"; fi ;;
    esac
  done
  [[ -n "$member" ]] || atmux::die "reload brief-reload: <member> required"

  atmux::tmux_window_exists "$member" \
    || atmux::die "reload: no tmux window for $member"

  local state; state="$(atmux::capture_pane "$member" 30)"
  local blocker; blocker="$(_atmux_reload_detect_blocker "$state")"
  if [[ -n "$blocker" && "$force" -ne 1 ]]; then
    atmux::log "reload: skipping $member (state=$blocker) — pass --force to override"
    return 1
  fi

  local mj; mj="$(atmux::member_json "$member")"
  local role; role="$(jq -r '.role // "member"' <<<"$mj")"
  local brief; brief="$(atmux::brief_path "$role")"
  [[ -f "$brief" ]] || atmux::die "reload: no brief at $brief for role=$role"

  local target; target="$(atmux::tmux_target "$member")"
  local tmp; tmp="$(mktemp /tmp/atmux-brief-reload-XXXXXX.md)"
  local hhmm; hhmm="$(atmux::now_myt)"
  {
    printf '📨 BRIEF RELOAD by lead at %s — apply going forward, your context is preserved\n\n' "$hhmm"
    atmux::render_brief "$member" "$role" "$brief"
  } > "$tmp"

  local buf="atmux_brief_reload_${member}"
  tmux load-buffer -b "$buf" "$tmp"
  tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
    || tmux paste-buffer -b "$buf" -t "$target"
  sleep 1
  tmux send-keys -t "$target" Enter
  rm -f "$tmp"

  atmux::ok "reloaded brief for $member"
}

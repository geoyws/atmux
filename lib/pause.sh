#!/usr/bin/env bash
# atmux pause <member>   — mark member paused (dispatch refuses to queue tasks)
# atmux resume <member>  — clear the paused flag

main() {
  atmux::require jq
  atmux::require_team

  local verb="${1:-}"; shift || true
  local member="${1:-}"
  [[ -n "$verb" && -n "$member" ]] || atmux::die "usage: atmux $verb <member>"

  atmux::member_json "$member" >/dev/null

  local state_file="$(atmux::state_dir)/paused.json"
  mkdir -p "$(dirname "$state_file")"
  [[ -f "$state_file" ]] || echo '{}' > "$state_file"

  case "$verb" in
    pause)
      atmux::jq_update "$state_file" '.[$m] = {at: $now, reason: $reason}' \
        --arg m "$member" --argjson now "$(atmux::now_epoch)" --arg reason "${ATMUX_PAUSE_REASON:-manual}"
      atmux::ok "paused $member (dispatch/claim will refuse)"
      ;;
    resume)
      atmux::jq_update "$state_file" 'del(.[$m])' --arg m "$member"
      atmux::ok "resumed $member"
      ;;
    *) atmux::die "pause.sh unknown verb: $verb" ;;
  esac
}

# atmux::is_paused <member> — returns 0 if paused.
atmux::is_paused() {
  local member="$1"
  local f="$(atmux::state_dir)/paused.json"
  [[ -f "$f" ]] || return 1
  local v; v=$(jq -r --arg m "$member" '.[$m] // empty' "$f")
  [[ -n "$v" ]]
}

#!/usr/bin/env bash
# atmux add-member <name> --role <role> --tui <tui> [--model <model>] [--cwd <dir>] [--command <cmd>]
# Appends a new member to team.json and (if the session is running) spawns them.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local name="" role="member" tui="claude" model="default" cwd="" cmd=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --role)    role="$2"; shift 2 ;;
      --tui)     tui="$2"; shift 2 ;;
      --model)   model="$2"; shift 2 ;;
      --cwd)     cwd="$2"; shift 2 ;;
      --command) cmd="$2"; shift 2 ;;
      -*) atmux::die "add-member: unknown flag: $1" ;;
      *)
        if [[ -z "$name" ]]; then name="$1"; else atmux::die "add-member: too many positional args"; fi
        shift ;;
    esac
  done
  [[ -n "$name" ]] || atmux::die "usage: atmux add-member <name> [--role …] [--tui …] [--model …] [--cwd …] [--command …]"
  [[ -z "$cwd" ]] && cwd="$PWD"

  local tj; tj="$(atmux::team_json)"
  local exists; exists=$(jq --arg n "$name" '[.members[] | select(.name == $n)] | length' "$tj")
  if [[ "$exists" != "0" ]]; then
    atmux::die "add-member: '$name' is already in team.json"
  fi

  atmux::jq_update "$tj" \
    '.members += [{name: $name, role: $role, tui: $tui, model: $model, cwd: $cwd}
      + (if $cmd == "" then {} else {command: $cmd} end)]' \
    --arg name "$name" --arg role "$role" --arg tui "$tui" \
    --arg model "$model" --arg cwd "$cwd" --arg cmd "$cmd"

  # Prime inbox.
  local ib="$(atmux::inbox_dir)/$name.json"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"

  atmux::ok "added member '$name' (role=$role, tui=$tui) to team.json"

  if atmux::tmux_session_exists; then
    atmux::log "  session is up — spawning the member now"
    _atmux_addmember_spawn "$name"
  else
    atmux::log "  run 'atmux start' (or 'atmux start --force') to bring the team up"
  fi
}

_atmux_addmember_spawn() {
  local member="$1"
  local mj; mj="$(atmux::member_json "$member")"
  local tui model cwd role
  tui="$(jq -r '.tui // "claude"' <<<"$mj")"
  model="$(jq -r '.model // "default"' <<<"$mj")"
  cwd="$(jq -r '.cwd // "."' <<<"$mj")"
  role="$(jq -r '.role // "member"' <<<"$mj")"

  local session win
  session="$(atmux::session_name)"
  win="$(atmux::window_name "$member")"

  tmux new-window -d -t "$session" -n "$win" -c "$cwd"
  local cmd; cmd="$(atmux::tui_cmd "$tui" "$model" "$cwd" "$member" "$role" "$mj")"
  tmux send-keys -t "$session:$win" "$cmd" Enter
  atmux::ok "spawned $member in $session:$win"
}

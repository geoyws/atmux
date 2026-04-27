#!/usr/bin/env bash
# atmux add-member <name> --role <role> --tui <tui> [--model <model>] [--cwd <dir>] [--command <cmd>]
# Appends a new member to team.json and (if the session is running) spawns them.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"
# shellcheck source=emoji.sh
. "$ATMUX_LIB_DIR/emoji.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local name="" role="member" tui="claude" model="default" cwd="" cmd="" lane=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --role)    role="$2"; shift 2 ;;
      --tui)     tui="$2"; shift 2 ;;
      --model)   model="$2"; shift 2 ;;
      --cwd)     cwd="$2"; shift 2 ;;
      --command) cmd="$2"; shift 2 ;;
      --lane)    lane="$2"; shift 2 ;;
      -*) atmux::die "add-member: unknown flag: $1" ;;
      *)
        if [[ -z "$name" ]]; then name="$1"; else atmux::die "add-member: too many positional args"; fi
        shift ;;
    esac
  done
  [[ -n "$name" ]] || atmux::die "usage: atmux add-member <name> [--role …] [--tui …] [--model …] [--cwd …] [--command …] [--lane …]"
  [[ -z "$cwd" ]] && cwd="$PWD"

  # Validate --lane up front (regardless of role — even though role-scoped
  # members silently coerce, an invalid enum value should still fail loud).
  if [[ -n "$lane" ]]; then
    case "$lane" in
      fe|be|db|ops|test|review|misc) ;;
      *) atmux::die "add-member: --lane must be one of {fe,be,db,ops,test,review,misc} (got: $lane)" ;;
    esac
  fi

  # Resolve final lane:
  #   role != member          → role-derived (silently overrides --lane)
  #   role == member + --lane → use --lane verbatim
  #   role == member, no flag → infer from name prefix; warn-and-fall-back-to-misc
  #                              when prefix doesn't match the enum.
  if [[ "$role" != "member" ]]; then
    if [[ -n "$lane" ]]; then
      atmux::log "add-member: --lane=$lane ignored for role=$role (role-derived lane is used)"
    fi
    lane="$(atmux::lane_for_name "$name" "$role")"
  elif [[ -z "$lane" ]]; then
    local prefix="${name%%-*}"
    case "$prefix" in
      fe|be|db|ops|test|review|misc) ;;
      *) atmux::warn "add-member: '$name' has no recognized lane prefix; defaulting to 'misc' (override with --lane)" ;;
    esac
    lane="$(atmux::lane_for_name "$name" "$role")"
  fi

  local tj; tj="$(atmux::team_json)"
  local exists; exists=$(jq --arg n "$name" '[.members[] | select(.name == $n)] | length' "$tj")
  if [[ "$exists" != "0" ]]; then
    atmux::die "add-member: '$name' is already in team.json"
  fi

  # ADR-030: resolve emoji via the priority chain (registry → team.json → random).
  # The resolver writes through to the registry on steps 2 + 3 — for a fresh
  # member, this is the random fallback path: pick once, persist forever.
  # Re-adding a previously-removed member returns the registry's prior emoji
  # (immutable-once-written) so visual identity survives remove/add cycles.
  # team.json is still seeded with the resolved value below for cold-start
  # consumers (atmux::member_emoji and any downstream tool that reads team.json
  # without consulting the registry).
  local emoji
  if declare -f atmux::resolve_member_emoji >/dev/null 2>&1; then
    emoji="$(atmux::resolve_member_emoji "$(atmux::team_name)" "$name" "$role")"
  else
    local seen; seen="$(jq -r '[.members[].emoji // ""] | map(select(. != "")) | join(" ")' "$tj")"
    emoji="$(atmux::emoji_assign "$name" "$role" "$seen")"
  fi

  # Per t-2f13a2e4: snapshot existing team.json before mutating so a botched
  # jq_update (or wrong cwd) leaves a recoverable .bak.<epoch>.
  atmux::team_json_backup >/dev/null

  atmux::jq_update "$tj" \
    '.members += [{name: $name, role: $role, tui: $tui, model: $model, cwd: $cwd, lane: $lane, emoji: $emoji}
      + (if $cmd == "" then {} else {command: $cmd} end)]' \
    --arg name "$name" --arg role "$role" --arg tui "$tui" \
    --arg model "$model" --arg cwd "$cwd" --arg cmd "$cmd" \
    --arg lane "$lane" --arg emoji "$emoji"

  # Prime inbox.
  local ib="$(atmux::inbox_dir)/$name.json"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"

  atmux::ok "added member '$emoji $name' (role=$role, tui=$tui) to team.json"

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

  # fd-3/4 closure — same rationale as lib/start.sh. ADR-012.
  tmux new-window -d -t "$session" -n "$win" -c "$cwd" 3>&- 4>&-
  local cmd; cmd="$(atmux::tui_cmd "$tui" "$model" "$cwd" "$member" "$role" "$mj")"
  tmux send-keys -t "$session:$win" "$cmd" Enter
  atmux::ok "spawned $member in $session:$win"
}

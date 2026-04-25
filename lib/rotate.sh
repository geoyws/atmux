#!/usr/bin/env bash
# atmux rotate <member>             — send /clear to member, re-paste brief
# atmux rotate-lead                  — routes here via `--lead` flag
#
# For Claude Code panes: uses its `/clear` slash-command. For other TUIs,
# this is a best-effort — most OpenCode/Kimi/Cursor setups don't expose an
# equivalent mid-session reset, so we warn and exit non-fatally.

# shellcheck source=tui.sh
. "$ATMUX_LIB_DIR/tui.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local target_kind=""
  local member=""
  if [[ "${1:-}" == "--lead" ]]; then
    target_kind="lead"
    shift
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      *)
        if [[ -z "$member" ]]; then member="$1"; shift
        else atmux::die "rotate: too many args"; fi ;;
    esac
  done

  if [[ "$target_kind" == "lead" ]]; then
    member="$(_atmux_find_lead_member)"
    [[ -n "$member" ]] || atmux::die "rotate-lead: no team-lead defined in team.json"
  fi
  [[ -n "$member" ]] || atmux::die "usage: atmux rotate <member>  |  atmux rotate-lead"

  local mj; mj="$(atmux::member_json "$member")"
  local tui role cwd
  tui="$(jq -r '.tui // "claude"' <<<"$mj")"
  role="$(jq -r '.role // "member"' <<<"$mj")"
  cwd="$(jq -r '.cwd // "."' <<<"$mj")"

  atmux::tmux_window_exists "$member" \
    || atmux::die "no tmux window for $member"

  local target; target="$(atmux::tmux_target "$member")"

  case "$tui" in
    claude)
      tmux send-keys -t "$target" "/clear" Enter
      sleep 2
      ;;
    *)
      atmux::warn "rotate: tui=$tui has no /clear equivalent — will re-paste brief only"
      ;;
  esac

  local brief; brief="$(atmux::brief_path "$role")"
  if [[ -f "$brief" ]]; then
    local tmp; tmp="$(mktemp /tmp/atmux-brief-XXXXXX.md)"
    local team; team="$(atmux::team_name)"
    sed \
      -e "s|{{TEAM}}|$team|g" \
      -e "s|{{MEMBER}}|$member|g" \
      -e "s|{{ROLE}}|$role|g" \
      -e "s|{{ATMUX_DIR}}|$(atmux::dir)|g" \
      "$brief" > "$tmp"
    local buf="atmux_brief_rot_${member}"
    tmux load-buffer -b "$buf" "$tmp"
    tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
      || tmux paste-buffer -b "$buf" -t "$target"
    sleep 1
    tmux send-keys -t "$target" Enter
    rm -f "$tmp"
  fi

  atmux::ok "rotated $member (role=$role, tui=$tui)"

  # Stamp rotation epoch — whip's auto-rotation logic (E2/S2) reads this to
  # decide when next to rotate. Both the claude /clear path and the non-claude
  # warning path land here, so a successful warn-and-rebrief still updates the
  # epoch (the rotate verb succeeded; auto-rotation should respect it).
  # Format mirrors session-start.txt: single epoch integer + trailing newline.
  local state_dir; state_dir="$(atmux::state_dir)"
  mkdir -p "$state_dir"
  atmux::now_epoch > "$state_dir/${member}-rotated.epoch"
}

_atmux_find_lead_member() {
  jq -r 'first(.members[] | select(.role == "team-lead") | .name) // empty' "$(atmux::team_json)"
}

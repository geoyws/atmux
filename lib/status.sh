#!/usr/bin/env bash
# atmux status
# Team overview: session state, window state, task board counts, inbox counts.

main() {
  atmux::require jq tmux
  atmux::require_team

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  local sess_state="down"
  atmux::tmux_session_exists && sess_state="up"

  local sess_emoji="🟢"
  [[ "$sess_state" == "down" ]] && sess_emoji="🔴"

  printf '%s%s%s 🦅 TEAM%s %s  %ssession=%s%s\n' \
    "$atmux_c_bld" "$atmux_c_cyn" "$sess_emoji" "$atmux_c_rst" \
    "$team" \
    "$atmux_c_dim" "$session [$sess_state]" "$atmux_c_rst"

  echo ""
  printf '%smember%s %s %s %s %s\n' \
    "$atmux_c_dim" "$atmux_c_rst" \
    "$(printf '%-8s' 'role')" \
    "$(printf '%-10s' 'tui')" \
    "$(printf '%-10s' 'pane')" \
    "$(printf '%-8s' 'inbox')"

  local members_json; members_json="$(jq -c '.members[]' "$(atmux::team_json)")"
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local name role tui pane_cmd pending
    name=$(jq -r '.name' <<<"$m")
    role=$(jq -r '.role // "member"' <<<"$m")
    tui=$(jq -r '.tui // "claude"' <<<"$m")

    if atmux::tmux_window_exists "$name"; then
      pane_cmd=$(tmux list-panes -t "$(atmux::tmux_target "$name")" -F '#{pane_current_command}' 2>/dev/null | head -1)
    else
      pane_cmd="(down)"
    fi

    local inbox="$(atmux::inbox_dir)/$name.json"
    if [[ -f "$inbox" ]]; then
      pending=$(jq '.pending | length' "$inbox" 2>/dev/null || echo 0)
    else
      pending=0
    fi

    local role_emoji="🐜"
    case "$role" in
      team-lead)     role_emoji="🦅" ;;
      reviewer)      role_emoji="🔍" ;;
      git-committer) role_emoji="📝" ;;
      devops)        role_emoji="⚙️ " ;;
    esac

    printf '  %s %-12s %-14s %-10s %-14s %s\n' \
      "$role_emoji" "$name" "$role" "$tui" "$pane_cmd" "📥 $pending pending"
  done <<< "$members_json"

  # Kanban counts
  local k="$(atmux::kanban_json)"
  if [[ -f "$k" ]]; then
    local todo ip done_c blocked
    todo=$(jq '[.tasks[] | select(.status=="todo")] | length' "$k")
    ip=$(jq   '[.tasks[] | select(.status=="in-progress")] | length' "$k")
    done_c=$(jq '[.tasks[] | select(.status=="done")] | length' "$k")
    blocked=$(jq '[.tasks[] | select(.status=="blocked")] | length' "$k")
    echo ""
    printf '%s📋 kanban%s  📌 todo=%d  🟡 in-progress=%d  ✅ done=%d  🛑 blocked=%d\n' \
      "$atmux_c_dim" "$atmux_c_rst" "$todo" "$ip" "$done_c" "$blocked"
  fi

  local di; di="$(atmux::driver_inbox)"
  if [[ -f "$di" ]]; then
    local opn; opn=$(awk '/^## Open/{flag=1;next}/^## /{flag=0}flag && /^- \[/' "$di" | wc -l | tr -d ' ')
    printf '%s📬 driver-inbox%s  open=%s\n' "$atmux_c_dim" "$atmux_c_rst" "$opn"
  fi
}

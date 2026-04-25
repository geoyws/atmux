#!/usr/bin/env bash
# atmux dispatch <member> <task-id> [--no-ping]
#
# Lead-flow: push a task from the kanban into a member's inbox, assign it,
# and ping the member's pane. Member can then `atmux claim <id>` to take it.

# shellcheck source=send.sh
. "$ATMUX_LIB_DIR/send.sh"

main() {
  atmux::require jq
  atmux::require_team
  atmux::kanban_normalize

  local no_ping=0
  local member="" id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-ping) no_ping=1; shift ;;
      -*) atmux::die "dispatch: unknown flag: $1" ;;
      *)
        if [[ -z "$member" ]]; then member="$1"
        elif [[ -z "$id" ]]; then id="$1"
        else atmux::die "dispatch: too many args"; fi
        shift ;;
    esac
  done
  [[ -n "$member" && -n "$id" ]] || atmux::die "usage: atmux dispatch <member> <task-id>"

  atmux::member_json "$member" >/dev/null

  # Refuse if the member is paused (budget blown, manual, failover peer etc.)
  # shellcheck source=pause.sh
  . "$ATMUX_LIB_DIR/pause.sh"
  if atmux::is_paused "$member"; then
    atmux::die "dispatch: $member is paused — resume with \`atmux resume $member\`"
  fi

  local k; k="$(atmux::kanban_json)"
  local task; task="$(jq --arg id "$id" '.tasks[] | select(.id == $id)' "$k")"
  [[ -n "$task" ]] || atmux::die "dispatch: no such task id: $id"

  # Dep-gate: block dispatch if any dep is not done.
  local unresolved
  unresolved=$(jq --arg id "$id" '
    (.tasks[] | select(.id == $id) | .deps // [])     as $need
    | [.tasks[] | select(.status != "done") | .id]    as $open
    | [$need[] | select(IN($open[]))]
    | join(",")' "$k")
  if [[ -n "$unresolved" && "$unresolved" != '""' ]]; then
    atmux::die "dispatch: task $id blocked by unresolved deps: ${unresolved//\"/}"
  fi

  # Assign + move to in-progress.
  atmux::jq_update "$k" \
    '(.tasks[] | select(.id == $id) | .owner) = $who
     | (.tasks[] | select(.id == $id) | .status) = "in-progress"
     | (.tasks[] | select(.id == $id) | .claimedAt) = $now' \
    --arg id "$id" --arg who "$member" --argjson now "$(atmux::now_epoch)"

  # Append to member inbox.
  local ib; ib="$(atmux::inbox_dir)/$member.json"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  jq --argjson task "$task" --argjson now "$(atmux::now_epoch)" \
     '.inProgress += [$task + {dispatchedAt: $now}]' \
     "$ib" > "${ib}.tmp" && mv "${ib}.tmp" "$ib"

  atmux::ok "dispatched $id → $member"

  if [[ "$no_ping" -ne 1 ]]; then
    local subject; subject="$(jq -r '.subject' <<<"$task")"
    local body; body="$(jq -r '.body // ""' <<<"$task")"
    local ping; ping=$(cat <<EOF
📨 NEW TASK from team-lead

id: $id
subject: $subject

${body:+body:\\n$body\\n}

Claim it with: atmux claim $id
Mark done with: atmux done $id
EOF
)
    atmux::send_to_member "$member" "$ping" 0 0 || atmux::warn "dispatch: ping to $member failed"
  fi
}

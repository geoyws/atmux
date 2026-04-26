#!/usr/bin/env bash
# atmux dispatch <member> <task-id> [--no-ping]
#
# Lead-flow: push a task from the kanban into a member's inbox, assign it,
# and ping the member's pane. Member can then `atmux claim <id>` to take it.

# shellcheck source=send.sh
. "$ATMUX_LIB_DIR/send.sh"
# shellcheck source=discord.sh
# inbox_cap_warn (called on cap-refused dispatches per E6/S2 t-a27f217b)
# guards on `declare -F atmux::discord_ping` — without sourcing here,
# the cap notice never reaches Discord even when a webhook is configured.
. "$ATMUX_LIB_DIR/discord.sh"

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

  # Append to member inbox — gated by inbox_push_guard (E6/S2 t-a27f217b).
  # Cap-refused: kanban-side assign + status flip already landed above;
  # only the inbox copy is denied. The member will see the task via
  # `atmux task list --assignee <name>` even without the inbox entry.
  local ib; ib="$(atmux::inbox_dir)/$member.json"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  if atmux::inbox_push_guard "$ib"; then
    # E6/S1 t-9d0c0270 (A1 site 1/6) — jq_update for atomic write under
    # flock. Bare `jq … > tmp && mv` lost writes when a concurrent claim
    # / done landed mid-flight. Filter logic preserved verbatim; only
    # the invocation changes.
    atmux::jq_update "$ib" \
      '.inProgress += [$task + {dispatchedAt: ($now | tonumber)}]' \
      --argjson task "$task" --arg now "$(atmux::now_epoch)"
  else
    atmux::inbox_cap_warn "$member"
  fi

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

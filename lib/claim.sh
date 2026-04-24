#!/usr/bin/env bash
# atmux claim <task-id> [--as <member>]
# atmux done  <task-id> [--as <member>] [--note <text>]
#
# Invoked via alias: bin/atmux rewrites `atmux claim <id>` → `atmux claim --claim <id>`,
# and `atmux done <id>` → `atmux claim --done <id>`. This lets both verbs share code.

main() {
  atmux::require jq
  atmux::require_team

  local verb=""
  case "${1:-}" in
    --claim|--done) verb="${1#--}"; shift ;;
    *) atmux::die "claim.sh called without verb flag (internal error)" ;;
  esac

  local id="" who="" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --as)   who="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      -*) atmux::die "$verb: unknown flag: $1" ;;
      *) if [[ -z "$id" ]]; then id="$1"; shift; else atmux::die "$verb: too many args"; fi ;;
    esac
  done
  [[ -n "$id" ]] || atmux::die "usage: atmux $verb <task-id> [--as <member>]"

  if [[ -z "$who" ]]; then
    who="${ATMUX_MEMBER:-$(_atmux_guess_member_from_cwd)}"
  fi
  [[ -n "$who" ]] || atmux::die "$verb: can't infer member — set ATMUX_MEMBER or pass --as <member>"

  local k; k="$(atmux::kanban_json)"
  local task; task="$(jq --arg id "$id" '.tasks[] | select(.id == $id)' "$k")"
  [[ -n "$task" ]] || atmux::die "no such task: $id"

  local now; now="$(atmux::now_epoch)"

  case "$verb" in
    claim)
      # Enforce deps: can't claim a task whose deps are not all "done".
      local unresolved
      unresolved=$(jq --arg id "$id" '
        (.tasks[] | select(.id == $id) | .deps // [])      as $need
        | [.tasks[] | select(.status != "done") | .id]      as $open
        | [$need[] | select(IN($open[]))]
        | join(",")' "$k")
      if [[ -n "$unresolved" && "$unresolved" != "\"\"" && "$unresolved" != '""' ]]; then
        atmux::die "claim: task $id blocked by unresolved deps: ${unresolved//\"/}"
      fi

      atmux::jq_update "$k" \
        '(.tasks[] | select(.id == $id) | .owner) = $who
         | (.tasks[] | select(.id == $id) | .status) = "in-progress"
         | (.tasks[] | select(.id == $id) | .claimedAt) = $now' \
        --arg id "$id" --arg who "$who" --argjson now "$now"
      _atmux_inbox_move "$who" "$task" "pending->inProgress" "$now"
      atmux::ok "$who claimed $id"
      ;;
    done)
      atmux::jq_update "$k" \
        '(.tasks[] | select(.id == $id) | .status) = "done"
         | (.tasks[] | select(.id == $id) | .completedAt) = $now
         | (.tasks[] | select(.id == $id) | .note) = $note' \
        --arg id "$id" --arg who "$who" --arg note "$note" --argjson now "$now"
      _atmux_inbox_move "$who" "$task" "inProgress->done" "$now"
      atmux::ok "$who completed $id"
      ;;
  esac
}

_atmux_guess_member_from_cwd() {
  # If the user is running atmux inside a per-member cwd that matches team.json,
  # try to guess. Otherwise empty.
  local cwd="$PWD"
  atmux::require_team
  jq -r --arg cwd "$cwd" '.members[] | select(.cwd == $cwd) | .name' "$(atmux::team_json)" | head -1
}

_atmux_inbox_move() {
  local who="$1" task="$2" direction="$3" now="$4"
  local ib
  ib="$(atmux::inbox_dir)/$who.json"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  local id; id="$(jq -r '.id' <<<"$task")"

  case "$direction" in
    "pending->inProgress")
      jq --arg id "$id" --argjson task "$task" --argjson now "$now" \
         '.pending |= map(select(.id != $id))
          | if any(.inProgress[]; .id == $id) then .
            else .inProgress += [$task + {claimedAt: $now}] end' \
         "$ib" > "${ib}.tmp" && mv "${ib}.tmp" "$ib"
      ;;
    "inProgress->done")
      jq --arg id "$id" --argjson task "$task" --argjson now "$now" \
         '.inProgress |= map(select(.id != $id))
          | .done += [$task + {completedAt: $now}]' \
         "$ib" > "${ib}.tmp" && mv "${ib}.tmp" "$ib"
      ;;
  esac
}

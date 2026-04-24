#!/usr/bin/env bash
# atmux task <verb> [args]
#   add <subject> [--body <text>] [--assignee <member>] [--deps <id,id,...>]
#   list [--status todo|in-progress|done|blocked] [--assignee <member>]
#   show <id>
#   move <id> <todo|in-progress|done|blocked>
#   assign <id> <member>
#   rm <id>

main() {
  atmux::require jq
  atmux::require_team
  local k; k="$(atmux::kanban_json)"
  [[ -f "$k" ]] || echo '{"tasks":[]}' > "$k"

  local verb="${1:-list}"; shift || true
  case "$verb" in
    add)    _atmux_task_add "$@" ;;
    list|ls) _atmux_task_list "$@" ;;
    show|get) _atmux_task_show "$@" ;;
    move|mv) _atmux_task_move "$@" ;;
    assign) _atmux_task_assign "$@" ;;
    rm|remove) _atmux_task_rm "$@" ;;
    *) atmux::die "task: unknown verb: $verb (use add|list|show|move|assign|rm)" ;;
  esac
}

_atmux_task_add() {
  local subject="" body="" assignee="" deps=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body)     body="$2"; shift 2 ;;
      --assignee) assignee="$2"; shift 2 ;;
      --deps)     deps="$2"; shift 2 ;;
      --) shift; subject="$*"; break ;;
      -*) atmux::die "task add: unknown flag: $1" ;;
      *)
        if [[ -z "$subject" ]]; then subject="$1"; else subject="$subject $1"; fi
        shift ;;
    esac
  done
  [[ -n "$subject" ]] || atmux::die "task add: <subject> required"

  local id; id="$(atmux::gen_id)"
  local now; now="$(atmux::now_epoch)"
  local deps_json; deps_json="$(jq -Rn --arg d "$deps" '[$d | split(",") | map(select(length>0))] | flatten')"

  local k; k="$(atmux::kanban_json)"
  jq --arg id "$id" \
     --arg subject "$subject" \
     --arg body "$body" \
     --arg assignee "$assignee" \
     --argjson deps "$deps_json" \
     --argjson now "$now" \
     '.tasks += [{
        id: $id, subject: $subject, body: $body,
        status: "todo", owner: (if $assignee == "" then null else $assignee end),
        deps: $deps, createdAt: $now, claimedAt: null, completedAt: null
      }]' "$k" > "${k}.tmp" && mv "${k}.tmp" "$k"

  atmux::ok "added task $id: $subject"
  printf '%s\n' "$id"
}

_atmux_task_list() {
  local filter_status="" filter_assignee=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status)   filter_status="$2"; shift 2 ;;
      --assignee) filter_assignee="$2"; shift 2 ;;
      *) atmux::die "task list: unknown arg: $1" ;;
    esac
  done

  local k; k="$(atmux::kanban_json)"
  local f='.tasks'
  [[ -n "$filter_status" ]]   && f="$f | map(select(.status == \"$filter_status\"))"
  [[ -n "$filter_assignee" ]] && f="$f | map(select(.owner == \"$filter_assignee\"))"
  f="$f | .[] | [.id, .status, (.owner // \"-\"), .subject] | @tsv"

  local rows; rows="$(jq -r "$f" "$k")"
  if [[ -z "$rows" ]]; then
    echo "(no tasks)"
    return
  fi
  printf '%-10s %-13s %-14s %s\n' "ID" "STATUS" "OWNER" "SUBJECT"
  echo "$rows" | awk -F'\t' '{printf "%-10s %-13s %-14s %s\n", $1, $2, $3, $4}'
}

_atmux_task_show() {
  local id="${1:-}"; [[ -n "$id" ]] || atmux::die "task show: <id> required"
  local k; k="$(atmux::kanban_json)"
  jq --arg id "$id" '.tasks[] | select(.id == $id)' "$k"
}

_atmux_task_move() {
  local id="${1:-}" status="${2:-}"
  [[ -n "$id" && -n "$status" ]] || atmux::die "task move: <id> <status>"
  case "$status" in
    todo|in-progress|done|blocked) ;;
    *) atmux::die "task move: status must be todo|in-progress|done|blocked" ;;
  esac
  local k; k="$(atmux::kanban_json)"
  local now; now="$(atmux::now_epoch)"
  jq --arg id "$id" --arg status "$status" --argjson now "$now" \
     '(.tasks[] | select(.id == $id) | .status) = $status
      | if $status == "done" then
          (.tasks[] | select(.id == $id) | .completedAt) = $now
        else . end' "$k" > "${k}.tmp" && mv "${k}.tmp" "$k"
  atmux::ok "task $id → $status"
}

_atmux_task_assign() {
  local id="${1:-}" who="${2:-}"
  [[ -n "$id" && -n "$who" ]] || atmux::die "task assign: <id> <member>"
  local k; k="$(atmux::kanban_json)"
  jq --arg id "$id" --arg who "$who" \
     '(.tasks[] | select(.id == $id) | .owner) = $who' "$k" > "${k}.tmp" \
     && mv "${k}.tmp" "$k"
  atmux::ok "task $id assigned → $who"
}

_atmux_task_rm() {
  local id="${1:-}"; [[ -n "$id" ]] || atmux::die "task rm: <id> required"
  local k; k="$(atmux::kanban_json)"
  jq --arg id "$id" '.tasks |= map(select(.id != $id))' "$k" > "${k}.tmp" && mv "${k}.tmp" "$k"
  atmux::ok "task $id removed"
}

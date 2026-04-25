#!/usr/bin/env bash
# atmux task <verb> [args]
#   add <subject> [--body <text>] [--assignee <member>] [--deps <id,id,...>]
#   list [--status todo|in-progress|done|blocked] [--assignee <member>]
#   show <id>
#   move <id> <todo|in-progress|done|blocked>
#   assign <id> <member>
#   rm <id>
#
# kanban.json schema (top-level):
#   {
#     "tasks":   [ { id, subject, body, status, owner, deps, priority,
#                    createdAt, claimedAt, completedAt, note,
#                    epic?, story?, lane?, deliverable? } ],
#     "epics":   [ { id, title, status, driverRef, stories, tasks,
#                    createdAt, completedAt } ],
#     "stories": [ { id, epic, title, acceptanceCriteria, status, tasks,
#                    createdAt, completedAt } ]
#   }
# `epic` / `story` / `lane` / `deliverable` on a task are optional — legacy
# tasks without them remain valid (treat missing as null on read). Top-level
# arrays are guaranteed present after `atmux::kanban_normalize` (see
# lib/common.sh) which runs at the top of every kanban mutation.

main() {
  atmux::require jq
  atmux::require_team
  atmux::kanban_normalize

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
  local subject="" body="" assignee="" deps="" priority=""
  local epic="" story="" lane="" deliverable=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body)        body="$2"; shift 2 ;;
      --assignee)    assignee="$2"; shift 2 ;;
      --deps)        deps="$2"; shift 2 ;;
      --priority|--prio) priority="$2"; shift 2 ;;
      --epic)        epic="$2"; shift 2 ;;
      --story)       story="$2"; shift 2 ;;
      --lane)        lane="$2"; shift 2 ;;
      --deliverable) deliverable="$2"; shift 2 ;;
      --) shift; subject="$*"; break ;;
      -*) atmux::die "task add: unknown flag: $1" ;;
      *)
        if [[ -z "$subject" ]]; then subject="$1"; else subject="$subject $1"; fi
        shift ;;
    esac
  done
  [[ -n "$subject" ]] || atmux::die "task add: <subject> required"

  # Lane enum (per ADR-007). UPPER-CASE only at render boundary; persisted lowercase.
  if [[ -n "$lane" ]]; then
    case "$lane" in
      fe|be|db|ops|test|review|misc) ;;
      *) atmux::die "task add: --lane must be one of {fe,be,db,ops,test,review,misc} (got: $lane)" ;;
    esac
  fi

  local k; k="$(atmux::kanban_json)"

  # Reject dangling --epic / --story refs. If --story is given without
  # --epic, infer epic from the parent story; if both given, they must agree.
  if [[ -n "$epic" ]]; then
    local epic_exists; epic_exists=$(jq -r --arg e "$epic" '[.epics[]? | select(.id==$e)] | length' "$k")
    [[ "$epic_exists" -ge 1 ]] || atmux::die "task add: no such epic: $epic"
  fi
  if [[ -n "$story" ]]; then
    local story_epic; story_epic=$(jq -r --arg s "$story" '.stories[]? | select(.id==$s) | .epic // ""' "$k")
    [[ -n "$story_epic" ]] || atmux::die "task add: no such story: $story"
    if [[ -z "$epic" ]]; then
      epic="$story_epic"
    elif [[ "$epic" != "$story_epic" ]]; then
      atmux::die "task add: --epic $epic doesn't match story $story's parent epic $story_epic"
    fi
  fi

  local id; id="$(atmux::gen_id)"
  local now; now="$(atmux::now_epoch)"
  local deps_json; deps_json="$(jq -Rn --arg d "$deps" '[$d | split(",") | map(select(length>0))] | flatten')"
  local prio_json; prio_json="$(jq -Rn --arg p "$priority" 'if $p == "" then null else ($p | tonumber? // null) end')"

  atmux::jq_update "$k" \
    '.tasks += [{
      id: $id, subject: $subject, body: $body,
      status: "todo", owner: (if $assignee == "" then null else $assignee end),
      deps: $deps, priority: $priority,
      epic:        (if $epic        == "" then null else $epic        end),
      story:       (if $story       == "" then null else $story       end),
      lane:        (if $lane        == "" then null else $lane        end),
      deliverable: (if $deliverable == "" then null else $deliverable end),
      createdAt: $now, claimedAt: null, completedAt: null
    }]' \
    --arg id "$id" \
    --arg subject "$subject" \
    --arg body "$body" \
    --arg assignee "$assignee" \
    --argjson deps "$deps_json" \
    --argjson priority "$prio_json" \
    --arg epic "$epic" \
    --arg story "$story" \
    --arg lane "$lane" \
    --arg deliverable "$deliverable" \
    --argjson now "$now"

  atmux::ok "added task $id: $subject"
  printf '%s\n' "$id"
}

_atmux_task_list() {
  local filter_status="" filter_assignee="" filter_epic="" filter_story="" filter_lane="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status)   filter_status="$2"; shift 2 ;;
      --assignee) filter_assignee="$2"; shift 2 ;;
      --epic)     filter_epic="$2"; shift 2 ;;
      --story)    filter_story="$2"; shift 2 ;;
      --lane)     filter_lane="$2"; shift 2 ;;
      --json)     json=1; shift ;;
      *) atmux::die "task list: unknown arg: $1" ;;
    esac
  done

  if [[ -n "$filter_lane" ]]; then
    case "$filter_lane" in
      fe|be|db|ops|test|review|misc) ;;
      *) atmux::die "task list: --lane must be one of {fe,be,db,ops,test,review,misc}" ;;
    esac
  fi

  local k; k="$(atmux::kanban_json)"
  local base='.tasks'
  [[ -n "$filter_status" ]]   && base="$base | map(select(.status == \"$filter_status\"))"
  [[ -n "$filter_assignee" ]] && base="$base | map(select(.owner == \"$filter_assignee\"))"
  [[ -n "$filter_epic" ]]     && base="$base | map(select(.epic  == \"$filter_epic\"))"
  [[ -n "$filter_story" ]]    && base="$base | map(select(.story == \"$filter_story\"))"
  # --lane explicitly excludes legacy tasks (.lane absent/null) — they have no
  # lane to match on, so a lane filter shouldn't sweep them in by default.
  [[ -n "$filter_lane" ]]     && base="$base | map(select(.lane  == \"$filter_lane\"))"

  if [[ "$json" -eq 1 ]]; then
    jq "$base" "$k"
    return
  fi

  local f="$base | sort_by(.priority // 99) | .[] | [.id, .status, (.owner // \"-\"), ((.priority // \"-\") | tostring), ((.lane // \"-\") | ascii_upcase), .subject] | @tsv"
  local rows; rows="$(jq -r "$f" "$k")"
  if [[ -z "$rows" ]]; then
    echo "(no tasks)"
    return
  fi
  printf '%-10s %-13s %-14s %-4s %-6s %s\n' "ID" "STATUS" "OWNER" "PRIO" "LANE" "SUBJECT"
  echo "$rows" | awk -F'\t' '{printf "%-10s %-13s %-14s %-4s %-6s %s\n", $1, $2, $3, $4, $5, $6}'
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

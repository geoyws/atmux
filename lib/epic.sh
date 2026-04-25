#!/usr/bin/env bash
# atmux epic <verb> [args]
#   add     <title> [--body <text>] [--driver-ref <ref>]
#   list    [--status <s>] [--json]
#   show    <id> [--json]
#   advance <id> [--to <state>]
#
# State machine (per ADR-007):
#   planning → ready → in-progress → review → done
#
# Schema in kanban.json (managed by lib/kanban-schema.sh / atmux::kanban_normalize):
#   epics[]: { id, title, body?, status, driverRef?, createdAt, completedAt }
#
# Children — Stories belong to an Epic via story.epic == epic.id; Tasks belong
# either to a Story (task.story == s-id) or directly to an Epic (task.epic ==
# e-id, task.story == null). `epic show` walks both. The .stories / .tasks
# arrays *inside* an epic record are not the source of truth — child lookup
# always queries .stories[]/.tasks[] at the top level by epic-id, which keeps
# the schema flat and avoids two-place updates.

main() {
  atmux::require jq
  atmux::require_team
  atmux::kanban_normalize

  local verb="${1:-}"; shift || true
  case "$verb" in
    add)        _atmux_epic_add "$@" ;;
    list|ls)    _atmux_epic_list "$@" ;;
    show|get)   _atmux_epic_show "$@" ;;
    advance|adv) _atmux_epic_advance "$@" ;;
    "")         atmux::die "epic: missing verb (add|list|show|advance)" ;;
    *)          atmux::die "epic: unknown verb: $verb (use add|list|show|advance)" ;;
  esac
}

# ---------- helpers ----------

_atmux_epic_gen_id() {
  printf 'e-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

_atmux_epic_states() { echo "planning ready in-progress review done"; }

# Default forward step in the state machine. Empty string for terminal.
_atmux_epic_next_state() {
  case "$1" in
    planning)    echo "ready" ;;
    ready)       echo "in-progress" ;;
    in-progress) echo "review" ;;
    review)      echo "done" ;;
    done)        echo "" ;;
    *)           echo "" ;;
  esac
}

# Legal transitions: same-state (idempotent) OR one forward step. Anything else
# is a bad jump (planning → done, in-progress → ready, etc.).
_atmux_epic_legal_transition() {
  local from="$1" to="$2"
  [[ "$from" == "$to" ]] && return 0
  local next; next="$(_atmux_epic_next_state "$from")"
  [[ "$next" == "$to" ]]
}

# Comma-joined list of child ids (stories + direct-tasks-with-no-story) that
# are not yet `done`. Empty string means safe to advance.
_atmux_epic_blocking_children() {
  local eid="$1" k
  k="$(atmux::kanban_json)"
  jq -r --arg eid "$eid" '
    (
      [ .stories[]? | select(.epic == $eid and .status != "done") | .id ]
      + [ .tasks[]?  | select(.epic == $eid and ((.story // null) == null) and .status != "done") | .id ]
    ) | join(",")
  ' "$k"
}

# ---------- add ----------

_atmux_epic_add() {
  local title="" body="" driver_ref=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --body)       body="$2"; shift 2 ;;
      --driver-ref) driver_ref="$2"; shift 2 ;;
      --) shift; title="$*"; break ;;
      -*) atmux::die "epic add: unknown flag: $1" ;;
      *)
        if [[ -z "$title" ]]; then title="$1"; else title="$title $1"; fi
        shift ;;
    esac
  done
  [[ -n "$title" ]] || atmux::die "epic add: <title> required"

  local id; id="$(_atmux_epic_gen_id)"
  local now; now="$(atmux::now_epoch)"
  local k; k="$(atmux::kanban_json)"

  atmux::jq_update "$k" \
    '.epics += [{
       id: $id,
       title: $title,
       body: $body,
       status: "planning",
       driverRef: (if $ref == "" then null else $ref end),
       createdAt: $now,
       completedAt: null
     }]' \
    --arg id "$id" \
    --arg title "$title" \
    --arg body "$body" \
    --arg ref "$driver_ref" \
    --argjson now "$now"

  atmux::ok "epic: added $id — $title"
  printf '%s\n' "$id"
}

# ---------- list ----------

_atmux_epic_list() {
  local filter_status="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) filter_status="$2"; shift 2 ;;
      --json)   json=1; shift ;;
      *) atmux::die "epic list: unknown arg: $1" ;;
    esac
  done

  local k; k="$(atmux::kanban_json)"
  local base='.epics // []'
  [[ -n "$filter_status" ]] && base="$base | map(select(.status == \"$filter_status\"))"
  base="$base | sort_by(.createdAt // 0)"

  if [[ "$json" -eq 1 ]]; then
    jq "$base" "$k"
    return
  fi

  local rows
  rows="$(jq -r "$base | .[] | [.id, .status, ((.createdAt // 0) | tostring), .title] | @tsv" "$k")"
  if [[ -z "$rows" ]]; then
    echo "(no epics)"
    return
  fi
  printf '%-12s %-12s %-12s %s\n' "ID" "STATUS" "CREATED" "TITLE"
  echo "$rows" | awk -F'\t' '{printf "%-12s %-12s %-12s %s\n", $1, $2, $3, $4}'
}

# ---------- show ----------

_atmux_epic_show() {
  local id="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      -*) atmux::die "epic show: unknown flag: $1" ;;
      *)
        if [[ -z "$id" ]]; then id="$1"; shift; else atmux::die "epic show: too many args"; fi ;;
    esac
  done
  [[ -n "$id" ]] || atmux::die "epic show: <id> required"

  local k; k="$(atmux::kanban_json)"
  local epic; epic="$(jq --arg id "$id" '.epics[]? | select(.id == $id)' "$k")"
  [[ -n "$epic" ]] || atmux::die "epic show: no such epic: $id"

  if [[ "$json" -eq 1 ]]; then
    jq --arg id "$id" '
      (.epics[]? | select(.id == $id))
      + { stories: [ .stories[]? | select(.epic == $id) ],
          tasks:   [ .tasks[]?   | select(.epic == $id) ] }
    ' "$k"
    return
  fi

  # Tree view — Epic header, then per-Story block (each Story line followed
  # by its child Tasks indented), then any direct epic-scoped tasks in their
  # own block. Single jq pass with $root anchored at top so nested $s scope
  # can still reach .tasks[].
  jq -r --arg id "$id" '
    . as $root
    | ($root.epics[]? | select(.id == $id)) as $e
    | [ "\($e.id) [\($e.status)] — \($e.title)" ]
      + (if ($e.body // "") == "" then [] else [ "  body: \($e.body)" ] end)
      + (if ($e.driverRef // null) == null then [] else [ "  ref:  \($e.driverRef)" ] end)
      + (
          [ $root.stories[]? | select(.epic == $id) ] as $stories
          | if ($stories | length) == 0 then []
            else [ "", "Stories:" ] + (
              $stories
              | map(
                  . as $s
                  | [ "  \($s.id) [\($s.status)] — \($s.title)" ]
                    + [ $root.tasks[]?
                        | select(.story == $s.id)
                        | "    task \(.id) [\(.status)] — \(.subject)" ]
                )
              | add // []
            )
            end
        )
      + (
          [ $root.tasks[]? | select(.epic == $id and ((.story // null) == null)) ] as $direct
          | if ($direct | length) == 0 then []
            else [ "", "Direct tasks:" ]
                 + ($direct | map("  \(.id) [\(.status)] — \(.subject)"))
            end
        )
    | .[]
  ' "$k"
}

# ---------- advance ----------

_atmux_epic_advance() {
  local id="" target=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) target="$2"; shift 2 ;;
      -*) atmux::die "epic advance: unknown flag: $1" ;;
      *)
        if [[ -z "$id" ]]; then id="$1"; shift; else atmux::die "epic advance: too many args"; fi ;;
    esac
  done
  [[ -n "$id" ]] || atmux::die "epic advance: <id> required"

  local k; k="$(atmux::kanban_json)"
  local epic; epic="$(jq --arg id "$id" '.epics[]? | select(.id == $id)' "$k")"
  [[ -n "$epic" ]] || atmux::die "epic advance: no such epic: $id"

  local cur; cur="$(jq -r '.status' <<<"$epic")"

  if [[ -z "$target" ]]; then
    target="$(_atmux_epic_next_state "$cur")"
    [[ -n "$target" ]] || atmux::die "epic advance: $id is in terminal state '$cur'"
  fi

  if ! _atmux_epic_legal_transition "$cur" "$target"; then
    atmux::die "epic advance: illegal transition $cur → $target (machine: planning→ready→in-progress→review→done)"
  fi

  # Idempotent on same-state — no work, no children check.
  if [[ "$cur" == "$target" ]]; then
    atmux::ok "epic: $id already $cur (no-op)"
    return 0
  fi

  # Children gate for review/done — name blocking ids in the error.
  if [[ "$target" == "review" || "$target" == "done" ]]; then
    local blocking; blocking="$(_atmux_epic_blocking_children "$id")"
    if [[ -n "$blocking" ]]; then
      atmux::die "epic advance: cannot advance $id to $target — blocking children: $blocking"
    fi
  fi

  local now; now="$(atmux::now_epoch)"

  # Atomic state flip — completedAt set when we land on `done`.
  atmux::jq_update "$k" \
    '(.epics[]? | select(.id == $id) | .status) = $target
     | if $target == "done" then
         (.epics[]? | select(.id == $id) | .completedAt) = $now
       else . end' \
    --arg id "$id" --arg target "$target" --argjson now "$now"

  atmux::ok "epic: $id $cur → $target"

  # Auto-dispatch summary task on `review` entry — lead writes the wrap-up.
  if [[ "$target" == "review" ]]; then
    _atmux_epic_dispatch_summary "$id"
  fi
}

# Mint a `draft Epic summary <eid>` task in the kanban + push to lead's inbox
# inProgress queue. Mirrors lib/dispatch.sh's two-step (kanban + inbox). Not
# atomic across files, matching dispatch's existing semantics.
_atmux_epic_dispatch_summary() {
  local eid="$1"
  local k; k="$(atmux::kanban_json)"
  local now; now="$(atmux::now_epoch)"
  local tid; tid="$(atmux::gen_id)"
  local subject="draft Epic summary $eid"
  local body; body="Epic $eid has entered review. Compose summary: title, child stories, key decisions, deltas. Source: \`atmux epic show $eid\`."

  atmux::jq_update "$k" \
    '.tasks += [{
       id: $tid, subject: $subject, body: $body,
       status: "in-progress", owner: "lead",
       deps: [], priority: 1,
       createdAt: $now, claimedAt: $now, completedAt: null,
       epic: null, story: null, lane: "misc", deliverable: null
     }]' \
    --arg tid "$tid" --arg subject "$subject" --arg body "$body" \
    --argjson now "$now"

  local ib; ib="$(atmux::inbox_dir)/lead.json"
  mkdir -p "$(dirname "$ib")"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  local task_json
  task_json="$(jq --arg id "$tid" '.tasks[]? | select(.id == $id)' "$k")"
  jq --argjson t "$task_json" --argjson now "$now" \
     '.inProgress += [$t + {dispatchedAt: $now}]' \
     "$ib" > "${ib}.tmp" && mv "${ib}.tmp" "$ib"

  atmux::log "epic: dispatched summary task $tid → lead (review entry)"
}

#!/usr/bin/env bash
# atmux story <verb> [args]
#   add     <title> --epic <eid> [--ac <criteria>] [--body <text>]
#   list    --epic <eid> [--status <s>] [--json]
#   show    <id> [--json]
#   advance <id> [--to <state>]
#
# State machine (per ADR-007):
#   planning → ready → in-progress → testing → review → merging → done
#
# Transitions:
#   ready → in-progress       parent Epic auto-flips ready → in-progress
#                             (atomic, single jq_update)
#   in-progress → testing     all non-test-lane child Tasks must be `done`
#   testing → review          all test-lane child Tasks must be `done`
#                             auto-dispatches "review <sid>" to reviewer
#   review → merging          requires .reviewSignoff == true
#                             auto-dispatches "merge <sid>" to gitter
#                             stores .mergeTaskId on the story
#   merging → done            requires the dispatched merge Task to be `done`
#
# Schema (managed by atmux::kanban_normalize / lib/kanban.sh header):
#   stories[]: { id, epic, title, body?, acceptanceCriteria?, status,
#                createdAt, completedAt, reviewSignoff?, mergeTaskId? }
#   epics[].stories[]: array of child story ids (initialized lazily via //= [])

main() {
  atmux::require jq
  atmux::require_team
  atmux::kanban_normalize

  local verb="${1:-}"; shift || true
  case "$verb" in
    add)         _atmux_story_add "$@" ;;
    list|ls)     _atmux_story_list "$@" ;;
    show|get)    _atmux_story_show "$@" ;;
    advance|adv) _atmux_story_advance "$@" ;;
    "")          atmux::die "story: missing verb (add|list|show|advance)" ;;
    *)           atmux::die "story: unknown verb: $verb (use add|list|show|advance)" ;;
  esac
}

# ---------- helpers ----------

_atmux_story_gen_id() {
  printf 's-%s\n' "$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
}

_atmux_story_next_state() {
  case "$1" in
    planning)    echo "ready" ;;
    ready)       echo "in-progress" ;;
    in-progress) echo "testing" ;;
    testing)     echo "review" ;;
    review)      echo "merging" ;;
    merging)     echo "done" ;;
    done)        echo "" ;;
    *)           echo "" ;;
  esac
}

_atmux_story_legal_transition() {
  local from="$1" to="$2"
  [[ "$from" == "$to" ]] && return 0
  local next; next="$(_atmux_story_next_state "$from")"
  [[ "$next" == "$to" ]]
}

# Comma-joined list of non-test-lane child task ids that aren't `done`. Tasks
# with no `.lane` field are treated as non-test (conservative — must be done).
_atmux_story_blocking_non_test_tasks() {
  local sid="$1" k
  k="$(atmux::kanban_json)"
  jq -r --arg sid "$sid" '
    [ .tasks[]?
      | select(.story == $sid and (.lane // "misc") != "test" and .status != "done")
      | .id
    ] | join(",")
  ' "$k"
}

# Comma-joined list of test-lane child task ids that aren't `done`. Empty
# string when (a) all test-lane tasks done or (b) no test-lane task exists.
_atmux_story_blocking_test_tasks() {
  local sid="$1" k
  k="$(atmux::kanban_json)"
  jq -r --arg sid "$sid" '
    [ .tasks[]?
      | select(.story == $sid and (.lane // "") == "test" and .status != "done")
      | .id
    ] | join(",")
  ' "$k"
}

# ---------- add ----------

_atmux_story_add() {
  local title="" body="" ac="" eid=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --epic) eid="$2"; shift 2 ;;
      --ac)   ac="$2"; shift 2 ;;
      --body) body="$2"; shift 2 ;;
      --) shift; title="$*"; break ;;
      -*) atmux::die "story add: unknown flag: $1" ;;
      *)
        if [[ -z "$title" ]]; then title="$1"; else title="$title $1"; fi
        shift ;;
    esac
  done
  [[ -n "$title" ]] || atmux::die "story add: <title> required"
  [[ -n "$eid" ]]   || atmux::die "story add: --epic <epic-id> required"

  local k; k="$(atmux::kanban_json)"
  local epic_exists
  epic_exists=$(jq -r --arg eid "$eid" '[.epics[]? | select(.id == $eid)] | length' "$k")
  [[ "$epic_exists" -ge 1 ]] || atmux::die "story add: no such epic: $eid"

  local sid; sid="$(_atmux_story_gen_id)"
  local now; now="$(atmux::now_epoch)"

  # Single atomic update: insert into stories[] AND append id to parent epic's
  # stories[]. The `//= []` guard initializes the array on legacy epics that
  # were minted before the field was conventional.
  atmux::jq_update "$k" \
    '.stories += [{
       id: $sid,
       epic: $eid,
       title: $title,
       body: $body,
       acceptanceCriteria: (if $ac == "" then null else $ac end),
       status: "planning",
       reviewSignoff: false,
       mergeTaskId: null,
       createdAt: $now,
       completedAt: null
     }]
     | (.epics[]? | select(.id == $eid) | .stories) //= []
     | (.epics[]? | select(.id == $eid) | .stories) += [$sid]' \
    --arg sid "$sid" --arg eid "$eid" --arg title "$title" \
    --arg body "$body" --arg ac "$ac" --argjson now "$now"

  atmux::ok "story: added $sid → $eid — $title"
  printf '%s\n' "$sid"
}

# ---------- list ----------

_atmux_story_list() {
  local eid="" filter_status="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --epic)   eid="$2"; shift 2 ;;
      --status) filter_status="$2"; shift 2 ;;
      --json)   json=1; shift ;;
      *) atmux::die "story list: unknown arg: $1" ;;
    esac
  done
  [[ -n "$eid" ]] || atmux::die "story list: --epic <epic-id> required"

  local k; k="$(atmux::kanban_json)"
  local base
  base=".stories // [] | map(select(.epic == \"$eid\"))"
  [[ -n "$filter_status" ]] && base="$base | map(select(.status == \"$filter_status\"))"
  base="$base | sort_by(.createdAt // 0)"

  if [[ "$json" -eq 1 ]]; then
    jq "$base" "$k"
    return
  fi

  local rows
  rows="$(jq -r "$base | .[] | [.id, .status, .title] | @tsv" "$k")"
  if [[ -z "$rows" ]]; then
    echo "(no stories for $eid)"
    return
  fi
  printf '%-12s %-12s %s\n' "ID" "STATUS" "TITLE"
  echo "$rows" | awk -F'\t' '{printf "%-12s %-12s %s\n", $1, $2, $3}'
}

# ---------- show ----------

_atmux_story_show() {
  local id="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift ;;
      -*) atmux::die "story show: unknown flag: $1" ;;
      *)
        if [[ -z "$id" ]]; then id="$1"; shift; else atmux::die "story show: too many args"; fi ;;
    esac
  done
  [[ -n "$id" ]] || atmux::die "story show: <id> required"

  local k; k="$(atmux::kanban_json)"
  local story; story="$(jq --arg id "$id" '.stories[]? | select(.id == $id)' "$k")"
  [[ -n "$story" ]] || atmux::die "story show: no such story: $id"

  if [[ "$json" -eq 1 ]]; then
    jq --arg id "$id" '
      (.stories[]? | select(.id == $id))
      + { tasks: [ .tasks[]? | select(.story == $id) ] }
    ' "$k"
    return
  fi

  jq -r --arg id "$id" '
    . as $root
    | ($root.stories[]? | select(.id == $id)) as $s
    | [ "\($s.id) [\($s.status)] — \($s.title)",
        "  epic: \($s.epic)" ]
      + (if ($s.body // "") == "" then [] else [ "  body: \($s.body)" ] end)
      + (if ($s.acceptanceCriteria // null) == null
         then [ "  AC:   (empty — reviewer must reject signoff per ADR-007 OQ2)" ]
         else [ "  AC:   \($s.acceptanceCriteria)" ] end)
      + (if ($s.reviewSignoff // false) then [ "  signoff: ✅" ] else [] end)
      + (
          [ $root.tasks[]? | select(.story == $id) ] as $tasks
          | if ($tasks | length) == 0 then []
            else [ "", "Tasks:" ]
                 + ($tasks | map(
                     "  \(.id) [\(.status)] (\(.lane // "-")) — \(.subject)"
                   ))
            end
        )
    | .[]
  ' "$k"
}

# ---------- advance ----------

_atmux_story_advance() {
  local id="" target=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) target="$2"; shift 2 ;;
      -*) atmux::die "story advance: unknown flag: $1" ;;
      *)
        if [[ -z "$id" ]]; then id="$1"; shift; else atmux::die "story advance: too many args"; fi ;;
    esac
  done
  [[ -n "$id" ]] || atmux::die "story advance: <id> required"

  local k; k="$(atmux::kanban_json)"
  local story; story="$(jq --arg id "$id" '.stories[]? | select(.id == $id)' "$k")"
  [[ -n "$story" ]] || atmux::die "story advance: no such story: $id"

  local cur; cur="$(jq -r '.status' <<<"$story")"
  local eid; eid="$(jq -r '.epic' <<<"$story")"

  if [[ -z "$target" ]]; then
    target="$(_atmux_story_next_state "$cur")"
    [[ -n "$target" ]] || atmux::die "story advance: $id is in terminal state '$cur'"
  fi

  if ! _atmux_story_legal_transition "$cur" "$target"; then
    atmux::die "story advance: illegal transition $cur → $target (machine: planning→ready→in-progress→testing→review→merging→done)"
  fi

  if [[ "$cur" == "$target" ]]; then
    atmux::ok "story: $id already $cur (no-op)"
    return 0
  fi

  # ----- gates -----
  case "$target" in
    testing)
      local blocking; blocking="$(_atmux_story_blocking_non_test_tasks "$id")"
      if [[ -n "$blocking" ]]; then
        atmux::die "story advance: cannot advance $id to testing — non-test-lane tasks still open: $blocking"
      fi
      ;;
    review)
      local blocking; blocking="$(_atmux_story_blocking_test_tasks "$id")"
      if [[ -n "$blocking" ]]; then
        atmux::die "story advance: cannot advance $id to review — test-lane tasks still open: $blocking"
      fi
      ;;
    merging)
      local signoff
      signoff=$(jq -r --arg id "$id" '.stories[]? | select(.id == $id) | .reviewSignoff // false' "$k")
      if [[ "$signoff" != "true" ]]; then
        atmux::die "story advance: cannot advance $id to merging — reviewer signoff missing (.reviewSignoff != true)"
      fi
      ;;
    done)
      local merge_tid
      merge_tid=$(jq -r --arg id "$id" '.stories[]? | select(.id == $id) | .mergeTaskId // ""' "$k")
      if [[ -z "$merge_tid" ]]; then
        atmux::die "story advance: cannot advance $id to done — no merge task on record (was the story dispatched to gitter via merging?)"
      fi
      local merge_status
      merge_status=$(jq -r --arg id "$merge_tid" '.tasks[]? | select(.id == $id) | .status // ""' "$k")
      if [[ "$merge_status" != "done" ]]; then
        atmux::die "story advance: cannot advance $id to done — merge task $merge_tid is '$merge_status' (gitter has not completed merge)"
      fi
      ;;
  esac

  local now; now="$(atmux::now_epoch)"

  # ----- atomic state flip (+ parent epic auto-flip when leaving ready) -----
  # E2/S10 t-ff60d3e8: stamp .advancedAt on every transition so whip's
  # 'Since last tick' delta block can surface story advances alongside
  # commits + done-tasks. Old stories that pre-date the schema simply
  # have .advancedAt absent; whip's bucket-filter (.advancedAt > since)
  # excludes them naturally — we don't backfill.
  if [[ "$cur" == "ready" && "$target" == "in-progress" ]]; then
    # Single jq_update: flip story AND parent epic ready→in-progress (only if
    # epic is currently `ready`; later transitions don't re-flip).
    atmux::jq_update "$k" \
      '(.stories[]? | select(.id == $sid) | .status) = $target
       | (.stories[]? | select(.id == $sid) | .advancedAt) = $now
       | (.epics[]?
           | select(.id == $eid and .status == "ready")
           | .status) = "in-progress"' \
      --arg sid "$id" --arg eid "$eid" --arg target "$target" --argjson now "$now"
  else
    local extra=''
    if [[ "$target" == "done" ]]; then
      extra=' | (.stories[]? | select(.id == $sid) | .completedAt) = $now'
    fi
    atmux::jq_update "$k" \
      "(.stories[]? | select(.id == \$sid) | .status) = \$target
       | (.stories[]? | select(.id == \$sid) | .advancedAt) = \$now$extra" \
      --arg sid "$id" --arg target "$target" --argjson now "$now"
  fi

  atmux::ok "story: $id $cur → $target"

  # ----- post-transition side effects -----
  case "$target" in
    review)  _atmux_story_dispatch "$id" "review"  "reviewer" ;;
    merging) _atmux_story_dispatch "$id" "merge"   "gitter"   ;;
  esac
}

# Mint an in-progress kanban Task with subject "<verb> <sid>" and push it to
# <member>'s inbox.inProgress queue. Mirrors lib/dispatch.sh's two-step
# (kanban + inbox). For "merge" dispatches, also stamps story.mergeTaskId so
# the merging→done gate can look it up.
_atmux_story_dispatch() {
  local sid="$1" verb="$2" member="$3"
  local k; k="$(atmux::kanban_json)"
  local now; now="$(atmux::now_epoch)"
  local tid; tid="$(atmux::gen_id)"
  local subject="$verb $sid"
  local body="Story $sid is in $([[ "$verb" == "review" ]] && echo review || echo merging) state. Source: \`atmux story show $sid\`."

  if [[ "$verb" == "merge" ]]; then
    atmux::jq_update "$k" \
      '.tasks += [{
         id: $tid, subject: $subject, body: $body,
         status: "in-progress", owner: $member,
         deps: [], priority: 1,
         createdAt: $now, claimedAt: $now, completedAt: null,
         epic: null, story: $sid, lane: "misc", deliverable: null
       }]
       | (.stories[]? | select(.id == $sid) | .mergeTaskId) = $tid' \
      --arg tid "$tid" --arg subject "$subject" --arg body "$body" \
      --arg member "$member" --arg sid "$sid" --argjson now "$now"
  else
    atmux::jq_update "$k" \
      '.tasks += [{
         id: $tid, subject: $subject, body: $body,
         status: "in-progress", owner: $member,
         deps: [], priority: 1,
         createdAt: $now, claimedAt: $now, completedAt: null,
         epic: null, story: $sid, lane: "review", deliverable: null
       }]' \
      --arg tid "$tid" --arg subject "$subject" --arg body "$body" \
      --arg member "$member" --arg sid "$sid" --argjson now "$now"
  fi

  local ib; ib="$(atmux::inbox_dir)/$member.json"
  mkdir -p "$(dirname "$ib")"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  local task_json
  task_json="$(jq --arg id "$tid" '.tasks[]? | select(.id == $id)' "$k")"
  # E6/S1 t-b1b315f1 (A1 site 5/6) — atmux::jq_update for flock'd
  # atomic write per ADR-013. Filter logic preserved verbatim.
  atmux::jq_update "$ib" \
    '.inProgress += [$t + {dispatchedAt: ($now | tonumber)}]' \
    --argjson t "$task_json" --arg now "$now"

  atmux::log "story: dispatched $verb task $tid → $member (story $sid)"
}

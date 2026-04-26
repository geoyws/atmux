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
# shellcheck source=send.sh
. "$ATMUX_LIB_DIR/send.sh"

#   {
#     "tasks":   [ { id, subject, body, status, owner, deps, priority,
#                    createdAt, claimedAt, completedAt, note,
#                    epic?, story?, lane?, deliverable? } ],
#     "epics":   [ { id, title, body?, status, driverRef?,
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
  local epic="" story="" lane="" deliverable="" stale_min=""
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
      --stale-min)   stale_min="$2"; shift 2 ;;
      --) shift; subject="$*"; break ;;
      -*) atmux::die "task add: unknown flag: $1" ;;
      *)
        if [[ -z "$subject" ]]; then subject="$1"; else subject="$subject $1"; fi
        shift ;;
    esac
  done
  [[ -n "$subject" ]] || atmux::die "task add: <subject> required"

  # --stale-min N: positive integer, minutes. Whip prefers this over the
  # team default for the per-Task stale heuristic (E2/S7 t-b8583298).
  if [[ -n "$stale_min" ]]; then
    [[ "$stale_min" =~ ^[1-9][0-9]*$ ]] \
      || atmux::die "task add: --stale-min must be a positive integer of minutes (got: $stale_min)"
  fi

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

  local stale_json; stale_json="$(jq -Rn --arg s "$stale_min" 'if $s == "" then null else ($s | tonumber? // null) end')"

  atmux::jq_update "$k" \
    '.tasks += [{
      id: $id, subject: $subject, body: $body,
      status: "todo", owner: (if $assignee == "" then null else $assignee end),
      deps: $deps, priority: $priority,
      epic:        (if $epic        == "" then null else $epic        end),
      story:       (if $story       == "" then null else $story       end),
      lane:        (if $lane        == "" then null else $lane        end),
      deliverable: (if $deliverable == "" then null else $deliverable end),
      staleMin:    $staleMin,
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
    --argjson staleMin "$stale_json" \
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

  if [[ "$status" == "done" ]]; then
    # Delegate to the shared finisher so `atmux done` and `atmux task move done`
    # always trigger the same auto-dispatch chain (commit → gitter, story flip,
    # storyless-epic flip + summary → lead). Per d-98907819 / t-7d99e935.
    atmux::finish_task_done "$id" ""
    atmux::ok "task $id → done"
    return 0
  fi

  local k; k="$(atmux::kanban_json)"
  jq --arg id "$id" --arg status "$status" \
     '(.tasks[]? | select(.id == $id) | .status) = $status' \
     "$k" > "${k}.tmp" && mv "${k}.tmp" "$k"
  atmux::ok "task $id → $status"
}

# atmux::finish_task_done <task_id> [<note>]
#
# Single source of truth for the `task → done` transition + side effects.
# Called by both `_atmux_task_move done` and lib/claim.sh's `--done` branch
# (per d-98907819) so worker `atmux done` and operator `atmux task move done`
# share the same auto-dispatch chain.
#
# Idempotent: if the task is already in `done`, optionally updates `.note`
# (when caller passed one) and returns — no double commit-Task dispatch.
#
# Side effects on a real done-transition (kanban side, single jq_update):
#   • status → done, completedAt → now, .note → $note (when non-empty)
#   • commit-Task (`commit <id>`) appended to .tasks for gitter when .epic != null
#   • Story testing → review when this is the last open task of a story AND
#     this task's lane == "test"
#   • storyless-Epic in-progress → review + draft-summary task for lead
#     when this is the last open task of the epic and the epic has no stories
# Inbox pushes (gitter, lead) follow the kanban write — same two-step pattern
# as lib/dispatch.sh.
atmux::finish_task_done() {
  local id="$1" note="${2:-}"
  local k; k="$(atmux::kanban_json)"
  local now; now="$(atmux::now_epoch)"

  local src_task; src_task="$(jq --arg id "$id" '.tasks[]? | select(.id == $id)' "$k")"
  [[ -n "$src_task" ]] || atmux::die "finish_task_done: no such task: $id"
  local src_status; src_status="$(jq -r '.status' <<<"$src_task")"

  # Idempotent on already-done. If the caller has a fresh note, persist it
  # without re-firing dispatches.
  if [[ "$src_status" == "done" ]]; then
    if [[ -n "$note" ]]; then
      atmux::jq_update "$k" \
        '(.tasks[]? | select(.id == $id) | .note) = $note' \
        --arg id "$id" --arg note "$note"
    fi
    return 0
  fi

  local src_epic;    src_epic="$(jq    -r '.epic    // ""' <<<"$src_task")"
  local src_story;   src_story="$(jq   -r '.story   // ""' <<<"$src_task")"
  local src_lane;    src_lane="$(jq    -r '.lane    // ""' <<<"$src_task")"
  local src_subject; src_subject="$(jq -r '.subject // ""' <<<"$src_task")"
  local src_owner;   src_owner="$(jq   -r '.owner   // ""' <<<"$src_task")"

  local do_commit=0 do_story_flip=0 do_epic_flip=0
  local target_story_id="" target_epic_id=""
  [[ -n "$src_epic" ]] && do_commit=1
  # E1/S4-followup t-15226e79: never auto-dispatch a commit-Task for a
  # Task that IS itself a meta-Task (commit/merge/persist). gitter
  # already hard-rules against batching so the recursion would stop
  # at one cycle anyway, but the phantom 'done' Tasks pollute the
  # kanban view + confuse 'task list' filters. Match the standard
  # subject prefixes the dispatch helpers mint.
  if [[ "$src_subject" =~ ^(commit|merge|persist)\  ]]; then
    do_commit=0
  fi
  # E1/S4-followup-3 t-1ff87709: same recursion class but caught on the
  # assignee+lane axis, not the subject. Planner-authored MISC fold-Tasks
  # ("[E#/S#] MISC: <docs/ADR/CHANGELOG/...>") slip past the regex above
  # because their subjects don't start with commit/merge/persist — yet
  # the work IS commit-flavored, so auto-dispatching another commit-Task
  # to gitter is recursion by definition. Single-rule gate beats whack-a-
  # mole regex maintenance: gitter's whole job is commit work, so a
  # gitter-owned MISC task done never warrants a child commit-Task.
  if [[ "$src_owner" == "gitter" && "$src_lane" == "misc" ]]; then
    do_commit=0
  fi

  if [[ -n "$src_story" && "$src_lane" == "test" ]]; then
    local story_status
    story_status="$(jq -r --arg s "$src_story" '.stories[]? | select(.id == $s) | .status // ""' "$k")"
    if [[ "$story_status" == "testing" ]]; then
      local other_open
      other_open="$(jq -r --arg s "$src_story" --arg id "$id" \
        '[.tasks[]? | select(.story == $s and .id != $id and .status != "done")] | length' "$k")"
      if [[ "$other_open" -eq 0 ]]; then
        do_story_flip=1
        target_story_id="$src_story"
      fi
    fi
  fi

  if [[ -n "$src_epic" && -z "$src_story" ]]; then
    local epic_has_stories
    epic_has_stories="$(jq -r --arg e "$src_epic" '[.stories[]? | select(.epic == $e)] | length' "$k")"
    if [[ "$epic_has_stories" -eq 0 ]]; then
      local epic_status
      epic_status="$(jq -r --arg e "$src_epic" '.epics[]? | select(.id == $e) | .status // ""' "$k")"
      if [[ "$epic_status" == "in-progress" ]]; then
        local other_open
        other_open="$(jq -r --arg e "$src_epic" --arg id "$id" \
          '[.tasks[]? | select(.epic == $e and .id != $id and .status != "done")] | length' "$k")"
        if [[ "$other_open" -eq 0 ]]; then
          do_epic_flip=1
          target_epic_id="$src_epic"
        fi
      fi
    fi
  fi

  local commit_tid="" summary_tid=""
  [[ "$do_commit"    -eq 1 ]] && commit_tid="$(atmux::gen_id)"
  [[ "$do_epic_flip" -eq 1 ]] && summary_tid="$(atmux::gen_id)"
  local commit_subject="commit $id"
  local commit_body="commit $id — see \`atmux task show $id\`"
  local summary_subject="draft Epic summary $target_epic_id"
  local summary_body="Epic $target_epic_id has entered review. Compose summary: title, child stories, key decisions, deltas. Source: \`atmux epic show $target_epic_id\`."

  atmux::jq_update "$k" '
    (.tasks[]? | select(.id == $id) | .status) = "done"
    | (.tasks[]? | select(.id == $id) | .completedAt) = $now
    | if $note != "" then
        (.tasks[]? | select(.id == $id) | .note) = $note
      else . end
    | if $do_commit == "1" then
        .tasks += [{
          id: $commit_tid, subject: $commit_subject, body: $commit_body,
          status: "in-progress", owner: "gitter",
          deps: [], priority: 1,
          epic: null, story: null, lane: "misc", deliverable: null,
          createdAt: $now, claimedAt: $now, completedAt: null
        }]
      else . end
    | if $do_story_flip == "1" then
        (.stories[]? | select(.id == $story_id) | .status) = "review"
      else . end
    | if $do_epic_flip == "1" then
        (.epics[]?  | select(.id == $epic_id)  | .status) = "review"
        | .tasks += [{
            id: $summary_tid, subject: $summary_subject, body: $summary_body,
            status: "in-progress", owner: "lead",
            deps: [], priority: 1,
            epic: null, story: null, lane: "misc", deliverable: null,
            createdAt: $now, claimedAt: $now, completedAt: null
          }]
      else . end
  ' \
    --arg id "$id" --arg note "$note" --argjson now "$now" \
    --arg do_commit "$do_commit" \
    --arg commit_tid "$commit_tid" \
    --arg commit_subject "$commit_subject" \
    --arg commit_body "$commit_body" \
    --arg do_story_flip "$do_story_flip" \
    --arg story_id "$target_story_id" \
    --arg do_epic_flip "$do_epic_flip" \
    --arg epic_id "$target_epic_id" \
    --arg summary_tid "$summary_tid" \
    --arg summary_subject "$summary_subject" \
    --arg summary_body "$summary_body"

  # Dispatch-suppression hook. ATMUX_FINISH_TASK_NO_DISPATCH=1 (set by
  # claim.sh's --no-dispatch flag, or by ATMUX_NO_AUTO_DISPATCH=1 in the
  # environment for cron / automation) keeps the kanban write but skips
  # the inbox push + pane ping for the auto-dispatched commit-Task and
  # the lead-summary task. State transitions (story-flip, epic-flip)
  # still run — those are local to the kanban, not dispatches. Use case:
  # driver is committing manually and doesn't want gitter woken on every
  # finalize. The minted commit-Task lands on the kanban in the inbox
  # of nobody; whatever picks up next (whip-driven dispatcher, manual
  # `atmux dispatch`) sees it.
  if [[ "${ATMUX_FINISH_TASK_NO_DISPATCH:-0}" != "1" ]]; then
    [[ -n "$commit_tid" ]]  && _atmux_kanban_push_inbox "gitter" "$commit_tid"
    [[ -n "$summary_tid" ]] && _atmux_kanban_push_inbox "lead"   "$summary_tid"
  fi

  # Prune any stale inbox.inProgress[] entry for this task. The kanban is
  # the authoritative completion ledger; inbox copies only matter for
  # whip's stale-task heuristic (lib/whip.sh:177) and pull-based claim
  # filtering. When a task is completed via `atmux task move done` (or
  # via `atmux done` from a member that wasn't the dispatched recipient,
  # e.g. lead-driven planner asks where the dispatch put the task in
  # planner.inProgress[] but the lead later moves it done directly), the
  # kanban update lands but the inbox copy lingers. Whip then perpetually
  # warns "N task(s) in-progress > 90min" against phantoms. Walking all
  # inboxes once per `done` transition is cheap (≤10 small JSON files,
  # most rewrite-skipped via the jq -e existence guard) and idempotent.
  _atmux_kanban_prune_inboxes "$id"

  if [[ "$do_commit" -eq 1 ]]; then
    if [[ "${ATMUX_FINISH_TASK_NO_DISPATCH:-0}" == "1" ]]; then
      atmux::log "task: minted commit task $commit_tid (gitter — DISPATCH SUPPRESSED) source $id"
    else
      atmux::log "task: dispatched commit task $commit_tid → gitter (source $id)"
    fi
  fi
  [[ "$do_story_flip" -eq 1 ]] && atmux::log "task: story $target_story_id auto-flipped testing → review"
  if [[ "$do_epic_flip" -eq 1 ]]; then
    if [[ "${ATMUX_FINISH_TASK_NO_DISPATCH:-0}" == "1" ]]; then
      atmux::log "task: epic $target_epic_id auto-flipped in-progress → review (summary $summary_tid — DISPATCH SUPPRESSED)"
    else
      atmux::log "task: epic  $target_epic_id  auto-flipped in-progress → review (summary $summary_tid → lead)"
    fi
  fi
  return 0
}

# Walk every member inbox + drop any inProgress[] entry matching <task_id>.
# Idempotent: inboxes that don't contain the id are skipped without rewrite
# (the jq -e existence check is a read-only fast path; only files that
# actually need pruning are reserialized). Used by atmux::finish_task_done
# to keep whip's stale-task heuristic anchored to live work, not phantoms.
_atmux_kanban_prune_inboxes() {
  local task_id="$1"
  [[ -n "$task_id" ]] || return 0
  local ib_dir; ib_dir="$(atmux::inbox_dir)"
  [[ -d "$ib_dir" ]] || return 0
  local ib
  for ib in "$ib_dir"/*.json; do
    [[ -f "$ib" ]] || continue
    if jq -e --arg id "$task_id" 'any(.inProgress[]?; .id == $id)' "$ib" >/dev/null 2>&1; then
      jq --arg id "$task_id" \
         '.inProgress = [.inProgress[]? | select(.id != $id)]' \
         "$ib" > "${ib}.tmp" && mv "${ib}.tmp" "$ib"
    fi
  done
}

# Look up <task_id> in kanban + push it to <member>'s inbox.inProgress.
# Mirrors the dispatch.sh / epic.sh / story.sh inbox-push idiom; factored here
# so task move's two simultaneous dispatches (commit→gitter, summary→lead)
# don't duplicate the boilerplate.
_atmux_kanban_push_inbox() {
  local member="$1" task_id="$2"
  local k; k="$(atmux::kanban_json)"
  local task_json; task_json="$(jq --arg id "$task_id" '.tasks[]? | select(.id == $id)' "$k")"
  [[ -n "$task_json" ]] || return 0
  local ib; ib="$(atmux::inbox_dir)/$member.json"
  mkdir -p "$(dirname "$ib")"
  [[ -f "$ib" ]] || echo '{"pending":[],"inProgress":[],"done":[]}' > "$ib"
  local now; now="$(atmux::now_epoch)"
  jq --argjson t "$task_json" --argjson now "$now" \
     '.inProgress += [$t + {dispatchedAt: $now}]' \
     "$ib" > "${ib}.tmp" && mv "${ib}.tmp" "$ib"

  # tmux send-keys nudge so the recipient sees the new task immediately —
  # without it, auto-dispatched commit-Tasks pile up silently while the
  # gitter pane sits idle thinking its inbox is drained (the lead has
  # surfaced this recurring "20-min lag before the next loop catches it"
  # gap multiple times — t-9fd8d48e). Mirrors lib/dispatch.sh:85's
  # explicit-dispatch ping. Pre-check window existence: send_to_member
  # would atmux::die on a missing window, which would abort the whole
  # `atmux done` chain. The kanban + inbox write above is the durable
  # handoff; the ping is best-effort punctuation.
  if atmux::tmux_window_exists "$member" 2>/dev/null; then
    local subject; subject="$(jq -r '.subject // ""' <<<"$task_json")"
    local ping="📨 auto-dispatch: $task_id — $subject"
    atmux::send_to_member "$member" "$ping" 0 0 \
      || atmux::log "kanban: auto-dispatch ping to $member failed (kanban write held)"
  else
    atmux::log "kanban: $member window missing — auto-dispatch ping skipped (kanban write held)"
  fi
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

# atmux::task_append_note lives in lib/common.sh so non-kanban callers
# (lib/flags.sh's --task linkage) can reach it without sourcing this file.

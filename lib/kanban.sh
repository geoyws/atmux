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
# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"
# shellcheck source=socket-pubsub.sh
. "$ATMUX_LIB_DIR/socket-pubsub.sh"

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
  local driver_only=0
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
      --driver-only) driver_only=1; shift ;;
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

    # Warn (don't reject) when no member of this team carries the lane.
    # Surfaced today via t-d3c52862 — a planner-authored task with
    # lane=ops sat unclaimable forever because the team had no ops
    # member. crossLaneClaim=true (default) would still rescue it, but
    # the silent-orphan failure mode is worth a heads-up at create time.
    # `misc` is the universal fallback lane for non-aligned tasks; never
    # warn on it (every team has misc-eligible workers).
    if [[ "$lane" != "misc" ]]; then
      local _has_lane
      _has_lane=$(jq -r --arg l "$lane" \
        '[.members[]? | select((.lane // "misc") == $l)] | length' \
        "$(atmux::team_json)" 2>/dev/null || echo 0)
      if [[ "${_has_lane:-0}" -eq 0 ]]; then
        atmux::warn "task add: no team member has lane=$lane — task will be claimable only via crossLaneClaim fallback or explicit --assignee. Add a member with lane=$lane or pick a different --lane."
      fi
    fi
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

  # driverOnly (bool) — load-bearing gate per ADR-033. New Tasks always
  # write the field explicitly; existing pre-ADR-033 Tasks lack it and
  # are read via `// false` coalesce in claim/move sites (E14/T2).
  local driver_only_json; driver_only_json=$(( driver_only )) # bash 0|1 → JSON via --argjson + ternary
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
      driverOnly:  ($driverOnly == 1),
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
    --argjson driverOnly "$driver_only_json" \
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

  # E6/S2 t-6a0e6daa (A3) — filter dimensions bind via --arg/$param
  # rather than shell-interpolation. Values are validated upstream
  # (status enum, lane enum, etc.) so this isn't a security fix —
  # it's the consistency contract that the rest of the codebase
  # already follows (atmux::jq_update everywhere uses --arg).
  # Empty-string args resolve via `$x == ""` short-circuit so absent
  # filters skip the corresponding map step.
  local base='
    .tasks
    | (if $status   != "" then map(select(.status == $status))   else . end)
    | (if $assignee != "" then map(select(.owner  == $assignee)) else . end)
    | (if $epic     != "" then map(select(.epic   == $epic))     else . end)
    | (if $story    != "" then map(select(.story  == $story))    else . end)
    | (if $lane     != "" then map(select(.lane   == $lane))     else . end)
  '
  # --lane explicitly excludes legacy tasks (.lane absent/null) — they have no
  # lane to match on, so a lane filter shouldn't sweep them in by default.

  if [[ "$json" -eq 1 ]]; then
    jq --arg status "$filter_status" \
       --arg assignee "$filter_assignee" \
       --arg epic "$filter_epic" \
       --arg story "$filter_story" \
       --arg lane "$filter_lane" \
       "$base" "$k"
    return
  fi

  local f="$base | sort_by(.priority // 99) | .[] | [.id, .status, (.owner // \"-\"), ((.priority // \"-\") | tostring), ((.lane // \"-\") | ascii_upcase), .subject] | @tsv"
  local rows
  rows="$(jq -r --arg status "$filter_status" \
                --arg assignee "$filter_assignee" \
                --arg epic "$filter_epic" \
                --arg story "$filter_story" \
                --arg lane "$filter_lane" \
                "$f" "$k")"
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

  # ADR-033 driver-only gate. Refuse `in-progress` and `done` transitions
  # when the Task is driverOnly:true and the caller's resolved scope
  # isn't "driver". `todo` and `blocked` transitions stay allowed because
  # those are bookkeeping (releasing a mis-claimed Task back to the pool;
  # marking a flag-blocked Task) — only forward-progress transitions
  # require driver scope.
  case "$status" in
    in-progress|done)
      if atmux::is_driver_only_blocked "$id"; then
        atmux::die "task move: $id is a driver-only Task — only the driver scope can move it to '$status'. Driver pane should have ATMUX_CALLER_SCOPE=driver set; if you ARE the driver, export ATMUX_CALLER_SCOPE=driver and retry."
      fi
      ;;
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
  # E6/S1 t-354a1b6b (A1 site 6/6) — atmux::jq_update for ADR-013
  # atomicity.
  # E6/Sm t-04c8b243 (Bug 2) — when the target status is `todo`, also
  # clear .owner / .claimedAt / .claimedFrom. A bounce-back ('claimed
  # the wrong lane, return it to the pool') previously left ownership
  # stamped: the next worker's claim --next select gate then rejected
  # the task because owner was somebody-else != caller. fe-kanban
  # bouncing t-09e761c4 wedged be-kanban's queue for 222 min during E6.
  # Other status targets (in-progress, blocked) leave ownership
  # untouched — only `todo` triggers the clear because returning to the
  # pool is the only flow where ownership becomes meaningless.
  atmux::jq_update "$k" \
    '(.tasks[]? | select(.id == $id) | .status) = $status
     | if $status == "todo" then
         (.tasks[]? | select(.id == $id) | .owner) = null
         | (.tasks[]? | select(.id == $id) | .claimedAt) = null
         | (.tasks[]? | select(.id == $id) | .claimedFrom) = null
       else . end' \
    --arg id "$id" --arg status "$status"
  if [[ "$status" == "todo" ]]; then
    atmux::ok "task $id → $status (ownership cleared)"
  else
    atmux::ok "task $id → $status"
  fi
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

  # E6/S2 t-eeb06966 — auto-dispatch depth guard. Read incoming depth
  # from env (default 0). Existing recursion gates (subject-prefix +
  # gitter+misc lane) catch known recursion classes; this depth cap is
  # defense-in-depth for unknown classes (e.g. planner-authored review
  # tasks that themselves trigger commits). Cap = 3: legitimate chains
  # max out at depth 2 (parent done → commit-Task = 1; commit-of-commit
  # would be depth 2 but is blocked by the subject-prefix gate already).
  # Depth ≥ 3 is genuinely abnormal — refuse the mint with audit trail.
  local _dispatch_depth_in="${ATMUX_DISPATCH_DEPTH:-0}"
  [[ "$_dispatch_depth_in" =~ ^[0-9]+$ ]] || _dispatch_depth_in=0
  local _dispatch_depth_new=$(( _dispatch_depth_in + 1 ))
  local _dispatch_depth_capped=0
  if (( _dispatch_depth_new >= 3 )); then
    _dispatch_depth_capped=1
  fi

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

  # Apply the depth gate AFTER the subject/owner heuristics so the warn
  # only fires when the depth cap is the binding constraint. If commit
  # was already suppressed by a recursion gate, the depth log would be
  # noise.
  if (( _dispatch_depth_capped == 1 )) && [[ "$do_commit" -eq 1 || -n "${target_epic_id:-}" ]]; then
    atmux::warn "auto-dispatch depth limit hit (parent=$id, depth=$_dispatch_depth_new) — not minting commit-Task"
    _atmux_kanban_notify_dispatch_depth_capped "$id" "$_dispatch_depth_new"
    do_commit=0
    do_epic_flip=0
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

  # E6/S2 t-48874db7 (F2-extension) — pre-write kanban backup. The
  # multi-mint jq filter below is the risky write that minted the B1
  # phantom (concurrent dispatch clobber). A timestamped .bak alongside
  # makes recovery painless if F12's post-write sanity probe later
  # rejects the result. Best-effort: cp failures (low-disk, read-only)
  # don't block the write itself.
  atmux::kanban_json_backup >/dev/null

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
          createdAt: $now, claimedAt: $now, completedAt: null,
          createdFrom: {parentTaskId: $id, depth: ($depth | tonumber)}
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
            createdAt: $now, claimedAt: $now, completedAt: null,
            createdFrom: {parentTaskId: $id, depth: ($depth | tonumber)}
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
    --arg summary_body "$summary_body" \
    --arg depth "$_dispatch_depth_new"

  # Auto-flip Story.reviewSignoff when this Task is review-lane + tied to
  # a Story. Bridges the gap between reviewer-marks-done and
  # `story advance --to merging` (lib/story.sh:282-285 dies with
  # reviewSignoff=false). E16 d-016afdeb allow-list: only review-shaped
  # callers (caller's role!=member OR caller's lane==review) can fire the
  # flip — defense-in-depth if E16 claim-side gate has not landed yet.
  if [[ "$src_lane" == "review" && -n "$src_story" && "$src_story" != "null" ]]; then
    local _atmux_caller="${ATMUX_MEMBER:-}"
    local _caller_role="" _caller_lane=""
    if [[ -n "$_atmux_caller" ]]; then
      local _tj; _tj="$(atmux::team_json 2>/dev/null)"
      if [[ -f "$_tj" ]]; then
        _caller_role="$(jq -r --arg n "$_atmux_caller" \
          '.members[]? | select(.name == $n) | .role // ""' "$_tj" 2>/dev/null)"
        _caller_lane="$(jq -r --arg n "$_atmux_caller" \
          '.members[]? | select(.name == $n) | .lane // ""' "$_tj" 2>/dev/null)"
      fi
    fi
    if [[ "$_caller_lane" == "review" \
          || ( -n "$_caller_role" && "$_caller_role" != "member" ) ]]; then
      atmux::jq_update "$k" \
        '.stories |= map(if .id == $sid then .reviewSignoff = true else . end)' \
        --arg sid "$src_story"
      atmux::log "task: story $src_story reviewSignoff=true via $id auto-flip (caller=$_atmux_caller)"
    else
      atmux::warn "review-Task $id finished by non-review caller '$_atmux_caller' (role=$_caller_role lane=$_caller_lane); story $src_story signoff NOT auto-flipped — re-run as reviewer or hand-flip"
    fi
  fi

  # Defense-in-depth: any nested atmux call from within this chain
  # inherits the new depth via env. tmux send-keys doesn't pass env, so
  # cross-pane chains rely on .createdFrom; this export covers any
  # future in-process subshell that re-enters atmux.
  export ATMUX_DISPATCH_DEPTH="$_dispatch_depth_new"

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

  # Cascade publish — wake every member whose Tasks just became
  # claimable because this Task closed. Per ADR-032 §Verb wire-in +
  # OQ4 default (per-target 100ms debounce). Non-fatal: dead listeners
  # warn-and-drop; cron-whip 5min floor catches anything missed.
  _atmux_kanban_publish_cascade "$id" "$src_owner"

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

# Discord notice for dispatch-depth-cap events (E6/S2 t-eeb06966).
# Rate-limited per parent task id via .atmux/state/dispatch-depth-seen.
# json — once per parent per cron-session. Mirrors the phantom-sweep
# ledger pattern: bounded growth, idempotent on re-entry. Webhook
# resolution chain matches lib/decisions.sh::_decisions_export_webhook
# (env override → team.json field → silent no-op).
_atmux_kanban_notify_dispatch_depth_capped() {
  local parent="$1" depth="$2"

  local ledger; ledger="$(atmux::state_dir)/dispatch-depth-seen.json"
  mkdir -p "$(dirname "$ledger")"
  [[ -s "$ledger" ]] || echo '{}' > "$ledger"

  local seen
  seen="$(jq -r --arg p "$parent" '.[$p] // empty' "$ledger" 2>/dev/null || true)"
  [[ -n "$seen" ]] && return 0

  if [[ -z "${ATMUX_DISCORD_WEBHOOK:-}" ]]; then
    local hook
    hook="$(jq -r '.discord.webhook // empty' "$(atmux::team_json)" 2>/dev/null || true)"
    if [[ -n "$hook" && "$hook" != "null" ]]; then
      export ATMUX_DISCORD_WEBHOOK="$hook"
    fi
  fi

  if [[ -n "${ATMUX_DISCORD_WEBHOOK:-}" ]]; then
    local team; team="$(atmux::team_name 2>/dev/null || echo unknown)"
    local ts; ts="$(atmux::now_myt)"
    local body="🛑 **[atmux-dispatch-depth]** · \`$team\` · $ts"
    body+=$'\n\n'"- ⛔ refused commit-Task mint: parent=\`$parent\`, depth=$depth"
    body+=$'\n'"- 📍 source: \`atmux task show $parent\`"
    atmux::discord_ping "$body" >/dev/null 2>&1 || true
  fi

  local now; now="$(atmux::now_epoch)"
  atmux::jq_update "$ledger" \
    '. + {($p): ($t | tonumber)}' \
    --arg p "$parent" --arg t "$now"
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
      # E6/S1 t-354a1b6b (A1 site 6/6) — atmux::jq_update for ADR-013
      # atomicity. Filter logic preserved verbatim. The jq -e existence
      # check above stays a read-only fast path; only the rewriter
      # converts.
      atmux::jq_update "$ib" \
        '.inProgress = [.inProgress[]? | select(.id != $id)]' \
        --arg id "$task_id"
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

  # E6/S2 t-a27f217b — inbox cap guard. Auto-dispatch chain has the
  # higher overflow risk (recursion-gate slip → ballooning inProgress)
  # so the cap fires here as well as in lib/dispatch.sh. Cap-refused:
  # auto-mint kanban entry already landed via finish_task_done's main
  # jq filter; only the inbox copy + ping are skipped.
  if ! atmux::inbox_push_guard "$ib"; then
    atmux::inbox_cap_warn "$member"
    return 0
  fi

  # E6/S1 t-354a1b6b (A1 site 6/6) — atmux::jq_update for ADR-013
  # atomicity. Filter logic preserved verbatim; \$now passed via --arg
  # + tonumber to keep filter shape identical.
  atmux::jq_update "$ib" \
    '.inProgress += [$t + {dispatchedAt: ($now | tonumber)}]' \
    --argjson t "$task_json" --arg now "$now"

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

# Compute the set of Tasks now-unblocked by closer_id's done-transition,
# group by target member, and fire one task-done-cascade event per member
# via atmux::sock_publish_debounced (per ADR-032 §Verb wire-in + OQ4
# per-target 100ms debounce).
#
# Owner resolution per unblocked Task:
#   - .owner set         → publish to that member.
#   - .owner null + .lane → publish to ALL team members carrying that lane
#                            (first-claim-wins; cascade is a wake-up nudge).
#   - both null          → skip (no addressable target; whip floor catches
#                            unscheduled work on its next 5 min tick).
#
# Filter to Tasks whose deps[] include closer_id AND whose deps[] are now
# all done. Tasks unblocked by a previous close don't get re-broadcast —
# their cascade fired then.
_atmux_kanban_publish_cascade() {
  local closer_id="$1" closer_owner="$2"
  local k; k="$(atmux::kanban_json)"
  local tj; tj="$(atmux::team_json)"

  local unblocked
  unblocked="$(jq -c --arg closer "$closer_id" '
    . as $root
    | ($root.tasks | map(select(.status == "done") | .id)) as $done
    | [ $root.tasks[]
        | select(.status == "todo")
        | select((.deps // []) | index($closer))
        | select((.deps // []) | all(. as $d | $done | index($d)))
        | { id, owner: (.owner // null), lane: (.lane // null) }
      ]' "$k" 2>/dev/null || echo '[]')"

  local n_unblocked
  n_unblocked="$(jq 'length' <<<"$unblocked" 2>/dev/null || echo 0)"
  [[ "$n_unblocked" -gt 0 ]] || return 0

  # Expand each unblocked Task to (member, task_id) pairs. Lane-only
  # tasks (owner null + lane set) fan out to every team member carrying
  # that lane — first-claim-wins. Tasks with neither owner nor lane are
  # dropped here (no addressable target).
  local pairs
  pairs="$(jq -c --slurpfile team "$tj" '
    [ .[]
      | . as $t
      | if ($t.owner != null and $t.owner != "") then
          [{ member: $t.owner, task_id: $t.id }]
        elif ($t.lane != null and $t.lane != "") then
          (($team[0].members // [])
           | map(select((.lane // "misc") == $t.lane))
           | map({ member: .name, task_id: $t.id }))
        else
          []
        end
    ] | flatten' <<<"$unblocked" 2>/dev/null || echo '[]')"

  local by_member
  by_member="$(jq -c '
    group_by(.member)
    | map({ member: .[0].member, task_ids: ([.[].task_id] | unique) })' \
    <<<"$pairs" 2>/dev/null || echo '[]')"

  local count
  count="$(jq 'length' <<<"$by_member" 2>/dev/null || echo 0)"
  [[ "$count" -gt 0 ]] || return 0

  local now; now="$(atmux::now_epoch)"
  local i=0
  while (( i < count )); do
    local m ids_json event
    m="$(jq -r ".[$i].member" <<<"$by_member")"
    ids_json="$(jq -c ".[$i].task_ids" <<<"$by_member")"
    event="$(jq -c -n \
      --arg type "task-done-cascade" \
      --argjson ts "$now" \
      --arg from "${closer_owner:-}" \
      --arg from_task "$closer_id" \
      --argjson ids "$ids_json" \
      '{type: $type, ts: $ts, from: $from,
        payload: {unblocked_task_ids: $ids, from_task_id: $from_task}}')"
    atmux::sock_publish_debounced "$m" "$event" 100
    i=$((i+1))
  done
}

_atmux_task_assign() {
  local id="${1:-}" who="${2:-}"
  [[ -n "$id" && -n "$who" ]] || atmux::die "task assign: <id> <member>"
  local k; k="$(atmux::kanban_json)"
  # E6/S1 t-354a1b6b (A1 site 6/6) — atmux::jq_update for ADR-013
  # atomicity. Filter logic preserved verbatim.
  atmux::jq_update "$k" \
    '(.tasks[] | select(.id == $id) | .owner) = $who' \
    --arg id "$id" --arg who "$who"
  atmux::ok "task $id assigned → $who"
}

_atmux_task_rm() {
  local id="${1:-}"; [[ -n "$id" ]] || atmux::die "task rm: <id> required"
  local k; k="$(atmux::kanban_json)"
  # E6/S1 t-354a1b6b (A1 site 6/6) — atmux::jq_update for ADR-013
  # atomicity. Filter logic preserved verbatim. _atmux_task_rm racing
  # finish_task_done's commit-Task append IS the documented B1 phantom
  # scenario per ADR-013 §Context — closing this site is the headline.
  atmux::jq_update "$k" \
    '.tasks |= map(select(.id != $id))' \
    --arg id "$id"
  atmux::ok "task $id removed"
}

# atmux::task_append_note lives in lib/common.sh so non-kanban callers
# (lib/flags.sh's --task linkage) can reach it without sourcing this file.

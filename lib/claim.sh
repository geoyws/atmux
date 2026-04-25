#!/usr/bin/env bash
# atmux claim <task-id> [--as <member>]
# atmux claim --next [--as <member>] [--lane <lane>]
# atmux done  <task-id> [--as <member>] [--note <text>]
#
# Invoked via alias: bin/atmux rewrites `atmux claim <id>` → `atmux claim --claim <id>`,
# and `atmux done <id>` → `atmux claim --done <id>`. This lets both verbs share code.

main() {
  atmux::require jq
  atmux::require_team
  atmux::kanban_normalize

  local verb=""
  case "${1:-}" in
    --claim|--done) verb="${1#--}"; shift ;;
    *) atmux::die "claim.sh called without verb flag (internal error)" ;;
  esac

  local id="" who="" note="" pick_next=0 pick_lane=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --as)   who="$2"; shift 2 ;;
      --note) note="$2"; shift 2 ;;
      --next) pick_next=1; shift ;;
      --lane) pick_lane="$2"; shift 2 ;;
      -*) atmux::die "$verb: unknown flag: $1" ;;
      *) if [[ -z "$id" ]]; then id="$1"; shift; else atmux::die "$verb: too many args"; fi ;;
    esac
  done

  if [[ "$pick_next" -eq 1 ]]; then
    [[ "$verb" == "claim" ]] || atmux::die "--next is only valid with claim, not $verb"
    [[ -z "$id" ]] || atmux::die "claim --next: don't pass <task-id> (selection is automatic)"
    _atmux_claim_pick_next "$who" "$pick_lane"
    return
  fi

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

# ---------- claim --next (pull-mode work selection — T4.3 / ADR-007) ----------

# Pull a single claimable task from the kanban + claim it atomically. Lane
# preference: caller's team.json lane, override-able via --lane. Falls back
# to any-lane when team.kanban.crossLaneClaim is true (default true). Honours
# deps (skip tasks with non-done deps) + paused-member status.
_atmux_claim_pick_next() {
  local who="$1" override_lane="$2"

  if [[ -z "$who" ]]; then
    who="${ATMUX_MEMBER:-$(_atmux_guess_member_from_cwd)}"
  fi
  [[ -n "$who" ]] || atmux::die "claim --next: can't infer member — set ATMUX_MEMBER or pass --as <member>"

  # shellcheck source=pause.sh
  . "$ATMUX_LIB_DIR/pause.sh"
  if atmux::is_paused "$who"; then
    atmux::die "claim --next: $who is paused — resume with \`atmux resume $who\`"
  fi

  local tj; tj="$(atmux::team_json)"
  local lane="$override_lane"
  if [[ -z "$lane" ]]; then
    lane=$(jq -r --arg n "$who" '.members[]? | select(.name == $n) | .lane // ""' "$tj")
    [[ "$lane" == "null" ]] && lane=""
  fi
  local cross
  # `// true` would coerce a literal `false` to true (// returns RHS for both
  # null AND false). Branch explicitly on `has` to distinguish missing-default
  # from explicitly-set-false.
  cross=$(jq -r 'if (.kanban // {} | has("crossLaneClaim"))
                 then .kanban.crossLaneClaim
                 else true end' "$tj")

  # Race-aware retry loop. The atomic claim filter only mutates if .owner is
  # still null, so a losing racer just falls through to a re-select on the
  # next iteration. Bound to 3 retries per AC.
  local attempts=0
  while (( attempts < 3 )); do
    attempts=$(( attempts + 1 ))

    local pick_id
    pick_id=$(_atmux_claim_select_next "$lane" "$cross")
    if [[ -z "$pick_id" ]]; then
      if [[ "$cross" != "true" && -n "$lane" ]]; then
        local lane_disp; lane_disp=$(printf '%s' "$lane" | tr '[:lower:]' '[:upper:]')
        atmux::die "claim --next: no work in $lane_disp lane (crossLaneClaim=false)"
      fi
      atmux::log "claim --next: no claimable work for $who"
      return 0
    fi

    if _atmux_claim_apply_atomic "$pick_id" "$who"; then
      local k; k="$(atmux::kanban_json)"
      local task_json; task_json=$(jq --arg id "$pick_id" '.tasks[]? | select(.id == $id)' "$k")
      local subject; subject=$(jq -r '.subject' <<<"$task_json")
      _atmux_inbox_move "$who" "$task_json" "pending->inProgress" "$(atmux::now_epoch)"
      atmux::ok "$who claimed $pick_id"
      printf '%s %s\n' "$pick_id" "$subject"
      return 0
    fi
    # Lost the race — retry with a fresh selection.
  done

  atmux::die "claim --next: 3 retries exhausted on race condition (try again)"
}

# Select the next claimable task id. Empty string when nothing is claimable.
# First pass: lane-matched (when caller has a lane). Second pass (if cross is
# true OR caller has no lane): any lane. Sort: priority asc (1=highest),
# then createdAt asc — tie-breaks deterministically per AC.
_atmux_claim_select_next() {
  local lane="$1" cross="$2"
  local k; k="$(atmux::kanban_json)"

  # First pass — only when we have a caller lane to prefer.
  if [[ -n "$lane" ]]; then
    local first
    first=$(jq -r --arg lane "$lane" '
      . as $root
      | ($root.tasks | map(select(.status == "done") | .id)) as $done_ids
      | [
          $root.tasks[]?
          | select(.status == "todo")
          | select((.owner // null) == null)
          | select(.lane == $lane)
          | select(((.deps // []) - $done_ids) | length == 0)
        ]
      | sort_by((.priority // 999), (.createdAt // 0))
      | .[0].id // empty
    ' "$k")
    if [[ -n "$first" ]]; then
      printf '%s' "$first"
      return
    fi
  fi

  # Fallback — any lane (or no-lane legacy tasks). Gated on crossLaneClaim
  # except when caller has no lane at all (then there's nothing to "cross"
  # from, so we always fall through).
  if [[ "$cross" == "true" || -z "$lane" ]]; then
    jq -r '
      . as $root
      | ($root.tasks | map(select(.status == "done") | .id)) as $done_ids
      | [
          $root.tasks[]?
          | select(.status == "todo")
          | select((.owner // null) == null)
          | select(((.deps // []) - $done_ids) | length == 0)
        ]
      | sort_by((.priority // 999), (.createdAt // 0))
      | .[0].id // empty
    ' "$k"
  fi
}

# Atomic claim: only flips .owner/.status/.claimedAt when .owner is currently
# null. Returns 0 if WE landed the claim (post-update .owner == $who), 1 if
# someone else already had it (race lost).
_atmux_claim_apply_atomic() {
  local task_id="$1" who="$2"
  local k; k="$(atmux::kanban_json)"
  local now; now="$(atmux::now_epoch)"

  atmux::jq_update "$k" \
    '.tasks |= map(
       if .id == $id and (.owner // null) == null then
         .owner = $who | .status = "in-progress" | .claimedAt = $now
       else . end
     )' \
    --arg id "$task_id" --arg who "$who" --argjson now "$now"

  local owner_after
  owner_after=$(jq -r --arg id "$task_id" '.tasks[]? | select(.id == $id) | .owner // ""' "$k")
  [[ "$owner_after" == "$who" ]]
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

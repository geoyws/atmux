#!/usr/bin/env bash
# atmux super-status [--json] [--prune]
#
# Cross-team / fleet rollup. Reads ~/.claude/teams/registry.json (E10/Sa
# helpers) + walks each entry's projectRoot for kanban + lead-outbox + git
# state. NO mutations on default reads — registry status flips happen only
# under --prune (operator-explicit).
#
# Per-team digest:
#   name + projectRoot + sessionName + status (running/stopped/stale)
#   kanban: todo / in-progress / blocked counts + opsPending (lane=ops + status≠done)
#   leadOutbox: last 3 entries from <projectRoot>/.atmux/lead-outbox.md
#   gitLog: last 5 oneline commits on projectRoot
#   branch: { ahead, behind } vs origin (`git rev-list --left-right --count`)
#
# Fleet rollup:
#   counts by status (running/stopped/stale)
#   promoteReadyEpics — Epic.status='review' OR every owned Story is done
#   staleClaims — in-progress Tasks claimed > 24h ago across ANY team
#   idleTeams — no commit AND no lead-outbox activity in last 24h
#
# Liveness rule: tmux has-session (under team's tmuxTmpdir) AND -d projectRoot/.atmux.
# Both fail → status='stale' in render. Default render does NOT mutate registry.
# --prune sets status='stale' on liveness-failed entries (preserving entry per
# ADR-025 §Decision: deregister keeps history; prune is the "remove from view"
# affordance, but we honor the same preserve-entry invariant — change status,
# don't delete).

main() {
  atmux::require jq

  # Rename in progress (E10/Se ADR-027 OQ H4): a half-renamed registry +
  # session would surface as fleet noise (a "stale" team that's actually
  # mid-rename). Skip the tick when the current team's rename.lock is
  # present. atmux::state_dir resolves from cwd → out-of-team invocations
  # (super-attach session) read a nonexistent path and continue normally;
  # the per-team filter on individual entries is out of scope per Sg.
  if [[ -f "$(atmux::state_dir)/rename.lock" ]]; then
    atmux::log "super-status: rename in progress — skipping tick"
    return 0
  fi

  local json=0 prune=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)  json=1; shift ;;
      --prune) prune=1; shift ;;
      *) atmux::die "super-status: unknown flag: $1" ;;
    esac
  done

  # Lazy-source registry helpers — common.sh is already sourced by bin/atmux.
  if ! declare -F atmux::registry_path >/dev/null 2>&1; then
    # shellcheck source=registry.sh
    . "$ATMUX_LIB_DIR/registry.sh"
  fi

  local rpath; rpath="$(atmux::registry_path)"
  if [[ ! -s "$rpath" ]]; then
    if [[ "$json" -eq 1 ]]; then
      printf '{"teams":[],"fleet":{"counts":{"running":0,"stopped":0,"stale":0},"promoteReadyEpics":[],"staleClaims":[],"idleTeams":[]}}\n'
    else
      printf '%ssuper-status%s  no teams registered (registry: %s)\n' \
        "$atmux_c_dim" "$atmux_c_rst" "$rpath"
    fi
    return 0
  fi

  local now; now="$(atmux::now_epoch)"
  local stale_threshold=$(( 24 * 3600 ))

  # Walk each registry entry, build per-team digest, accumulate into teams[].
  local teams='[]' entry name proj sess status digest
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    name="$(jq -r '.name'        <<<"$entry")"
    proj="$(jq -r '.projectRoot' <<<"$entry")"
    sess="$(jq -r '.sessionName // ""' <<<"$entry")"
    status="$(jq -r '.status // "running"' <<<"$entry")"

    digest="$(_atmux_super_status_team_digest "$name" "$proj" "$sess" "$status" "$now")"
    teams="$(jq --argjson d "$digest" --argjson t "$teams" '$t + [$d]' <<<"null")"
  done < <(jq -c '.[]' "$rpath")

  # Fleet rollup from the per-team digests.
  local fleet
  fleet="$(_atmux_super_status_fleet "$teams" "$now" "$stale_threshold")"

  if [[ "$prune" -eq 1 ]]; then
    _atmux_super_status_prune "$rpath" "$teams"
  fi

  if [[ "$json" -eq 1 ]]; then
    jq -n --argjson teams "$teams" --argjson fleet "$fleet" \
      '{teams: $teams, fleet: $fleet}'
  else
    _atmux_super_status_render_human "$teams" "$fleet"
  fi
}

# Per-team digest. Echoes one JSON object per call.
_atmux_super_status_team_digest() {
  local name="$1" proj="$2" sess="$3" status="$4" now="$5"

  # Liveness — both checks must pass to keep 'running'. Each can fail
  # independently; either failure → 'stale'. Read-only.
  local atmux_dir="$proj/.atmux"
  local has_atmux=0 has_session=0
  [[ -d "$atmux_dir" ]] && has_atmux=1

  local tmpdir=""
  if [[ -f "$atmux_dir/team.json" ]]; then
    tmpdir="$(jq -r '.tmuxTmpdir // empty' "$atmux_dir/team.json" 2>/dev/null)"
  fi
  if [[ -n "$sess" ]]; then
    if [[ -n "$tmpdir" ]]; then
      TMUX_TMPDIR="$tmpdir" tmux has-session -t "=$sess" 2>/dev/null && has_session=1
    else
      tmux has-session -t "=$sess" 2>/dev/null && has_session=1
    fi
  fi

  local live_status="$status"
  if [[ "$status" != "stopped" ]]; then
    if (( has_atmux == 0 || has_session == 0 )); then
      live_status="stale"
    else
      live_status="running"
    fi
  fi

  # Kanban rollup.
  local kanban='{"todo":0,"inProgress":0,"blocked":0,"opsPending":0}'
  local kpath="$atmux_dir/kanban.json"
  if [[ -s "$kpath" ]]; then
    kanban="$(jq '{
      todo:       [.tasks[]? | select(.status == "todo")]                            | length,
      inProgress: [.tasks[]? | select(.status == "in-progress")]                     | length,
      blocked:    [.tasks[]? | select(.status == "blocked")]                         | length,
      opsPending: [.tasks[]? | select((.lane // "") == "ops" and .status != "done")] | length
    }' "$kpath" 2>/dev/null || echo '{"todo":0,"inProgress":0,"blocked":0,"opsPending":0}')"
  fi

  # Lead-outbox tail — last 3 non-empty lines.
  local outbox_tail='[]'
  local opath="$atmux_dir/lead-outbox.md"
  if [[ -f "$opath" ]]; then
    outbox_tail="$(grep -v '^$' "$opath" 2>/dev/null | tail -3 | jq -R . | jq -s .)"
  fi

  # Git log + ahead/behind (read-only via -C).
  local git_log='[]' ahead=0 behind=0
  if [[ -d "$proj/.git" ]] || git -C "$proj" rev-parse --git-dir >/dev/null 2>&1; then
    git_log="$(git -C "$proj" log --oneline -5 2>/dev/null | jq -R . | jq -s . || echo '[]')"
    local ab
    ab="$(git -C "$proj" rev-list --left-right --count '@{u}...HEAD' 2>/dev/null || true)"
    if [[ -n "$ab" ]]; then
      behind="$(awk '{print $1}' <<<"$ab")"
      ahead="$(awk '{print $2}' <<<"$ab")"
    fi
  fi

  # Most recent commit epoch — used by fleet idle detection.
  local last_commit=0
  last_commit="$(git -C "$proj" log -1 --format=%ct 2>/dev/null || echo 0)"
  [[ "$last_commit" =~ ^[0-9]+$ ]] || last_commit=0

  # Most recent lead-outbox mtime.
  local last_outbox=0
  if [[ -f "$opath" ]]; then
    last_outbox="$(stat -c '%Y' "$opath" 2>/dev/null || stat -f '%m' "$opath" 2>/dev/null || echo 0)"
  fi

  jq -n \
    --arg name "$name" --arg proj "$proj" --arg sess "$sess" \
    --arg status "$live_status" \
    --argjson kanban "$kanban" \
    --argjson outbox "$outbox_tail" \
    --argjson gitlog "$git_log" \
    --argjson ahead  "$ahead" --argjson behind "$behind" \
    --argjson last_commit "$last_commit" --argjson last_outbox "$last_outbox" \
    '{name: $name, projectRoot: $proj, sessionName: $sess, status: $status,
      kanban: $kanban, leadOutbox: $outbox, gitLog: $gitlog,
      branch: {ahead: $ahead, behind: $behind},
      lastCommit: $last_commit, lastOutbox: $last_outbox}'
}

# Fleet rollup over the teams[] array. Echoes one JSON object.
_atmux_super_status_fleet() {
  local teams="$1" now="$2" stale_threshold="$3"

  # Counts by status. `total` is the sum of the three buckets — kept as
  # an explicit field per README schema so downstream consumers don't
  # have to recompute it (the human renderer at line 281 derives it the
  # same way).
  local counts
  counts="$(jq -n --argjson t "$teams" '
    {
      running: [$t[] | select(.status == "running")] | length,
      stopped: [$t[] | select(.status == "stopped")] | length,
      stale:   [$t[] | select(.status == "stale")]   | length
    } | .total = (.running + .stopped + .stale)')"

  # Promote-ready epics — walk each running team's kanban for epics in 'review'
  # OR epics whose every story is 'done' (and at least 1 story exists).
  local promote_ready='[]' staleClaims='[]' idle='[]'
  local entry name proj kpath
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    name="$(jq -r '.name' <<<"$entry")"
    proj="$(jq -r '.projectRoot' <<<"$entry")"
    kpath="$proj/.atmux/kanban.json"

    if [[ -s "$kpath" ]]; then
      # Epic is promote-ready when status='review' OR every owned Story is
      # done (and at least one Story exists — empty-Story-list epics aren't
      # auto-promotable, that would flip every brand-new epic on first add).
      local team_promote
      team_promote="$(jq --arg team "$name" '
        (.stories // []) as $allStories
        | [.epics[]?
           | . as $e
           | ($allStories | map(select(.epic == $e.id))) as $children
           | select(
               $e.status == "review"
               or ( ($children | length) > 0
                    and (all($children[]; .status == "done")) )
             )
           | {team: $team, id: $e.id, title: ($e.title // ""), status: ($e.status // "")}]
      ' "$kpath" 2>/dev/null || echo '[]')"
      promote_ready="$(jq --argjson new "$team_promote" --argjson all "$promote_ready" '$all + $new' <<<"null")"

      # Stale claims — in-progress + claimedAt older than stale_threshold.
      local team_stale
      team_stale="$(jq --arg team "$name" --argjson now "$now" --argjson th "$stale_threshold" '
        [.tasks[]? | select(.status == "in-progress" and ((.claimedAt // 0) > 0) and ($now - (.claimedAt // 0)) > $th)
                   | {team: $team, id: .id, owner: (.owner // ""), claimedAt: .claimedAt, ageSec: ($now - .claimedAt)}]
      ' "$kpath" 2>/dev/null || echo '[]')"
      staleClaims="$(jq --argjson new "$team_stale" --argjson all "$staleClaims" '$all + $new' <<<"null")"
    fi

    # Idle: no commit AND no outbox activity in last 24h. Stopped teams skipped
    # (status='stopped' is operator-intentional, not a fleet anomaly).
    local lc lo st
    lc="$(jq -r '.lastCommit  // 0' <<<"$entry")"
    lo="$(jq -r '.lastOutbox  // 0' <<<"$entry")"
    st="$(jq -r '.status'            <<<"$entry")"
    if [[ "$st" != "stopped" ]] \
       && (( now - lc > stale_threshold )) \
       && (( now - lo > stale_threshold )); then
      idle="$(jq --arg name "$name" --argjson lc "$lc" --argjson lo "$lo" --argjson all "$idle" \
        '$all + [{name: $name, lastCommit: $lc, lastOutbox: $lo}]' <<<"null")"
    fi
  done < <(jq -c '.[]' <<<"$teams")

  jq -n --argjson counts "$counts" --argjson promote "$promote_ready" \
        --argjson stale "$staleClaims" --argjson idle "$idle" \
    '{counts: $counts, promoteReadyEpics: $promote, staleClaims: $stale, idleTeams: $idle}'
}

# --prune: rewrite registry.json so liveness-stale entries flip to status='stale'.
# Preserves entry (no delete) per ADR-025: deregister/prune both keep history.
_atmux_super_status_prune() {
  local rpath="$1" teams="$2"
  local stale_names
  stale_names="$(jq -r '[.[] | select(.status == "stale") | .name]' <<<"$teams")"
  [[ "$(jq 'length' <<<"$stale_names")" -gt 0 ]] || { atmux::log "super-status --prune: no stale entries"; return 0; }

  atmux::jq_update "$rpath" '
    map(if (.name as $n | $stale | index($n)) then .status = "stale" else . end)
  ' --argjson stale "$stale_names"

  atmux::ok "super-status --prune: marked stale → $(jq -r 'join(", ")' <<<"$stale_names")"
}

# Human-readable render.
_atmux_super_status_render_human() {
  local teams="$1" fleet="$2"

  local n_running n_stopped n_stale n_total
  n_running="$(jq -r '.counts.running' <<<"$fleet")"
  n_stopped="$(jq -r '.counts.stopped' <<<"$fleet")"
  n_stale="$(  jq -r '.counts.stale'   <<<"$fleet")"
  n_total=$(( n_running + n_stopped + n_stale ))

  printf '%s🛰  super-status%s  fleet=%d  🟢 running=%d  ⚪ stopped=%d  🟡 stale=%d\n\n' \
    "$atmux_c_bld$atmux_c_cyn" "$atmux_c_rst" \
    "$n_total" "$n_running" "$n_stopped" "$n_stale"

  printf '%-18s %-9s %-7s %s\n' "TEAM" "STATUS" "KANBAN" "BRANCH"
  jq -r '.[] | [.name, .status,
    "📌\(.kanban.todo)/🟡\(.kanban.inProgress)/🛑\(.kanban.blocked)",
    "↑\(.branch.ahead)/↓\(.branch.behind)"] | @tsv' <<<"$teams" \
    | while IFS=$'\t' read -r n st kb br; do
        printf '  %-16s %-9s %-7s %s\n' "$n" "$st" "$kb" "$br"
      done

  local n_promote n_stale_claims n_idle
  n_promote="$(jq      '.promoteReadyEpics | length' <<<"$fleet")"
  n_stale_claims="$(jq '.staleClaims       | length' <<<"$fleet")"
  n_idle="$(jq         '.idleTeams         | length' <<<"$fleet")"
  echo ""
  printf '%s🌐 fleet rollup%s  promote-ready=%d  stale-claims=%d  idle-teams=%d\n' \
    "$atmux_c_dim" "$atmux_c_rst" "$n_promote" "$n_stale_claims" "$n_idle"
}

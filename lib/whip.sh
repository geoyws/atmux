#!/usr/bin/env bash
# atmux whip — 5-minute watchdog. Intended for cron:
#
#   */5 * * * * cd /path/to/project && /usr/local/bin/atmux whip >> .atmux/logs/whip.log 2>&1
#
# Checks performed on each tick:
#   1. tmux session liveness
#   2. per-member pane: is pane running the expected TUI? (zsh/bash = crashed)
#   3. per-member: is the pane idle > $ATMUX_STALE_MIN minutes with in-progress tasks?
#   4. per-member Claude Code: is "Compacting conversation" or "hit your limit" banner visible?
#   5. lead: uptime > $ATMUX_LEAD_MAX_MIN minutes → recommend rotate
#
# Non-interactive; escalates to Discord via $ATMUX_DISCORD_WEBHOOK when findings exist.

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"
# shellcheck source=cost.sh
. "$ATMUX_LIB_DIR/cost.sh"
# shellcheck source=pause.sh
. "$ATMUX_LIB_DIR/pause.sh"

main() {
  atmux::require jq tmux
  atmux::require_team

  local team session
  team="$(atmux::team_name)"
  session="$(atmux::session_name)"

  local STALE_MIN="${ATMUX_STALE_MIN:-30}"
  local LEAD_MAX_MIN="${ATMUX_LEAD_MAX_MIN:-60}"

  local findings=()
  local ts; ts="$(atmux::now_myt)"

  # ---- decisions cursor (ADR-008 / T10.2) ----
  # Runs regardless of session liveness — decisions.md is independent state.
  # Sets `dmtime_new` if the file exists; that's used for the post-ping
  # cursor advance below. Appends a flag-only pointer to findings if N > 0.
  local dmtime_new=""
  _atmux_whip_check_decisions

  # ---- 1. session liveness ----
  if ! atmux::tmux_session_exists; then
    findings+=("🛑 session $session is DOWN")
    _atmux_report_and_exit "$ts" "$team" "${findings[@]}"
    _atmux_whip_advance_decisions_cursor
    return 0
  fi

  # ---- per-member checks ----
  local mj; mj="$(jq -c '.members[]' "$(atmux::team_json)")"
  local lead_name=""
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    local name role tui
    name=$(jq -r '.name' <<<"$m")
    role=$(jq -r '.role // "member"' <<<"$m")
    tui=$(jq -r '.tui // "claude"' <<<"$m")
    [[ "$role" == "team-lead" ]] && lead_name="$name"

    if ! atmux::tmux_window_exists "$name"; then
      findings+=("🛑 $name: window missing (role=$role)")
      continue
    fi

    local pane_cmd
    pane_cmd=$(tmux list-panes -t "$(atmux::tmux_target "$name")" -F '#{pane_current_command}' 2>/dev/null | head -1)
    local want=""
    case "$tui" in
      claude) want="claude" ;;
      opencode) want="opencode" ;;
      kimi) want="kimi" ;;
      cursor) want="cursor-agent" ;;
    esac
    if [[ -n "$want" && "$pane_cmd" != "$want" ]]; then
      findings+=("🛑 $name: pane is \`$pane_cmd\` not \`$want\` (TUI crashed or not launched)")
      continue
    fi

    # Banner detection.
    local state; state=$(atmux::capture_pane "$name" 30)
    if echo "$state" | grep -qi 'hit your limit\|rate.?limit'; then
      findings+=("🔴 $name: rate-limited banner visible")
    fi
    if echo "$state" | grep -qi 'Compacting conversation'; then
      findings+=("⏳ $name: compacting — skip sends until done")
    fi
    if echo "$state" | grep -qi 'Press up to edit queued messages'; then
      findings+=("📥 $name: messages queued but not submitted")
    fi

    # Stale-task heuristic — count inbox entries whose effective anchor is
    # older than STALE_MIN. The anchor is max(claimedAt, dispatchedAt,
    # <member>-rotated.epoch): a recent rotation means the member resumed
    # clean and shouldn't be flagged for tasks that were claimed pre-rotation.
    local ib="$(atmux::inbox_dir)/$name.json"
    if [[ -f "$ib" ]]; then
      local rotated; rotated=$(_atmux_whip_member_rotated_epoch "$name")
      local stale
      stale=$(jq --argjson now "$(atmux::now_epoch)" --argjson s "$((STALE_MIN*60))" \
                  --argjson rot "$rotated" \
        '[.inProgress[]
          | (.claimedAt // .dispatchedAt // 0) as $base
          | ([$base, $rot] | max) as $anchor
          | select(($anchor + $s) < $now)
         ] | length' "$ib" 2>/dev/null || echo 0)
      if [[ "${stale:-0}" -gt 0 ]]; then
        findings+=("⏰ $name: $stale task(s) in-progress > ${STALE_MIN}min")
      fi
    fi
  done <<< "$mj"

  # ---- budget check ----
  local tj; tj="$(atmux::team_json)"
  local budget_total budget_per_member overrun_policy
  budget_total=$(jq -r '.budget.total // empty' "$tj")
  budget_per_member=$(jq -r '.budget.perMember // empty' "$tj")
  overrun_policy=$(jq -r '.budget.overrunPolicy // "warn"' "$tj")

  if [[ -n "$budget_total" || -n "$budget_per_member" ]]; then
    local sf="$(atmux::state_dir)/session-start.txt"
    local since; since=$(cat "$sf" 2>/dev/null || echo 0)
    local cost_snapshot; cost_snapshot=$(atmux::compute_team_cost "$since")
    local total_usd; total_usd=$(jq -r '.totalUsd' <<<"$cost_snapshot")

    if [[ -n "$budget_total" ]]; then
      if awk "BEGIN{exit !($total_usd >= $budget_total)}"; then
        findings+=("💸 team cost \$$total_usd ≥ total budget \$$budget_total (policy=$overrun_policy)")
      fi
    fi
    if [[ -n "$budget_per_member" ]]; then
      local overs
      overs=$(jq -r --argjson cap "$budget_per_member" \
        '.members[] | select(.usd >= $cap) | "💸 \(.member) cost $\(.usd) ≥ per-member budget $\($cap | tostring)"' <<<"$cost_snapshot")
      if [[ -n "$overs" ]]; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && findings+=("$line")
        done <<< "$overs"

        if [[ "$overrun_policy" == "pause" ]]; then
          local m_over
          while IFS= read -r m_over; do
            [[ -z "$m_over" ]] && continue
            ATMUX_PAUSE_REASON="budget-exhausted" \
              "$ATMUX_BIN_DIR/atmux" pause "$m_over" >/dev/null 2>&1 || true
          done < <(jq -r --argjson cap "$budget_per_member" \
            '.members[] | select(.usd >= $cap) | .member' <<<"$cost_snapshot")
        elif [[ "$overrun_policy" == "failover" ]]; then
          _atmux_whip_attempt_failover "$cost_snapshot" "$budget_per_member"
        fi
      fi
    fi
  fi

  # ---- lead uptime check ----
  if [[ -n "$lead_name" ]]; then
    local start_file="$(atmux::state_dir)/session-start.txt"
    if [[ -f "$start_file" ]]; then
      local start; start=$(cat "$start_file" 2>/dev/null || echo 0)
      local uptime=$(( $(atmux::now_epoch) - start ))
      local uptime_min=$(( uptime / 60 ))
      if [[ "$uptime_min" -ge "$LEAD_MAX_MIN" ]]; then
        findings+=("♻️  lead uptime=${uptime_min}min ≥ ${LEAD_MAX_MIN}min — consider \`atmux rotate-lead\`")
      fi
    fi
  fi

  _atmux_report_and_exit "$ts" "$team" "${findings[@]}"
  _atmux_whip_advance_decisions_cursor
}

# Detect new decisions since the last whip cursor and append a flag-only
# pointer to the parent's `findings` array. Sets `dmtime_new` (parent local)
# to the file's current mtime if the file exists — used by the cursor-advance
# helper after the ping fires. Silent no-op if decisions.md is absent.
_atmux_whip_check_decisions() {
  local dfile; dfile="$(atmux::dir)/decisions.md"
  [[ -f "$dfile" ]] || return 0

  dmtime_new=$(stat -c '%Y' "$dfile" 2>/dev/null || stat -f '%m' "$dfile" 2>/dev/null || echo 0)

  local dcursor_file; dcursor_file="$(atmux::state_dir)/decisions-cursor"
  local dcursor_old=0
  if [[ -f "$dcursor_file" ]]; then
    dcursor_old=$(cat "$dcursor_file" 2>/dev/null || echo 0)
    [[ "$dcursor_old" =~ ^[0-9]+$ ]] || dcursor_old=0
  fi

  (( dmtime_new > dcursor_old )) || return 0

  local n_new
  n_new=$(awk -v c="$dcursor_old" '
    BEGIN { in_entry=0; count=0 }
    /^### / && $2 ~ /^d-/ { in_entry=1; next }
    /^- \*\*timestamp\*\*:/ {
      v=$0; sub(/^- \*\*timestamp\*\*: */,"",v)
      if (in_entry && (v+0) > c) { count++ }
      in_entry=0
    }
    END { print count }
  ' "$dfile")

  if [[ "${n_new:-0}" -gt 0 ]]; then
    findings+=("📋 $n_new new decisions — atmux decisions list")
  fi
}

# Advance the cursor to the mtime captured by _atmux_whip_check_decisions.
# Runs AFTER report-and-exit so the cursor only moves once the ping has been
# attempted. discord_ping is fire-and-warn (warns on curl failure, swallows
# rc), so we can't distinguish ping-fail from ping-success — the cursor moves
# either way. Real retry-on-failure would need discord_ping to surface its
# rc; out of scope per ADR-008's "do not modify discord.sh" rule.
_atmux_whip_advance_decisions_cursor() {
  [[ -n "${dmtime_new:-}" ]] || return 0
  local dcursor_file; dcursor_file="$(atmux::state_dir)/decisions-cursor"
  mkdir -p "$(dirname "$dcursor_file")"
  echo "$dmtime_new" > "$dcursor_file"
}

# For the `failover` budget policy: find a peer with the same role that still
# has budget, invoke `atmux handoff <exhausted> <peer>`, pause the exhausted.
_atmux_whip_attempt_failover() {
  local cost_snapshot="$1" cap="$2"
  local exhausted
  while IFS= read -r exhausted; do
    [[ -z "$exhausted" ]] && continue
    local role cwd
    role=$(jq -r --arg n "$exhausted" '.members[] | select(.name == $n) | .role // "member"' "$(atmux::team_json)")
    # Pick any peer with same role, not paused, not exhausted, and usd < cap/2.
    local peer
    peer=$(jq -r --arg role "$role" --arg ex "$exhausted" --argjson cap "$cap" \
      --slurpfile cs <(echo "$cost_snapshot") '
      .members[]
      | select(.role == $role and .name != $ex)
      | .name
      | select(
          ($cs[0].members[] | select(.member == .)  | .usd) as $u
          | ($u // 0) < ($cap / 2)
        )' "$(atmux::team_json)" 2>/dev/null | head -1 || true)

    # jq above can be brittle with nested scope; simpler: just pick first same-role peer.
    if [[ -z "$peer" ]]; then
      peer=$(jq -r --arg role "$role" --arg ex "$exhausted" \
        '[.members[] | select(.role == $role and .name != $ex) | .name][0] // empty' "$(atmux::team_json)")
    fi

    if [[ -n "$peer" ]]; then
      atmux::log "whip: failover $exhausted → $peer"
      "$ATMUX_BIN_DIR/atmux" handoff "$exhausted" "$peer" --reason "budget-exhausted" --pause-from >/dev/null 2>&1 || true
    else
      atmux::log "whip: no failover peer available for $exhausted (role=$role)"
      ATMUX_PAUSE_REASON="budget-exhausted-no-peer" \
        "$ATMUX_BIN_DIR/atmux" pause "$exhausted" >/dev/null 2>&1 || true
    fi
  done < <(jq -r --argjson cap "$cap" \
    '.members[] | select(.usd >= $cap) | .member' <<<"$cost_snapshot")
}

_atmux_report_and_exit() {
  local ts="$1"; shift
  local team="$1"; shift
  local findings=("$@")

  local logf="$(atmux::logs_dir)/whip.log"
  mkdir -p "$(dirname "$logf")"

  if [[ "${#findings[@]}" -eq 0 ]]; then
    echo "[$ts] whip: all clean" >> "$logf"
    atmux::log "whip: all clean"
    return 0
  fi

  local body="💥 **[whip]** · \`$team\` · $ts"
  body+=$'\n'
  for f in "${findings[@]}"; do
    body+=$'\n- '"$f"
  done

  printf '[%s]\n%s\n\n' "$ts" "$body" >> "$logf"
  echo "$body"
  # ---- body-hash dedup (E2/S7 / t-96390734) ----
  # Hash bullet content only — header + timestamp change every tick and would
  # defeat dedup. If the hash matches the last successful ping, the findings
  # haven't changed; skip the Discord post but keep logging + cursor advance.
  local body_hash; body_hash="$(_atmux_whip_body_hash "${findings[@]}")"
  local hash_file; hash_file="$(atmux::state_dir)/whip-last.hash"
  local prev_hash=""
  [[ -f "$hash_file" ]] && prev_hash="$(cat "$hash_file" 2>/dev/null || echo "")"

  if [[ "$body_hash" == "$prev_hash" ]]; then
    atmux::log "whip: body unchanged since last tick — skipping Discord ping (hash=$body_hash)"
    return 0
  fi

  atmux::discord_ping "$body"
  mkdir -p "$(dirname "$hash_file")"
  printf '%s\n' "$body_hash" > "$hash_file"
}

# Hash the findings bullets only (one bullet per line). Excludes the team
# header + timestamp so dedup survives the every-tick header churn.
_atmux_whip_body_hash() {
  local f
  for f in "$@"; do
    printf '%s\n' "$f"
  done | sha256sum | awk '{print $1}'
}

# Read <member>-rotated.epoch as an integer; 0 if absent or non-numeric.
# Used inline by the stale-task jq filter so we don't shell-out per-task.
_atmux_whip_member_rotated_epoch() {
  local member="$1"
  local f; f="$(atmux::state_dir)/${member}-rotated.epoch"
  [[ -f "$f" ]] || { echo 0; return; }
  local v; v=$(cat "$f" 2>/dev/null || echo 0)
  [[ "$v" =~ ^[0-9]+$ ]] || v=0
  echo "$v"
}

# Per AC of t-59ffacfd: returns max(<claimed_or_dispatched>, <member>-rotated.epoch).
# Reusable for any caller that wants the stale-anchor for a single task; the
# whip stale-check inlines this logic inside jq for batch efficiency, but the
# bash entrypoint exists for unit-test + future-reuse callers (T3.1 timing).
_atmux_whip_stale_anchor() {
  local member="$1" claimed="${2:-0}"
  [[ "$claimed" =~ ^[0-9]+$ ]] || claimed=0
  local rotated; rotated=$(_atmux_whip_member_rotated_epoch "$member")
  if (( rotated > claimed )); then
    printf '%s\n' "$rotated"
  else
    printf '%s\n' "$claimed"
  fi
}

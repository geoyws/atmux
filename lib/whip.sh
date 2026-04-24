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

  # ---- 1. session liveness ----
  if ! atmux::tmux_session_exists; then
    findings+=("🛑 session $session is DOWN")
    _atmux_report_and_exit "$ts" "$team" "${findings[@]}"
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

    # Idle heuristic: check pane activity timestamp if tmux supports #{pane_current_command_start}.
    # Simpler: count in-progress inbox entries that are older than STALE_MIN.
    local ib="$(atmux::inbox_dir)/$name.json"
    if [[ -f "$ib" ]]; then
      local stale
      stale=$(jq --argjson now "$(atmux::now_epoch)" --argjson s "$((STALE_MIN*60))" \
        '[.inProgress[] | select(((.claimedAt // .dispatchedAt // 0) + $s) < $now)] | length' "$ib" 2>/dev/null || echo 0)
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
  atmux::discord_ping "$body"
}

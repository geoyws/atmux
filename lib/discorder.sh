#!/usr/bin/env bash
# lib/discorder.sh — `atmux discorder <subverb>` Discord ping composer.
#
# Per ADR-022: spawns alongside teams that opt into a `role: discorder`
# member. Two cron-fired subverbs:
#
#   atmux discorder progress    — 30-min digest (commits + done Tasks +
#                                 advanced Stories + new decisions). Cron
#                                 line registered by lib/cron.sh; cadence
#                                 `*/30 * * * *`.
#   atmux discorder heartbeat   — hourly state-of-team (alive members,
#                                 in-flight count, blocker count, lead
#                                 uptime). Cadence `0 * * * *`.
#
# Both compose a [whip-progress] / [whip-heartbeat] body following the
# canonical whip-prompt §6 + §7 voice (header + bulleted body + per-bullet
# emoji) and emit via atmux::discord_embed_ping. Single-instance flock per
# subverb mirrors lib/whip.sh:53–59 to defend against overlapping cron
# ticks. Read-only on kanban / git / decisions; never claims, never plans.
#
# E9/Sd t-bffe9a2e.

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"
# shellcheck source=cost.sh
. "$ATMUX_LIB_DIR/cost.sh"
# shellcheck source=whip.sh
# whip.sh defines _atmux_whip_delta_since (commits + done Tasks + advanced
# Stories renderer) which is the exact shape ADR-022 asks the progress
# digest to use. Sourcing pulls main() into scope; it's shadowed by our
# own main() below — last function-def wins, same pattern claim.sh uses
# to source kanban.sh.
. "$ATMUX_LIB_DIR/whip.sh"

main() {
  atmux::require jq flock
  atmux::require_team

  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift

  case "$sub" in
    progress)  atmux::discorder_progress  "$@" ;;
    heartbeat) atmux::discorder_heartbeat "$@" ;;
    -h|--help|"") _atmux_discorder_usage ;;
    *) atmux::die "discorder: unknown subverb '$sub' (try: progress | heartbeat)" ;;
  esac
}

_atmux_discorder_usage() {
  cat <<'EOF'
atmux discorder <subverb>

  progress    — 30-min digest: commits + done Tasks + advanced Stories +
                new decisions since last cursor tick. Updates cursor on
                successful send.
  heartbeat   — hourly state-of-team: alive members, in-flight Tasks,
                blocker count, lead uptime.

  Both subverbs are read-only on kanban / git / decisions. Cron is
  registered by lib/cron.sh when team.json declares a discorder member.
EOF
}

# ---- 30-min progress digest -----------------------------------------------

atmux::discorder_progress() {
  local lock; lock="$(atmux::state_dir)/discorder-progress.lock"
  mkdir -p "$(dirname "$lock")"
  exec 9>"$lock"
  if ! flock -n 9; then
    atmux::log "discorder progress: another instance is running — skipping tick"
    return 0
  fi

  local team ts
  team="$(atmux::team_name)"
  ts="$(atmux::now_myt)"

  # Cursor — epoch of the last successful progress tick. First run uses
  # `now - 30min` so the very first send doesn't leak hours of historic
  # commits / Tasks (cold-start burst class). State file shape:
  #   {"epoch": <unix>}
  local cursor_file; cursor_file="$(atmux::state_dir)/discorder-progress-cursor.json"
  local since_epoch
  since_epoch="$(_atmux_discorder_progress_cursor_read)"
  if [[ -z "$since_epoch" || "$since_epoch" == "0" ]]; then
    since_epoch=$(( $(atmux::now_epoch) - 1800 ))
  fi

  local sections=()

  # Bucket 1: commits + done Tasks + advanced Stories (whip's renderer
  # already handles all three with the right caps + truncation shape).
  local delta_block
  delta_block="$(_atmux_whip_delta_since "$since_epoch" 2>/dev/null || true)"
  [[ -n "$delta_block" ]] && sections+=("$delta_block")

  # Bucket 2: new decisions since cursor.
  local decisions_block
  decisions_block="$(_atmux_discorder_render_decisions_since "$since_epoch" 2>/dev/null || true)"
  [[ -n "$decisions_block" ]] && sections+=("$decisions_block")

  # Bucket 3: open p0 flags pointer (don't escalate as a separate ping
  # per ADR-022 §Hard rules — discorder mentions inline; lead owns the
  # urgent-blocker channel). Counted via `atmux flags list` which knows
  # about the resolved-state filter.
  local flags_block
  flags_block="$(_atmux_discorder_render_open_p0_flags 2>/dev/null || true)"
  [[ -n "$flags_block" ]] && sections+=("$flags_block")

  if (( ${#sections[@]} == 0 )); then
    atmux::log "discorder progress: no deltas since cursor — silent (no ping)"
    _atmux_discorder_progress_cursor_write
    return 0
  fi

  local body="📊 **[whip-progress]** · \`$team\` · $ts"
  local s
  for s in "${sections[@]}"; do
    body+=$'\n'$'\n- '"$s"
  done

  ATMUX_DISCORD_TRIGGER="${ATMUX_DISCORD_TRIGGER:-discorder-progress}" \
    atmux::discord_embed_ping "$body"

  # Advance cursor only after a successful compose+ping cycle. Mirrors
  # whip's decisions-cursor advance ordering (post-ping) so a Discord
  # outage doesn't permanently swallow a window of deltas.
  _atmux_discorder_progress_cursor_write
}

# Read .epoch from the cursor file. Empty / missing / malformed → "".
_atmux_discorder_progress_cursor_read() {
  local f; f="$(atmux::state_dir)/discorder-progress-cursor.json"
  [[ -f "$f" ]] || { printf ''; return 0; }
  local v
  v=$(jq -r '.epoch // empty' "$f" 2>/dev/null || true)
  [[ "$v" =~ ^[0-9]+$ ]] || v=""
  printf '%s' "$v"
}

# Write {"epoch": <now>} atomically.
_atmux_discorder_progress_cursor_write() {
  local f; f="$(atmux::state_dir)/discorder-progress-cursor.json"
  mkdir -p "$(dirname "$f")"
  local now; now="$(atmux::now_epoch)"
  jq -n --argjson e "$now" '{epoch: $e}' > "$f.tmp" && mv "$f.tmp" "$f"
}

# Compose a sub-block listing decisions added since `$1` (epoch). Uses
# `atmux decisions list --since <epoch> --json` which already knows how
# to walk decisions.md per the decisions verb's own parser. Empty when
# zero new decisions in window.
_atmux_discorder_render_decisions_since() {
  local since="$1"
  [[ "$since" =~ ^[0-9]+$ ]] || return 0

  local json
  json=$("$ATMUX_BIN_DIR/atmux" decisions list --since "$since" --json 2>/dev/null || echo '[]')
  jq -e . <<<"$json" >/dev/null 2>&1 || return 0

  local n
  n=$(jq -r 'length' <<<"$json" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] && (( n > 0 )) || return 0

  local out="📋 **Decisions** ($n new):"
  local emoji_map='{"low":"🟢","medium":"🟡","high":"🔴"}'
  while IFS= read -r line; do
    [[ -n "$line" ]] && out+=$'\n  - '"$line"
  done < <(jq -r --argjson em "$emoji_map" \
             '.[:5] | .[] | "\($em[.reversibility] // "⚪") \(.id) \(.question) → \(.default)"' \
             <<<"$json")
  if (( n > 5 )); then
    out+=$'\n  - +'$((n - 5))" more — atmux decisions digest"
  fi
  printf '%s' "$out"
}

# Inline mention of open p0 flags — deferred to lead for the urgent ping.
# Empty when zero open p0 flags (status=open + severity=p0).
_atmux_discorder_render_open_p0_flags() {
  local n
  n=$("$ATMUX_BIN_DIR/atmux" flags list --status open --severity p0 --json 2>/dev/null \
        | jq -r 'length' 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] && (( n > 0 )) || return 0
  printf '🛑 **Blockers**: %d open p0 — atmux flag list (lead owns urgent ping)' "$n"
}

# ---- hourly heartbeat -----------------------------------------------------

atmux::discorder_heartbeat() {
  local lock; lock="$(atmux::state_dir)/discorder-heartbeat.lock"
  mkdir -p "$(dirname "$lock")"
  exec 9>"$lock"
  if ! flock -n 9; then
    atmux::log "discorder heartbeat: another instance is running — skipping tick"
    return 0
  fi

  local team ts
  team="$(atmux::team_name)"
  ts="$(atmux::now_myt)"

  local alive_count member_count alive_block in_flight_block blocked_block uptime_block

  # Members alive — pane present + the declared TUI is the foreground
  # process command. Mirrors lib/whip.sh's per-member liveness probe so
  # the heartbeat reads the same state as whip's findings would.
  alive_block="$(_atmux_discorder_render_alive)"
  alive_count="$(_atmux_discorder_count_alive)"
  member_count="$(jq -r '.members | length' "$(atmux::team_json)" 2>/dev/null || echo 0)"

  in_flight_block="$(_atmux_discorder_render_in_flight)"
  blocked_block="$(_atmux_discorder_render_blocked)"
  uptime_block="$(_atmux_discorder_render_lead_uptime)"

  local body="💓 **[whip-heartbeat]** · \`$team\` · $ts"
  body+=$'\n'$'\n🎯 **Team state**:'
  body+=$'\n- 🟢 alive: '"$alive_count/$member_count members"
  [[ -n "$alive_block"     ]] && body+=$'\n'"$alive_block"
  [[ -n "$in_flight_block" ]] && body+=$'\n'"$in_flight_block"
  [[ -n "$blocked_block"   ]] && body+=$'\n'"$blocked_block"
  [[ -n "$uptime_block"    ]] && body+=$'\n'"$uptime_block"

  ATMUX_DISCORD_TRIGGER="${ATMUX_DISCORD_TRIGGER:-discorder-heartbeat}" \
    atmux::discord_embed_ping "$body"
}

# Echo per-member liveness bullets (one bullet per non-alive member with
# the reason). Empty when every member is alive.
_atmux_discorder_render_alive() {
  atmux::tmux_session_exists || { printf -- '- 🔴 session DOWN — see whip log'; return 0; }

  local out=""
  local mj; mj="$(jq -c '.members[]' "$(atmux::team_json)" 2>/dev/null || true)"
  local m name role tui pane_cmd want
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    name=$(jq -r '.name' <<<"$m")
    role=$(jq -r '.role // "member"' <<<"$m")
    tui=$(jq -r '.tui // "claude"' <<<"$m")

    if ! atmux::tmux_window_exists "$name"; then
      out+=$'\n- 🔴 '"\`$name\` ($role): window missing"
      continue
    fi
    pane_cmd=$(tmux list-panes -t "$(atmux::tmux_target "$name")" -F '#{pane_current_command}' 2>/dev/null | head -1)
    want=""
    case "$tui" in
      claude)   want="claude" ;;
      opencode) want="opencode" ;;
      kimi)     want="kimi" ;;
      cursor)   want="cursor-agent" ;;
    esac
    if [[ -n "$want" && "$pane_cmd" != "$want" ]]; then
      out+=$'\n- 🟡 '"\`$name\` ($role): pane is \`$pane_cmd\` (TUI not running)"
    fi
  done <<<"$mj"

  printf '%s' "$out"
}

# Count members whose pane is present + running the declared TUI.
_atmux_discorder_count_alive() {
  atmux::tmux_session_exists || { printf '0'; return 0; }

  local n=0
  local mj; mj="$(jq -c '.members[]' "$(atmux::team_json)" 2>/dev/null || true)"
  local m name tui pane_cmd want
  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    name=$(jq -r '.name' <<<"$m")
    tui=$(jq -r '.tui // "claude"' <<<"$m")
    atmux::tmux_window_exists "$name" || continue
    pane_cmd=$(tmux list-panes -t "$(atmux::tmux_target "$name")" -F '#{pane_current_command}' 2>/dev/null | head -1)
    want=""
    case "$tui" in
      claude)   want="claude" ;;
      opencode) want="opencode" ;;
      kimi)     want="kimi" ;;
      cursor)   want="cursor-agent" ;;
    esac
    if [[ -z "$want" || "$pane_cmd" == "$want" ]]; then
      n=$((n + 1))
    fi
  done <<<"$mj"
  printf '%s' "$n"
}

# Single-bullet line: "📊 in-flight: N task(s)". Empty when N=0 (no need
# to mention a quiet kanban).
_atmux_discorder_render_in_flight() {
  local k; k="$(atmux::kanban_json 2>/dev/null || true)"
  [[ -f "$k" ]] || return 0
  local n
  n=$(jq -r '[.tasks[]? | select(.status == "in-progress")] | length' "$k" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] && (( n > 0 )) || return 0
  printf -- '- 📊 in-flight: %d task(s)' "$n"
}

# Single-bullet line: "🛑 blocked: N task(s)". Empty when N=0.
_atmux_discorder_render_blocked() {
  local k; k="$(atmux::kanban_json 2>/dev/null || true)"
  [[ -f "$k" ]] || return 0
  local n
  n=$(jq -r '[.tasks[]? | select(.status == "blocked")] | length' "$k" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] && (( n > 0 )) || return 0
  printf -- '- 🛑 blocked: %d task(s)' "$n"
}

# Lead uptime bullet — anchored at max(<lead>-rotated.epoch,
# session-start.txt). Empty when neither anchor exists (cold-start, no
# session yet). Format: compact human duration per CLAUDE.md §Duration.
_atmux_discorder_render_lead_uptime() {
  local lead_name
  lead_name=$(jq -r '.members[]? | select(.role == "team-lead") | .name' \
                "$(atmux::team_json)" 2>/dev/null | head -1 || true)
  [[ -n "$lead_name" ]] || return 0

  local sd; sd="$(atmux::state_dir)"
  local rotated=0 sess=0
  if [[ -f "$sd/${lead_name}-rotated.epoch" ]]; then
    rotated=$(cat "$sd/${lead_name}-rotated.epoch" 2>/dev/null || echo 0)
    [[ "$rotated" =~ ^[0-9]+$ ]] || rotated=0
  fi
  if [[ -f "$sd/session-start.txt" ]]; then
    sess=$(cat "$sd/session-start.txt" 2>/dev/null || echo 0)
    [[ "$sess" =~ ^[0-9]+$ ]] || sess=0
  fi
  local anchor=$(( rotated > sess ? rotated : sess ))
  (( anchor > 0 )) || return 0

  local now; now="$(atmux::now_epoch)"
  local elapsed=$(( now - anchor ))
  (( elapsed > 0 )) || return 0

  local human
  if (( elapsed < 3600 )); then
    human=$(( elapsed / 60 ))min
  else
    local h=$(( elapsed / 3600 )) m=$(( (elapsed % 3600) / 60 ))
    if (( m == 0 )); then human="${h}h"; else human="${h}h${m}m"; fi
  fi
  printf -- '- ♻️ lead uptime: %s (`%s`)' "$human" "$lead_name"
}

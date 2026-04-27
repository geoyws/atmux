#!/usr/bin/env bash
# atmux report — 30-min progress digest. Intended for cron:
#
#   */30 * * * * cd /path/to/project && /usr/local/bin/atmux report >> .atmux/logs/report.log 2>&1
#
# Generates + prints + (optionally) pings Discord with: shipped tasks since last
# report, in-progress counts per member, blockers, open driver-inbox asks.

# shellcheck source=discord.sh
. "$ATMUX_LIB_DIR/discord.sh"

main() {
  atmux::require jq
  atmux::require_team

  local push_discord=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-discord) push_discord=0; shift ;;
      *) atmux::die "report: unknown arg: $1" ;;
    esac
  done

  local team; team="$(atmux::team_name)"
  local ts; ts="$(atmux::now_myt)"

  local last_file="$(atmux::state_dir)/last-report.epoch"
  local last; last=$(cat "$last_file" 2>/dev/null || echo 0)
  local now; now=$(atmux::now_epoch)

  local k; k="$(atmux::kanban_json)"

  local shipped_rows=""
  if [[ -f "$k" ]]; then
    shipped_rows=$(jq -r --argjson last "$last" \
      '.tasks[] | select(.status=="done" and (.completedAt // 0) > $last)
        | "  ✅ \(.id) · \(.owner // "?") · \(.subject)"' "$k")
  fi
  local shipped_n; shipped_n=$(echo -n "$shipped_rows" | grep -c '^' || true)

  # In-progress per member.
  local ip_rows=""
  if [[ -f "$k" ]]; then
    ip_rows=$(jq -r '.tasks[] | select(.status=="in-progress")
      | "  🟡 \(.id) · \(.owner // "?") · \(.subject)"' "$k")
  fi

  local blocked_rows=""
  if [[ -f "$k" ]]; then
    blocked_rows=$(jq -r '.tasks[] | select(.status=="blocked")
      | "  🛑 \(.id) · \(.owner // "?") · \(.subject)"' "$k")
  fi

  local di; di="$(atmux::driver_inbox)"
  local open_asks=""
  if [[ -f "$di" ]]; then
    open_asks=$(awk '/^## Open/{flag=1;next}/^## /{flag=0}flag && /^- /' "$di")
  fi

  local body="📊 **[atmux-report]** · \`$team\` · $ts"
  body+=$'\n\n🏗️ **Shipped** (since last report): '"$shipped_n"
  if [[ -n "$shipped_rows" ]]; then
    body+=$'\n'"$shipped_rows"
  fi
  body+=$'\n\n🟡 **In-progress**'
  if [[ -n "$ip_rows" ]]; then
    body+=$'\n'"$ip_rows"
  else
    body+=$'\n  (none)'
  fi
  if [[ -n "$blocked_rows" ]]; then
    body+=$'\n\n🛑 **Blocked**'$'\n'"$blocked_rows"
  fi
  if [[ -n "$open_asks" ]]; then
    body+=$'\n\n🙏 **Open driver-inbox asks**'$'\n'"$open_asks"
  fi

  echo "$body"
  if [[ "$push_discord" -eq 1 ]]; then
    atmux::discord_embed_ping "$body"
  fi

  echo "$now" > "$last_file"
}

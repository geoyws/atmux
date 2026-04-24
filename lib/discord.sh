#!/usr/bin/env bash
# lib/discord.sh — shared Discord webhook pinger. No-ops if $ATMUX_DISCORD_WEBHOOK
# is unset (so whip/report runs are never blocked on escalation being configured).

# atmux::discord_ping "<markdown-body>"
atmux::discord_ping() {
  local msg="$1"
  local url="${ATMUX_DISCORD_WEBHOOK:-${DISCORD_WHIP_WEBHOOK:-}}"
  if [[ -z "$url" ]]; then
    atmux::log "discord: ATMUX_DISCORD_WEBHOOK not set — skipping"
    return 0
  fi
  atmux::require curl jq
  curl -fsS -H 'Content-Type: application/json' \
    -d "$(jq -n --arg c "$msg" '{content:$c}')" \
    "$url" >/dev/null || atmux::warn "discord: ping failed"
}

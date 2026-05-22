#!/usr/bin/env bash
# Shared Discord-webhook pinger for the /whip skill.
#
# Reads the webhook URL from the DISCORD_WEBHOOK_URL env var, which the
# coordination plugin resolves from its `userConfig` (keychain-backed).
#
# Gracefully no-ops (exit 0) if the webhook isn't configured, so whip runs
# are never blocked on escalation being set up.
set -euo pipefail

msg="${1:?usage: ping-discord.sh <message>}"

url="${DISCORD_WEBHOOK_URL:-${DISCORD_WHIP_WEBHOOK:-}}"

if [[ -z "$url" ]]; then
  echo "whip: DISCORD_WEBHOOK_URL not set — skipping escalation" >&2
  exit 0
fi

curl -fsS -H 'Content-Type: application/json' \
  -d "$(jq -n --arg c "$msg" '{content:$c}')" \
  "$url" >/dev/null

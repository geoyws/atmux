#!/usr/bin/env bash
# lib/discord.sh — shared Discord webhook pinger. No-ops if $ATMUX_DISCORD_WEBHOOK
# is unset (so whip/report runs are never blocked on escalation being configured).
#
# Two senders:
#   atmux::discord_ping <body>        — plain {content:<body>} shape.
#   atmux::discord_embed_ping <body>  — Discord webhook embed shape with per-team
#                                       color (hash-derived or .discord.color
#                                       override) and emoji glyph in the title.
#
# ATMUX_DISCORD_PLAINTEXT=1 forces the embed sender to fall back to the plain
# content shape — preserves test fixtures that assert on `.content` and gives
# operators a runtime kill-switch if a Discord-side embed regression appears.
#
# Per ADR-019.

# Catppuccin-Frappe-aligned 16-color palette. Index = sha256(team-name) first
# byte mod 16. Order is locked: a one-line append adds a new color, but
# reordering or removing shifts every existing team's auto-color (palette is
# fixed at decompose time per ADR-019 §C). Hex values are the canonical
# Catppuccin Frappe definitions.
ATMUX_DISCORD_PALETTE_NAMES=(
  rosewater flamingo pink     mauve    red     maroon  peach    yellow
  green     teal     sky      sapphire blue    lavender surface2 overlay2
)
ATMUX_DISCORD_PALETTE_HEX=(
  f2d5cf    eebebe   f4b8e4   ca9ee6   e78284  ea999c  ef9f76   e5c890
  a6d189    81c8be   99d1db   85c1dc   8caaee  babbf1  626880   949cbb
)

# atmux::discord_ping <body>
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

# atmux::discord_embed_ping <body>
# Resolves color + emoji from team.json (or hash defaults) and posts an embed.
atmux::discord_embed_ping() {
  local msg="$1"

  if [[ "${ATMUX_DISCORD_PLAINTEXT:-0}" == "1" ]]; then
    atmux::discord_ping "$msg"
    return 0
  fi

  local url="${ATMUX_DISCORD_WEBHOOK:-${DISCORD_WHIP_WEBHOOK:-}}"
  if [[ -z "$url" ]]; then
    atmux::log "discord: ATMUX_DISCORD_WEBHOOK not set — skipping"
    return 0
  fi
  atmux::require curl jq

  local team_name="" override_color="" override_emoji=""
  local tj=""
  if declare -F atmux::team_json >/dev/null 2>&1; then
    tj="$(atmux::team_json 2>/dev/null || true)"
  fi
  if [[ -n "$tj" && -f "$tj" ]]; then
    team_name="$(jq -r '.name // empty' "$tj" 2>/dev/null || true)"
    override_color="$(jq -r '.discord.color // empty' "$tj" 2>/dev/null || true)"
    override_emoji="$(jq -r '.discord.emoji // empty' "$tj" 2>/dev/null || true)"
  fi
  [[ -z "$team_name" || "$team_name" == "null" ]] && team_name="atmux"

  local color_hex
  if [[ -n "$override_color" && "$override_color" != "null" ]]; then
    color_hex="${override_color#\#}"
  else
    color_hex="$(_atmux_discord_hash_color "$team_name")"
  fi
  local color_dec=$((16#${color_hex}))

  local emoji="$override_emoji"
  [[ -z "$emoji" || "$emoji" == "null" ]] && emoji="🤖"

  local title="${emoji} ${team_name}"
  local payload
  payload="$(jq -n \
    --argjson color "$color_dec" \
    --arg     title "$title" \
    --arg     desc  "$msg" \
    '{embeds:[{color:$color, title:$title, description:$desc}]}')"

  curl -fsS -H 'Content-Type: application/json' \
    -d "$payload" \
    "$url" >/dev/null || atmux::warn "discord: embed ping failed"
}

# sha256 first byte mod 16 → palette hex. macOS shasum -a 256 fallback.
_atmux_discord_hash_color() {
  local name="$1"
  local hash byte idx
  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(printf '%s' "$name" | sha256sum | cut -c1-2)"
  else
    hash="$(printf '%s' "$name" | shasum -a 256 | cut -c1-2)"
  fi
  byte=$((16#${hash}))
  idx=$(( byte % 16 ))
  printf '%s\n' "${ATMUX_DISCORD_PALETTE_HEX[$idx]}"
}

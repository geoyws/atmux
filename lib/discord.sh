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
    _atmux_discord_log skip "" 0 "" "ATMUX_DISCORD_WEBHOOK not set" "$msg" "" 0
    return 0
  fi
  atmux::require curl jq
  local payload; payload="$(jq -n --arg c "$msg" '{content:$c}')"
  _atmux_discord_send_with_log "plain" "$msg" "$payload" "$url"
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
    _atmux_discord_log skip "" 0 "" "ATMUX_DISCORD_WEBHOOK not set" "$msg" "" 0
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

  _atmux_discord_send_with_log "embed" "$msg" "$payload" "$url"
}

# Internal — issues the actual curl POST, captures status + body + duration,
# emits a jsonl record to .atmux/logs/discord.log, and surfaces the same
# warn line existing callers expect on failure. The caller-set
# $ATMUX_DISCORD_TRIGGER (whip / report / decisions / dispatch / etc.)
# is recorded as the trigger field; defaults to "unknown".
#
# Args: <shape> <body> <payload> <url>
# Globals consumed: ATMUX_DISCORD_TRIGGER (optional, default "unknown")
_atmux_discord_send_with_log() {
  local shape="$1" body="$2" payload="$3" url="$4"
  local trigger="${ATMUX_DISCORD_TRIGGER:-unknown}"

  local started; started="$(date +%s%N 2>/dev/null || date +%s)"
  local resp_file; resp_file="$(mktemp 2>/dev/null || echo "/tmp/atmux-discord-resp.$$")"
  local http_status duration_ms
  http_status="$(curl -sS -o "$resp_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --max-time 10 \
    -d "$payload" \
    "$url" 2>>"$resp_file" || echo 000)"
  local ended; ended="$(date +%s%N 2>/dev/null || date +%s)"
  if [[ "$started" =~ ^[0-9]{15,}$ ]]; then
    duration_ms=$(( (ended - started) / 1000000 ))
  else
    duration_ms=$(( (ended - started) * 1000 ))
  fi

  local resp_body; resp_body="$(head -c 500 "$resp_file" 2>/dev/null || true)"
  rm -f "$resp_file" 2>/dev/null

  local result="ok"
  if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    result="fail"
    atmux::warn "discord: $shape ping failed (HTTP $http_status)"
  fi

  _atmux_discord_log "$result" "$shape" "$http_status" "$trigger" \
    "${resp_body//$'\n'/\\n}" "$body" "$payload" "$duration_ms"
}

# Append a jsonl record to .atmux/logs/discord.log. All-failure-tolerant
# (silent no-op when .atmux/ unavailable, jq missing, atmux::dir not
# resolved). Contract: never breaks the calling discord_*_ping.
#
# Args: <result> <shape> <http_status> <trigger> <error_or_resp> <body> <payload> <duration_ms>
_atmux_discord_log() {
  local result="$1" shape="$2" http_status="$3" trigger="$4"
  local err_or_resp="$5" body="$6" payload="$7" duration_ms="$8"

  command -v jq >/dev/null 2>&1 || return 0
  declare -F atmux::dir >/dev/null 2>&1 || return 0

  local logdir log
  logdir="$(atmux::dir 2>/dev/null)/logs" || return 0
  [[ -n "$logdir" ]] || return 0
  mkdir -p "$logdir" 2>/dev/null || return 0
  log="$logdir/discord.log"

  local ts
  ts="$(TZ='Asia/Kuala_Lumpur' date '+%Y-%m-%dT%H:%M:%S+08')"

  local team_name=""
  if declare -F atmux::team_name >/dev/null 2>&1; then
    team_name="$(atmux::team_name 2>/dev/null || echo unknown)"
  fi

  # Truncate body / payload preview at 500 bytes to keep the log
  # line-oriented and greppable. body_sha256 lets you correlate the
  # full content with whip.log / report.log entries.
  local body_preview="${body:0:500}"
  local payload_preview="${payload:0:500}"

  local body_sha=""
  if command -v sha256sum >/dev/null 2>&1; then
    body_sha="$(printf '%s' "$body" | sha256sum | cut -c1-16)"
  fi

  jq -nc \
    --arg ts            "$ts" \
    --arg trigger       "$trigger" \
    --arg team          "$team_name" \
    --arg shape         "$shape" \
    --arg result        "$result" \
    --arg http_status   "$http_status" \
    --arg duration_ms   "$duration_ms" \
    --arg body_sha      "$body_sha" \
    --arg body_preview  "$body_preview" \
    --arg payload_pre   "$payload_preview" \
    --arg err_or_resp   "$err_or_resp" \
    --arg payload_bytes "${#payload}" \
    '{
      ts: $ts,
      trigger: $trigger,
      team: $team,
      shape: $shape,
      result: $result,
      http_status: ($http_status | tonumber? // 0),
      duration_ms: ($duration_ms | tonumber? // 0),
      payload_bytes: ($payload_bytes | tonumber? // 0),
      body_sha256_16: $body_sha,
      body_preview: $body_preview,
      payload_preview: $payload_pre,
      response_or_error: $err_or_resp
    }' >> "$log" 2>/dev/null || true
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

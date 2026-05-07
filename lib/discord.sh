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

# _atmux_whip_audit_format <findings_json> <fix_outcomes_json>
#
# Per ADR-040 §Discord template (E14/Sd t-361003b9). Renders the
# `[whip-audit]` body — three bulleted sections, each omitted entirely
# when empty (per ADR-040 empty-tick discipline). Header
# (`🛡️ **[whip-audit]** · \`<team>\` · HH:MM MYT`) is composed by the
# caller — this helper has no team / timestamp context.
#
# Inputs are JSON arrays:
#   findings_json     — per ADR-038 emit schema:
#                       {class, severity, team, detail, fix_hint, ...}
#   fix_outcomes_json — rows from this tick's audit-fix.log delta:
#                       {class, result, action, detail}
#
# Routing (per ADR-040 examples + tests/unit/whip_audit.bats):
#   D, E, F + matching ok outcome → 🔧 Auto-corrected (detail only)
#   A, B                          → ⚠️ Surfaced — driver action
#                                      (detail + `· fire: <fix_hint>`)
#   C + everything else           → 🛑 Refused (detail + `· manual: <fix_hint>`)
#
# Bullet shape: `<emoji> class <X> · <detail>[ · fire|manual: <fix_hint>]`.
# Returns 0 always; emits empty stdout when no section has bullets.
_atmux_whip_audit_format() {
  local findings_json="${1:-[]}" fix_outcomes_json="${2:-[]}"
  command -v jq >/dev/null 2>&1 || return 0
  jq -n -r \
    --argjson f "$findings_json" \
    --argjson o "$fix_outcomes_json" '
    def fixed_classes:
      [$o[] | select(.result == "ok") | .class] | unique;
    def auto: [
      $f[] | select(.class as $c | $c | IN("D","E","F"))
           | select(.class as $c | (fixed_classes | index($c)))
           | "🛠️ class \(.class) · \(.detail)"
    ];
    def surf: [
      $f[] | select(.class as $c | $c | IN("A","B"))
           | "⚠️ class \(.class) · \(.detail) · fire: \(.fix_hint)"
    ];
    def refsd: [
      $f[] | select(.class == "C")
           | "🛑 class \(.class) · \(.detail) · manual: \(.fix_hint)"
    ];
    [
      ( auto  | if length>0 then "🔧 **Auto-corrected** (low-blast):\n" + join("\n") else "" end ),
      ( surf  | if length>0 then "⚠️ **Surfaced — driver action**:\n" + join("\n") else "" end ),
      ( refsd | if length>0 then "🛑 **Refused** (high-blast, manual only):\n" + join("\n") else "" end )
    ] | map(select(length > 0)) | join("\n\n")
  '
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

# _atmux_chunk_for_embed <header> <max_body> <max_chunks> <truncation_marker> <section1> [section2] ...
#
# Shared chunker for Discord embed renders. Allocates an ordered list of
# section blocks into 1..max_chunks NUL-separated body chunks, each fitting
# within (max_body − header overhead) bytes.
#
# Behavior:
# - chunks[0] is the REQUIRED block — section1 always lands there.
# - Subsequent sections (section2..N) pack greedily into chunks[1..max_chunks]:
#     * append to the current open chunk if {current + "\n\n" + section} fits;
#     * else flush the open chunk to chunks[] and start a new chunk holding
#       the section.
# - Per-section atomic — a section is never split across chunks. A section
#   bigger than body_budget on its own gets dropped.
# - Over-cap — once chunks[] reaches max_chunks, remaining sections drop.
# - On any drop (cap-hit or oversized-section), the supplied
#   truncation_marker is appended to the LAST surviving chunk (joined with
#   a "\n\n" separator). Pass empty marker to skip the append.
# - Byte budget = max_body − (#header + 16 slack for " [N/M]" tag + newlines).
#   Floored to 100 to avoid degenerate inputs producing zero-budget loops.
#
# The header parameter exists ONLY for byte-budget overhead — emitted chunks
# are body-only. Caller composes "<header>\n\n<chunk>" per message and adds
# any [N/M] tag to the header itself.
#
# Output: emits each chunk as a NUL-terminated string on stdout. Caller reads
# via `mapfile -d '' chunks < <(_atmux_chunk_for_embed ...)`.
#
# Returns 0 always; emits nothing when section list is empty.
_atmux_chunk_for_embed() {
  local header="${1:-}" max_body="${2:-1900}" max_chunks="${3:-5}"
  local marker="${4:-}"
  shift 4 || shift $#
  local sections=("$@")

  local n=${#sections[@]}
  (( n > 0 )) || return 0

  local hdr_overhead=$(( ${#header} + 16 ))
  local body_budget=$(( max_body - hdr_overhead ))
  (( body_budget < 100 )) && body_budget=100

  # Single-chunk fast path: every non-empty section concatenated fits.
  local single="${sections[0]}"
  local i
  for (( i=1; i<n; i++ )); do
    [[ -n "${sections[i]}" ]] && single+=$'\n\n'"${sections[i]}"
  done
  if (( ${#single} <= body_budget )); then
    printf '%s\0' "$single"
    return 0
  fi

  # Multi-chunk: chunks[0] = required block (sections[0]), rest pack greedily.
  local chunks=("${sections[0]}")
  local current=""
  local skipped=0

  for (( i=1; i<n; i++ )); do
    local sec="${sections[i]}"
    [[ -z "$sec" ]] && continue
    local candidate
    if [[ -z "$current" ]]; then
      candidate="$sec"
    else
      candidate="$current"$'\n\n'"$sec"
    fi
    if (( ${#candidate} <= body_budget )); then
      current="$candidate"
      continue
    fi
    if [[ -n "$current" ]]; then
      chunks+=("$current")
      current=""
    fi
    if (( ${#chunks[@]} >= max_chunks )); then
      skipped=$((skipped + 1))
      continue
    fi
    if (( ${#sec} <= body_budget )); then
      current="$sec"
    else
      skipped=$((skipped + 1))
    fi
  done
  [[ -n "$current" ]] && chunks+=("$current")

  if (( skipped > 0 )) && [[ -n "$marker" ]]; then
    local last=$(( ${#chunks[@]} - 1 ))
    chunks[last]="${chunks[last]}"$'\n\n'"$marker"
  fi

  local total=${#chunks[@]}
  for (( i=0; i<total; i++ )); do
    printf '%s\0' "${chunks[i]}"
  done
}

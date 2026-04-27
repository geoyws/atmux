#!/usr/bin/env bats
# Unit tests for the per-team Discord palette + emoji + embed payload shape
# (ADR-019). Covers: hash determinism, override paths, plaintext fallback,
# embed payload shape, and palette-mod-16 distribution.
#
# Pattern matches tests/unit/decisions.bats — PATH-prepend mock-curl that
# captures `-d` argv to a NUL-delimited tmpfile. Sandbox via the standard
# atmux_setup_sandbox helper.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name palette-test >/dev/null

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
# mock curl for discord_palette.bats — capture argv to $ATMUX_TEST_TMP/curl-args.bin
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"
  export PATH="$ATMUX_MOCK_BIN:$PATH"

  # Webhook env so atmux::discord_embed_ping doesn't short-circuit on
  # "no webhook configured." Mock curl captures the payload regardless.
  export ATMUX_DISCORD_WEBHOOK="https://example.invalid/mock"
}

teardown() {
  atmux_teardown_sandbox
}

# Recover the most recent mock-curl `-d <payload>` bytes from the capture
# file. Returns empty string if no curl invocation has happened.
_curl_last_payload() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"} prev=="-d"{last=$0} {prev=$0} END{print last}' "$f"
}

# Reset the capture file between assertions inside one @test.
_clear_curl_capture() {
  : > "$ATMUX_TEST_TMP/curl-args.bin"
}

# Run lib/discord.sh's hash helper directly so we can assert on its output
# without going through team.json + curl.
_hash_color_for() {
  local team="$1"
  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    _atmux_discord_hash_color "$1"
  ' _ "$team"
}

# ---------- (1) Hash determinism ----------

@test "palette: hash is deterministic — same team name yields same hex across invocations" {
  local a b
  a="$(_hash_color_for "atmux-kanban")"
  b="$(_hash_color_for "atmux-kanban")"
  [ -n "$a" ]
  [ "$a" = "$b" ]
}

@test "palette: hash is deterministic — multiple teams keep their distinct hex stable" {
  local a1 a2 s1 s2
  a1="$(_hash_color_for "atmux-kanban")"
  s1="$(_hash_color_for "sopx-mvp")"
  a2="$(_hash_color_for "atmux-kanban")"
  s2="$(_hash_color_for "sopx-mvp")"
  [ "$a1" = "$a2" ]
  [ "$s1" = "$s2" ]
}

@test "palette: hex result is a 6-char palette entry (one of the 16 locked colors)" {
  local hex
  hex="$(_hash_color_for "any-team-name-here")"
  [[ "$hex" =~ ^[0-9a-f]{6}$ ]]
  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    for x in "${ATMUX_DISCORD_PALETTE_HEX[@]}"; do
      [[ "$x" == "'"$hex"'" ]] && exit 0
    done
    exit 1
  '
}

@test "palette: sha256sum and shasum -a 256 produce identical first-byte (cross-platform parity)" {
  if ! command -v sha256sum >/dev/null 2>&1; then
    skip "sha256sum not available — Linux-stock check; the macOS branch is exercised when sha256sum is absent"
  fi
  if ! command -v shasum >/dev/null 2>&1; then
    skip "shasum not installed — macOS-fallback check needs both tools to compare"
  fi
  local a b
  a="$(printf '%s' "atmux-kanban" | sha256sum    | cut -c1-2)"
  b="$(printf '%s' "atmux-kanban" | shasum -a 256 | cut -c1-2)"
  [ "$a" = "$b" ]
}

# ---------- (2) Per-team color override ----------

@test "palette: team.json:.discord.color overrides hash + decimal-converts correctly" {
  jq '.discord.color = "#abc123"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "test override"
  '

  local payload color_dec
  payload="$(_curl_last_payload)"
  [ -n "$payload" ]
  color_dec="$(jq -r '.embeds[0].color' <<<"$payload")"
  # 0xabc123 == 11256099
  [ "$color_dec" = "11256099" ]
}

@test "palette: override accepts color without leading #" {
  jq '.discord.color = "abc123"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "test override no hash"
  '
  local color_dec
  color_dec="$(jq -r '.embeds[0].color' <<<"$(_curl_last_payload)")"
  [ "$color_dec" = "11256099" ]
}

# ---------- (3) Per-team emoji override ----------

@test "palette: team.json:.discord.emoji overrides default 🤖" {
  jq '.discord.emoji = "🌊"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "wave wave"
  '

  local title
  title="$(jq -r '.embeds[0].title' <<<"$(_curl_last_payload)")"
  [[ "$title" == "🌊 palette-test" ]]
}

@test "palette: default emoji is 🤖 when override absent" {
  # team.example.json baked-in discord.emoji ('🌊') is the override path;
  # to test the default fallback we strip the block first.
  jq 'del(.discord)' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "no emoji override"
  '
  local title
  title="$(jq -r '.embeds[0].title' <<<"$(_curl_last_payload)")"
  [[ "$title" == "🤖 palette-test" ]]
}

# ---------- (4) Embed payload shape ----------

@test "palette: embed payload parses as JSON with .embeds[0].{color,title,description}" {
  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "shape check body"
  '
  local payload
  payload="$(_curl_last_payload)"
  jq -e . <<<"$payload" >/dev/null
  local color_type title desc
  color_type="$(jq -r '.embeds[0].color | type' <<<"$payload")"
  title="$(jq -r '.embeds[0].title' <<<"$payload")"
  desc="$(jq -r '.embeds[0].description' <<<"$payload")"
  [ "$color_type" = "number" ]
  [ -n "$title" ]
  [ "$desc" = "shape check body" ]
}

@test "palette: hash-derived color matches palette entry once decoded" {
  # team.example.json bakes in .discord.color override; strip to exercise
  # the hash route.
  jq 'del(.discord)' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "hash route"
  '
  local payload color_dec hex_actual hex_expected
  payload="$(_curl_last_payload)"
  color_dec="$(jq -r '.embeds[0].color' <<<"$payload")"
  hex_actual="$(printf '%06x' "$color_dec")"
  hex_expected="$(_hash_color_for "palette-test")"
  [ "$hex_actual" = "$hex_expected" ]
}

# ---------- (5) ATMUX_DISCORD_PLAINTEXT=1 fallback ----------

@test "palette: ATMUX_DISCORD_PLAINTEXT=1 emits .content shape (not .embeds)" {
  ATMUX_DISCORD_PLAINTEXT=1 bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/discord.sh"
    atmux::discord_embed_ping "plaintext kill switch"
  '
  local payload content embeds
  payload="$(_curl_last_payload)"
  jq -e . <<<"$payload" >/dev/null
  content="$(jq -r '.content // empty' <<<"$payload")"
  embeds="$(jq -r '.embeds // empty' <<<"$payload")"
  [ "$content" = "plaintext kill switch" ]
  [ -z "$embeds" ]
}

# ---------- (6) Hash mod-16 distribution ----------

@test "palette: 32 distinct team names cover ≥8 distinct palette indices (no pathological clustering)" {
  local i name hex
  declare -A seen
  for i in $(seq 1 32); do
    name="team-distribution-$i"
    hex="$(_hash_color_for "$name")"
    seen[$hex]=1
  done
  local distinct=${#seen[@]}
  [ "$distinct" -ge 8 ] || { echo "only ${distinct} distinct palette entries across 32 names — pathological clustering"; return 1; }
}

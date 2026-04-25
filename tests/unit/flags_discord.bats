#!/usr/bin/env bats
# Unit tests for `atmux flags add` Discord gating (E4/S4 / t-5b96b9ee).
# Per ADR-008 + the t-5b96b9ee ship: only severity=p0 triggers a Discord
# ping; p1/p2 stay silent (recorded in flags.md, no webhook hit). Mirrors
# the decisions reversibility-gate pattern in tests/unit/decisions_gating.bats.
#
# Mocks curl on PATH; counts invocations; captures payload bodies for
# template-content assertions.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name f >/dev/null

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"

  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
}

teardown() {
  atmux_teardown_sandbox
}

_curl_calls() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

# Pull the .content field from the captured curl --data-raw / --data /-d JSON.
_curl_payload_content() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"; pick=0} {
    if (pick) { print; pick=0; next }
    if ($0=="--data-raw" || $0=="-d" || $0=="--data") pick=1
  }' "$f" | jq -r '.content // empty' 2>/dev/null
}

# ---------- gate by severity ----------

@test "flags_discord: severity=p0 + webhook ⇒ exactly 1 POST with [atmux-flags] template" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "stack wedged" \
    --severity p0 --needs unblock --as devops
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "1" ]
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "[atmux-flags]" ]]
  [[ "$body" =~ "🛑 devops: stack wedged" ]]
  [[ "$body" =~ "📋 needs: unblock" ]]
  [[ "$body" =~ "atmux flags resolve f-" ]]
}

@test "flags_discord: severity=p1 + webhook ⇒ NO POST (silent on Discord)" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "warn-level concern" \
    --severity p1 --needs review --as reviewer
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  # The flag IS still recorded in markdown.
  grep -q "warn-level concern" .atmux/flags.md
}

@test "flags_discord: severity=p2 + webhook ⇒ NO POST (silent on Discord)" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "FYI ctx" \
    --severity p2 --needs context --as lead
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  grep -q "FYI ctx" .atmux/flags.md
}

@test "flags_discord: severity=p0 + NO webhook ⇒ silent no-op (no curl on PATH would be hit)" {
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "no-webhook smoke" \
    --severity p0 --needs unblock --as devops
  [ "$status" -eq 0 ]
  # curl was on PATH but discord.sh short-circuits when webhook is absent.
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]
}

# ---------- payload bullet content ----------

@test "flags_discord: p0 with --task ⇒ '📍 task: <id>' bullet in body" {
  # flags add validates the task id exists in kanban — create one first.
  local tid; tid=$("$ATMUX_BIN" task add "real task" | tail -1)
  [[ "$tid" =~ ^t-[0-9a-f]{8}$ ]]
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "blocked on dep" \
    --severity p0 --needs unblock --as worker --task "$tid"
  [ "$status" -eq 0 ]
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "📍 task: $tid" ]]
}

@test "flags_discord: p0 with --note ⇒ '📝 <note>' bullet in body" {
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "rate limited" \
    --severity p0 --needs rotate --as devops --note "see logs"
  [ "$status" -eq 0 ]
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "📝 see logs" ]]
}

@test "flags_discord: p0 with no --task and no --note ⇒ neither bullet appears" {
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" flags add "minimal flag" \
    --severity p0 --needs review --as reviewer
  [ "$status" -eq 0 ]
  local body; body=$(_curl_payload_content)
  [ -n "$body" ]
  ! [[ "$body" =~ "📍 task:" ]]
  ! [[ "$body" =~ "📝 " ]]
}

# ---------- ≤80-char bullet budget ----------

@test "flags_discord: every body line ≤80 chars (global format spec)" {
  # Use upper-bound inputs: 60-char message + --task + --note. The header
  # line is allowed >80 chars per format spec; we check body bullets only.
  local msg60 note60
  msg60=$(printf '%.0sM' {1..60})
  note60=$(printf '%.0sN' {1..60})
  local tid; tid=$("$ATMUX_BIN" task add "real" | tail -1)
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "$msg60" \
    --severity p0 --needs decision --as devops \
    --task "$tid" --note "$note60" >/dev/null
  local body; body=$(_curl_payload_content)
  # Skip the header (📍 ... · `team` · HH:MM MYT — informational, multi-byte).
  local seen_first_blank=0
  while IFS= read -r line; do
    if [[ "$seen_first_blank" -eq 0 ]]; then
      [[ -z "$line" ]] && seen_first_blank=1
      continue
    fi
    [[ -z "$line" ]] && continue
    local n=${#line}
    [ "$n" -le 80 ] || { echo "BULLET >80 chars ($n): $line"; false; }
  done <<<"$body"
}

# ---------- mixed-stream sanity ----------

@test "flags_discord: 3 adds (p0/p1/p2) ⇒ exactly 1 ping (only p0 fires)" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "p2 ctx" --severity p2 --needs context --as lead >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "p1 review" --severity p1 --needs review --as reviewer >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" flags add "p0 unblock" --severity p0 --needs unblock --as devops >/dev/null
  [ "$(_curl_calls)" = "1" ]
  local body; body=$(_curl_payload_content)
  [[ "$body" =~ "p0 unblock" ]]
  ! [[ "$body" =~ "p1 review" ]]
  ! [[ "$body" =~ "p2 ctx" ]]
}

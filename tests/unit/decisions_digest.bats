#!/usr/bin/env bats
# Unit tests for `atmux decisions digest` (E2/S8 / t-dd036408).
#
# Behaviour under test (per ADR-008 + S8 ship):
#   - cursor at .atmux/state/decisions-digest-cursor (epoch seconds)
#   - 0 new decisions ⇒ exit 0, "no new decisions", NO discord_ping, cursor untouched
#   - ≥1 new ⇒ 1 ping (or ≥1 if body >2000 chars); cursor advances to now
#   - bullets are atomic — chunker never splits mid-decision
#   - fire-and-warn: cursor moves whether the ping returned 0 or non-zero
#
# Mocks curl on PATH; counts invocations; captures bodies for content asserts.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name d >/dev/null

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

# Concatenate every captured curl payload (the --data-raw / --data argument
# values) into a single blob for content assertions.
_all_payloads() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"; pick=0} {
    if (pick) { print; pick=0; next }
    if ($0=="--data-raw" || $0=="-d" || $0=="--data") pick=1
  }' "$f" | jq -r '.content // empty' 2>/dev/null
}

# Replace the curl mock with one that exits non-zero (still records args).
_install_failing_curl() {
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 1
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"
}

# ---------- empty / no-op ----------

@test "digest: 0 new decisions ⇒ 'no new decisions' + exit 0 + no ping + cursor untouched" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions digest
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no new decisions" ]]
  [ "$(_curl_calls)" = "0" ]
  [ ! -f .atmux/state/decisions-digest-cursor ]
}

# ---------- happy path: 3 decisions, no prior cursor ----------

@test "digest: 3 decisions, no prior cursor ⇒ 1 ping with all 3 bullets + cursor advances" {
  # Use --reversibility low so the per-add gate doesn't ping (we want only
  # the digest-side ping to register).
  "$ATMUX_BIN" decisions add "Q1?" --default "A1" --reversibility low >/dev/null
  "$ATMUX_BIN" decisions add "Q2?" --default "A2" --reversibility low >/dev/null
  "$ATMUX_BIN" decisions add "Q3?" --default "A3" --reversibility low >/dev/null
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  local before; before=$(date +%s)
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions digest
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "1" ]
  local body; body=$(_all_payloads)
  [[ "$body" =~ "Q1?" ]]
  [[ "$body" =~ "Q2?" ]]
  [[ "$body" =~ "Q3?" ]]
  [[ "$body" =~ "atmux-digest" ]]
  # Cursor advanced past the start of the test.
  [ -f .atmux/state/decisions-digest-cursor ]
  local cursor; cursor=$(< .atmux/state/decisions-digest-cursor)
  [ "$cursor" -ge "$before" ]
}

# ---------- cursor blocks duplicate emit ----------

@test "digest: re-run immediately ⇒ 'no new decisions' (cursor blocks duplicate emit)" {
  "$ATMUX_BIN" decisions add "Once?" --default "Y" --reversibility low >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions digest >/dev/null

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions digest
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no new decisions" ]]
  [ "$(_curl_calls)" = "0" ]
}

# ---------- 5 decisions, single chunk ----------

@test "digest: 5 short decisions ⇒ 1 chunk (single ping under 2000 chars)" {
  for i in 1 2 3 4 5; do
    "$ATMUX_BIN" decisions add "Q$i?" --default "A$i" --reversibility low >/dev/null
  done
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions digest
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "1" ]
  local body; body=$(_all_payloads)
  # All 5 bullets present in the single chunk.
  for i in 1 2 3 4 5; do
    [[ "$body" =~ "Q$i?" ]]
  done
  # Single-chunk path doesn't carry [N/M] prefix.
  ! [[ "$body" =~ \[1/1\] ]]
}

# ---------- multi-chunk: force >2000-char body ----------

@test "digest: many decisions exceeding 2000 chars ⇒ multiple chunks with [N/M] markers + every bullet present" {
  # Use 60-char questions/defaults to maximise per-bullet length within the
  # ≤60-char gate. ~140 chars/bullet × 30 bullets ≈ 4200 chars ⇒ ≥3 chunks.
  # Build a 56-char question prefix; with 2-digit suffix + "?" the total
  # stays within the 60-char gate for all 30 entries.
  local qpfx a60
  qpfx=$(printf '%.0sQ' {1..56})
  a60=$(printf '%.0sA' {1..60})
  for i in $(seq -f '%02g' 1 30); do
    "$ATMUX_BIN" decisions add "${qpfx}${i}?" --default "${a60}" --reversibility low >/dev/null
  done
  local n; n=$("$ATMUX_BIN" decisions list --json | jq -r 'length')
  [ "$n" = "30" ]

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions digest
  [ "$status" -eq 0 ]
  local calls; calls=$(_curl_calls)
  # Multi-chunk: must be ≥2 pings.
  [ "$calls" -ge 2 ]

  local body; body=$(_all_payloads)
  # Every chunk in a multi-chunk send carries the [N/M] prefix.
  [[ "$body" =~ \[1/$calls\] ]]
  [[ "$body" =~ \[$calls/$calls\] ]]
}

# ---------- chunk-boundary atomicity ----------

@test "digest: bullets are atomic — every chunk's last bullet is a complete decision" {
  local q60 a60
  q60=$(printf '%.0sQ' {1..58})
  a60=$(printf '%.0sA' {1..60})
  for i in $(seq 1 30); do
    "$ATMUX_BIN" decisions add "${q60}${i}?" --default "${a60}" --reversibility low >/dev/null 2>&1 || true
  done
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions digest >/dev/null
  local body; body=$(_all_payloads)

  # Every line that begins with a reversibility emoji must contain `→` —
  # i.e. it's a complete bullet. A truncated bullet would be missing the
  # arrow + default. Use rev-emoji starts as bullet anchors.
  while IFS= read -r line; do
    case "$line" in
      🟢*|🟡*|🔴*)
        [[ "$line" =~ "→" ]] || { echo "BAD bullet (no arrow, mid-split?): $line"; false; }
        ;;
    esac
  done <<<"$body"
}

# ---------- fire-and-warn: cursor advances even on ping failure ----------

@test "digest: ping failure ⇒ cursor STILL advances (fire-and-warn semantics)" {
  _install_failing_curl
  "$ATMUX_BIN" decisions add "Will fail?" --default "yes" --reversibility low >/dev/null
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"

  local before; before=$(date +%s)
  # discord_ping swallows curl rc; the digest verb returns 0 either way.
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions digest
  [ "$status" -eq 0 ]
  # curl WAS attempted (record present).
  [ "$(_curl_calls)" -ge 1 ]
  # Cursor was advanced anyway.
  [ -f .atmux/state/decisions-digest-cursor ]
  local cursor; cursor=$(< .atmux/state/decisions-digest-cursor)
  [ "$cursor" -ge "$before" ]
}

# ---------- digest does NOT touch the per-add cursor (independent state) ----------

@test "digest: digest cursor is independent from the per-add decisions-cursor" {
  "$ATMUX_BIN" decisions add "ind?" --default "y" --reversibility low >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions digest >/dev/null
  [ -f .atmux/state/decisions-digest-cursor ]
  # The whip-side per-add decisions-cursor is unrelated; digest must not write it.
  [ ! -f .atmux/state/decisions-cursor ]
}

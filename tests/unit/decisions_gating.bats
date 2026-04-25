#!/usr/bin/env bats
# Unit tests for the reversibility-gated Discord ping in atmux decisions
# (E2/S8 / t-398bc8a1). Per ADR-008 + the t-398bc8a1 ship: only
# reversibility=high triggers a Discord post; low + medium are
# silent (recorded in decisions.md, no ping). All three reversibility
# levels otherwise produce identical decisions.md state and identical
# `atmux decisions show / list` output.
#
# Mocks curl on PATH to count Discord ping invocations — same pattern as
# tests/unit/decisions.bats and tests/unit/whip_dedup.bats.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name g >/dev/null

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

# Count curl invocations recorded so far (each invocation has at least one
# arg starting with `http`, so we count those).
_curl_calls() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || { echo 0; return; }
  awk 'BEGIN{RS="\0"} /^http:/{n++} END{print n+0}' "$f"
}

# ---------- gate behaviour per reversibility level ----------

@test "gating: reversibility=high ⇒ exactly 1 ping fired + decisions.md gains entry" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "ship?" --default "y" --reversibility high
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "1" ]
  [ -f .atmux/decisions.md ]
  grep -q "ship?" .atmux/decisions.md
  grep -q "reversibility.*high" .atmux/decisions.md
}

@test "gating: reversibility=medium ⇒ NO ping fired, decisions.md still written" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "switch?" --default "n" --reversibility medium
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  [ -f .atmux/decisions.md ]
  grep -q "switch?" .atmux/decisions.md
  grep -q "reversibility.*medium" .atmux/decisions.md
}

@test "gating: reversibility=low ⇒ NO ping fired, decisions.md still written" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "tweak?" --default "ok" --reversibility low
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  grep -q "tweak?" .atmux/decisions.md
  grep -q "reversibility.*low" .atmux/decisions.md
}

@test "gating: reversibility omitted ⇒ defaults to low ⇒ NO ping" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "default?" --default "y"
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  grep -q "default?" .atmux/decisions.md
}

# ---------- show / list parity (output independent of ping path) ----------

@test "gating: show <id> output is identical shape across all 3 reversibility levels" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "low-q?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "med-q?"  --default "a" --reversibility medium >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "high-q?" --default "a" --reversibility high   >/dev/null

  local low_id med_id high_id
  low_id=$("$ATMUX_BIN" decisions list --json | jq -r '.[] | select(.question=="low-q?") | .id')
  med_id=$("$ATMUX_BIN" decisions list --json | jq -r '.[] | select(.question=="med-q?") | .id')
  high_id=$("$ATMUX_BIN" decisions list --json | jq -r '.[] | select(.question=="high-q?") | .id')

  for id in "$low_id" "$med_id" "$high_id"; do
    [[ "$id" =~ ^d-[0-9a-f]{8}$ ]]
    run "$ATMUX_BIN" decisions show "$id"
    [ "$status" -eq 0 ]
    [[ "$output" =~ "$id" ]]
    [[ "$output" =~ "default" ]]
    [[ "$output" =~ "reversibility" ]]
  done
}

@test "gating: list returns all 3 entries regardless of ping path" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-low?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-med?"  --default "a" --reversibility medium >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-high?" --default "a" --reversibility high   >/dev/null
  run "$ATMUX_BIN" decisions list --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" = "3" ]
  # All three reversibility levels show up in the output.
  [ "$(jq -r '[.[] | .reversibility] | sort | unique | length' <<<"$output")" = "3" ]
}

@test "gating: list --reversibility filter unaffected by ping path (all 3 levels listable)" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "Q-low?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "Q-med?"  --default "a" --reversibility medium >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "Q-high?" --default "a" --reversibility high   >/dev/null

  for level in low medium high; do
    local listed; listed=$("$ATMUX_BIN" decisions list --reversibility "$level" --json)
    [ "$(jq -r 'length' <<<"$listed")" = "1" ]
    [ "$(jq -r '.[0].reversibility' <<<"$listed")" = "$level" ]
  done
}

# ---------- mixed-stream sanity ----------

@test "gating: 3 adds (low/med/high) ⇒ exactly 1 ping fired (only the high one)" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "lo?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "md?"  --default "a" --reversibility medium >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "hi?"  --default "a" --reversibility high   >/dev/null
  [ "$(_curl_calls)" = "1" ]
}

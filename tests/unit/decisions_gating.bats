#!/usr/bin/env bats
# Unit tests for the reversibility-gated Discord ping in atmux decisions
# (E2/S8 / t-398bc8a1, broadened in E6/S1 / t-d0750a1b).
#
# Current gate (lib/decisions.sh:253) — `^(high|medium)$` fires the rich,
# section-by-section chunked Discord render in real time. `low` stays
# whip-batched (markdown still appended; whip's tick surfaces count + 1-line
# preview + digest pointer). All three levels otherwise produce identical
# decisions.md state and identical `atmux decisions show / list` output.
#
# Mocks curl on PATH to count Discord ping invocations + capture body
# payloads — same pattern as tests/unit/decisions.bats and
# tests/unit/whip_dedup.bats.

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

# True if any captured curl arg contains the rich-render's required-block
# fingerprint. Markers chosen to be unique to _decisions_render_discord —
# they don't appear in whip's batched preview path or any other ping.
_curl_received_rich_render() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 1
  grep -aq '🔵 question:' "$f" || return 1
  grep -aq '📍 atmux decisions show' "$f" || return 1
}

# ---------- gate behaviour per reversibility level ----------

@test "gating: reversibility=high ⇒ rich render fires + decisions.md gains entry" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "ship?" --default "y" --reversibility high --context "ship ctx"
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" -ge 1 ]
  _curl_received_rich_render
  [ -f .atmux/decisions.md ]
  grep -q "ship?" .atmux/decisions.md
  grep -q "reversibility.*high" .atmux/decisions.md
}

@test "gating: reversibility=medium ⇒ rich render fires (E6/S1 t-d0750a1b broadened gate)" {
  # Pre-S1 contract: medium was silent. New contract: medium now fires the
  # same chunked render as high — captured curl payload must carry the rich
  # render's required-block fingerprint, not just a count > 0.
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "switch?" --default "n" --reversibility medium --context "switch ctx"
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" -ge 1 ]
  _curl_received_rich_render
  [ -f .atmux/decisions.md ]
  grep -q "switch?" .atmux/decisions.md
  grep -q "reversibility.*medium" .atmux/decisions.md
}

@test "gating: reversibility=low ⇒ rich render skipped (whip-batched path), decisions.md still written" {
  # Low explicitly stays out of the rich-ping path — whip's tick surfaces a
  # batched count + 1-line preview instead. Mock curl tmpfile must remain
  # absent / empty (no `_decisions_render_discord` chunks reached it).
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "tweak?" --default "ok" --reversibility low
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  ! _curl_received_rich_render
  grep -q "tweak?" .atmux/decisions.md
  grep -q "reversibility.*low" .atmux/decisions.md
}

@test "gating: reversibility omitted ⇒ defaults to low ⇒ rich render skipped" {
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "default?" --default "y"
  [ "$status" -eq 0 ]
  [ "$(_curl_calls)" = "0" ]
  ! _curl_received_rich_render
  grep -q "default?" .atmux/decisions.md
}

# ---------- show / list parity (output independent of ping path) ----------

@test "gating: show <id> output is identical shape across all 3 reversibility levels" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "low-q?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "med-q?"  --default "a" --reversibility medium --context "med-q ctx" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "high-q?" --default "a" --reversibility high   --context "high-q ctx" >/dev/null

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
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-med?"  --default "a" --reversibility medium --context "q-med ctx" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-high?" --default "a" --reversibility high   --context "q-high ctx" >/dev/null
  run "$ATMUX_BIN" decisions list --json
  [ "$status" -eq 0 ]
  [ "$(jq -r 'length' <<<"$output")" = "3" ]
  # All three reversibility levels show up in the output.
  [ "$(jq -r '[.[] | .reversibility] | sort | unique | length' <<<"$output")" = "3" ]
}

@test "gating: list --reversibility filter unaffected by ping path (all 3 levels listable)" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "Q-low?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "Q-med?"  --default "a" --reversibility medium --context "Q-med ctx" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "Q-high?" --default "a" --reversibility high   --context "Q-high ctx" >/dev/null

  for level in low medium high; do
    local listed; listed=$("$ATMUX_BIN" decisions list --reversibility "$level" --json)
    [ "$(jq -r 'length' <<<"$listed")" = "1" ]
    [ "$(jq -r '.[0].reversibility' <<<"$listed")" = "$level" ]
  done
}

# ---------- mixed-stream sanity ----------

@test "gating: 3 adds (low/med/high) ⇒ rich render fires twice (medium + high), low silent" {
  # Post-E6/S1: medium now fires alongside high. Each rich-render call is
  # 1 chunk in the no-options/no-context shape these adds use (well under
  # the 1900-char single-message threshold) — so curl-call count maps 1:1
  # to "decisions that fired the rich path".
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "lo?"  --default "a" --reversibility low    >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "md?"  --default "a" --reversibility medium --context "md ctx" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "hi?"  --default "a" --reversibility high   --context "hi ctx" >/dev/null
  [ "$(_curl_calls)" = "2" ]
  # Both surviving rich payloads carry the required-block fingerprint —
  # rules out a regression that fires curl but silently truncates the body.
  local md_hits hi_hits
  md_hits=$(grep -ac 'md?' "$ATMUX_TEST_TMP/curl-args.bin" || echo 0)
  hi_hits=$(grep -ac 'hi?' "$ATMUX_TEST_TMP/curl-args.bin" || echo 0)
  [ "$md_hits" -ge 1 ]
  [ "$hi_hits" -ge 1 ]
  # Low question NEVER reached the curl tmpfile — it stayed batched.
  ! grep -aq 'lo?' "$ATMUX_TEST_TMP/curl-args.bin"
}

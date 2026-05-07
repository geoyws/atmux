#!/usr/bin/env bats
# Unit tests for the E6/Sd context-richness gate (t-480ce575, lib/decisions.sh:189).
# `atmux decisions add` with --reversibility high|medium MUST carry at least one
# of --context / --note; otherwise the rich-ping body collapses to question +
# default + show-pointer, forcing the driver to shell in to read the call.
#
# The gate fires BEFORE the 60s idempotency dedup + BEFORE markdown append, so
# a rejected call leaves no trace in .atmux/decisions.md and never invokes
# curl. Low reversibility is exempt — the digest-batched path tolerates terse
# entries.
#
# Mocks curl on PATH (same harness as decisions_gating.bats) so no real
# Discord ping fires during the bypass cases.

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

# ---------- gate trigger paths (high/medium without --context AND --note) ----------

@test "context-gate: high without --context AND without --note dies (exit 1, stderr cite)" {
  run "$ATMUX_BIN" decisions add "ship?" --default "yes" --reversibility high
  [ "$status" -ne 0 ]
  # Educational error message — name both flags so the operator knows --note is
  # the lighter alternative, plus cite the reversibility level that triggered.
  [[ "$output" =~ "--context (or --note) required for high-reversibility" ]]
  # Side-effect-free reject: no .md write, no curl invocation.
  [ ! -f .atmux/decisions.md ] || ! grep -q "ship?" .atmux/decisions.md
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]
}

@test "context-gate: medium without --context AND without --note dies (exit 1, stderr cite)" {
  run "$ATMUX_BIN" decisions add "switch?" --default "no" --reversibility medium
  [ "$status" -ne 0 ]
  [[ "$output" =~ "--context (or --note) required for medium-reversibility" ]]
  [ ! -f .atmux/decisions.md ] || ! grep -q "switch?" .atmux/decisions.md
  [ ! -f "$ATMUX_TEST_TMP/curl-args.bin" ]
}

# ---------- gate bypass paths (low exempt + --context satisfies + --note satisfies) ----------

@test "context-gate: low without --context passes (digest-batched path, gate exempt)" {
  # Low reversibility never reaches the rich-ping path — the digest-batched
  # whip tick surfaces it instead. Gate must NOT trip on terse low entries.
  run "$ATMUX_BIN" decisions add "tweak?" --default "ok" --reversibility low
  [ "$status" -eq 0 ]
  [ -f .atmux/decisions.md ]
  grep -q "tweak?" .atmux/decisions.md
  grep -q "reversibility.*low" .atmux/decisions.md
}

@test "context-gate: high with --context passes (canonical bypass)" {
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "ship?" \
    --default "yes" --reversibility high \
    --context "demo path freeze starts Thursday"
  [ "$status" -eq 0 ]
  [ -f .atmux/decisions.md ]
  grep -q "ship?" .atmux/decisions.md
  grep -q "reversibility.*high" .atmux/decisions.md
  grep -q "context.*demo path freeze" .atmux/decisions.md
}

@test "context-gate: medium with --note (no --context) passes (--note alt-bypass)" {
  # Verifies --note satisfies the gate as the lighter reviewer-style
  # annotation — operator doesn't need to redundantly fill --context when a
  # one-line --note covers the rationale.
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" decisions add "switch?" \
    --default "no" --reversibility medium \
    --note "ADR-013 already covers rationale"
  [ "$status" -eq 0 ]
  [ -f .atmux/decisions.md ]
  grep -q "switch?" .atmux/decisions.md
  grep -q "reversibility.*medium" .atmux/decisions.md
  grep -q "note.*ADR-013 already covers rationale" .atmux/decisions.md
}

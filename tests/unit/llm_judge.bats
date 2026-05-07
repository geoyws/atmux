#!/usr/bin/env bats
# Unit tests for lib/llm-judge.sh — atmux::llm_judge wrapper + JSONL cost ledger.
# Per ADR-023 §Decision (E9/Se).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # llm-judge isn't sourced by tui.sh's helper; load it explicitly.
  . "$ATMUX_LIB_DIR/llm-judge.sh"
  "$ATMUX_BIN" init --name j >/dev/null

  # Stub `claude` binary via ATMUX_CLAUDE_BIN. The stub echoes a canned
  # JSON judgment so we don't hit the real CLI.
  STUB_DIR="$ATMUX_TEST_TMP/stub"
  mkdir -p "$STUB_DIR"
  cat > "$STUB_DIR/claude-ok" <<'EOF'
#!/usr/bin/env bash
# Drains stdin (the prompt) so wc-on-piped inputs would match if anyone wired it.
cat >/dev/null
echo '{"decision":"skip","reason":"teammate mid-refactor, 12 lines staged"}'
EOF
  chmod +x "$STUB_DIR/claude-ok"

  cat > "$STUB_DIR/claude-fail" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
exit 7
EOF
  chmod +x "$STUB_DIR/claude-fail"
}

teardown() {
  atmux_teardown_sandbox
}

@test "llm_judge: happy-path emits judge JSON to stdout" {
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'classify: %s\n' "approaching usage limit" > "$prompt"
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" run atmux::llm_judge "$prompt" --caller whip --member dba
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.decision == "skip"' >/dev/null
  echo "$output" | jq -e '.reason | test("mid-refactor")' >/dev/null
}

@test "llm_judge: appends one JSONL row per invocation with full schema" {
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'AAAAAAA' > "$prompt"   # 7 chars input
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" atmux::llm_judge "$prompt" --caller whip --member dba >/dev/null

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  [ -f "$ledger" ]
  run wc -l <"$ledger"
  [ "$output" = "1" ]

  run jq -e '.ts and .member == "dba" and .caller == "whip" and .model == "claude-sonnet-4-6"
             and .input_chars == 7 and .output_chars > 0
             and .decision == "skip" and (.reason | length > 0)' "$ledger"
  [ "$status" -eq 0 ]

  # Second call appends, doesn't truncate.
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" atmux::llm_judge "$prompt" --caller unblocker --member fe-foo >/dev/null
  run wc -l <"$ledger"
  [ "$output" = "2" ]
}

@test "llm_judge: --model override flows to the binary call" {
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'x' > "$prompt"

  cat > "$STUB_DIR/claude-spy" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
# Echo the args back into the JSON reason so the test can assert on it.
echo "{\"decision\":\"rotate\",\"reason\":\"args=$*\"}"
EOF
  chmod +x "$STUB_DIR/claude-spy"

  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-spy" run atmux::llm_judge "$prompt" --model claude-haiku-4-5 --caller whip
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.reason | test("--model claude-haiku-4-5")' >/dev/null
  echo "$output" | jq -e '.reason | test("--no-conversation")' >/dev/null

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  run jq -e '.model == "claude-haiku-4-5"' "$ledger"
  [ "$status" -eq 0 ]
}

@test "llm_judge: missing claude binary → unavailable JSON + ledger entry" {
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'q' > "$prompt"
  local out; out="$(ATMUX_CLAUDE_BIN="$STUB_DIR/does-not-exist" atmux::llm_judge "$prompt" --caller whip --member dba 2>/dev/null)"
  echo "$out" | jq -e '.decision == "unavailable"' >/dev/null
  echo "$out" | jq -e '.reason == "judge invocation failed"' >/dev/null

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  run jq -e '.decision == "unavailable" and .caller == "whip"' "$ledger"
  [ "$status" -eq 0 ]
}

@test "llm_judge: non-zero exit from claude → unavailable JSON + ledger entry" {
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'q' > "$prompt"
  local out; out="$(ATMUX_CLAUDE_BIN="$STUB_DIR/claude-fail" atmux::llm_judge "$prompt" --caller unblocker 2>/dev/null)"
  echo "$out" | jq -e '.decision == "unavailable"' >/dev/null

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  run jq -e '.decision == "unavailable"' "$ledger"
  [ "$status" -eq 0 ]
}

@test "llm_judge: missing prompt file → unavailable JSON, no ledger write" {
  local out; out="$(atmux::llm_judge "/nonexistent/prompt.txt" --caller whip 2>/dev/null)"
  echo "$out" | jq -e '.decision == "unavailable"' >/dev/null

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  [ ! -f "$ledger" ]
}

@test "llm_judge: defaults — model=sonnet-4-6 caller=unknown member=-" {
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'x' > "$prompt"
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" atmux::llm_judge "$prompt" >/dev/null

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  run jq -e '.model == "claude-sonnet-4-6" and .caller == "unknown" and .member == "-"' "$ledger"
  [ "$status" -eq 0 ]
}

@test "llm_judge: 3 concurrent invocations append 3 well-formed rows (no torn writes)" {
  # Stub is bash so each invocation is independent; the JSONL ledger is
  # opened with O_APPEND under the hood (bash `>>`), and one judge call
  # emits one line ≪ PIPE_BUF, so concurrent appends should not interleave.
  local prompt; prompt="$(mktemp "$ATMUX_TEST_TMP/prompt.XXXX")"
  printf 'parallel' > "$prompt"

  # Fire 3 in parallel, wait for all.
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" atmux::llm_judge "$prompt" --caller c1 --member m1 >/dev/null &
  local p1=$!
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" atmux::llm_judge "$prompt" --caller c2 --member m2 >/dev/null &
  local p2=$!
  ATMUX_CLAUDE_BIN="$STUB_DIR/claude-ok" atmux::llm_judge "$prompt" --caller c3 --member m3 >/dev/null &
  local p3=$!
  wait "$p1" "$p2" "$p3"

  local ledger="$(atmux::state_dir)/llm-judge-cost.jsonl"
  [ -f "$ledger" ]

  # Exactly 3 lines.
  run wc -l <"$ledger"
  [ "$output" = "3" ]

  # Every line is a parseable JSON object with the expected schema (no
  # torn writes / partial lines).
  run bash -c "while IFS= read -r line; do
                 echo \"\$line\" | jq -e 'has(\"ts\") and has(\"caller\") and has(\"member\") and has(\"model\") and has(\"input_chars\") and has(\"output_chars\") and has(\"decision\") and has(\"reason\")' >/dev/null || exit 1
               done <'$ledger'"
  [ "$status" -eq 0 ]

  # All 3 distinct callers landed (set-equality with {c1,c2,c3}).
  run jq -rs 'map(.caller) | sort | join(",")' "$ledger"
  [ "$output" = "c1,c2,c3" ]
}

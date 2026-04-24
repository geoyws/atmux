#!/usr/bin/env bats
# Cost tracking against a synthetic Claude JSONL session.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name c >/dev/null

  # Build a fake ~/.claude/projects/<slug>/session.jsonl under an isolated HOME.
  export HOME="$ATMUX_TEST_TMP/home"
  mkdir -p "$HOME"
  local slug="${PWD//\//-}"
  local proj_dir="$HOME/.claude/projects/$slug"
  mkdir -p "$proj_dir"

  # Two assistant messages using the opus model. Input 1000, output 500, cache-read 2000.
  cat > "$proj_dir/session1.jsonl" <<'JSON'
{"type":"user","message":{"role":"user","content":"hello"}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000}}}
{"type":"user","message":{"role":"user","content":"again"}}
{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"yo"}],"usage":{"input_tokens":200,"output_tokens":100,"cache_creation_input_tokens":500,"cache_read_input_tokens":0}}}
JSON

  # Make sure the session file's mtime is after session-start.
  echo 0 > .atmux/state/session-start.txt
}

teardown() {
  atmux_teardown_sandbox
}

@test "cost: --json returns structured output with per-member rows" {
  run "$ATMUX_BIN" cost --json
  [ "$status" -eq 0 ]
  echo "$output" | jq . >/dev/null
  run sh -c "'$ATMUX_BIN' cost --json | jq -r '.members | length'"
  [ "$output" -gt "0" ]
}

@test "cost: claude member with a fake session totals non-zero USD" {
  # Find a member whose cwd matches PWD — our init template sets them all to PWD.
  run sh -c "'$ATMUX_BIN' cost --json | jq -r '[.members[] | select(.tui == \"claude\")] | .[0].usd'"
  [ "$status" -eq 0 ]
  # Opus pricing → input 1200 * 15 + output 600 * 75 + cache_write 500 * 18.75 + cache_read 2000 * 1.5 (per million)
  # = 0.018 + 0.045 + 0.009375 + 0.003 = ~0.0754
  # We don't care about the exact value; just that it's > 0.
  awk "BEGIN{exit !($output > 0)}"
}

@test "cost: non-claude TUI reports unknown" {
  # Add a cursor member, verify its cost row has source=unknown.
  "$ATMUX_BIN" add-member ui-test --role member --tui cursor --cwd "$PWD" >/dev/null
  run sh -c "'$ATMUX_BIN' cost --json | jq -r '.members[] | select(.member == \"ui-test\") | .source'"
  [ "$output" = "unknown" ]
}

@test "cost: tokens.total = input + output + cacheWrite + cacheRead" {
  run sh -c "'$ATMUX_BIN' cost --json | jq -r '[.members[] | select(.tui == \"claude\")] | .[0] | .tokens | (.input + .output + .cacheWrite + .cacheRead) == .total'"
  [ "$output" = "true" ]
}

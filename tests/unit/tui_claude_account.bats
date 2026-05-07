#!/usr/bin/env bats
# Unit tests for per-member Claude account selection (`claudeAccount` field).
# Mirrors the per-member model precedent (ADR-024): a sugar layer over
# Claude Code's built-in CLAUDE_CONFIG_DIR env var, exposed through a
# declarative team.json field so cost-balancing across multiple Claude Max
# accounts doesn't have to live in member.command verbatim.
#
# Coverage:
#   1. Field absent or "default" → no CLAUDE_CONFIG_DIR in spawn cmd.
#   2. Field set to "ifca" → CLAUDE_CONFIG_DIR=$HOME/.claude-ifca prepended.
#   3. Field "null" string (jq's null-as-string) → treated as absent.
#   4. Field coexists with --model selection (both env vars present).
#   5. member.command override path STILL wins (claudeAccount ignored —
#      operator chose to handle env themselves).
#   6. tuiCommands prefix path does NOT honor claudeAccount (custom prefix
#      handles its own env composition; documented gap).
#
# Refs: ADR-024 §Per-member model selection (mirror precedent).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  mkdir -p .atmux
}

teardown() {
  atmux_teardown_sandbox
}

_write_team() {
  echo "$1" > .atmux/team.json
}

# ---------- (1) absent / default → no env ----------

@test "claudeAccount: absent → no CLAUDE_CONFIG_DIR in spawn cmd" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ CLAUDE_CONFIG_DIR ]]
  [[ "$output" =~ CLAUDECODE=1 ]]
}

@test "claudeAccount: literal 'default' → no CLAUDE_CONFIG_DIR" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":"default"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ CLAUDE_CONFIG_DIR ]]
}

@test "claudeAccount: empty string → no CLAUDE_CONFIG_DIR" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":""}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ CLAUDE_CONFIG_DIR ]]
}

# ---------- (2) set → env prepended ----------

@test "claudeAccount: 'ifca' → CLAUDE_CONFIG_DIR=\$HOME/.claude-ifca prepended" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":"ifca"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "CLAUDE_CONFIG_DIR=$HOME/.claude-ifca" ]]
  # Env must come BEFORE `claude` invocation (and before CLAUDECODE/EFFORT).
  [[ "$output" =~ "CLAUDE_CONFIG_DIR=$HOME/.claude-ifca CLAUDECODE=1" ]]
}

@test "claudeAccount: alphanumeric suffix → resolves verbatim" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":"unum-prod"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "CLAUDE_CONFIG_DIR=$HOME/.claude-unum-prod" ]]
}

# ---------- (3) jq's null-as-string ----------

@test "claudeAccount: jq null-as-string → no CLAUDE_CONFIG_DIR (defensive)" {
  # Belt-and-suspenders: a malformed team.json that has the field as
  # JSON null is parsed by jq -r as the literal string "null". The
  # helper must treat that as absent, not try to mkdir ~/.claude-null.
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":null}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ CLAUDE_CONFIG_DIR ]]
}

# ---------- (4) coexists with --model ----------

@test "claudeAccount + model: both env + --model land in spawn cmd" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"claude-sonnet-4-6","cwd":"/tmp","claudeAccount":"ifca"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude claude-sonnet-4-6 /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "CLAUDE_CONFIG_DIR=$HOME/.claude-ifca" ]]
  [[ "$output" =~ "--model claude-sonnet-4-6" ]]
}

# ---------- (5) member.command override wins ----------

@test "claudeAccount: member.command override wins; claudeAccount is NOT auto-applied" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":"ifca","command":"my-wrapper --flag"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "my-wrapper --flag" ]]
  # Override path bypasses the built-in handler; operator owns env in command.
  ! [[ "$output" =~ CLAUDE_CONFIG_DIR ]]
  ! [[ "$output" =~ CLAUDECODE=1 ]]
}

# ---------- (6) tuiCommands prefix gap (documented) ----------

@test "claudeAccount: tuiCommands prefix path does NOT auto-apply (custom prefix owns env)" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"claude": "claude --plugin-dir=/x"},
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","claudeAccount":"ifca"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "claude --plugin-dir=/x" ]]
  # Documented gap: custom prefix path doesn't auto-apply claudeAccount.
  # Operators using tuiCommands write the env into the prefix themselves.
  ! [[ "$output" =~ CLAUDE_CONFIG_DIR ]]
}

#!/usr/bin/env bats
# Unit tests for `atmux doctor`.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# Helper: write a valid minimal team.json using only tui=shell so PATH checks
# never go red (every sandbox has a shell).
_write_shell_team() {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "doc",
  "members": [
    {"name": "w1", "role": "member", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
}

@test "doctor: help prints usage" {
  run "$ATMUX_BIN" doctor --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "environment health" ]] || [[ "$output" =~ "check environment" ]]
}

@test "doctor: green on a valid shell-only team" {
  _write_shell_team
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 0 ]
  [[ "$output" =~ "team.json" ]]
  [[ "$output" =~ "valid" ]]
}

@test "doctor: quiet mode suppresses output on green" {
  _write_shell_team
  run "$ATMUX_BIN" doctor --quiet
  [ "$status" -eq 0 ]
  # No check-table rows in quiet mode.
  ! [[ "$output" =~ "team.json" ]]
}

@test "doctor: red exit when team.json missing" {
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "team.json" ]]
  [[ "$output" =~ "missing" ]]
}

@test "doctor: red exit when team.json is invalid JSON" {
  mkdir -p .atmux
  echo '{broken' > .atmux/team.json
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "invalid JSON" ]]
}

@test "doctor: red exit when member TUI binary is not on PATH" {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "members": [
    {"name": "w1", "role": "member", "tui": "claude", "command": "definitely-not-a-real-binary-xyz-$$", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "NOT on PATH" ]]
}

@test "doctor: green ignores shell TUI (never checks PATH for shell/bash/zsh)" {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "members": [
    {"name": "w1", "role": "member", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "w2", "role": "member", "tui": "bash",  "model": "default", "cwd": "$PWD"},
    {"name": "w3", "role": "member", "tui": "zsh",   "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "NOT on PATH" ]]
}

@test "doctor: --json emits parseable JSON with red/yellow counts" {
  _write_shell_team
  run "$ATMUX_BIN" doctor --json
  [ "$status" -eq 0 ]
  run jq -e '.red == 0 and (.checks | length > 0)' <<<"$output"
  [ "$status" -eq 0 ]
}

@test "doctor: detects unknown tui type as red" {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "members": [
    {"name": "w1", "role": "member", "tui": "claude-custom-no-override", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "unknown tui" ]] || [[ "$output" =~ "tui:claude-custom" ]]
}

@test "doctor: resolves tuiCommands prefix to first binary token" {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "tuiCommands": {"claude": "nonexistent-claude-wrapper-$$  --plugin-dir=/x"},
  "members": [
    {"name": "w1", "role": "member", "tui": "claude", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  run "$ATMUX_BIN" doctor
  [ "$status" -eq 1 ]
  [[ "$output" =~ "nonexistent-claude-wrapper" ]]
  [[ "$output" =~ "NOT on PATH" ]]
}

@test "doctor: skips env-var prefix when extracting binary from command" {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "members": [
    {"name": "w1", "role": "member", "tui": "claude", "command": "FOO=bar BAZ=1 $(command -v sh) -c true", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  run "$ATMUX_BIN" doctor
  # sh is definitely on PATH — doctor should resolve past FOO=/BAZ= to sh.
  [ "$status" -eq 0 ]
}

@test "start: red preflight aborts with pointer to doctor" {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "members": [
    {"name": "w1", "role": "member", "tui": "claude", "command": "definitely-not-a-real-binary-xyz-$$", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  export ATMUX_SESSION="atmux-test-$$-preflight-red"
  run "$ATMUX_BIN" start
  [ "$status" -ne 0 ]
  [[ "$output" =~ "preflight" ]] || [[ "$output" =~ "doctor" ]]
}

@test "start: --no-doctor bypasses preflight" {
  # Valid team.json but a fake TUI. Preflight would normally red; --no-doctor skips.
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "d",
  "members": [
    {"name": "w1", "role": "member", "tui": "claude", "command": "definitely-not-a-real-binary-xyz-$$", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  export ATMUX_SESSION="atmux-test-$$-preflight-skip"
  run "$ATMUX_BIN" start --no-doctor
  # Session should be created even though the TUI doesn't exist.
  # (The fake TUI command will just fail inside the pane — that's not start.sh's problem.)
  [ "$status" -eq 0 ]
  tmux kill-session -t "$ATMUX_SESSION" 2>/dev/null || true
}

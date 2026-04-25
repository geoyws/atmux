#!/usr/bin/env bats
# Unit tests for `atmux up` (bare `atmux` → one-stop bring-up).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

_write_shell_team() {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "up",
  "members": [
    {"name": "w1", "role": "member", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
}

@test "up: bare atmux routes to up (no 'unknown verb')" {
  # Non-interactive (no TTY) in a fresh dir → should die with a clear message,
  # NOT print the help or 'unknown verb'.
  run "$ATMUX_BIN"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no team.json" ]]
  ! [[ "$output" =~ "unknown verb" ]]
  ! [[ "$output" =~ "Usage:" ]]
}

@test "up: explicit 'atmux up' verb also works" {
  run "$ATMUX_BIN" up
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no team.json" ]]
}

@test "up: help flag still prints usage (not up)" {
  run "$ATMUX_BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Usage:" ]]
}

@test "up: version flag still prints version (not up)" {
  run "$ATMUX_BIN" --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^atmux\ [0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "up: ATMUX_NO_WIZARD aborts without prompting" {
  ATMUX_NO_WIZARD=1 run "$ATMUX_BIN"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "ATMUX_NO_WIZARD" ]]
}

@test "up: with existing team.json, starts session (non-TTY skips attach)" {
  _write_shell_team
  export ATMUX_SESSION="atmux-test-$$-up-bare"
  run "$ATMUX_BIN"
  [ "$status" -eq 0 ]
  run tmux has-session -t "$ATMUX_SESSION"
  [ "$status" -eq 0 ]
  tmux kill-session -t "$ATMUX_SESSION" 2>/dev/null || true
}

@test "up: second invocation reuses existing session" {
  _write_shell_team
  export ATMUX_SESSION="atmux-test-$$-up-reuse"
  "$ATMUX_BIN" >/dev/null 2>&1
  run "$ATMUX_BIN"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "already running" ]] || [[ "$output" =~ "reusing" ]]
  tmux kill-session -t "$ATMUX_SESSION" 2>/dev/null || true
}

@test "up: red preflight aborts with doctor report + pointer" {
  # Valid team.json, but a fake TUI binary → preflight red.
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "u",
  "members": [
    {"name": "w1", "role": "member", "tui": "claude", "command": "definitely-not-a-real-binary-xyz-$$", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  export ATMUX_SESSION="atmux-test-$$-up-red"
  run "$ATMUX_BIN"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "preflight" ]]
  # Doctor's red row should appear in output (verbose re-run)
  [[ "$output" =~ "NOT on PATH" ]]
}

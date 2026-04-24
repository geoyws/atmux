#!/usr/bin/env bats
# Unit tests for bin/atmux dispatcher.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

@test "cli: no args prints help" {
  run "$ATMUX_BIN"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux" ]]
  [[ "$output" =~ "Usage:" ]]
}

@test "cli: --help prints help" {
  run "$ATMUX_BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Usage:" ]]
}

@test "cli: version prints semver" {
  run "$ATMUX_BIN" version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^atmux\ [0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "cli: unknown verb exits 64" {
  run "$ATMUX_BIN" not-a-verb
  [ "$status" -eq 64 ]
  [[ "$output" =~ "unknown verb" ]]
}

@test "cli: task is aliased to kanban" {
  "$ATMUX_BIN" init --name x >/dev/null
  run "$ATMUX_BIN" task list
  [ "$status" -eq 0 ]
}

@test "cli: broadcast goes to send.sh" {
  "$ATMUX_BIN" init --name x >/dev/null
  # No tmux session → broadcast loops members and warns each; exit code from send is non-zero.
  run "$ATMUX_BIN" broadcast "hi"
  # broadcast aggregates failures; shouldn't crash with a missing-script error.
  ! [[ "$output" =~ "missing main" ]]
}

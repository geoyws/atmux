#!/usr/bin/env bats
# Unit tests for bin/atmux dispatcher.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

@test "cli: no args routes to 'up' one-stop flow" {
  # Bare `atmux` is aliased to `atmux up` — in a fresh sandbox with no TTY
  # and no team.json, up aborts with a clear "no team.json" message rather
  # than printing help. Use `atmux help` / `--help` to get help.
  run "$ATMUX_BIN"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no team.json" ]]
}

@test "cli: 'atmux help' prints help" {
  run "$ATMUX_BIN" help
  [ "$status" -eq 0 ]
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

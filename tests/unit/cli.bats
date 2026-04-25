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

# --team-dir + ATMUX_TEAM_DIR — the cron-from-$HOME fix. Without these,
# `*/5 * * * * atmux whip` runs from $HOME, can't find team.json, and
# silently fails forever.

@test "cli: --team-dir <dir> pins atmux at project root from outside cwd" {
  "$ATMUX_BIN" init --name pin >/dev/null
  local proj="$ATMUX_TEST_TMP/project"
  mkdir -p "$ATMUX_TEST_TMP/elsewhere"
  cd "$ATMUX_TEST_TMP/elsewhere"
  unset ATMUX_DIR  # let the flag fully drive resolution
  run "$ATMUX_BIN" --team-dir "$proj" task list
  [ "$status" -eq 0 ]
}

@test "cli: --team-dir=<dir> equals form works" {
  "$ATMUX_BIN" init --name pin >/dev/null
  local proj="$ATMUX_TEST_TMP/project"
  mkdir -p "$ATMUX_TEST_TMP/elsewhere"
  cd "$ATMUX_TEST_TMP/elsewhere"
  unset ATMUX_DIR
  run "$ATMUX_BIN" --team-dir="$proj" task list
  [ "$status" -eq 0 ]
}

@test "cli: --team-dir accepted post-verb (atmux <verb> --team-dir <dir>)" {
  "$ATMUX_BIN" init --name pin >/dev/null
  local proj="$ATMUX_TEST_TMP/project"
  mkdir -p "$ATMUX_TEST_TMP/elsewhere"
  cd "$ATMUX_TEST_TMP/elsewhere"
  unset ATMUX_DIR
  run "$ATMUX_BIN" task --team-dir "$proj" list
  [ "$status" -eq 0 ]
}

@test "cli: --team-dir without value exits 64" {
  run "$ATMUX_BIN" --team-dir
  [ "$status" -eq 64 ]
  [[ "$output" =~ "requires <dir>" ]]
}

@test "cli: --team-dir <missing> rejects non-existent dir" {
  run "$ATMUX_BIN" --team-dir /nonexistent/path/here task list
  [ "$status" -eq 64 ]
  [[ "$output" =~ "not a directory" ]]
}

@test "cli: ATMUX_TEAM_DIR env pins atmux from outside cwd (cron path)" {
  "$ATMUX_BIN" init --name pin >/dev/null
  local proj="$ATMUX_TEST_TMP/project"
  mkdir -p "$ATMUX_TEST_TMP/elsewhere"
  cd "$ATMUX_TEST_TMP/elsewhere"
  unset ATMUX_DIR
  ATMUX_TEAM_DIR="$proj" run "$ATMUX_BIN" task list
  [ "$status" -eq 0 ]
}

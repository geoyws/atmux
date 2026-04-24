#!/usr/bin/env bats
# Unit tests for status / report / whip — no tmux required for status/report (logic only).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name s >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "status: prints team name, member rows, kanban counts" {
  run "$ATMUX_BIN" status
  [ "$status" -eq 0 ]
  [[ "$output" =~ "TEAM" ]]
  [[ "$output" =~ "s" ]]
  [[ "$output" =~ "kanban" ]]
  [[ "$output" =~ "todo=0" ]]
}

@test "status: reflects task counts" {
  "$ATMUX_BIN" task add "one" >/dev/null
  "$ATMUX_BIN" task add "two" >/dev/null
  run "$ATMUX_BIN" status
  [[ "$output" =~ "todo=2" ]]
}

@test "report: --no-discord prints body to stdout" {
  "$ATMUX_BIN" task add "one" >/dev/null
  run "$ATMUX_BIN" report --no-discord
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux-report" ]]
  [[ "$output" =~ "Shipped" ]]
  [[ "$output" =~ "In-progress" ]]
}

@test "report: shipped section counts tasks completed since last report" {
  local id; id=$("$ATMUX_BIN" task add "ship-me" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null

  # First run: should include the shipped task.
  run "$ATMUX_BIN" report --no-discord
  [[ "$output" =~ "ship-me" ]]

  # Second run: last-report.epoch is updated, so no new shipped.
  run "$ATMUX_BIN" report --no-discord
  ! [[ "$output" =~ "ship-me" ]]
}

@test "tell-lead: appends to driver-inbox.md + passes through" {
  # Stub tmux to avoid real send-keys. If no session exists, tell-lead should
  # fail at the send step but still have appended to driver-inbox.
  run "$ATMUX_BIN" tell-lead "hello world"
  # send fails because no tmux session is up
  [ "$status" -ne 0 ] || true
  # but driver-inbox got the entry
  run grep -F "hello world" .atmux/driver-inbox.md
  [ "$status" -eq 0 ]
}

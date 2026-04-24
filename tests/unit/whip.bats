#!/usr/bin/env bats
# Unit tests for atmux whip

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "whip: flags session DOWN when no tmux session exists" {
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "DOWN" ]] || [[ "$output" =~ "down" ]]
}

@test "whip: logs to .atmux/logs/whip.log" {
  "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  [ -f .atmux/logs/whip.log ]
}

@test "whip: STALE_MIN env var is respected" {
  # We can't fully exercise without a live tmux session, but we can verify
  # the command runs with the env var without erroring out.
  ATMUX_STALE_MIN=1 ATMUX_LEAD_MAX_MIN=1 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
}

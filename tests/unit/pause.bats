#!/usr/bin/env bats
# pause / resume + dispatch refusal.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name p >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "pause: marks member paused in state file" {
  "$ATMUX_BIN" pause lead >/dev/null
  run jq -r '.lead.reason' .atmux/state/paused.json
  [ "$output" = "manual" ]
}

@test "resume: clears paused state" {
  "$ATMUX_BIN" pause lead >/dev/null
  "$ATMUX_BIN" resume lead >/dev/null
  run jq -r '.lead // "empty"' .atmux/state/paused.json
  [ "$output" = "empty" ]
}

@test "dispatch: refuses a paused member" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" pause lead >/dev/null
  run "$ATMUX_BIN" dispatch lead "$id" --no-ping
  [ "$status" -ne 0 ]
  [[ "$output" =~ "paused" ]]
}

@test "dispatch: works again after resume" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" pause lead >/dev/null
  "$ATMUX_BIN" resume lead >/dev/null
  run "$ATMUX_BIN" dispatch lead "$id" --no-ping
  [ "$status" -eq 0 ]
}

#!/usr/bin/env bats
# Task dep-gating + priority.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name d >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "deps: claim blocked when a dep is not done" {
  local a b
  a=$("$ATMUX_BIN" task add "parent" | tail -1)
  b=$("$ATMUX_BIN" task add "child" --deps "$a" | tail -1)
  run "$ATMUX_BIN" claim "$b" --as lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "blocked by unresolved deps" ]]
}

@test "deps: claim allowed once all deps are done" {
  local a b
  a=$("$ATMUX_BIN" task add "parent" | tail -1)
  b=$("$ATMUX_BIN" task add "child" --deps "$a" | tail -1)
  "$ATMUX_BIN" task move "$a" done >/dev/null
  run "$ATMUX_BIN" claim "$b" --as lead
  [ "$status" -eq 0 ]
}

@test "deps: dispatch blocked when a dep is not done" {
  local a b
  a=$("$ATMUX_BIN" task add "parent" | tail -1)
  b=$("$ATMUX_BIN" task add "child" --deps "$a" | tail -1)
  run "$ATMUX_BIN" dispatch lead "$b" --no-ping
  [ "$status" -ne 0 ]
  [[ "$output" =~ "blocked by unresolved deps" ]]
}

@test "priority: task add --priority is persisted" {
  local id; id=$("$ATMUX_BIN" task add "urgent" --priority 1 | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .priority' .atmux/kanban.json
  [ "$output" = "1" ]
}

@test "priority: task list sorts by priority ascending" {
  local low high
  low=$("$ATMUX_BIN" task add "low"  --priority 9 | tail -1)
  high=$("$ATMUX_BIN" task add "high" --priority 1 | tail -1)
  run "$ATMUX_BIN" task list
  # high (prio 1) should appear on an earlier line than low (prio 9)
  local high_line low_line
  high_line=$(echo "$output" | grep -n 'high' | head -1 | cut -d: -f1)
  low_line=$(echo "$output"  | grep -n 'low'  | head -1 | cut -d: -f1)
  [ -n "$high_line" ] && [ -n "$low_line" ]
  [ "$high_line" -lt "$low_line" ]
}

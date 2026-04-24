#!/usr/bin/env bats
# Unit tests for kanban / task verb.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name k >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "task: add creates a todo task with a generated id" {
  run "$ATMUX_BIN" task add "implement feature X"
  [ "$status" -eq 0 ]
  # last line is the id
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^t-[0-9a-f]{8}$ ]]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "todo" ]
}

@test "task: add with --body + --assignee stores both" {
  run "$ATMUX_BIN" task add "thing" --body "do it right" --assignee worker
  local id; id=$(echo "$output" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .body' .atmux/kanban.json
  [ "$output" = "do it right" ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "worker" ]
}

@test "task: list shows added tasks" {
  "$ATMUX_BIN" task add "first" >/dev/null
  "$ATMUX_BIN" task add "second" >/dev/null
  run "$ATMUX_BIN" task list
  [[ "$output" =~ first ]]
  [[ "$output" =~ second ]]
}

@test "task: list --status filters" {
  local id; id=$("$ATMUX_BIN" task add "one" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  "$ATMUX_BIN" task add "two" >/dev/null

  run "$ATMUX_BIN" task list --status done
  [[ "$output" =~ one ]]
  ! [[ "$output" =~ two ]]
}

@test "task: move requires valid status" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  run "$ATMUX_BIN" task move "$id" nonsense
  [ "$status" -ne 0 ]
}

@test "task: move sets completedAt when status=done" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .completedAt' .atmux/kanban.json
  [[ "$output" =~ ^[0-9]+$ ]]
}

@test "task: assign updates owner" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task assign "$id" alice >/dev/null
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "alice" ]
}

@test "task: rm removes the task" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task rm "$id" >/dev/null
  run jq -r --arg id "$id" '[.tasks[] | select(.id==$id)] | length' .atmux/kanban.json
  [ "$output" = "0" ]
}

@test "task: show returns the task JSON" {
  local id; id=$("$ATMUX_BIN" task add "show-me" | tail -1)
  run "$ATMUX_BIN" task show "$id"
  [[ "$output" =~ show-me ]]
}

@test "task: add with --deps parses comma-separated deps" {
  local id; id=$("$ATMUX_BIN" task add "x" --deps "t-aaa,t-bbb" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .deps | join(",")' .atmux/kanban.json
  [ "$output" = "t-aaa,t-bbb" ]
}

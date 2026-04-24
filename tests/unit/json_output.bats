#!/usr/bin/env bats
# --json output for status + task list.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name j >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "status --json is valid JSON" {
  run "$ATMUX_BIN" status --json
  [ "$status" -eq 0 ]
  echo "$output" | jq . >/dev/null
}

@test "status --json has team + session + members + kanban keys" {
  run sh -c "'$ATMUX_BIN' status --json | jq -r 'keys | join(\",\")'"
  [[ "$output" =~ team ]]
  [[ "$output" =~ session ]]
  [[ "$output" =~ members ]]
  [[ "$output" =~ kanban ]]
}

@test "status --json kanban counts reflect task state" {
  "$ATMUX_BIN" task add "one" >/dev/null
  "$ATMUX_BIN" task add "two" >/dev/null
  local id; id=$("$ATMUX_BIN" task add "three" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run sh -c "'$ATMUX_BIN' status --json | jq '.kanban.todo'"
  [ "$output" = "2" ]
  run sh -c "'$ATMUX_BIN' status --json | jq '.kanban.done'"
  [ "$output" = "1" ]
}

@test "task list --json returns an array" {
  "$ATMUX_BIN" task add "a" >/dev/null
  "$ATMUX_BIN" task add "b" >/dev/null
  run "$ATMUX_BIN" task list --json
  [ "$status" -eq 0 ]
  run sh -c "'$ATMUX_BIN' task list --json | jq 'type'"
  [ "$output" = '"array"' ]
  run sh -c "'$ATMUX_BIN' task list --json | jq 'length'"
  [ "$output" = "2" ]
}

@test "task list --json --status filters" {
  local id; id=$("$ATMUX_BIN" task add "done-me" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  "$ATMUX_BIN" task add "todo-me" >/dev/null
  run sh -c "'$ATMUX_BIN' task list --json --status done | jq -r '.[].subject' | tr '\n' ' '"
  [[ "$output" =~ "done-me" ]]
  ! [[ "$output" =~ "todo-me" ]]
}

#!/usr/bin/env bats
# Unit tests for dispatch / inbox / claim / done.
# These test the STATE side (inbox + kanban updates) — send-keys pings are
# skipped via a dummy tmux stub + --no-ping mode.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name d >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "dispatch: --no-ping moves task to in-progress + inbox" {
  local id; id=$("$ATMUX_BIN" task add "do-it" | tail -1)
  run "$ATMUX_BIN" dispatch lead "$id" --no-ping
  [ "$status" -eq 0 ]
  # kanban flipped
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "lead" ]
  # inbox populated
  run jq --arg id "$id" '[.inProgress[] | select(.id==$id)] | length' .atmux/inboxes/lead.json
  [ "$output" = "1" ]
}

@test "dispatch: refuses unknown member" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  run "$ATMUX_BIN" dispatch nope "$id" --no-ping
  [ "$status" -ne 0 ]
}

@test "dispatch: refuses unknown task id" {
  run "$ATMUX_BIN" dispatch lead t-nope --no-ping
  [ "$status" -ne 0 ]
}

@test "claim: member claims a todo task" {
  local id; id=$("$ATMUX_BIN" task add "do-it" | tail -1)
  run "$ATMUX_BIN" claim "$id" --as lead
  [ "$status" -eq 0 ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "lead" ]
  run jq --arg id "$id" '[.inProgress[] | select(.id==$id)] | length' .atmux/inboxes/lead.json
  [ "$output" = "1" ]
}

@test "done: closes out an in-progress task + records note" {
  local id; id=$("$ATMUX_BIN" task add "do-it" | tail -1)
  "$ATMUX_BIN" claim "$id" --as lead >/dev/null
  run "$ATMUX_BIN" done "$id" --as lead --note "shipped"
  [ "$status" -eq 0 ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "done" ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .note' .atmux/kanban.json
  [ "$output" = "shipped" ]
  # inbox: moved from inProgress to done
  run jq --arg id "$id" '[.done[] | select(.id==$id)] | length' .atmux/inboxes/lead.json
  [ "$output" = "1" ]
  run jq --arg id "$id" '[.inProgress[] | select(.id==$id)] | length' .atmux/inboxes/lead.json
  [ "$output" = "0" ]
}

@test "inbox: shows pending/inProgress/done sections" {
  local id; id=$("$ATMUX_BIN" task add "do-it" | tail -1)
  "$ATMUX_BIN" claim "$id" --as lead >/dev/null
  run "$ATMUX_BIN" inbox lead
  [[ "$output" =~ "pending" ]]
  [[ "$output" =~ "in-progress" ]]
  [[ "$output" =~ "done" ]]
  [[ "$output" =~ "$id" ]]
}

@test "inbox --json returns raw JSON" {
  "$ATMUX_BIN" task add "x" >/dev/null
  run "$ATMUX_BIN" inbox lead --json
  [ "$status" -eq 0 ]
  # must parse
  echo "$output" | jq . >/dev/null
}

@test "claim: errors when ATMUX_MEMBER + --as both unset and no cwd match" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  # Force cwd mismatch.
  cd /tmp
  ATMUX_DIR="$ATMUX_TEST_TMP/project/.atmux" run "$ATMUX_BIN" claim "$id"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "can't infer member" ]]
}

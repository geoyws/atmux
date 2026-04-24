#!/usr/bin/env bats
# atmux handoff — state migration (no tmux required). The native-handoff path
# is tested in e2e (since it needs real panes to capture).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name h >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "handoff: refuses unknown members" {
  run "$ATMUX_BIN" handoff lead nobody
  [ "$status" -ne 0 ]
}

@test "handoff: migrates in-progress tasks from source to target" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" dispatch lead "$id" --no-ping >/dev/null
  run "$ATMUX_BIN" handoff lead reviewer --no-native
  [ "$status" -eq 0 ]
  # kanban ownership flipped
  run jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .owner' .atmux/kanban.json
  [ "$output" = "reviewer" ]
  # target inbox has it in inProgress
  run jq --arg id "$id" '[.inProgress[] | select(.id == $id)] | length' .atmux/inboxes/reviewer.json
  [ "$output" = "1" ]
  # source inbox no longer has it
  run jq --arg id "$id" '[.inProgress[] | select(.id == $id)] | length' .atmux/inboxes/lead.json
  [ "$output" = "0" ]
}

@test "handoff: writes a handoff markdown even without source pane" {
  "$ATMUX_BIN" handoff lead reviewer --no-native >/dev/null
  local f; f=$(ls .atmux/handoff/lead-to-reviewer-*.md | head -1)
  [ -n "$f" ]
  [ -f "$f" ]
}

@test "handoff: --pause-from pauses the source member" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" dispatch lead "$id" --no-ping >/dev/null
  "$ATMUX_BIN" handoff lead reviewer --no-native --pause-from >/dev/null
  run jq -r '.lead.reason // "empty"' .atmux/state/paused.json
  ! [ "$output" = "empty" ]
  [[ "$output" =~ "handoff" ]]
}

@test "handoff: migrates zero tasks cleanly (source had no in-progress)" {
  run "$ATMUX_BIN" handoff lead reviewer --no-native
  [ "$status" -eq 0 ]
  [[ "$output" =~ "0 tasks" ]]
}

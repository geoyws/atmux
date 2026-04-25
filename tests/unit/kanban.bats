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

# ---- schema normalize (Epic / Story expansion) ----

@test "schema: fresh init writes tasks[] + epics[] + stories[]" {
  run jq -r '[.tasks, .epics, .stories] | map(type) | join(",")' .atmux/kanban.json
  [ "$status" -eq 0 ]
  [ "$output" = "array,array,array" ]
}

@test "schema: legacy kanban (tasks-only) survives a mutation and gains epics/stories" {
  # Hand-craft a legacy shape — exactly what pre-v0.4 kanbans look like.
  echo '{"tasks":[{"id":"t-legacy01","subject":"old","status":"todo","owner":null,"deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}]}' > .atmux/kanban.json

  # First mutation should auto-add the missing top-level arrays without
  # losing the legacy task.
  "$ATMUX_BIN" task add "fresh" >/dev/null

  run jq -r '.epics | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '.stories | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '[.tasks[] | .id] | sort | join(",")' .atmux/kanban.json
  [[ "$output" =~ t-legacy01 ]]
}

@test "schema: legacy task without epic/story/lane/deliverable reads back as null" {
  echo '{"tasks":[{"id":"t-legacy02","subject":"old","status":"todo","owner":null,"deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}]}' > .atmux/kanban.json
  "$ATMUX_BIN" task add "noop-trigger" >/dev/null
  run jq -r '.tasks[] | select(.id=="t-legacy02") | [.epic, .story, .lane, .deliverable] | map(. // "null") | join(",")' .atmux/kanban.json
  [ "$output" = "null,null,null,null" ]
}

@test "schema: kanban_normalize is idempotent (running it twice is a no-op)" {
  # Snapshot, normalize twice via two mutations, snapshot again — the
  # top-level shape should be byte-identical between the two snapshots
  # (only the new task differs, and we exclude .tasks from the diff).
  local before; before=$(jq -S 'del(.tasks)' .atmux/kanban.json)
  "$ATMUX_BIN" task add "first"  >/dev/null
  "$ATMUX_BIN" task add "second" >/dev/null
  local after;  after=$(jq -S 'del(.tasks)' .atmux/kanban.json)
  [ "$before" = "$after" ]
}

@test "schema: claim normalizes a legacy kanban without losing data" {
  # Arrange: a legacy kanban with one task already in-progress on a member.
  echo '{"tasks":[{"id":"t-legacy03","subject":"x","status":"todo","owner":"worker","deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}]}' > .atmux/kanban.json

  run "$ATMUX_BIN" claim t-legacy03 --as worker
  [ "$status" -eq 0 ]

  # Top-level arrays present, status updated, task preserved.
  run jq -r '.epics | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '.stories | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '.tasks[] | select(.id=="t-legacy03") | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
}

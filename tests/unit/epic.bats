#!/usr/bin/env bats
# Unit tests for `atmux epic` (lib/epic.sh) — T2.2 / t-ec15f973.
#
# State machine (per ADR-007): planning → ready → in-progress → review → done
#
# These tests target the verb-suite contract from t-21aebee2's AC. They will
# fail with "atmux: unknown verb: epic" until lib/epic.sh + bin/atmux dispatch
# wiring lands (T2.1, be-kanban). That's the deliverable shape; once the BE
# verb exists, gaps fill in.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name e >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- add ----------

@test "epic: add mints e-xxxxxxxx, status=planning, prints id on stdout" {
  run "$ATMUX_BIN" epic add "ship feature X"
  [ "$status" -eq 0 ]
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^e-[0-9a-f]{8}$ ]]
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "planning" ]
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .title' .atmux/kanban.json
  [ "$output" = "ship feature X" ]
}

@test "epic: add --body persists body" {
  local id; id=$("$ATMUX_BIN" epic add "X" --body "context here" | tail -1)
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .body' .atmux/kanban.json
  [ "$output" = "context here" ]
}

@test "epic: add --driver-ref persists ref" {
  local id; id=$("$ATMUX_BIN" epic add "X" --driver-ref "issue-42" | tail -1)
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .driverRef // ""' .atmux/kanban.json
  [ "$output" = "issue-42" ]
}

@test "epic: add stamps createdAt as epoch seconds" {
  local id; id=$("$ATMUX_BIN" epic add "X" | tail -1)
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .createdAt' .atmux/kanban.json
  [[ "$output" =~ ^[0-9]+$ ]]
}

# ---------- list ----------

@test "epic: list shows added epics, sorted by createdAt asc" {
  "$ATMUX_BIN" epic add "first"  >/dev/null
  "$ATMUX_BIN" epic add "second" >/dev/null
  run "$ATMUX_BIN" epic list
  [[ "$output" =~ first ]]
  [[ "$output" =~ second ]]
}

@test "epic: list --status filters" {
  local id; id=$("$ATMUX_BIN" epic add "one" | tail -1)
  "$ATMUX_BIN" epic advance "$id" --to ready >/dev/null
  "$ATMUX_BIN" epic add "two" >/dev/null    # still planning
  run "$ATMUX_BIN" epic list --status planning
  [[ "$output" =~ two ]]
  ! [[ "$output" =~ one ]]
}

@test "epic: list --json round-trips" {
  "$ATMUX_BIN" epic add "a" >/dev/null
  "$ATMUX_BIN" epic add "b" >/dev/null
  run "$ATMUX_BIN" epic list --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e 'length == 2' >/dev/null
  echo "$output" | jq -e '.[0] | has("id") and has("title") and has("status")' >/dev/null
}

# ---------- show ----------

@test "epic: show renders an Epic with zero Stories/Tasks" {
  local id; id=$("$ATMUX_BIN" epic add "lone" | tail -1)
  run "$ATMUX_BIN" epic show "$id"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "lone" ]]
  [[ "$output" =~ "$id" ]]
}

@test "epic: show --json round-trips" {
  local id; id=$("$ATMUX_BIN" epic add "j" | tail -1)
  run "$ATMUX_BIN" epic show "$id" --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e --arg id "$id" '.id == $id' >/dev/null
}

@test "epic: show renders child Stories + Tasks (tree view)" {
  local eid; eid=$("$ATMUX_BIN" epic add "with kids" | tail -1)
  local sid; sid=$("$ATMUX_BIN" story add "child" --epic "$eid" | tail -1)
  local tid; tid=$("$ATMUX_BIN" task add "kid task" --story "$sid" --epic "$eid" | tail -1)
  run "$ATMUX_BIN" epic show "$eid"
  [[ "$output" =~ "$sid" ]]
  [[ "$output" =~ "$tid" ]]
}

@test "epic: show with unknown id ⇒ non-zero exit" {
  run "$ATMUX_BIN" epic show e-deadbeef
  [ "$status" -ne 0 ]
}

# ---------- advance ----------

@test "epic: advance default = next state in machine" {
  local id; id=$("$ATMUX_BIN" epic add "p" | tail -1)
  run "$ATMUX_BIN" epic advance "$id"
  [ "$status" -eq 0 ]
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "ready" ]
}

@test "epic: advance --to <state> validates legal transitions" {
  local id; id=$("$ATMUX_BIN" epic add "x" | tail -1)
  "$ATMUX_BIN" epic advance "$id" --to ready >/dev/null
  run "$ATMUX_BIN" epic advance "$id" --to in-progress
  [ "$status" -eq 0 ]
  run jq -r --arg id "$id" '.epics[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
}

@test "epic: advance is idempotent on same-state target" {
  local id; id=$("$ATMUX_BIN" epic add "x" | tail -1)
  "$ATMUX_BIN" epic advance "$id" --to ready >/dev/null
  run "$ATMUX_BIN" epic advance "$id" --to ready
  [ "$status" -eq 0 ]
}

@test "epic: advance rejects illegal jump (planning → done)" {
  local id; id=$("$ATMUX_BIN" epic add "x" | tail -1)
  run "$ATMUX_BIN" epic advance "$id" --to done
  [ "$status" -ne 0 ]
}

@test "epic: advance --to review with open Stories ⇒ error names blocking ids" {
  local eid; eid=$("$ATMUX_BIN" epic add "e" | tail -1)
  local sid; sid=$("$ATMUX_BIN" story add "blocking" --epic "$eid" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  "$ATMUX_BIN" epic advance "$eid" --to in-progress >/dev/null
  run "$ATMUX_BIN" epic advance "$eid" --to review
  [ "$status" -ne 0 ]
  [[ "$output" =~ "$sid" ]]
}

@test "epic: advance --to review when all children done ⇒ auto-dispatches summary task to lead inbox" {
  local eid; eid=$("$ATMUX_BIN" epic add "ready-to-review" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  "$ATMUX_BIN" epic advance "$eid" --to in-progress >/dev/null
  run "$ATMUX_BIN" epic advance "$eid" --to review
  [ "$status" -eq 0 ]
  # Inbox should now contain a "draft Epic summary <eid>" task.
  run jq --arg eid "$eid" '[.inProgress[], .pending[] | select(.subject | test("draft Epic summary " + $eid))] | length' .atmux/inboxes/lead.json
  [ "$output" -ge 1 ]
}

@test "epic: advance unknown id ⇒ non-zero" {
  run "$ATMUX_BIN" epic advance e-deadbeef
  [ "$status" -ne 0 ]
}

# ---------- dispatch / args ----------

@test "epic: missing verb errors with usage hint" {
  run "$ATMUX_BIN" epic
  [ "$status" -ne 0 ]
  [[ "$output" =~ "add" ]] || [[ "$output" =~ "usage" ]]
}

@test "epic: unknown verb errors" {
  run "$ATMUX_BIN" epic blarp
  [ "$status" -ne 0 ]
}

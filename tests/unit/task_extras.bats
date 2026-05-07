#!/usr/bin/env bats
# Unit tests for `atmux task add/list` Epic-/Story-/lane-/deliverable-aware
# flag set — T4.1 (t-8f03ec9d). Pre-scaffold per lead-approved B-then-A plan;
# the file stays untracked (`??`) until lead formally dispatches t-a333ae77.
#
# Decoupling: `task add --epic <eid> --story <sid>` requires Epics/Stories
# to exist. We seed those via `atmux epic add` / `atmux story add` (T2.1
# + T3.1 already shipped) — so this file has NO open dependency on T4.1's
# own --epic/--story plumbing besides the flags themselves.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name t >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Scaffold an Epic + Story so we can exercise --epic / --story refs.
_make_epic_with_story() {
  local eid; eid=$("$ATMUX_BIN" epic add "parent epic" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  local sid; sid=$("$ATMUX_BIN" story add "parent story" --epic "$eid" | tail -1)
  printf '%s %s\n' "$eid" "$sid"
}

# ---------- task add: new flags ----------

@test "task add --lane <fe|be|db|ops|test|review|misc>: persists" {
  for lane in fe be db ops test review misc; do
    local id; id=$("$ATMUX_BIN" task add "x-$lane" --lane "$lane" | tail -1)
    run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .lane' .atmux/kanban.json
    [ "$output" = "$lane" ]
  done
}

@test "task add --lane <invalid>: errors with enum list" {
  run "$ATMUX_BIN" task add "x" --lane "marketing"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "fe" ]] && [[ "$output" =~ "be" ]] && [[ "$output" =~ "misc" ]]
}

@test "task add --epic <unknown>: rejects dangling epic ref" {
  run "$ATMUX_BIN" task add "x" --epic "e-deadbeef"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "epic" ]]
}

@test "task add --story <unknown>: rejects dangling story ref" {
  run "$ATMUX_BIN" task add "x" --story "s-deadbeef"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "story" ]]
}

@test "task add --epic + --story: persists both" {
  read -r eid sid <<<"$(_make_epic_with_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | [.epic, .story] | join(",")' .atmux/kanban.json
  [ "$output" = "$eid,$sid" ]
}

@test "task add --story alone: infers parent epic" {
  read -r eid sid <<<"$(_make_epic_with_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --story "$sid" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .epic' .atmux/kanban.json
  [ "$output" = "$eid" ]
}

@test "task add --epic + --story (mismatched parents): errors" {
  read -r eid1 _ <<<"$(_make_epic_with_story)"
  read -r _    sid2 <<<"$(_make_epic_with_story)"
  run "$ATMUX_BIN" task add "x" --epic "$eid1" --story "$sid2"
  [ "$status" -ne 0 ]
}

@test "task add --deliverable: persists" {
  local id; id=$("$ATMUX_BIN" task add "x" --deliverable "lib/foo.sh" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .deliverable' .atmux/kanban.json
  [ "$output" = "lib/foo.sh" ]
}

@test "task add: omitted flags persist as null (legacy compat)" {
  local id; id=$("$ATMUX_BIN" task add "plain" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | [.epic, .story, .lane, .deliverable] | map(. // "null") | join(",")' .atmux/kanban.json
  [ "$output" = "null,null,null,null" ]
}

# ---------- task list: filters ----------

@test "task list --lane <fe>: filters to that lane only" {
  "$ATMUX_BIN" task add "fe-one" --lane fe >/dev/null
  "$ATMUX_BIN" task add "be-one" --lane be >/dev/null
  "$ATMUX_BIN" task add "no-lane" >/dev/null
  run "$ATMUX_BIN" task list --lane fe
  [[ "$output" =~ fe-one ]]
  ! [[ "$output" =~ be-one ]]
  # Legacy / no-lane tasks should NOT appear in --lane filter.
  ! [[ "$output" =~ no-lane ]]
}

@test "task list --epic <eid>: filters to children of that epic" {
  read -r eid _ <<<"$(_make_epic_with_story)"
  "$ATMUX_BIN" task add "in-epic"     --epic "$eid" >/dev/null
  "$ATMUX_BIN" task add "not-in-epic" >/dev/null
  run "$ATMUX_BIN" task list --epic "$eid"
  [[ "$output" =~ in-epic ]]
  ! [[ "$output" =~ not-in-epic ]]
}

@test "task list --story <sid>: filters to children of that story" {
  read -r eid sid <<<"$(_make_epic_with_story)"
  "$ATMUX_BIN" task add "in-story" --story "$sid" >/dev/null
  "$ATMUX_BIN" task add "outside"  >/dev/null
  run "$ATMUX_BIN" task list --story "$sid"
  [[ "$output" =~ in-story ]]
  ! [[ "$output" =~ outside ]]
}

@test "task list --lane + --status: filters compose" {
  local id1; id1=$("$ATMUX_BIN" task add "fe-todo" --lane fe | tail -1)
  local id2; id2=$("$ATMUX_BIN" task add "fe-done" --lane fe | tail -1)
  "$ATMUX_BIN" task move "$id2" done >/dev/null
  "$ATMUX_BIN" task add "be-todo" --lane be >/dev/null
  run "$ATMUX_BIN" task list --lane fe --status todo
  [[ "$output" =~ fe-todo ]]
  ! [[ "$output" =~ fe-done ]]
  ! [[ "$output" =~ be-todo ]]
}

@test "task list (no filter): shows tabular LANE column with UPPER-CASE display" {
  "$ATMUX_BIN" task add "fe-task" --lane fe >/dev/null
  run "$ATMUX_BIN" task list
  # Header should mention LANE; rows should render UPPER-CASE per ADR-007.
  [[ "$output" =~ "LANE" ]] || [[ "$output" =~ "Lane" ]]
  [[ "$output" =~ "FE" ]]
}

@test "task list (no filter): legacy tasks render '-' in LANE column" {
  # Hand-craft a legacy kanban: task with no .lane field.
  echo '{"tasks":[{"id":"t-legacy","subject":"old","status":"todo","owner":null,"deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}],"epics":[],"stories":[]}' > .atmux/kanban.json
  run "$ATMUX_BIN" task list
  [[ "$output" =~ t-legacy ]]
  [[ "$output" =~ "-" ]]
}

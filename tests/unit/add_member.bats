#!/usr/bin/env bats
# atmux add-member

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name a >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "add-member: appends a new member with the given fields" {
  run "$ATMUX_BIN" add-member alpha --role member --tui shell --cwd /tmp
  [ "$status" -eq 0 ]
  run jq -r '[.members[] | select(.name == "alpha")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '.members[] | select(.name == "alpha") | .tui' .atmux/team.json
  [ "$output" = "shell" ]
  run jq -r '.members[] | select(.name == "alpha") | .cwd' .atmux/team.json
  [ "$output" = "/tmp" ]
}

@test "add-member: refuses to add a duplicate name" {
  "$ATMUX_BIN" add-member beta --role member --tui shell >/dev/null
  run "$ATMUX_BIN" add-member beta --role member --tui shell
  [ "$status" -ne 0 ]
  [[ "$output" =~ "already in team.json" ]]
}

@test "add-member: --command override is persisted" {
  "$ATMUX_BIN" add-member gamma --role member --tui claude --command "my-wrapper" >/dev/null
  run jq -r '.members[] | select(.name == "gamma") | .command' .atmux/team.json
  [ "$output" = "my-wrapper" ]
}

@test "add-member: creates a fresh empty inbox" {
  "$ATMUX_BIN" add-member delta --role member --tui shell >/dev/null
  [ -f .atmux/inboxes/delta.json ]
  run jq '.pending | length' .atmux/inboxes/delta.json
  [ "$output" = "0" ]
}

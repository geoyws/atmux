#!/usr/bin/env bats
# Unit tests for lib/init.sh

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

@test "init: scaffolds .atmux from template" {
  run "$ATMUX_BIN" init --name hello
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
  [ -d .atmux/inboxes ]
  [ -d .atmux/logs ]
  [ -d .atmux/state ]
  [ -f .atmux/kanban.json ]
  [ -f .atmux/driver-inbox.md ]

  run jq -r '.name' .atmux/team.json
  [ "$output" = "hello" ]
  run jq -r '.drivers | length' .atmux/team.json
  [ "$output" = "3" ]
  run jq -r '[.drivers[] | .name] | join(",")' .atmux/team.json
  [ "$output" = "driver,driver-2,driver-3" ]
  run jq -r '.driverPair.layout' .atmux/team.json
  [ "$output" = "horizontal" ]
  run jq -r '.driverPair.panes[1].workflow' .atmux/team.json
  [ "$output" = "kb-att" ]
  run jq -r '.driverPair.panes[1].command | tostring' .atmux/team.json
  [ "$output" = "null" ]
}

@test "init: refuses to overwrite without --force" {
  "$ATMUX_BIN" init --name a
  run "$ATMUX_BIN" init --name b
  [ "$status" -ne 0 ]
  [[ "$output" =~ "already initialized" ]]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "a" ]  # unchanged
}

@test "init: --force overwrites" {
  "$ATMUX_BIN" init --name a
  run "$ATMUX_BIN" init --name b --force
  [ "$status" -eq 0 ]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "b" ]
}

@test "init: template has the 5 default members with expected roles" {
  "$ATMUX_BIN" init --name t
  run jq -r '.drivers | length' .atmux/team.json
  [ "$output" = "3" ]
  run jq -r '.driverPair.panes[1].authority' .atmux/team.json
  [ "$output" = "decision-only" ]
  run jq -r '.members | length' .atmux/team.json
  [ "$output" = "5" ]
  run jq -r '[.members[] | select(.role == "team-lead")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '[.members[] | select(.role == "planner")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '[.members[] | select(.role == "docs")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '[.members[] | select(.role == "reviewer")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '[.members[] | select(.name == "gitter" and .role == "committer")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '[.members[] | select(.role == "dba")] | length' .atmux/team.json
  [ "$output" = "0" ]
}

@test "init: defaults team name to basename of pwd" {
  run "$ATMUX_BIN" init
  [ "$status" -eq 0 ]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "project" ]  # sandbox pwd is .../project
}

@test "init: wizard produces valid JSON (non-interactive piped input)" {
  local tmp; tmp="$(mktemp)"
  # team name | preset=custom | planner y | reviewer y | gitter y | devops n |
  # dba n | n_workers=1 | emoji_mode=static | discord="" | singleSession="" |
  # tui_cmd_claude="" | tui_cmd_opencode="" | tui_cmd_kimi="" | tui_cmd_cursor="" |
  # worker tui=shell | worker model=default | worker name
  printf 'wiz-team\ncustom\ny\ny\ny\nn\nn\n1\nstatic\n\n\n\n\n\n\nshell\ndefault\nworker-1\n' > "$tmp"
  run bash -c "'$ATMUX_BIN' init --wizard --force < '$tmp'"
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "wiz-team" ]
  run jq -r '[.members[] | .name] | join(",")' .atmux/team.json
  [[ "$output" =~ lead ]]
  [[ "$output" =~ reviewer ]]
  [[ "$output" =~ gitter ]]
  [[ "$output" =~ worker-1 ]]
  rm -f "$tmp"
}

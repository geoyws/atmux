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

@test "init: template has the 7 default members with expected roles" {
  "$ATMUX_BIN" init --name t
  run jq -r '.members | length' .atmux/team.json
  [ "$output" = "7" ]
  run jq -r '[.members[] | select(.role == "team-lead")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '[.members[] | select(.role == "reviewer")] | length' .atmux/team.json
  [ "$output" = "1" ]
}

@test "init: defaults team name to basename of pwd" {
  run "$ATMUX_BIN" init
  [ "$status" -eq 0 ]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "project" ]  # sandbox pwd is .../project
}

@test "init: wizard produces valid JSON (non-interactive piped input)" {
  local tmp; tmp="$(mktemp)"
  # team name | reviewer y | gitter y | devops n | n_workers=1 | emoji_mode=static
  # | discord="" | tui_cmd_claude="" | tui_cmd_opencode="" | tui_cmd_kimi="" | tui_cmd_cursor=""
  # | worker tui=shell | worker model=default | worker name
  printf 'wiz-team\ny\ny\nn\n1\nstatic\n\n\n\n\n\nshell\ndefault\nworker-1\n' > "$tmp"
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

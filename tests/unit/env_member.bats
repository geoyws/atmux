#!/usr/bin/env bats
# Every launch command must include `export ATMUX_MEMBER=<name>` so claim/done
# inside that pane auto-infer the member without --as.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
}

teardown() {
  atmux_teardown_sandbox
}

@test "env_member: tui_claude exports ATMUX_MEMBER" {
  run atmux::tui_cmd claude default /tmp backend member
  [[ "$output" =~ "export ATMUX_MEMBER=backend" ]]
}

@test "env_member: tui_opencode exports ATMUX_MEMBER" {
  run atmux::tui_cmd opencode default /tmp svc member
  [[ "$output" =~ "export ATMUX_MEMBER=svc" ]]
}

@test "env_member: tui_kimi exports ATMUX_MEMBER" {
  run atmux::tui_cmd kimi default /tmp k-1 member
  [[ "$output" =~ "export ATMUX_MEMBER=k-1" ]]
}

@test "env_member: tui_cursor exports ATMUX_MEMBER" {
  run atmux::tui_cmd cursor default /tmp ui-1 member
  [[ "$output" =~ "export ATMUX_MEMBER=ui-1" ]]
}

@test "env_member: shell TUI also exports ATMUX_MEMBER" {
  run atmux::tui_cmd shell "" /tmp s-1 member
  [[ "$output" =~ "export ATMUX_MEMBER=s-1" ]]
}

@test "env_member: member.command override still exports ATMUX_MEMBER" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{
  "name": "t",
  "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp","command":"custom-wrapper"}]
}
JSON
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [[ "$output" =~ "export ATMUX_MEMBER=w" ]]
  [[ "$output" =~ custom-wrapper ]]
}

@test "env_member: tuiCommands prefix still exports ATMUX_MEMBER" {
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{
  "name": "t",
  "tuiCommands": {"claude": "claude --plugin-dir=/x"},
  "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp"}]
}
JSON
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [[ "$output" =~ "export ATMUX_MEMBER=w" ]]
  [[ "$output" =~ "--plugin-dir=/x" ]]
}

#!/usr/bin/env bats
# Unit tests for the 3-tier TUI launch-command resolution:
#   1. member.command full override
#   2. team.tuiCommands[<tui>] prefix
#   3. built-in default

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  mkdir -p .atmux
}

teardown() {
  atmux_teardown_sandbox
}

_write_team() {
  local contents="$1"
  echo "$contents" > .atmux/team.json
}

@test "tui resolution: member.command takes priority over everything" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"claude": "SHOULD-NOT-USE-ME"},
    "members": [{"name":"w","tui":"claude","model":"some-model","cwd":"/tmp","command":"my-wrapper --flag"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude some-model /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "my-wrapper --flag" ]]
  ! [[ "$output" =~ "SHOULD-NOT-USE-ME" ]]
  ! [[ "$output" =~ CLAUDECODE=1 ]]
}

@test "tui resolution: team.tuiCommands[claude] prefix overrides the built-in" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"claude": "claude --plugin-dir=/home/g/skills"},
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "claude --plugin-dir=/home/g/skills" ]]
  # built-in's CLAUDECODE=1 shouldn't be there; custom command is the whole prefix.
  ! [[ "$output" =~ CLAUDECODE=1 ]]
}

@test "tui resolution: tuiCommands prefix gets --model appended (when no --model in prefix)" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"claude": "claude --plugin-dir=/x"},
    "members": [{"name":"w","tui":"claude","model":"claude-sonnet-4-6","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude claude-sonnet-4-6 /tmp w member "$mj"
  [[ "$output" =~ "--plugin-dir=/x" ]]
  [[ "$output" =~ "--model claude-sonnet-4-6" ]]
}

@test "tui resolution: prefix with --model already does not get it appended" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"claude": "claude --model claude-opus-4-7 --plugin-dir=/x"},
    "members": [{"name":"w","tui":"claude","model":"claude-sonnet-4-6","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude claude-sonnet-4-6 /tmp w member "$mj"
  # only one --model occurrence
  local n; n=$(awk -v s="$output" 'BEGIN{t=s; c=0; while ((p=index(t,"--model"))>0){c++;t=substr(t,p+7)}; print c}')
  [ "$n" = "1" ]
  [[ "$output" =~ claude-opus-4-7 ]]
  ! [[ "$output" =~ "claude-sonnet-4-6" ]]
}

@test "tui resolution: custom tui name without tuiCommands entry errors clearly" {
  _write_team '{
    "name": "t",
    "tuiCommands": {},
    "members": [{"name":"w","tui":"claude-fresh","model":"default","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude-fresh default /tmp w member "$mj"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown tui type" ]]
  [[ "$output" =~ "tuiCommands" ]]
}

@test "tui resolution: custom tui name WITH tuiCommands entry works" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"claude-fresh": "claude"},
    "members": [{"name":"w","tui":"claude-fresh","model":"default","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude-fresh default /tmp w member "$mj"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "claude" ]]
}

@test "tui resolution: built-in default still fires when no overrides" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default /tmp w member "$mj"
  [[ "$output" =~ CLAUDECODE=1 ]]
  [[ "$output" =~ "--permission-mode" ]]
}

@test "tui resolution: opencode-as-lead uses configured launch prefix" {
  _write_team '{
    "name": "t",
    "tuiCommands": {"opencode": "opencode --model minimax-coding-plan/MiniMax-M2.7-highspeed"},
    "members": [{"name":"lead","tui":"opencode","model":"default","cwd":"/tmp","role":"team-lead"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd opencode default /tmp lead team-lead "$mj"
  [[ "$output" =~ MiniMax-M2.7-highspeed ]]
}

@test "tui resolution: member.command is shell-safe for cwd with spaces" {
  _write_team '{
    "name": "t",
    "members": [{"name":"w","tui":"claude","model":"default","cwd":"/tmp/with space","command":"wrapper"}]
  }'
  local mj; mj=$(jq -c '.members[0]' .atmux/team.json)
  run atmux::tui_cmd claude default "/tmp/with space" w member "$mj"
  # bash printf %q escapes a space as '\ '
  [[ "$output" =~ "/tmp/with\\ space" ]] || [[ "$output" =~ "/tmp/with'\\''space'" ]]
}

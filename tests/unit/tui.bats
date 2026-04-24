#!/usr/bin/env bats
# Unit tests for lib/tui.sh

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
}

teardown() {
  atmux_teardown_sandbox
}

@test "tui: claude default composes CLAUDECODE + model" {
  run atmux::tui_cmd claude default /tmp/p worker team-lead
  [ "$status" -eq 0 ]
  [[ "$output" =~ CLAUDECODE=1 ]]
  [[ "$output" =~ "cd /tmp/p" ]]
  [[ "$output" =~ claude ]]
  [[ "$output" =~ dontAsk ]]
}

@test "tui: claude with explicit model passes --model" {
  run atmux::tui_cmd claude "claude-opus-4-7" /tmp/p worker team-lead
  [[ "$output" =~ "--model claude-opus-4-7" ]]
}

@test "tui: opencode default uses MiniMax model" {
  run atmux::tui_cmd opencode default /tmp/p w member
  [[ "$output" =~ "opencode --model" ]]
  [[ "$output" =~ "MiniMax" ]]
}

@test "tui: opencode with explicit model overrides default" {
  run atmux::tui_cmd opencode "anthropic/claude-3-5-sonnet" /tmp/p w member
  [[ "$output" =~ "anthropic/claude-3-5-sonnet" ]]
  [[ ! "$output" =~ "MiniMax" ]]
}

@test "tui: kimi default uses kimi-latest" {
  run atmux::tui_cmd kimi default /tmp/p w member
  [[ "$output" =~ "kimi --model" ]]
  [[ "$output" =~ "kimi-latest" ]]
}

@test "tui: cursor default uses composer-2" {
  run atmux::tui_cmd cursor default /tmp/p w member
  [[ "$output" =~ "cursor-agent --model" ]]
  [[ "$output" =~ "composer-2" ]]
}

@test "tui: cursor respects ATMUX_CURSOR_BIN override" {
  ATMUX_CURSOR_BIN="my-cursor" run atmux::tui_cmd cursor default /tmp/p w member
  [[ "$output" =~ "my-cursor --model" ]]
}

@test "tui: shell falls through to \$SHELL" {
  run atmux::tui_cmd shell "" /tmp/p w member
  [[ "$output" =~ "cd" ]]
  [[ "$output" =~ "exec" ]]
  [[ "$output" =~ SHELL ]]
}

@test "tui: unknown type dies with hint" {
  run atmux::tui_cmd nopetui "" /tmp/p w member
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown tui type" ]]
}

@test "tui: brief_path picks role-specific brief when present" {
  run atmux::brief_path team-lead
  [[ "$output" =~ team-lead.md$ ]]
}

@test "tui: brief_path falls back to member.md" {
  run atmux::brief_path no-such-role
  [[ "$output" =~ member.md$ ]]
}

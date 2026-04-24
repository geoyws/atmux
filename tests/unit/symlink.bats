#!/usr/bin/env bats
# Make sure atmux works when invoked via a symlink (the install.sh path).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

@test "symlink: atmux invoked via symlink resolves lib/ correctly" {
  local link="$ATMUX_TEST_TMP/atmux-link"
  ln -s "$ATMUX_BIN" "$link"
  run "$link" version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^atmux\ [0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "symlink: atmux invoked via chain of symlinks still resolves" {
  local l1="$ATMUX_TEST_TMP/atmux-l1"
  local l2="$ATMUX_TEST_TMP/atmux-l2"
  ln -s "$ATMUX_BIN" "$l1"
  ln -s "$l1" "$l2"
  run "$l2" help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Usage:" ]]
}

@test "symlink: atmux init via symlink finds templates/" {
  local link="$ATMUX_TEST_TMP/atmux-link"
  ln -s "$ATMUX_BIN" "$link"
  run "$link" init --name via-link
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "via-link" ]
}

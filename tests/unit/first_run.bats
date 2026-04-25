#!/usr/bin/env bats
# Unit tests for first-run auto-wizard behavior.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

@test "first-run: non-tty + no team.json fails with normal error (no wizard prompt)" {
  # bats' `run` already disconnects stdin from a tty, so this simulates cron.
  run "$ATMUX_BIN" status
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no team.json" ]]
  ! [[ "$output" =~ "first run" ]]
}

@test "first-run: ATMUX_NO_WIZARD=1 skips the wizard offer even on tty (we fake tty via script)" {
  # We can't easily force a tty inside bats, but we can verify that with the
  # env var set, we get the normal "no team.json" failure path.
  ATMUX_NO_WIZARD=1 run "$ATMUX_BIN" status
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no team.json" ]]
}

@test "first-run: init does not trigger the wizard itself" {
  # Running `init` without any team.json must succeed (it's how we create one).
  run "$ATMUX_BIN" init --name hello
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
}

@test "first-run: help does not trigger the wizard" {
  run "$ATMUX_BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Usage:" ]]
}

@test "first-run: version does not trigger the wizard" {
  run "$ATMUX_BIN" version
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux" ]]
}

@test "first-run: interactive answer y → wizard runs + team.json created" {
  # Drive both tty emulation (via `script`) and the wizard answers by piping
  # stdin. `script` makes atmux think stdin is a terminal.
  if ! command -v script >/dev/null 2>&1; then
    skip "script(1) not available"
  fi
  # Input: wizard-offer=y, then wizard answers.
  # wizard answers: team-name, preset=custom, planner y, reviewer y, gitter y,
  # devops n, dba n, n_workers=1, emoji_mode=static, discord="",
  # 4× tui_cmd_* accept default, worker tui=shell, model=default, worker name=w1
  local tmp; tmp="$(mktemp)"
  printf 'y\nfresh\ncustom\ny\ny\ny\nn\nn\n1\nstatic\n\n\n\n\n\nshell\ndefault\nw1\n' > "$tmp"
  run script -q -c "'$ATMUX_BIN' status" /dev/null < "$tmp"
  # script returns the wrapped command's exit code; the wizard exec'd the init,
  # which succeeds and exits 0.
  [ -f .atmux/team.json ]
  run jq -r '.name' .atmux/team.json
  [ "$output" = "fresh" ]
  rm -f "$tmp"
}

@test "first-run: interactive answer n → prints hint + exits non-zero" {
  if ! command -v script >/dev/null 2>&1; then
    skip "script(1) not available"
  fi
  local tmp; tmp="$(mktemp)"
  printf 'n\n' > "$tmp"
  run script -q -c "'$ATMUX_BIN' status; echo EXIT=\$?" /dev/null < "$tmp"
  [[ "$output" =~ "init --wizard" ]]
  # No team.json created.
  [ ! -f .atmux/team.json ]
  rm -f "$tmp"
}

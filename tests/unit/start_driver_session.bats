#!/usr/bin/env bats
# Unit tests for `atmux start`'s driverSession bring-up (ADR-044).
#
# When team.json:.driverSession is set, `atmux start` ensures a NAMED
# tmux session exists on the operator's default tmux server (NOT the
# cage / team socket). Idempotent on re-run; non-fatal on tmux failure.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "dst",
  "members": [
    {"name": "alpha", "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "kanban": {"cronAutoInstall": false},
  "supervisor": false,
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  echo '{"pending":[],"inProgress":[],"done":[]}' > .atmux/inboxes/alpha.json
  atmux_disable_down_confirm
}

teardown() {
  # Clean up any default-socket sessions these tests can create. Belt-and-
  # suspenders: kill TEST_DRIVER_SESSION (if set by the test body) AND the
  # well-known names so a test-leaked session can't pollute siblings.
  for s in "${TEST_DRIVER_SESSION:-}" atmux_dst; do
    [[ -z "$s" ]] && continue
    env -u TMUX -u TMUX_TMPDIR tmux kill-session -t "=$s" 2>/dev/null || true
  done
  env -u TMUX -u TMUX_TMPDIR tmux list-sessions -F '#{session_name}' 2>/dev/null \
    | grep '^my-custom-driver-' \
    | xargs -I{} env -u TMUX -u TMUX_TMPDIR tmux kill-session -t "={}" 2>/dev/null || true
  atmux_teardown_sandbox
}

@test "driverSession: absent — no separate session created" {
  TEST_DRIVER_SESSION="dst-test-absent-$$"
  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  ! env -u TMUX -u TMUX_TMPDIR tmux has-session -t "=$TEST_DRIVER_SESSION" 2>/dev/null
}

@test "driverSession: enabled — creates session with default name on default tmux server" {
  TEST_DRIVER_SESSION="atmux_dst"
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  [[ "$output" =~ "driver-session: spawned 'atmux_dst'" ]]
  env -u TMUX -u TMUX_TMPDIR tmux has-session -t "=atmux_dst" 2>/dev/null
}

@test "driverSession: explicit name override is honored" {
  TEST_DRIVER_SESSION="my-custom-driver-$$"
  jq --arg n "$TEST_DRIVER_SESSION" \
     '.driverSession = {name: $n, tui: "shell"}' \
     .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  env -u TMUX -u TMUX_TMPDIR tmux has-session -t "=$TEST_DRIVER_SESSION" 2>/dev/null
}

@test "driverSession: enabled=false — no separate session created" {
  TEST_DRIVER_SESSION="atmux_dst"
  jq '.driverSession = {enabled: false, tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  ! env -u TMUX -u TMUX_TMPDIR tmux has-session -t "=atmux_dst" 2>/dev/null
}

@test "driverSession: idempotent — second start leaves existing session alone" {
  TEST_DRIVER_SESSION="atmux_dst"
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1
  env -u TMUX -u TMUX_TMPDIR tmux has-session -t "=atmux_dst"

  # Capture the session's creation epoch — idempotency means it must not
  # change across the second start. tmux's session_created is monotonic
  # per-session: a recreated session would get a fresh epoch.
  local first_created
  first_created="$(env -u TMUX -u TMUX_TMPDIR tmux display-message -p -t atmux_dst '#{session_created}')"

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  [[ "$output" =~ "driver-session: 'atmux_dst' already exists" ]]

  local second_created
  second_created="$(env -u TMUX -u TMUX_TMPDIR tmux display-message -p -t atmux_dst '#{session_created}')"
  [ "$first_created" = "$second_created" ]
}

@test "driverSession: suppresses in-team driver window when configured" {
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  TEST_DRIVER_SESSION="atmux_dst"

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  # No in-team "driver" window inside the team session
  ! tmux list-windows -t atmux-dst -F '#{window_name}' 2>/dev/null | grep -qx driver
}

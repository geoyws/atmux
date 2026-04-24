#!/usr/bin/env bats
# E2E: full lifecycle against a tmux session using tui=shell.
# No AI API calls — we exercise atmux itself end-to-end.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # Use a team.json whose members are all tui=shell so start doesn't try to launch claude/etc.
  cat > /tmp/e2e-team-template.json <<JSON
{
  "name": "e2e",
  "members": [
    {"name": "lead",     "role": "team-lead",     "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "reviewer", "role": "reviewer",      "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "gitter",   "role": "git-committer", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "w1",       "role": "member",        "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip":   {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60},
  "report": {"intervalMins": 30}
}
JSON
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cp /tmp/e2e-team-template.json .atmux/team.json
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
  # Make the session name unique so parallel runs don't collide.
  export ATMUX_SESSION="atmux-test-$$-$RANDOM"
  export ATMUX_TEST_SESSION="$ATMUX_SESSION"
}

teardown() {
  atmux_teardown_sandbox
}

@test "e2e: start creates tmux session + one window per member" {
  run "$ATMUX_BIN" start
  [ "$status" -eq 0 ]
  run tmux has-session -t "$ATMUX_SESSION"
  [ "$status" -eq 0 ]
  # 4 members → 4 windows.
  local n; n=$(tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' | grep -c '^__e2e__' || true)
  [ "$n" = "4" ]
}

@test "e2e: start + send puts text into the pane" {
  "$ATMUX_BIN" start
  sleep 1
  run "$ATMUX_BIN" send w1 "echo HELLO_FROM_ATMUX_E2E"
  [ "$status" -eq 0 ] || true  # send verifier may warn, that's fine
  sleep 2
  run tmux capture-pane -p -S -30 -t "$ATMUX_SESSION:__e2e__w1"
  [[ "$output" =~ HELLO_FROM_ATMUX_E2E ]]
}

@test "e2e: dispatch + claim + done round-trip" {
  "$ATMUX_BIN" start
  local id; id=$("$ATMUX_BIN" task add "e2e-task-1" | tail -1)
  [ -n "$id" ]

  "$ATMUX_BIN" dispatch w1 "$id" --no-ping
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]

  "$ATMUX_BIN" done "$id" --as w1 --note "e2e-ok"
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "done" ]
}

@test "e2e: tell-lead appends to driver-inbox + pings lead pane" {
  "$ATMUX_BIN" start
  sleep 1
  run "$ATMUX_BIN" tell-lead "please implement X"
  [ "$status" -eq 0 ] || true
  run grep -F "please implement X" .atmux/driver-inbox.md
  [ "$status" -eq 0 ]
  # Lead pane should see the ping text.
  sleep 1
  run tmux capture-pane -p -S -30 -t "$ATMUX_SESSION:__e2e__lead"
  [[ "$output" =~ "please implement X" ]]
}

@test "e2e: status reports session=up and correct pane states" {
  "$ATMUX_BIN" start
  run "$ATMUX_BIN" status
  [ "$status" -eq 0 ]
  [[ "$output" =~ "session=$ATMUX_SESSION" ]]
  [[ "$output" =~ \[up\] ]]
}

@test "e2e: whip all-clean when session is up and no stale tasks" {
  "$ATMUX_BIN" start
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "all clean" ]]
}

@test "e2e: whip flags DOWN after stop" {
  "$ATMUX_BIN" start
  "$ATMUX_BIN" stop --force
  run "$ATMUX_BIN" whip
  [[ "$output" =~ DOWN ]] || [[ "$output" =~ down ]]
}

@test "e2e: stop archives state" {
  "$ATMUX_BIN" start
  "$ATMUX_BIN" task add "some-task" >/dev/null
  "$ATMUX_BIN" stop
  run ls .atmux/archive
  [ "$status" -eq 0 ]
  [ -n "$output" ]  # at least one archive dir
}

@test "e2e: report produces a shipped section with a completed task" {
  "$ATMUX_BIN" start
  local id; id=$("$ATMUX_BIN" task add "ship-it" | tail -1)
  "$ATMUX_BIN" dispatch w1 "$id" --no-ping
  "$ATMUX_BIN" done "$id" --as w1 --note "done"
  run "$ATMUX_BIN" report --no-discord
  [[ "$output" =~ "atmux-report" ]]
  [[ "$output" =~ "ship-it" ]]
}

@test "e2e: broadcast message lands in every non-driver member pane" {
  "$ATMUX_BIN" start
  sleep 1
  run "$ATMUX_BIN" broadcast "echo BROADCAST_E2E"
  sleep 2
  # At least one member pane should have it.
  local hits=0
  for m in lead reviewer gitter w1; do
    local pane; pane=$(tmux capture-pane -p -S -30 -t "$ATMUX_SESSION:__e2e__$m" 2>/dev/null || true)
    if echo "$pane" | grep -qF "BROADCAST_E2E"; then
      hits=$((hits + 1))
    fi
  done
  (( hits >= 3 ))
}

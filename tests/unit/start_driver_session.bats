#!/usr/bin/env bats
# Unit tests for `atmux start`'s driverSession topology (ADR-044).
#
# When team.json:.driverSession is configured, atmux start creates the
# team session with "driver" as the FIRST window (window 1), then spawns
# members AFTER — preserving the declarative topology
# `driver → lead → members` per team.json order.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "dst",
  "members": [
    {"name": "alpha", "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "bee",   "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "kanban": {"cronAutoInstall": false},
  "supervisor": false,
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in alpha bee; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  atmux_disable_down_confirm
}

teardown() {
  atmux_teardown_sandbox
}

@test "driverSession: absent — legacy at-end driver placement (after members)" {
  # Legacy 2026-04-30 behavior: when driverSession is unset but driverTui
  # defaults to "claude", driver window appended AFTER members. ADR-044
  # supersedes this with driverSession-driven at-front placement, but the
  # legacy path persists for backward compat.
  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  local indices
  indices="$(tmux list-windows -t atmux-dst -F '#{window_index}:#{window_name}' | sort -n)"
  # If a driver window exists at all, it must be AFTER alpha and bee
  if echo "$indices" | grep -q ':driver$'; then
    local driver_idx alpha_idx
    driver_idx="$(echo "$indices" | grep ':driver$' | cut -d: -f1)"
    alpha_idx="$(echo "$indices" | grep alpha | cut -d: -f1)"
    [ "$driver_idx" -gt "$alpha_idx" ]
  fi
}

@test "driverSession: configured — driver is window 1, members 2..N in team.json order" {
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  [[ "$output" =~ "driver at window 1" ]]

  local order
  order="$(tmux list-windows -t atmux-dst -F '#{window_index}:#{window_name}' | sort -n)"
  # Window 1 must be the driver
  [[ "$(echo "$order" | head -1)" =~ ^1:driver$ ]]
  # Window 2 must be the lead (alpha)
  [[ "$(echo "$order" | sed -n '2p')" =~ ^2:__dst__.*alpha$ ]]
  # Window 3 must be bee
  [[ "$(echo "$order" | sed -n '3p')" =~ ^3:__dst__.*bee$ ]]
}

@test "driverSession: with explicit tui — that tui runs in driver pane" {
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  # driver window's pane runs a shell (via atmux::tui_cmd's shell branch)
  local pane_cmd
  pane_cmd="$(tmux list-panes -t atmux-dst:driver -F '#{pane_current_command}' 2>/dev/null)"
  [[ "$pane_cmd" =~ ^(zsh|bash|sh)$ ]]
}

@test "driverSession: idempotent — second start leaves running driver alone" {
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1
  local first_created
  first_created="$(tmux display-message -p -t atmux-dst '#{session_created}')"

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]

  local second_created
  second_created="$(tmux display-message -p -t atmux-dst '#{session_created}')"
  [ "$first_created" = "$second_created" ]
}

@test "driverSession: no separate atmux_dst session is created on default socket" {
  jq '.driverSession = {tui: "shell"}' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]
  # ADR-044's earlier separate-session model is dead — a `atmux_dst` session
  # must NOT be created on the default tmux server alongside the team session.
  ! env -u TMUX -u TMUX_TMPDIR tmux has-session -t "=atmux_dst" 2>/dev/null
}

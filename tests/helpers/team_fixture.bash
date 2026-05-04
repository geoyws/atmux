#!/usr/bin/env bash
# tests/helpers/team_fixture.sh — shared team.json fixtures for E2E tests.
#
# Usage: `load '../helpers/team_fixture'` (bats convention) inside a test
# file already loading helpers/setup.bash. Then call
# `atmux_team_fixture_2member [name]` from setup() AFTER atmux_setup_sandbox.
#
# Why a helper: E13/Se's socket-lifecycle E2E + future socket-related
# integration tests all need the same minimal-but-realistic 2-member roster
# (lead + 2 lane-stamped workers) — duplicating the JSON across test files
# drifts the moment one cell needs a `cwd` fix or a new `kanban` toggle.

# 2-member working roster: lead + w1 + w2. lead is required by atmux start's
# topology (the `__<team>__lead` window holds driver-inbox/outbox surfaces);
# the two lane=be workers are the dispatch + cascade targets. Tui=shell so
# `atmux start` doesn't try to spawn a real claude binary.
#
# Args:
#   $1 — team name (default "sl" for socket-lifecycle).
atmux_team_fixture_2member() {
  local team="${1:-sl}"

  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "$team",
  "members": [
    {"name": "lead", "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "w1",   "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "w2",   "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "kanban": {"crossLaneClaim": true},
  "whip":   {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "downConfirmTicks": 1},
  "report": {"intervalMins": 30}
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md
  for m in lead w1 w2; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done

  # Unique session per bats run so parallel CI / repeated invocations don't
  # collide on `atmux-test-<team>` (lifecycle.bats pattern).
  export ATMUX_SESSION="atmux-test-${team}-$$-$RANDOM"
  export ATMUX_TEST_SESSION="$ATMUX_SESSION"
}

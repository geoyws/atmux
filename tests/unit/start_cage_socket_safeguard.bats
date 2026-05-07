#!/usr/bin/env bats
# Unit tests for lib/start.sh:58 cage-socket safeguard (driver-inbox
# 10:16 MYT 2026-05-07 P1 leak fix).
#
# Coverage:
#   1. Project-local cage shape `*/.atmux/tmux*` triggers the safeguard
#      when $TMUX points at a different socket (the bug fix).
#   2. ADR-018 shared cage shape `*/atmux-tmux*` continues to trigger
#      (regression guard for the existing arm).
#   3. $TMUX unset = no safeguard fires (cron / fresh-shell path).
#   4. $TMUX set + matching cage socket = no safeguard fires
#      (already-attached path).
#
# All four assertions exercise lib/start.sh:58 directly via bash -c
# rather than `atmux start` end-to-end — the safeguard is the FIRST
# action of the verb body, exits non-zero on mismatch with stderr
# `cage-socket mismatch:`, so the unit-level assertion is sufficient
# (no need to spin up tmux).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  rm -rf "$ATMUX_TEST_TMP"
}

# ---- 1. project-local shape (the bug fix) ----

@test "cage-socket safeguard: project-local TMUX_TMPDIR + mismatching \$TMUX → refuse" {
  # Set up a team.json with project-local tmuxTmpdir.
  mkdir -p .atmux
  cat > .atmux/team.json <<JSON
{
  "name": "p1leak",
  "tmuxTmpdir": "$ATMUX_TEST_TMP/project/.atmux/tmux",
  "members": [
    {"name": "lead", "role": "team-lead", "lane": "misc", "tui": "shell"}
  ],
  "supervisor": false,
  "driverTui": false
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  # Simulate "running from inside daily-driver tmux on a different socket":
  # TMUX_TMPDIR points at the project-local cage; $TMUX points at a
  # /tmp/different-socket,123,0 form (daily-driver convention).
  run env \
    TMUX_TMPDIR="$ATMUX_TEST_TMP/project/.atmux/tmux" \
    TMUX="/tmp/daily-driver-socket,99,0" \
    "$ATMUX_BIN" --team-dir "$ATMUX_TEST_TMP/project" start --no-doctor
  [[ "$status" -ne 0 ]]
  [[ "$output" == *"cage-socket mismatch"* ]]
  [[ "$output" == *"$ATMUX_TEST_TMP/project/.atmux/tmux/tmux-"* ]]
  [[ "$output" == *"env -u TMUX atmux start"* ]]
}

# ---- 2. shared ADR-018 shape (regression guard) ----

@test "cage-socket safeguard: ADR-018 /tmp/atmux-tmux_<team> shape still refuses" {
  mkdir -p .atmux
  cat > .atmux/team.json <<JSON
{
  "name": "shared",
  "tmuxTmpdir": "/tmp/atmux-tmux_shared",
  "members": [
    {"name": "lead", "role": "team-lead", "lane": "misc", "tui": "shell"}
  ],
  "supervisor": false,
  "driverTui": false
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  run env \
    TMUX_TMPDIR="/tmp/atmux-tmux_shared" \
    TMUX="/tmp/daily-driver-socket,99,0" \
    "$ATMUX_BIN" --team-dir "$ATMUX_TEST_TMP/project" start --no-doctor
  [[ "$status" -ne 0 ]]
  [[ "$output" == *"cage-socket mismatch"* ]]
}

# ---- 3. $TMUX unset → no safeguard fires ----

@test "cage-socket safeguard: \$TMUX unset bypasses the gate (cron / fresh shell)" {
  mkdir -p .atmux
  cat > .atmux/team.json <<JSON
{
  "name": "cron",
  "tmuxTmpdir": "$ATMUX_TEST_TMP/project/.atmux/tmux",
  "members": [
    {"name": "lead", "role": "team-lead", "lane": "misc", "tui": "shell"}
  ],
  "supervisor": false,
  "driverTui": false
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  # No TMUX env var — safeguard's `&& -n "${TMUX:-}"` clause filters out.
  # Whatever happens next (session creation may succeed or fail on
  # other gates), the cage-socket safeguard MUST NOT fire.
  run env \
    -u TMUX \
    TMUX_TMPDIR="$ATMUX_TEST_TMP/project/.atmux/tmux" \
    "$ATMUX_BIN" --team-dir "$ATMUX_TEST_TMP/project" start --no-doctor
  [[ "$output" != *"cage-socket mismatch"* ]]
}

# ---- 4. $TMUX set + matching cage socket → no safeguard fires ----

@test "cage-socket safeguard: \$TMUX matches cage socket → already-attached, no refuse" {
  mkdir -p .atmux
  local cage_dir="$ATMUX_TEST_TMP/project/.atmux/tmux"
  local cage_sock="$cage_dir/tmux-$(id -u)/default"
  cat > .atmux/team.json <<JSON
{
  "name": "attached",
  "tmuxTmpdir": "$cage_dir",
  "members": [
    {"name": "lead", "role": "team-lead", "lane": "misc", "tui": "shell"}
  ],
  "supervisor": false,
  "driverTui": false
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  # TMUX format is `<socket-path>,<pid>,<session-id>` — only the prefix
  # before the first comma is checked by the safeguard.
  run env \
    TMUX_TMPDIR="$cage_dir" \
    TMUX="${cage_sock},42,0" \
    "$ATMUX_BIN" --team-dir "$ATMUX_TEST_TMP/project" start --no-doctor
  # The mismatch error specifically must NOT appear. Other errors
  # downstream are fine (e.g., the session may fail to create on the
  # nonexistent cage path) — those are not what this test gates.
  [[ "$output" != *"cage-socket mismatch"* ]]
}

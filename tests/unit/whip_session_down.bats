#!/usr/bin/env bats
# Unit tests for the two-tick session-DOWN confirmation gate — E6/S1 / t-84c315eb.
# Coverage for BE task t-9e85a35c (lib/whip.sh _atmux_whip_session_state_check).
#
# AC:
#   1. First DOWN tick is silent (no '🛑 session DOWN' finding); state file
#      tracks {lastDown.count: 1}.
#   2. Second consecutive DOWN tick fires (findings include the alert);
#      state file tracks {count: 2}.
#   3. UP observation after a DOWN tick wipes lastDown (count: 0).
#   4. team.json whip.downConfirmTicks=3 ⇒ third tick is the firing tick.
#
# Approach: source lib/{common,whip}.sh + drive the state-machine helper
# directly. atmux::tmux_session_exists is overridden in-shell to control
# UP/DOWN — cheaper than spawning real tmux servers, and the helper is
# what governs the FE-visible contract anyway. A complementary e2e test
# at the bottom asserts the inert-sandbox `atmux whip` flow surfaces the
# alert exactly on tick N (default threshold 2).
#
# bats `run` captures both stdout AND stderr in this version; the helper
# emits log lines on stderr via atmux::log. Tests use direct
# `out=$(... 2>/dev/null)` capture to isolate the printed state-machine
# verdict (`up`/`report`/`suppress`) from the log noise.
#
# Per memory feedback_orphan_test_staging.md: the parent BE (t-9e85a35c)
# is `done` — this .bats file is safe to git add when the worker stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
  # The inert sandbox has no tmux session — `tmux has-session -t atmux-w`
  # returns 1 by default, so the helper-direct tests don't need to mock
  # DOWN until they explicitly need UP. Tests that need UP override the
  # function in their own scope (per-`@test` shell isolation).
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

_load_libs() {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
}

_state_field() {
  jq -r "$1" .atmux/state/whip-session-state.json 2>/dev/null
}

# Capture stdout-only verdict from the state-machine helper.
_tick() {
  _atmux_whip_session_state_check 2>/dev/null
}

# ---------- AC test 1: first DOWN tick is silent ----------

@test "session_down: tick 1 returns 'suppress' + state {lastDown.count: 1} (silent first tick)" {
  _load_libs
  local out; out=$(_tick)
  [ "$out" = "suppress" ]
  [ -f .atmux/state/whip-session-state.json ]
  [ "$(_state_field '.lastDown.count')" = "1" ]
  # Epoch present + numeric.
  local epoch; epoch=$(_state_field '.lastDown.epoch')
  [[ "$epoch" =~ ^[0-9]+$ ]]
}

# ---------- AC test 2: second consecutive DOWN tick fires ----------

@test "session_down: tick 2 returns 'report' + state {lastDown.count: 2} (alert fires)" {
  _load_libs
  _tick >/dev/null   # tick 1 — suppress
  local out; out=$(_tick)
  [ "$out" = "report" ]
  [ "$(_state_field '.lastDown.count')" = "2" ]
}

@test "session_down: subsequent DOWN ticks (count >= threshold) keep returning 'report'" {
  # Defends a regression where the helper might one-shot the alert and
  # then go silent — we want each DOWN tick past threshold to keep firing
  # so a real outage stays visible until UP recovery.
  _load_libs
  _tick >/dev/null   # 1 - suppress
  _tick >/dev/null   # 2 - report
  local out
  out=$(_tick); [ "$out" = "report" ]            # 3
  [ "$(_state_field '.lastDown.count')" = "3" ]
  out=$(_tick); [ "$out" = "report" ]            # 4
  [ "$(_state_field '.lastDown.count')" = "4" ]
}

# ---------- AC test 3: UP observation resets ----------

@test "session_down: UP after a DOWN tick wipes lastDown (count -> 0, lastDown null)" {
  _load_libs
  _tick >/dev/null
  [ "$(_state_field '.lastDown.count')" = "1" ]

  # Override session-exists to UP for the next tick.
  atmux::tmux_session_exists() { return 0; }
  local out; out=$(_tick)
  [ "$out" = "up" ]
  # `del(.lastDown)` ⇒ field is absent.
  [ "$(jq -r '.lastDown // null' .atmux/state/whip-session-state.json)" = "null" ]
}

@test "session_down: UP at tick 1 (no prior DOWN) is a clean no-op (no state churn)" {
  _load_libs
  atmux::tmux_session_exists() { return 0; }
  local out; out=$(_tick)
  [ "$out" = "up" ]
  [ "$(jq -r '.lastDown // null' .atmux/state/whip-session-state.json)" = "null" ]
}

@test "session_down: DOWN -> UP -> DOWN restarts the counter from 1 (not from prior peak)" {
  _load_libs
  _tick >/dev/null   # DOWN tick 1
  _tick >/dev/null   # DOWN tick 2 (report)
  [ "$(_state_field '.lastDown.count')" = "2" ]

  atmux::tmux_session_exists() { return 0; }   # UP — wipes counter
  _tick >/dev/null
  [ "$(jq -r '.lastDown // null' .atmux/state/whip-session-state.json)" = "null" ]

  # Back to DOWN — counter must restart at 1 (silent), NOT carry a stale 2.
  unset -f atmux::tmux_session_exists
  local out; out=$(_tick)
  [ "$out" = "suppress" ]
  [ "$(_state_field '.lastDown.count')" = "1" ]
}

# ---------- AC test 4: configurable threshold via team.json ----------

@test "session_down: team.json whip.downConfirmTicks=3 ⇒ tick 3 is the firing tick" {
  _load_libs
  jq '.whip.downConfirmTicks = 3' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  local out
  out=$(_tick); [ "$out" = "suppress" ]   # tick 1
  out=$(_tick); [ "$out" = "suppress" ]   # tick 2
  out=$(_tick); [ "$out" = "report" ]     # tick 3 — fires
  [ "$(_state_field '.lastDown.count')" = "3" ]
}

@test "session_down: team.json whip.downConfirmTicks=1 ⇒ tick 1 is the firing tick (no two-tick gate)" {
  _load_libs
  jq '.whip.downConfirmTicks = 1' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  local out; out=$(_tick)
  [ "$out" = "report" ]
  [ "$(_state_field '.lastDown.count')" = "1" ]
}

@test "session_down: team.json garbage downConfirmTicks ⇒ falls back to default 2" {
  _load_libs
  # Non-integer string. jq's `// 2` doesn't catch this; the post-jq regex
  # guard in the helper is what enforces fallback to 2.
  jq '.whip.downConfirmTicks = "abc"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  local out
  out=$(_tick); [ "$out" = "suppress" ]   # tick 1 — silent under default 2
  out=$(_tick); [ "$out" = "report" ]     # tick 2 — fires
}

# ---------- e2e: full atmux whip pipeline honors the gate ----------

@test "session_down (e2e): inert sandbox + default threshold ⇒ tick 1 silent, tick 2 emits '🛑 session DOWN'" {
  rm -f .atmux/state/whip-session-state.json
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "session "[a-zA-Z-]*" is DOWN" ]]
  [ "$(_state_field '.lastDown.count')" = "1" ]

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "DOWN" ]]
  [ "$(_state_field '.lastDown.count')" = "2" ]
}

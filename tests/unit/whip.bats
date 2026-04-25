#!/usr/bin/env bats
# Unit tests for atmux whip

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "whip: flags session DOWN when no tmux session exists" {
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "DOWN" ]] || [[ "$output" =~ "down" ]]
}

@test "whip: logs to .atmux/logs/whip.log" {
  "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  [ -f .atmux/logs/whip.log ]
}

@test "whip: STALE_MIN env var is respected" {
  # We can't fully exercise without a live tmux session, but we can verify
  # the command runs with the env var without erroring out.
  ATMUX_STALE_MIN=1 ATMUX_LEAD_MAX_MIN=1 run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
}

# ---- decisions cursor (ADR-008 / T10.2) ----

@test "whip: no-op silently when .atmux/decisions.md is absent" {
  [ ! -f .atmux/decisions.md ]
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [ ! -f .atmux/state/decisions-cursor ]
}

@test "whip: flags new decisions and creates cursor on first tick" {
  "$ATMUX_BIN" decisions add "Q1?" --default "A1" >/dev/null
  "$ATMUX_BIN" decisions add "Q2?" --default "A2" >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "2 new decisions" ]]
  [[ "$output" =~ "atmux decisions list" ]]
  [ -f .atmux/state/decisions-cursor ]
}

@test "whip: cursor suppresses re-flagging on the next tick" {
  "$ATMUX_BIN" decisions add "Stale Q?" --default "A" >/dev/null
  "$ATMUX_BIN" whip >/dev/null
  # Second tick with no new entries — pointer must NOT appear.
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ ! "$output" =~ "new decision" ]]
}

@test "whip: stale_anchor returns max(claimed, rotated.epoch) — rotation overrides stale anchor (E2/S7 t-59ffacfd)" {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"

  mkdir -p .atmux/state

  # No rotated.epoch ⇒ falls through to claimed.
  rm -f .atmux/state/w1-rotated.epoch
  run _atmux_whip_stale_anchor w1 1500
  [ "$output" = "1500" ]

  # Rotated.epoch newer than claimed ⇒ rotated wins (a fresh rotation makes
  # the prior claimedAt irrelevant for stale-task gating).
  echo 2000 > .atmux/state/w1-rotated.epoch
  run _atmux_whip_stale_anchor w1 1500
  [ "$output" = "2000" ]

  # Rotated.epoch older than claimed ⇒ claimed wins.
  echo 100 > .atmux/state/w1-rotated.epoch
  run _atmux_whip_stale_anchor w1 1500
  [ "$output" = "1500" ]

  # Garbage in the file ⇒ treated as 0.
  echo "junk" > .atmux/state/w1-rotated.epoch
  run _atmux_whip_stale_anchor w1 1500
  [ "$output" = "1500" ]

  # Empty/missing claimed arg ⇒ 0.
  rm -f .atmux/state/w1-rotated.epoch
  run _atmux_whip_stale_anchor w1
  [ "$output" = "0" ]
}



@test "whip: pointer survives session-DOWN early-exit path" {
  # Decisions check must be independent of tmux session liveness — under
  # the bats sandbox no session exists, so this exercises the early-return
  # branch where session is DOWN.
  "$ATMUX_BIN" decisions add "Down-path Q?" --default "A" >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "DOWN" ]]
  [[ "$output" =~ "1 new decisions" ]]
  [ -f .atmux/state/decisions-cursor ]
}

#!/usr/bin/env bats
# Unit tests for whip's auto-stop-on-idle behavior (ADR-043).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
  atmux_disable_down_confirm
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
}

teardown() {
  atmux_teardown_sandbox
}

@test "autoStop: disabled by default — counter never written" {
  _atmux_whip_check_auto_stop 1
  _atmux_whip_check_auto_stop 1
  [ ! -f .atmux/state/whip-idle-state.json ]
}

@test "autoStop: idle ticks accumulate when threshold > 0" {
  jq '.whip.autoStopAfterIdleTicks = 5' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  _atmux_whip_check_auto_stop 1
  [ "$(jq -r '.idleTicks' .atmux/state/whip-idle-state.json)" = "1" ]

  _atmux_whip_check_auto_stop 1
  [ "$(jq -r '.idleTicks' .atmux/state/whip-idle-state.json)" = "2" ]

  _atmux_whip_check_auto_stop 1
  [ "$(jq -r '.idleTicks' .atmux/state/whip-idle-state.json)" = "3" ]
}

@test "autoStop: activity tick clears non-zero counter" {
  jq '.whip.autoStopAfterIdleTicks = 5' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  _atmux_whip_check_auto_stop 1
  _atmux_whip_check_auto_stop 1
  [ "$(jq -r '.idleTicks' .atmux/state/whip-idle-state.json)" = "2" ]

  _atmux_whip_check_auto_stop 0
  [ "$(jq -r '.idleTicks // null' .atmux/state/whip-idle-state.json)" = "null" ]
}

@test "autoStop: threshold reached invokes atmux stop and clears counter" {
  jq '.whip.autoStopAfterIdleTicks = 2' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  # Shadow the bin with a stub so the stop call is observable without
  # touching tmux. The shim writes a marker file; whip looks up
  # $ATMUX_BIN_DIR/atmux so we redirect that var to our stub dir.
  local stub_dir
  stub_dir="$ATMUX_TEST_TMP/stub-bin"
  mkdir -p "$stub_dir"
  cat >"$stub_dir/atmux" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "stop" ]]; then
  : > "$ATMUX_TEST_TMP/stop-was-called"
  exit 0
fi
exec "$ATMUX_REPO_ROOT/bin/atmux" "$@"
SH
  chmod +x "$stub_dir/atmux"
  ATMUX_BIN_DIR="$stub_dir"

  _atmux_whip_check_auto_stop 1   # idleTicks=1 < 2
  [ ! -f "$ATMUX_TEST_TMP/stop-was-called" ]

  _atmux_whip_check_auto_stop 1   # idleTicks=2 == threshold → stop
  [ -f "$ATMUX_TEST_TMP/stop-was-called" ]
  [ "$(jq -r '.idleTicks // null' .atmux/state/whip-idle-state.json)" = "null" ]
}

@test "autoStop: non-numeric config falls back to disabled" {
  jq '.whip.autoStopAfterIdleTicks = "garbage"' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json

  _atmux_whip_check_auto_stop 1
  [ ! -f .atmux/state/whip-idle-state.json ]
}

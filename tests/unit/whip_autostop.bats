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

# ---------- ADR-052 eternal-improvement intercept (t-a3a0e5b1) ----------

# Shared stub builder: shadows $ATMUX_BIN_DIR/atmux to make `improve`
# and `stop` invocations observable without touching tmux. Each
# subcommand drops a marker file in $ATMUX_TEST_TMP so the test can
# assert which path fired.
_setup_atmux_stub() {
  local stub_dir="$ATMUX_TEST_TMP/stub-bin"
  mkdir -p "$stub_dir"
  cat >"$stub_dir/atmux" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  stop)    : > "$ATMUX_TEST_TMP/stop-was-called" ;;
  improve) : > "$ATMUX_TEST_TMP/improve-was-called"
           # Optional: set ATMUX_TEST_IMPROVE_EXIT to 1 to simulate failure.
           exit "${ATMUX_TEST_IMPROVE_EXIT:-0}" ;;
  *)       exec "$ATMUX_REPO_ROOT/bin/atmux" "$@" ;;
esac
SH
  chmod +x "$stub_dir/atmux"
  ATMUX_BIN_DIR="$stub_dir"
}

@test "autoStop: ADR-052 — no eternal-improvement state file → invokes improve, skips stop" {
  jq '.whip.autoStopAfterIdleTicks = 2' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _setup_atmux_stub

  _atmux_whip_check_auto_stop 1   # idleTicks=1 < 2
  _atmux_whip_check_auto_stop 1   # idleTicks=2 == threshold → intercept fires

  [ -f "$ATMUX_TEST_TMP/improve-was-called" ]
  [ ! -f "$ATMUX_TEST_TMP/stop-was-called" ]
}

@test "autoStop: ADR-052 — eternal-improvement.active=true falls through to atmux stop" {
  jq '.whip.autoStopAfterIdleTicks = 2' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _setup_atmux_stub

  mkdir -p .atmux/state
  echo '{"active":true,"runId":"ei-deadbeef","cycleN":3}' > .atmux/state/eternal-improvement.json

  _atmux_whip_check_auto_stop 1
  _atmux_whip_check_auto_stop 1   # threshold met → improve already active → fall through

  [ ! -f "$ATMUX_TEST_TMP/improve-was-called" ]
  [ -f "$ATMUX_TEST_TMP/stop-was-called" ]
}

@test "autoStop: ADR-052 — eternal-improvement.active=false invokes improve, skips stop" {
  jq '.whip.autoStopAfterIdleTicks = 2' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _setup_atmux_stub

  mkdir -p .atmux/state
  echo '{"active":false,"runId":"ei-prevrun"}' > .atmux/state/eternal-improvement.json

  _atmux_whip_check_auto_stop 1
  _atmux_whip_check_auto_stop 1   # threshold met → improve not active → invoke

  [ -f "$ATMUX_TEST_TMP/improve-was-called" ]
  [ ! -f "$ATMUX_TEST_TMP/stop-was-called" ]
}

@test "autoStop: ADR-052 — improve invocation failure falls through to atmux stop" {
  jq '.whip.autoStopAfterIdleTicks = 2' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _setup_atmux_stub
  export ATMUX_TEST_IMPROVE_EXIT=1

  _atmux_whip_check_auto_stop 1
  _atmux_whip_check_auto_stop 1   # improve invoked + fails → fall through

  [ -f "$ATMUX_TEST_TMP/improve-was-called" ]
  [ -f "$ATMUX_TEST_TMP/stop-was-called" ]
  unset ATMUX_TEST_IMPROVE_EXIT
}

@test "autoStop: ADR-052 — malformed eternal-improvement.json treated as not-active (invokes improve)" {
  jq '.whip.autoStopAfterIdleTicks = 2' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  _setup_atmux_stub

  mkdir -p .atmux/state
  echo 'not-json{' > .atmux/state/eternal-improvement.json

  _atmux_whip_check_auto_stop 1
  _atmux_whip_check_auto_stop 1

  [ -f "$ATMUX_TEST_TMP/improve-was-called" ]
  [ ! -f "$ATMUX_TEST_TMP/stop-was-called" ]
}

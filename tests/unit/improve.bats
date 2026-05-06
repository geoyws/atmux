#!/usr/bin/env bats
# Unit tests for `atmux improve` — bash side parity (ADR-052 T4).
# Mirrors TS test names where applicable so the parity matrix can pick
# them up later (cross-ref ADR-026 if/when these rows go into the matrix).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name imp >/dev/null
  # Source the lib for direct function-level tests.
  # shellcheck source=../../lib/common.sh
  . "$ATMUX_LIB_DIR/common.sh"
  # shellcheck source=../../lib/improve.sh
  . "$ATMUX_LIB_DIR/improve.sh"
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- T2 primitives — _atmux_improve_state_path ----------

@test "_atmux_improve_state_path: returns <atmuxDir>/state/eternal-improvement.json" {
  run _atmux_improve_state_path
  [ "$status" -eq 0 ]
  [[ "$output" =~ /\.atmux/state/eternal-improvement\.json$ ]]
}

# ---------- T2 primitives — _atmux_improve_state_read ----------

@test "_atmux_improve_state_read: missing file → '{}'" {
  run _atmux_improve_state_read
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "_atmux_improve_state_read: populated file → cats contents" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"active":true,"runId":"ei-deadbeef"}\n' > "$f"
  run _atmux_improve_state_read
  [ "$status" -eq 0 ]
  [[ "$output" == *'ei-deadbeef'* ]]
}

# ---------- T2 primitives — _atmux_improve_state_write_jq ----------

@test "_atmux_improve_state_write_jq: writes via jq filter (creates file on first call)" {
  _atmux_improve_state_write_jq '{cycleN: 1, active: true}'
  local f; f="$(_atmux_improve_state_path)"
  [ -f "$f" ]
  run jq -r '.cycleN' "$f"
  [ "$output" = "1" ]
  run jq -r '.active' "$f"
  [ "$output" = "true" ]
}

@test "_atmux_improve_state_write_jq: re-write modifies existing file via filter" {
  _atmux_improve_state_write_jq '{cycleN: 1}'
  _atmux_improve_state_write_jq '.cycleN = 7'
  local f; f="$(_atmux_improve_state_path)"
  run jq -r '.cycleN' "$f"
  [ "$output" = "7" ]
}

@test "_atmux_improve_state_write_jq: contended sidecar → non-fatal skip + log line" {
  _atmux_improve_state_write_jq '{cycleN: 3}'
  local f; f="$(_atmux_improve_state_path)"
  # Hold the sidecar lock from a separate FD, then attempt a write.
  exec 9>"${f}.lock"
  flock 9
  run _atmux_improve_state_write_jq '.cycleN = 99'
  exec 9>&-
  [ "$status" -eq 0 ]                  # non-fatal
  [[ "$output" == *"locked, skipping"* ]]
  # Value unchanged.
  run jq -r '.cycleN' "$f"
  [ "$output" = "3" ]
}

# ---------- T1 budget-spec parser — _atmux_improve_parse_spec ----------

@test "_atmux_improve_parse_spec: '1000000' → raw 1000000" {
  run _atmux_improve_parse_spec "1000000"
  [ "$status" -eq 0 ]
  [ "$output" = "raw 1000000" ]
}

@test "_atmux_improve_parse_spec: '30%' → pct-wk 30" {
  run _atmux_improve_parse_spec "30%"
  [ "$status" -eq 0 ]
  [ "$output" = "pct-wk 30" ]
}

@test "_atmux_improve_parse_spec: '50%-5h' → pct-5h 50" {
  run _atmux_improve_parse_spec "50%-5h"
  [ "$status" -eq 0 ]
  [ "$output" = "pct-5h 50" ]
}

@test "_atmux_improve_parse_spec: '30%-wk' → pct-wk 30" {
  run _atmux_improve_parse_spec "30%-wk"
  [ "$status" -eq 0 ]
  [ "$output" = "pct-wk 30" ]
}

@test "_atmux_improve_parse_spec: '101%' rejected (>100)" {
  run _atmux_improve_parse_spec "101%"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_parse_spec: 'abc' rejected (malformed)" {
  run _atmux_improve_parse_spec "abc"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_parse_spec: '30%-day' rejected (unknown window)" {
  run _atmux_improve_parse_spec "30%-day"
  [ "$status" -ne 0 ]
}

# ---------- T1 budget resolver — _atmux_improve_resolve_budget ----------

@test "_atmux_improve_resolve_budget: raw kind echoes total + formula" {
  run _atmux_improve_resolve_budget "raw" "1000000"
  [ "$status" -eq 0 ]
  [[ "$output" == *"1000000"* ]]
  [[ "$output" == *"raw=1000000"* ]]
}

@test "_atmux_improve_resolve_budget: pct-wk requires probe, fails without" {
  run _atmux_improve_resolve_budget "pct-wk" "30"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_resolve_budget: pct-wk with probe computes total" {
  # Mock the probe at .atmux/state/budget-probe-imp.json
  local probe; probe="$(atmux::state_dir)/budget-probe-$(atmux::team_name).json"
  mkdir -p "$(dirname "$probe")"
  printf '{"h5_util":0,"wk_util":0}\n' > "$probe"
  run _atmux_improve_resolve_budget "pct-wk" "30"
  [ "$status" -eq 0 ]
  # 30% × 100M = 30M
  [[ "$output" == *"30000000"* ]]
}

@test "_atmux_improve_resolve_budget: pct-5h with probe + util > 0" {
  local probe; probe="$(atmux::state_dir)/budget-probe-$(atmux::team_name).json"
  mkdir -p "$(dirname "$probe")"
  printf '{"h5_util":0.5,"wk_util":0}\n' > "$probe"
  run _atmux_improve_resolve_budget "pct-5h" "50"
  [ "$status" -eq 0 ]
  # 50% × (1-0.5) × 5M = 1.25M
  [[ "$output" == *"1250000"* ]]
}

# ---------- T1 precedence resolver — _atmux_improve_resolve_spec ----------

@test "_atmux_improve_resolve_spec: CLI wins over env + team.json + default" {
  ATMUX_IMPROVE_BUDGET="50%-5h" run _atmux_improve_resolve_spec "1000000"
  [ "$status" -eq 0 ]
  [ "$output" = "1000000" ]
}

@test "_atmux_improve_resolve_spec: env wins when no CLI" {
  ATMUX_IMPROVE_BUDGET="50%-5h" run _atmux_improve_resolve_spec ""
  [ "$status" -eq 0 ]
  [ "$output" = "50%-5h" ]
}

@test "_atmux_improve_resolve_spec: team.json wins when no CLI + no env" {
  # Inject team.improve.defaultBudget via jq.
  atmux::jq_update "$(atmux::team_json)" '.improve = {defaultBudget: "10%-wk"}'
  unset ATMUX_IMPROVE_BUDGET
  run _atmux_improve_resolve_spec ""
  [ "$status" -eq 0 ]
  [ "$output" = "10%-wk" ]
}

@test "_atmux_improve_resolve_spec: default 30%-wk when nothing set" {
  unset ATMUX_IMPROVE_BUDGET
  run _atmux_improve_resolve_spec ""
  [ "$status" -eq 0 ]
  [ "$output" = "30%-wk" ]
}

# ---------- T1 idempotence — _atmux_improve_is_active ----------

@test "_atmux_improve_is_active: active=false → not active" {
  run _atmux_improve_is_active '{"active":false,"startedAt":0}'
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_active: active=true + recent start → active" {
  local now; now="$(atmux::now_epoch)"
  run _atmux_improve_is_active "$(jq -nc --argjson n "$now" '{active:true,startedAt:$n,currentCycle:null}')"
  [ "$status" -eq 0 ]
}

@test "_atmux_improve_is_active: active=true + 30h-old start + no recent cycle → not active (stale)" {
  local now thirty_h_ago
  now="$(atmux::now_epoch)"
  thirty_h_ago=$(( now - 30 * 3600 ))
  run _atmux_improve_is_active "$(jq -nc --argjson s "$thirty_h_ago" '{active:true,startedAt:$s,currentCycle:null}')"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_active: active=true + 30h-old start + recent currentCycle (1h ago) → active" {
  local now thirty_h_ago one_h_ago
  now="$(atmux::now_epoch)"
  thirty_h_ago=$(( now - 30 * 3600 ))
  one_h_ago=$(( now - 3600 ))
  run _atmux_improve_is_active "$(jq -nc --argjson s "$thirty_h_ago" --argjson c "$one_h_ago" '{active:true,startedAt:$s,currentCycle:{startedAt:$c}}')"
  [ "$status" -eq 0 ]
}

# ---------- atmux improve --status (end-to-end via bin/atmux) ----------

@test "atmux improve --status: missing state-file → emits {} on stdout, exit 0" {
  run "$ATMUX_BIN" improve --status
  [ "$status" -eq 0 ]
  [ "$output" = "{}" ]
}

@test "atmux improve --status: existing state-file → emits its JSON, exit 0" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"active":true,"runId":"ei-cafef00d","mode":"user-invoked"}\n' > "$f"
  run "$ATMUX_BIN" improve --status
  [ "$status" -eq 0 ]
  [[ "$output" == *"ei-cafef00d"* ]]
}

# ---------- atmux improve --dry-run (end-to-end) ----------

@test "atmux improve --dry-run --budget <int>: prints formula + state path, no writes" {
  run "$ATMUX_BIN" improve --dry-run --budget 1000000
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [[ "$output" == *"1000000"* ]]
  [[ "$output" == *"raw=1000000"* ]]
  [[ "$output" == *"eternal-improvement.json"* ]]
  # No state file written.
  local f; f="$(_atmux_improve_state_path)"
  [ ! -f "$f" ]
}

@test "atmux improve --dry-run with default 30%-wk + no probe → fail-closed" {
  run "$ATMUX_BIN" improve --dry-run
  [ "$status" -ne 0 ]
}

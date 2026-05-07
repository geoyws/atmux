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

# ---------- T7 cycle mechanics ----------

@test "_atmux_improve_build_arm_message: includes cycle number + planner-routing prompt" {
  run _atmux_improve_build_arm_message 3
  [ "$status" -eq 0 ]
  [[ "$output" == *"cycle 3 requested"* ]]
  [[ "$output" == *"ask each lane member"* ]]
}

@test "_atmux_improve_arm_directive: writes header + entry on first call" {
  _atmux_improve_arm_directive "ei-deadbeef" 1
  local f; f="$(_atmux_improve_directives_path)"
  [ -f "$f" ]
  run cat "$f"
  [[ "$output" == *"Improve Directives"* ]]
  [[ "$output" == *"## Open"* ]]
  [[ "$output" == *"runId=ei-deadbeef"* ]]
  [[ "$output" == *"cycle=1"* ]]
}

@test "_atmux_improve_arm_directive: appends to existing file (no header dup)" {
  _atmux_improve_arm_directive "ei-first" 1
  _atmux_improve_arm_directive "ei-second" 2
  local f; f="$(_atmux_improve_directives_path)"
  run grep -c "Improve Directives" "$f"
  [ "$output" = "1" ]
  run grep -c "Improve Directives — eternal-improvement cycle prompts" "$f"
  [ "$output" = "1" ]
  run grep -c "ei-first\|ei-second" "$f"
  [ "$output" = "2" ]
}

@test "_atmux_improve_cycle_open: increments cycleN + initializes currentCycle" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"active":true,"runId":"ei-r","startedAt":1,"mode":"user-invoked","budgetSpec":"1000000","budgetTotal":1000000,"budgetRemaining":1000000,"cycleN":0,"currentCycle":null,"lastCycleClosedAt":null,"history":[]}\n' > "$f"
  _atmux_improve_cycle_open "$f" 1700000500
  run jq '.cycleN' "$f"
  [ "$output" = "1" ]
  run jq -r '.currentCycle.startedAt' "$f"
  [ "$output" = "1700000500" ]
  run jq -r '.currentCycle.tasksDispatched' "$f"
  [ "$output" = "[]" ]
}

@test "_atmux_improve_cycle_close: moves cycle to history + decrements budget" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{
  "active": true,
  "runId": "ei-r",
  "startedAt": 1,
  "mode": "user-invoked",
  "budgetSpec": "1000000",
  "budgetTotal": 1000000,
  "budgetRemaining": 1000000,
  "cycleN": 1,
  "currentCycle": {
    "startedAt": 100,
    "tasksLanded": ["t-a","t-b"],
    "tasksDispatched": ["t-a","t-b"],
    "tasksDone": ["t-a","t-b"],
    "tokensSpent": 50000
  },
  "lastCycleClosedAt": null,
  "history": []
}
EOF
  _atmux_improve_cycle_close "$f" 200 0
  run jq -r '.currentCycle' "$f"
  [ "$output" = "null" ]
  run jq '.budgetRemaining' "$f"
  [ "$output" = "950000" ]
  run jq '.history | length' "$f"
  [ "$output" = "1" ]
  run jq '.history[0].tasksDone' "$f"
  [ "$output" = "2" ]
  run jq '.lastCycleClosedAt' "$f"
  [ "$output" = "200" ]
}

@test "_atmux_improve_cycle_close: applies tokensSpentDelta on top of currentCycle.tokensSpent" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{
  "active": true,
  "runId": "ei-r",
  "startedAt": 1,
  "mode": "user-invoked",
  "budgetSpec": "1000000",
  "budgetTotal": 1000000,
  "budgetRemaining": 1000000,
  "cycleN": 1,
  "currentCycle": {
    "startedAt": 100,
    "tasksLanded": ["t-a"],
    "tasksDispatched": ["t-a"],
    "tasksDone": ["t-a"],
    "tokensSpent": 1000
  },
  "lastCycleClosedAt": null,
  "history": []
}
EOF
  _atmux_improve_cycle_close "$f" 200 4000
  # tokensSpent 1000 + delta 4000 = 5000 → budget 1000000 - 5000 = 995000
  run jq '.budgetRemaining' "$f"
  [ "$output" = "995000" ]
  run jq '.history[0].tokensSpent' "$f"
  [ "$output" = "5000" ]
}

@test "_atmux_improve_cycle_close: no-op when currentCycle is null" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"cycleN":2,"currentCycle":null,"history":[],"budgetRemaining":1000}\n' > "$f"
  _atmux_improve_cycle_close "$f" 999 0
  run jq '.budgetRemaining' "$f"
  [ "$output" = "1000" ]
  run jq '.currentCycle' "$f"
  [ "$output" = "null" ]
}

@test "_atmux_improve_is_cycle_closable: false when no current cycle" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"currentCycle":null}\n' > "$f"
  printf '{"tasks":[]}\n' > "$(atmux::dir)/kanban.json"
  run _atmux_improve_is_cycle_closable "$f"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_cycle_closable: false when dispatched tasks include status!=done" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{"currentCycle":{"tasksDispatched":["t-a"]}}
EOF
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"in-progress","completedAt":null}]}
EOF
  run _atmux_improve_is_cycle_closable "$f"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_cycle_closable: false when status=done but completedAt null" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{"currentCycle":{"tasksDispatched":["t-a"]}}
EOF
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"done","completedAt":null}]}
EOF
  run _atmux_improve_is_cycle_closable "$f"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_cycle_closable: true when all dispatched tasks done + committed" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{"currentCycle":{"tasksDispatched":["t-a","t-b"]}}
EOF
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"done","completedAt":100},{"id":"t-b","status":"done","completedAt":200}]}
EOF
  run _atmux_improve_is_cycle_closable "$f"
  [ "$status" -eq 0 ]
}

@test "_atmux_improve_should_terminate: false when budget > 0" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"budgetRemaining":1}\n' > "$f"
  run _atmux_improve_should_terminate "$f"
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_should_terminate: true when budget = 0 (boundary inclusive)" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"budgetRemaining":0}\n' > "$f"
  run _atmux_improve_should_terminate "$f"
  [ "$status" -eq 0 ]
}

@test "_atmux_improve_should_terminate: true when budget < 0 (mid-cycle overage)" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  printf '{"budgetRemaining":-50000}\n' > "$f"
  run _atmux_improve_should_terminate "$f"
  [ "$status" -eq 0 ]
}

@test "_atmux_improve_is_driver_preempt: false on empty kanban" {
  printf '{"tasks":[]}\n' > "$(atmux::dir)/kanban.json"
  run _atmux_improve_is_driver_preempt
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_driver_preempt: false when only improvement tasks in-progress" {
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"in-progress","epic":"e-a25968cc"}]}
EOF
  run _atmux_improve_is_driver_preempt
  [ "$status" -ne 0 ]
}

@test "_atmux_improve_is_driver_preempt: true when foreign-epic task in-progress" {
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"in-progress","epic":"e-other"}]}
EOF
  run _atmux_improve_is_driver_preempt
  [ "$status" -eq 0 ]
}

@test "_atmux_improve_is_driver_preempt: true when in-progress task has null epic" {
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"in-progress","epic":null}]}
EOF
  run _atmux_improve_is_driver_preempt
  [ "$status" -eq 0 ]
}

# ---------- atmux improve --tick (end-to-end) ----------

@test "atmux improve --tick: missing state file → no-op exit 0" {
  printf '{"tasks":[]}\n' > "$(atmux::dir)/kanban.json"
  run "$ATMUX_BIN" improve --tick
  [ "$status" -eq 0 ]
}

@test "atmux improve --tick: dispatched task done → cycle closes, re-arms cycle 2" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{
  "active": true,
  "runId": "ei-tickrun",
  "startedAt": 1,
  "mode": "user-invoked",
  "budgetSpec": "1000000",
  "budgetTotal": 1000000,
  "budgetRemaining": 1000000,
  "cycleN": 1,
  "currentCycle": {
    "startedAt": 100,
    "tasksLanded": ["t-a"],
    "tasksDispatched": ["t-a"],
    "tasksDone": ["t-a"],
    "tokensSpent": 0
  },
  "lastCycleClosedAt": null,
  "history": []
}
EOF
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"done","completedAt":500}]}
EOF
  run "$ATMUX_BIN" improve --tick
  [ "$status" -eq 0 ]
  run jq '.cycleN' "$f"
  [ "$output" = "2" ]
  run jq -r '.currentCycle != null' "$f"
  [ "$output" = "true" ]
  run jq '.history | length' "$f"
  [ "$output" = "1" ]
}

@test "atmux improve --tick: budget exhaustion at close → terminate (active:false)" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{
  "active": true,
  "runId": "ei-broke",
  "startedAt": 1,
  "mode": "user-invoked",
  "budgetSpec": "1000",
  "budgetTotal": 1000,
  "budgetRemaining": 100,
  "cycleN": 1,
  "currentCycle": {
    "startedAt": 100,
    "tasksLanded": [],
    "tasksDispatched": ["t-a"],
    "tasksDone": ["t-a"],
    "tokensSpent": 200
  },
  "lastCycleClosedAt": null,
  "history": []
}
EOF
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-a","status":"done","completedAt":500}]}
EOF
  run "$ATMUX_BIN" improve --tick
  [ "$status" -eq 0 ]
  run jq -r '.active' "$f"
  [ "$output" = "false" ]
  # budget went negative (overage allowed mid-cycle).
  run jq -r '.budgetRemaining < 0' "$f"
  [ "$output" = "true" ]
}

@test "atmux improve --tick: driver Task in-flight → cycle pauses" {
  local f; f="$(_atmux_improve_state_path)"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<'EOF'
{
  "active": true,
  "runId": "ei-pause",
  "startedAt": 1,
  "mode": "user-invoked",
  "budgetSpec": "1000000",
  "budgetTotal": 1000000,
  "budgetRemaining": 1000000,
  "cycleN": 1,
  "currentCycle": {
    "startedAt": 100,
    "tasksLanded": [],
    "tasksDispatched": ["t-a"],
    "tasksDone": [],
    "tokensSpent": 0
  },
  "lastCycleClosedAt": null,
  "history": []
}
EOF
  cat > "$(atmux::dir)/kanban.json" <<'EOF'
{"tasks":[{"id":"t-driver","status":"in-progress","epic":null}]}
EOF
  run "$ATMUX_BIN" improve --tick
  [ "$status" -eq 0 ]
  run jq -r '.currentCycle.paused' "$f"
  [ "$output" = "true" ]
}

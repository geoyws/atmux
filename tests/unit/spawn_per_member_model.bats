#!/usr/bin/env bats
# Unit tests for per-member spawn command assembly (ADR-024 §Consequences).
#
# Covers atmux::tui_cmd → atmux::tui_claude propagation of the per-member
# `team.json:.members[N].model` field. Three load-bearing invariants:
#
#   1. model="<explicit>"  → spawn cmd contains '--model <explicit>'
#   2. model="default"     → spawn cmd OMITS '--model' (CLI picks Opus per
#                            CLAUDE_CODE_EFFORT_LEVEL=xhigh global env)
#   3. model field absent  → defaults to "default" → same as #2
#
# Plus environment invariants per ADR-024: CLAUDE_CODE_EFFORT_LEVEL=xhigh
# stays global on every Claude member regardless of model size.
#
# Strategy: invoke atmux::tui_cmd directly (assertion is on the assembled
# command string; we don't actually spawn tmux). The 7-role sweep at the
# end exercises lead/planner/be-kanban/fe-kanban/test-kanban/gitter/reviewer
# under both default + claude-sonnet-4-6 — pinning the per-role-flag-shape
# documented in ADR-024 §Decision.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  atmux_assert_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# Helper: write team.json with a single member of (name, role, model).
# A null/empty model omits the field entirely (covers AC3).
_team_json_with() {
  local name="$1" role="$2" model="$3"
  mkdir -p .atmux
  if [[ -z "$model" ]]; then
    cat > .atmux/team.json <<JSON
{"name":"t","members":[{"name":"$name","role":"$role","tui":"claude","cwd":"/tmp"}]}
JSON
  else
    cat > .atmux/team.json <<JSON
{"name":"t","members":[{"name":"$name","role":"$role","tui":"claude","model":"$model","cwd":"/tmp"}]}
JSON
  fi
}

# Helper: invoke tui_cmd with the given member-json shape, return stdout.
_tui_cmd_for_member() {
  local mj; mj="$(jq -c '.members[0]' .atmux/team.json)"
  local model; model="$(jq -r '.model // "default"' <<<"$mj")"
  local role;  role="$( jq -r '.role  // "member"'  <<<"$mj")"
  local name;  name="$( jq -r '.name'                <<<"$mj")"
  atmux::tui_cmd claude "$model" /tmp "$name" "$role" "$mj"
}

# ---------- AC1: explicit model propagates verbatim ----------

@test "spawn-model: member.model=claude-sonnet-4-6 → cmd contains '--model claude-sonnet-4-6'" {
  _team_json_with worker member claude-sonnet-4-6
  run _tui_cmd_for_member
  [ "$status" -eq 0 ]
  [[ "$output" =~ "--model claude-sonnet-4-6" ]]
}

@test "spawn-model: member.model=claude-opus-4-7 → cmd contains '--model claude-opus-4-7'" {
  _team_json_with worker member claude-opus-4-7
  run _tui_cmd_for_member
  [[ "$output" =~ "--model claude-opus-4-7" ]]
}

# ---------- AC2: model=default omits --model ----------

@test "spawn-model: member.model='default' → cmd OMITS '--model' flag" {
  _team_json_with worker member default
  run _tui_cmd_for_member
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "--model" ]]
}

# ---------- AC3: field absent defaults to "default" ----------

@test "spawn-model: member.model field absent → cmd OMITS '--model' flag (default semantics)" {
  _team_json_with worker member ""
  run _tui_cmd_for_member
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "--model" ]]
}

# ---------- AC4: CLAUDE_CODE_EFFORT_LEVEL=xhigh present regardless ----------

@test "spawn-model: CLAUDE_CODE_EFFORT_LEVEL=xhigh on every Claude member (model=default)" {
  _team_json_with worker member default
  run _tui_cmd_for_member
  [[ "$output" =~ "CLAUDE_CODE_EFFORT_LEVEL=xhigh" ]]
}

@test "spawn-model: CLAUDE_CODE_EFFORT_LEVEL=xhigh on every Claude member (model=sonnet)" {
  _team_json_with worker member claude-sonnet-4-6
  run _tui_cmd_for_member
  [[ "$output" =~ "CLAUDE_CODE_EFFORT_LEVEL=xhigh" ]]
  [[ "$output" =~ "--model claude-sonnet-4-6" ]]
}

# ---------- AC5: ATMUX_CLAUDE_BIN override coexists with --model ----------

@test "spawn-model: ATMUX_CLAUDE_BIN override applied alongside --model flag" {
  _team_json_with worker member claude-sonnet-4-6
  ATMUX_CLAUDE_BIN="/usr/local/bin/claude-stable" run _tui_cmd_for_member
  [[ "$output" =~ "/usr/local/bin/claude-stable" ]]
  [[ "$output" =~ "--model claude-sonnet-4-6" ]]
  ! [[ "$output" =~ " claude --" ]]    # the bare 'claude' isn't there
}

# ---------- AC6: 7-role sweep (default + sonnet variants) ----------
#
# ADR-024 §Decision: every team-spawned role uses Opus by default. The
# only sanctioned Sonnet member is `discorder` (narrative-formatter) —
# but that's a per-team override, not a default. Confirm here that the
# spawn assembly is INDEPENDENT of role: the 7 standard roles all behave
# identically — model="default" omits flag, explicit model passes through.

@test "spawn-model: 7-role sweep — default model omits --model for every role" {
  local role
  for role in team-lead planner member member member gitter reviewer; do
    _team_json_with x "$role" default
    run _tui_cmd_for_member
    [ "$status" -eq 0 ] || { echo "role=$role failed"; return 1; }
    if [[ "$output" =~ "--model" ]]; then
      echo "role=$role: unexpected --model in: $output"
      return 1
    fi
  done
}

@test "spawn-model: 7-role sweep — explicit sonnet propagates for every role" {
  local role
  for role in team-lead planner member member member gitter reviewer; do
    _team_json_with x "$role" claude-sonnet-4-6
    run _tui_cmd_for_member
    [ "$status" -eq 0 ] || { echo "role=$role failed"; return 1; }
    if ! [[ "$output" =~ "--model claude-sonnet-4-6" ]]; then
      echo "role=$role: missing --model claude-sonnet-4-6 in: $output"
      return 1
    fi
  done
}

# ---------- bonus: discorder variant from ADR-024 §Decision ----------

@test "spawn-model: discorder role at sonnet (the documented Sonnet carve-out per ADR-024)" {
  _team_json_with discorder discorder claude-sonnet-4-6
  run _tui_cmd_for_member
  [[ "$output" =~ "--model claude-sonnet-4-6" ]]
  [[ "$output" =~ "CLAUDE_CODE_EFFORT_LEVEL=xhigh" ]]
}

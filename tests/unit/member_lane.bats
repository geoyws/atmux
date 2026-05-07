#!/usr/bin/env bats
# Unit tests for member-lane wiring — Story S5 (t-2ef9d630).
# Pre-scaffold per lead-approved plan; the file stays untracked (`??`)
# until lead formally dispatches t-2ef9d630.
#
# Coverage splits across two BE Tasks:
#   T5.1 (shipped @ 6bc2799) — atmux::lane_for_name + atmux::lane_display
#       helpers in lib/common.sh, .lane stamped during wizard, status.sh
#       LANE column rendering. Tests in this file under "T5.1" pass NOW.
#   T5.2 (NOT shipped) — add-member --lane flag + name-prefix inference
#       fallback + role-scoped silent-ignore. Tests under "T5.2" stay red
#       until be-kanban ships lib/add-member.sh changes.
#
# Per d-485b965d, RED tests during pre-scaffold are tolerated.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name m >/dev/null
  atmux_source_libs   # makes atmux::lane_for_name / atmux::lane_display callable
}

teardown() {
  atmux_teardown_sandbox
}

# ============================================================
# T5.1 — atmux::lane_for_name pure-function unit tests
# ============================================================

@test "lane_for_name: 'fe-' prefix → fe" {
  run atmux::lane_for_name fe-auth member
  [ "$output" = "fe" ]
}

@test "lane_for_name: 'be-' prefix → be" {
  run atmux::lane_for_name be-orders member
  [ "$output" = "be" ]
}

@test "lane_for_name: 'db-' prefix → db" {
  run atmux::lane_for_name db-migrations member
  [ "$output" = "db" ]
}

@test "lane_for_name: 'ops-' prefix → ops" {
  run atmux::lane_for_name ops-deploy member
  [ "$output" = "ops" ]
}

@test "lane_for_name: 'test-' prefix → test" {
  run atmux::lane_for_name test-kanban member
  [ "$output" = "test" ]
}

@test "lane_for_name: 'review-' prefix → review" {
  run atmux::lane_for_name review-x member
  [ "$output" = "review" ]
}

@test "lane_for_name: 'misc-' prefix → misc" {
  run atmux::lane_for_name misc-thing member
  [ "$output" = "misc" ]
}

# ---------- role overrides (no lane prefix) ----------

@test "lane_for_name: role=reviewer w/o prefix → review" {
  run atmux::lane_for_name "alice" reviewer
  [ "$output" = "review" ]
}

@test "lane_for_name: role=devops w/o prefix → ops" {
  run atmux::lane_for_name "bob" devops
  [ "$output" = "ops" ]
}

@test "lane_for_name: role=dba w/o prefix → db" {
  run atmux::lane_for_name "carol" dba
  [ "$output" = "db" ]
}

@test "lane_for_name: role=team-lead w/o prefix → misc" {
  run atmux::lane_for_name "lead" team-lead
  [ "$output" = "misc" ]
}

@test "lane_for_name: role=planner w/o prefix → misc" {
  run atmux::lane_for_name "planner" planner
  [ "$output" = "misc" ]
}

@test "lane_for_name: role=gitter w/o prefix → misc" {
  run atmux::lane_for_name "gitter" gitter
  [ "$output" = "misc" ]
}

# ---------- ambiguous names ----------

@test "lane_for_name: ambiguous bare name + role=member → misc" {
  run atmux::lane_for_name "alice" member
  [ "$output" = "misc" ]
}

@test "lane_for_name: prefix WINS over role override (fe- + role=dba → fe)" {
  run atmux::lane_for_name fe-anything dba
  [ "$output" = "fe" ]
}

# ============================================================
# T5.1 — atmux::lane_display rendering
# ============================================================

@test "lane_display: lowercase → UPPERCASE" {
  run atmux::lane_display fe
  [ "$output" = "FE" ]
}

@test "lane_display: empty → MISC fallback" {
  run atmux::lane_display ""
  [ "$output" = "MISC" ]
}

@test "lane_display: 'null' literal → MISC fallback (read-side null guard)" {
  run atmux::lane_display "null"
  [ "$output" = "MISC" ]
}

# ============================================================
# T5.1 — wizard / init bakes .lane into team.json on first run
# ============================================================

@test "init: default members have .lane stamped per role/name" {
  run jq -r '.members[] | select(.name=="lead") | .lane' .atmux/team.json
  [ "$output" = "misc" ]
  run jq -r '.members[] | select(.name=="reviewer") | .lane' .atmux/team.json
  [ "$output" = "review" ]
  run jq -r '.members[] | select(.name=="devops") | .lane' .atmux/team.json
  [ "$output" = "ops" ]
  run jq -r '.members[] | select(.name=="dba") | .lane' .atmux/team.json
  [ "$output" = "db" ]
}

@test "init: feature-prefix worker member infers .lane from name" {
  # Default init creates fe-auth, be-auth, db-auth feature workers.
  run jq -r '.members[] | select(.name=="fe-auth") | .lane' .atmux/team.json
  [ "$output" = "fe" ]
  run jq -r '.members[] | select(.name=="be-auth") | .lane' .atmux/team.json
  [ "$output" = "be" ]
  run jq -r '.members[] | select(.name=="db-auth") | .lane' .atmux/team.json
  [ "$output" = "db" ]
}

# ============================================================
# T5.1 — status.sh renders LANE column with UPPERCASE display
# ============================================================

@test "status: tabular output includes LANE column header" {
  run "$ATMUX_BIN" status
  # Ignore exit code (tmux session is down in tests; status still prints
  # the member table). Just assert column header is present.
  [[ "$output" =~ lane ]] || [[ "$output" =~ LANE ]]
}

@test "status: each row renders the member's lane in UPPER-CASE" {
  run "$ATMUX_BIN" status
  [[ "$output" =~ "FE" ]]      # fe-auth
  [[ "$output" =~ "BE" ]]      # be-auth
  [[ "$output" =~ "REVIEW" ]]  # reviewer
}

@test "status --json: members carry .lane field (lowercase)" {
  run "$ATMUX_BIN" status --json
  echo "$output" | jq -e '.members[] | select(.name=="fe-auth") | .lane == "fe"' >/dev/null
  echo "$output" | jq -e '.members[] | select(.name=="reviewer") | .lane == "review"' >/dev/null
}

# ============================================================
# T5.1 — legacy compat: pre-lane team.json reads back null/misc
# ============================================================

@test "legacy team.json (no .lane on members): status falls back to inferred lane" {
  # Strip .lane from every member to simulate a pre-T5.1 team.json.
  jq 'del(.members[].lane)' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  run "$ATMUX_BIN" status
  # Should still render the LANE column with the same inferred values.
  [[ "$output" =~ "FE" ]]
  [[ "$output" =~ "BE" ]]
  [[ "$output" =~ "REVIEW" ]]
}

# ============================================================
# T5.2 — add-member --lane flag (NOT yet shipped; expected red)
# ============================================================

@test "add-member --lane fe: persists lane=fe on the new member" {
  run "$ATMUX_BIN" add-member alpha --role member --tui shell --lane fe
  [ "$status" -eq 0 ]
  run jq -r '.members[] | select(.name=="alpha") | .lane' .atmux/team.json
  [ "$output" = "fe" ]
}

@test "add-member without --lane: infers from name prefix (be-orders → be)" {
  run "$ATMUX_BIN" add-member be-orders --role member --tui shell
  [ "$status" -eq 0 ]
  run jq -r '.members[] | select(.name=="be-orders") | .lane' .atmux/team.json
  [ "$output" = "be" ]
}

@test "add-member without --lane + ambiguous name: lane=misc" {
  run "$ATMUX_BIN" add-member "alice" --role member --tui shell
  [ "$status" -eq 0 ]
  run jq -r '.members[] | select(.name=="alice") | .lane' .atmux/team.json
  [ "$output" = "misc" ]
}

@test "add-member --lane <invalid>: errors with enum list" {
  run "$ATMUX_BIN" add-member beta --role member --tui shell --lane "marketing"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "fe" ]] && [[ "$output" =~ "be" ]] && [[ "$output" =~ "misc" ]]
}

@test "add-member with role=reviewer + --lane fe: silently uses role override (review)" {
  # Role-scoped members: --lane is silently ignored / coerced to role default.
  run "$ATMUX_BIN" add-member rev --role reviewer --tui shell --lane fe
  [ "$status" -eq 0 ]
  run jq -r '.members[] | select(.name=="rev") | .lane' .atmux/team.json
  # Either role override wins (review) OR the flag is rejected — both are
  # valid implementations of "ignore". Test asserts the safer behavior.
  [[ "$output" = "review" ]] || [[ "$output" = "fe" && "$status" -ne 0 ]]
}

@test "add-member with role=devops: lane=ops regardless of --lane" {
  run "$ATMUX_BIN" add-member ops1 --role devops --tui shell --lane fe
  [ "$status" -eq 0 ]
  run jq -r '.members[] | select(.name=="ops1") | .lane' .atmux/team.json
  [[ "$output" = "ops" ]] || [[ "$output" = "fe" && "$status" -ne 0 ]]
}

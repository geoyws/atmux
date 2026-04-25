#!/usr/bin/env bats
# Unit tests for team.json write safety — t-2f13a2e4 (P0 incident response).
#
# Background: on 2026-04-25 a test fixture overwrote the live team.json
# (driver-detected via 'no tmux window for lead' breakage). Recovery
# required rebuilding from observed reality. This suite locks in the
# safety mechanisms added in lib/common.sh (atmux::team_json_backup) +
# lib/init.sh + lib/add-member.sh + lib/reconfigure.sh:
#
#   - bare init (no existing team.json) ⇒ NO .bak (nothing to back up)
#   - init --force on existing team.json ⇒ .bak.<epoch> captured
#   - add-member ⇒ .bak.<epoch> captured before jq_update
#   - sandbox assertion guard catches "ran in repo root" misuse
#
# The .bak naming uses epoch seconds so concurrent writes don't collide
# (with sub-second precision the cp would race; we accept second-grain
# because real writes are seconds-apart).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- init ----------

@test "team_json_safety: bare 'init' (no existing team.json) ⇒ NO backup created" {
  # First-ever init has nothing to back up — atmux::team_json_backup is
  # a silent no-op, no .bak file lands on disk.
  run "$ATMUX_BIN" init --name x
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
  # No backup file should exist.
  run bash -c "ls .atmux/team.json.bak.* 2>/dev/null | wc -l"
  [ "$output" = "0" ]
}

@test "team_json_safety: 'init --force' over existing team.json ⇒ .bak.<epoch> captured" {
  # First init, baseline.
  "$ATMUX_BIN" init --name original >/dev/null
  [ "$(jq -r '.name' .atmux/team.json)" = "original" ]
  # Second init with --force should snapshot the original first.
  run "$ATMUX_BIN" init --name overwritten --force
  [ "$status" -eq 0 ]
  [ "$(jq -r '.name' .atmux/team.json)" = "overwritten" ]
  # Exactly one .bak — it should still hold the ORIGINAL name.
  local baks; baks=$(ls .atmux/team.json.bak.* 2>/dev/null)
  [ -n "$baks" ]
  local bak; bak=$(echo "$baks" | head -1)
  [ "$(jq -r '.name' "$bak")" = "original" ]
  # Filename must include an integer epoch suffix.
  [[ "$bak" =~ \.bak\.[0-9]+$ ]]
}

# ---------- add-member ----------

@test "team_json_safety: 'add-member' on existing team ⇒ .bak.<epoch> captured" {
  "$ATMUX_BIN" init --name tt >/dev/null
  local before_n; before_n=$(jq -r '.members | length' .atmux/team.json)
  run "$ATMUX_BIN" add-member fe-newcomer --role member --tui shell
  [ "$status" -eq 0 ]
  local after_n; after_n=$(jq -r '.members | length' .atmux/team.json)
  [ "$after_n" -gt "$before_n" ]
  # Backup exists and reflects the pre-add state (member count == before_n).
  local bak; bak=$(ls .atmux/team.json.bak.* 2>/dev/null | head -1)
  [ -n "$bak" ]
  [ "$(jq -r '.members | length' "$bak")" = "$before_n" ]
}

@test "team_json_safety: rapid sequential add-member calls each leave their own .bak" {
  # Two adds in a row should produce two distinct .bak files (unless the
  # epoch-second tick clashes — accepted edge case, documented).
  "$ATMUX_BIN" init --name tt >/dev/null
  "$ATMUX_BIN" add-member fe-w1 --role member --tui shell >/dev/null
  sleep 1   # ensure epoch advances so second .bak gets a fresh name
  "$ATMUX_BIN" add-member fe-w2 --role member --tui shell >/dev/null
  local count; count=$(ls .atmux/team.json.bak.* 2>/dev/null | wc -l)
  [ "$count" -ge 2 ]
}

# ---------- atmux::team_json_backup unit ----------

@test "team_json_safety: atmux::team_json_backup is a no-op when team.json doesn't exist" {
  atmux_source_libs
  # Sandbox has no team.json yet (init not called).
  run atmux::team_json_backup
  [ "$status" -eq 0 ]
  # Empty stdout (helper echoes path on success only).
  [ -z "$output" ]
  # And no stray .bak files in the dir.
  run bash -c "ls .atmux/team.json.bak.* 2>/dev/null | wc -l"
  [ "$output" = "0" ]
}

@test "team_json_safety: atmux::team_json_backup echoes the .bak path it created" {
  "$ATMUX_BIN" init --name tt >/dev/null
  atmux_source_libs
  run atmux::team_json_backup
  [ "$status" -eq 0 ]
  # Output is the .bak path; file must exist on disk.
  [ -n "$output" ]
  [ -f "$output" ]
  [[ "$output" =~ \.bak\.[0-9]+$ ]]
}

# ---------- sandbox-assert helper ----------

@test "team_json_safety: atmux_assert_sandbox passes inside the test sandbox" {
  # Default sandbox set up in setup() ⇒ assert succeeds.
  run atmux_assert_sandbox
  [ "$status" -eq 0 ]
}

@test "team_json_safety: atmux_assert_sandbox fails when ATMUX_TEST_TMP is unset" {
  # Simulate a misconfigured test that bypassed atmux_setup_sandbox.
  unset ATMUX_TEST_TMP
  run atmux_assert_sandbox
  [ "$status" -ne 0 ]
  [[ "$output" =~ "ATMUX_TEST_TMP unset" ]] || [[ "$output" =~ "sandbox not initialized" ]]
}

#!/usr/bin/env bats
# Unit tests for the enforcer role brief — t-c7643540 (E14/Sc).
#
# Per ADR-039, enforcer is the fleet-level audit consumer. It runs on the
# superdriver team (not per-project teams) on `claude-opus-4-7 xhigh` per
# ADR-024 + global CLAUDE.md model selection. Lane: misc.
#
# This spec covers the three landing-readiness checks:
#   AC1. Brief loadability — templates/briefs/enforcer.md is on disk,
#        atmux::brief_path resolves to it (not the member.md fallback),
#        and the v-marker parses cleanly through atmux::brief_version.
#   AC2. add-member integration — `atmux add-member enforcer --role
#        enforcer --tui claude --model default --lane misc` lands a
#        team.json entry with the right shape and primes an empty inbox.
#   AC3. team.json schema/role acceptance — downstream consumers
#        (lane_for_name, status verb) handle role=enforcer gracefully
#        rather than crashing on an unknown role.
#
# Brief-reload itself is NOT exercised — it requires a live tmux pane,
# which would couple this spec to the tmux-spawn integration path. The
# brief_path + brief_version surface is the load-readiness contract;
# brief-reload is just a transport on top of it (covered by the
# brief_versions.bats whip-side coverage).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_assert_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- AC1: brief loadability ----------

@test "enforcer brief: templates/briefs/enforcer.md is shipped in the repo" {
  [ -f "$ATMUX_REPO_ROOT/templates/briefs/enforcer.md" ]
  [ -r "$ATMUX_REPO_ROOT/templates/briefs/enforcer.md" ]
  # First line is the v-marker — required by atmux::brief_version regex.
  run head -1 "$ATMUX_REPO_ROOT/templates/briefs/enforcer.md"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^\<!--[[:space:]]*brief-version:[[:space:]]*v[0-9]+[[:space:]]*--\>$ ]]
}

@test "enforcer brief: atmux::brief_path enforcer resolves to enforcer.md (not member.md fallback)" {
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_path enforcer
  [ "$status" -eq 0 ]
  # Resolves to the role-specific file, not the member.md catch-all.
  [[ "$output" == */templates/briefs/enforcer.md ]]
  ! [[ "$output" == */templates/briefs/member.md ]]
}

@test "enforcer brief: atmux::brief_version enforcer returns a v-marker (not v0 fallback)" {
  . "$ATMUX_LIB_DIR/common.sh"
  . "$ATMUX_LIB_DIR/tui.sh"
  run atmux::brief_version enforcer
  [ "$status" -eq 0 ]
  # Must parse — not the v0 legacy fallback that signals a missing /
  # malformed marker.
  [[ "$output" =~ ^v[0-9]+$ ]]
  [ "$output" != "v0" ]
}

# ---------- AC2: add-member integration ----------

@test "enforcer add-member: --role enforcer --tui claude --model default --lane misc registers the member" {
  "$ATMUX_BIN" init --name sd >/dev/null

  run "$ATMUX_BIN" add-member enforcer \
    --role enforcer --tui claude --model default --lane misc
  [ "$status" -eq 0 ]

  # Member appended to team.json with the right field shape.
  run jq -r '[.members[] | select(.name == "enforcer")] | length' .atmux/team.json
  [ "$output" = "1" ]
  run jq -r '.members[] | select(.name == "enforcer") | .role'  .atmux/team.json
  [ "$output" = "enforcer" ]
  run jq -r '.members[] | select(.name == "enforcer") | .tui'   .atmux/team.json
  [ "$output" = "claude" ]
  run jq -r '.members[] | select(.name == "enforcer") | .model' .atmux/team.json
  [ "$output" = "default" ]
  # Lane: role-derived for non-{member,unblocker} roles → misc (per
  # add-member.sh:46-50, the explicit --lane=misc matches the role-derived
  # value either way; stays "misc" without warning).
  run jq -r '.members[] | select(.name == "enforcer") | .lane'  .atmux/team.json
  [ "$output" = "misc" ]
}

@test "enforcer add-member: primes a fresh empty inbox file" {
  "$ATMUX_BIN" init --name sd >/dev/null
  "$ATMUX_BIN" add-member enforcer \
    --role enforcer --tui claude --model default --lane misc >/dev/null

  [ -f .atmux/inboxes/enforcer.json ]
  run jq -r '.pending | length' .atmux/inboxes/enforcer.json
  [ "$output" = "0" ]
  run jq -r '.inProgress | length' .atmux/inboxes/enforcer.json
  [ "$output" = "0" ]
}

@test "enforcer add-member: refuses to add a duplicate enforcer name" {
  "$ATMUX_BIN" init --name sd >/dev/null
  "$ATMUX_BIN" add-member enforcer \
    --role enforcer --tui claude --model default --lane misc >/dev/null

  run "$ATMUX_BIN" add-member enforcer \
    --role enforcer --tui claude --model default --lane misc
  [ "$status" -ne 0 ]
  [[ "$output" =~ "already in team.json" ]]
}

# ---------- AC3: team.json schema / role acceptance ----------

@test "enforcer schema: atmux::lane_for_name maps role=enforcer to lane=misc" {
  # The lane resolver's role-case has a `*` fallback to misc — verifies
  # that adding a new role doesn't break lane derivation for
  # non-prefix-matching member names.
  . "$ATMUX_LIB_DIR/common.sh"
  run atmux::lane_for_name enforcer enforcer
  [ "$status" -eq 0 ]
  [ "$output" = "misc" ]
}

@test "enforcer schema: prefixed name (e.g. misc-enforcer) still picks up the prefix lane" {
  # Sanity: the name-prefix path wins over the role-derived path. An
  # operator who names the member `misc-enforcer` gets lane=misc from
  # the prefix; `be-enforcer` would get lane=be (overriding role).
  . "$ATMUX_LIB_DIR/common.sh"
  run atmux::lane_for_name misc-enforcer enforcer
  [ "$status" -eq 0 ]
  [ "$output" = "misc" ]
}

@test "enforcer schema: status verb does not crash on a team with an enforcer member" {
  # End-to-end smoke — the most common breakage shape for a new role is
  # a downstream tool with a hardcoded role enum (case statement, JSON
  # schema validation). Status touches the broadest surface (lane
  # derivation, emoji, member render). If it returns 0 with the
  # enforcer member listed in output, the schema is permissive.
  "$ATMUX_BIN" init --name sd >/dev/null
  "$ATMUX_BIN" add-member enforcer \
    --role enforcer --tui claude --model default --lane misc >/dev/null

  run "$ATMUX_BIN" status
  [ "$status" -eq 0 ]
  [[ "$output" =~ "enforcer" ]]
}

@test "enforcer schema: doctor team.json check accepts role=enforcer (no red row)" {
  # Doctor's team.json validation is the gatekeeper for `atmux start`'s
  # preflight — if it red-flagged role=enforcer, the team would refuse
  # to bring up. Verify it stays green on the role.
  "$ATMUX_BIN" init --name sd >/dev/null
  "$ATMUX_BIN" add-member enforcer \
    --role enforcer --tui claude --model default --lane misc >/dev/null

  run "$ATMUX_BIN" doctor --json
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]   # red count may be >0 from unrelated env (no webhook etc)
  # Parse the JSON; assert there is no red row whose label starts with
  # "team.json" (the schema check). Yellow is fine — that surfaces
  # informational warnings, not blockers.
  run jq -r '.checks[] | select(.label | startswith("team.json")) | .status' <<<"$output"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "red" ]]
}

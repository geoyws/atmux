#!/usr/bin/env bats
# Integration round-trip for `atmux sync claude-team-json` per ADR-164
# §"Behavior" + §"File shape after sync" + §OQ-1 + §OQ-4 + §OQ-5.
# T7 (t-4329b053) bats integration capstone.
#
# 8-step lifecycle per task body:
#   1. Seed atmux team.json fixture (3-member roster: lead + planner + member)
#   2. Run --dry-run → assert stdout has +/-/space lines, no write
#   3. Run sync → assert .claude/team.json created with mapped shape
#   4. Re-run sync → no-op (idempotent; fingerprint matches)
#   5. Hand-edit .claude/team.json → re-run → assert drift, exit 65
#   6. Re-run with --force → assert sync proceeds + _atmuxSync updated
#   7. Pre-populate non-empty role → re-run without --overwrite-briefs → preserved
#   8. Re-run with --overwrite-briefs → role replaced

load '../helpers/setup.bash'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux .claude
  cat > .atmux/team.json <<'JSON'
{
  "name": "fixture-team",
  "description": "T7 round-trip fixture",
  "members": [
    {"name": "lead",    "role": "team-lead", "lane": "misc", "tui": "shell", "emoji": "🧭", "model": "default", "cwd": "/tmp"},
    {"name": "planner", "role": "planner",   "lane": "misc", "tui": "shell", "emoji": "🎯", "model": "claude-opus-4-7", "cwd": "/tmp"},
    {"name": "fe-1",    "role": "member",    "lane": "fe",   "tui": "shell", "emoji": "🌸", "cwd": "/tmp"}
  ]
}
JSON
}

teardown() {
  atmux_teardown_sandbox
}

@test "step 2: --dry-run renders preview without writing .claude/team.json" {
  [[ ! -f .claude/team.json ]]
  run "$ATMUX_BIN" sync claude-team-json --dry-run
  [[ "$status" -eq 0 ]]
  [[ "$output" == *"--dry-run preview"* ]]
  [[ "$output" == *"fresh file"* ]]
  [[ "$output" == *"[member: team-lead]"* ]]
  [[ "$output" == *"[member: planner]"* ]]
  [[ "$output" == *"[member: fe-1]"* ]]
  # MUST NOT have written the file.
  [[ ! -f .claude/team.json ]]
}

@test "step 3: sync writes .claude/team.json with mapped shape + marker" {
  run "$ATMUX_BIN" sync claude-team-json
  [[ "$status" -eq 0 ]]
  [[ -f .claude/team.json ]]

  # Top-level shape
  local name
  name="$(jq -r '.name' .claude/team.json)"
  [[ "$name" == "fixture-team" ]]

  # lead → team-lead rewrite + agentType
  local lead_name
  lead_name="$(jq -r '.members[0].name' .claude/team.json)"
  [[ "$lead_name" == "team-lead" ]]
  local lead_agent_type
  lead_agent_type="$(jq -r '.members[0].agentType' .claude/team.json)"
  [[ "$lead_agent_type" == "team-lead" ]]

  # Color resolved from emoji 🧭 → white (coordinator band)
  local lead_color
  lead_color="$(jq -r '.members[0].color' .claude/team.json)"
  [[ "$lead_color" == "white" ]]

  # planner: no agentType (only team-lead emits one)
  local planner_agent_type
  planner_agent_type="$(jq -r '.members[1].agentType // "null"' .claude/team.json)"
  [[ "$planner_agent_type" == "null" ]]

  # Model 'default' → claude-opus-4-7 expansion (ADR-094)
  local lead_model
  lead_model="$(jq -r '.members[0].model' .claude/team.json)"
  [[ "$lead_model" == "claude-opus-4-7" ]]

  # _atmuxSync marker present + valid shape
  local schema_rev
  schema_rev="$(jq -r '._atmuxSync.schemaRev' .claude/team.json)"
  [[ "$schema_rev" == "v1" ]]
  local fp
  fp="$(jq -r '._atmuxSync.sourceFingerprint' .claude/team.json)"
  [[ "$fp" =~ ^sha256:[0-9a-f]{64}$ ]]
  local last
  last="$(jq -r '._atmuxSync.lastSyncedAt' .claude/team.json)"
  [[ -n "$last" ]] && [[ "$last" != "null" ]]
}

@test "step 4: re-run is idempotent (no drift; fingerprint matches)" {
  "$ATMUX_BIN" sync claude-team-json
  local fp_first
  fp_first="$(jq -r '._atmuxSync.sourceFingerprint' .claude/team.json)"

  run "$ATMUX_BIN" sync claude-team-json
  [[ "$status" -eq 0 ]]
  local fp_second
  fp_second="$(jq -r '._atmuxSync.sourceFingerprint' .claude/team.json)"
  [[ "$fp_first" == "$fp_second" ]]
}

@test "step 5: hand-edit triggers drift, refuses without --force (exit 65)" {
  "$ATMUX_BIN" sync claude-team-json
  # Hand-edit: append a stale 4th member directly into the file.
  jq '.members += [{"name": "hand-added", "color": "red"}]' \
    .claude/team.json > .claude/team.json.tmp
  mv .claude/team.json.tmp .claude/team.json

  run "$ATMUX_BIN" sync claude-team-json
  [[ "$status" -eq 65 ]]
  # Warning to stderr (bats captures combined output in $output)
  [[ "$output" == *"drift detected"* ]]
}

@test "step 6: --force overrides drift + updates marker + logs event" {
  "$ATMUX_BIN" sync claude-team-json
  local fp_before
  fp_before="$(jq -r '._atmuxSync.sourceFingerprint' .claude/team.json)"
  jq '.members += [{"name": "hand-added", "color": "red"}]' \
    .claude/team.json > .claude/team.json.tmp
  mv .claude/team.json.tmp .claude/team.json

  run "$ATMUX_BIN" sync claude-team-json --force
  [[ "$status" -eq 0 ]]
  # Marker stamp refreshed
  local fp_after
  fp_after="$(jq -r '._atmuxSync.sourceFingerprint' .claude/team.json)"
  [[ "$fp_after" != "$fp_before" ]]
  # Hand-added member dropped (mapping rewrote from atmux roster — 3 members)
  local count
  count="$(jq '.members | length' .claude/team.json)"
  [[ "$count" == "3" ]]
  # Event logged
  [[ -f .atmux/logs/sync-events.jsonl ]]
  grep -q '"action":"drift-forced"' .atmux/logs/sync-events.jsonl
}

@test "step 7: non-empty Claude-side role preserved (preserve-by-default)" {
  "$ATMUX_BIN" sync claude-team-json
  # Hand-edit a long-form role on member fe-1.
  jq '(.members[] | select(.name == "fe-1")).role = "FE worker — hand-curated brief"' \
    .claude/team.json > .claude/team.json.tmp
  mv .claude/team.json.tmp .claude/team.json

  # Use --force because the hand-edit also drifts the fingerprint.
  run "$ATMUX_BIN" sync claude-team-json --force
  [[ "$status" -eq 0 ]]
  local preserved
  preserved="$(jq -r '(.members[] | select(.name == "fe-1")).role' .claude/team.json)"
  [[ "$preserved" == "FE worker — hand-curated brief" ]]
}

@test "step 8: --overwrite-briefs replaces with atmux role-enum" {
  "$ATMUX_BIN" sync claude-team-json
  jq '(.members[] | select(.name == "fe-1")).role = "FE worker — hand-curated brief"' \
    .claude/team.json > .claude/team.json.tmp
  mv .claude/team.json.tmp .claude/team.json

  run "$ATMUX_BIN" sync claude-team-json --overwrite-briefs --force
  [[ "$status" -eq 0 ]]
  local overwritten
  overwritten="$(jq -r '(.members[] | select(.name == "fe-1")).role' .claude/team.json)"
  [[ "$overwritten" == "member" ]]
}

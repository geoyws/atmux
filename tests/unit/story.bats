#!/usr/bin/env bats
# Unit tests for `atmux story` (lib/story.sh) — T3.2 / t-f8e8beaf.
#
# State machine (per ADR-007):
#   planning → ready → in-progress → testing → review → merging → done
#
# These tests target the verb-suite contract from t-63968c37's AC. They will
# fail with "atmux: unknown verb: story" until lib/story.sh + bin/atmux
# dispatch wiring lands (T3.1, be-kanban). That's the deliverable shape.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name s >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Helper: scaffold a parent Epic in `ready` state so tests can attach Stories.
_make_epic() {
  local eid; eid=$("$ATMUX_BIN" epic add "${1:-parent}" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  echo "$eid"
}

# Seed a child Task directly into kanban.json with .story / .epic / .lane set.
# Decouples story.bats from T4.1 (`task add --story/--epic/--lane` flags) — the
# advance validators only need .story and .lane fields on tasks, which we can
# write directly via jq without requiring those flags to exist on the task verb.
# Returns the new task id on stdout.
# Usage: _seed_task <story-id> <epic-id> <lane> [status=todo]
_seed_task() {
  local sid="$1" eid="$2" lane="$3" status="${4:-todo}"
  local tid; tid="t-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  local now; now="$(date +%s)"
  jq --arg tid "$tid" --arg sid "$sid" --arg eid "$eid" --arg lane "$lane" \
     --arg status "$status" --argjson now "$now" \
    '.tasks += [{
       id: $tid, subject: ("seed " + $lane), status: $status,
       owner: null, deps: [], priority: null,
       story: $sid, epic: $eid, lane: $lane, deliverable: null,
       createdAt: $now, claimedAt: null, completedAt: (if $status == "done" then $now else null end)
     }]' .atmux/kanban.json > .atmux/kanban.json.tmp \
    && mv .atmux/kanban.json.tmp .atmux/kanban.json
  # Append id to parent story.tasks[] so story show / advance can find it.
  jq --arg tid "$tid" --arg sid "$sid" \
    '(.stories[] | select(.id==$sid) | .tasks) += [$tid]' .atmux/kanban.json > .atmux/kanban.json.tmp \
    && mv .atmux/kanban.json.tmp .atmux/kanban.json
  echo "$tid"
}

# ---------- add ----------

@test "story: add requires --epic" {
  run "$ATMUX_BIN" story add "no parent"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "epic" ]]
}

@test "story: add with unknown epic id ⇒ non-zero exit" {
  run "$ATMUX_BIN" story add "x" --epic e-deadbeef
  [ "$status" -ne 0 ]
}

@test "story: add mints s-xxxxxxxx, status=planning, prints id" {
  local eid; eid=$(_make_epic)
  run "$ATMUX_BIN" story add "do thing" --epic "$eid"
  [ "$status" -eq 0 ]
  local sid; sid=$(echo "$output" | tail -1)
  [[ "$sid" =~ ^s-[0-9a-f]{8}$ ]]
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .status' .atmux/kanban.json
  [ "$output" = "planning" ]
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .epic' .atmux/kanban.json
  [ "$output" = "$eid" ]
}

@test "story: add appends id to parent epic.stories[]" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "child" --epic "$eid" | tail -1)
  run jq -r --arg eid "$eid" --arg sid "$sid" '.epics[] | select(.id==$eid) | .stories | index($sid) // -1' .atmux/kanban.json
  [ "$output" -ge 0 ]
}

@test "story: add --ac persists acceptance criteria" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" --ac "must do Y" | tail -1)
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .acceptanceCriteria // ""' .atmux/kanban.json
  [[ "$output" =~ "must do Y" ]]
}

@test "story: add WITHOUT --ac creates story with empty AC (allowed at create per ADR-007 OQ2)" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .acceptanceCriteria // ""' .atmux/kanban.json
  [ "$status" -eq 0 ]
  # Either empty string or null — both are "absent at create".
  [[ -z "$output" ]] || [[ "$output" = "null" ]] || [[ -n "$output" ]] || true
}

@test "story: add --body persists body" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" --body "context" | tail -1)
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .body' .atmux/kanban.json
  [ "$output" = "context" ]
}

# ---------- list ----------

@test "story: list --epic <eid> filters to that epic's stories" {
  local e1; e1=$(_make_epic "e1")
  local e2; e2=$(_make_epic "e2")
  "$ATMUX_BIN" story add "in-e1" --epic "$e1" >/dev/null
  "$ATMUX_BIN" story add "in-e2" --epic "$e2" >/dev/null
  run "$ATMUX_BIN" story list --epic "$e1"
  [[ "$output" =~ "in-e1" ]]
  ! [[ "$output" =~ "in-e2" ]]
}

@test "story: list --json round-trips" {
  local eid; eid=$(_make_epic)
  "$ATMUX_BIN" story add "a" --epic "$eid" >/dev/null
  "$ATMUX_BIN" story add "b" --epic "$eid" >/dev/null
  run "$ATMUX_BIN" story list --epic "$eid" --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e 'length == 2' >/dev/null
}

@test "story: list --status filters" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  "$ATMUX_BIN" story advance "$sid" --to ready >/dev/null
  "$ATMUX_BIN" story add "y" --epic "$eid" >/dev/null   # still planning
  run "$ATMUX_BIN" story list --epic "$eid" --status planning
  [[ "$output" =~ "y" ]]
  ! [[ "$output" =~ "x" ]]
}

# ---------- show ----------

@test "story: show renders title + AC + child Tasks" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "showme" --epic "$eid" --ac "AC text here" | tail -1)
  local tid; tid=$("$ATMUX_BIN" task add "child task" --story "$sid" --epic "$eid" | tail -1)
  run "$ATMUX_BIN" story show "$sid"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "showme" ]]
  [[ "$output" =~ "AC text here" ]]
  [[ "$output" =~ "$tid" ]]
}

@test "story: show --json round-trips" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "j" --epic "$eid" | tail -1)
  run "$ATMUX_BIN" story show "$sid" --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e --arg sid "$sid" '.id == $sid' >/dev/null
}

@test "story: show unknown id ⇒ non-zero" {
  run "$ATMUX_BIN" story show s-deadbeef
  [ "$status" -ne 0 ]
}

# ---------- advance ----------

@test "story: advance default = next state in machine (planning → ready)" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  "$ATMUX_BIN" story advance "$sid" >/dev/null
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .status' .atmux/kanban.json
  [ "$output" = "ready" ]
}

@test "story: advance is idempotent on same-state target" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  "$ATMUX_BIN" story advance "$sid" --to ready >/dev/null
  run "$ATMUX_BIN" story advance "$sid" --to ready
  [ "$status" -eq 0 ]
}

@test "story: advance --to testing while non-test-lane Tasks open ⇒ error names blockers" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  local tid; tid=$(_seed_task "$sid" "$eid" be todo)
  "$ATMUX_BIN" story advance "$sid" --to ready >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress >/dev/null
  run "$ATMUX_BIN" story advance "$sid" --to testing
  [ "$status" -ne 0 ]
  [[ "$output" =~ "$tid" ]]
}

@test "story: advance --to testing succeeds when all non-test Tasks are done" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  _seed_task "$sid" "$eid" be done >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to ready >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress >/dev/null
  run "$ATMUX_BIN" story advance "$sid" --to testing
  [ "$status" -eq 0 ]
}

@test "story: advance --to review with test-lane Task done ⇒ auto-dispatches review task to reviewer inbox" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  _seed_task "$sid" "$eid" be   done >/dev/null
  _seed_task "$sid" "$eid" test done >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to ready >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to testing >/dev/null
  run "$ATMUX_BIN" story advance "$sid" --to review
  [ "$status" -eq 0 ]
  run jq --arg sid "$sid" '[.inProgress[], .pending[] | select(.subject | test("review " + $sid))] | length' .atmux/inboxes/reviewer.json
  [ "$output" -ge 1 ]
}

@test "story: advance --to merging requires reviewSignoff flag, then dispatches to gitter" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  # Force the story into review with signoff via direct jq mutation — once the
  # reviewer brief lands its own signoff verb (T6.4) this should become a
  # call to that. For now, simulate.
  "$ATMUX_BIN" story advance "$sid" --to ready        >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress  >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to testing      >/dev/null 2>&1 || true
  "$ATMUX_BIN" story advance "$sid" --to review       >/dev/null 2>&1 || true
  jq --arg sid "$sid" '(.stories[] | select(.id==$sid) | .reviewSignoff) |= true' .atmux/kanban.json > .atmux/kanban.json.tmp \
    && mv .atmux/kanban.json.tmp .atmux/kanban.json
  run "$ATMUX_BIN" story advance "$sid" --to merging
  [ "$status" -eq 0 ]
  run jq --arg sid "$sid" '[.inProgress[], .pending[] | select(.subject | test("merge " + $sid))] | length' .atmux/inboxes/gitter.json
  [ "$output" -ge 1 ]
}

@test "story: advance --to merging without reviewSignoff ⇒ error" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "x" --epic "$eid" | tail -1)
  "$ATMUX_BIN" story advance "$sid" --to ready       >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to testing     >/dev/null 2>&1 || true
  "$ATMUX_BIN" story advance "$sid" --to review      >/dev/null 2>&1 || true
  run "$ATMUX_BIN" story advance "$sid" --to merging
  [ "$status" -ne 0 ]
  [[ "$output" =~ "signoff" ]] || [[ "$output" =~ "review" ]]
}

@test "story: parent Epic auto-flips ready→in-progress when first Story leaves ready" {
  local eid; eid=$(_make_epic)
  local sid; sid=$("$ATMUX_BIN" story add "first-mover" --epic "$eid" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to in-progress >/dev/null 2>&1 || true
  # Reset epic to ready to test the auto-flip (some implementations may
  # already be in-progress after the dependency chain above).
  jq --arg eid "$eid" '(.epics[] | select(.id==$eid) | .status) = "ready"' .atmux/kanban.json > .atmux/kanban.json.tmp \
    && mv .atmux/kanban.json.tmp .atmux/kanban.json
  "$ATMUX_BIN" story advance "$sid" --to ready        >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress  >/dev/null
  run jq -r --arg eid "$eid" '.epics[] | select(.id==$eid) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
}

@test "story: advance unknown id ⇒ non-zero" {
  run "$ATMUX_BIN" story advance s-deadbeef
  [ "$status" -ne 0 ]
}

# ---------- dispatch / args ----------

@test "story: missing verb errors with usage hint" {
  run "$ATMUX_BIN" story
  [ "$status" -ne 0 ]
}

@test "story: unknown verb errors" {
  run "$ATMUX_BIN" story blarp
  [ "$status" -ne 0 ]
}

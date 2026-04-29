#!/usr/bin/env bats
# Unit tests for atmux::finish_task_done auto-flip of Story.reviewSignoff
# (Option B per t-bb128904 / lead+reviewer-1 recommendation).
#
# Behaviour gate (E16 d-016afdeb allow-list):
#   - Caller's role!=member OR caller's lane==review → flip fires.
#   - Otherwise → warn, no flip (Task still moves to done).
# Pre-condition: Task is lane=review AND .story != null.
#
# All cells exercise the lib directly via atmux::finish_task_done — bypassing
# the full bin/atmux dispatch path keeps the assertions focused on the
# auto-flip surface. Inbox push / commit-Task minting paths are not under
# test here (covered by claim_state_machine.bats).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/kanban.sh
  . "$ATMUX_LIB_DIR/kanban.sh"
  # shellcheck source=../../lib/story.sh
  . "$ATMUX_LIB_DIR/story.sh"
  atmux_assert_sandbox

  # Build a team.json with two callers: a review-shaped member (lane=review)
  # and a fe-shaped member (lane=fe). Plus a non-member-role caller (lead).
  mkdir -p "$ATMUX_DIR"
  cat > "$ATMUX_DIR/team.json" <<'JSON'
{
  "name":"sg",
  "tmuxTmpdir":"/tmp/sg-tmpdir",
  "members":[
    {"name":"reviewer-test","role":"member","lane":"review"},
    {"name":"fe-test","role":"member","lane":"fe"},
    {"name":"lead","role":"team-lead","lane":"misc"}
  ]
}
JSON

  # Suppress dispatch side-effects — we just want the auto-flip behaviour.
  export ATMUX_FINISH_TASK_NO_DISPATCH=1
}

teardown() {
  atmux_teardown_sandbox
}

# Seed kanban with one Story (status=review, reviewSignoff=false) and one
# review-lane Task tied to it. Echoes the Task id.
_seed_kanban_with_review_task() {
  local owner="${1:-reviewer-test}"
  local sid="s-test01"
  local tid="t-rev001"
  cat > "$ATMUX_DIR/kanban.json" <<JSON
{
  "tasks":[
    {"id":"$tid","subject":"REVIEW signoff","status":"in-progress",
     "lane":"review","story":"$sid","epic":null,"owner":"$owner",
     "deps":[],"priority":1,"createdAt":1,"claimedAt":1,"completedAt":null}
  ],
  "epics":[],
  "stories":[
    {"id":"$sid","epic":null,"title":"test story","status":"review",
     "reviewSignoff":false,"createdAt":1,"completedAt":null}
  ]
}
JSON
  printf '%s\n' "$tid"
}

# ---------- CELL 1: review caller → flip works ----------

@test "story-signoff: review caller finishes review-Task → reviewSignoff flips true" {
  local tid; tid="$(_seed_kanban_with_review_task reviewer-test)"

  ATMUX_MEMBER=reviewer-test atmux::finish_task_done "$tid" "review done"

  run jq -r '.tasks[] | select(.id == "'"$tid"'") | .status' "$ATMUX_DIR/kanban.json"
  [ "$output" = "done" ]
  run jq -r '.stories[] | select(.id == "s-test01") | .reviewSignoff' "$ATMUX_DIR/kanban.json"
  [ "$output" = "true" ]
}

# ---------- CELL 2: non-reviewer caller → flip refused, warn surfaces ----------

@test "story-signoff: fe-lane caller finishes review-Task → flip refused (warn-only); Task still done" {
  local tid; tid="$(_seed_kanban_with_review_task fe-test)"

  # Capture stderr separately — atmux::warn writes there.
  local out err
  err="$(ATMUX_MEMBER=fe-test atmux::finish_task_done "$tid" "" 2>&1 >/dev/null)"

  run jq -r '.tasks[] | select(.id == "'"$tid"'") | .status' "$ATMUX_DIR/kanban.json"
  [ "$output" = "done" ]
  # Story.reviewSignoff stays FALSE — that's the gate working.
  run jq -r '.stories[] | select(.id == "s-test01") | .reviewSignoff' "$ATMUX_DIR/kanban.json"
  [ "$output" = "false" ]
  [[ "$err" == *"non-review caller"* || "$err" == *"NOT auto-flipped"* ]]
}

# ---------- CELL 3: post-flip story advance to merging now succeeds ----------

@test "story-signoff: post-flip → atmux story advance review→merging succeeds" {
  local tid; tid="$(_seed_kanban_with_review_task reviewer-test)"
  ATMUX_MEMBER=reviewer-test atmux::finish_task_done "$tid" "" >/dev/null 2>&1

  # Now the Story has reviewSignoff=true; merging gate should open.
  run "$ATMUX_BIN" story advance s-test01 --to merging
  [ "$status" -eq 0 ]
  run jq -r '.stories[] | select(.id == "s-test01") | .status' "$ATMUX_DIR/kanban.json"
  [ "$output" = "merging" ]
}

# ---------- CELL 4: idempotent re-flip ----------

@test "story-signoff: idempotent — second review-Task finish on already-true Story is a no-op" {
  local tid1; tid1="$(_seed_kanban_with_review_task reviewer-test)"
  ATMUX_MEMBER=reviewer-test atmux::finish_task_done "$tid1" "" >/dev/null 2>&1

  # Add a second review-Task tied to the same Story (e.g. follow-up coverage).
  jq '.tasks += [{
    id:"t-rev002", subject:"REVIEW pass2", status:"in-progress",
    lane:"review", story:"s-test01", epic:null, owner:"reviewer-test",
    deps:[], priority:1, createdAt:2, claimedAt:2, completedAt:null
  }]' "$ATMUX_DIR/kanban.json" > /tmp/k.tmp
  mv /tmp/k.tmp "$ATMUX_DIR/kanban.json"

  ATMUX_MEMBER=reviewer-test atmux::finish_task_done t-rev002 "" >/dev/null 2>&1

  run jq -r '.stories[] | select(.id == "s-test01") | .reviewSignoff' "$ATMUX_DIR/kanban.json"
  [ "$output" = "true" ]
  # Both review-Tasks are done.
  run jq -r '[.tasks[] | select(.lane=="review" and .status=="done")] | length' "$ATMUX_DIR/kanban.json"
  [ "$output" = "2" ]
}

# ---------- CELL 5: non-member-role caller (team-lead) → flip works (allow-list) ----------

@test "story-signoff: lead (role=team-lead) finishing review-Task → flip fires (allow-list)" {
  local tid; tid="$(_seed_kanban_with_review_task lead)"

  ATMUX_MEMBER=lead atmux::finish_task_done "$tid" "" >/dev/null 2>&1

  run jq -r '.stories[] | select(.id == "s-test01") | .reviewSignoff' "$ATMUX_DIR/kanban.json"
  [ "$output" = "true" ]
}

# ---------- BONUS: review Task with .story=null → no flip, no warn ----------

@test "story-signoff: review Task with .story=null → no flip + no warn" {
  cat > "$ATMUX_DIR/kanban.json" <<'JSON'
{
  "tasks":[
    {"id":"t-orphan","subject":"REVIEW orphan","status":"in-progress",
     "lane":"review","story":null,"epic":"e-1","owner":"reviewer-test",
     "deps":[],"priority":1,"createdAt":1,"claimedAt":1,"completedAt":null}
  ],
  "epics":[{"id":"e-1","title":"epic","status":"review"}],
  "stories":[]
}
JSON

  local err
  err="$(ATMUX_MEMBER=reviewer-test atmux::finish_task_done t-orphan "" 2>&1 >/dev/null)"

  run jq -r '.tasks[] | select(.id == "t-orphan") | .status' "$ATMUX_DIR/kanban.json"
  [ "$output" = "done" ]
  # No Story to flip; no warn either — orphan reviews are a normal shape.
  [[ "$err" != *"NOT auto-flipped"* ]]
  [[ "$err" != *"non-review caller"* ]]
}

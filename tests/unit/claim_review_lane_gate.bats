#!/usr/bin/env bats
# Unit tests for the ADR-031 §REVIEW-lane carve-out — claim --next
# second-pass + explicit-id `atmux claim` refuse-gates exclude
# non-review-lane members from `lane=review` Tasks.
#
# Origin (2026-04-27): fe-kanban + test-kanban cross-lane'd into REVIEW
# Tasks via the second-pass any-lane fallback before self-recognising
# the lane-purity violation. The feedback_reviewer_lane_gate.md memory
# was the discipline rule; ADR-031 + lib/claim.sh §E16 refuse-gate
# (lines 87-100 + 282) make it structural.
#
# Per CLAUDE.md feedback_orphan_test_staging.md: BE dep t-bffc4943
# (E16 BE refuse-gate) is already done — this .bats is safe to git add.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name lprt >/dev/null
  # Replace the template's wide member set with a minimal pair we control.
  cat > .atmux/team.json <<JSON
{
  "name": "lprt",
  "kanban": {"crossLaneClaim": true},
  "members": [
    {"name": "lead",          "role": "team-lead", "lane": "misc",   "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "fe-test",       "role": "member",    "lane": "fe",     "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "reviewer-test", "role": "member",    "lane": "review", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "gitter",        "role": "gitter",    "lane": "misc",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead fe-test reviewer-test gitter; do
    mkdir -p .atmux/inboxes
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  export ATMUX_NO_AUTO_DISPATCH=1
}

teardown() {
  atmux_teardown_sandbox
}

# Add a lane=review todo Task and echo its id.
_seed_review_task() {
  local id; id="$("$ATMUX_BIN" task add "REVIEW signoff stub" --lane review 2>/dev/null | tail -1)"
  printf '%s\n' "$id"
}

_task_status() {
  local id="$1"
  jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .status' .atmux/kanban.json
}

_task_owner() {
  local id="$1"
  jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .owner // ""' .atmux/kanban.json
}

# ---------- CELL 1 — claim --next member negative ----------

@test "claim --next: lane=fe member does NOT select a lane=review Task (cross-lane fallback excludes it)" {
  local rid; rid="$(_seed_review_task)"
  [[ "$rid" =~ ^t- ]]

  run "$ATMUX_BIN" claim --next --as fe-test
  [ "$status" -eq 0 ]
  # The review Task must not have been picked.
  [[ "$output" == *"no claimable work"* ]] || ! [[ "$output" == *"$rid"* ]]
  [ "$(_task_status "$rid")" = "todo" ]
  [ -z "$(_task_owner "$rid")" ]
}

# ---------- CELL 2 — claim --next reviewer positive ----------

@test "claim --next: lane=review member DOES select a lane=review Task (cross-lane gate doesn't fire)" {
  local rid; rid="$(_seed_review_task)"

  run "$ATMUX_BIN" claim --next --as reviewer-test
  [ "$status" -eq 0 ]
  [[ "$output" == *"$rid"* ]]
  [ "$(_task_status "$rid")" = "in-progress" ]
  [ "$(_task_owner "$rid")" = "reviewer-test" ]
}

# ---------- CELL 3 — explicit-id member negative ----------

@test "atmux claim <review-id>: lane=fe member refuses with REVIEW-lane error" {
  local rid; rid="$(_seed_review_task)"

  run "$ATMUX_BIN" claim "$rid" --as fe-test
  [ "$status" -ne 0 ]
  [[ "$output" == *"REVIEW-lane"* ]]
  [[ "$output" == *"review-lane callers can claim"* ]]
  [ "$(_task_status "$rid")" = "todo" ]
  [ -z "$(_task_owner "$rid")" ]
}

# ---------- CELL 4 — explicit-id reviewer positive ----------

@test "atmux claim <review-id>: lane=review member succeeds" {
  local rid; rid="$(_seed_review_task)"

  run "$ATMUX_BIN" claim "$rid" --as reviewer-test
  [ "$status" -eq 0 ]
  [ "$(_task_status "$rid")" = "in-progress" ]
  [ "$(_task_owner "$rid")" = "reviewer-test" ]
}

# ---------- CELL 5 — non-member-role bypass ----------

@test "atmux claim <review-id>: gitter (role=gitter) bypasses the gate (allow-list per OQ1)" {
  local rid; rid="$(_seed_review_task)"

  run "$ATMUX_BIN" claim "$rid" --as gitter
  # The refuse-gate is gated on role==member; gitter (role=gitter) sails
  # through the lane check. Note: a separate reactive-role gate at
  # `claim --next` (line 138-150) refuses gitter on the --next path,
  # but the explicit-id path here is allowed per ADR-031 §allow-list.
  [ "$status" -eq 0 ]
  [ "$(_task_status "$rid")" = "in-progress" ]
  [ "$(_task_owner "$rid")" = "gitter" ]
}

# ---------- CELL 6 — explicit --lane review override ----------

@test "claim --next --lane review: lane=fe member CAN claim review Task with explicit override" {
  local rid; rid="$(_seed_review_task)"

  run "$ATMUX_BIN" claim --next --as fe-test --lane review
  [ "$status" -eq 0 ]
  [[ "$output" == *"$rid"* ]]
  [ "$(_task_status "$rid")" = "in-progress" ]
  [ "$(_task_owner "$rid")" = "fe-test" ]
}

# ---------- regression: non-review tasks still claimable across lanes ----------

@test "claim --next: lane=fe member STILL cross-lane'd into a lane=be Task (carve-out is review-only)" {
  local bid; bid="$("$ATMUX_BIN" task add "BE chore" --lane be 2>/dev/null | tail -1)"
  [[ "$bid" =~ ^t- ]]

  run "$ATMUX_BIN" claim --next --as fe-test
  [ "$status" -eq 0 ]
  [[ "$output" == *"$bid"* ]]
  [ "$(_task_status "$bid")" = "in-progress" ]
  [ "$(_task_owner "$bid")" = "fe-test" ]
}

# ---------- AUDIT t-ac338265 — dispatch path pin (H5 / OQ3) ----------
# Audit verdict: claim --next / explicit-id paths gate correctly (CELLs 1-7
# above prove it). Production failure (fe-kanban + be-kanban-2 auto-claiming
# review Tasks) routed through `atmux dispatch` — owner-mutation site at
# lib/dispatch.sh:60-64 has NO lane refuse-gate. Per d-7a648d40 OQ3 the
# dispatch-time gate was punted; this cell documents the gap so a future
# OQ3 reopen flips assertion direction (status==todo + owner==null) at
# the same time the gate ships.

@test "atmux dispatch <review-id> to lane=fe member: SUCCEEDS today (H5/OQ3 gap — lib/dispatch.sh has no lane gate)" {
  local rid; rid="$(_seed_review_task)"

  # Pre-create the recipient's tmux window so dispatch's send-keys nudge
  # doesn't die on missing-window. We only care about the kanban-side
  # mutation here.
  if command -v tmux >/dev/null 2>&1 && [[ -n "${TMUX_TMPDIR:-}" ]]; then
    tmux new-session -d -s "atmux-lprt" -n "__lprt__fe-test" 3>&- 4>&-  || true
  fi

  run "$ATMUX_BIN" dispatch fe-test "$rid"
  # The kanban-side write lands regardless of tmux send-keys outcome —
  # owner gets stamped to fe-test. THIS IS THE BUG SURFACE per t-ac338265.
  [ "$(_task_owner "$rid")" = "fe-test" ]
  [ "$(_task_status "$rid")" = "in-progress" ]
}

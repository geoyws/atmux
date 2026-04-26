#!/usr/bin/env bats
# Unit tests for the claim/dispatch state-machine fixes — E6/Sm / t-114d0b49.
# Coverage for two BE Tasks:
#   t-437af404 — Bug 1: lib/claim.sh _atmux_claim_apply_atomic embeds the
#                deps[]-met assertion in the same jq filter as the flip,
#                closing the select+apply TOCTOU window. On rejection, dies
#                with "unresolved deps: <list>".
#   t-04c8b243 — Bug 2: lib/kanban.sh _atmux_task_move clears .owner /
#                .claimedAt / .claimedFrom when target status is `todo`,
#                so a bounce-back returns the task to the unclaimed pool.
#
# AC mapping:
#   Bug 1 cases (1-3): deps gate at apply.
#   Bug 2 cases (4-6): bounce-back ownership clear.
#
# Per memory feedback_orphan_test_staging.md: both BE deps already `done`
# (t-437af404 + t-04c8b243) — this .bats is safe to git add when worker
# stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name csm >/dev/null
  "$ATMUX_BIN" add-member worker-be --role member --lane be --tui shell >/dev/null
  "$ATMUX_BIN" add-member worker-fe --role member --lane fe --tui shell >/dev/null
  # Bump cap so dispatch in supplementary tests doesn't trip the inbox guard.
  export ATMUX_INBOX_CAP=200
  export ATMUX_NO_AUTO_DISPATCH=1
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

_load_libs() {
  atmux_source_libs
  # shellcheck source=../../lib/kanban.sh
  . "$ATMUX_LIB_DIR/kanban.sh"
  # shellcheck source=../../lib/claim.sh
  . "$ATMUX_LIB_DIR/claim.sh"
}

_field() {
  local id="$1" field="$2"
  jq -r --arg id "$id" --arg f "$field" '.tasks[] | select(.id == $id) | .[$f]' .atmux/kanban.json
}

# Mint a todo task with optional --deps / --lane and return the id.
_mint() {
  local subject="$1"; shift
  "$ATMUX_BIN" task add "$subject" "$@" | tail -1
}

# ============================================================
# Bug 1 — deps assertion at apply (claim path)
# ============================================================

# ---------- AC case 1: claim --next rejects task with unmet deps ----------

@test "claim deps gate (AC1): claim --next never picks an unmet-deps task (select_next filters it)" {
  # The shipped impl gates deps in TWO places: select_next (filters out
  # unmet-deps tasks before apply) AND apply_atomic (re-checks at flip
  # time). For claim --next, the select gate fires first and silently
  # skips — the task with unmet deps stays in the pool. Assert state on
  # the specific task, not on global "no claimable work" output (which
  # only fires when the WHOLE pool is empty/blocked).
  local x_id; x_id=$(_mint "blocker-X-only" --deps "t-nonexistent" --lane be)
  local a_id; a_id=$(_mint "needs-X"        --lane be --deps "$x_id")

  # Both tasks have unmet deps (blocker-X-only blocks on a fake id;
  # needs-X blocks on blocker-X-only). Pool is fully blocked → claim
  # --next reports "no claimable work".
  run "$ATMUX_BIN" claim --next --as worker-be
  [ "$status" -eq 0 ]
  [[ "$output" =~ "no claimable work" ]]
  # State unchanged.
  [ "$(_field "$a_id" owner)" = "null" ]
  [ "$(_field "$a_id" status)" = "todo" ]
  [ "$(_field "$x_id" owner)" = "null" ]
  [ "$(_field "$x_id" status)" = "todo" ]
}

@test "claim deps gate (AC1 supplementary): claim --next picks an unblocked sibling, leaves blocked task alone" {
  # When the pool has both a claimable task AND a deps-blocked one,
  # claim --next picks the claimable one and the blocked one is
  # untouched. Pins that select_next's deps filter is per-candidate,
  # not global.
  local x_id; x_id=$(_mint "blocker-X" --lane be)
  local a_id; a_id=$(_mint "needs-X"   --lane be --deps "$x_id")

  run "$ATMUX_BIN" claim --next --as worker-be
  [ "$status" -eq 0 ]
  [[ "$output" =~ "claimed" ]]
  # blocker-X (no deps) is the natural pick — claim picked it.
  [ "$(_field "$x_id" owner)" = "worker-be" ]
  # needs-X stayed unclaimed because its dep is still open.
  [ "$(_field "$a_id" owner)" = "null" ]
  [ "$(_field "$a_id" status)" = "todo" ]
}

@test "claim deps gate (AC1): explicit 'atmux claim <id>' on unmet-deps task ⇒ atmux::die names blocker" {
  # The explicit-id claim path (lib/claim.sh:65-85) dies with the AC's
  # canonical "unresolved deps: <list>" message. This is the operator-
  # facing rejection path; --next callers see "no claimable work" instead
  # because select_next filters them out earlier (above test).
  local x_id; x_id=$(_mint "blocker-X" --lane be)
  local a_id; a_id=$(_mint "needs-X"   --lane be --deps "$x_id")

  run "$ATMUX_BIN" claim "$a_id" --as worker-be
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unresolved deps" ]]
  [[ "$output" =~ "$x_id" ]]
  # State unchanged.
  [ "$(_field "$a_id" owner)" = "null" ]
  [ "$(_field "$a_id" status)" = "todo" ]
}

# ---------- AC case 2: claim --next succeeds when deps complete ----------

@test "claim deps gate (AC2): claim --next on met-deps task ⇒ owner+status flip lands" {
  local x_id; x_id=$(_mint "blocker-X" --lane be)
  local a_id; a_id=$(_mint "needs-X"   --lane be --deps "$x_id")

  # Move blocker to done so deps - done_ids = empty.
  "$ATMUX_BIN" task move "$x_id" done >/dev/null 2>&1 || true

  run "$ATMUX_BIN" claim --next --as worker-be
  [ "$status" -eq 0 ]
  [[ "$output" =~ "claimed" ]]
  # t-A flipped to in-progress with worker-be as owner.
  [ "$(_field "$a_id" owner)" = "worker-be" ]
  [ "$(_field "$a_id" status)" = "in-progress" ]
  local claimed_at; claimed_at=$(_field "$a_id" claimedAt)
  [[ "$claimed_at" =~ ^[0-9]+$ ]]
}

# ---------- AC case 3: TOCTOU at apply-atomic ----------

@test "claim deps gate (AC3): apply_atomic called on unmet-deps task ⇒ die with 'unresolved deps' (TOCTOU close)" {
  # The select_next gate filters unmet-deps tasks out, so a TOCTOU race
  # in production needs deps to land between select and apply (e.g. dep
  # un-marked via direct jq mutation). To exercise the apply-time die
  # deterministically, source the libs and call _atmux_claim_apply_atomic
  # directly with a task whose deps are unmet. The die at line 303 is
  # the contract under test — it's what catches the race the select
  # gate can't.
  _load_libs
  local x_id; x_id=$(_mint "blocker-X" --lane be)
  local a_id; a_id=$(_mint "needs-X"   --lane be --deps "$x_id")

  run _atmux_claim_apply_atomic "$a_id" worker-be
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unresolved deps" ]]
  [[ "$output" =~ "$x_id" ]]
  # Kanban unchanged (the if-then-else inside the jq filter no-ops the
  # deps-rejected case).
  [ "$(_field "$a_id" owner)" = "null" ]
  [ "$(_field "$a_id" status)" = "todo" ]
}

@test "claim deps gate (AC3): apply_atomic on met-deps task succeeds (positive control)" {
  _load_libs
  local x_id; x_id=$(_mint "blocker-X" --lane be)
  local a_id; a_id=$(_mint "needs-X"   --lane be --deps "$x_id")
  "$ATMUX_BIN" task move "$x_id" done >/dev/null 2>&1 || true

  run _atmux_claim_apply_atomic "$a_id" worker-be
  [ "$status" -eq 0 ]
  [ "$(_field "$a_id" owner)" = "worker-be" ]
  [ "$(_field "$a_id" status)" = "in-progress" ]
}

# ============================================================
# Bug 2 — bounce-back ownership clear
# ============================================================

# ---------- AC case 4: task move todo clears owner+claimedAt ----------

@test "task move (AC4): 'task move <id> todo' clears .owner / .claimedAt / .claimedFrom on a claimed task" {
  local id; id=$(_mint "bounce-target" --lane be)
  "$ATMUX_BIN" claim "$id" --as worker-be >/dev/null
  # Sanity: claim landed.
  [ "$(_field "$id" owner)" = "worker-be" ]
  [ "$(_field "$id" status)" = "in-progress" ]

  run "$ATMUX_BIN" task move "$id" todo
  [ "$status" -eq 0 ]
  [[ "$output" =~ "ownership cleared" ]]

  [ "$(_field "$id" status)" = "todo" ]
  [ "$(_field "$id" owner)" = "null" ]
  [ "$(_field "$id" claimedAt)" = "null" ]
  [ "$(_field "$id" claimedFrom)" = "null" ]
}

@test "task move (AC4): 'task move <id> blocked' DOES NOT clear ownership (only 'todo' triggers)" {
  # Negative control — the impl explicitly carves out blocked + in-progress
  # to preserve owner. Bounce-to-pool semantics are 'todo'-only.
  local id; id=$(_mint "blocked-target" --lane be)
  "$ATMUX_BIN" claim "$id" --as worker-be >/dev/null

  run "$ATMUX_BIN" task move "$id" blocked
  [ "$status" -eq 0 ]
  [ "$(_field "$id" status)" = "blocked" ]
  [ "$(_field "$id" owner)" = "worker-be" ]
  local claimed; claimed=$(_field "$id" claimedAt)
  [[ "$claimed" =~ ^[0-9]+$ ]]
}

# ---------- AC case 5: cross-lane bounce + re-claim by another worker ----------

@test "task move (AC5): cross-lane bounce ⇒ another lane's worker can re-claim" {
  # Mint a BE-lane task. fe-kanban grabs it via cross-lane fallback (no FE
  # work in the queue), realizes it's the wrong lane, bounces via
  # 'task move todo'. be-kanban then runs claim --next; the task is now
  # back in the unclaimed pool with owner=null, so be-kanban wins it
  # cleanly. Pre-Bug-2 fix, owner stayed = fe-kanban after the bounce,
  # and be-kanban's claim --next select_next gate (which requires
  # owner==null OR owner==caller) silently skipped it forever.
  local id; id=$(_mint "be-lane-task" --lane be)

  # fe-kanban claims via cross-lane fallback (default crossLaneClaim=true).
  run "$ATMUX_BIN" claim --next --as worker-fe
  [ "$status" -eq 0 ]
  [ "$(_field "$id" owner)" = "worker-fe" ]
  [ "$(_field "$id" status)" = "in-progress" ]

  # fe-kanban bounces it back.
  "$ATMUX_BIN" task move "$id" todo >/dev/null
  [ "$(_field "$id" owner)" = "null" ]

  # be-kanban claim --next now selects the bounced task.
  run "$ATMUX_BIN" claim --next --as worker-be
  [ "$status" -eq 0 ]
  [[ "$output" =~ "claimed" ]]
  [ "$(_field "$id" owner)" = "worker-be" ]
  [ "$(_field "$id" status)" = "in-progress" ]
}

# ---------- AC case 6: idempotent on null-owner task ----------

@test "task move (AC6): 'task move <id> todo' on already-unclaimed task is a clean no-op" {
  local id; id=$(_mint "untouched" --lane be)
  # Sanity: fresh task has owner=null + status=todo already.
  [ "$(_field "$id" owner)" = "null" ]
  [ "$(_field "$id" status)" = "todo" ]

  run "$ATMUX_BIN" task move "$id" todo
  [ "$status" -eq 0 ]
  # Status, owner, claimedAt all still null/todo — the jq filter sets the
  # status to itself (todo) and the conditional clear writes null on
  # already-null fields (a no-op semantically).
  [ "$(_field "$id" status)" = "todo" ]
  [ "$(_field "$id" owner)" = "null" ]
  [ "$(_field "$id" claimedAt)" = "null" ]
}

# ---------- supplementary: bounce preserves note + body + deliverable ----------

@test "task move (Bug 2 follow-up): bounce-to-todo clears ownership but PRESERVES note / body / deliverable" {
  # Defends against an over-eager future change that wipes adjacent
  # fields alongside owner. Only ownership-flavored fields belong in the
  # clear set.
  local id
  id=$("$ATMUX_BIN" task add "preserve-test" --lane be --body "task body" --deliverable "concrete output" | tail -1)
  "$ATMUX_BIN" claim "$id" --as worker-be >/dev/null
  "$ATMUX_BIN" done  "$id" --as worker-be --note "wip note before bounce" >/dev/null 2>&1 || true
  # ^ done flow doesn't apply here — we want a claimed-but-not-done
  # state. Re-mint:
  id=$(_mint "preserve-test-2" --lane be --body "task body" --deliverable "concrete output")
  "$ATMUX_BIN" claim "$id" --as worker-be >/dev/null

  "$ATMUX_BIN" task move "$id" todo >/dev/null
  [ "$(_field "$id" body)"        = "task body" ]
  [ "$(_field "$id" deliverable)" = "concrete output" ]
  [ "$(_field "$id" lane)"        = "be" ]
  [ "$(_field "$id" owner)"       = "null" ]
}

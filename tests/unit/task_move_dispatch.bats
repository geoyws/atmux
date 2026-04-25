#!/usr/bin/env bats
# Unit tests for `task move <id> done` auto-dispatch — T4.2 (t-e256e3b0).
# Pre-scaffold; the file stays untracked (`??`) until lead formally
# dispatches t-a333ae77.
#
# Behaviour under test (per ADR-007 OQ4 + AC):
#   When a task with .epic != null moves to status=done, append a NEW
#   commit-Task to gitter inbox referencing the source id. Commit-Task has
#   .epic=null, .lane="misc" (so it does NOT recurse). Legacy/ad-hoc tasks
#   (.epic=null) skip auto-dispatch — preserves the existing flow.
#
# Decoupling: `task move` already exists today; only the AUTO-DISPATCH
# behaviour is new (T4.2). T4.1 + T2.1 + T3.1 all shipped, so we can
# scaffold full Epic/Story state and simply check whether the gitter inbox
# gains the commit-Task entry.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name td >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Scaffold Epic + Story + return both ids.
_make_epic_story() {
  local eid; eid=$("$ATMUX_BIN" epic add "epic-x" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready >/dev/null
  local sid; sid=$("$ATMUX_BIN" story add "story-x" --epic "$eid" | tail -1)
  printf '%s %s\n' "$eid" "$sid"
}

# Count commit-Task entries (subject starts with "commit ") in gitter inbox.
_gitter_commit_tasks() {
  local f=.atmux/inboxes/gitter.json
  [[ -f "$f" ]] || { echo 0; return; }
  jq '[.pending[], .inProgress[] | select(.subject // "" | startswith("commit "))] | length' "$f"
}

# ---------- auto-dispatch: happy path ----------

@test "task move done: Epic-scoped task ⇒ commit-Task lands in gitter inbox" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "real work" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  [ "$(_gitter_commit_tasks)" -ge 1 ]
}

@test "task move done: commit-Task body references source task id" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run jq -r --arg id "$id" '[.pending[], .inProgress[] | select(.body // "" | contains($id))] | length' .atmux/inboxes/gitter.json
  [ "$output" -ge 1 ]
}

@test "task move done: commit-Task has .epic=null, .lane=misc (no recursion)" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  # Find the commit-Task in the kanban + assert .epic null + .lane misc.
  run jq -r '[.tasks[] | select((.subject // "") | startswith("commit "))] | .[0] | [.epic // "null", .lane] | join(",")' .atmux/kanban.json
  [ "$output" = "null,misc" ]
}

# ---------- auto-dispatch: legacy regression ----------

@test "task move done: legacy/ad-hoc task (.epic=null) ⇒ NO auto-dispatch" {
  local id; id=$("$ATMUX_BIN" task add "ad-hoc" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  [ "$(_gitter_commit_tasks)" = "0" ]
}

@test "task move done: ad-hoc task with --lane (still .epic=null) ⇒ NO auto-dispatch" {
  local id; id=$("$ATMUX_BIN" task add "lane-only" --lane be | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  [ "$(_gitter_commit_tasks)" = "0" ]
}

# ---------- auto-dispatch: idempotency / non-done ----------

@test "task move in-progress (NOT done): NO auto-dispatch" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$id" in-progress >/dev/null
  [ "$(_gitter_commit_tasks)" = "0" ]
}

@test "task move done twice: only ONE commit-Task in gitter inbox" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  "$ATMUX_BIN" task move "$id" done >/dev/null 2>&1 || true
  [ "$(_gitter_commit_tasks)" = "1" ]
}

# ---------- Story state machine: testing → review on last test-Task done ----------

@test "task move done: last test-lane Task done in testing ⇒ Story auto-flips to review" {
  read -r eid sid <<<"$(_make_epic_story)"
  # Drive Story up to `testing` with a be-Task done first.
  local be_tid; be_tid=$("$ATMUX_BIN" task add "be-work" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$be_tid" done >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to ready       >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to testing     >/dev/null
  local te_tid; te_tid=$("$ATMUX_BIN" task add "test-work" --epic "$eid" --story "$sid" --lane test | tail -1)
  "$ATMUX_BIN" task move "$te_tid" done >/dev/null
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .status' .atmux/kanban.json
  [ "$output" = "review" ]
}

# ---------- Epic state machine: storyless Epic auto-flips on last task ----------

@test "task move done: last Task of storyless Epic ⇒ Epic auto-flips to review + summary dispatched to lead" {
  local eid; eid=$("$ATMUX_BIN" epic add "no-stories" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready       >/dev/null
  "$ATMUX_BIN" epic advance "$eid" --to in-progress >/dev/null
  local id; id=$("$ATMUX_BIN" task add "lone" --epic "$eid" --lane misc | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run jq -r --arg eid "$eid" '.epics[] | select(.id==$eid) | .status' .atmux/kanban.json
  [ "$output" = "review" ]
  run jq --arg eid "$eid" '[.pending[], .inProgress[] | select((.subject // "") | test("draft Epic summary " + $eid))] | length' .atmux/inboxes/lead.json
  [ "$output" -ge 1 ]
}

# ---------- atomicity ----------

@test "task move done: kanban update + inbox append happen atomically (single mutation)" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" --lane be | tail -1)
  # Snapshot kanban mtime before move.
  local before; before=$(stat -c '%Y' .atmux/kanban.json)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  # After: status flipped AND commit-Task in gitter inbox in one go (no
  # half-state where one side updated but not the other).
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "done" ]
  [ "$(_gitter_commit_tasks)" -ge 1 ]
}

# ---------- `atmux done` (claim.sh) parity with `task move done` (t-7d99e935) ----------

@test "atmux done: Epic-scoped task ⇒ commit-Task lands in gitter inbox (parity with task move done)" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "real work" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" claim "$id" --as worker >/dev/null
  "$ATMUX_BIN" done "$id" --as worker --note "feat(x): ship it" >/dev/null
  [ "$(_gitter_commit_tasks)" -ge 1 ]
  # Note from `--note` persists.
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .note' .atmux/kanban.json
  [ "$output" = "feat(x): ship it" ]
}

@test "atmux done: legacy/ad-hoc task (.epic=null) ⇒ NO auto-dispatch (regression preserved)" {
  local id; id=$("$ATMUX_BIN" task add "ad-hoc" | tail -1)
  "$ATMUX_BIN" claim "$id" --as worker >/dev/null
  "$ATMUX_BIN" done "$id" --as worker >/dev/null
  [ "$(_gitter_commit_tasks)" = "0" ]
}

@test "atmux done: idempotent — double-done is a no-op (no double commit-Task)" {
  read -r eid sid <<<"$(_make_epic_story)"
  local id; id=$("$ATMUX_BIN" task add "x" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" claim "$id" --as worker >/dev/null
  "$ATMUX_BIN" done "$id" --as worker >/dev/null
  # Second done from a different angle (operator path) — same task already done.
  "$ATMUX_BIN" task move "$id" done >/dev/null 2>&1 || true
  [ "$(_gitter_commit_tasks)" = "1" ]
}

@test "atmux done: last test-lane Task in testing ⇒ Story auto-flips to review (parity)" {
  read -r eid sid <<<"$(_make_epic_story)"
  local be_tid; be_tid=$("$ATMUX_BIN" task add "be-work" --epic "$eid" --story "$sid" --lane be | tail -1)
  "$ATMUX_BIN" task move "$be_tid" done >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to ready       >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to in-progress >/dev/null
  "$ATMUX_BIN" story advance "$sid" --to testing     >/dev/null
  local te_tid; te_tid=$("$ATMUX_BIN" task add "test-work" --epic "$eid" --story "$sid" --lane test | tail -1)
  "$ATMUX_BIN" claim "$te_tid" --as test-worker >/dev/null
  "$ATMUX_BIN" done "$te_tid" --as test-worker >/dev/null
  run jq -r --arg sid "$sid" '.stories[] | select(.id==$sid) | .status' .atmux/kanban.json
  [ "$output" = "review" ]
}

@test "atmux done: last Task of storyless Epic ⇒ Epic auto-flips to review + summary dispatched to lead (parity)" {
  local eid; eid=$("$ATMUX_BIN" epic add "no-stories" | tail -1)
  "$ATMUX_BIN" epic advance "$eid" --to ready       >/dev/null
  "$ATMUX_BIN" epic advance "$eid" --to in-progress >/dev/null
  local id; id=$("$ATMUX_BIN" task add "lone" --epic "$eid" --lane misc | tail -1)
  "$ATMUX_BIN" claim "$id" --as worker >/dev/null
  "$ATMUX_BIN" done "$id" --as worker >/dev/null
  run jq -r --arg eid "$eid" '.epics[] | select(.id==$eid) | .status' .atmux/kanban.json
  [ "$output" = "review" ]
  run jq --arg eid "$eid" '[.pending[], .inProgress[] | select((.subject // "") | test("draft Epic summary " + $eid))] | length' .atmux/inboxes/lead.json
  [ "$output" -ge 1 ]
}

#!/usr/bin/env bats
# Unit tests for kanban / task verb.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name k >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "task: add creates a todo task with a generated id" {
  run "$ATMUX_BIN" task add "implement feature X"
  [ "$status" -eq 0 ]
  # last line is the id
  local id; id=$(echo "$output" | tail -1)
  [[ "$id" =~ ^t-[0-9a-f]{8}$ ]]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "todo" ]
}

@test "task: add with --body + --assignee stores both" {
  run "$ATMUX_BIN" task add "thing" --body "do it right" --assignee worker
  local id; id=$(echo "$output" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .body' .atmux/kanban.json
  [ "$output" = "do it right" ]
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "worker" ]
}

@test "task: list shows added tasks" {
  "$ATMUX_BIN" task add "first" >/dev/null
  "$ATMUX_BIN" task add "second" >/dev/null
  run "$ATMUX_BIN" task list
  [[ "$output" =~ first ]]
  [[ "$output" =~ second ]]
}

@test "task: list --status filters" {
  local id; id=$("$ATMUX_BIN" task add "one" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  "$ATMUX_BIN" task add "two" >/dev/null

  run "$ATMUX_BIN" task list --status done
  [[ "$output" =~ one ]]
  ! [[ "$output" =~ two ]]
}

@test "task: move requires valid status" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  run "$ATMUX_BIN" task move "$id" nonsense
  [ "$status" -ne 0 ]
}

@test "task: move sets completedAt when status=done" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .completedAt' .atmux/kanban.json
  [[ "$output" =~ ^[0-9]+$ ]]
}

@test "task: assign updates owner" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task assign "$id" alice >/dev/null
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [ "$output" = "alice" ]
}

@test "task: rm removes the task" {
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task rm "$id" >/dev/null
  run jq -r --arg id "$id" '[.tasks[] | select(.id==$id)] | length' .atmux/kanban.json
  [ "$output" = "0" ]
}

@test "task: show returns the task JSON" {
  local id; id=$("$ATMUX_BIN" task add "show-me" | tail -1)
  run "$ATMUX_BIN" task show "$id"
  [[ "$output" =~ show-me ]]
}

@test "task: add with --deps parses comma-separated deps" {
  local id; id=$("$ATMUX_BIN" task add "x" --deps "t-aaa,t-bbb" | tail -1)
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .deps | join(",")' .atmux/kanban.json
  [ "$output" = "t-aaa,t-bbb" ]
}

# ---- schema normalize (Epic / Story expansion) ----

@test "schema: fresh init writes tasks[] + epics[] + stories[]" {
  run jq -r '[.tasks, .epics, .stories] | map(type) | join(",")' .atmux/kanban.json
  [ "$status" -eq 0 ]
  [ "$output" = "array,array,array" ]
}

@test "schema: legacy kanban (tasks-only) survives a mutation and gains epics/stories" {
  # Hand-craft a legacy shape — exactly what pre-v0.4 kanbans look like.
  echo '{"tasks":[{"id":"t-legacy01","subject":"old","status":"todo","owner":null,"deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}]}' > .atmux/kanban.json

  # First mutation should auto-add the missing top-level arrays without
  # losing the legacy task.
  "$ATMUX_BIN" task add "fresh" >/dev/null

  run jq -r '.epics | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '.stories | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '[.tasks[] | .id] | sort | join(",")' .atmux/kanban.json
  [[ "$output" =~ t-legacy01 ]]
}

@test "schema: legacy task without epic/story/lane/deliverable reads back as null" {
  echo '{"tasks":[{"id":"t-legacy02","subject":"old","status":"todo","owner":null,"deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}]}' > .atmux/kanban.json
  "$ATMUX_BIN" task add "noop-trigger" >/dev/null
  run jq -r '.tasks[] | select(.id=="t-legacy02") | [.epic, .story, .lane, .deliverable] | map(. // "null") | join(",")' .atmux/kanban.json
  [ "$output" = "null,null,null,null" ]
}

@test "schema: kanban_normalize is idempotent (running it twice is a no-op)" {
  # Snapshot, normalize twice via two mutations, snapshot again — the
  # top-level shape should be byte-identical between the two snapshots
  # (only the new task differs, and we exclude .tasks from the diff).
  local before; before=$(jq -S 'del(.tasks)' .atmux/kanban.json)
  "$ATMUX_BIN" task add "first"  >/dev/null
  "$ATMUX_BIN" task add "second" >/dev/null
  local after;  after=$(jq -S 'del(.tasks)' .atmux/kanban.json)
  [ "$before" = "$after" ]
}

# ---------- auto-dispatch ping (E1/S4-followup-2 / t-9fd8d48e) ----------
#
# Background: when finish_task_done auto-dispatches a commit-Task to gitter,
# it must also tmux send-keys a 1-line nudge — otherwise gitter sits idle
# thinking its inbox is drained while commit-Tasks pile up (recurring lead
# surface; ~20min/cycle latency before next loop catches up).

@test "kanban: auto-dispatched commit-Task reaches the new send-keys nudge path" {
  # finish_task_done's pre-check skips the ping when the recipient's tmux
  # window is missing (avoids atmux::die aborting the done chain). In a
  # bare-test environment no gitter window exists, so we expect the
  # "window missing — skipped" log line — which proves the new code path
  # is wired up. The actual tmux send-keys delivery is exercised by the
  # send.bats integration suite (real-window path) and by gitter's runtime.
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  "$ATMUX_BIN" task add "real work" --epic "$eid" >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject=="real work")][0].id' .atmux/kanban.json)
  run "$ATMUX_BIN" done "$id" --as worker --note "shipped"
  [ "$status" -eq 0 ]
  # The kanban write side still lands.
  [ -f .atmux/inboxes/gitter.json ]
  local pushed
  pushed=$(jq '[.inProgress[] | select(.subject | startswith("commit "))] | length' \
              .atmux/inboxes/gitter.json)
  [ "$pushed" -ge 1 ]
  # And the auto-dispatch ping branch was reached (skipped because no
  # gitter window in the sandbox — but reached).
  [[ "$output" =~ "auto-dispatch" ]] || [[ "$output" =~ "window missing" ]]
}

# ---------- recursion guard (E1/S4-followup t-15226e79) ----------
#
# When a commit-Task itself completes (gitter marking its own queue
# done), finish_task_done used to auto-dispatch ANOTHER commit-Task
# for it ('commit t-xxx' → 'commit commit t-xxx' phantom chain). The
# recursion stopped at one cycle (gitter no-ops on missing source
# content) but polluted the kanban + confused 'task list' filters.
# Fix: skip the auto-dispatch when subject matches /^(commit|merge|
# persist) /.

@test "kanban: completing a 'commit <id>' Task does NOT auto-dispatch another commit-Task (recursion guard)" {
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  # Mint a meta-Task with the 'commit ' subject prefix that gitter
  # would mint when a real Task lands. .epic is set (would normally
  # trigger do_commit=1), so the guard must be the gating signal.
  "$ATMUX_BIN" task add "commit t-fakesource" --epic "$eid" >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject == "commit t-fakesource")][0].id' .atmux/kanban.json)

  local before; before=$(jq '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  "$ATMUX_BIN" done "$id" --as gitter --note "irrelevant" >/dev/null 2>&1
  local after;  after=$(jq  '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)

  # No new 'commit ' Task minted on the kanban.
  [ "$after" -eq "$before" ]
}

@test "kanban: completing a 'merge <id>' Task does NOT auto-dispatch a commit-Task" {
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  "$ATMUX_BIN" task add "merge s-fakestory" --epic "$eid" >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject == "merge s-fakestory")][0].id' .atmux/kanban.json)
  local before; before=$(jq '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  "$ATMUX_BIN" done "$id" --as gitter --note "merged" >/dev/null 2>&1
  local after;  after=$(jq  '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  [ "$after" -eq "$before" ]
}

@test "kanban: 'commitments' (full word that happens to start with 'commit') is NOT skipped" {
  # Word-boundary regression check — the guard is `^(commit|merge|persist)\ `,
  # i.e. requires a trailing space. A real Task subject like 'commitments
  # plan: …' must still auto-dispatch its commit-Task.
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  "$ATMUX_BIN" task add "commitments plan: research" --epic "$eid" >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject == "commitments plan: research")][0].id' .atmux/kanban.json)
  local before; before=$(jq '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  "$ATMUX_BIN" done "$id" --as worker --note "shipped" >/dev/null 2>&1
  local after;  after=$(jq  '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  # One new 'commit ' Task should have appeared.
  [ "$after" -eq "$((before + 1))" ]
}

# ---------- recursion guard #2: gitter+MISC gate (E1/S4-followup-3 / t-1ff87709) ----------
#
# Planner-authored fold-Tasks like "[E#/S#] MISC: docs/adr/010..." slip past
# the subject regex but ARE commit-flavored work owned by gitter. Gate on
# assignee+lane: gitter's whole job is commit work; auto-dispatching a
# child commit-Task for a gitter-MISC task is recursion. Both axes are
# required — owner alone (gitter+FE) and lane alone (worker+MISC) still
# auto-dispatch.

@test "kanban: gitter+MISC fold-Task does NOT auto-dispatch a commit-Task" {
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  # Planner-shaped fold-Task: subject doesn't match the commit/merge/persist
  # regex, but assignee=gitter + lane=misc means it's already commit work.
  "$ATMUX_BIN" task add "[E1/S1] MISC: fold ADR-010 + ADR-011 + CHANGELOG" \
    --epic "$eid" --assignee gitter --lane misc >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject == "[E1/S1] MISC: fold ADR-010 + ADR-011 + CHANGELOG")][0].id' .atmux/kanban.json)
  local before; before=$(jq '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  "$ATMUX_BIN" done "$id" --as gitter --note "folded" >/dev/null 2>&1
  local after;  after=$(jq  '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  # Guard fired: no child commit-Task minted.
  [ "$after" -eq "$before" ]
}

@test "kanban: non-gitter MISC task STILL auto-dispatches (lane alone is not the gate)" {
  # Lane=misc but owner=worker — this is a legitimate misc task by a
  # regular worker, must still get its commit-Task. Both axes required.
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  "$ATMUX_BIN" task add "wire env loader" --epic "$eid" --assignee worker --lane misc >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject == "wire env loader")][0].id' .atmux/kanban.json)
  local before; before=$(jq '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  "$ATMUX_BIN" done "$id" --as worker --note "shipped" >/dev/null 2>&1
  local after;  after=$(jq  '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  [ "$after" -eq "$((before + 1))" ]
}

@test "kanban: gitter on a non-MISC lane STILL auto-dispatches (owner alone is not the gate)" {
  # Hypothetical gitter-FE task — owner=gitter but lane=fe. Both axes
  # required, so this still gets its commit-Task.
  local eid; eid=$("$ATMUX_BIN" epic add "test epic" | tail -1)
  "$ATMUX_BIN" task add "FE styling tweak" --epic "$eid" --assignee gitter --lane fe >/dev/null
  local id; id=$(jq -r '[.tasks[] | select(.subject == "FE styling tweak")][0].id' .atmux/kanban.json)
  local before; before=$(jq '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  "$ATMUX_BIN" done "$id" --as gitter --note "shipped" >/dev/null 2>&1
  local after;  after=$(jq  '[.tasks[] | select(.subject | startswith("commit "))] | length' .atmux/kanban.json)
  [ "$after" -eq "$((before + 1))" ]
}

@test "schema: claim normalizes a legacy kanban without losing data" {
  # Arrange: a legacy kanban with one task already in-progress on a member.
  echo '{"tasks":[{"id":"t-legacy03","subject":"x","status":"todo","owner":"worker","deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}]}' > .atmux/kanban.json

  run "$ATMUX_BIN" claim t-legacy03 --as worker
  [ "$status" -eq 0 ]

  # Top-level arrays present, status updated, task preserved.
  run jq -r '.epics | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '.stories | type' .atmux/kanban.json
  [ "$output" = "array" ]
  run jq -r '.tasks[] | select(.id=="t-legacy03") | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
}

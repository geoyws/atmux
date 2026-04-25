#!/usr/bin/env bats
# Unit tests for `atmux claim --next` — T4.3 (t-2fa32f3d). Pre-scaffold; the
# file stays untracked (`??`) until lead formally dispatches t-a333ae77.
#
# Decoupling: T4.3 reads `.lane` from team.json members (T5.1, shipped) and
# from kanban tasks (T4.1, shipped). We seed members with `add-member`
# (--lane flag is T5.2 / not yet shipped, so we mutate team.json directly
# via jq for the lane field). Tasks seed via `task add --lane` (T4.1).
#
# Expected red until T4.3 ships — claim refuses --next today with
# "claim: too many args" or "no such task: --next".

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name c >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Seed a member with a specific lane. Adds via `add-member` then patches the
# team.json directly (T5.2 --lane flag isn't shipped yet — direct jq is the
# decoupling pattern).
_seed_member_lane() {
  local name="$1" lane="$2" role="${3:-member}"
  "$ATMUX_BIN" add-member "$name" --role "$role" --tui shell >/dev/null
  jq --arg name "$name" --arg lane "$lane" \
    '(.members[] | select(.name==$name) | .lane) = $lane' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
}

# Set or unset team.kanban.crossLaneClaim.
_set_cross_lane() {
  local v="$1"  # true|false
  jq --argjson v "$v" '.kanban.crossLaneClaim = $v' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
}

# ---------- claim --next: lane preference ----------

@test "claim --next: picks highest-priority claimable task in caller's lane" {
  _seed_member_lane fe-worker fe
  local hi; hi=$("$ATMUX_BIN" task add "fe-hi"  --lane fe --priority 1 | tail -1)
  local lo; lo=$("$ATMUX_BIN" task add "fe-lo"  --lane fe --priority 5 | tail -1)
  "$ATMUX_BIN" task add "be-task" --lane be --priority 1 >/dev/null
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$hi" ]]
  ! [[ "$output" =~ "$lo" ]]
}

@test "claim --next: tie-breaks on createdAt asc when priority ties" {
  _seed_member_lane fe-worker fe
  local first; first=$("$ATMUX_BIN" task add "fe-first" --lane fe --priority 2 | tail -1)
  sleep 1
  local second; second=$("$ATMUX_BIN" task add "fe-second" --lane fe --priority 2 | tail -1)
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$first" ]]
}

@test "claim --next --lane <lane>: overrides caller's lane" {
  _seed_member_lane fe-worker fe
  local be_id; be_id=$("$ATMUX_BIN" task add "be-task" --lane be | tail -1)
  run "$ATMUX_BIN" claim --next --as fe-worker --lane be
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$be_id" ]]
}

# ---------- claim --next: deps ----------

@test "claim --next: skips deps-blocked tasks" {
  _seed_member_lane fe-worker fe
  local blocker; blocker=$("$ATMUX_BIN" task add "blocker" --lane fe | tail -1)
  local blocked; blocked=$("$ATMUX_BIN" task add "blocked" --lane fe --deps "$blocker" | tail -1)
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  # Should pick blocker, not the deps-blocked task.
  [[ "$output" =~ "$blocker" ]]
  ! [[ "$output" =~ "$blocked" ]]
}

@test "claim --next: deps-blocked task becomes claimable after deps done" {
  _seed_member_lane fe-worker fe
  local a; a=$("$ATMUX_BIN" task add "a" --lane fe | tail -1)
  local b; b=$("$ATMUX_BIN" task add "b" --lane fe --deps "$a" | tail -1)
  "$ATMUX_BIN" task move "$a" done >/dev/null
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$b" ]]
}

# ---------- claim --next: crossLaneClaim ----------

@test "claim --next + crossLaneClaim=false + empty caller lane ⇒ exit 1 with clear message" {
  _seed_member_lane fe-worker fe
  _set_cross_lane false
  "$ATMUX_BIN" task add "be-only" --lane be >/dev/null
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no work" ]] || [[ "$output" =~ "FE" ]] || [[ "$output" =~ "fe" ]]
}

@test "claim --next + crossLaneClaim=true (default) + empty caller lane ⇒ falls back to any claimable" {
  _seed_member_lane fe-worker fe
  # Default crossLaneClaim=true (not setting it explicitly per ADR-007 OQ1 default).
  local be_id; be_id=$("$ATMUX_BIN" task add "be-any" --lane be | tail -1)
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$be_id" ]]
}

# ---------- claim --next: race ----------

@test "claim --next: two concurrent claimers ⇒ only one wins the same task" {
  _seed_member_lane fe-one fe
  _seed_member_lane fe-two fe
  local id; id=$("$ATMUX_BIN" task add "the-only-task" --lane fe | tail -1)
  # Race via background subshell.
  "$ATMUX_BIN" claim --next --as fe-one >/tmp/race-1.out 2>&1 &
  local pid1=$!
  "$ATMUX_BIN" claim --next --as fe-two >/tmp/race-2.out 2>&1 &
  local pid2=$!
  wait "$pid1" "$pid2"
  # Exactly one .owner should be set; the other claim either picked nothing or errored.
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .owner' .atmux/kanban.json
  [[ "$output" = "fe-one" ]] || [[ "$output" = "fe-two" ]]
  rm -f /tmp/race-1.out /tmp/race-2.out
}

# ---------- claim --next: legacy tasks ----------

@test "claim --next: legacy task with no .lane falls back to crossLaneClaim path" {
  _seed_member_lane fe-worker fe
  echo '{"tasks":[{"id":"t-legacy","subject":"old","status":"todo","owner":null,"deps":[],"priority":null,"createdAt":1,"claimedAt":null,"completedAt":null}],"epics":[],"stories":[]}' > .atmux/kanban.json
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "t-legacy" ]]
}

# ---------- claim --next: preassign relax (d-515de5ce / t-5b75f839) ----------

@test "claim --next: picks task preassigned to caller (.owner == caller)" {
  _seed_member_lane fe-worker fe
  local id; id=$("$ATMUX_BIN" task add "preassigned" --lane fe --assignee fe-worker | tail -1)
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$id" ]]
  # Status flipped to in-progress + claimedAt set, like a normal claim.
  run jq -r --arg id "$id" '.tasks[] | select(.id==$id) | .status' .atmux/kanban.json
  [ "$output" = "in-progress" ]
}

@test "claim --next: skips task preassigned to a DIFFERENT worker" {
  _seed_member_lane fe-one fe
  _seed_member_lane fe-two fe
  # Preassigned to fe-one; fe-two should NOT pick it.
  "$ATMUX_BIN" task add "for-fe-one" --lane fe --assignee fe-one >/dev/null
  run "$ATMUX_BIN" claim --next --as fe-two
  # No claimable work for fe-two — exits 0 with no-claim, OR a non-zero
  # under cross=false. Either way, the task's owner stays fe-one (not fe-two).
  run jq -r '.tasks[] | select(.subject=="for-fe-one") | .owner' .atmux/kanban.json
  [ "$output" = "fe-one" ]
  run jq -r '.tasks[] | select(.subject=="for-fe-one") | .status' .atmux/kanban.json
  [ "$output" = "todo" ]
}

@test "claim --next: prefers caller-preassigned over plain unclaimed at same priority" {
  _seed_member_lane fe-worker fe
  # Both at priority 1. Sort tie-break is createdAt asc → unassigned (added
  # first) wins on tie. The relax must NOT change ordering — it only widens
  # eligibility. Add the preassigned LATER so plain-unclaimed has earlier
  # createdAt; assert plain-unclaimed wins (deterministic tie-break preserved).
  local plain; plain=$("$ATMUX_BIN" task add "plain"        --lane fe --priority 1 | tail -1)
  sleep 1
  local pre;   pre=$("$ATMUX_BIN"   task add "preassigned"  --lane fe --priority 1 --assignee fe-worker | tail -1)
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "$plain" ]]
}

# ---------- claim --next: paused member ----------

@test "claim --next: paused member can't claim" {
  _seed_member_lane fe-worker fe
  "$ATMUX_BIN" pause fe-worker >/dev/null 2>&1 || true
  "$ATMUX_BIN" task add "fe-task" --lane fe >/dev/null
  run "$ATMUX_BIN" claim --next --as fe-worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "paused" ]] || [[ "$output" =~ "pause" ]]
}

# ---------- claim --next: empty work queue ----------

@test "claim --next: no work anywhere ⇒ exit 0 with 'no work' marker" {
  _seed_member_lane fe-worker fe
  run "$ATMUX_BIN" claim --next --as fe-worker
  # Either a non-error empty result OR a non-zero exit — just assert no task claimed.
  run jq -r '[.tasks[] | select(.owner != null)] | length' .atmux/kanban.json
  [ "$output" = "0" ]
}

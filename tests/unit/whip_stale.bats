#!/usr/bin/env bats
# Unit tests for whip stale-task gating — E2/S7 / t-b8583298.
#
# AC: cover the per-Task .staleMin override + the team default raised
# from 30 → 90 in init/templates. Tests fall into three groups:
#   1. config defaults  (team.json + init template)
#   2. task creation    (atmux task add --stale-min N → kanban.staleMin)
#   3. stale-count algorithm (lib/whip.sh:170 jq filter)
#
# Group 3 uses a contract-copy of the inline jq filter (lib/whip.sh
# doesn't expose the filter as a callable function and the bats sandbox
# has no live tmux session, so end-to-end whip-driven coverage would
# require spawning a fake session per case). Documented dual-update
# requirement on the helper below.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- contract-copy of lib/whip.sh:170 stale-count filter ----------
#
# DUAL-UPDATE: any change to lib/whip.sh's per-Task stale filter MUST
# update this helper in lockstep, or these tests silently drift from
# production. Asserts behavior, not implementation reuse — pair with
# integration tests for end-to-end coverage.
_count_stale_tasks() {
  local inbox="$1" now="$2" default_min="$3" rotated="${4:-0}"
  jq --argjson now "$now" --argjson default_min "$default_min" \
     --argjson rot "$rotated" \
    '[.inProgress[]?
      | (.claimedAt // .dispatchedAt // 0) as $base
      | ([$base, $rot] | max) as $anchor
      | ((.staleMin // $default_min) * 60) as $task_s
      | select(($anchor + $task_s) < $now)
     ] | length' "$inbox" 2>/dev/null || echo 0
}

# ---------- 1. config defaults ----------

@test "whip stale: fresh atmux init writes whip.staleMin=90 (raised from 30 in S7)" {
  # `atmux init --name w` already ran in setup. Read team.json + assert.
  local got; got=$(jq -r '.whip.staleMin' .atmux/team.json)
  [ "$got" = "90" ]
}

@test "whip stale: templates/team.example.json default is 90" {
  # Source-of-truth: the template that init copies from.
  local got; got=$(jq -r '.whip.staleMin' "$ATMUX_REPO_ROOT/templates/team.example.json")
  [ "$got" = "90" ]
}

@test "whip stale: existing team with explicit staleMin=30 is preserved (no migration)" {
  # Pre-S7 teams shipped with staleMin=30. The S7 default lift must NOT
  # auto-rewrite live team.json files — explicit values are user choices.
  jq '.whip.staleMin = 30' .atmux/team.json > .atmux/team.json.tmp
  mv .atmux/team.json.tmp .atmux/team.json
  # Run a handful of read-side and write-side commands that touch state.
  "$ATMUX_BIN" task add "x" >/dev/null
  "$ATMUX_BIN" decisions add "Q?" --default "y" --reversibility low >/dev/null
  "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  local got; got=$(jq -r '.whip.staleMin' .atmux/team.json)
  [ "$got" = "30" ]
}

# ---------- 2. task creation ----------

@test "whip stale: 'task add --stale-min 45 foo' writes .staleMin=45 to kanban" {
  local id; id=$("$ATMUX_BIN" task add --stale-min 45 "foo" | tail -1)
  local got; got=$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .staleMin' .atmux/kanban.json)
  [ "$got" = "45" ]
}

@test "whip stale: 'task add foo' (no --stale-min) writes .staleMin=null" {
  local id; id=$("$ATMUX_BIN" task add "foo" | tail -1)
  local got; got=$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .staleMin' .atmux/kanban.json)
  [ "$got" = "null" ]
}

@test "whip stale: 'task add --stale-min 0 foo' rejected (must be positive)" {
  run "$ATMUX_BIN" task add --stale-min 0 "foo"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "positive integer" ]]
}

@test "whip stale: 'task add --stale-min abc foo' rejected (non-numeric)" {
  run "$ATMUX_BIN" task add --stale-min abc "foo"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "positive integer" ]]
}

# ---------- 3. stale-count filter (contract-copy of lib/whip.sh:170) ----------

@test "whip stale: per-Task .staleMin=10 + age=15min ⇒ flagged (override beats team default 90)" {
  local now; now=$(date +%s)
  local fifteen_ago=$(( now - 15*60 ))
  cat > inbox.json <<EOF
{"inProgress":[{"id":"t1","staleMin":10,"claimedAt":$fifteen_ago}]}
EOF
  run _count_stale_tasks inbox.json "$now" 90
  [ "$output" = "1" ]
}

@test "whip stale: no .staleMin + age=45min + team default=90 ⇒ NOT flagged" {
  local now; now=$(date +%s)
  local fortyfive_ago=$(( now - 45*60 ))
  cat > inbox.json <<EOF
{"inProgress":[{"id":"t1","claimedAt":$fortyfive_ago}]}
EOF
  run _count_stale_tasks inbox.json "$now" 90
  [ "$output" = "0" ]
}

@test "whip stale: per-Task .staleMin=120 + age=60min ⇒ NOT flagged (override permits longer)" {
  local now; now=$(date +%s)
  local sixty_ago=$(( now - 60*60 ))
  cat > inbox.json <<EOF
{"inProgress":[{"id":"t1","staleMin":120,"claimedAt":$sixty_ago}]}
EOF
  run _count_stale_tasks inbox.json "$now" 90
  [ "$output" = "0" ]
}

@test "whip stale: rotation epoch newer than claimedAt ⇒ counts from rotation (clean slate)" {
  # Symmetric to t-59ffacfd: a rotation resets the stale anchor — a Task
  # claimed pre-rotation that's now "old" by its claimedAt should NOT
  # trigger if the member rotated more recently.
  local now; now=$(date +%s)
  local two_hours_ago=$(( now - 7200 ))
  local five_min_ago=$((  now - 300  ))
  cat > inbox.json <<EOF
{"inProgress":[{"id":"t1","claimedAt":$two_hours_ago}]}
EOF
  # default 30, rotated 5min ago → anchor = 5min ago, 5min < 30min ⇒ NOT stale
  run _count_stale_tasks inbox.json "$now" 30 "$five_min_ago"
  [ "$output" = "0" ]
}

@test "whip stale: mixed inProgress with + without .staleMin tallies independently" {
  # One overridden short stale (flagged), one default-bound long (not).
  local now; now=$(date +%s)
  local twenty_ago=$(( now - 20*60 ))
  cat > inbox.json <<EOF
{"inProgress":[
  {"id":"t1","staleMin":10,"claimedAt":$twenty_ago},
  {"id":"t2","claimedAt":$twenty_ago}
]}
EOF
  run _count_stale_tasks inbox.json "$now" 90
  # Only t1 (override 10min, age 20min) is stale; t2 (default 90, age 20min) is not.
  [ "$output" = "1" ]
}

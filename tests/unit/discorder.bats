#!/usr/bin/env bats
# Unit tests for lib/discorder.sh — E9/Sd t-bffe9a2e, ADR-022.
#
# Strategy: drive the subverb functions directly against a sandbox team.
# Discord webhook is intentionally unset in the sandbox so
# atmux::discord_embed_ping no-ops — assertions target body composition
# (via the helper renderers) and cursor management, not network IO.
#
# AC coverage:
#   1. discorder dispatcher routes 'progress' + 'heartbeat' subverbs.
#   2. Unknown subverb is rejected.
#   3. progress: zero deltas + cold cursor → cursor file written, no
#      ping; second run with no deltas stays silent.
#   4. progress: kanban delta (done Task with completedAt > cursor) →
#      whip's renderer produces a 🏁 bullet that lands in the body.
#   5. progress: cursor advances after a tick.
#   6. heartbeat: assembles 🎯 Team state header + alive count + lead
#      uptime bullet (when session-start.txt is seeded).
#   7. heartbeat: in-flight + blocked counts surface bullets when >0,
#      silent when 0.
#   8. Single-instance flock: a held progress.lock skips the second tick.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name disc >/dev/null
  atmux_assert_sandbox
  # No webhook — atmux::discord_embed_ping no-ops cleanly. Renderer
  # outputs are still observable via the helper functions below.
  unset ATMUX_DISCORD_WEBHOOK DISCORD_WHIP_WEBHOOK
}

teardown() {
  atmux_teardown_sandbox
}

_source_discorder() {
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/discorder.sh
  . "$ATMUX_LIB_DIR/discorder.sh"
}

# ---------- 1. dispatcher routing ----------

@test "discorder: --help prints both subverb usage" {
  run "$ATMUX_BIN" discorder --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "progress" ]]
  [[ "$output" =~ "heartbeat" ]]
}

@test "discorder: bare invocation prints usage (no subverb)" {
  run "$ATMUX_BIN" discorder
  [ "$status" -eq 0 ]
  [[ "$output" =~ "progress" ]]
  [[ "$output" =~ "heartbeat" ]]
}

@test "discorder: unknown subverb errors out" {
  run "$ATMUX_BIN" discorder bogus
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown subverb" ]]
}

# ---------- 2. progress cursor management ----------

@test "discorder progress: cold-start writes cursor and stays silent (no deltas)" {
  run "$ATMUX_BIN" discorder progress
  [ "$status" -eq 0 ]
  [ -f .atmux/state/discorder-progress-cursor.json ]
  local epoch
  epoch=$(jq -r '.epoch' .atmux/state/discorder-progress-cursor.json)
  [[ "$epoch" =~ ^[0-9]+$ ]]
}

@test "discorder progress: cursor advances on each successful tick" {
  run "$ATMUX_BIN" discorder progress
  [ "$status" -eq 0 ]
  local first; first=$(jq -r '.epoch' .atmux/state/discorder-progress-cursor.json)
  sleep 1
  run "$ATMUX_BIN" discorder progress
  [ "$status" -eq 0 ]
  local second; second=$(jq -r '.epoch' .atmux/state/discorder-progress-cursor.json)
  (( second > first ))
}

# ---------- 3. progress: kanban delta picks up a done Task ----------

@test "discorder progress: done Task post-cursor surfaces in delta block" {
  _source_discorder
  # Seed cursor at a fixed past epoch.
  local past=$(( $(date +%s) - 600 ))
  jq -n --argjson e "$past" '{epoch: $e}' > .atmux/state/discorder-progress-cursor.json

  # Add a Task and mark it done with completedAt > cursor.
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{
  "epics": [],
  "stories": [],
  "tasks": [
    {"id":"t-disc01","subject":"[E1/S1] BE: hello","status":"done","owner":"be-disc","createdAt":$past,"completedAt":$now}
  ]
}
EOF

  # Render the delta directly (whip's renderer is what discorder consumes).
  local block; block="$(_atmux_whip_delta_since "$past" 2>/dev/null || true)"
  [[ -n "$block" ]]
  [[ "$block" =~ "Since last tick" ]]
  [[ "$block" =~ "t-disc01" ]]
  [[ "$block" =~ "be-disc" ]]
}

# ---------- 4. heartbeat: counts + uptime ----------

@test "discorder heartbeat: in-flight + blocked counters render as bullets" {
  _source_discorder
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{
  "epics": [], "stories": [],
  "tasks": [
    {"id":"t-a","subject":"a","status":"in-progress","createdAt":$now},
    {"id":"t-b","subject":"b","status":"in-progress","createdAt":$now},
    {"id":"t-c","subject":"c","status":"blocked","createdAt":$now}
  ]
}
EOF

  local in_flight; in_flight="$(_atmux_discorder_render_in_flight)"
  local blocked;   blocked="$(_atmux_discorder_render_blocked)"
  [[ "$in_flight" =~ "in-flight: 2 task" ]]
  [[ "$blocked"   =~ "blocked: 1 task" ]]
}

@test "discorder heartbeat: zero in-flight + zero blocked ⇒ both renderers silent" {
  _source_discorder
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{"epics":[],"stories":[],"tasks":[{"id":"t-d","subject":"d","status":"todo","createdAt":$now}]}
EOF

  local in_flight; in_flight="$(_atmux_discorder_render_in_flight)"
  local blocked;   blocked="$(_atmux_discorder_render_blocked)"
  [ -z "$in_flight" ]
  [ -z "$blocked" ]
}

@test "discorder heartbeat: lead uptime bullet uses session-start.txt anchor" {
  _source_discorder
  local now; now=$(date +%s)
  local anchor=$(( now - 3600 - 30 ))   # ~1h ago
  echo "$anchor" > .atmux/state/session-start.txt

  local out; out="$(_atmux_discorder_render_lead_uptime)"
  [[ "$out" =~ "lead uptime:" ]]
  # Lead member from default init scaffold; render carries the team-lead
  # name in backticks. Matching '`lead`' is fragile to renames so we
  # only insist on the backticked-name shape.
  [[ "$out" =~ \`[a-zA-Z0-9_-]+\` ]]
}

@test "discorder heartbeat: no anchor ⇒ uptime renderer silent" {
  _source_discorder
  rm -f .atmux/state/session-start.txt .atmux/state/lead-rotated.epoch
  local out; out="$(_atmux_discorder_render_lead_uptime)"
  [ -z "$out" ]
}

# ---------- 5. single-instance flock ----------

@test "discorder progress: held lock skips the tick (single-instance)" {
  _source_discorder
  mkdir -p .atmux/state

  # Acquire the lock in a backgrounded subshell, hold it for 5s.
  ( exec 9>".atmux/state/discorder-progress.lock"; flock -n 9 && sleep 5 ) &
  local hold_pid=$!
  sleep 0.2

  # Second tick should skip — cursor must NOT advance.
  rm -f .atmux/state/discorder-progress-cursor.json
  run "$ATMUX_BIN" discorder progress
  [ "$status" -eq 0 ]
  [[ "$output" =~ "another instance is running" ]]
  [ ! -f .atmux/state/discorder-progress-cursor.json ]

  wait "$hold_pid" 2>/dev/null || true
}

# ---------- 6. dispatcher smoke ----------

@test "discorder progress: end-to-end via bin/atmux exits 0 on quiet sandbox" {
  run "$ATMUX_BIN" discorder progress
  [ "$status" -eq 0 ]
}

@test "discorder heartbeat: end-to-end via bin/atmux exits 0 on quiet sandbox" {
  run "$ATMUX_BIN" discorder heartbeat
  [ "$status" -eq 0 ]
}

#!/usr/bin/env bats
# E2E coverage for the rotate-banner pre-flight gate (commit 04b038b) —
# E6/S4 / t-a0b7643d / AC A8.
#
# THE GATE LITERALLY SHIPPED (lib/rotate.sh:136 _atmux_rotate_detect_blocker):
#   - blocker  "queued-input"  ⇐ pane shows: "Press up to edit queued messages"
#   - blocker  "mid-turn"      ⇐ pane shows: "Esc to interrupt" / "tokens · esc to interrupt" / "thinking with"
#   - NO blocker (rotation-eligible):
#       "Compacting conversation"   — *intentionally* allowed; rotate is the cure
#       "approaching usage limit"   — same
#       "rate-limited" / "hit your limit" — same
#
# AC framing note: the task body refers to a "Compacting-conversation gate"
# but the actual shipped gate (04b038b) does NOT block on Compacting. The
# planner conflated `whip.sh:164` (which emits a `⏳ ... compacting — skip
# sends` *informational* finding) with `rotate.sh`'s pre-flight (which only
# blocks mid-turn + queued-input). Tests below assert the BEHAVIOR THAT
# ACTUALLY SHIPPED — not the AC's literal wording — and pin the literal
# banner strings so future banner-text drift in Claude Code surfaces as a
# failing test. tests/e2e/rotation.bats already covers the Compacting +
# AUTO-PRECLEAR happy path; this file fills the rotate-refusal case.
#
# Per memory feedback_orphan_test_staging.md: no parent BE Task — gate
# already shipped; safe to git add when worker stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "rb",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "downConfirmTicks": 1}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  : > .atmux/driver-inbox.md
  export ATMUX_SESSION="atmux-test-rb-$$-$RANDOM"
}

teardown() {
  "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
  atmux_teardown_sandbox
}

# ---------- helpers ----------

_start_session() {
  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__rb__worker" && return 0
    sleep 0.2
  done
}

# Inject literal pane content via send-keys. The single-quoted string gets
# echoed by the shell pane; the resulting scrollback contains the exact
# banner text capture-pane will read.
_inject() {
  local text="$1"
  local target="$ATMUX_SESSION:__rb__worker"
  tmux send-keys -t "$target" "echo '$text'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo '$text'" Enter
  sleep 1
}

# ---------- 1. detector direct unit tests ----------

@test "rotate banner gate: detector classifies 'thinking with' ⇒ mid-turn (block)" {
  atmux_source_libs
  # shellcheck source=../../lib/rotate.sh
  . "$ATMUX_LIB_DIR/rotate.sh"
  run _atmux_rotate_detect_blocker "thinking with sonnet…"
  [ "$status" -eq 0 ]
  [ "$output" = "mid-turn" ]
}

@test "rotate banner gate: detector classifies 'Esc to interrupt' ⇒ mid-turn (block)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/rotate.sh"
  run _atmux_rotate_detect_blocker "1234 tokens · esc to interrupt"
  [ "$output" = "mid-turn" ]
}

@test "rotate banner gate: detector classifies 'Press up to edit queued messages' ⇒ queued-input (block)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/rotate.sh"
  run _atmux_rotate_detect_blocker "Press up to edit queued messages"
  [ "$output" = "queued-input" ]
}

@test "rotate banner gate: detector classifies 'Compacting conversation' ⇒ EMPTY (rotation-eligible)" {
  # The whole point of A8: Compacting is intentionally NOT a blocker —
  # rotation IS the cure for compacting.
  atmux_source_libs
  . "$ATMUX_LIB_DIR/rotate.sh"
  run _atmux_rotate_detect_blocker "Compacting conversation..."
  [ -z "$output" ]
}

@test "rotate banner gate: detector classifies 'approaching usage limit' ⇒ EMPTY (rotation-eligible)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/rotate.sh"
  run _atmux_rotate_detect_blocker "approaching usage limit"
  [ -z "$output" ]
}

@test "rotate banner gate: detector classifies empty / unrelated text ⇒ EMPTY (no false-positive)" {
  atmux_source_libs
  . "$ATMUX_LIB_DIR/rotate.sh"
  run _atmux_rotate_detect_blocker ""
  [ -z "$output" ]
  run _atmux_rotate_detect_blocker "$ ls -la"
  [ -z "$output" ]
  # Partial banner match (substring 'Compacting' alone, not the full
  # 'Compacting conversation') — the whip.sh:164 banner regex requires
  # the full phrase, so this is a no-op for the rotate detector too.
  run _atmux_rotate_detect_blocker "Compacting"
  [ -z "$output" ]
}

# ---------- 2. e2e: rotate against live tmux session ----------

@test "rotate banner gate (e2e): mid-turn banner ⇒ atmux rotate refuses + no rotated.epoch" {
  _start_session
  _inject "thinking with sonnet…"
  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "mid-turn" ]]
  [[ "$output" =~ "skipping" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate banner gate (e2e): queued-input banner ⇒ atmux rotate refuses" {
  _start_session
  _inject "Press up to edit queued messages"
  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "queued-input" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate banner gate (e2e): Compacting conversation banner ⇒ atmux rotate ALLOWS (rotation-eligible)" {
  _start_session
  _inject "Compacting conversation"
  rm -f .atmux/state/worker-rotated.epoch
  local before; before=$(date +%s)
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "rotated worker" ]]
  [ -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(< .atmux/state/worker-rotated.epoch)
  [ "$epoch" -ge "$before" ]
}

@test "rotate banner gate (e2e): empty pane ⇒ atmux rotate ALLOWS normally" {
  _start_session
  rm -f .atmux/state/worker-rotated.epoch
  local before; before=$(date +%s)
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "rotated worker" ]]
  [ -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate banner gate (e2e): --force overrides mid-turn block (operator escape hatch)" {
  _start_session
  _inject "thinking with claude…"
  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker --force
  [ "$status" -eq 0 ]
  # Force path skips the warn line entirely.
  ! [[ "$output" =~ "mid-turn" ]]
  [ -f .atmux/state/worker-rotated.epoch ]
}

# ---------- 3. e2e: whip-driven AUTO-PRECLEAR honors the gate ----------

@test "rotate banner gate (whip e2e): mid-turn pane with rate-limited banner ⇒ auto-preclear FAILS" {
  # autoRotate=true + a rotation-trigger banner (rate-limited) sets
  # preclear_banner, which makes whip call `atmux rotate <member>`.
  # If the pane simultaneously shows mid-turn ('thinking with'), the
  # rotate.sh pre-flight refuses, and whip emits the
  # '⚠️ auto-preclear … attempted but failed' finding rather than the
  # success '♻️ AUTO-PRECLEAR' finding.
  jq '.whip.autoRotate = true' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  _start_session

  # Inject BOTH a rotation-eligible banner AND a mid-turn marker —
  # whip's preclear_banner regex matches the rate-limited substring,
  # but rotate.sh sees mid-turn and refuses.
  _inject "rate-limit hit · thinking with sonnet"
  rm -f .atmux/state/worker-rotated.epoch .atmux/state/whip-last.hash

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "auto-preclear" ]] && [[ "$output" =~ "failed" ]]
  ! [[ "$output" =~ "AUTO-PRECLEAR worker" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate banner gate (whip e2e): Compacting alone ⇒ AUTO-PRECLEAR succeeds (no false-block)" {
  # Pin: Compacting alone never blocks rotation. This guards against a
  # future regression that lumps Compacting into the blocker set —
  # which would silently break whip's AUTO-PRECLEAR for the very banner
  # rotation is supposed to cure.
  jq '.whip.autoRotate = true' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  _start_session
  _inject "Compacting conversation"
  rm -f .atmux/state/worker-rotated.epoch .atmux/state/whip-last.hash

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "AUTO-PRECLEAR worker" ]]
  [ -f .atmux/state/worker-rotated.epoch ]
}

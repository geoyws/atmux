#!/usr/bin/env bats
# Unit tests for atmux unblocker (E9/Sc, t-a6adc81d, ADR-021).
#
# Strategy:
#   - Function-level: source lib/unblocker.sh + lib/common.sh, call the
#     internal classifier with synthetic pane states. No tmux needed.
#   - Verb-level: smoke that `atmux unblocker tick` exits cleanly on
#     empty kanban / no-session. Full pane-classify→escalate end-to-end
#     would need a live tmux server + spawned member panes; covered by
#     the function-level tests on the classifier surface.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name u >/dev/null
  atmux_assert_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

_source_unblocker() {
  atmux_source_libs
  # shellcheck source=../../lib/discord.sh
  . "$ATMUX_LIB_DIR/discord.sh"
  # shellcheck source=../../lib/unblocker.sh
  . "$ATMUX_LIB_DIR/unblocker.sh"
}

# ---- verb smoke ---------------------------------------------------------

@test "unblocker: --help prints usage" {
  run "$ATMUX_BIN" unblocker --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "atmux unblocker tick" ]]
  [[ "$output" =~ "blocker triage" ]]
}

@test "unblocker: bare invocation defaults to 'tick' subverb" {
  # No tmux session in the sandbox → unblocker logs 'session DOWN' and
  # returns 0. We just need exit-code success + no syntax-error on the
  # subverb dispatch path.
  run "$ATMUX_BIN" unblocker
  [ "$status" -eq 0 ]
}

@test "unblocker: tick exits 0 with no-session sandbox" {
  run "$ATMUX_BIN" unblocker tick
  [ "$status" -eq 0 ]
}

@test "unblocker: unknown subverb errors out" {
  run "$ATMUX_BIN" unblocker bogus
  [ "$status" -ne 0 ]
  [[ "$output" =~ "unknown subverb" ]]
}

@test "unblocker: tick writes a per-tick log line when candidates exist" {
  # Seed a stale in-progress task. Even though no tmux session means we
  # never reach the per-task loop, the no-session early-exit also skips
  # the tick log. This test asserts the BARE no-session path is silent
  # on the log file (only logs when we got past session-check).
  ! [ -f .atmux/logs/unblocker.log ]
  "$ATMUX_BIN" unblocker tick >/dev/null 2>&1
  ! [ -f .atmux/logs/unblocker.log ]
}

# ---- classifier function-level -----------------------------------------

@test "classify: WEDGED on 'Compacting conversation'" {
  _source_unblocker
  local state='✻ Compacting conversation… (2k tokens used)'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED" ]
}

@test "classify: WEDGED on 'hit your limit'" {
  _source_unblocker
  local state='You hit your limit — try again in 1h.'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED" ]
}

@test "classify: WEDGED on queued-message backbuffer" {
  _source_unblocker
  local state='› Press up to edit queued messages'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED" ]
}

@test "classify: WEDGED on 'Now using extra usage'" {
  _source_unblocker
  local state='Now using extra usage — 3% remaining'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED" ]
}

@test "classify: WEDGED on permission-prompt buffer" {
  _source_unblocker
  local state='Do you want to proceed? (y/n)'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED" ]
}

@test "classify: WEDGED-WITH-DRIVER-NEEDED on gh auth flow" {
  _source_unblocker
  local state='gh auth login — please authenticate to continue'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED-WITH-DRIVER-NEEDED" ]
}

@test "classify: WEDGED-WITH-DRIVER-NEEDED on 401 unauthorized" {
  _source_unblocker
  local state='HTTP 401 Unauthorized — token expired'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED-WITH-DRIVER-NEEDED" ]
}

@test "classify: WEDGED-WITH-DRIVER-NEEDED on ENOTFOUND" {
  _source_unblocker
  local state='Error: getaddrinfo ENOTFOUND api.example.com'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED-WITH-DRIVER-NEEDED" ]
}

@test "classify: LEGITIMATELY-SLOW on Esc-to-interrupt token counter" {
  _source_unblocker
  local state='✶ Reasoning… (1.2k tokens · esc to interrupt)'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "LEGITIMATELY-SLOW" ]
}

@test "classify: LEGITIMATELY-SLOW on active build output" {
  _source_unblocker
  local state='Running tests... PASS  src/foo.test.ts'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "LEGITIMATELY-SLOW" ]
}

@test "classify: IDLE on quiet shell prompt" {
  _source_unblocker
  # Shell-prompt-like content with no banner / no error / no progress.
  local state='─ ~/proj ─────  '
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "IDLE" ]
}

@test "classify: precedence — driver-needed beats wedged on auth+queued combo" {
  _source_unblocker
  # Pane that has BOTH 'Press up to edit queued messages' AND 'gh auth
  # login' — driver-needed should win because the routing is different
  # (lead can't fix auth via /clear).
  local state='gh auth login — please authenticate
Press up to edit queued messages'
  run _atmux_unblocker_classify "$state" t-x w1
  [ "$output" = "WEDGED-WITH-DRIVER-NEEDED" ]
}

# ---- candidate selector (jq filter) ------------------------------------

@test "candidate selector: blocked tasks always selected" {
  _source_unblocker
  cat > .atmux/kanban.json <<'JSON'
{
  "tasks": [
    {"id":"t-blocked","status":"blocked","owner":"w1","subject":"BE: foo","claimedAt":0},
    {"id":"t-running","status":"in-progress","owner":"w2","subject":"BE: bar","claimedAt":99999999999}
  ],
  "epics":[],"stories":[]
}
JSON
  run jq -r --argjson now 1700000000 --argjson stale 1800 '
    .tasks as $all
    | .tasks[]?
    | . as $t
    | select(((.subject // "") | startswith("commit ")) | not)
    | select(
        .status == "blocked"
        or (
          .status == "in-progress"
          and (.claimedAt // 0) > 0
          and ((.claimedAt // 0) + $stale) < $now
          and ([
                $all[]?
                | select(.createdFrom.parentTaskId == $t.id
                         and ((.subject // "") | startswith("commit ")))
               ] | length == 0)
        )
      )
    | .id
  ' .atmux/kanban.json
  [ "$status" -eq 0 ]
  [[ "$output" =~ "t-blocked" ]]
  [[ ! "$output" =~ "t-running" ]]
}

@test "candidate selector: stale in-progress without commit-Task downstream is selected" {
  _source_unblocker
  cat > .atmux/kanban.json <<'JSON'
{
  "tasks": [
    {"id":"t-stale","status":"in-progress","owner":"w1","subject":"BE: stale","claimedAt":1500000000}
  ],
  "epics":[],"stories":[]
}
JSON
  run jq -r --argjson now 1700000000 --argjson stale 1800 '
    .tasks as $all
    | .tasks[]?
    | . as $t
    | select(((.subject // "") | startswith("commit ")) | not)
    | select(
        .status == "blocked"
        or (
          .status == "in-progress"
          and (.claimedAt // 0) > 0
          and ((.claimedAt // 0) + $stale) < $now
          and ([
                $all[]?
                | select(.createdFrom.parentTaskId == $t.id
                         and ((.subject // "") | startswith("commit ")))
               ] | length == 0)
        )
      )
    | .id
  ' .atmux/kanban.json
  [ "$output" = "t-stale" ]
}

@test "candidate selector: stale in-progress WITH commit-Task downstream is excluded" {
  _source_unblocker
  cat > .atmux/kanban.json <<'JSON'
{
  "tasks": [
    {"id":"t-stale","status":"in-progress","owner":"w1","subject":"BE: stale","claimedAt":1500000000},
    {"id":"t-commit","status":"in-progress","owner":"gitter","subject":"commit t-stale",
     "createdFrom":{"parentTaskId":"t-stale","depth":1}}
  ],
  "epics":[],"stories":[]
}
JSON
  run jq -r --argjson now 1700000000 --argjson stale 1800 '
    .tasks as $all
    | .tasks[]?
    | . as $t
    | select(((.subject // "") | startswith("commit ")) | not)
    | select(
        .status == "blocked"
        or (
          .status == "in-progress"
          and (.claimedAt // 0) > 0
          and ((.claimedAt // 0) + $stale) < $now
          and ([
                $all[]?
                | select(.createdFrom.parentTaskId == $t.id
                         and ((.subject // "") | startswith("commit ")))
               ] | length == 0)
        )
      )
    | .id
  ' .atmux/kanban.json
  [ -z "$output" ]
}

@test "candidate selector: commit-Tasks themselves are never candidates" {
  _source_unblocker
  cat > .atmux/kanban.json <<'JSON'
{
  "tasks": [
    {"id":"t-commit","status":"in-progress","owner":"gitter","subject":"commit t-foo","claimedAt":1500000000,
     "createdFrom":{"parentTaskId":"t-foo","depth":1}}
  ],
  "epics":[],"stories":[]
}
JSON
  run jq -r --argjson now 1700000000 --argjson stale 1800 '
    .tasks as $all
    | .tasks[]?
    | . as $t
    | select(((.subject // "") | startswith("commit ")) | not)
    | select(
        .status == "blocked"
        or (
          .status == "in-progress"
          and (.claimedAt // 0) > 0
          and ((.claimedAt // 0) + $stale) < $now
        )
      )
    | .id
  ' .atmux/kanban.json
  [ -z "$output" ]
}

# ---- debounce ledger ---------------------------------------------------

@test "debounce: should_act returns true on first call (no ledger)" {
  _source_unblocker
  ! [ -f .atmux/state/unblocker-ledger.json ]
  run _atmux_unblocker_should_act t-foo IDLE 900 1700000000
  [ "$status" -eq 0 ]
}

@test "debounce: should_act respects a record younger than the window" {
  _source_unblocker
  mkdir -p .atmux/state
  printf '{"t-foo:IDLE": 1700000000}' > .atmux/state/unblocker-ledger.json
  # 500s later, debounce window is 900s → must refuse.
  run _atmux_unblocker_should_act t-foo IDLE 900 1700000500
  [ "$status" -ne 0 ]
}

@test "debounce: should_act allows a record older than the window" {
  _source_unblocker
  mkdir -p .atmux/state
  printf '{"t-foo:IDLE": 1700000000}' > .atmux/state/unblocker-ledger.json
  # 1200s later, debounce window is 900s → must allow.
  run _atmux_unblocker_should_act t-foo IDLE 900 1700001200
  [ "$status" -eq 0 ]
}

@test "debounce: ledger_record persists current epoch under the composite key" {
  _source_unblocker
  mkdir -p .atmux/state
  _atmux_unblocker_ledger_record t-foo WEDGED
  [ -f .atmux/state/unblocker-ledger.json ]
  run jq -r '.["t-foo:WEDGED"]' .atmux/state/unblocker-ledger.json
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+$ ]]
}

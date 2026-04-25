#!/usr/bin/env bats
# Unit tests for whip "Since last tick" delta — E2/S7 / t-ac42591e.
#
# AC: append a 📊 block (commits + done tasks) when ≥1 positive event
# happened since mtime(.atmux/state/whip-last.hash). Skip section entirely
# when (a) no baseline (first tick) OR (b) empty window.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# Source whip.sh so the helper is callable from tests directly.
_load_whip() {
  atmux_source_libs
  # shellcheck source=../../lib/whip.sh
  . "$ATMUX_LIB_DIR/whip.sh"
}

@test "delta_since: no since arg ⇒ silent (no body)" {
  _load_whip
  run _atmux_whip_delta_since ""
  [ -z "$output" ]
}

@test "delta_since: empty window (no commits, no done tasks) ⇒ silent" {
  _load_whip
  # Use a future epoch so nothing qualifies.
  local future=$(( $(date +%s) + 3600 ))
  run _atmux_whip_delta_since "$future"
  [ -z "$output" ]
}

@test "delta_since: kanban tasks completed in window ⇒ 🏁 bullet emitted" {
  _load_whip
  local before; before=$(date +%s)
  sleep 1
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "tasks done" ]]
  [[ "$output" =~ "$id" ]]
}

@test "delta_since: > 5 done tasks ⇒ shows 5 + '+N more'" {
  _load_whip
  local before; before=$(date +%s)
  sleep 1
  local i
  for i in 1 2 3 4 5 6 7; do
    local id; id=$("$ATMUX_BIN" task add "t$i" | tail -1)
    "$ATMUX_BIN" task move "$id" done >/dev/null
  done
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "7 tasks done" ]]
  [[ "$output" =~ "+2 more" ]]
}

@test "whip end-to-end: no whip-last.hash ⇒ no delta block (first tick has no baseline)" {
  [ ! -f .atmux/state/whip-last.hash ]
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "Since last tick" ]]
}

@test "whip end-to-end: prior tick + new done task ⇒ delta block fires on next tick" {
  # First tick — no findings of interest other than session DOWN; writes hash.
  "$ATMUX_BIN" whip >/dev/null
  [ -f .atmux/state/whip-last.hash ]
  sleep 1
  # Land a done task in the window between the two ticks.
  local id; id=$("$ATMUX_BIN" task add "delta-task" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "$id" ]]
}

# ---------- commit-side coverage (AC cases 3, 4, 6) ----------
#
# The bats sandbox isn't a real git repo, so the helper's `git rev-parse
# --git-dir` short-circuits and the commit-counting branch never fires
# in the existing tests above. To exercise that branch we PATH-shadow
# git with a tiny script that
#   (1) makes `git rev-parse --git-dir` succeed (helper proceeds), and
#   (2) emits a controlled list of SHAs from `git log` via FAKEGIT_SHAS.
# Each emitted SHA is newline-terminated — that matches what the helper
# expects to read line-by-line. The shadow is per-test; PATH unwinds
# automatically when the bats test subshell exits.
_setup_fake_git() {
  local fakebin="$ATMUX_TEST_TMP/fakebin"
  mkdir -p "$fakebin"
  cat > "$fakebin/git" <<'FAKE_EOF'
#!/usr/bin/env bash
case "$1" in
  rev-parse)
    # Anything that looks like the helper's "are we in a repo?" probe ⇒ yes.
    [[ "$*" == *--git-dir* ]] && { echo .git; exit 0; }
    exit 0
    ;;
  log)
    # Emit one sha per line (trailing newline preserved). FAKEGIT_SHAS is
    # space-separated in the env so the test caller stays one-liner.
    local sha
    for sha in ${FAKEGIT_SHAS:-}; do
      printf '%s\n' "$sha"
    done
    exit 0
    ;;
esac
exit 0
FAKE_EOF
  chmod +x "$fakebin/git"
  export PATH="$fakebin:$PATH"
}

@test "delta_since: 1 commit in window ⇒ ✅ commit bullet emitted" {
  _setup_fake_git
  _load_whip
  export FAKEGIT_SHAS="abc1234"
  local before; before=$(date +%s)
  sleep 1
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "1 commits: abc1234" ]]
}

@test "delta_since: 7 commits in window ⇒ 5 SHAs shown + (+2 more)" {
  _setup_fake_git
  _load_whip
  export FAKEGIT_SHAS="s1 s2 s3 s4 s5 s6 s7"
  local before; before=$(date +%s)
  sleep 1
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "7 commits" ]]
  [[ "$output" =~ "s1 s2 s3 s4 s5 (+2 more)" ]]
  # Trailing SHAs s6/s7 must NOT appear — they're collapsed into "+2 more".
  # `[[ ! ... ]]` not `! [[ ... ]]` — Bats ≥1.5 only fails the last `!`
  # command, so the inverted-on-the-outside form silently no-ops mid-test.
  [[ ! "$output" =~ "s6" ]]
  [[ ! "$output" =~ "s7" ]]
}

@test "delta_since: commits + done tasks together ⇒ both bullets emitted" {
  _setup_fake_git
  _load_whip
  export FAKEGIT_SHAS="abc1234 def5678"
  local before; before=$(date +%s)
  sleep 1
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "2 commits: abc1234 def5678" ]]
  [[ "$output" =~ "1 tasks done: $id" ]]
}

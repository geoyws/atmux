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

@test "delta_since: kanban tasks completed in window ⇒ 🏁 bullet emitted (E2/S10 per-task shape)" {
  _load_whip
  local before; before=$(date +%s)
  sleep 1
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  # New shape (E2/S10 t-62249136): one bullet per task — '🏁 `<id>` …'.
  # The flat 'tasks done: id1 id2 …' line is gone.
  [[ "$output" =~ 🏁 ]]
  [[ "$output" =~ "$id" ]]
}

@test "delta_since: > 5 done tasks ⇒ shows 5 bullets + '+N more' (E2/S10 per-task shape)" {
  _load_whip
  local before; before=$(date +%s)
  sleep 1
  local i
  for i in 1 2 3 4 5 6 7; do
    local id; id=$("$ATMUX_BIN" task add "t$i" | tail -1)
    "$ATMUX_BIN" task move "$id" done >/dev/null
  done
  run _atmux_whip_delta_since "$before"
  # 5 emitted bullets + 1 '+2 more' summary line.
  local bullet_count; bullet_count=$(grep -c '🏁' <<<"$output")
  [ "$bullet_count" -eq 6 ]
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

@test "delta_since: commits + done tasks together ⇒ both bullets emitted (E2/S10 per-task shape)" {
  _setup_fake_git
  _load_whip
  export FAKEGIT_SHAS="abc1234 def5678"
  local before; before=$(date +%s)
  sleep 1
  local id; id=$("$ATMUX_BIN" task add "x" | tail -1)
  "$ATMUX_BIN" task move "$id" done >/dev/null
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  # Commit line shape stays flat (one bullet, IDs joined).
  [[ "$output" =~ "2 commits: abc1234 def5678" ]]
  # Task shape now per-bullet — '🏁 `<id>` …'. The id appears inside
  # backticks; check the substring without anchoring on the old flat form.
  [[ "$output" =~ "$id" ]]
  [[ "$output" =~ 🏁 ]]
}

# ---------- real-git regression coverage (flag f-3229e152) ----------
#
# The PATH-shadow tests above use a mock that emits trailing newlines per
# SHA. Production helper hits real git, where `git log --pretty=format:%h`
# omits the trailing newline on the last entry — `read -r` then silently
# drops it. The fix swap (lib/whip.sh:541 `format:` → `tformat:`) is
# trivial; what's important is a test that catches a future regression
# the moment someone reverts. We init a real git repo, commit N times,
# and assert ALL N commits appear in the body. Bypasses the mock so a
# `format:` slip surfaces immediately.
_init_real_git_in_sandbox() {
  git init -q
  git config user.email "t@t" >/dev/null
  git config user.name  "t"   >/dev/null
}

@test "delta_since: REAL git, 1 commit ⇒ that commit appears in body (regression: format vs tformat)" {
  _init_real_git_in_sandbox
  echo a > a; git add a; git commit -q -m a
  _load_whip
  local before; before=$(( $(date +%s) - 60 ))
  local sha; sha=$(git rev-parse --short HEAD)
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "Since last tick" ]]
  [[ "$output" =~ "1 commits: $sha" ]]
}

@test "delta_since: REAL git, 3 commits ⇒ all 3 SHAs appear (none dropped)" {
  _init_real_git_in_sandbox
  echo a > a; git add a; git commit -q -m a
  echo b > b; git add b; git commit -q -m b
  echo c > c; git add c; git commit -q -m c
  _load_whip
  local before; before=$(( $(date +%s) - 60 ))
  local sha1 sha2 sha3
  sha1=$(git rev-parse --short HEAD~2)
  sha2=$(git rev-parse --short HEAD~1)
  sha3=$(git rev-parse --short HEAD)
  run _atmux_whip_delta_since "$before"
  [[ "$output" =~ "3 commits" ]]
  [[ "$output" =~ "$sha1" ]]
  [[ "$output" =~ "$sha2" ]]
  [[ "$output" =~ "$sha3" ]]
}

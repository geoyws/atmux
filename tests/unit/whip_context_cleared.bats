#!/usr/bin/env bats
# Unit tests for the `Context cleared` banner detector in lib/whip.sh.
# Targets t-455864ff: Claude Code's own auto-`/clear` posts
# `● Context cleared. Ready for your next instruction.` which wipes
# the role brief. Whip's snapshot stays unchanged tick after tick
# (same N stale teammates → rising quiet_count, no rotate). Detector
# arms preclear_banner=context-cleared so AUTO-PRECLEAR re-pastes the
# brief via the same path used for compacting / rate-limit signals.
#
# Regex-only cells — no tmux needed. The integration path (real pane
# + actual rotate) is exercised by whip_preclear.bats.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- positive matches ----------

@test "context-cleared regex: literal CC banner matches" {
  local state='● Context cleared. Ready for your next instruction.'
  echo "$state" | grep -qiE 'Context cleared\.\s*Ready for'
}

@test "context-cleared regex: CC banner with leading prompt-glyph matches" {
  local state="$(printf '%b' '\xe2\x97\x8f Context cleared. Ready for your next instruction.\n')"
  echo "$state" | grep -qiE 'Context cleared\.\s*Ready for'
}

@test "context-cleared regex: case-insensitive (Context cleared / context cleared)" {
  echo "context cleared. ready for input" | grep -qiE 'Context cleared\.\s*Ready for'
  echo "CONTEXT CLEARED. READY FOR INPUT" | grep -qiE 'Context cleared\.\s*Ready for'
}

@test "context-cleared regex: tolerates extra whitespace between '.' and 'Ready'" {
  # CC's banner is single-line in practice; the regex must tolerate
  # variable inter-token spacing (multiple spaces, tab) but not span
  # newlines (grep -E is line-oriented, which is the right behavior —
  # a multi-line `Context cleared.\nReady …` would be from disjoint
  # output and shouldn't trip a single-event detector).
  echo 'Context cleared.   Ready for your next instruction.' \
    | grep -qiE 'Context cleared\.\s*Ready for'
  printf 'Context cleared.\tReady for your next instruction.\n' \
    | grep -qiE 'Context cleared\.\s*Ready for'
}

# ---------- negative matches (false-positive guard) ----------

@test "context-cleared regex: 'Context cleared' alone (no Ready) does NOT match" {
  ! echo 'Context cleared from cache' | grep -qiE 'Context cleared\.\s*Ready for'
  ! echo 'context cleared yesterday'  | grep -qiE 'Context cleared\.\s*Ready for'
}

@test "context-cleared regex: docstring/comment mentioning the banner does NOT trip if no period+Ready" {
  ! echo 'see Context cleared banner doc — Ready states defined elsewhere' \
    | grep -qiE 'Context cleared\.\s*Ready for'
}

@test "context-cleared regex: Compacting banner does NOT match (separate detector)" {
  ! echo 'Compacting conversation…' | grep -qiE 'Context cleared\.\s*Ready for'
}

@test "context-cleared regex: rate-limit banner does NOT match" {
  ! echo 'You hit your limit'           | grep -qiE 'Context cleared\.\s*Ready for'
  ! echo 'approaching usage limit'      | grep -qiE 'Context cleared\.\s*Ready for'
  ! echo '95% of limit used'            | grep -qiE 'Context cleared\.\s*Ready for'
}

# ---------- whip.sh contains the detector ----------

@test "lib/whip.sh: Context cleared detector is wired" {
  # Defense-in-depth — the regex test cells above prove the pattern
  # works in isolation, but whip.sh must actually invoke it. Grep
  # the file for both the regex literal AND the preclear_banner=
  # assignment so a future refactor that breaks the wiring can't
  # silently regress.
  grep -q "Context cleared\\\\\\.\\\\s\\*Ready for" "$ATMUX_LIB_DIR/whip.sh"
  grep -qE "preclear_banner=.*context-cleared" "$ATMUX_LIB_DIR/whip.sh"
}

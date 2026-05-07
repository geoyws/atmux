#!/usr/bin/env bats
# Integration tests for whip ↔ decisions cursor pointer (T10.2 + T10.3).
#
# Per ADR-008: whip detects new entries in .atmux/decisions.md since last
# tick (mtime + cursor file at .atmux/state/decisions-cursor) and emits a
# "📋 N new decisions" pointer in its Discord ping. Whip does NOT duplicate
# decision bodies — the decisions verb itself does the immediate per-add
# ping; whip flags missed pings.
#
# These tests will fail until T10.2 (be-kanban) lands the whip cursor logic.
# That's by design: this stub is the deliverable shape; gaps fill in once
# the BE wiring exists.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name w >/dev/null
  atmux_disable_down_confirm

  # Mock curl — capture each Discord ping's payload to a NUL-delimited file
  # so we can assert the "N new decisions" pointer made it into the body.
  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
exec >>"$ATMUX_TEST_TMP/curl-args.bin"
for arg in "\$@"; do printf '%s\0' "\$arg"; done
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/curl"

  export ATMUX_DISCORD_WEBHOOK="http://mock.test/hook"
}

teardown() {
  atmux_teardown_sandbox
}

# Concatenate ALL captured curl payloads in order — whip + decisions add can
# both ping in the same run; tests assert which body carries the pointer.
_all_payloads() {
  local f="$ATMUX_TEST_TMP/curl-args.bin"
  [[ -f "$f" ]] || return 0
  awk 'BEGIN{RS="\0"} prev=="-d"{print; print "---PING---"} {prev=$0}' "$f"
}

# Find the WHIP payload specifically (header has [whip-...] or no [atmux-decisions]).
_whip_payload() {
  _all_payloads | awk '
    /---PING---/ { if (saw_whip) { print buf; exit } else { buf=""; saw_whip=0 }; next }
    /\[whip/      { saw_whip=1 }
    !/\[atmux-decisions\]/ { buf = buf $0 "\n" }
  '
}

# ---------- cursor lifecycle ----------

@test "whip+decisions: missing .atmux/decisions.md ⇒ no pointer, no error" {
  rm -f .atmux/decisions.md
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  # No curl payload should mention "new decisions" since the log file is absent.
  ! _all_payloads | grep -q "new decisions"
}

@test "whip+decisions: first tick after a new decisions add ⇒ pointer fires" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "fresh ping?" --default "y" >/dev/null
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  # whip ping body must include the count pointer.
  _all_payloads | grep -qE "📋 [0-9]+ new decisions"
}

@test "whip+decisions: cursor advances ⇒ second tick (no new decisions) ⇒ no pointer" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "first?" --default "y" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  ! _all_payloads | grep -q "new decisions"
}

@test "whip+decisions: cursor file lives under .atmux/state/decisions-cursor" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "cursor?" --default "y" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  [ -f .atmux/state/decisions-cursor ]
}

@test "whip+decisions: inline preview surfaces top-3 question + default per decision (E2/S8 t-93993183)" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-alpha?"  --default "a-alpha"  >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-beta?"   --default "a-beta"   >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q-gamma?"  --default "a-gamma"  >/dev/null
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  local payloads; payloads=$(_all_payloads)
  # Whip ping should now inline the question + default (not just a flag pointer).
  echo "$payloads" | grep -qE "📋 3 new decisions:"
  echo "$payloads" | grep -q "q-alpha?"
  echo "$payloads" | grep -q "q-beta?"
  echo "$payloads" | grep -q "q-gamma?"
  echo "$payloads" | grep -q "→ a-alpha"
}

@test "whip+decisions: > 3 decisions ⇒ shows 3 inline + '+N more — atmux decisions digest' tail" {
  local i
  for i in 1 2 3 4 5; do
    PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q$i?" --default "a$i" >/dev/null
  done
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  local payloads; payloads=$(_all_payloads)
  echo "$payloads" | grep -qE "📋 5 new decisions:"
  echo "$payloads" | grep -qE "\+2 more — atmux decisions digest"
}

@test "whip+decisions: N decisions in a single window ⇒ count reflects all of them" {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q1?" --default "a1" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q2?" --default "a2" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "q3?" --default "a3" >/dev/null
  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  _all_payloads | grep -qE "📋 3 new decisions"
}

@test "whip+decisions: cursor file containing a real epoch ⇒ inline preview fires (regression: --since rejected bare epoch pre-fix)" {
  # Pre-fix repro for t-2b81aa76: when whip writes the decisions cursor
  # (epoch integer) and the next tick reads it back via
  # `decisions list --since "$epoch"`, the parser rejected the bare
  # integer ("bad --since format"), the preview_json stayed empty, and
  # whip fell through to the count-only fallback ("📋 N new decisions —
  # atmux decisions list") instead of the S8 top-3 inline format. Every
  # production whip tick was hitting this fallback.
  #
  # Setup: warm the cursor file with an epoch from BEFORE we add new
  # decisions, then run whip. The whip body must show the colon-suffix
  # `📋 N new decisions:` shape (inline) AND each question, NOT the
  # em-dash fallback shape `📋 N new decisions — atmux decisions list`.
  mkdir -p .atmux/state
  local seed_epoch=$(( $(date +%s) - 1200 ))   # 20 minutes ago
  echo "$seed_epoch" > .atmux/state/decisions-cursor

  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "post-cursor-q1?" --default "p1" >/dev/null
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" decisions add "post-cursor-q2?" --default "p2" >/dev/null

  rm -f "$ATMUX_TEST_TMP/curl-args.bin"
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" whip >/dev/null 2>&1 || true
  local payloads; payloads=$(_all_payloads)

  # New (S8) format header — colon-suffix, NOT the em-dash fallback.
  # The `:` discriminates the inline-preview path from the count-only
  # fallback (`📋 N new decisions — atmux decisions list`); a passing
  # grep here is itself a regression test against the pre-fix shape.
  echo "$payloads" | grep -qE "📋 2 new decisions:"
  # Each question + default inlined — proves the preview_json path
  # executed and produced bullets.
  echo "$payloads" | grep -q "post-cursor-q1?"
  echo "$payloads" | grep -q "→ p1"
  echo "$payloads" | grep -q "post-cursor-q2?"
  echo "$payloads" | grep -q "→ p2"
}

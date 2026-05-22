#!/usr/bin/env bash
# measure-context.test.sh — shell-level tests for measure-context.sh.
#
# Drives the parse + write logic against fixture scrollback strings via
# the WHIP_CONTEXT_FIXTURE_SCROLLBACK / WHIP_CONTEXT_OUT_ROOT env-var
# injection seam in measure-context.sh. No real tmux needed.
#
# Usage: bash measure-context.test.sh
# Exits: 0 on all-pass, 1 on any failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${SCRIPT_DIR}/measure-context.sh"

if [ ! -x "$SCRIPT" ]; then
  echo "FAIL: measure-context.sh not executable at ${SCRIPT}" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED_TESTS=()

assert_eq() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ok  ${desc}"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$desc")
    echo "  FAIL ${desc}"
    echo "       expected: '${expected}'"
    echo "       actual:   '${actual}'"
  fi
}

assert_contains() {
  local desc="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1))
    echo "  ok  ${desc}"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$desc")
    echo "  FAIL ${desc}"
    echo "       needle:   '${needle}'"
    echo "       haystack: '${haystack}'"
  fi
}

assert_not_exists() {
  local desc="$1"
  local path="$2"
  if [ ! -e "$path" ]; then
    PASS=$((PASS + 1))
    echo "  ok  ${desc}"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$desc")
    echo "  FAIL ${desc}: path exists when it shouldn't: ${path}"
  fi
}

# ---------- Setup ----------

OUT_ROOT=$(mktemp -d -t measure-context-test.XXXXXX)
trap 'rm -rf "$OUT_ROOT"' EXIT

# ---------- Test 1: happy path — basic ↑/↓ tokens line ----------

echo "test 1: parses '↑ 12.3k ↓ 4.5k tokens' indicator (200kt window default)"
SCROLLBACK_T1='> some output here
... ↑ 12.3k ↓ 4.5k tokens · esc to interrupt
'
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T1" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam alpha 2>&1
)
JSON_T1="${OUT_ROOT}/teams/testteam/member-context/alpha.json"
assert_eq "test1: out file written" "true" "$([ -f "$JSON_T1" ] && echo true || echo false)"
if [ -f "$JSON_T1" ]; then
  BODY=$(cat "$JSON_T1")
  assert_contains "test1: member field" '"member": "alpha"' "$BODY"
  assert_contains "test1: input_kt field" '"input_kt": 12.3' "$BODY"
  assert_contains "test1: output_kt field" '"output_kt": 4.5' "$BODY"
  # (12.3 + 4.5) / 200 * 100 = 8.4
  assert_contains "test1: context_pct=8.4" '"context_pct": 8.4' "$BODY"
  assert_contains "test1: window_kt=200" '"window_kt": 200' "$BODY"
  assert_contains "test1: in_flight_task null when omitted" '"in_flight_task": null' "$BODY"
fi

# ---------- Test 2: in-flight task id threads through ----------

echo "test 2: in_flight_task argument threads into JSON"
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T1" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam alpha t-abc12345 2>&1
)
BODY=$(cat "$JSON_T1")
assert_contains "test2: in_flight_task = t-abc12345" '"in_flight_task": "t-abc12345"' "$BODY"

# ---------- Test 3: 1M-context window override (Opus 4.7) ----------

echo "test 3: WHIP_CONTEXT_WINDOW_KT=1000 produces ~1.68%"
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T1" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  WHIP_CONTEXT_WINDOW_KT=1000 \
  bash "$SCRIPT" testteam bravo 2>&1
)
JSON_T3="${OUT_ROOT}/teams/testteam/member-context/bravo.json"
BODY=$(cat "$JSON_T3")
# (12.3 + 4.5) / 1000 * 100 = 1.68 ≈ 1.7 (one decimal place)
assert_contains "test3: context_pct on 1000kt window" '"context_pct": 1.7' "$BODY"
assert_contains "test3: window_kt=1000" '"window_kt": 1000' "$BODY"

# ---------- Test 4: threshold-crossing context_pct (>=60%) ----------

echo "test 4: 120k input + 30k output on 200kt → 75% (above ROTATE_THRESHOLD)"
SCROLLBACK_T4='... ↑ 120k ↓ 30k tokens · esc to interrupt'
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T4" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam charlie 2>&1
)
JSON_T4="${OUT_ROOT}/teams/testteam/member-context/charlie.json"
BODY=$(cat "$JSON_T4")
assert_contains "test4: context_pct=75.0" '"context_pct": 75.0' "$BODY"

# ---------- Test 5: most-recent tokens line wins on multi-occurrence ----------

echo "test 5: takes latest tokens line when scrollback has multiple"
SCROLLBACK_T5='... ↑ 5k ↓ 1k tokens · earlier turn
... some middle output
... ↑ 50k ↓ 10k tokens · esc to interrupt'
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T5" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam delta 2>&1
)
JSON_T5="${OUT_ROOT}/teams/testteam/member-context/delta.json"
BODY=$(cat "$JSON_T5")
# Should pick 50k/10k (latest), not 5k/1k (earlier)
assert_contains "test5: input_kt=50 (latest)" '"input_kt": 50' "$BODY"
assert_contains "test5: output_kt=10 (latest)" '"output_kt": 10' "$BODY"
# (50 + 10) / 200 * 100 = 30
assert_contains "test5: context_pct=30.0" '"context_pct": 30.0' "$BODY"

# ---------- Test 6: no tokens indicator → graceful skip, no file ----------

echo "test 6: scrollback without tokens indicator skips silently"
SCROLLBACK_T6='> some prose-only output
no token-indicator here at all'
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T6" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam echo 2>&1
)
JSON_T6="${OUT_ROOT}/teams/testteam/member-context/echo.json"
assert_not_exists "test6: no file written when scrollback has no tokens" "$JSON_T6"
assert_contains "test6: skip diagnostic on stderr" "no '↑ Nk ↓ Mk tokens' indicator" "$OUTPUT"

# ---------- Test 7: missing args (no member) → silent skip ----------

echo "test 7: missing member arg → silent skip + usage diagnostic"
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T1" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam 2>&1
)
assert_contains "test7: usage diagnostic" "usage:" "$OUTPUT"

# ---------- Test 8: rewrite (idempotent overwrite) ----------

echo "test 8: second call overwrites the file"
SCROLLBACK_T8A='... ↑ 1k ↓ 1k tokens'
SCROLLBACK_T8B='... ↑ 100k ↓ 50k tokens'
WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T8A" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam foxtrot 2>&1 >/dev/null
JSON_T8="${OUT_ROOT}/teams/testteam/member-context/foxtrot.json"
BODY_A=$(cat "$JSON_T8")
assert_contains "test8a: first write input_kt=1" '"input_kt": 1' "$BODY_A"

WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T8B" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  bash "$SCRIPT" testteam foxtrot 2>&1 >/dev/null
BODY_B=$(cat "$JSON_T8")
assert_contains "test8b: second write input_kt=100" '"input_kt": 100' "$BODY_B"
# Old value gone
if echo "$BODY_B" | grep -qE '"input_kt": 1[^0]'; then
  FAIL=$((FAIL + 1))
  FAILED_TESTS+=("test8b: old input_kt=1 lingers in second write")
  echo "  FAIL test8b: old input_kt lingers"
else
  PASS=$((PASS + 1))
  echo "  ok  test8b: atomic overwrite (no stale field)"
fi

# ---------- Test 9: JSON validity (parsable by jq if available) ----------

echo "test 9: emitted JSON is valid (parseable by jq when available)"
if command -v jq >/dev/null 2>&1; then
  if jq -e '.member' "$JSON_T1" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo "  ok  test9: jq parses test1 output cleanly"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("test9: jq rejected test1 JSON body")
    echo "  FAIL test9: jq rejected test1 JSON"
    cat "$JSON_T1" >&2
  fi
else
  echo "  skip test9: jq not on PATH"
fi

# ---------- Test 10: window_kt=0 guards against div-by-zero ----------

echo "test 10: WHIP_CONTEXT_WINDOW_KT=0 emits context_pct=0 (safe guard)"
OUTPUT=$(
  WHIP_CONTEXT_FIXTURE_SCROLLBACK="$SCROLLBACK_T1" \
  WHIP_CONTEXT_OUT_ROOT="$OUT_ROOT" \
  WHIP_CONTEXT_WINDOW_KT=0 \
  bash "$SCRIPT" testteam golf 2>&1
)
JSON_T10="${OUT_ROOT}/teams/testteam/member-context/golf.json"
BODY=$(cat "$JSON_T10")
assert_contains "test10: context_pct=0 on window_kt=0" '"context_pct": 0' "$BODY"

# ---------- Summary ----------

echo ""
echo "=========================================="
echo "  PASS: ${PASS}"
echo "  FAIL: ${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  Failed:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "    - ${t}"
  done
  exit 1
fi
exit 0

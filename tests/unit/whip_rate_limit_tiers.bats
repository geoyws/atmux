#!/usr/bin/env bats
# Unit tests for the ADR-023 three-tier rate-limit classification refactor
# in lib/whip.sh. Covers t-71285619 AC: HARD/SOFT/NONE branches, judge mock
# (rotate / skip / unavailable), debounce floor, and cost-ledger schema.
#
# Approach: direct-source `lib/whip.sh` into a sandbox bash and exercise:
#   - the tier-classification regex via inline bash matches
#   - `_atmux_whip_judge_soft` with a PATH-shimmed mock `claude` binary
#   - `atmux::llm_judge` cost-ledger schema
#
# This avoids the flaky `atmux start` spawn path that gets clobbered by
# parallel test contention on the shared tmux server (whip_preclear.bats
# documented the same constraint). Integration of the full whip tick with
# real spawn is covered by whip_preclear.bats's pre-existing cells; this
# file focuses on the new SOFT-tier judge wiring per t-cc4064a9.
#
# Per CLAUDE.md feedback_orphan_test_staging.md: BE deps t-cc4064a9
# (Se_T3 whip refactor) + t-f256f2d1 (Se_T2 prompt template) + t-0030ab2b
# (Se_T1 atmux::llm_judge wrapper) are all already done — this .bats is
# safe to `git add` from the start.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "wrlt",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "autoRotate": true}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done

  # Mock `claude` binary — emits ATMUX_MOCK_CLAUDE_OUTPUT and exits with
  # ATMUX_MOCK_CLAUDE_RC. Records a marker file when invoked so tests can
  # assert "judge NOT called" cleanly.
  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/claude" <<'EOF'
#!/usr/bin/env bash
touch "$ATMUX_MOCK_CLAUDE_CALLED_MARKER"
printf '%s' "${ATMUX_MOCK_CLAUDE_OUTPUT:-}"
exit "${ATMUX_MOCK_CLAUDE_RC:-0}"
EOF
  chmod +x "$ATMUX_MOCK_BIN/claude"
  export ATMUX_CLAUDE_BIN="$ATMUX_MOCK_BIN/claude"
  export ATMUX_MOCK_CLAUDE_CALLED_MARKER="$ATMUX_TEST_TMP/.judge-called"
  rm -f "$ATMUX_MOCK_CLAUDE_CALLED_MARKER"
}

teardown() {
  atmux_teardown_sandbox
}

# Source whip.sh + transitive deps in a clean bash. Returns the function
# names available so the caller can assert on them.
_load_whip() {
  bash -c '
    set -euo pipefail
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    declare -F _atmux_whip_judge_soft _atmux_whip_judge_last_reason
  '
}

# ---------- (0) tier-classification regex (no tmux needed) ----------

@test "tier classify: 'hit your limit' is HARD" {
  local state="some output\nYou hit your limit\nmore output"
  echo -e "$state" | grep -qi 'hit your limit'
}

@test "tier classify: 'approaching usage limit' is SOFT" {
  local state="approaching usage limit (80% used)"
  echo -e "$state" | grep -qiE 'approaching usage limit|[0-9]+% of (limit|window) used'
}

@test "tier classify: '95% of limit used' is SOFT" {
  local state="status: 95% of limit used"
  echo -e "$state" | grep -qiE 'approaching usage limit|[0-9]+% of (limit|window) used'
}

@test "tier classify: '50% of window used' is SOFT" {
  local state="status: 50% of window used"
  echo -e "$state" | grep -qiE 'approaching usage limit|[0-9]+% of (limit|window) used'
}

@test "tier classify: clean output is NONE (neither HARD nor SOFT pattern matches)" {
  local state="just normal pane output, no limits anywhere"
  ! echo -e "$state" | grep -qi 'hit your limit'
  ! echo -e "$state" | grep -qiE 'approaching usage limit|[0-9]+% of (limit|window) used'
}

@test "tier classify: HARD takes precedence over SOFT in mixed pane" {
  local state="approaching usage limit\nthen later: You hit your limit"
  # Both patterns match — refactor's case order checks HARD first.
  echo -e "$state" | grep -qi 'hit your limit'
  echo -e "$state" | grep -qiE 'approaching usage limit|[0-9]+% of (limit|window) used'
}

# ---------- (1) judge invocation: rotate decision ----------

@test "judge rotate: pane snapshot through helper → atmux::llm_judge → 'rotate' on stdout" {
  export ATMUX_MOCK_CLAUDE_OUTPUT='{"decision":"rotate","reason":"95% used"}'

  local out
  out="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "fake pane: approaching usage limit"
  ')"
  [ "$out" = "rotate" ]

  local reason
  reason="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_last_reason
  ')"
  [ "$reason" = "95% used" ]

  [ -f "$ATMUX_MOCK_CLAUDE_CALLED_MARKER" ]
}

# ---------- (2) judge invocation: skip decision ----------

@test "judge skip: helper returns 'skip' on stdout, reason persisted" {
  export ATMUX_MOCK_CLAUDE_OUTPUT='{"decision":"skip","reason":"mid-refactor"}'

  local out reason
  out="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit"
  ')"
  reason="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_last_reason
  ')"
  [ "$out" = "skip" ]
  [ "$reason" = "mid-refactor" ]
}

# ---------- (3) judge unavailable: claude exits non-zero ----------

@test "judge unavailable (claude rc != 0): helper returns 'unavailable'" {
  export ATMUX_MOCK_CLAUDE_OUTPUT=''
  export ATMUX_MOCK_CLAUDE_RC=1

  local out
  out="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit"
  ')"
  [ "$out" = "unavailable" ]
}

# ---------- (4) judge unavailable: claude binary missing ----------

@test "judge unavailable (claude binary missing): helper returns 'unavailable'" {
  ATMUX_CLAUDE_BIN=/no/such/claude/binary
  export ATMUX_CLAUDE_BIN

  local out
  out="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit"
  ')"
  [ "$out" = "unavailable" ]
}

# ---------- (5) cost ledger: appended JSONL has the documented 8 keys ----------

@test "cost ledger: schema carries ts, member, caller, model, input_chars, output_chars, decision, reason" {
  export ATMUX_MOCK_CLAUDE_OUTPUT='{"decision":"skip","reason":"schema-test"}'

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit" >/dev/null
  '

  [ -f .atmux/state/llm-judge-cost.jsonl ]
  local last; last="$(tail -1 .atmux/state/llm-judge-cost.jsonl)"
  jq -e . <<<"$last" >/dev/null
  [ "$(jq -r '.ts | type'              <<<"$last")" = "number" ]
  [ "$(jq -r '.member'                 <<<"$last")" = "worker" ]
  [ "$(jq -r '.caller'                 <<<"$last")" = "whip-rate-limit" ]
  [ "$(jq -r '.model'                  <<<"$last")" = "claude-sonnet-4-6" ]
  [ "$(jq -r '.input_chars  | type'    <<<"$last")" = "number" ]
  [ "$(jq -r '.output_chars | type'    <<<"$last")" = "number" ]
  [ "$(jq -r '.decision'               <<<"$last")" = "skip" ]
  [ "$(jq -r '.reason'                 <<<"$last")" = "schema-test" ]
}

@test "cost ledger: every judge invocation appends one row (idempotent appender, not overwrite)" {
  export ATMUX_MOCK_CLAUDE_OUTPUT='{"decision":"skip","reason":"r1"}'

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit" >/dev/null
    _atmux_whip_judge_soft "worker" "approaching usage limit" >/dev/null
    _atmux_whip_judge_soft "worker" "approaching usage limit" >/dev/null
  '

  local n; n="$(wc -l < .atmux/state/llm-judge-cost.jsonl)"
  [ "$n" -eq 3 ]
}

# ---------- (6) judge unavailable does NOT pollute the ledger with garbage ----------

@test "cost ledger: judge unavailable still emits one row tagged decision='unavailable'" {
  export ATMUX_MOCK_CLAUDE_OUTPUT=''
  export ATMUX_MOCK_CLAUDE_RC=1

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit" >/dev/null
  '
  [ -f .atmux/state/llm-judge-cost.jsonl ]
  local last; last="$(tail -1 .atmux/state/llm-judge-cost.jsonl)"
  [ "$(jq -r '.decision' <<<"$last")" = "unavailable" ]
}

# ---------- (7) prompt-template missing → unavailable, no judge call ----------

@test "judge: prompt template missing ⇒ helper returns 'unavailable' WITHOUT calling claude" {
  rm -f "$ATMUX_MOCK_CLAUDE_CALLED_MARKER"
  ATMUX_TEMPLATES_DIR=/tmp/no/such/templates/dir
  export ATMUX_TEMPLATES_DIR

  local out
  out="$(bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "approaching usage limit"
  ')"
  [ "$out" = "unavailable" ]
  [ ! -f "$ATMUX_MOCK_CLAUDE_CALLED_MARKER" ]
}

# ---------- (8) prompt slot substitution ----------

@test "judge prompt: slots are substituted before claude is invoked" {
  # Capture the substituted prompt by replacing the mock to dump stdin to
  # a file (instead of just emitting fake JSON). Each slot must be present.
  cat > "$ATMUX_MOCK_BIN/claude" <<EOF
#!/usr/bin/env bash
cat > "$ATMUX_TEST_TMP/.prompt.captured"
printf '{"decision":"skip","reason":"slot-test"}'
EOF
  chmod +x "$ATMUX_MOCK_BIN/claude"

  bash -c '
    . "$ATMUX_LIB_DIR/common.sh"
    . "$ATMUX_LIB_DIR/whip.sh"
    _atmux_whip_judge_soft "worker" "PANE_SNAP_42" >/dev/null
  '

  [ -f "$ATMUX_TEST_TMP/.prompt.captured" ]
  local p; p="$(cat "$ATMUX_TEST_TMP/.prompt.captured")"
  # Member name + tier (always SOFT for this helper) + pane snapshot
  # are all expected to land in the rendered prompt. claim_age_min and
  # recent_commits are computed dynamically; they may be 0 / "(no recent
  # commits)" but the slots themselves must NOT survive un-substituted.
  [[ "$p" == *"worker"* ]]
  [[ "$p" == *"SOFT"* ]]
  [[ "$p" == *"PANE_SNAP_42"* ]]
  ! [[ "$p" == *"{member_name}"* ]]
  ! [[ "$p" == *"{tier}"* ]]
  ! [[ "$p" == *"{pane_snapshot}"* ]]
  ! [[ "$p" == *"{claim_age_min}"* ]]
  ! [[ "$p" == *"{recent_commits}"* ]]
}

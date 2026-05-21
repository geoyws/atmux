#!/usr/bin/env bash
# measure-context.sh — capture own pane's context-token usage + write JSON.
#
# Each whip-running member calls this once per idle-hook fire (post-turn,
# pre-wait) so the team-lead can read the structured signal on its next
# whip cycle instead of eyeballing pane scrollback.
#
# Pipeline:
#   1. tmux capture-pane → own pane scrollback (last 80 lines).
#   2. Regex-extract the most recent `↑ Nk ↓ Mk tokens` indicator from
#      Claude Code's status line.
#   3. Compute `context_pct = (N + M) / window_size_kt * 100`.
#   4. Atomic write to `${HOME}/.claude/teams/${TEAM}/member-context/${MEMBER}.json`.
#
# Idempotent. Non-blocking — silent best-effort. If anything fails (no
# tokens line in scrollback, jq missing, write fails), exit 0 silently;
# next idle-hook fire retries. The lead's read-side treats absence as
# "no signal, skip" (per whip-prompt.md §1a augment), so a silent miss
# costs at most one whip cycle of stale data.
#
# Window size:
#   - Defaults to 200 (kt) per the bash-side legacy convention.
#   - Override via `WHIP_CONTEXT_WINDOW_KT` env var. Opus 4.7 1M-context
#     teams set 1000; legacy Sonnet/Opus stays on 200.
#
# Usage: measure-context.sh <team> <member> [in_flight_task]
# Exits: 0 always (silent best-effort). stderr carries diagnostics only.

set -uo pipefail

TEAM="${1:-}"
MEMBER="${2:-}"
IN_FLIGHT_TASK="${3:-}"

if [ -z "$TEAM" ] || [ -z "$MEMBER" ]; then
  echo "measure-context.sh: usage: $0 <team> <member> [in_flight_task]" >&2
  exit 0
fi

# Window size — default 200 kt; operator-overridable per team for
# Opus 4.7 1M-context where 1000 kt is the right denominator.
WINDOW_KT="${WHIP_CONTEXT_WINDOW_KT:-200}"

# Resolve own pane name. Inside a tmux client the easiest signal is
# `tmux display-message -p '#{window_name}'`; under cron / detached
# script the script's pane is the calling tty. We need the WINDOW name
# the lead would target — for members that's the `<emoji>-<member>` /
# `<member>` form. `tmux display-message -p` returns it.
#
# Test-injection: WHIP_CONTEXT_FIXTURE_SCROLLBACK + WHIP_CONTEXT_FIXTURE_WIN
# bypass tmux entirely so the shell-level test can drive parse + write
# without spinning a real tmux server. When the fixture env vars are set,
# the script trusts them and skips both `tmux display-message` and
# `tmux capture-pane`. Production callers leave both env vars unset.
if [ -n "${WHIP_CONTEXT_FIXTURE_SCROLLBACK:-}" ]; then
  PANE_WIN="${WHIP_CONTEXT_FIXTURE_WIN:-fixture-win}"
  SCROLLBACK="$WHIP_CONTEXT_FIXTURE_SCROLLBACK"
else
  if [ -z "${TMUX:-}" ]; then
    echo "measure-context.sh: not inside a tmux client (TMUX unset) — skip" >&2
    exit 0
  fi
  PANE_WIN=$(tmux display-message -p '#{window_name}' 2>/dev/null || echo "")
  if [ -z "$PANE_WIN" ]; then
    echo "measure-context.sh: tmux display-message failed — skip" >&2
    exit 0
  fi

  # Capture pane scrollback. -S -80 covers ~one screen-page; the most
  # recent status-line tokens indicator is always near the bottom.
  SCROLLBACK=$(tmux capture-pane -p -t "$PANE_WIN" -S -80 2>/dev/null || echo "")
fi
if [ -z "$SCROLLBACK" ]; then
  echo "measure-context.sh: empty pane scrollback — skip" >&2
  exit 0
fi

# Test-injection: override the output root for shell tests so fixtures
# don't pollute the user's real ~/.claude/teams/ tree. Production
# callers leave WHIP_CONTEXT_OUT_ROOT unset → defaults to $HOME/.claude.
OUT_ROOT="${WHIP_CONTEXT_OUT_ROOT:-${HOME}/.claude}"

# Extract the LATEST `↑ Nk ↓ Mk tokens` indicator. Claude Code's
# status line renders something like:
#   `… ↑ 12.3k ↓ 4.5k tokens · esc to interrupt …`
# Allow integer / float k-counts. Match the last occurrence — earlier
# occurrences are stale (prior turns scrolled up).
TOKENS_LINE=$(echo "$SCROLLBACK" | grep -oE '↑ [0-9]+\.?[0-9]*k ↓ [0-9]+\.?[0-9]*k tokens' | tail -1)
if [ -z "$TOKENS_LINE" ]; then
  echo "measure-context.sh: no '↑ Nk ↓ Mk tokens' indicator in scrollback — skip" >&2
  exit 0
fi

INPUT_KT=$(echo "$TOKENS_LINE" | grep -oE '↑ [0-9]+\.?[0-9]*k' | head -1 | grep -oE '[0-9]+\.?[0-9]*')
OUTPUT_KT=$(echo "$TOKENS_LINE" | grep -oE '↓ [0-9]+\.?[0-9]*k' | head -1 | grep -oE '[0-9]+\.?[0-9]*')

if [ -z "$INPUT_KT" ] || [ -z "$OUTPUT_KT" ]; then
  echo "measure-context.sh: failed to parse N/M from '$TOKENS_LINE' — skip" >&2
  exit 0
fi

# Compute percentage. Pure awk so we don't require bc/python.
CONTEXT_PCT=$(awk -v i="$INPUT_KT" -v o="$OUTPUT_KT" -v w="$WINDOW_KT" \
  'BEGIN { if (w <= 0) { print 0; exit } printf "%.1f", (i + o) / w * 100 }')

# Write atomic temp + rename.
TS=$(date +%s)
OUT_DIR="${OUT_ROOT}/teams/${TEAM}/member-context"
OUT_FILE="${OUT_DIR}/${MEMBER}.json"
TMP_FILE="${OUT_FILE}.tmp.$$"

mkdir -p "$OUT_DIR" 2>/dev/null || {
  echo "measure-context.sh: mkdir ${OUT_DIR} failed — skip" >&2
  exit 0
}

# jq-canonical writer if jq is on PATH; fallback to a hand-rolled JSON
# body. The hand-rolled fallback handles in_flight_task=null safely
# because the script's empty-string carries through to JSON null below.
IN_FLIGHT_JSON="null"
if [ -n "$IN_FLIGHT_TASK" ]; then
  # Quote-escape any internal " in the task id (paranoid; task ids are
  # `t-<8 hex>` so this never fires in practice, but defensive write).
  ESCAPED=$(echo "$IN_FLIGHT_TASK" | sed 's/"/\\"/g')
  IN_FLIGHT_JSON="\"${ESCAPED}\""
fi

cat > "$TMP_FILE" <<EOF
{
  "member": "${MEMBER}",
  "ts": ${TS},
  "input_kt": ${INPUT_KT},
  "output_kt": ${OUTPUT_KT},
  "context_pct": ${CONTEXT_PCT},
  "window_kt": ${WINDOW_KT},
  "in_flight_task": ${IN_FLIGHT_JSON}
}
EOF

mv -f "$TMP_FILE" "$OUT_FILE" 2>/dev/null || {
  echo "measure-context.sh: mv to ${OUT_FILE} failed — skip" >&2
  rm -f "$TMP_FILE" 2>/dev/null
  exit 0
}

# Success — emit one line to stderr for whip log archeology. Quiet on
# stdout so callers can capture stdout for other purposes.
echo "measure-context.sh: ${MEMBER}@${TEAM} ctx=${CONTEXT_PCT}% (↑${INPUT_KT}k ↓${OUTPUT_KT}k / ${WINDOW_KT}k)" >&2
exit 0

#!/usr/bin/env bash
# clear-member.sh — robust teammate clear-and-rebrief.
#
# Fixes the three fragile patterns in the naive inline flow:
#   1. `/clear` sent while teammate is mid-turn → queues behind in-flight
#      work, brief paste queues on top of that, `/clear` never cleanly lands.
#   2. `sleep 3` after `/clear` is a guess, not a signal. If the teammate
#      was compacting (60s+), post-clear state isn't verified.
#   3. `tmux paste-buffer + Enter` for the brief is broken under bracketed
#      paste — the paste's trailing newline leaves the cursor on an empty
#      continuation line and the Enter doesn't submit. Brief sits unsent.
#
# This script:
#   - Polls for teammate-idle BEFORE sending /clear.
#   - Sends /clear via single-line send-keys (reliable submit).
#   - Polls for post-clear idle.
#   - Writes the brief to a file and submits `Read <path>` via single-line
#     send-keys — bypasses bracketed-paste entirely. Teammate's first tool
#     call is Read, which consumes the file. Self-cleaning.
#
# Usage: clear-member.sh <team> <member> [reason...]
# Exits: 0 ok, 2 misuse, 3 no-window, 4 wrong-command, 5 timeout.

set -euo pipefail

TEAM="${1:?usage: clear-member.sh <team> <member> [reason]}"
MEMBER="${2:?usage: clear-member.sh <team> <member> [reason]}"
shift 2
REASON="$*"

WINDOW="__${TEAM}__${MEMBER}"
BRIEF_FILE="/tmp/team-clear-brief-${TEAM}-${MEMBER}.txt"

log() { echo "[$(TZ='${user_config.COORDINATION_TZ}' date +'%H:%M:%S ${user_config.COORDINATION_TZ_SUFFIX}')] $*"; }

# --- guards ---------------------------------------------------------------

if [ "$MEMBER" = "team-lead" ]; then
  log "FAIL: use /team rotate-lead for the lead, not /team clear"
  exit 2
fi

if ! tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -q "^${WINDOW}$"; then
  log "FAIL: no tmux window ${WINDOW} — member dead or not spawned. Try /team add ${MEMBER} or /team start."
  exit 3
fi

PANE_CMD=$(tmux list-panes -a -F '#{window_name} #{pane_current_command}' 2>/dev/null | awk -v w="$WINDOW" '$1==w{print $2}')
if [ "$PANE_CMD" != "claude" ]; then
  log "FAIL: pane for ${MEMBER} runs '${PANE_CMD}', not 'claude' — refusing to clobber shell input"
  exit 4
fi

# --- idle detection -------------------------------------------------------

# Is the teammate ready to receive input?
# Idle: pane contains the `❯ ` prompt-only line AND no busy markers.
# Busy: thinking/compacting/queued-messages markers present anywhere in recent tail.
# Empty (blank pane, TUI rendered off-screen): treat as idle — Claude is
# definitely not mid-turn if there's no busy banner.
is_idle() {
  local tail
  tail=$(tmux capture-pane -t "$WINDOW" -p -S -20 2>/dev/null | tail -20)

  # Busy signals — any of these anywhere in recent tail = not idle
  if echo "$tail" | grep -qE "(thinking with|thought for|Compacting|Cogitating|Press up to edit queued|…)"; then
    return 1
  fi

  # Non-blank content AND has prompt-only line → idle
  # Or: blank pane (no content at all) → treat as idle, Claude is idle somewhere off-screen
  if echo "$tail" | grep -qE "^[[:space:]]*❯[[:space:]]*$"; then
    return 0
  fi
  # Fallback: if the tail has no busy markers AND no visible prompt, it's
  # likely TUI-scrolled-off or freshly-cleared — safe to treat as idle.
  local non_blank
  non_blank=$(echo "$tail" | grep -cv '^[[:space:]]*$' || echo 0)
  if [ "$non_blank" -lt 3 ]; then
    return 0
  fi

  return 1
}

wait_for_idle() {
  local max_sec=${1:-120}
  local elapsed=0
  while [ "$elapsed" -lt "$max_sec" ]; do
    if is_idle; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# --- step 1: wait for idle before sending /clear --------------------------

log "waiting for ${MEMBER} to be idle (up to 120s)..."
if ! wait_for_idle 120; then
  log "WARN: ${MEMBER} still busy after 120s. /clear will queue behind in-flight work. Continuing."
fi

# --- step 2: send /clear (single-line, reliable submit) -------------------

log "sending /clear to ${MEMBER}..."
tmux send-keys -t "$WINDOW" "/clear" Enter

# --- step 3: wait for post-clear idle -------------------------------------
# /clear is usually fast (<2s). But if teammate was mid-turn, it processed
# in-flight work first. Budget 60s total.

sleep 2
if ! wait_for_idle 60; then
  log "WARN: ${MEMBER} not idle 60s after /clear — brief may queue. Continuing."
fi

# --- step 4: write brief to file + submit `Read <path>` single-line ------
# Using `Read` bypasses bracketed-paste issues with multi-line paste-buffer.
# Teammate's first tool call in the fresh context reads this file and
# follows the instructions inside.

ROLE="General-purpose teammate"
if [ -f .claude/team.json ] && command -v jq >/dev/null 2>&1; then
  ROLE_FROM_JSON=$(jq -r --arg m "$MEMBER" '.members[] | select(.name == $m) | .role // empty' .claude/team.json 2>/dev/null || echo "")
  [ -n "$ROLE_FROM_JSON" ] && ROLE="$ROLE_FROM_JSON"
fi

{
  echo "# Re-brief for ${MEMBER} on ${TEAM}"
  echo ""
  echo "You are the \`${MEMBER}\` teammate on team \`${TEAM}\`. Your conversation context was just cleared."
  echo ""
  echo "## Role"
  echo ""
  echo "$ROLE"
  echo ""
  if [ -n "$REASON" ]; then
    echo "## Why you were cleared"
    echo ""
    echo "$REASON"
    echo ""
  fi
  echo "## First actions"
  echo ""
  echo "1. Read \`~/.claude/teams/${TEAM}/inboxes/${MEMBER}.json\` to see any queued messages from team-lead."
  echo "2. Run \`TaskList\` to see current in-flight + pending tasks. Claim ones owned by you (or unowned ones matching your lane)."
  echo "3. Read the project handoff at \`~/.claude/projects/<project-slug>/todo/<branch>/handoff.md\` for standing decisions and recent state. Do NOT relitigate standing decisions."
  echo "4. If nothing actionable, reply to team-lead via SendMessage: 'standing by for dispatch'."
  echo ""
  echo "## Rules"
  echo ""
  echo "- Work only within your lane (\`${MEMBER}\`). Surface cross-lane blockers to team-lead; do not patch other teammates' code."
  echo "- Every commit: ping team-lead via SendMessage with the SHA."
  echo "- Unit tests in the same commit as code."
  echo ""
  echo "You can delete this file after reading."
} > "$BRIEF_FILE"

log "submitting 'Read ${BRIEF_FILE}' to ${MEMBER}..."
tmux send-keys -t "$WINDOW" "Read ${BRIEF_FILE} and follow the instructions inside." Enter

# --- step 5: verify submit landed (pane consumed the command) -------------

sleep 3
TAIL=$(tmux capture-pane -t "$WINDOW" -p -S -15 2>/dev/null | tail -15)

# If `❯ Read ...` is still a present line (anywhere in recent tail — the
# prompt line isn't necessarily the last line; tmux TUI puts a status line
# "opus 4.7 │ ctx -- │ tok …" below the prompt divider), the REPL didn't
# consume it. Match the prompt line specifically, not just substring.
if echo "$TAIL" | grep -qE "^[[:space:]]*❯ Read ${BRIEF_FILE}[[:space:]]*$"; then
  log "FAIL: 'Read ...' command still at prompt after 3s — submit didn't land"
  echo "last pane content:" >&2
  echo "$TAIL" >&2
  exit 5
fi

log "ok: cleared ${MEMBER} + submitted re-brief"
log "pane tail:"
echo "$TAIL" | grep -v '^[[:space:]]*$' | tail -6 | sed 's/^/    /'

# --- step 6: reset context-age marker (read by whip-watchdog Check 4) -----
# Context was just reset via /clear, so age-since-last-clear = now. Without
# this, whip-watchdog's teammate-uptime-nag would fall back to process etimes
# and keep pinging Discord as "overdue" even after we just cleared.
MARKER_DIR="$HOME/.claude/teams/${TEAM}"
mkdir -p "$MARKER_DIR"
date +%s > "${MARKER_DIR}/member-clear-${MEMBER}.txt"

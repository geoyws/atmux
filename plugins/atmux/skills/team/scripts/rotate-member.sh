#!/usr/bin/env bash
# rotate-member.sh — checkpoint + clear + resume-from-checkpoint for a teammate.
#
# Distinct from clear-member.sh:
#   - clear  = "you're confused/stale, start fresh from role brief"
#   - rotate = "you're fine but context is big, checkpoint then resume"
#
# Flow:
#   1. Guards (not lead, window exists, running claude).
#   2. Wait for idle.
#   3. Ask teammate to write an in-flight checkpoint to a known path.
#   4. Poll for checkpoint file (exists + stable mtime) up to 180s.
#   5. If checkpoint present → /clear + re-brief pointing at checkpoint.
#   6. If checkpoint missing → abort, caller decides whether to fall back to
#      /team clear (loses checkpoint) or ping Discord for manual handling.
#   7. Write context-age marker so whip-watchdog stops nagging about this member.
#
# Usage: rotate-member.sh <team> <member>
# Exits: 0 ok, 2 misuse, 3 no-window, 4 wrong-command, 5 submit-didnt-land,
#        6 checkpoint-timeout.

set -euo pipefail

TEAM="${1:?usage: rotate-member.sh <team> <member>}"
MEMBER="${2:?usage: rotate-member.sh <team> <member>}"

WINDOW="__${TEAM}__${MEMBER}"
CHECKPOINT_FILE="$HOME/.claude/teams/${TEAM}/rotate-${MEMBER}.md"
INSTR_FILE="/tmp/team-rotate-instr-${TEAM}-${MEMBER}.txt"
BRIEF_FILE="/tmp/team-rotate-brief-${TEAM}-${MEMBER}.txt"

log() { echo "[$(TZ='${user_config.COORDINATION_TZ}' date +'%H:%M:%S ${user_config.COORDINATION_TZ_SUFFIX}')] $*"; }

# --- guards ---------------------------------------------------------------

if [ "$MEMBER" = "team-lead" ]; then
  log "FAIL: use /team rotate-lead for the lead, not /team rotate-member"
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

# --- idle detection (mirrors clear-member.sh) -----------------------------

is_idle() {
  local tail
  tail=$(tmux capture-pane -t "$WINDOW" -p -S -20 2>/dev/null | tail -20)
  if echo "$tail" | grep -qE "(thinking with|thought for|Compacting|Cogitating|Press up to edit queued|…)"; then
    return 1
  fi
  if echo "$tail" | grep -qE "^[[:space:]]*❯[[:space:]]*$"; then
    return 0
  fi
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

# --- step 1: wait for idle before asking for checkpoint -------------------

log "waiting for ${MEMBER} to be idle (up to 180s)..."
if ! wait_for_idle 180; then
  log "FAIL: ${MEMBER} still busy after 180s — can't safely rotate mid-turn"
  exit 6
fi

# --- step 2: ask teammate to write checkpoint -----------------------------
# Use the `Read <path>` trick to avoid bracketed-paste issues on multi-line
# instructions (same reason clear-member.sh uses it for the re-brief).

# Pre-clean any stale checkpoint from a previous rotation attempt
rm -f "$CHECKPOINT_FILE"
mkdir -p "$(dirname "$CHECKPOINT_FILE")"

cat > "$INSTR_FILE" <<EOF
# Rotation checkpoint request

Your conversation context is about to be rotated (\`/clear\` + re-brief). Before
that happens, write a concise in-flight checkpoint so future-you can resume
cleanly.

## Steps

1. Write a Markdown file to exactly this path: \`${CHECKPOINT_FILE}\`
2. Keep it tight — **one screen max**. Future-you has fresh context, this is
   the only handoff.

## Contents

\`\`\`markdown
# Rotation checkpoint — ${MEMBER} @ \$(date)

## What you were doing
- One-two sentences. The current task number + what phase.

## Uncommitted work
- Anything in working tree, with file paths. Nothing = say "nothing uncommitted".

## SHAs relevant right now
- Recent commits that are load-bearing for the current thread.

## Next concrete action
- One bullet. The literal next thing to do.

## Open questions (if any)
- Numbered. Things blocking you that need driver/lead input.
\`\`\`

## After writing

Do nothing else — do NOT SendMessage anyone, do NOT start new work. Just write
the file and stop. Your next input will be a fresh-context re-brief that points
at this file.
EOF

log "sending checkpoint request to ${MEMBER}..."
tmux send-keys -t "$WINDOW" "Read ${INSTR_FILE} and follow the instructions inside." Enter

# --- step 3: poll for checkpoint file (exists + stable mtime) -------------
# "Stable mtime" = not modified in last 5s. Catches the race where teammate
# is still writing and we'd read a half-file.

log "polling for checkpoint file (up to 180s)..."
elapsed=0
last_mtime=0
stable_since=0
while [ "$elapsed" -lt 180 ]; do
  if [ -f "$CHECKPOINT_FILE" ]; then
    mtime=$(stat -c %Y "$CHECKPOINT_FILE" 2>/dev/null || echo 0)
    size=$(stat -c %s "$CHECKPOINT_FILE" 2>/dev/null || echo 0)
    if [ "$mtime" != "$last_mtime" ]; then
      last_mtime=$mtime
      stable_since=$(date +%s)
    elif [ "$size" -gt 100 ] && [ $(( $(date +%s) - stable_since )) -ge 5 ]; then
      log "checkpoint received: ${size} bytes, stable 5s"
      break
    fi
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done

if [ ! -f "$CHECKPOINT_FILE" ] || [ "$(stat -c %s "$CHECKPOINT_FILE" 2>/dev/null || echo 0)" -lt 100 ]; then
  log "FAIL: checkpoint file missing or too small after 180s — aborting rotation"
  log "  teammate didn't cooperate. Consider /team clear ${MEMBER} (discards state) or attach manually."
  rm -f "$INSTR_FILE"
  exit 6
fi

# --- step 4: send /clear --------------------------------------------------

log "sending /clear to ${MEMBER}..."
tmux send-keys -t "$WINDOW" "/clear" Enter

sleep 2
if ! wait_for_idle 60; then
  log "WARN: ${MEMBER} not idle 60s after /clear — brief may queue. Continuing."
fi

# --- step 5: write resume brief pointing at checkpoint --------------------

ROLE="General-purpose teammate"
if [ -f .claude/team.json ] && command -v jq >/dev/null 2>&1; then
  ROLE_FROM_JSON=$(jq -r --arg m "$MEMBER" '.members[] | select(.name == $m) | .role // empty' .claude/team.json 2>/dev/null || echo "")
  [ -n "$ROLE_FROM_JSON" ] && ROLE="$ROLE_FROM_JSON"
fi

cat > "$BRIEF_FILE" <<EOF
# Resume brief for ${MEMBER} on ${TEAM} — post-rotation

You are the \`${MEMBER}\` teammate on team \`${TEAM}\`. Your conversation context was just
\`/clear\`-ed to keep memory fresh. Before the clear, past-you wrote a checkpoint
at \`${CHECKPOINT_FILE}\`.

## Role

${ROLE}

## First actions (in order)

1. Read \`${CHECKPOINT_FILE}\` — this is past-you's note to future-you (you).
2. Execute the "Next concrete action" from the checkpoint. Do not re-plan,
   past-you already planned.
3. If the checkpoint has "Open questions", SendMessage them to team-lead.
4. Delete \`${CHECKPOINT_FILE}\` after you've absorbed it — it's ephemeral.
5. If the checkpoint is unclear or seems stale, fall back: \`TaskList\`, check
   your inbox at \`~/.claude/teams/${TEAM}/inboxes/${MEMBER}.json\`, read the
   project handoff at \`~/.claude/projects/<project-slug>/todo/<branch>/handoff.md\`.

## Rules

- Work only within your lane (\`${MEMBER}\`). Surface cross-lane blockers to team-lead; do not patch other teammates' code.
- Every commit: ping team-lead via SendMessage with the SHA.
- Unit tests in the same commit as code.

You can delete this brief file after reading.
EOF

log "submitting 'Read ${BRIEF_FILE}' to ${MEMBER}..."
tmux send-keys -t "$WINDOW" "Read ${BRIEF_FILE} and follow the instructions inside." Enter

# --- step 6: verify submit landed -----------------------------------------

sleep 3
TAIL=$(tmux capture-pane -t "$WINDOW" -p -S -15 2>/dev/null | tail -15)
if echo "$TAIL" | grep -qE "^[[:space:]]*❯ Read ${BRIEF_FILE}[[:space:]]*$"; then
  log "FAIL: 'Read ...' command still at prompt after 3s — submit didn't land"
  echo "last pane content:" >&2
  echo "$TAIL" >&2
  exit 5
fi

# --- step 7: reset context-age marker (read by whip-watchdog Check 4) -----

MARKER_DIR="$HOME/.claude/teams/${TEAM}"
mkdir -p "$MARKER_DIR"
date +%s > "${MARKER_DIR}/member-clear-${MEMBER}.txt"

# --- cleanup --------------------------------------------------------------

rm -f "$INSTR_FILE"
# Leave BRIEF_FILE + CHECKPOINT_FILE for the teammate to read; they'll delete.

log "ok: rotated ${MEMBER} — checkpoint captured, /clear-ed, re-briefed"
log "pane tail:"
echo "$TAIL" | grep -v '^[[:space:]]*$' | tail -6 | sed 's/^/    /'

#!/bin/bash
# send-keys-submit.sh — send a single-line command to a tmux pane and verify it was consumed.
#
# Usage: send-keys-submit.sh <tmux-target> <command>
# Example: send-keys-submit.sh __<team>__backend "/team bootstrap"
#
# Exits 0 on success (command consumed by the pane's REPL).
# Exits 1 on verification failure (command still visible at the prompt after 3s).
# Exits 2 on usage error.
#
# Why this exists: bracketed-paste + trailing-newline used to silently bomb rotation
# submits. This helper standardises on single-line send-keys + post-submit verification
# so any future regression surfaces immediately instead of bricking a teammate silently.
#
# Design notes:
# - ONLY use this for single-line commands. Multi-line content must be written to a file
#   and loaded via a single-line "Read <path>" command to this helper.
# - The verification heuristic greps the last non-blank pane line for `❯ <command>` —
#   if the exact command is still sitting after the prompt marker, it wasn't submitted.
# - Exits 1 (not 2) on verification failure so callers can distinguish retry-able
#   submit failure from a caller-side usage bug.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <tmux-target> <command>" >&2
  exit 2
fi

TARGET="$1"
CMD="$2"

# Fire the command
tmux send-keys -t "$TARGET" "$CMD" Enter

# Give the REPL a moment to consume it. 3s handles the common case where the target
# is mid-turn; if the target is deeply busy (thinking 30s+) the verify will false-fail,
# but that's acceptable — callers should log the failure and let the next whip retry.
sleep 3

# Capture last 15 lines of the pane; trim blanks; look at the tail.
LAST=$(tmux capture-pane -t "$TARGET" -p -S -15 2>/dev/null | grep -v '^[[:space:]]*$' | tail -1 || echo "")

# If the last visible line is still `❯ <command>` verbatim, the REPL didn't consume it.
if echo "$LAST" | grep -qF "❯ $CMD"; then
  echo "FAIL send-keys-submit: '$CMD' still sitting at prompt in $TARGET" >&2
  echo "       last pane line: $LAST" >&2
  exit 1
fi

echo "ok send-keys-submit: '$CMD' consumed by $TARGET"

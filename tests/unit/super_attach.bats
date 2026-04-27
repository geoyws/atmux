#!/usr/bin/env bats
# Unit tests for `atmux super-attach` — E10/Sd t-14c5c7ea.
#
# super-attach (lib/super-attach.sh) is the spawn-or-attach verb for the
# global `atmux-superdriver` tmux session per ADR-025. Phase 1 cadence is
# ON-DEMAND only; the session is single-window, single-Claude-pane, brief
# auto-injected from templates/briefs/superdriver.md.
#
# Testing strategy: super-attach ends with `exec tmux attach-session ...`
# which fails in headless bats (no tty). Side-effects (new-session +
# send-keys + paste-buffer) DO complete before the exec. Assertions read
# those side-effects directly via `tmux list-sessions` + `capture-pane`.
# ATMUX_CLAUDE_BIN=/bin/true mocks the Claude TUI so the launch line
# doesn't choke on a missing `claude` binary in CI/sandbox environments.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  # super-attach is global / not team-bound, so no team.json is required.
  # Mock the Claude TUI: send-keys feeds the launch command into a shell
  # pane; /bin/true tolerates any --flag and exits 0, so the pane stays
  # quiet instead of erroring with "command not found: claude".
  export ATMUX_CLAUDE_BIN=/bin/true
  # ATMUX_SPAWN_WAIT=0 already exported by atmux_setup_sandbox; reasserted
  # here for clarity since super-attach honors it for the post-launch sleep.
  export ATMUX_SPAWN_WAIT=0
}

teardown() {
  # Kill any lingering atmux-superdriver session on the sandbox socket
  # before atmux_teardown_sandbox wipes TMUX_TMPDIR — keeps the host's
  # tmux server clean even if the sandbox kill-server step changes shape.
  if [[ -n "${TMUX_TMPDIR:-}" ]]; then
    local socket
    for socket in "$TMUX_TMPDIR"/tmux-*/default "$TMUX_TMPDIR/default"; do
      [[ -S "$socket" ]] || continue
      tmux -S "$socket" kill-session -t atmux-superdriver 2>/dev/null || true
    done
  fi
  atmux_teardown_sandbox
}

# Capture a pane's full visible + scrollback content. Scrollback bound is
# generous (-S -2000) because the brief plus the launch command echo can
# scroll well past one screen, especially when paste-buffer feeds a 60+-
# line markdown file into a shell prompt.
_capture_super_pane() {
  tmux capture-pane -p -t atmux-superdriver:superdriver -S -2000 2>/dev/null
}

# ---------- AC 1: spawn-if-absent ----------

@test "super-attach: spawn-if-absent — creates atmux-superdriver session when none exists" {
  # Precondition: no pre-existing session on this sandbox socket.
  ! tmux has-session -t atmux-superdriver 2>/dev/null

  # super-attach exec's `tmux attach-session` at the end which fails in
  # headless bats. The session-create + send-keys + paste-buffer side-
  # effects complete BEFORE the exec, so we tolerate the attach failure.
  run "$ATMUX_BIN" super-attach
  # Don't assert exit code — exec attach in non-tty fails. Side-effects
  # are the contract.

  # Side-effect: the named session must exist on the sandbox socket.
  tmux has-session -t atmux-superdriver
}

# ---------- AC 3: brief content markers present in pane ----------

@test "super-attach: brief content — pane scrollback contains key brief markers" {
  run "$ATMUX_BIN" super-attach
  local pane; pane="$(_capture_super_pane)"

  # Markers from templates/briefs/superdriver.md (per t-c8ef6619). The
  # paste-buffer feeds the brief into the pane's input stream; even when
  # the shell tries to interpret lines as commands the typed/echoed
  # characters land in scrollback and capture-pane sees them.
  [[ "$pane" == *"ON-DEMAND"* ]]
  [[ "$pane" == *"Phase 2 carve-out"* ]]
  [[ "$pane" == *"super-tell"* ]]
  [[ "$pane" == *"super-status"* ]]
}

# ---------- AC 5: Opus model in launch command ----------

@test "super-attach: launch command pins --model claude-opus-4-7" {
  run "$ATMUX_BIN" super-attach
  local pane; pane="$(_capture_super_pane)"

  # The launch line is sent via `tmux send-keys` BEFORE the brief paste,
  # so the typed text echoes into scrollback even though /bin/true silently
  # accepts and exits.
  [[ "$pane" == *"--model claude-opus-4-7"* ]]
  # Belt-and-suspenders: effort + permission flags from lib/super-attach.sh.
  [[ "$pane" == *"CLAUDECODE=1"* ]]
}

# ---------- AC 4: fixed session name per OQ G5 ----------

@test "super-attach: session name fixed at 'atmux-superdriver' (OQ G5)" {
  run "$ATMUX_BIN" super-attach

  # Exact-match grep — guards against naming drift to e.g. atmux-super,
  # atmux-superdriver-<host>, or anything else not OQ-G5-blessed.
  local sessions
  sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null)"
  [[ -n "$(printf '%s\n' "$sessions" | grep -x 'atmux-superdriver')" ]]
}

# ---------- AC 2: attach-if-exists — idempotent, no spawn duplication ----------

@test "super-attach: attach-if-exists — pre-existing session not respawned, no second brief inject" {
  # Pre-create the session manually with an EMPTY shell pane so we can
  # detect any subsequent brief injection by comparing pane content.
  tmux new-session -d -s atmux-superdriver -n superdriver -c "$HOME"
  [ "$(tmux list-sessions -F '#{session_name}' | grep -c '^atmux-superdriver$')" -eq 1 ]

  # Pre-state: pane has no claude launch + no brief markers.
  local before; before="$(_capture_super_pane)"
  [[ "$before" != *"--model claude-opus-4-7"* ]]
  [[ "$before" != *"ON-DEMAND"* ]]

  # Run super-attach. The early-return path hits `tmux has-session` ⇒ true
  # ⇒ exec tmux attach-session (fails in headless). NO new-session, NO
  # send-keys launch, NO paste-buffer brief.
  run "$ATMUX_BIN" super-attach

  # Still exactly one atmux-superdriver session — no spawn duplication.
  [ "$(tmux list-sessions -F '#{session_name}' | grep -c '^atmux-superdriver$')" -eq 1 ]

  # Pane content unchanged — early-return skipped both the launch send-keys
  # and the brief paste-buffer step.
  local after; after="$(_capture_super_pane)"
  [[ "$after" != *"--model claude-opus-4-7"* ]]
  [[ "$after" != *"ON-DEMAND"* ]]
}

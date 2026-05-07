#!/usr/bin/env bash
# atmux super-attach — attach (or spawn) the global atmux_superdriver session.
#
# atmux_superdriver is a fleet-wide driver session running Claude (Opus) for
# cross-team coordination via super-status (read-only) and super-tell (write
# via per-team tell-lead chain). Phase 1 per ADR-025: single window, single
# Claude pane, ON-DEMAND only — no whip-cycle.
#
# Idempotent. If the tmux session already exists, attach. Otherwise:
#   1. tmux new-session -d -s atmux_superdriver -n superdriver -c $HOME
#   2. send-keys the Claude (Opus) launch command into the pane
#   3. wait $ATMUX_SPAWN_WAIT seconds for the welcome screen to render
#   4. paste-buffer the brief from templates/briefs/superdriver.md
#   5. tmux attach-session -t atmux_superdriver
#
# Skips brief paste when templates/briefs/superdriver.md is absent — the
# brief lives in a sibling task (E10/Sd FE) and may not yet be on disk
# when this verb is first wired.

# Canonical fixed name per ADR-025 §OQ G5 — underscore separator per the
# fleet-wide naming convention (`-` for spaces, `_` for domain boundaries).
# Pre-2026-04-30 this was `atmux-superdriver` with a hyphen. Driver renamed
# in-place; verb default updated for fresh installs. Does NOT resolve via
# atmux::session_name — the superdriver is global, not bound to any team.json.
ATMUX_SUPERDRIVER_SESSION="atmux_superdriver"

main() {
  atmux::require tmux

  if tmux has-session -t "=$ATMUX_SUPERDRIVER_SESSION" 2>/dev/null; then
    atmux::ok "superdriver session already up — attaching"
    exec tmux attach-session -t "=$ATMUX_SUPERDRIVER_SESSION"
  fi

  atmux::log "spawning superdriver session: $ATMUX_SUPERDRIVER_SESSION"

  # fd 3/4 closure (per ADR-012) so a daemonised tmux server doesn't inherit
  # bats's status pipe when this runs under the test harness. No-op for
  # interactive use; required for bats green.
  tmux new-session -d -s "$ATMUX_SUPERDRIVER_SESSION" -n superdriver -c "$HOME" 3>&- 4>&-

  # NOTE: NO `set-option -g prefix` here. Superdriver runs on the operator's
  # default tmux socket (shared with the host's daily-driver tmux); a
  # server-scope prefix change would clobber every other session on that
  # socket. Cage prefix override lives in lib/start.sh, gated on the
  # cage's per-team TMUX_TMPDIR socket where blast radius is contained.

  local target="$ATMUX_SUPERDRIVER_SESSION:superdriver"
  local bin="${ATMUX_CLAUDE_BIN:-claude}"
  local effort="${ATMUX_CLAUDE_EFFORT:-xhigh}"
  local permission="${ATMUX_CLAUDE_PERMISSION:-dontAsk}"
  local launch
  printf -v launch 'CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=%s %s --permission-mode %s --model claude-opus-4-7' \
    "$effort" "$bin" "$permission"
  tmux send-keys -t "$target" "$launch" Enter

  # Match lib/start.sh:_atmux_spawn_member — wait for the Claude welcome
  # screen to render before pasting the brief, otherwise the paste lands
  # in the not-yet-ready prompt and is lost. ATMUX_SPAWN_WAIT honored for
  # fast-path tests (set to 0 in bats specs that mock the TUI).
  local wait_s="${ATMUX_SPAWN_WAIT:-6}"
  sleep "$wait_s"

  local brief="$ATMUX_TEMPLATES_DIR/briefs/superdriver.md"
  if [[ -f "$brief" ]]; then
    _atmux_paste_superdriver_brief "$target" "$brief"
  else
    atmux::warn "superdriver brief missing: $brief — skipping injection"
  fi

  exec tmux attach-session -t "=$ATMUX_SUPERDRIVER_SESSION"
}

# Paste-bracket brief injection — mirrors lib/start.sh:_atmux_paste_brief but
# skips atmux::render_brief's {{TEAM}}/{{MEMBER}}/{{ROLE}}/{{ATMUX_DIR}} sed
# pass: the superdriver is a global session, not bound to any team.json, so
# render_brief's atmux::team_name → atmux::require_team would die when the
# verb is run from a directory without `.atmux/`. The brief itself is the
# authoring surface for substitutions — Phase 1 keeps it static.
_atmux_paste_superdriver_brief() {
  local target="$1" brief_path="$2"
  local buf="atmux_superdriver_brief"
  tmux load-buffer -b "$buf" "$brief_path"
  tmux paste-buffer -b "$buf" -d -t "$target" 2>/dev/null \
    || tmux paste-buffer -b "$buf" -t "$target"
  sleep 1
  tmux send-keys -t "$target" Enter
}

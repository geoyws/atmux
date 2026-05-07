#!/usr/bin/env bats
# Pin tmux session-lookup invariants per SEC sweep (t-0dbfe104).
#
# Bare `tmux has-session -t <name>` is PREFIX-match, not exact-match — the
# 2026-04-27 reproducer that triggered this sweep: with sessions 'beta'
# and 'beta-other' alive, `tmux has-session -t beta-foo` falsely succeeds
# (matches 'beta' as a prefix of 'beta-foo'? actually matches 'beta-' as
# prefix of 'beta-foo' against 'beta-other'). The exact-match form
# `=<name>` (per tmux(1) §SESSIONS, "Names") fixes the false-green.
#
# These cells lock the contract on bare `tmux` AND on atmux helpers
# wrapping it.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  atmux_assert_sandbox
}

teardown() {
  # Twin-session cleanup — kill via exact-match so we don't rely on the
  # very behaviour under test.
  tmux kill-session -t '=beta'        2>/dev/null || true
  tmux kill-session -t '=beta-other'  2>/dev/null || true
  atmux_teardown_sandbox
}

@test "tmux session lookup: exact-match (=name) returns success only for literal session" {
  # Spawn twin sessions whose names overlap as prefixes — the canonical
  # reproducer shape that the SEC sweep is defending against.
  tmux new-session -d -s 'beta'        -n home 3>&- 4>&-
  tmux new-session -d -s 'beta-other'  -n home 3>&- 4>&-

  # Exact-match form: each literal name resolves; anything else fails.
  run tmux has-session -t '=beta'
  [ "$status" -eq 0 ]
  run tmux has-session -t '=beta-other'
  [ "$status" -eq 0 ]
  run tmux has-session -t '=beta-foo'
  [ "$status" -ne 0 ]
  run tmux has-session -t '=zeta'
  [ "$status" -ne 0 ]
}

@test "tmux session lookup: bare -t form is PREFIX-match — documents WHY the sweep was needed" {
  # This cell DOCUMENTS the broken behaviour (run live so a future tmux
  # release that fixes -t to exact-match would surface here as an
  # unexpected pass — at which point the `=` prefix can be removed). It
  # is not a contract under test; it's a regression-tripwire.
  tmux new-session -d -s 'beta'        -n home 3>&- 4>&-
  tmux new-session -d -s 'beta-other'  -n home 3>&- 4>&-

  # Bare 'beta-' would falsely succeed against 'beta-other' under the
  # prefix-match behaviour. tmux(1) docs it as the documented behaviour;
  # keep the assertion as `[ "$status" -eq 0 ]` so the cell goes red the
  # day tmux flips defaults (we'd want to know).
  run tmux has-session -t 'beta-'
  [ "$status" -eq 0 ]
}

@test "atmux::tmux_session_exists wraps the exact-match form (regression — twin-session false-green)" {
  # Stand up the wrapper's expected env: a team.json + a tmux session.
  # Use a name that's a strict prefix of another live session ('atmux-k'
  # vs 'atmux-kanban') — the real-world reproducer cited by unblocker.
  mkdir -p .atmux
  cat > .atmux/team.json <<'JSON'
{"name":"k","members":[{"name":"foo","tui":"shell"}]}
JSON
  # Stand up the longer-name twin first; the wrapper's session is 'atmux-k'.
  tmux new-session -d -s 'atmux-kanban' -n home 3>&- 4>&-

  # Without the fix this would falsely return true (prefix-match against
  # 'atmux-kanban'). With the fix it returns false because no 'atmux-k'
  # session exists.
  run atmux::tmux_session_exists
  [ "$status" -ne 0 ]

  # Now create the literal 'atmux-k' session and confirm the wrapper
  # returns true.
  tmux new-session -d -s 'atmux-k' -n home 3>&- 4>&-
  run atmux::tmux_session_exists
  [ "$status" -eq 0 ]

  tmux kill-session -t '=atmux-kanban' 2>/dev/null || true
  tmux kill-session -t '=atmux-k'      2>/dev/null || true
}

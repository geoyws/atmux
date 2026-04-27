#!/usr/bin/env bats
# Unit tests for the ADR-026 wizard flip: every team defaults to
# `singleSession=true`. The opt-in prompt from ADR-016 is gone — the
# wizard no longer asks, and the non-wizard template path also bakes in
# `singleSession: true`. `singleSession=false` survives as a *declared*
# (not prompted) escape hatch — operators set it by hand in team.json
# for non-human-driven teams or detached observer setups.
#
# Three ACs cover the contract:
#   1. Both init paths (template-driven `atmux init` AND
#      wizard-driven `atmux init --wizard`) emit `singleSession=true`
#      with no operator interaction beyond defaults.
#   2. Wizard output does NOT carry the legacy single-session
#      explainer copy or the "Spawn into driver tmux session?" prompt.
#   3. Manually flipping `team.json:.singleSession=false` post-init
#      still routes through the legacy `atmux-<team>` session-name —
#      the escape hatch is live.
#
# Refs: docs/adr/026-always-single-session-topology.md.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_assert_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- AC1: both init paths emit singleSession=true ----------

@test "ADR-026: 'atmux init' (non-wizard, template-driven) writes singleSession=true" {
  run "$ATMUX_BIN" init --name nw
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
  run jq -r '.singleSession' .atmux/team.json
  [ "$output" = "true" ]
}

@test "ADR-026: 'atmux init --wizard' with all-defaults stdin writes singleSession=true" {
  # All 17 wizard prompts get a default response. n_workers=0 so the
  # per-worker prompts (model + name) never fire — keeps the input feed
  # short + decoupled from preset-driven worker-prompt count.
  #   1  team_name (default = pwd basename)
  #   2  preset (default)
  #   3  include_planner          n
  #   4  include_reviewer         n
  #   5  include_gitter           n
  #   6  include_devops           n
  #   7  include_dba              n
  #   8  include_unblocker        n
  #   9  include_discorder        n
  #  10  n_workers                0
  #  11  emoji_mode (default)
  #  12  discord_hook (default = "")
  #  13  cage_isolation (default y) — ADR-018 isolated tmux socket
  #  14  tui_cmd_claude (default)
  #  15  tui_cmd_opencode (default)
  #  16  tui_cmd_kimi (default)
  #  17  tui_cmd_cursor (default)
  local feed; feed=$(mktemp)
  printf '\ndefault\nn\nn\nn\nn\nn\nn\nn\n0\nrandom\n\ny\n\n\n\n\n' > "$feed"
  run bash -c "'$ATMUX_BIN' init --wizard --force < '$feed'"
  rm -f "$feed"
  [ "$status" -eq 0 ]
  [ -f .atmux/team.json ]
  run jq -r '.singleSession' .atmux/team.json
  [ "$output" = "true" ]
}

# ---------- AC2: wizard does NOT prompt for single-session topology ----------

@test "ADR-026: wizard output has no legacy 'Spawn into driver tmux session' prompt" {
  # Capture wizard stdout+stderr; assert the ADR-016 prompt copy is
  # absent. Two markers — both must be gone:
  #   - "Spawn into driver tmux session?" — the prompt itself.
  #   - "Single-session mode spawns team windows" — the 4-line preamble.
  local feed; feed=$(mktemp)
  printf '\ndefault\nn\nn\nn\nn\nn\nn\nn\n0\nrandom\n\ny\n\n\n\n\n' > "$feed"
  run bash -c "'$ATMUX_BIN' init --wizard --force < '$feed' 2>&1"
  rm -f "$feed"
  [ "$status" -eq 0 ]
  ! [[ "$output" =~ "Spawn into driver tmux session" ]]
  ! [[ "$output" =~ "Single-session mode spawns team windows" ]]
}

# ---------- AC3: manual singleSession=false post-init still works ----------

@test "ADR-026: manual team.json:.singleSession=false still routes to atmux-<team> session" {
  # Init writes singleSession=true; operator hand-edits to false; the
  # session resolver MUST honor the manual override and fall back to
  # the dedicated `atmux-<team>` name (the ADR-016 legacy topology).
  # The state/session.txt absence is the second gate — when the file
  # is missing AND the flag is false, we're in pure dedicated-session
  # mode regardless of the wizard's default.
  run "$ATMUX_BIN" init --name escape
  [ "$status" -eq 0 ]
  run jq -r '.singleSession' .atmux/team.json
  [ "$output" = "true" ]

  # Flip to false (the declared escape hatch).
  jq '.singleSession = false' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  run jq -r '.singleSession' .atmux/team.json
  [ "$output" = "false" ]

  # No state/session.txt — atmux::session_name should fall through to
  # the legacy dedicated-session form. Mirrors the
  # tests/unit/single_session.bats backward-compat case.
  [ ! -f .atmux/state/session.txt ]
  atmux_source_libs
  run atmux::session_name
  [ "$status" -eq 0 ]
  [ "$output" = "atmux-escape" ]
}

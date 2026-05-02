#!/usr/bin/env bats
# Unit tests for the cage tmpdir separator convention.
#
# Convention (memory: feedback_path_separator_convention.md):
# multi-word prefix `atmux-tmux` joins to a team name via UNDERSCORE,
# not hyphen. Hyphen is reserved for within-name compounds. So
# `myteam-c` → `/tmp/atmux-tmux_myteam-c`, never `/tmp/atmux-tmux-myteam-c`.
#
# Bug sites the fix landed at: lib/init.sh:104 (template default) and
# lib/init.sh:246 (wizard path). These tests assert both surfaces emit
# the underscore form for any team name, including hyphen-bearing names
# where the mixed-separator anti-pattern would have been visible.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
}

teardown() {
  atmux_teardown_sandbox
}

@test "init: tmuxTmpdir uses underscore separator (simple name)" {
  run "$ATMUX_BIN" init --name beads
  [ "$status" -eq 0 ]
  run jq -r '.tmuxTmpdir' .atmux/team.json
  [ "$output" = "/tmp/atmux-tmux_beads" ]
}

@test "init: tmuxTmpdir uses underscore separator (hyphen-bearing name)" {
  # The canonical anti-pattern: `myteam-c` joined with hyphen produces
  # `atmux-tmux-myteam-c` — three hyphens of mixed semantic role.
  run "$ATMUX_BIN" init --name myteam-c
  [ "$status" -eq 0 ]
  run jq -r '.tmuxTmpdir' .atmux/team.json
  [ "$output" = "/tmp/atmux-tmux_myteam-c" ]
  # Negative: the mixed-separator form must not appear anywhere.
  run grep -F "atmux-tmux-myteam-c" .atmux/team.json
  [ "$status" -ne 0 ]
}

@test "init: tmuxTmpdir uses underscore separator (underscore-bearing name)" {
  run "$ATMUX_BIN" init --name unum_beads
  [ "$status" -eq 0 ]
  run jq -r '.tmuxTmpdir' .atmux/team.json
  [ "$output" = "/tmp/atmux-tmux_unum_beads" ]
  run grep -F "atmux-tmux-unum_beads" .atmux/team.json
  [ "$status" -ne 0 ]
}

@test "init --wizard: cage tmpdir uses underscore separator" {
  local tmp; tmp="$(mktemp)"
  # team_name=cage-test | preset=custom | planner y | reviewer y | gitter y |
  # devops n | dba n | unblocker n | discorder n | enforcer n | n_workers=1 |
  # emoji_mode=static | discord="" | cage_isolation=y |
  # tui_cmd_claude="" | tui_cmd_opencode="" | tui_cmd_kimi="" | tui_cmd_cursor="" |
  # worker tui=shell | worker model=default | worker name
  printf 'cage-test\ncustom\ny\ny\ny\nn\nn\nn\nn\nn\n1\nstatic\n\ny\n\n\n\n\nshell\ndefault\nworker-1\n' > "$tmp"
  run bash -c "'$ATMUX_BIN' init --wizard --force < '$tmp'"
  [ "$status" -eq 0 ]
  run jq -r '.tmuxTmpdir' .atmux/team.json
  [ "$output" = "/tmp/atmux-tmux_cage-test" ]
  rm -f "$tmp"
}

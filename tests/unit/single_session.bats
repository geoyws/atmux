#!/usr/bin/env bats
# Unit tests for the single-session topology (E7/Sa) — ADR-016 Phase 1.
#
# Covers the seven AC scenarios from t-f003c89a:
#   1. BACKWARD COMPAT — no flag, no state file → today's dedicated-session behavior.
#   2. opt-in via team.json — atmux::session_name reads state/session.txt.
#   3. opt-in via env — ATMUX_DRIVER_SESSION=1 at start.sh seeds state + flips flag.
#   4. window-name normalisation — placeholder is __<team>__home, never __atmux__home.
#   5. atmux stop under single-session — kill team windows ONLY, leave session alive.
#   6. refuse-gate — atmux stop dies when target == $TMUX but singleSession != true.
#   7. doctor orphan-session — yellow finding when singleSession=true + atmux-<team> alive.
#
# Mix of strategies: function-level tests (1, 2) source common.sh and call
# atmux::session_name directly; integration-level tests (3–7) drive bin/atmux
# against a real tmux server in the sandbox (TMUX_TMPDIR isolation), with
# $TMUX + $TMUX_PANE wired so display-message/precondition resolve to the
# synthetic driver session.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
}

teardown() {
  atmux_teardown_sandbox
}

# Helper: bring up a synthetic driver session, point $TMUX + $TMUX_PANE at it.
# Used by cases 3–7. Caller is responsible for any team-side setup before
# calling this.
_seed_driver() {
  tmux new-session -d -s driver -n shell
  local sock pid sid pane
  sock="$(tmux display-message -p '#{socket_path}')"
  pid="$(tmux display-message -p '#{pid}')"
  sid="$(tmux display-message -p -t driver '#{session_id}' | tr -d '$')"
  pane="$(tmux display-message -p -t driver:shell '#{pane_id}')"
  export TMUX="$sock,$pid,$sid"
  export TMUX_PANE="$pane"
}

# ---------- 1. BACKWARD COMPAT ----------

@test "single-session: backward compat — no flag, no state file → atmux-<team>" {
  echo '{"name":"legacy","members":[]}' > .atmux/team.json
  atmux_source_libs
  run atmux::session_name
  [ "$status" -eq 0 ]
  [ "$output" = "atmux-legacy" ]
  [ ! -f .atmux/state/session.txt ]
}

# ---------- 2. opt-in via state file ----------

@test "single-session: state/session.txt drives atmux::session_name resolution" {
  cat > .atmux/team.json <<'JSON'
{"name":"team-x","members":[],"singleSession":true}
JSON
  echo "driver-shell" > .atmux/state/session.txt
  atmux_source_libs
  run atmux::session_name
  [ "$status" -eq 0 ]
  [ "$output" = "driver-shell" ]
}

# ---------- 3. opt-in via env ----------

@test "single-session: ATMUX_DRIVER_SESSION=1 at start seeds state + flips flag" {
  cat > .atmux/team.json <<'JSON'
{"name":"team-x","members":[],"kanban":{"cronAutoInstall":false}}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  _seed_driver
  ATMUX_DRIVER_SESSION=1 run "$ATMUX_BIN" start --no-doctor
  [ "$status" -eq 0 ]

  # State file written, content = driver session name.
  [ -f .atmux/state/session.txt ]
  [ "$(cat .atmux/state/session.txt)" = "driver" ]

  # team.json grew the singleSession flag.
  local single; single="$(jq -r '.singleSession' .atmux/team.json)"
  [ "$single" = "true" ]

  # No dedicated atmux-<team> session was created.
  ! tmux has-session -t atmux-team-x 2>/dev/null
}

# ---------- 4. window-name normalisation ----------

@test "single-session: home placeholder uses per-team prefix __<team>__home" {
  # Legacy-mode start with members=[] keeps the placeholder alive (the
  # kill-home branch in start.sh only fires when at least one member
  # spawned). The per-team prefix is what avoids cross-team collision
  # when teams share a tmux session under single-session topology —
  # absence of `__atmux__home` is the regression guard.
  cat > .atmux/team.json <<'JSON'
{"name":"teamA","members":[],"kanban":{"cronAutoInstall":false}}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1

  local wins
  wins="$(tmux list-windows -t atmux-teamA -F '#{window_name}' 2>/dev/null)"
  echo "$wins" | grep -qx "__teamA__home"
  ! echo "$wins" | grep -qx "__atmux__home"
}

# ---------- 5. atmux stop under single-session: kill team windows ONLY ----------

@test "single-session: atmux stop kills team windows; session + non-team windows survive" {
  cat > .atmux/team.json <<'JSON'
{
  "name":"team-x",
  "members":[
    {"name":"alpha","role":"team-lead","tui":"shell","model":"default","cwd":"."},
    {"name":"bee","role":"member","tui":"shell","model":"default","cwd":"."},
    {"name":"cee","role":"member","tui":"shell","model":"default","cwd":"."}
  ],
  "kanban":{"cronAutoInstall":false}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in alpha bee cee; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done

  _seed_driver
  ATMUX_DRIVER_SESSION=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1
  sleep 0.3

  # Add a non-team "driver-work" window the operator owns.
  tmux new-window -d -t driver: -n driver-work

  run "$ATMUX_BIN" stop
  [ "$status" -eq 0 ]

  # Team windows gone.
  local wins; wins="$(tmux list-windows -t driver -F '#{window_name}')"
  ! echo "$wins" | grep -qx "__team-x__alpha"
  ! echo "$wins" | grep -qx "__team-x__bee"
  ! echo "$wins" | grep -qx "__team-x__cee"

  # Non-team windows + session intact.
  echo "$wins" | grep -qx "shell"
  echo "$wins" | grep -qx "driver-work"
  tmux has-session -t driver
}

# ---------- 6. refuse-gate ----------

@test "single-session: stop refuses when resolved target == \$TMUX but flag is false" {
  # Corrupt-state setup: state/session.txt resolves atmux::session_name to
  # the driver session, BUT team.json says singleSession=false (i.e. the
  # state file shouldn't have been written under legacy mode). atmux stop
  # would otherwise kill-session the driver shell — the refuse-gate is
  # the safety net.
  cat > .atmux/team.json <<'JSON'
{"name":"team-x","members":[],"kanban":{"cronAutoInstall":false}}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  _seed_driver
  echo "driver" > .atmux/state/session.txt   # corrupt state — flag=false but pointing at driver

  run "$ATMUX_BIN" stop
  [ "$status" -ne 0 ]
  [[ "$output" =~ "refusing to kill driver session" ]] \
    || [[ "$output" =~ "investigate" ]] \
    || [[ "$output" =~ "TMUX" ]]

  # Driver session unchanged.
  tmux has-session -t driver
  local count
  count="$(tmux list-windows -t driver -F '#{window_name}' | wc -l | tr -d ' ')"
  [ "$count" -ge 1 ]
}

# ---------- 7. doctor orphan-session detector ----------

@test "doctor: orphan-session yellow finding when singleSession=true + atmux-<team> alive" {
  cat > .atmux/team.json <<'JSON'
{
  "name":"team-x",
  "members":[{"name":"w1","role":"member","tui":"shell","model":"default","cwd":"."}],
  "singleSession":true,
  "kanban":{"cronAutoInstall":false}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  echo '{"pending":[],"inProgress":[],"done":[]}' > .atmux/inboxes/w1.json
  _seed_driver
  echo "driver" > .atmux/state/session.txt

  # Orphan: legacy `atmux-team-x` session lingering after the team
  # supposedly migrated to single-session.
  tmux new-session -d -s atmux-team-x -n stale

  run "$ATMUX_BIN" doctor
  [[ "$output" =~ "orphan-session" ]]
  [[ "$output" =~ "migrate-to-driver-session" ]]

  # Kill the orphan, re-run — finding should disappear.
  tmux kill-session -t atmux-team-x
  run "$ATMUX_BIN" doctor
  ! [[ "$output" =~ "orphan-session" ]]
}

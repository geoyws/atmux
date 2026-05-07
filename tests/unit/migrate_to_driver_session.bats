#!/usr/bin/env bats
# Unit tests for `atmux migrate-to-driver-session` (E7/Sb t-12e1aceb).
#
# Per ADR-016 Phase 2, migrate is the forward-direction topology mutation:
# move every team window from the dedicated `atmux-<team>` session into the
# driver's currently-attached tmux session via `tmux move-window`. Strict
# pre-flight pane-state precondition; cleanup gate kills source ONLY on
# zero-windows-remaining; idempotent on already-migrated teams.
#
# Testing strategy: real tmux server in the sandbox (via TMUX_TMPDIR), with
# a synthetic "driver" session created BEFORE atmux start so the migrate
# verb can resolve $TMUX → driver. We export TMUX_PANE pointing at the
# driver shell — that's how `tmux display-message -p '#S'` (with no -t)
# resolves the session name when not running under an attached client.
# Verified empirically: TMUX env's session_id field alone is insufficient;
# TMUX_PANE is the load-bearing piece.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "team-x",
  "members": [
    {"name": "alpha", "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "bee",   "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "cee",   "role": "member",    "lane": "fe",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "kanban": {"cronAutoInstall": false},
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in alpha bee cee; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
}

teardown() {
  atmux_teardown_sandbox
}

# Bring up a synthetic driver session + the team's dedicated atmux-team-x
# session, then point $TMUX_PANE / $TMUX at the driver so migrate's
# precondition + display-message resolution land on "driver".
_start_team_and_driver() {
  # 1. Driver session FIRST — it'll host the migrated windows.
  tmux new-session -d -s driver -n shell

  # 2. atmux start creates atmux-team-x with __team-x__{alpha,bee,cee}.
  "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true

  # 3. Wait for member windows to register (best-effort).
  for _ in 1 2 3 4 5; do
    tmux list-windows -t atmux-team-x -F '#{window_name}' 2>/dev/null \
      | grep -qx "__team-x__alpha" && break
    sleep 0.2
  done

  # 4. Construct a TMUX env that points at the sandbox server, plus a
  #    TMUX_PANE that resolves to driver:shell — empirically `display-
  #    message -p '#S'` only honours the session via TMUX_PANE when no
  #    client is attached.
  local sock pid sid pane
  sock="$(tmux display-message -p '#{socket_path}')"
  pid="$(tmux display-message -p '#{pid}')"
  sid="$(tmux display-message -p -t driver '#{session_id}' | tr -d '$')"
  pane="$(tmux display-message -p -t driver:shell '#{pane_id}')"
  export TMUX="$sock,$pid,$sid"
  export TMUX_PANE="$pane"
}

# ---------- 1. happy path ----------

@test "migrate happy path: moves windows + state update + cleanup" {
  _start_team_and_driver

  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -eq 0 ]
  [[ "$output" =~ "migrated" ]]

  # Source session gone.
  ! tmux has-session -t atmux-team-x 2>/dev/null

  # Driver session has shell + 3 team windows.
  local wins; wins="$(tmux list-windows -t driver -F '#{window_name}')"
  echo "$wins" | grep -qx "shell"
  echo "$wins" | grep -qx "__team-x__alpha"
  echo "$wins" | grep -qx "__team-x__bee"
  echo "$wins" | grep -qx "__team-x__cee"
  local count; count="$(echo "$wins" | wc -l | tr -d ' ')"
  [ "$count" -eq 4 ]

  # state/session.txt = "driver".
  [ -f .atmux/state/session.txt ]
  [ "$(cat .atmux/state/session.txt)" = "driver" ]

  # team.json.singleSession = true.
  local single; single="$(jq -r '.singleSession // false' .atmux/team.json)"
  [ "$single" = "true" ]
}

# ---------- 2-4. pre-flight refusals (thinking / compacting / queued) ----------

@test "migrate pre-flight refuse: thinking-with banner" {
  _start_team_and_driver
  # Inject the banner into one team window so capture-pane sees it.
  tmux send-keys -t "atmux-team-x:__team-x__bee" \
    "echo 'thinking with xhigh effort'" Enter
  sleep 0.5

  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -ne 0 ]
  [[ "$output" =~ "thinking" ]] || [[ "$output" =~ "refusing" ]]
  [[ "$output" =~ "__team-x__bee" ]]

  # Nothing moved; source session intact.
  tmux has-session -t atmux-team-x
  local count
  count="$(tmux list-windows -t atmux-team-x -F '#{window_name}' | wc -l | tr -d ' ')"
  [ "$count" -eq 3 ]

  # team.json NOT flipped; state/session.txt NOT written.
  local single; single="$(jq -r '.singleSession // false' .atmux/team.json)"
  [ "$single" != "true" ]
  [ ! -f .atmux/state/session.txt ]
}

@test "migrate pre-flight refuse: Compacting conversation banner" {
  _start_team_and_driver
  tmux send-keys -t "atmux-team-x:__team-x__alpha" \
    "echo 'Compacting conversation...'" Enter
  sleep 0.5

  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -ne 0 ]
  [[ "$output" =~ "compacting" ]] || [[ "$output" =~ "refusing" ]]

  tmux has-session -t atmux-team-x
  local single; single="$(jq -r '.singleSession // false' .atmux/team.json)"
  [ "$single" != "true" ]
}

@test "migrate pre-flight refuse: queued-input banner" {
  _start_team_and_driver
  tmux send-keys -t "atmux-team-x:__team-x__cee" \
    "echo 'Press up to edit queued messages'" Enter
  sleep 0.5

  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -ne 0 ]
  [[ "$output" =~ "queued-input" ]] || [[ "$output" =~ "refusing" ]]

  tmux has-session -t atmux-team-x
  local single; single="$(jq -r '.singleSession // false' .atmux/team.json)"
  [ "$single" != "true" ]
}

# ---------- 5. cleanup gate: refuses if move fails (stragglers) ----------

@test "migrate cleanup gate: aborts before kill-session if move-window fails" {
  _start_team_and_driver

  # Force a real move-window failure mid-loop without an external mock:
  # register a tmux `window-linked` hook that renames `__team-x__bee` to
  # an unmatchable name as soon as the FIRST move lands in driver. The
  # second move-window call then iterates with `=__team-x__bee`, which
  # exact-matches no source window → tmux exits 1 → migrate atmux::die.
  # Source session has _unfindable + cee left behind = preserved.
  tmux set-hook -g window-linked \
    'rename-window -t "atmux-team-x:=__team-x__bee" "_unfindable"'

  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -ne 0 ]
  [[ "$output" =~ "failed to move" ]] || [[ "$output" =~ "aborting" ]]

  # Source session preserved (kill-session NEVER fires when move fails).
  tmux has-session -t atmux-team-x

  # team.json NOT flipped to single-session; state/session.txt NOT written.
  local single; single="$(jq -r '.singleSession // false' .atmux/team.json)"
  [ "$single" != "true" ]
  [ ! -f .atmux/state/session.txt ]

  # Cleanup the global hook so it doesn't bleed into other tests sharing
  # the tmux server (each test gets a fresh server via teardown, but be
  # belt-and-suspenders here).
  tmux set-hook -gu window-linked 2>/dev/null || true
}

# ---------- 6. idempotence ----------

@test "migrate idempotence: re-run on migrated team is a no-op success" {
  _start_team_and_driver

  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -eq 0 ]

  # State persisted between runs; second run hits the idempotency branch.
  run "$ATMUX_BIN" migrate-to-driver-session team-x
  [ "$status" -eq 0 ]
  [[ "$output" =~ "already migrated" ]]

  # Double-run did not break anything: driver still has shell + 3 team wins.
  local count
  count="$(tmux list-windows -t driver -F '#{window_name}' | wc -l | tr -d ' ')"
  [ "$count" -eq 4 ]
}

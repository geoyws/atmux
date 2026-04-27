#!/usr/bin/env bats
# Unit tests for `atmux super-tell` — E10/Sc t-4bad3dc3.
#
# super-tell (lib/super-tell.sh) writes to <projectRoot>/.atmux/driver-inbox.md
# AND tmux send-keys a heads-up into the target member's pane. Both paths
# share preflight gates: registry lookup, status==running, projectRoot exists,
# tmux session exists, pane-state idle.
#
# Sandbox: $ATMUX_REGISTRY + TMUX_TMPDIR isolate writes. ATMUX_CLAUDE_BIN
# unused — super-tell has no Claude TUI dep.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  atmux_assert_sandbox

  # Build a target project (team alpha) with a team.json that has a
  # team-lead member, so the `lead` sentinel resolves cleanly.
  TEAM_PROJ="$ATMUX_TEST_TMP/proj-alpha"
  mkdir -p "$TEAM_PROJ/.atmux"
  cat > "$TEAM_PROJ/.atmux/team.json" <<JSON
{
  "name":"alpha",
  "tmuxTmpdir":"$ATMUX_TEST_TMP/tmux",
  "members":[
    {"name":"lead","role":"team-lead"},
    {"name":"be-foo","role":"member"}
  ]
}
JSON

  # Register alpha in the sandbox registry. Session name = 'alpha' (flat
  # naming per ADR-026 default).
  atmux::registry_upsert alpha "$TEAM_PROJ" "alpha" >/dev/null

  # Spawn a target tmux session with one window per member. Window name
  # follows ADR-030: __<team>__<member> (no emoji set in registry yet).
  tmux new-session -d -s alpha -n "__alpha__lead" -c "$TEAM_PROJ" 3>&- 4>&-
  tmux new-window -t alpha -n "__alpha__be-foo" -c "$TEAM_PROJ" 3>&- 4>&-

  # Make every target pane non-empty so super-tell's capture-pane preflight
  # doesn't trip on the "empty capture → window missing?" branch. Without
  # this each freshly-spawned pane is bytewise empty for ~100ms before the
  # shell renders its prompt; the lib's preflight refuses-on-empty.
  tmux send-keys -t alpha:__alpha__lead   "echo ready" Enter
  tmux send-keys -t alpha:__alpha__be-foo "echo ready" Enter
  # Spin until both panes report non-empty content via capture-pane (max 2s).
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do
    local cap_lead cap_foo
    cap_lead="$(tmux capture-pane -p -t alpha:__alpha__lead   -S -10 2>/dev/null)"
    cap_foo="$( tmux capture-pane -p -t alpha:__alpha__be-foo -S -10 2>/dev/null)"
    [[ -n "$cap_lead" && -n "$cap_foo" ]] && break
    sleep 0.2
  done
}

teardown() {
  if [[ -n "${TMUX_TMPDIR:-}" ]]; then
    local socket
    for socket in "$TMUX_TMPDIR"/tmux-*/default "$TMUX_TMPDIR/default"; do
      [[ -S "$socket" ]] || continue
      tmux -S "$socket" kill-server 2>/dev/null || true
    done
  fi
  atmux_teardown_sandbox
}

# ---------- AC 1: happy path ----------

@test "super-tell: happy path — driver-inbox appended + pane send-keys recorded" {
  run "$ATMUX_BIN" super-tell alpha lead "implement caching layer"
  [ "$status" -eq 0 ]

  # Audit trail: driver-inbox.md gained an entry tagged with super-tell + msg.
  [ -f "$TEAM_PROJ/.atmux/driver-inbox.md" ]
  run grep -F "super-tell → lead" "$TEAM_PROJ/.atmux/driver-inbox.md"
  [ "$status" -eq 0 ]
  run grep -F "implement caching layer" "$TEAM_PROJ/.atmux/driver-inbox.md"
  [ "$status" -eq 0 ]

  # Pane-side: heads-up landed in the target window's scrollback.
  local pane; pane="$(tmux capture-pane -p -t alpha:__alpha__lead -S -100 2>/dev/null)"
  [[ "$pane" == *"super-tell"* ]] || [[ "$pane" == *"caching"* ]]
}

# ---------- AC 2: unknown team ----------

@test "super-tell: unknown team → die with prune suggestion" {
  run "$ATMUX_BIN" super-tell ghost lead "hello"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "ghost" ]]
  [[ "$output" =~ "registry" || "$output" =~ "prune" ]]
}

# ---------- AC 3: stale team — registry says running but tmux session absent ----------

@test "super-tell: stale team (session absent) → die with prune suggestion" {
  # Kill alpha's session BEHIND super-tell's back, leaving registry in
  # inconsistent 'running' state — exactly the stale case super-status --prune
  # is built to fix.
  tmux kill-session -t alpha
  run "$ATMUX_BIN" super-tell alpha lead "hello"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "alpha" ]]
  [[ "$output" =~ "session" || "$output" =~ "prune" ]]
}

# ---------- AC 4-6: pane-state refuse ----------

@test "super-tell: pane-state refuse — 'Compacting conversation' present" {
  # Inject the marker phrase into the target pane's scrollback. The shell
  # echoes the literal string back, which capture-pane then sees and
  # super-tell's preflight grep matches.
  tmux send-keys -t alpha:__alpha__lead "echo 'Compacting conversation in progress'" Enter
  sleep 0.2

  run "$ATMUX_BIN" super-tell alpha lead "hello"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "busy" || "$output" =~ "compact" || "$output" =~ "Compacting" ]]
}

@test "super-tell: pane-state refuse — 'thinking with' active" {
  tmux send-keys -t alpha:__alpha__lead "echo 'thinking with maximum effort'" Enter
  sleep 0.2

  run "$ATMUX_BIN" super-tell alpha lead "hello"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "busy" || "$output" =~ "thinking" ]]
}

@test "super-tell: pane-state refuse — 'Press up to edit queued messages'" {
  tmux send-keys -t alpha:__alpha__lead "echo 'Press up to edit queued messages'" Enter
  sleep 0.2

  run "$ATMUX_BIN" super-tell alpha lead "hello"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "busy" || "$output" =~ "queued" ]]
}

# ---------- AC 7: audit trail with provenance + timestamp ----------

@test "super-tell: audit trail — entry stamped with timestamp + super-tell tag + member" {
  "$ATMUX_BIN" super-tell alpha lead "first ask" >/dev/null

  local di="$TEAM_PROJ/.atmux/driver-inbox.md"
  # Most recent line is the inbox entry — bullet '-', then timestamp, then
  # provenance marker, then msg.
  local line; line="$(tail -1 "$di")"
  [[ "$line" =~ ^- ]]
  [[ "$line" =~ MYT ]]
  [[ "$line" =~ super-tell ]]
  [[ "$line" =~ lead ]]
  [[ "$line" =~ "first ask" ]]
}

# ---------- AC 8: multi-team isolation ----------

@test "super-tell: multi-team isolation — team A ping does NOT touch team B" {
  # Build a second target team beta in parallel.
  local proj_b="$ATMUX_TEST_TMP/proj-beta"
  mkdir -p "$proj_b/.atmux"
  cat > "$proj_b/.atmux/team.json" <<JSON
{
  "name":"beta",
  "tmuxTmpdir":"$ATMUX_TEST_TMP/tmux",
  "members":[{"name":"lead","role":"team-lead"}]
}
JSON
  atmux::registry_upsert beta "$proj_b" "beta" >/dev/null
  tmux new-session -d -s beta -n "__beta__lead" -c "$proj_b" 3>&- 4>&-
  tmux send-keys -t beta:__beta__lead "echo ready" Enter
  sleep 0.2

  # Snapshot beta's driver-inbox state (file may not exist yet — empty
  # baseline).
  local b_inbox="$proj_b/.atmux/driver-inbox.md"
  local b_pre_lines=0
  [[ -f "$b_inbox" ]] && b_pre_lines="$(wc -l <"$b_inbox" | tr -d ' ')"
  local b_pre_pane; b_pre_pane="$(tmux capture-pane -p -t beta:__beta__lead -S -100 2>/dev/null)"

  # Fire super-tell against ALPHA only.
  "$ATMUX_BIN" super-tell alpha lead "isolation test" >/dev/null

  # Beta's inbox should be untouched (line count unchanged or file still
  # absent), and beta's pane should not contain the alpha-bound message.
  if [[ -f "$b_inbox" ]]; then
    local b_post_lines; b_post_lines="$(wc -l <"$b_inbox" | tr -d ' ')"
    [ "$b_post_lines" = "$b_pre_lines" ]
  fi
  local b_post_pane; b_post_pane="$(tmux capture-pane -p -t beta:__beta__lead -S -100 2>/dev/null)"
  [[ "$b_post_pane" != *"isolation test"* ]]

  # ALPHA's inbox got the entry as expected.
  run grep -F "isolation test" "$TEAM_PROJ/.atmux/driver-inbox.md"
  [ "$status" -eq 0 ]
}

# ---------- bonus: empty msg refused ----------

@test "super-tell: empty msg → die with usage error" {
  run "$ATMUX_BIN" super-tell alpha lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "usage" || "$output" =~ "empty" ]]
}

# ---------- bonus: registry lookup is the source of truth (not team.json walk) ----------

@test "super-tell: deregistered team (status=stopped) → die with prune suggestion" {
  atmux::registry_deregister alpha
  run "$ATMUX_BIN" super-tell alpha lead "hello"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "stopped" || "$output" =~ "prune" ]]
}

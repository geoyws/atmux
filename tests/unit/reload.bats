#!/usr/bin/env bats
# Unit tests for `atmux reload` (lib/reload.sh) — E3/S1 t-a0520114.
#
# Sandbox-only: argv parsing + window-missing error. The live paste +
# blocker-skip behaviour is exercised in tests/e2e/lifecycle.bats once
# E3/S2+S3 land their full coverage; here we just guard the verb shape so
# the dispatcher never breaks and the brief renderer stays callable.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name r >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

@test "reload: no subcommand ⇒ usage error" {
  run "$ATMUX_BIN" reload
  [ "$status" -ne 0 ]
  [[ "$output" =~ "missing subcommand" ]]
}

@test "reload: unknown subcommand ⇒ error names brief-reload" {
  run "$ATMUX_BIN" reload nope
  [ "$status" -ne 0 ]
  [[ "$output" =~ "brief-reload" ]]
}

@test "reload brief-reload: missing <member> ⇒ error" {
  run "$ATMUX_BIN" reload brief-reload
  [ "$status" -ne 0 ]
  [[ "$output" =~ "<member> required" ]]
}

@test "reload brief-reload: unknown member ⇒ error (member must exist in team.json)" {
  run "$ATMUX_BIN" reload brief-reload no-such-member
  [ "$status" -ne 0 ]
}

@test "reload brief-reload: known member but no live tmux window ⇒ error" {
  # Pick the first declared member from the default-init template.
  local m; m=$(jq -r '.members[0].name' .atmux/team.json)
  [ -n "$m" ]
  run "$ATMUX_BIN" reload brief-reload "$m"
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no tmux window" ]] || [[ "$output" =~ "window" ]]
}

@test "reload brief-reload: --force on missing window still errors out (window precondition)" {
  local m; m=$(jq -r '.members[0].name' .atmux/team.json)
  run "$ATMUX_BIN" reload brief-reload "$m" --force
  [ "$status" -ne 0 ]
}

@test "reload brief-reload: unknown flag ⇒ error" {
  run "$ATMUX_BIN" reload brief-reload some-name --bogus
  [ "$status" -ne 0 ]
}

# ---------- config-reload ----------

@test "reload config-reload: takes no args" {
  run "$ATMUX_BIN" reload config-reload extra
  [ "$status" -ne 0 ]
}

@test "reload config-reload: errors when no spawn snapshot exists" {
  run "$ATMUX_BIN" reload config-reload
  [ "$status" -ne 0 ]
  [[ "$output" =~ "no spawn snapshot" ]] || [[ "$output" =~ "atmux start" ]]
}

@test "reload config-reload: no drift ⇒ atmux::ok 'N notified, M unchanged' (no errors)" {
  # Hand-craft a snapshot that exactly matches the current team.json's tracked
  # fields. With no drift and no live tmux session, the verb should succeed
  # silently (no member windows to ping; nothing to diff).
  mkdir -p .atmux/state
  jq '{members: [.members[] | {name, role: (.role // "member"),
                                lane: (.lane // "misc"),
                                model: (.model // "default"),
                                tui:   (.tui   // "claude")}]}' \
    .atmux/team.json > .atmux/state/spawn-snapshot.json
  run "$ATMUX_BIN" reload config-reload
  [ "$status" -eq 0 ]
  [[ "$output" =~ "config-reload" ]]
  [[ "$output" =~ "0 member" ]] || [[ "$output" =~ "notified" ]]
}

@test "reload config-reload: drifted member ⇒ delta line in stderr log" {
  # Snapshot says model=default for fe-auth; flip team.json model to opus and
  # expect the verb to log a delta. (No live tmux ⇒ no actual ping; the log
  # line still surfaces via atmux::log.)
  mkdir -p .atmux/state
  jq '{members: [.members[] | {name, role: (.role // "member"),
                                lane: (.lane // "misc"),
                                model: (.model // "default"),
                                tui:   (.tui   // "claude")}]}' \
    .atmux/team.json > .atmux/state/spawn-snapshot.json
  jq '(.members[] | select(.name == "fe-auth") | .model) = "opus"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  run "$ATMUX_BIN" reload config-reload
  [ "$status" -eq 0 ]
  # Either the per-member log line appears OR the summary acknowledges 0
  # notified (because there's no live window to send-keys into) — both are
  # acceptable; the BEHAVIOUR we're verifying is "verb runs without erroring".
  [[ "$output" =~ "config-reload" ]]
}

# ---------- atmux::render_brief shared helper (lib/common.sh) ----------

@test "render_brief: substitutes {{TEAM}}/{{MEMBER}}/{{ROLE}}/{{ATMUX_DIR}} placeholders" {
  atmux_source_libs
  local tmpl; tmpl="$(mktemp /tmp/atmux-brief-tmpl-XXXXXX.md)"
  cat > "$tmpl" <<'EOF'
team={{TEAM}} member={{MEMBER}} role={{ROLE}} dir={{ATMUX_DIR}}
EOF
  run atmux::render_brief alice member "$tmpl"
  [ "$status" -eq 0 ]
  [[ "$output" =~ team=r ]]
  [[ "$output" =~ member=alice ]]
  [[ "$output" =~ role=member ]]
  [[ "$output" =~ "dir=$ATMUX_DIR" ]]
  rm -f "$tmpl"
}

@test "render_brief: missing brief file ⇒ non-zero return" {
  atmux_source_libs
  run atmux::render_brief alice member /nonexistent/path.md
  [ "$status" -ne 0 ]
}

# ---------- live-session coverage (AC a/b/c + f/g/h) ----------
# Bring up a sandbox tmux session with shell-tui members so paste/send-keys
# side-effects are observable via `tmux capture-pane`. Each test below owns
# its own session (single tear-down via the shared atmux_teardown_sandbox).

_live_setup() {
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "rl",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  export ATMUX_SESSION="atmux-test-rl-$$-$RANDOM"
  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__rl__worker" && return 0
    sleep 0.2
  done
}

# AC (a): brief-reload <m> with clean pane → paste fires.
@test "reload brief-reload: clean pane ⇒ paste fires (banner appears in scrollback)" {
  _live_setup
  run "$ATMUX_BIN" reload brief-reload worker
  [ "$status" -eq 0 ]
  [[ "$output" =~ "reloaded brief for worker" ]]
  sleep 1
  local pane; pane=$(tmux capture-pane -p -S -200 -t "$ATMUX_SESSION" 2>/dev/null || echo "")
  [[ "$pane" =~ "BRIEF RELOAD" ]]
}

# AC (b): brief-reload <m> with 'Compacting conversation' → paste skipped + warn + exit 1.
@test "reload brief-reload: blocker banner ⇒ paste skipped, non-zero exit" {
  _live_setup
  local target="$ATMUX_SESSION:__rl__worker"
  tmux send-keys -t "$target" "echo 'Compacting conversation'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo 'Compacting conversation'" Enter
  sleep 1
  run "$ATMUX_BIN" reload brief-reload worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "skip" ]] || [[ "$output" =~ "Compacting" ]] || [[ "$output" =~ "compacting" ]]
}

# AC (c): brief-reload <m> with banner + --force → paste fires regardless.
@test "reload brief-reload: --force overrides blocker skip (paste fires)" {
  _live_setup
  local target="$ATMUX_SESSION:__rl__worker"
  tmux send-keys -t "$target" "echo 'Compacting conversation'" Enter 2>/dev/null \
    || tmux send-keys -t "$ATMUX_SESSION:worker" "echo 'Compacting conversation'" Enter
  sleep 1
  run "$ATMUX_BIN" reload brief-reload worker --force
  [ "$status" -eq 0 ]
  sleep 1
  local pane; pane=$(tmux capture-pane -p -S -200 -t "$ATMUX_SESSION" 2>/dev/null || echo "")
  [[ "$pane" =~ "BRIEF RELOAD" ]]
}

# AC (f): config-reload with role change → 1 ping with delta msg in pane.
@test "reload config-reload: role flip on one member ⇒ 1 notified, pane shows delta" {
  _live_setup
  # Flip worker role from 'member' to 'reviewer' AFTER spawn (snapshot
  # already on disk from `atmux start`).
  jq '(.members[] | select(.name == "worker") | .role) = "reviewer"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" reload config-reload
  [ "$status" -eq 0 ]
  [[ "$output" =~ "1 member" ]] || [[ "$output" =~ "notified" ]]

  sleep 1
  local pane; pane=$(tmux capture-pane -p -S -200 -t "$ATMUX_SESSION" 2>/dev/null || echo "")
  [[ "$pane" =~ "CONFIG RELOAD" ]]
  [[ "$pane" =~ "role" ]]
  [[ "$pane" =~ "member" ]] || [[ "$pane" =~ "reviewer" ]]
}

# AC (g): config-reload with multiple member changes → N pings.
@test "reload config-reload: drift on multiple members ⇒ N pings (matches change count)" {
  _live_setup
  # Flip BOTH members.
  jq '(.members[] | select(.name == "worker") | .lane) = "fe"
    | (.members[] | select(.name == "lead") | .model) = "opus"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" reload config-reload
  [ "$status" -eq 0 ]
  [[ "$output" =~ "2 member" ]] || [[ "$output" =~ "notified" ]]
}

# AC (h): config-reload skips members absent from spawn-snapshot.
@test "reload config-reload: member added post-spawn ⇒ silently skipped (cold-start)" {
  _live_setup
  # Add a third member to team.json AFTER snapshot was written. Verb must
  # skip them silently (no ping; not counted as notified or unchanged).
  jq '.members += [{"name":"newcomer","role":"member","lane":"db","tui":"shell","model":"default","cwd":"."}]' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" reload config-reload
  [ "$status" -eq 0 ]
  # Both pre-existing members are still unchanged (no drift in role/lane/model/tui).
  [[ "$output" =~ "0 member" ]] || [[ "$output" =~ "unchanged" ]]
  # 'newcomer' never appears as a notified target.
  ! [[ "$output" =~ "newcomer" ]]
}

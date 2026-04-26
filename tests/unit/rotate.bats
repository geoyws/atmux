#!/usr/bin/env bats
# Unit tests for `atmux rotate` / `atmux rotate-lead` epoch-write — T2.S1
# (t-20b4265a, deps t-9d90f3ac). Pre-scaffold per d-485b965d; the file
# stays untracked (`??`) until the parent BE commits.
#
# Per ADR-009 D1: lib/rotate.sh writes .atmux/state/<member>-rotated.epoch
# on every successful rotation (idempotent overwrite). Whip's auto-rotation
# logic (E2/S2) reads this file to anchor uptime.
#
# Testing strategy: rotate.sh requires a live tmux window for the target
# member (atmux::tmux_window_exists check + send-keys / paste-buffer). We
# bring up a minimal sandbox session via `atmux start` with tui=shell
# members so no real TUIs spawn. Same pattern as tests/e2e/lifecycle.bats.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "rot",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "model": "default", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "model": "default", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  export ATMUX_SESSION="atmux-test-rot-$$-$RANDOM"
}

teardown() {
  atmux_teardown_sandbox
}

# Bring up the sandbox tmux session so rotate has windows to address.
_start_session() {
  "$ATMUX_BIN" start >/dev/null 2>&1 || true
  # Best-effort wait for windows to register.
  for _ in 1 2 3 4 5; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -qx "__rot__lead" && return 0
    sleep 0.2
  done
}

# ---------- AC (a): rotate <member> writes the epoch file with valid digits ----------

@test "rotate: writes .atmux/state/<member>-rotated.epoch with digits-only epoch" {
  _start_session
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [ -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(cat .atmux/state/worker-rotated.epoch)
  [[ "$epoch" =~ ^[0-9]+$ ]]
}

# ---------- AC (b): re-rotate overwrites ----------

@test "rotate: re-rotate overwrites the epoch file (single line, latest value)" {
  _start_session
  "$ATMUX_BIN" rotate worker >/dev/null 2>&1
  local first; first=$(cat .atmux/state/worker-rotated.epoch)
  sleep 1
  # --force on the re-rotate skips the pre-flight pane-state check.
  # In a shell-tui sandbox the prior brief paste leaves blocker phrases
  # (`Press up to edit queued messages`, documented in member.md §12)
  # in scrollback — the pre-flight matches them and bails. Real-world
  # operator intent on an explicit re-rotate is to override anyway, so
  # this matches the ergonomics. E6/S1 t-09e761c4 (F10) added a sleep+
  # capture-pane settle that exposed the latent flake.
  "$ATMUX_BIN" rotate worker --force >/dev/null 2>&1
  local second; second=$(cat .atmux/state/worker-rotated.epoch)
  [[ "$second" =~ ^[0-9]+$ ]]
  [ "$second" -ge "$first" ]
  # File must have exactly one line (no append-mode accumulation).
  local lines; lines=$(wc -l < .atmux/state/worker-rotated.epoch)
  [ "$lines" -le 1 ]
}

# ---------- AC (c): rotate-lead writes lead's epoch under lead's name ----------

@test "rotate-lead: writes .atmux/state/lead-rotated.epoch (resolves team-lead role)" {
  _start_session
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -eq 0 ]
  [ -f .atmux/state/lead-rotated.epoch ]
  # Specifically lead's file, NOT a generic "lead.epoch" or anyone else's.
  [ ! -f .atmux/state/worker-rotated.epoch ]
  local epoch; epoch=$(cat .atmux/state/lead-rotated.epoch)
  [[ "$epoch" =~ ^[0-9]+$ ]]
}

@test "rotate-lead: with renamed team-lead member writes under the renamed name" {
  # Per the same role-not-name lookup pattern as the epic-summary fix
  # (review-followup t-53051620 / commit 8e4c303). rotate-lead should
  # follow the role, not hard-code 'lead'.
  jq '(.members[] | select(.role=="team-lead") | .name) = "captain"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  echo '{"pending":[],"inProgress":[],"done":[]}' > .atmux/inboxes/captain.json

  _start_session
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -eq 0 ]
  [ -f .atmux/state/captain-rotated.epoch ]
  [ ! -f .atmux/state/lead-rotated.epoch ]
}

# ---------- AC (d): state dir auto-created if missing ----------

@test "rotate: auto-creates .atmux/state/ when missing" {
  rm -rf .atmux/state
  _start_session
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [ -d .atmux/state ]
  [ -f .atmux/state/worker-rotated.epoch ]
}

# ---------- AC (e): epoch within ~5s of test wall-clock ----------

@test "rotate: epoch value is within 5s of test wall-clock at rotation time" {
  _start_session
  local before; before=$(date +%s)
  "$ATMUX_BIN" rotate worker >/dev/null 2>&1
  local after; after=$(date +%s)
  local epoch; epoch=$(cat .atmux/state/worker-rotated.epoch)
  [ "$epoch" -ge "$before" ]
  [ "$epoch" -le "$after" ]
  # Tighter: within 5s of either bound.
  [ $((epoch - before)) -le 5 ]
  [ $((after - epoch)) -le 5 ]
}

# ---------- error paths ----------

@test "rotate: unknown member errors before writing any epoch file" {
  _start_session
  run "$ATMUX_BIN" rotate ghost
  [ "$status" -ne 0 ]
  [ ! -f .atmux/state/ghost-rotated.epoch ]
}

@test "rotate-lead: errors when team.json has no team-lead role" {
  jq '(.members[] | select(.role=="team-lead") | .role) = "member"' \
    .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json
  _start_session
  run "$ATMUX_BIN" rotate-lead
  [ "$status" -ne 0 ]
  [[ "$output" =~ "team-lead" ]] || [[ "$output" =~ "lead" ]]
}

@test "rotate: no tmux window for member ⇒ errors before writing epoch" {
  # No _start_session — no windows exist. Rotate must refuse.
  run "$ATMUX_BIN" rotate worker
  [ "$status" -ne 0 ]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

# ---------- F10 post-paste validation (E6/S1 t-09e761c4) ----------

@test "rotate: brief paste with no marker in pane ⇒ skip epoch + warn (F10)" {
  # Simulate a silent-paste-failure mode by swapping the resolved brief
  # template (atmux::brief_path uses \$ATMUX_ROOT/templates/briefs/<role>.md)
  # to a marker-less version. rotate runs to completion (paste-buffer +
  # send-keys still execute), but the post-paste grep for
  # 'brief-version:|You are' against pane scrollback returns false,
  # so validation bails BEFORE record_brief_version + epoch write.
  # Pre-F10, the epoch was stamped regardless and whip thought the
  # member was freshly rotated.
  _start_session
  rm -f .atmux/state/worker-rotated.epoch

  # Build a sandbox ATMUX_ROOT that mirrors the real layout but with a
  # marker-less brief for role=member. bin/atmux resolves ATMUX_ROOT
  # via `readlink + cd -P` on its own path — so symlinks resolve to the
  # real repo. We copy bin/atmux as a regular file (not symlink) so
  # ATMUX_ROOT lands inside the sandbox; lib stays a symlink because
  # the lib resolution is via ATMUX_LIB_DIR which the binary derives
  # from its own real-path.
  local fake_root="$ATMUX_TEST_TMP/fake-root"
  mkdir -p "$fake_root/bin" "$fake_root/lib" "$fake_root/templates/briefs"
  cp "$ATMUX_REPO_ROOT/bin/atmux" "$fake_root/bin/atmux"
  for f in "$ATMUX_REPO_ROOT"/lib/*.sh "$ATMUX_REPO_ROOT"/lib/*.json; do
    [[ -f "$f" ]] && cp "$f" "$fake_root/lib/"
  done
  cat > "$fake_root/templates/briefs/member.md" <<'EOF'
no_marker_text_payload_xyz
EOF

  run "$fake_root/bin/atmux" rotate worker
  [ "$status" -eq 0 ]
  [ ! -f .atmux/state/worker-rotated.epoch ]
  [[ "$output" =~ "paste appears to have failed" ]]
}

# ---------- pre-flight pane-state check (added 2026-04-26) ----------
#
# rotate.sh refuses to /clear a pane that's mid-turn or has queued
# input — those states would lose user-visible work. Rate-limit /
# approaching-limit / Compacting banners DON'T block rotation (whip's
# AUTO-PRECLEAR path uses those as the trigger TO rotate). --force
# overrides the pre-flight unconditionally.
#
# Tests use the shell-tui sandbox + inject the literal banner string
# via `echo` so capture-pane picks it up — same pattern as
# whip_preclear.bats. The blocker patterns are specific enough not to
# appear in legitimate shell scrollback, so the check works uniformly
# across TUIs.

@test "rotate pre-flight: mid-turn banner blocks rotation (status non-zero, no epoch)" {
  _start_session
  tmux send-keys -t "$ATMUX_SESSION:__rot__worker" \
    "echo 'thinking with xhigh effort'" Enter
  sleep 0.5

  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "mid-turn" ]] || [[ "$output" =~ "skipping" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate pre-flight: queued-input banner blocks rotation" {
  _start_session
  tmux send-keys -t "$ATMUX_SESSION:__rot__worker" \
    "echo 'Press up to edit queued messages'" Enter
  sleep 0.5

  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker
  [ "$status" -ne 0 ]
  [[ "$output" =~ "queued-input" ]] || [[ "$output" =~ "skipping" ]]
  [ ! -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate pre-flight: rate-limit banner does NOT block (rotation-eligible)" {
  # Rate-limit / approaching-limit / Compacting are the SIGNALS that
  # whip's AUTO-PRECLEAR uses to fire rotation — blocking on them
  # would defeat the feature.
  _start_session
  tmux send-keys -t "$ATMUX_SESSION:__rot__worker" \
    "echo 'you have hit your limit'" Enter
  sleep 0.5

  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [ -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate pre-flight: Compacting banner does NOT block (AUTO-PRECLEAR trigger)" {
  _start_session
  tmux send-keys -t "$ATMUX_SESSION:__rot__worker" \
    "echo 'Compacting conversation'" Enter
  sleep 0.5

  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker
  [ "$status" -eq 0 ]
  [ -f .atmux/state/worker-rotated.epoch ]
}

@test "rotate pre-flight: --force overrides mid-turn block" {
  _start_session
  tmux send-keys -t "$ATMUX_SESSION:__rot__worker" \
    "echo 'thinking with xhigh effort'" Enter
  sleep 0.5

  rm -f .atmux/state/worker-rotated.epoch
  run "$ATMUX_BIN" rotate worker --force
  [ "$status" -eq 0 ]
  [ -f .atmux/state/worker-rotated.epoch ]
}

#!/usr/bin/env bats
# Unit tests for the doctor audit checks added in E6/S3 — t-faba37e3.
# Coverage for BE task t-d0c2e85a (lib/doctor.sh A5 + A6 + --fix).
#
# AC:
#   1. Stale whip-last.hash (>24h) + session UP ⇒ yellow finding.
#   2. Fresh whip-last.hash ⇒ silent.
#   3. Phantom inbox entry ⇒ yellow finding citing member + id.
#   4. `atmux doctor --fix` prunes phantoms; second `--fix` is a no-op.
#   5. Session DOWN ⇒ stale-hash check skipped (whip can't run anyway).
#
# The doctor's UNIT-test layer here sources lib/{common,doctor}.sh +
# overrides atmux::tmux_session_exists in-shell to control UP/DOWN, then
# calls _doctor_check_whip_hash + _doctor_check_phantom_inboxes directly
# and asserts on the captured `_doctor_rows` array. The e2e --fix test
# uses `atmux doctor --json` to verify the check runs end-to-end + the
# fix path mutates state.
#
# Per memory feedback_orphan_test_staging.md: parent BE t-d0c2e85a is
# done — this .bats is safe to git add when worker stages.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  "$ATMUX_BIN" init --name d >/dev/null
  "$ATMUX_BIN" add-member worker1 --role member --lane be --tui shell >/dev/null
}

teardown() {
  atmux_teardown_sandbox
}

# ---------- helpers ----------

_load_doctor() {
  atmux_source_libs
  # shellcheck source=../../lib/doctor.sh
  . "$ATMUX_LIB_DIR/doctor.sh"
  _doctor_reset
}

# Did any doctor row of $1 status carry the substring $2 in its detail field?
_row_has() {
  local want_status="$1" want_substr="$2"
  local row status detail
  for row in "${_doctor_rows[@]}"; do
    IFS='|' read -r status _ detail _ <<<"$row"
    [[ "$status" == "$want_status" && "$detail" == *"$want_substr"* ]] && return 0
  done
  return 1
}

# Touch a file with mtime offset N hours from now (negative for past).
_touch_h() {
  local path="$1" offset_h="$2"
  touch "$path"
  local now; now=$(date +%s)
  local target=$(( now + offset_h * 3600 ))
  # GNU touch with -d @epoch.
  touch -d "@$target" "$path" 2>/dev/null \
    || touch -t "$(date -d "@$target" +%Y%m%d%H%M.%S 2>/dev/null || \
                   date -r "$target" +%Y%m%d%H%M.%S 2>/dev/null)" "$path"
}

_seed_phantom_fixture() {
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{
  "tasks": [{"id":"t-real","subject":"real","status":"done","createdAt":$now}],
  "epics": [],
  "stories": []
}
EOF
  cat > .atmux/inboxes/worker1.json <<EOF
{
  "pending": [],
  "inProgress": [
    {"id":"t-real","claimedAt":$now},
    {"id":"t-phantom-x","subject":"ghost","claimedAt":$now}
  ],
  "done": []
}
EOF
}

# ---------- AC test 1: stale whip-hash + session UP ⇒ yellow ----------

@test "doctor_audit: stale whip-last.hash (>24h) + session UP ⇒ yellow 'whip-last.hash stale' finding" {
  _load_doctor
  mkdir -p .atmux/state
  # 48h-old hash file.
  : > .atmux/state/whip-last.hash
  _touch_h .atmux/state/whip-last.hash -48

  # Session UP: override the helper.
  atmux::tmux_session_exists() { return 0; }

  _doctor_check_whip_hash
  _row_has yellow "whip-last.hash stale"
}

# ---------- AC test 2: fresh whip-hash ⇒ silent ----------

@test "doctor_audit: fresh whip-last.hash (<24h) ⇒ no whip-hash finding" {
  _load_doctor
  mkdir -p .atmux/state
  : > .atmux/state/whip-last.hash   # mtime = now
  atmux::tmux_session_exists() { return 0; }

  _doctor_check_whip_hash
  ! _row_has yellow "whip-last.hash"
}

@test "doctor_audit: missing whip-last.hash (cold-start) ⇒ silent (no nag on first whip tick)" {
  _load_doctor
  mkdir -p .atmux/state
  rm -f .atmux/state/whip-last.hash
  atmux::tmux_session_exists() { return 0; }

  _doctor_check_whip_hash
  [ "${#_doctor_rows[@]}" -eq 0 ]
}

# ---------- AC test 5: session DOWN ⇒ skip (no nag when team paused) ----------

@test "doctor_audit: session DOWN ⇒ stale-hash check skipped (whip can't run anyway)" {
  _load_doctor
  mkdir -p .atmux/state
  : > .atmux/state/whip-last.hash
  _touch_h .atmux/state/whip-last.hash -48

  atmux::tmux_session_exists() { return 1; }

  _doctor_check_whip_hash
  [ "${#_doctor_rows[@]}" -eq 0 ]
}

# ---------- AC test 3: phantom inbox ⇒ yellow ----------

@test "doctor_audit: phantom inbox entry ⇒ yellow finding cites member + id" {
  _load_doctor
  _seed_phantom_fixture

  _doctor_check_phantom_inboxes
  _row_has yellow "worker1 inbox.inProgress contains phantom t-phantom-x"
}

@test "doctor_audit: clean tree (no phantoms) ⇒ no phantom-inbox finding" {
  _load_doctor
  local now; now=$(date +%s)
  cat > .atmux/kanban.json <<EOF
{"tasks":[{"id":"t-real","status":"done","createdAt":$now}],"epics":[],"stories":[]}
EOF
  cat > .atmux/inboxes/worker1.json <<EOF
{"pending":[],"inProgress":[{"id":"t-real","claimedAt":$now}],"done":[]}
EOF

  _doctor_check_phantom_inboxes
  ! _row_has yellow "phantom"
}

# ---------- AC test 4: --fix prunes; second --fix is no-op ----------

@test "doctor_audit: 'atmux doctor --fix' prunes phantom inbox entry" {
  _seed_phantom_fixture
  # Sanity: phantom present BEFORE fix.
  [ "$(jq -r '[.inProgress[].id] | sort | join(",")' .atmux/inboxes/worker1.json)" = "t-phantom-x,t-real" ]

  # --fix runs the phantom pruner end-to-end.
  run "$ATMUX_BIN" doctor --fix </dev/null
  # doctor exits 0 when no red findings remain — phantoms are yellow, so
  # exit code can be 0 OR 1 depending on whether other yellows promote
  # to red on this sandbox. Assert state, not exit.
  [ "$(jq -r '[.inProgress[].id] | sort | join(",")' .atmux/inboxes/worker1.json)" = "t-real" ]
}

@test "doctor_audit: 'atmux doctor --fix' on already-clean tree is a no-op (idempotent)" {
  _seed_phantom_fixture
  "$ATMUX_BIN" doctor --fix </dev/null >/dev/null 2>&1 || true
  # First fix landed.
  [ "$(jq -r '[.inProgress[].id] | sort | join(",")' .atmux/inboxes/worker1.json)" = "t-real" ]

  # Snapshot inbox + run --fix again.
  local before; before=$(jq -cS . .atmux/inboxes/worker1.json)
  "$ATMUX_BIN" doctor --fix </dev/null >/dev/null 2>&1 || true
  local after; after=$(jq -cS . .atmux/inboxes/worker1.json)
  [ "$before" = "$after" ]
}

# ---------- e2e via 'atmux doctor --json' ----------

@test "doctor_audit (e2e): --json output includes phantom-inbox check entry" {
  _seed_phantom_fixture
  run "$ATMUX_BIN" doctor --json </dev/null
  # The JSON output is parseable + contains a phantom-inbox check entry.
  # Doctor reports red>=1 for missing tmux session (sandbox), so don't
  # gate on exit code.
  local out_json="$output"
  jq -e '.checks[] | select(.label == "phantom-inbox")' <<<"$out_json" >/dev/null
  jq -e '.checks[] | select(.label == "phantom-inbox" and (.detail | test("worker1.*t-phantom-x")))' \
    <<<"$out_json" >/dev/null
  # yellow count >= 1 (phantom-inbox finding).
  [ "$(jq -r '.yellow' <<<"$out_json")" -ge 1 ]
}

# ---------- E6/Sc: cron-orphan detector (paired with cron_install.bats) ----------
# _doctor_check_cron_orphans (lib/doctor.sh:392) calls atmux::cron_orphans
# which shells out to `crontab -l`. We sandbox that with a PATH-prepended
# crontab shim that read/writes $ATMUX_TEST_CRONTAB instead of touching the
# runner's actual crond. The shim mirrors the one in cron_install.bats —
# kept colocated rather than cross-loaded so each file is grep-self-evident.

_install_crontab_mock() {
  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  export ATMUX_TEST_CRONTAB="$ATMUX_TEST_TMP/crontab.txt"
  cat > "$ATMUX_MOCK_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
sf="${ATMUX_TEST_CRONTAB:?}"
case "$1" in
  -l) [[ -f "$sf" ]] && { cat "$sf"; exit 0; } || exit 1 ;;
  -r) rm -f "$sf"; exit 0 ;;
  *)  [[ -f "$1" ]] && { cp "$1" "$sf"; exit 0; } || exit 2 ;;
esac
EOF
  chmod +x "$ATMUX_MOCK_BIN/crontab"
}

@test "doctor_audit: cron-orphan block (ATMUX_DIR missing on disk) ⇒ yellow finding cites team + dir" {
  _install_crontab_mock
  _load_doctor

  # Seed crontab with a marker block whose ATMUX_DIR points at a path that
  # doesn't exist (simulates `rm -rf <worktree>` without `atmux stop`).
  local dead_dir="$ATMUX_TEST_TMP/dead-team/.atmux"
  printf '# >>> atmux:team=ghost — managed by atmux start; do not edit by hand\n*/5 * * * * ATMUX_DIR=%s atmux whip\n# <<< atmux:team=ghost\n' "$dead_dir" \
    > "$ATMUX_TEST_CRONTAB"
  [[ ! -d "$dead_dir" ]]

  PATH="$ATMUX_MOCK_BIN:$PATH" _doctor_check_cron_orphans
  _row_has yellow "ghost"
  _row_has yellow "$dead_dir"
}

@test "doctor_audit: cron-orphan check silent when ATMUX_DIR resolves on disk" {
  _install_crontab_mock
  _load_doctor

  # Live block: ATMUX_DIR points at a real directory.
  local live_dir="$ATMUX_TEST_TMP/live-team"
  mkdir -p "$live_dir"
  printf '# >>> atmux:team=live — managed by atmux start; do not edit by hand\n*/5 * * * * ATMUX_DIR=%s atmux whip\n# <<< atmux:team=live\n' "$live_dir" \
    > "$ATMUX_TEST_CRONTAB"

  PATH="$ATMUX_MOCK_BIN:$PATH" _doctor_check_cron_orphans
  ! _row_has yellow "cron-orphan"
  ! _row_has yellow "live"
}

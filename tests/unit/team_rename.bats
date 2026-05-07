#!/usr/bin/env bats
# Unit tests for `atmux team rename` — atomic team-rename orchestrator + rollback
# engine (E10/Se t-961c2558, ADR-027).
#
# Coverage table (see Task t-c8d8fe80 AC):
#   AC1 happy path                 — full rename; team.json + windows + state +
#                                    cron + registry + lock all updated.
#   AC2 refuse-gate: in-progress   — die without --force; succeed with.
#   AC3 refuse-gate: collision     — die; --force does NOT override.
#   AC4 refuse-gate: invalid name  — die; --force does NOT override.
#   AC5 cron migration order       — install(new) PRECEDES remove(old).
#   AC6 rollback                   — step6 registry_upsert fails → team.json
#                                    restored, lock cleared.
#   AC7 lock-file lifecycle        — post-success no lock; whip honors mid-
#                                    rename lock per SE_T2 guard.
#   AC8 --migrate-session          — single-session team's session.txt rewrites.
#   AC9 createdAt preservation     — old createdAt carried forward to new
#                                    registry entry (NOT now()).
#
# Mocks: crontab via PATH-shim (cron_install.bats pattern). tmux runs on the
# sandbox's TMUX_TMPDIR socket — no shim needed for window/session ops, since
# we exercise real rename-window / rename-session against fixture sessions.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  atmux_assert_sandbox

  "$ATMUX_BIN" init --name old >/dev/null
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  export ATMUX_TEST_CRONTAB="$ATMUX_TEST_TMP/crontab.txt"
  export ATMUX_TEST_CRONLOG="$ATMUX_TEST_TMP/crontab-calls.log"

  # crontab shim — records every invocation (verb + args + body-fingerprint)
  # to ATMUX_TEST_CRONLOG so AC5 can assert install-then-remove order.
  cat > "$ATMUX_MOCK_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
sf="${ATMUX_TEST_CRONTAB:?ATMUX_TEST_CRONTAB unset}"
log="${ATMUX_TEST_CRONLOG:-/dev/null}"
case "$1" in
  -l)
    if [[ -f "$sf" ]]; then cat "$sf"; rc=0
    else echo "no crontab for $USER" >&2; rc=1; fi
    printf '%s\n' "list" >> "$log"
    exit "$rc" ;;
  -r)
    rm -f "$sf"
    printf '%s\n' "remove-all" >> "$log"
    exit 0 ;;
  -*)
    echo "mock-crontab: unsupported flag: $1" >&2; exit 2 ;;
  *)
    if [[ -f "$1" ]]; then
      cp "$1" "$sf"
      # Record fingerprint — every distinct atmux:team=<name> header in the
      # written body counts as one "block present after this write".
      teams="$(grep -oE '^# >>> atmux:team=[^ ]+' "$1" | awk -F= '{print $2}' | sort -u | tr '\n' ',')"
      printf 'write %s\n' "${teams%,}" >> "$log"
      exit 0
    else
      echo "mock-crontab: file not found: $1" >&2; exit 2
    fi ;;
esac
EOF
  chmod +x "$ATMUX_MOCK_BIN/crontab"

  # Tests that exercise the cron path must unset ATMUX_NO_CRON (default-on
  # in the sandbox to keep other suites from touching the host crontab).
  unset ATMUX_NO_CRON
  export PATH="$ATMUX_MOCK_BIN:$PATH"
}

teardown() {
  atmux_teardown_sandbox
}

# Helper: source registry + cron helpers + common (so we can call atmux::*
# directly from inside @test bodies, e.g. for direct-API fixtures).
_load_libs() {
  atmux_source_libs
  # shellcheck source=../../lib/registry.sh
  . "$ATMUX_LIB_DIR/registry.sh"
  # shellcheck source=../../lib/cron.sh
  . "$ATMUX_LIB_DIR/cron.sh"
}

# Helper: spawn a tmux session with N __old__<member> windows on the sandbox
# socket. Returns the session name on stdout. Caller is responsible for
# wiring the session into team.json / state/session.txt before calling
# `atmux team rename`.
_seed_team_tmux_session() {
  local session="$1"; shift
  tmux new-session -d -s "$session" -n "__old__home" 3>&- 4>&-
  local member
  for member in "$@"; do
    tmux new-window -t "$session" -n "__old__${member}" 3>&- 4>&-
  done
}

# Helper: list tmux window names in <session> (sorted, newline-list).
_tmux_window_names() {
  tmux list-windows -t "$1" -F '#{window_name}' 2>/dev/null | sort
}

# Helper: parse the cron call log into ordered per-write team-set entries.
# Each `write` line lists comma-joined teams present in that crontab snapshot.
# AC5 uses this to assert install(new) PRECEDES remove(old).
_cron_writes() {
  grep '^write ' "$ATMUX_TEST_CRONLOG" 2>/dev/null | sed 's/^write //'
}

# ---------- AC1: happy path ----------

@test "team-rename: happy path — team.json + tmux + state + cron + registry + lock all updated" {
  # Multi-session setup (singleSession=false) so step3a tmux rename-session
  # also fires. AC8 covers the singleSession branch separately.
  jq '.singleSession = false | .members = [{"name":"alpha","role":"member"},{"name":"beta","role":"member"}]' \
    .atmux/team.json > .atmux/team.json.tmp && mv .atmux/team.json.tmp .atmux/team.json

  _seed_team_tmux_session "atmux-old" alpha beta
  # Pre-seed cron block so step5 has an old to remove (otherwise install-only).
  _load_libs
  atmux::cron_install "old" "$ATMUX_DIR" >/dev/null
  # Pre-seed registry entry for old via direct API (ADR-029 caller-scope
  # bypass — we're inside the test process, not a member pane).
  ATMUX_REGISTRY="$ATMUX_REGISTRY" atmux::registry_upsert "old" "$PWD" "atmux-old" >/dev/null

  run "$ATMUX_BIN" team rename old new --session "atmux-new"
  [ "$status" -eq 0 ]

  # team.json:.name flipped.
  [ "$(jq -r '.name' .atmux/team.json)" = "new" ]
  # Backup of pre-rename team.json captured.
  ls .atmux/team.json.bak.* >/dev/null 2>&1

  # tmux windows renamed: __old__home + __old__alpha + __old__beta →
  # __new__home / __new__alpha / __new__beta.
  local names; names="$(_tmux_window_names "atmux-new")"
  [[ "$names" == *"__new__home"* ]]
  [[ "$names" == *"__new__alpha"* ]]
  [[ "$names" == *"__new__beta"* ]]
  [[ "$names" != *"__old__"* ]]

  # tmux session renamed.
  tmux has-session -t "atmux-new" 2>/dev/null
  ! tmux has-session -t "atmux-old" 2>/dev/null

  # Cron block replaced — only `# >>> atmux:team=new` should remain.
  grep -q '^# >>> atmux:team=new' "$ATMUX_TEST_CRONTAB"
  ! grep -q '^# >>> atmux:team=old' "$ATMUX_TEST_CRONTAB"

  # Registry: old=stopped, new=running.
  [ "$(jq -r '.[] | select(.name=="old") | .status' "$ATMUX_REGISTRY")" = "stopped" ]
  [ "$(jq -r '.[] | select(.name=="new") | .status' "$ATMUX_REGISTRY")" = "running" ]

  # Lock removed.
  [ ! -f .atmux/state/rename.lock ]
}

# ---------- AC2: refuse-gate (in-progress Task) ----------

@test "team-rename: in-progress Task ⇒ die without --force; succeed with --force" {
  # Inject an in-progress Task into kanban.
  jq '.tasks = [{"id":"t-x","status":"in-progress","subject":"wip"}]' \
    .atmux/kanban.json > .atmux/kanban.json.tmp && mv .atmux/kanban.json.tmp .atmux/kanban.json

  run "$ATMUX_BIN" team rename old new
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "in-progress Task"
  # team.json untouched.
  [ "$(jq -r '.name' .atmux/team.json)" = "old" ]
  # No backup created when the gate fired pre-step2.
  ! ls .atmux/team.json.bak.* >/dev/null 2>&1

  # --force overrides — completes (no tmux session pre-seeded; that path
  # is best-effort per impl line 127-135 and can no-op without erroring).
  run "$ATMUX_BIN" team rename old new --force
  [ "$status" -eq 0 ]
  [ "$(jq -r '.name' .atmux/team.json)" = "new" ]
}

# ---------- AC3: refuse-gate (collision) ----------

@test "team-rename: <new> already in registry ⇒ die; --force does NOT override" {
  _load_libs
  atmux::registry_upsert "new" "/some/other/proj" "atmux-other" >/dev/null

  run "$ATMUX_BIN" team rename old new
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "already in registry"
  [ "$(jq -r '.name' .atmux/team.json)" = "old" ]

  # NEVER overrideable (per ADR-027 §Pre-flight refuse-gates).
  run "$ATMUX_BIN" team rename old new --force
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "already in registry"
  [ "$(jq -r '.name' .atmux/team.json)" = "old" ]
}

# ---------- AC4: refuse-gate (invalid name shape) ----------

@test "team-rename: invalid <new> name ⇒ die; --force does NOT override" {
  # Uppercase rejected.
  run "$ATMUX_BIN" team rename old "NewTeam"
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "invalid"
  [ "$(jq -r '.name' .atmux/team.json)" = "old" ]

  # Whitespace rejected.
  run "$ATMUX_BIN" team rename old "foo bar"
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "invalid"

  # Bang rejected.
  run "$ATMUX_BIN" team rename old "new!"
  [ "$status" -ne 0 ]

  # --force can't bypass shape gate.
  run "$ATMUX_BIN" team rename old "BadName" --force
  [ "$status" -ne 0 ]
  echo "$output" | grep -q "invalid"
  [ "$(jq -r '.name' .atmux/team.json)" = "old" ]

  # Lowercase + digits + dash + underscore allowed (sanity-check the regex
  # admits the canonical shape — runs through to step2 cleanly).
  run "$ATMUX_BIN" team rename old "team_2-x"
  [ "$status" -eq 0 ]
  [ "$(jq -r '.name' .atmux/team.json)" = "team_2-x" ]
}

# ---------- AC5: cron migration order — install(new) PRECEDES remove(old) ----------

@test "team-rename: cron install(new) precedes remove(old) — no zero-cron window" {
  _load_libs
  atmux::cron_install "old" "$ATMUX_DIR" >/dev/null
  # Reset call log so we only observe the rename's writes.
  : > "$ATMUX_TEST_CRONLOG"

  run "$ATMUX_BIN" team rename old new
  [ "$status" -eq 0 ]

  # Read writes in temporal order. Constraints:
  #   - First write contains BOTH old AND new (install-new appended).
  #   - Last write contains ONLY new (remove-old).
  # Together these prove install precedes remove — there is no
  # intermediate snapshot lacking 'new'.
  local writes; writes="$(_cron_writes)"
  [ -n "$writes" ]
  local first; first="$(printf '%s\n' "$writes" | head -1)"
  local last;  last="$( printf '%s\n' "$writes" | tail -1)"
  [[ "$first" == *"new"* ]]
  [[ "$first" == *"old"* ]]
  [ "$last" = "new" ]

  # Negative-space proof: NO write ever contained zero atmux:team blocks
  # for THIS team (i.e. no snapshot where both old and new were absent).
  ! printf '%s\n' "$writes" | grep -qxE '|^$'
}

# ---------- AC6: rollback — step5 cron_install fails → team.json restored ----------

@test "team-rename: cron install fails ⇒ rollback restores team.json + clears lock" {
  _load_libs
  atmux::registry_upsert "old" "$PWD" "atmux-old" >/dev/null
  atmux::cron_install "old" "$ATMUX_DIR" >/dev/null

  # Sabotage step5 by swapping the crontab shim to one that fails on
  # writes. `crontab -l` still works (so cron_install reads the existing
  # crontab fine), but the subsequent `crontab <newfile>` errors out →
  # cron_install returns non-zero → orchestrator rolls back.
  cat > "$ATMUX_MOCK_BIN/crontab" <<'EOF'
#!/usr/bin/env bash
sf="${ATMUX_TEST_CRONTAB:?ATMUX_TEST_CRONTAB unset}"
case "$1" in
  -l)
    [[ -f "$sf" ]] && cat "$sf" && exit 0
    exit 1 ;;
  -*) echo "mock-crontab(fail): unsupported flag: $1" >&2; exit 2 ;;
  *)  echo "mock-crontab(fail): writes disabled for AC6"  >&2; exit 1 ;;
esac
EOF

  run "$ATMUX_BIN" team rename old new
  [ "$status" -ne 0 ]

  # Rollback evidence — team.json restored, lock removed, rollback log
  # carries BEGIN+END markers.
  [ "$(jq -r '.name' .atmux/team.json)" = "old" ]
  [ ! -f .atmux/state/rename.lock ]
  [ -f .atmux/state/rename-rollback.log ]
  grep -q "rollback: BEGIN" .atmux/state/rename-rollback.log
  grep -q "rollback: END"   .atmux/state/rename-rollback.log
}

# ---------- AC7: lock-file lifecycle + cron-consumer guard ----------

@test "team-rename: post-success no lock; whip honors mid-rename lock per SE_T2 guard" {
  # 7a — lock file absent after a successful rename.
  run "$ATMUX_BIN" team rename old new
  [ "$status" -eq 0 ]
  [ ! -f .atmux/state/rename.lock ]

  # 7b — a manually-placed lock file makes whip silently no-op (per
  # lib/whip.sh main() guard added in t-67186026). Tests SE_T2 directly.
  : > .atmux/state/rename.lock
  # Need a tmux session for whip; multi-session here per t-c5297af1's
  # baseline. atmux::session_name resolves via state/session.txt under
  # singleSession; we set it to the rename's new session.
  echo "atmux-new" > .atmux/state/session.txt
  jq '.singleSession = true' .atmux/team.json > .atmux/team.json.tmp \
    && mv .atmux/team.json.tmp .atmux/team.json

  run "$ATMUX_BIN" whip
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "rename in progress"
}

# ---------- AC8: --migrate-session — legacy dedicated → driver consolidation ----------

@test "team-rename: --migrate-session moves windows from atmux-old INTO driver's 'atmux' session" {
  # Per Task t-c8d8fe80 AC8 + E10/Se BE landing (t-130ab37a): rename
  # invokes migrate-to-driver-session pre-team.json-edit when
  # --migrate-session is set. Migrate moves windows from the legacy
  # dedicated session into the driver session; then step 3b renames
  # __old__* → __new__*.

  # Driver session 'atmux' is the migration TARGET; legacy dedicated
  # 'atmux-old' carries the team's panes today. Seed driver FIRST so
  # migrate's $TMUX precondition + display-message can resolve to it.
  tmux new-session -d -s "atmux"     -n "shell"      3>&- 4>&-
  _seed_team_tmux_session "atmux-old" alpha

  # Construct $TMUX env mimicking migrate_to_driver_session.bats: the
  # migrate verb requires $TMUX set + display-message resolves to the
  # driver's session via TMUX_PANE.
  local sock pid sid pane
  sock="$(tmux display-message -p '#{socket_path}')"
  pid="$(tmux display-message -p '#{pid}')"
  sid="$(tmux display-message -p -t atmux '#{session_id}' | tr -d '$')"
  pane="$(tmux display-message -p -t atmux:shell '#{pane_id}')"
  export TMUX="$sock,$pid,$sid"
  export TMUX_PANE="$pane"

  run "$ATMUX_BIN" team rename old new --session atmux --migrate-session
  [ "$status" -eq 0 ]

  # Windows moved into 'atmux', renamed __old__* → __new__*. Source
  # session 'atmux-old' is killed by migrate's cleanup gate.
  local names; names="$(_tmux_window_names "atmux")"
  [[ "$names" == *"__new__alpha"* ]]
  ! tmux has-session -t "=atmux-old" 2>/dev/null
}

# ---------- AC8b: singleSession step3b session-arg hygiene (f-d79872d3) ----------

@test "team-rename: singleSession=true ⇒ step3b targets driver session (old_session), windows renamed in place" {
  # Per t-12cf5835 / f-d79872d3: orchestrator no longer threads
  # new_session into step3b unconditionally. In singleSession mode
  # without --migrate-session, no session is renamed, so new_session
  # would be a non-existent name — step3b targets old_session (the
  # driver session, where the team's windows actually live) instead.
  # Window prefix __old__* → __new__* still happens so post-rename
  # atmux::window_name lookups continue to resolve.

  # Driver session pre-seeded with team windows. State/session.txt pins
  # the rename's atmux::session_name resolution to the driver session.
  local driver_session="atmux-driver-$$"
  _seed_team_tmux_session "$driver_session" alpha
  echo "$driver_session" > .atmux/state/session.txt

  jq '.singleSession = true | .members = [{"name":"alpha","role":"member"}]' \
    .atmux/team.json > .atmux/team.json.tmp && mv .atmux/team.json.tmp .atmux/team.json

  _load_libs
  ATMUX_REGISTRY="$ATMUX_REGISTRY" atmux::registry_upsert "old" "$PWD" "$driver_session" >/dev/null

  run "$ATMUX_BIN" team rename old new
  [ "$status" -eq 0 ]

  # team.json renamed, registry rolled forward.
  [ "$(jq -r '.name' .atmux/team.json)" = "new" ]
  [ "$(jq -r '.[] | select(.name=="new") | .status' "$ATMUX_REGISTRY")" = "running" ]

  # Windows in the driver session got renamed __old__* → __new__*.
  # Pinning this confirms step3b operates on old_session (the live
  # session), not the misleading new_session that would have been a
  # non-existent name in singleSession mode.
  local names; names="$(_tmux_window_names "$driver_session")"
  [[ "$names" == *"__new__alpha"* ]]
  [[ "$names" != *"__old__alpha"* ]]

  # Rollback log records the actual session targeted — pinning the
  # log line surfaces future regressions in the param-hygiene logic.
  grep -q "step3b: tmux rename-window in '$driver_session'" .atmux/state/rename-rollback.log
}

# ---------- AC9: registry createdAt preservation across rename ----------

@test "team-rename: old registry entry's createdAt carries to new entry (NOT now())" {
  _load_libs
  # Hand-craft an old entry with a deterministic past createdAt so we can
  # assert preservation. registry_upsert seeds createdAt=now; we rewrite
  # it via direct jq.
  atmux::registry_upsert "old" "$PWD" "atmux-old" >/dev/null
  jq '(.[] | select(.name=="old")).createdAt = 1000' "$ATMUX_REGISTRY" \
    > "$ATMUX_REGISTRY.tmp" && mv "$ATMUX_REGISTRY.tmp" "$ATMUX_REGISTRY"
  [ "$(jq -r '.[] | select(.name=="old") | .createdAt' "$ATMUX_REGISTRY")" = "1000" ]

  run "$ATMUX_BIN" team rename old new
  [ "$status" -eq 0 ]

  # E10/Se landed createdAt preservation: orchestrator step6 reads old's
  # createdAt before deregister, threads it through registry_upsert via
  # the new --created-at flag, lib/registry.sh applies it to the freshly
  # appended new-name entry. lastSeenAt should still be fresh (rename IS
  # an event).
  local created; created="$(jq -r '.[] | select(.name=="new") | .createdAt' "$ATMUX_REGISTRY")"
  [ "$created" = "1000" ]
  local last_seen; last_seen="$(jq -r '.[] | select(.name=="new") | .lastSeen' "$ATMUX_REGISTRY")"
  [ "$last_seen" -gt 1000 ]
}

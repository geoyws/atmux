#!/usr/bin/env bats
# Unit tests for `atmux doctor` logout-kill exposure detection — E8/Sa
# t-89dfd787 (paired with SA_T1 — _doctor_check_logout_kill at
# lib/doctor.sh:401-454, _doctor_try_fix_logout_kill at :760-782).
#
# Per ADR-017: systemd's stock `KillUserProcesses=yes` (default on
# systemd ≥230) reaps the user cgroup on logout, killing tmux + every
# atmux team. `loginctl enable-linger` is the documented escape hatch.
# The doctor surfaces a severity-graded row (green / yellow tty / red
# ssh) so the operator can `--fix` before starting a team.
#
# Mocking strategy
# ----------------
# `loginctl` is the only system probe we intercept. setup() prepends
# $ATMUX_TEST_TMP/mock-bin to PATH with a `loginctl` shim driven by env
# vars (MOCK_LINGER, MOCK_SESSION_TYPE, MOCK_SESSION_REMOTE,
# MOCK_FIX_RESULT). Tests set those vars + invoke `atmux doctor`.
#
# `/etc/systemd/logind.conf` is NOT mockable — the doctor reads the
# literal hardcoded path. The `KillUserProcesses=no` matrix cell is
# therefore skip-documented (would need lib/doctor.sh to honor an env
# override of the logind.conf path; that's BE scope, not TEST scope).
# On the test host the file may or may not exist; the doctor's default
# of `kup="yes"` makes the test outputs deterministic for the four
# matrix cells we DO exercise.

load '../helpers/setup'

setup() {
  atmux_setup_sandbox

  # Minimal team.json so doctor's other checks pass and we can isolate
  # the logout-kill row in output assertions.
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  cat > .atmux/team.json <<JSON
{
  "name": "lk",
  "members": [
    {"name": "w1", "role": "member", "tui": "shell", "model": "default", "cwd": "$PWD"}
  ]
}
JSON
  echo '{"tasks":[]}' > .atmux/kanban.json
  : > .atmux/driver-inbox.md

  ATMUX_MOCK_BIN="$ATMUX_TEST_TMP/mock-bin"
  mkdir -p "$ATMUX_MOCK_BIN"
  cat > "$ATMUX_MOCK_BIN/loginctl" <<'EOF'
#!/usr/bin/env bash
# Mock loginctl — env-driven responses for doctor logout-kill checks.
#   show-user <user> --property=Linger      → echoes "Linger=$MOCK_LINGER"
#   show-session <id> --property=Type       → echoes "Type=$MOCK_SESSION_TYPE"
#   show-session <id> --property=Remote     → echoes "Remote=$MOCK_SESSION_REMOTE"
#   enable-linger <user>                    → exit 0 (success) / exit 1 (EPERM)
#                                              gated by $MOCK_FIX_RESULT
case "$1" in
  show-user)
    # args: show-user <user> --property=<key>
    case "$3" in
      --property=Linger) echo "Linger=${MOCK_LINGER:-no}" ;;
    esac
    exit 0
    ;;
  show-session)
    # args: show-session <id> --property=<key>
    case "$3" in
      --property=Type)   echo "Type=${MOCK_SESSION_TYPE:-tty}" ;;
      --property=Remote) echo "Remote=${MOCK_SESSION_REMOTE:-no}" ;;
    esac
    exit 0
    ;;
  enable-linger)
    if [[ "${MOCK_FIX_RESULT:-success}" == "success" ]]; then
      exit 0
    else
      exit 1
    fi
    ;;
esac
exit 0
EOF
  chmod +x "$ATMUX_MOCK_BIN/loginctl"

  # Force the show-session probe path: the doctor only calls
  # show-session when XDG_SESSION_ID is set. Pin to a literal so the
  # mock-loginctl always sees a non-empty session id arg.
  export XDG_SESSION_ID=42
  # Default — tests that need SSH-shape override per-test.
  unset SSH_CONNECTION
}

teardown() {
  atmux_teardown_sandbox
}

# Convenience: run atmux doctor with the mock loginctl on PATH.
_doctor_with_mock() {
  PATH="$ATMUX_MOCK_BIN:$PATH" "$ATMUX_BIN" doctor "$@"
}

# ---------- AC matrix cells 1-4 ----------

@test "doctor logout-kill: Linger=yes ⇒ green row, no warning" {
  atmux_assert_sandbox
  MOCK_LINGER=yes run _doctor_with_mock
  [ "$status" -eq 0 ]
  [[ "$output" =~ "logout-kill" ]]
  # Green narrative — survives logout.
  [[ "$output" =~ "linger enabled" ]] || [[ "$output" =~ "survives logout" ]]
  # No red/ssh-incident-shape language on a Linger=yes host.
  ! [[ "$output" =~ "tmux server dies on disconnect" ]]
}

@test "doctor logout-kill: Linger=no + Type=tty (no SSH) ⇒ yellow row, hint present" {
  atmux_assert_sandbox
  MOCK_LINGER=no MOCK_SESSION_TYPE=tty MOCK_SESSION_REMOTE=no \
    run _doctor_with_mock
  # Yellow doesn't fail the doctor exit code — only red does.
  [[ "$output" =~ "logout-kill" ]]
  [[ "$output" =~ "local-tty" ]] || [[ "$output" =~ "tmux server dies on logout" ]]
  # Hint must steer the operator to the fix command.
  [[ "$output" =~ "atmux doctor --fix" ]] || [[ "$output" =~ "loginctl enable-linger" ]]
}

@test "doctor logout-kill: Linger=no + Type=ssh ⇒ red row, doctor exits non-zero" {
  atmux_assert_sandbox
  MOCK_LINGER=no MOCK_SESSION_TYPE=ssh MOCK_SESSION_REMOTE=yes \
    run _doctor_with_mock
  # Red counts toward _doctor_red_count → main returns non-zero.
  [ "$status" -eq 1 ]
  [[ "$output" =~ "logout-kill" ]]
  [[ "$output" =~ "ssh session" ]] || [[ "$output" =~ "tmux server dies on disconnect" ]]
  [[ "$output" =~ "atmux doctor --fix" ]] || [[ "$output" =~ "loginctl enable-linger" ]]
}

@test "doctor logout-kill: Linger=no + SSH_CONNECTION set ⇒ red row (env-fallback path)" {
  # Covers the lib/doctor.sh:440 fallback: `[[ -n "$SSH_CONNECTION" ]]`
  # forces is_ssh=yes even when the loginctl probe says Type=tty
  # (e.g. nohup'd shell where loginctl doesn't see the SSH session).
  atmux_assert_sandbox
  export SSH_CONNECTION="10.0.0.1 22 10.0.0.2 22"
  MOCK_LINGER=no MOCK_SESSION_TYPE=tty MOCK_SESSION_REMOTE=no \
    run _doctor_with_mock
  [ "$status" -eq 1 ]
  [[ "$output" =~ "ssh session" ]] || [[ "$output" =~ "tmux server dies on disconnect" ]]
}

@test "doctor logout-kill: Linger=no + KillUserProcesses=no — SKIPPED (logind.conf path not mockable)" {
  # The check at lib/doctor.sh:418 reads `/etc/systemd/logind.conf`
  # literally. Mocking that path would require a small BE refactor
  # (e.g. ${ATMUX_LOGIND_CONF:-/etc/systemd/logind.conf}) which is
  # out-of-scope for this TEST-lane Task. When the BE adds the env
  # override, replace the skip with a real assertion: green row, narrative
  # 'KillUserProcesses=no — tmux survives logout'.
  skip "KillUserProcesses override needs lib/doctor.sh refactor — out-of-scope for TEST lane"
}

# ---------- additional case: loginctl missing ⇒ silent skip ----------

@test "doctor logout-kill: loginctl missing on PATH ⇒ silent skip (no row, no warning)" {
  atmux_assert_sandbox
  # Run doctor with the mock-bin REMOVED from PATH and a stripped PATH
  # that contains only system bins WITHOUT loginctl. The simplest path:
  # mask loginctl by setting PATH to a directory that lacks it.
  # /usr/bin and /bin on most CI hosts DO have loginctl on systemd; we
  # work around by interposing a /tmp dir that has nothing.
  local empty_path="$ATMUX_TEST_TMP/empty-bin"
  mkdir -p "$empty_path"
  # Symlink only the binaries doctor needs (jq, tmux, sed, grep, awk,
  # cat, mktemp, sleep, date, id, find, sha256sum, tr, cut, ls). Skip
  # loginctl. tmux is needed for orphan-session check; jq is core.
  for bin in bash sh jq tmux sed grep awk cat mktemp sleep date id \
             find sha256sum tr cut ls dirname basename printf wc head \
             tail uname stat readlink command rm cp mv chmod ln env; do
    src="$(command -v "$bin" 2>/dev/null)"
    [[ -n "$src" ]] && ln -sf "$src" "$empty_path/$bin"
  done

  PATH="$empty_path" run "$ATMUX_BIN" doctor
  # The check returns 0 silently when loginctl isn't found — no row
  # emitted. Other checks still run; doctor as a whole may go green.
  ! [[ "$output" =~ "logout-kill" ]]
}

# ---------- --fix path ----------

@test "doctor --fix logout-kill: enable-linger succeeds ⇒ ok-banner printed" {
  atmux_assert_sandbox
  # Pre-state: not lingering. --fix calls enable-linger; mock returns 0.
  MOCK_LINGER=no MOCK_FIX_RESULT=success \
    run _doctor_with_mock --fix
  # The fix banner is on stderr but bats merges stderr into $output.
  [[ "$output" =~ "enabling linger" ]] || [[ "$output" =~ "linger enabled" ]]
  # Should NOT print the EPERM-fallback sudo hint when the fix succeeded.
  ! [[ "$output" =~ "sudo loginctl enable-linger" && "$output" =~ "refused" ]]
}

@test "doctor --fix logout-kill: enable-linger fails (EPERM) ⇒ sudo hint printed" {
  atmux_assert_sandbox
  MOCK_LINGER=no MOCK_FIX_RESULT=fail \
    run _doctor_with_mock --fix
  [[ "$output" =~ "refused" ]] || [[ "$output" =~ "EPERM" ]]
  [[ "$output" =~ "sudo loginctl enable-linger" ]]
}

@test "doctor --fix logout-kill: already lingering ⇒ idempotent no-op" {
  atmux_assert_sandbox
  MOCK_LINGER=yes \
    run _doctor_with_mock --fix
  # No 'enabling linger' banner (the fix function returns 0 immediately
  # when Linger=yes is already set).
  ! [[ "$output" =~ "enabling linger" ]]
  # No EPERM/sudo hint either.
  ! [[ "$output" =~ "sudo loginctl enable-linger" && "$output" =~ "refused" ]]
}

#!/usr/bin/env bats
# EPIC e-f28c2596 T6 — bats integration test for the queued-text resubmit
# wiring landed in T2 (poke.ts, commit 0d69bf3) + T3 (lane-tick.ts, commit
# 23a33b1). End-to-end against real tmux + a lightweight shell-pane shim
# that mimics a stuck compose-box.
#
# Coverage matrix:
#   1. Happy path  — stuck composer + `claim` shim that clears on Enter →
#                    `atmux poke` fires resubmit → verifier observes the
#                    composer-clear transition → send-keys-failures.log
#                    stays absent (no escalation).
#   2. Sad path    — stuck composer + NO clearing shim (raw shell) →
#                    `atmux poke` fires resubmit → shell errors on `claim`,
#                    composer never clears → verifier exhausts retries →
#                    send-keys-failures.log gets an ADR-168 escalation row.
#
# Both tests use the sandbox helper (isolated TMUX_TMPDIR) per
# tests/helpers/setup.bash so they cannot collide with the operator's
# default tmux server. `tui: "shell"` in team.json bypasses the
# `expectedTuiCmd` gate at src/verbs/poke.ts (only "claude" / "opencode" /
# "kimi" / "cursor" enforce pane_current_command equality; "shell" returns
# null → checkMember proceeds past the TUI verification).
#
# Cross-refs: T1 (c24ee2b — helper), T2 (0d69bf3 — poke wiring),
# T3 (23a33b1 — lane-tick wiring), T5 (0505bb4 — helper unit tests),
# ADR-138 (safeSendKeysWithVerify + composerEmpty verifier),
# ADR-168 (send-keys-failures.log rotation policy).

load '../helpers/setup'

setup() {
  atmux_setup_sandbox
  mkdir -p .atmux/inboxes .atmux/logs .atmux/state
  # Two-member team — `lead` (team-lead role; required for the per-member
  # iteration to skip a lead-uptime check that would otherwise refuse a
  # never-set lead-session-start marker), `worker` (the BE-lane member
  # we'll drive the queued-text fixture against).
  cat > .atmux/team.json <<JSON
{
  "name": "qtr",
  "members": [
    {"name": "lead",   "role": "team-lead", "lane": "misc", "tui": "shell", "cwd": "$PWD"},
    {"name": "worker", "role": "member",    "lane": "be",   "tui": "shell", "cwd": "$PWD"}
  ],
  "whip": {"intervalMins": 5, "staleMin": 30, "leadMaxMin": 60, "downConfirmTicks": 1}
}
JSON
  echo '{"tasks":[],"epics":[],"stories":[]}' > .atmux/kanban.json
  for m in lead worker; do
    echo '{"pending":[],"inProgress":[],"done":[]}' > ".atmux/inboxes/$m.json"
  done
  : > .atmux/driver-inbox.md
  export ATMUX_SESSION="atmux-test-qtr-$$-$RANDOM"
  # send-keys-failures.log defaults to $HOME/.atmux/state/send-keys-failures.log
  # (per ADR-138 §Escalation log). Sandbox $HOME so escalation writes land
  # in our tmpdir rather than ~/$USER/.atmux/state — the latter would
  # pollute the operator's real log + race against unrelated atmux work.
  export HOME="$ATMUX_TEST_TMP"
  export SEND_KEYS_FAILURES_LOG="$HOME/.atmux/state/send-keys-failures.log"
}

teardown() {
  "$ATMUX_BIN" stop --force >/dev/null 2>&1 || true
  atmux_teardown_sandbox
}

# ---------- helpers ----------

# Spin up the team's tmux session (skips doctor probes per the sandbox's
# ATMUX_NO_DOCTOR / ATMUX_NO_CRON gates). Polls until the worker window
# appears in the session listing (5 × 200ms = 1s ceiling — `atmux start`'s
# brief paste + pane spawn is well under this on hax).
_start_session() {
  ATMUX_NO_DOCTOR=1 "$ATMUX_BIN" start --no-doctor >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
      | grep -q "worker" && return 0
    sleep 0.2
  done
  return 1
}

# Resolve the actual worker window name — atmux's window-naming convention
# may emit `<emoji>-worker` per ADR-135 D3 / ADR-136 TR4 (or `__qtr__worker`
# under the older socket-isolation convention per ADR-162). We grep the
# session listing and pick the first match containing "worker".
_worker_window() {
  tmux list-windows -t "$ATMUX_SESSION" -F '#{window_name}' 2>/dev/null \
    | grep "worker" | head -1
}

# Inject a literal command into the worker pane via tmux send-keys.
# `Enter` is sent as a tmux keysym (NOT the literal characters), so the
# shell receives it as a carriage-return and executes immediately.
_inject() {
  local payload="$1"
  local win
  win="$(_worker_window)"
  [[ -n "$win" ]] || return 1
  tmux send-keys -t "$ATMUX_SESSION:$win" "$payload" Enter 2>/dev/null
  sleep 0.5
}

# Capture the worker pane's last N lines — for assertion purposes.
_capture() {
  local n="${1:-30}"
  local win
  win="$(_worker_window)"
  [[ -n "$win" ]] || { echo ""; return 0; }
  tmux capture-pane -p -S "-$n" -t "$ATMUX_SESSION:$win" 2>/dev/null
}

# ---------- 1. happy path: stuck composer + claim shim → fire success ----------

@test "queued-text resubmit (T2 wiring): happy path — claim shim clears composer; no escalation log entry" {
  _start_session || skip "atmux start failed to spawn worker pane"

  # Stage a `claim` shell function in the worker pane that clears the
  # screen + prints an empty composer prompt — simulates a TUI that
  # responds to the resubmitted command by transitioning to ready state.
  _inject "claim() { clear; printf '❯ \\n'; }"
  # Stage the stuck-composer state — the queued text the resubmit helper
  # will detect + re-fire.
  _inject "clear; echo '❯ claim --next'"

  # Sanity: pane shows the queued text BEFORE poke runs.
  capture_pre="$(_capture 5)"
  echo "PRE: $capture_pre"
  [[ "$capture_pre" == *"❯ claim --next"* ]] || \
    skip "fixture didn't render queued text into the pane (timing flake)"

  # Drive the wiring: a single poke tick. Discord disabled so the test
  # doesn't depend on a webhook stub.
  run "$ATMUX_BIN" poke --no-discord
  echo "POKE stdout: $output"
  echo "POKE status: $status"
  # poke is expected to exit 0 on a healthy tick (findings array stays
  # empty when no blockers + no needs-approval pings).
  [ "$status" -eq 0 ]

  # The escalation log must NOT have a new entry — the verifier observed
  # the composer-clear transition (claim function fired clear + new
  # composer line), so safeSendKeysWithVerify returned success=true and
  # the failureLogFn path was never reached.
  if [[ -f "$SEND_KEYS_FAILURES_LOG" ]]; then
    log_size="$(stat -c %s "$SEND_KEYS_FAILURES_LOG" 2>/dev/null || \
                  stat -f %z "$SEND_KEYS_FAILURES_LOG" 2>/dev/null || echo 0)"
    # Allow header-only / empty log; assert no `target=...worker...` row.
    if grep -q "worker" "$SEND_KEYS_FAILURES_LOG" 2>/dev/null; then
      echo "UNEXPECTED escalation log entry for worker pane:"
      cat "$SEND_KEYS_FAILURES_LOG"
      false
    fi
  fi
}

# ---------- 2. sad path: stuck composer + no shim → log-failure escalation ----------

@test "queued-text resubmit (T2 wiring): sad path — no claim shim; send-keys-failures.log entry written per ADR-168" {
  _start_session || skip "atmux start failed to spawn worker pane"

  # NO `claim` function defined — when the resubmit fires `claim --next`,
  # the shell errors with "command not found" + emits a fresh prompt
  # ($/zsh-%). The pane's last line is the shell prompt, NOT `❯ `, so
  # composerEmpty() returns false → verifier times out → safeSendKeysWithVerify
  # escalates per onFail:"escalate" → ADR-168 log row written.
  _inject "clear; echo '❯ claim --next'"

  capture_pre="$(_capture 5)"
  echo "PRE: $capture_pre"
  [[ "$capture_pre" == *"❯ claim --next"* ]] || \
    skip "fixture didn't render queued text into the pane (timing flake)"

  run "$ATMUX_BIN" poke --no-discord
  echo "POKE stdout: $output"
  echo "POKE status: $status"
  [ "$status" -eq 0 ]

  # Escalation log MUST exist + contain a row referencing this pane.
  # safeSendKeysWithVerify writes the target as the tmux pane spec
  # (`<session>:<window>`); we assert the worker window name appears.
  [[ -f "$SEND_KEYS_FAILURES_LOG" ]] || {
    echo "send-keys-failures.log was NOT created at $SEND_KEYS_FAILURES_LOG"
    echo "stderr+stdout from poke:"
    echo "$output"
    false
  }
  echo "ESCALATION LOG:"
  cat "$SEND_KEYS_FAILURES_LOG"
  # Match the worker pane in the target field. The window name may be
  # `__qtr__worker` (ADR-162) or `<emoji>-worker` (ADR-135) depending on
  # which convention the locally-built atmux is on — both match the
  # broader `worker` substring.
  grep -q "worker" "$SEND_KEYS_FAILURES_LOG"
}

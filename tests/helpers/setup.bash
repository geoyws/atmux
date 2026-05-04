#!/usr/bin/env bash
# tests/helpers/setup.bash — common setup for bats tests.
# Sets up a temporary sandbox (project dir + fake HOME-less state) and points
# `atmux` at our repo-local bin.

# Resolve atmux repo root from this helper's location.
ATMUX_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export ATMUX_REPO_ROOT
export ATMUX_BIN="$ATMUX_REPO_ROOT/bin/atmux"
export ATMUX_ROOT="$ATMUX_REPO_ROOT"
export ATMUX_BIN_DIR="$ATMUX_REPO_ROOT/bin"
export ATMUX_LIB_DIR="$ATMUX_REPO_ROOT/lib"
export ATMUX_TEMPLATES_DIR="$ATMUX_REPO_ROOT/templates"

# Create an isolated per-test workspace.
#
# Tests run on a dedicated tmux socket (TMUX_TMPDIR=$ATMUX_TEST_TMP/tmux) so test
# churn never touches the user's daily-driver tmux server. Without this, mass
# teardown of N panes inside the shared default-socket server can wedge tmux 3.x
# and take down unrelated sessions (incident: 2026-04-25).
atmux_setup_sandbox() {
  ATMUX_TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/atmux-test-XXXXXX")"
  export ATMUX_TEST_TMP
  mkdir -p "$ATMUX_TEST_TMP/project" "$ATMUX_TEST_TMP/tmux"
  cd "$ATMUX_TEST_TMP/project" || return 1
  export ATMUX_DIR="$ATMUX_TEST_TMP/project/.atmux"
  export TMUX_TMPDIR="$ATMUX_TEST_TMP/tmux"
  # Sandbox the fleet registry too. The new init/start hooks (E10/Sa
  # registry_upsert + registry_touch) write to $HOME/.claude/teams/
  # registry.json by default — without this override, every `atmux init`
  # / `atmux start` in a test pollutes the user's real fleet registry
  # (incident: 9 leaked entries observed 2026-04-27). registry.sh honors
  # $ATMUX_REGISTRY explicitly for this sandbox case.
  export ATMUX_REGISTRY="$ATMUX_TEST_TMP/registry.json"
  unset TMUX  # detach inherited client so child tmux invocations spawn a fresh sandbox server
  # Don't spew colors in tests.
  export NO_COLOR=1
  # Fast spawn wait.
  export ATMUX_SPAWN_WAIT=0
  # E8/Sb t-14365bea — opt out of `atmux start`'s cron auto-install so test
  # runs never touch the host's crontab. SB_T1 (atmux::cron_install) honors
  # this var; setting it here covers every sandbox without requiring tests
  # to remember the explicit `kanban.cronAutoInstall: false` team.json
  # field. Belt-and-suspenders teardown sweep below catches any cron lines
  # that slipped through (e.g. tests that override the var, or pre-SB_T1
  # code paths that miss the env-var gate).
  export ATMUX_NO_CRON=1
  # Same reasoning for groom: lib/start.sh fires a backgrounded
  # `atmux groom --quiet` on team activation. Tests that exercise other
  # paths don't want a parallel fork mutating .atmux/archive/ + .bak
  # files mid-test. tests/unit/groom.bats explicitly unsets this in the
  # one test that needs the verb's own behavior.
  export ATMUX_NO_GROOM=1
  # Sandbox HISTFILE so panes spawned by `atmux start` (which run
  # `exec $SHELL` in their initial command) don't append their brief +
  # member-init noise to the operator's real ~/.zsh_history. Observed
  # 2026-04-27: 1.2 MB of leaked brief content / `export ATMUX_MEMBER=...`
  # lines after a single full test run. HISTFILE is honored by both bash
  # and zsh; setting it before pane spawn confines all writes to the
  # sandbox tmpdir, which the teardown rm-rf reaps.
  export HISTFILE="$ATMUX_TEST_TMP/zsh_history"
}

atmux_teardown_sandbox() {
  # Sweep order:
  #   1. cron_remove BEFORE everything — atmux::cron_remove edits the
  #      host's crontab; once we wipe ATMUX_TEST_TMP the team's name
  #      isn't recoverable from team.json, and skipping this would leak
  #      orphan crontab lines into the operator's environment.
  #   2. tmux kill-server — single-op reaping (per the 2026-04-25 wedge
  #      incident); explicit `-S <socket>` because bare `kill-server`
  #      doesn't honour TMUX_TMPDIR on every tmux build.
  #   3. rm -rf the test tmpdir.
  #
  # cron_remove is no-op on hosts without crontab (matches the
  # cron_remove implementation's own behavior), so this sweep is safe in
  # CI / minimal containers / macOS-without-cron envs.
  _atmux_teardown_cron_sweep
  if [[ -n "${TMUX_TMPDIR:-}" ]]; then
    local socket
    for socket in "$TMUX_TMPDIR"/tmux-*/default "$TMUX_TMPDIR/default"; do
      [[ -S "$socket" ]] || continue
      tmux -S "$socket" kill-server 2>/dev/null || true
    done
  fi
  if [[ -n "${ATMUX_TEST_TMP:-}" && -d "$ATMUX_TEST_TMP" ]]; then
    rm -rf "$ATMUX_TEST_TMP"
  fi
}

# E8/Sb t-14365bea — belt+suspenders crontab cleanup. ATMUX_NO_CRON=1 in
# setup should already block install at source, but a test that overrides
# the env var, or a pre-SB_T1 binary path that misses the gate, would
# leak crontab lines past the rm-rf. Parse every team.json under the
# sandbox dir, look up the team name, call atmux::cron_remove. Idempotent
# + no-op when there's nothing to remove.
_atmux_teardown_cron_sweep() {
  [[ -n "${ATMUX_TEST_TMP:-}" && -d "$ATMUX_TEST_TMP" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  if ! declare -F atmux::cron_remove >/dev/null 2>&1; then
    [[ -f "${ATMUX_LIB_DIR:-}/cron.sh" ]] || return 0
    # cron.sh consumes atmux::* helpers (atmux::warn / atmux::log) which
    # live in common.sh; load common first if it's not already in scope.
    if ! declare -F atmux::warn >/dev/null 2>&1; then
      # shellcheck source=../../lib/common.sh
      . "$ATMUX_LIB_DIR/common.sh" 2>/dev/null || return 0
    fi
    # shellcheck source=../../lib/cron.sh
    . "$ATMUX_LIB_DIR/cron.sh" 2>/dev/null || return 0
  fi
  declare -F atmux::cron_remove >/dev/null 2>&1 || return 0

  local tj team
  while IFS= read -r tj; do
    team="$(jq -r '.name // empty' "$tj" 2>/dev/null)"
    [[ -n "$team" ]] || continue
    atmux::cron_remove "$team" >/dev/null 2>&1 || true
  done < <(find "$ATMUX_TEST_TMP" -name team.json -path '*/.atmux/team.json' 2>/dev/null)

  # 2026-04-27 reinforcement: the team.json walk above only catches lines
  # whose sandbox dir still exists. A prior test process killed mid-run
  # (BATS_TEST_TIMEOUT, OOM, ^C) leaks a crontab line whose ATMUX_DIR
  # points into a now-deleted /tmp/atmux-test-XXXXXX. Those lines fire
  # every minute against the OPERATOR's default tmux socket (cron has no
  # TMUX_TMPDIR) — the documented vector for the 2026-04-22..27 daily-
  # driver tmux deaths. Path-based sweep below scrubs every line whose
  # ATMUX_DIR points at /tmp/atmux-{test,stop}-* regardless of which
  # bats run created it. Runs always — independent of the team.json walk.
  _atmux_teardown_cron_path_sweep
}

# Path-based crontab purge — scrubs every line containing /tmp/atmux-
# sandbox prefixes from the host's crontab, atomically. Runs in addition
# to the team.json walk so crashed-mid-test runs from PREVIOUS sessions
# can't continue firing whip/report/digest against the operator's real
# tmux socket every minute.
_atmux_teardown_cron_path_sweep() {
  command -v crontab >/dev/null 2>&1 || return 0
  local current
  current="$(crontab -l 2>/dev/null || true)"
  [[ -z "$current" ]] && return 0

  # Drop lines mentioning /tmp/atmux-test- or /tmp/atmux-stop- — the
  # mktemp prefixes used by atmux_setup_sandbox + tests/unit/stop.bats.
  local stripped
  stripped="$(printf '%s\n' "$current" \
    | grep -vE '/tmp/atmux-(test|stop)-' || true)"

  # No-op when nothing changed (avoids needless crontab swap mtime bump).
  [[ "$stripped" == "$current" || "$stripped" == "$current"$'\n' ]] && return 0

  local tmp; tmp="$(mktemp /tmp/atmux-cron-sweep-XXXXXX)"
  printf '%s\n' "$stripped" > "$tmp"
  crontab "$tmp" 2>/dev/null || true
  rm -f "$tmp"
}

# Force single-tick session-DOWN alerting (E6/S1 t-9e85a35c). Many whip
# tests use the inert-sandbox tmux state as a synthetic finding source —
# they need the first DOWN tick to surface immediately rather than wait
# for the two-tick confirmation. Tests that exercise the two-tick gate
# itself (whip_session_down.bats) MUST NOT call this helper.
atmux_disable_down_confirm() {
  local tj="$ATMUX_DIR/team.json"
  [[ -f "$tj" ]] || return 1
  jq '.whip.downConfirmTicks = 1' "$tj" > "$tj.tmp" && mv "$tj.tmp" "$tj"
}

# skip-with-reason when socat is missing (apt install socat / brew install
# socat). The pubsub primitives + supervisor listener side are socat-pinned
# per ADR-032 OQ1; the python3 fallback is only exercised by the supervisor
# Sb integration tests. Apply at the top of any setup() for socket tests
# (Sa socket_pubsub.bats / Sb supervisor.bats / Se socket_lifecycle.bats).
require_socat() {
  if ! command -v socat >/dev/null 2>&1; then
    skip "socat not installed (apt install socat | brew install socat) — pubsub primitives are socat-pinned per ADR-032 OQ1"
  fi
  export ATMUX_SOCK_BACKEND=socat
}

# Sources lib files for direct function-level unit tests.
atmux_source_libs() {
  # shellcheck source=../../lib/common.sh
  . "$ATMUX_LIB_DIR/common.sh"
  # shellcheck source=../../lib/tui.sh
  . "$ATMUX_LIB_DIR/tui.sh"
}

# Paranoid guard — call BEFORE any atmux command in a test that might
# write to .atmux/team.json. Hard-fails the test if `pwd` looks like
# the repo's own working tree (the canonical 2026-04-25 incident: a
# test fixture clobbered the live team.json because cwd had drifted).
# Tests using atmux_setup_sandbox always pass; tests that ran
# `cd "$ATMUX_REPO_ROOT"` mid-body (or never sandboxed) trip the
# assertion before the write fires.
atmux_assert_sandbox() {
  if [[ "$PWD" == "$ATMUX_REPO_ROOT" || "$PWD" == "$ATMUX_REPO_ROOT"/* ]]; then
    if [[ -z "${ATMUX_TEST_TMP:-}" || "$PWD" != "$ATMUX_TEST_TMP"/* ]]; then
      printf 'atmux_assert_sandbox: refusing to run inside repo root (%s)\n' "$PWD" >&2
      printf '  call atmux_setup_sandbox in setup() before any team.json mutation\n' >&2
      return 1
    fi
  fi
  if [[ -z "${ATMUX_TEST_TMP:-}" ]]; then
    printf 'atmux_assert_sandbox: ATMUX_TEST_TMP unset — sandbox not initialized\n' >&2
    return 1
  fi
}

# Runs the atmux binary in a subshell with the sandbox env.
atmux_run() {
  "$ATMUX_BIN" "$@"
}

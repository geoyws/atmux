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
  unset TMUX  # detach inherited client so child tmux invocations spawn a fresh sandbox server
  # Don't spew colors in tests.
  export NO_COLOR=1
  # Fast spawn wait.
  export ATMUX_SPAWN_WAIT=0
}

atmux_teardown_sandbox() {
  # Tear down the sandbox tmux server in a single op — avoids the per-pane kill
  # storm that wedged tmux on 2026-04-25.
  if [[ -n "${TMUX_TMPDIR:-}" && -S "$TMUX_TMPDIR/default" ]]; then
    tmux kill-server 2>/dev/null || true
  fi
  if [[ -n "${ATMUX_TEST_TMP:-}" && -d "$ATMUX_TEST_TMP" ]]; then
    rm -rf "$ATMUX_TEST_TMP"
  fi
}

# Sources lib files for direct function-level unit tests.
atmux_source_libs() {
  # shellcheck source=../../lib/common.sh
  . "$ATMUX_LIB_DIR/common.sh"
  # shellcheck source=../../lib/tui.sh
  . "$ATMUX_LIB_DIR/tui.sh"
}

# Runs the atmux binary in a subshell with the sandbox env.
atmux_run() {
  "$ATMUX_BIN" "$@"
}

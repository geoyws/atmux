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
atmux_setup_sandbox() {
  ATMUX_TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/atmux-test-XXXXXX")"
  export ATMUX_TEST_TMP
  mkdir -p "$ATMUX_TEST_TMP/project"
  cd "$ATMUX_TEST_TMP/project"
  export ATMUX_DIR="$ATMUX_TEST_TMP/project/.atmux"
  # Don't spew colors in tests.
  export NO_COLOR=1
  # Fast spawn wait.
  export ATMUX_SPAWN_WAIT=0
}

atmux_teardown_sandbox() {
  # Kill any tmux sessions we created.
  if [[ -n "${ATMUX_TEST_SESSION:-}" ]]; then
    tmux kill-session -t "$ATMUX_TEST_SESSION" 2>/dev/null || true
  fi
  # Kill any session named atmux-* that we might have created.
  if command -v tmux >/dev/null 2>&1; then
    tmux list-sessions -F '#S' 2>/dev/null | grep -E '^atmux-test-' | while read -r s; do
      tmux kill-session -t "$s" 2>/dev/null || true
    done
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

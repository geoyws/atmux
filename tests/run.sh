#!/usr/bin/env bash
# Run all atmux tests (unit + e2e), optionally in parallel.
# Usage: ./tests/run.sh [--jobs N] [--shellcheck]

set -euo pipefail
cd "$(dirname "$0")/.."

jobs=1
shellcheck_pass=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs|-j) jobs="$2"; shift 2 ;;
    --shellcheck) shellcheck_pass=1; shift ;;
    *) echo "run.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo ""
echo "================ atmux test suite ================"
echo ""

fail=0

if [[ "$shellcheck_pass" -eq 1 ]]; then
  echo "--- shellcheck ---"
  if shellcheck -x -e SC1091,SC2154,SC2155,SC2016,SC2034 bin/atmux lib/*.sh tests/helpers/*.bash; then
    echo "shellcheck: OK"
  else
    fail=1
    echo "shellcheck: FAIL"
  fi
  echo ""
fi

echo "--- unit tests (jobs=$jobs) ---"
# BATS_TEST_TIMEOUT caps wall time per test. Belt-and-suspenders for the
# fd-3 hygiene fix in lib/start.sh (ADR-012): if a future regression
# reintroduces fd-3 leakage (or any other hang), the suite terminates
# instead of hanging CI for hours. 120s is comfortable for the heaviest
# unit test (a few seconds typical).
if BATS_TEST_TIMEOUT=120 bats --jobs "$jobs" tests/unit/; then
  echo "unit: OK"
else
  fail=1
  echo "unit: FAIL"
fi

echo ""
echo "--- e2e tests ---"
# e2e tests share tmux global state — keep serial to avoid session-name races.
# 300s timeout — longer than unit tests because e2e walks real tmux + claim
# flows, but still bounded so a wedge can't burn CI for hours. ADR-012.
if BATS_TEST_TIMEOUT=300 bats tests/e2e/; then
  echo "e2e: OK"
else
  fail=1
  echo "e2e: FAIL"
fi

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "✅ all green"
else
  echo "❌ failures above"
fi
exit "$fail"

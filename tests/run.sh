#!/usr/bin/env bash
# Run all atmux tests (unit + e2e). Used locally + in CI.

set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "================ atmux test suite ================"
echo ""

fail=0

echo "--- unit tests ---"
if bats tests/unit/; then
  echo "unit: OK"
else
  fail=1
  echo "unit: FAIL"
fi

echo ""
echo "--- e2e tests ---"
if bats tests/e2e/; then
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

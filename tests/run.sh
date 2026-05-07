#!/usr/bin/env bash
# Run all atmux tests (unit + e2e), optionally in parallel.
# Usage: ./tests/run.sh [--jobs N] [--shellcheck]
#
# Unit tier default is --jobs 1 (serial). 2026-04-27 incident — daily-
# driver tmux server killed 6 times since 2026-04-25. Forensic root
# cause was the dogfooding team running on the operator's default
# socket (now fixed via ADR-018 tmuxTmpdir migration), but parallel
# runs are a force-multiplier: each bats job forks `crontab -l` per
# setup+teardown, fans out `atmux start` (which spawns N member panes
# under the user@0 systemd-user instance), and burns through pid_max
# faster than the kernel can reap. PID rollover at jobs=4 was observed
# (4194221 → 328 in <1s) which destabilises systemd-scope tracking
# even if no test directly touches the operator's tmux socket. Opt
# back into parallel via `./tests/run.sh --jobs 4` once you've
# confirmed the cron path-sweep + tmuxTmpdir migration are in place.
# e2e tier stays serial regardless — those tests share global tmux
# session names and would race each other.

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
# instead of hanging CI for hours.
#
# Bumped 120s → 300s 2026-04-27 (E7-blocker / t-d51ec76a). atomicity.bats's
# 5 forking tests fire 20 concurrent atmux subshells each, racing flock'd
# kanban.json + inbox writes — N=20 is intentional contention pressure
# (don't lower; comment in atomicity.bats:24-26 explains). On a busy host
# (4-CPU + concurrent socket_pubsub.bats supervisor-start forks), linear
# jq+flock contention can balloon individual tests past 120s under load
# even though they finish in ~1-2s standalone. 300s mirrors the e2e tier
# ceiling — still bounded enough that a real wedge can't burn CI for
# hours. Hypothesis "parallel-load" was ruled out (jobs=1 already);
# root cause is intra-test 20-fork contention amplified by host load.
if BATS_TEST_TIMEOUT=300 bats --jobs "$jobs" tests/unit/; then
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

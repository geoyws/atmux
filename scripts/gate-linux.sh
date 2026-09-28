#!/usr/bin/env bash
# scripts/gate-linux.sh — run the atmux gate inside the Linux gate image.
#
# Usage:
#   scripts/gate-linux.sh [bun-test-args...]   # default: tsc + full unit suite
#   scripts/gate-linux.sh --quick              # tsc only (no test run)
#   scripts/gate-linux.sh tests/unit/verbs/    # pass through to `bun test`
#
# HEAVY GATE: wrap the invocation with gate-slot on @@mbp (never inside):
#   GATE_SLOT="$(realpath ~/.agents/skills)/../../medic/skills/gate-slot/bin/gate-slot"
#   "$GATE_SLOT" run --name <gate-name> -- scripts/gate-linux.sh
# The slot wraps the BLOCKING `docker run` (no -d); a detached start would
# free the slot while containers keep running.
#
# What runs where: tsc + `bun test` run IN the container (Linux proof).
# `bun run lint` stays native per-file (unchanged practice) — the container
# gate does not lint. Native macOS test runs are iteration-speed only and
# NEVER gate evidence.
#
# Receipts cite: this script, the image ID (`docker images atmux-gate`),
# the base digest in docker/Dockerfile.gate, and the slot verdict.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ATMUX_GATE_IMAGE:-atmux-gate:latest}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -f "$REPO/docker/Dockerfile.gate" -t "$IMAGE" "$REPO"
fi

if [[ "${1:-}" == "--quick" ]]; then
  CMD=(bash -c 'bunx tsc --noEmit -p tsconfig.json')
else
  # Isolated HOME + TMPDIR so the suite never touches the operator's
  # ~/.atmux, ~/.claude-*, or host /tmp fixtures. node_modules lives on
  # a named volume: container `bun install` writes Linux builds there
  # instead of clobbering the host's macOS tree. --frozen-lockfile never
  # mutates the mounted repo's lockfile; the bun-types check fails fast
  # on a silent partial install (seen once as downstream TS2688).
  # tsc is advisory here, not a gate: the tree carries 2 known
  # pre-existing type errors in test files (cockpit StartOpts,
  # cron-reaper handler), so `tsc && test` would never reach the suite.
  # tsc runs, its exit is reported, and the suite ALWAYS runs; the
  # suite's exit is the gate's.
  CMD=(bash -c 'export HOME=/tmp/gate-home TMPDIR=/tmp/gate-tmp && mkdir -p "$HOME" "$TMPDIR" && bun install --silent --frozen-lockfile && test -d node_modules/bun-types && (bunx tsc --noEmit -p tsconfig.json; echo "TSC_EXIT=$?") && bun test "$@"' _ "$@")
fi

docker run --rm \
  --cpus 4 --memory 8g \
  -v "$REPO:/repo:rw" \
  -v atmux-gate-nm:/repo/node_modules \
  -w /repo \
  -e TMUX_TMPDIR=/tmp/gate-tmp \
  "$IMAGE" "${CMD[@]}"

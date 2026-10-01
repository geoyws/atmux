# RUNBOOK-gates — containerised Linux gates for atmux

Every e2e run, quality gate and test suite for atmux runs INSIDE the Linux
gate container on the configured test host (never as a native macOS process
— the served host is Linux and a macOS-only pass proves nothing about the
tier). Which host that is lives in the estate placement docs, not here.
Reference: repo rule "ALWAYS CONTAINERISE e2e, gates and tests".

## The gate

- Image: `docker/Dockerfile.gate` (oven/bun + git + jq + the PINNED tmux
  from `tmux/PINNED_VERSION`, built checksum-verified by
  `scripts/build-vendored-tmux.sh` per ADR-191 — never the distro tmux,
  whose `-F` tab handling differs; base pinned by digest in the Dockerfile
  header — bump deliberately, never float).
- Script: `scripts/gate-linux.sh` (tags the image by a hash of its inputs
  and builds it when that tag is absent; mounts the repo; isolates
  HOME/TMPDIR/node_modules from the host).
- Slot: every run goes through `gate-slot` on the test host. Wrap the
  BLOCKING invocation, never a detached start:

```bash
GATE_SLOT="$(realpath ~/.agents/skills)/../../medic/skills/gate-slot/bin/gate-slot"
"$GATE_SLOT" run --name <gate-name> -- scripts/gate-linux.sh [bun-test-args...]
```

## Receipts

Every gate/e2e receipt names: the script, the image ID (`docker images
atmux-gate --format '{{.ID}}'`), the base digest from the Dockerfile, and
the slot verdict. `native macOS run` is iteration speed only — it NEVER
counts as gate evidence (say so plainly when that is all you have).

## Scope notes

- `gate-linux.sh` runs `tsc` + `bun test`. `bun run lint` stays native
  per-file (unchanged practice).
- First containerised proof: t-e3aed002 (2026-09-28) — full unit suite in
  the gate image under slot; counts recorded on the task.

## Addenda

- 2026-09-28: test-host placement (which machine runs the gate, slot
  concurrency, prod-adjacency safety floor) moved to the estate docs
  (dotfiles `AGENTS.md`, infra-root ADR-005). This runbook stays
  host-agnostic: env vars and a generic "test host" only. Earlier
  receipts naming a specific host stay as historical record.

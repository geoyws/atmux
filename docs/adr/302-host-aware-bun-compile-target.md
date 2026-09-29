# ADR-302: Host-aware `bun build --compile` target

**Status**: accepted (reviewer signoff 2026-09-29)
**Date**: 2026-09-29
**Driver-ref**: kb atmux t-af727acd
**Relates**: [ADR-047](047-canonical-install-topology.md) (install topology), [ADR-191](191-vendored-tmux-binary.md) (`build:install` ships the artefacts)

## Context

`package.json::build:compile` hardcoded `--target=bun-linux-x64`, and
`build:install` runs it first — so on @@mbp (macOS arm64)
`bun run build:install` installed a Linux ELF as
`/opt/atmux/<ver>/bin/atmux` (measured 2026-09-29 at 8eccd947:
83 MB `bun-linux-x64-v1.4.2`; the sudo install step then hung and left
a root-owned temp file behind). The workaround was a hand-rolled
`bun build … --target=bun-darwin-arm64` plus manual sudo steps.

Deploy hosts are Linux, CI (`ci.yml`) runs on `ubuntu-24.04` and never
invokes `build:compile`, and `atmux release` shells out to
`bun run build:install` on the deploy host — so nothing in the release
pipeline depends on `build:compile` meaning linux-x64 specifically.

## Decision

### D1 — `build:compile` follows the host via `scripts/build-compile.ts`

`src/core/build-target.ts::resolveBunCompileTarget()` maps
`process.platform`/`process.arch` to the matching bun target
(darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64;
anything else throws naming the known set). The thin wrapper
`scripts/build-compile.ts` resolves the target, prints
`build-compile: target=<t> (via …)` to stderr, and execs
`bun build ./bin/atmux-entry.ts --compile --target=<t> --outfile dist/atmux`,
passing remaining argv through to `bun build` verbatim.

### D2 — Explicit override for Linux release artefacts

Two equivalent escape hatches, highest precedence first:
`--target=<t>` argv on the script, then `ATMUX_BUN_TARGET` env
(blank/whitespace falls through; unknown values fail closed with exit
2 listing the known targets). `package.json::build:compile:linux`
pins `ATMUX_BUN_TARGET=bun-linux-x64` for anyone cross-compiling a
Linux artefact from macOS; `build:install` keeps calling
`build:compile`, which is linux-x64 on the Linux deploy hosts by
default.

### D3 — No CI/release change

`ci.yml` never builds the binary; `src/verbs/release.ts` invokes
`build:install` on the (Linux) deploy host, where the host default is
unchanged. `docs/RUNBOOK-deploy.md` §Cut procedure names the
host-default + the `:linux` escape hatch.

## Consequences

- `bun run build:install` on macOS now installs a runnable Mach-O
  binary (verified: `dist/atmux: Mach-O 64-bit executable arm64`,
  reports `atmux 0.8.30`); on Linux deploy hosts nothing changes.
- New tracked source `src/core/build-target.ts` is pinned at 100% by
  `tests/unit/core/build-target.test.ts` (host rows + override +
  argv splitter); `scripts/build-compile.ts` is outside the
  `src/**` lcov universe per the ADR-254 gate.
- Cross-compiling from macOS stays one explicit step
  (`build:compile:linux`), never the default.

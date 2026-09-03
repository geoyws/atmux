# ADR-191: atmux ships its own vendored tmux binary — version-pinning + behavior isolation + reproducibility

**Status**: Accepted — ratified by driver 2026-09-03 (vendored tmux at /opt/atmux/<v>/bin/tmux pinned to 3.7c; ordinary atmux paths stay on `resolveTmuxBin()` with `ATMUX_TMUX_BIN` then host PATH, while only the driver-only `aca` / `aco` vendored cockpit path opts into `resolveVendoredTmuxBin()` and fails closed; older 3.6a wording is historical only)
**Date**: 2026-05-20
**Driver-ref**: driver-2026-05-20-13:25-MYT (ASK 1 of operator's structural-foundations dispatch; sibling to ADR-190 ASK 2 atmux.conf OSS-ready)
**Operator order**: lands AFTER Epic e-63c97ed8 (atmux.conf shipped patterns); ASK 1 is the "insulation layer" on top of the conf-patterns Epic.

## Amendment 2026-09-02 — staged split, historical pending gate

- Ordinary atmux paths stay on the legacy resolver: `resolveTmuxBin()` first honors `ATMUX_TMUX_BIN`, then host PATH.
- The driver-only `aca` / `aco` vendored cockpit path is the only consumer of `binaryPath` / `resolveVendoredTmuxBin()`; it fails closed and never falls back to host tmux.
- 3.7c was a vendored candidate pin pending George gate; this note is historical and superseded by the 2026-09-03 acceptance.

## Amendment 2026-09-03 — accepted vendored pin is 3.7c

- George approved exact tmux `3.7c` as the vendored source-build pin, and the install pipeline now treats that pin as the accepted live contract.
- The source build verifies the pinned SHA before extraction, rejects hostile archive members and extracted links, and probes the built binary with `tmux -V` before publish.
- The install root is built as a complete candidate payload, including `atmux`, `atmux-listener`, `atmux-cockpit-mirror`, `templates`, `plugins`, and the vendored tmux tree, and `current` is retargeted only after that candidate validates.
- The 2026-09-02 staged-split note remains historical. The live contract is the 2026-09-03 pin, not the earlier 3.6a staging language.

## Context

atmux currently uses the operator's system-installed tmux (typically `/usr/local/bin/tmux` from `brew install tmux` or `apt install tmux`). Two recurring problems with this dependency posture:

1. **Version drift**: operator-installed tmux varies across machines (3.4 on local, 3.6a on hax, etc.). atmux's verb behaviors depend on tmux feature support (e.g. ADR-190 §Context tmux 3.6a PANE-ACTIVITY `#()` re-eval semantics). When operator-tmux upgrades, atmux behaviors silently change.

2. **Behavior isolation gap**: ADR-162 already establishes "atmux owns its tmux infrastructure" — canonical `atmux.conf`, isolated cockpit socket, etc. — but the BINARY itself is still operator-managed. The conf isolation is partial; binary isolation closes the gap.

The 2026-05-20 statusline-fork-storm incident (ADR-190 §Context) is canonical evidence: tmux 3.6a's PANE-ACTIVITY `#()` re-eval semantics caused 100+ git-branch forks/sec at 20-cage scale. The bug was tmux-version-exposed; if atmux had been on a pinned older tmux without that semantic, the incident wouldn't have surfaced. Conversely, if atmux upgrades to a new tmux without notice, future incidents are inevitable.

### Operator's daily-driver tmux MUST stay untouched

ASK 1 explicit: operator's personal tmux (system-installed) is operator-personal scope. atmux ships its OWN binary at `/opt/atmux/<v>/bin/tmux` and uses it via `ATMUX_TMUX_BIN` env var. Operator running `tmux` on the command line still hits their personal `/usr/local/bin/tmux`.

## Decision

### Vendored tmux binary at `/opt/atmux/<v>/bin/tmux`

atmux ships a vendored tmux binary as part of its install artifact. Location: `/opt/atmux/<v>/bin/tmux` (mirrors the existing `/opt/atmux/<v>/bin/atmux` install topology per memory `project_atmux_install_topology`).

Version-pinned to a **known-good** tmux release (current accepted pin: tmux 3.7c; older 3.6a guidance is historical). Pin file at `tmux/PINNED_VERSION` in atmux source.

### Spawn-path resolution via `ATMUX_TMUX_BIN`

Ordinary / legacy atmux spawn sites resolve tmux through `resolveTmuxBin()`:

1. `process.env.ATMUX_TMUX_BIN` if set (operator override)
2. host PATH (`tmux` / `which tmux`) if no override is set

That legacy resolver does not consult the vendored binary. The driver-only `aca` / `aco` cockpit path instead uses `resolveVendoredTmuxBin()` / `binaryPath`, points at `/opt/atmux/<v>/bin/tmux`, and fails closed with no host PATH fallback.

### Call-sites to migrate

- `src/abstractions/tmux.ts` — owner of `resolveTmuxBin()` + every tmux spawn primitive
- `src/verbs/start.ts` — tmux server bootstrap for new cages
- `src/verbs/cockpit.ts` — cockpit socket isolation (per ADR-162); the driver-only `aca` / `aco` vendored cockpit path is the only cockpit caller that uses the vendored binary
- `install.sh` — installer fetches + verifies + symlinks the vendored binary into `/opt/atmux/<v>/bin/tmux`
- Any script or shell call that hard-codes `tmux` — grep + migrate

### Build pipeline

`/opt/atmux/<v>/bin/tmux` is built-from-source as part of atmux release process (NOT runtime download per security posture):

1. Source: tmux upstream tag (e.g. `3.7c`)
2. Build deps: libevent + ncurses + bison + pkg-config (atmux release env per CI config)
3. Configure: `./configure --prefix=/opt/atmux/<v> --disable-utempter` (minimize attack surface)
4. Build: `make`
5. Output: `/opt/atmux/<v>/bin/tmux` (statically-linked-when-possible for cross-machine portability)
6. Smoke test: vendored binary boots; `tmux -V` reports the pinned version; basic `new-session` + `kill-session` flow works

Release artifact includes the binary; install.sh extracts + chmods + smoke-tests post-install.

### Operator override

`ATMUX_TMUX_BIN=/path/to/operator-preferred-tmux atmux <verb>` always wins. Use cases:
- Operator pinning a different version for testing
- Operator developing tmux features (point at local build)
- CI rigs using system tmux deliberately

Override is process-scope; no global state.

## Consequences

### What changes for which lanes

**BUILD/OPS lane** — install.sh + CI release pipeline:
- Fetch + build + verify vendored tmux per release
- Ship binary in atmux release tarball (size impact: +1-2MB)
- Install.sh extracts + symlinks + smoke-tests
- CHANGELOG entries on every vendored-tmux upgrade (with security-relevant CHANGELOG link from upstream)

**BE lane** — src/abstractions/tmux.ts + call-sites:
- `resolveTmuxBin()` helper extraction + same-commit unit tests
- Migrate every spawn site to use the helper
- Legacy compatibility: ordinary atmux paths use host tmux when `ATMUX_TMUX_BIN` is unset. This does not apply to the vendored `aca` / `aco` path, which fails closed when its explicit binary is absent.

**SECURITY lane** — bundling a binary adds supply-chain surface:
- Tmux is C code with active maintenance; CVE feed monitoring required (per CHANGELOG mention above)
- Build determinism: same source + deps + flags → same binary (reproducible-builds-style verify; SBOM published)
- Operator may audit the vendored binary; SHA256 published per release

**DOCS lane** — sweep:
- ADR-162 §Amendment cross-link ADR-191 (cockpit socket isolation + binary isolation: complete tmux-infrastructure ownership)
- ADR-163 (bundled tmux 3.7c) — supersede if pin version changes; cross-ref this ADR
- README operator guidance: how to override via ATMUX_TMUX_BIN
- RUNBOOK on rolling back to system tmux (escape valve documented)

### What we give up

- **Install size**: +1-2MB per release tarball
- **Build complexity**: CI needs build deps for tmux (libevent / ncurses / etc); release-engineering surface grows
- **Maintenance overhead**: vendored tmux needs periodic upgrade tracking; operator-relevant CHANGELOG entries on every bump

### Rollback path

`ATMUX_TMUX_BIN=/usr/local/bin/tmux atmux <ordinary-legacy-verb>` selects system tmux for the ordinary / legacy resolver only. It does not affect the vendored `aca` / `aco` path.

Roll back the vendored plane by atomically retargeting `/opt/atmux/current` to a previously verified, complete atmux release tree that includes exact tmux 3.7c. Deliberately removing `/opt/atmux/<v>/bin/tmux` disables only the vendored plane: legacy resolver paths remain available, while `aca` / `aco` refuse to start until a complete bundle is restored.

## Historical open questions from the 2026-05 proposal

1. **(LOW reversibility) Initial pin version**: tmux 3.7c is the accepted live pin. The older 3.6a recommendation is historical. Alternative: pin OLDER (3.4 — no PANE-ACTIVITY `#()` re-eval) which sidesteps the ADR-190 fork-storm hazard at the binary level (in addition to the conf-level TTL-cache mitigation).

2. **(LOW reversibility) Distribution format**: built binary in release tarball vs source-distribution + build-on-install. Recommendation: built binary (faster install; reproducible-builds verifiable via published SHA + reproducer command). Build-on-install adds build deps to install.sh and is slow.

3. **(LOW reversibility) Cross-platform support**: atmux runs on Linux (hax) + macOS (operator local). Vendored binary must be built per-platform. Recommendation: ship per-platform tarballs; install.sh selects the right one via `uname -s`. Same complexity tier as existing atmux multi-platform CI; no new surface.

4. **(LOW reversibility) Static vs dynamic linking**: static = portable but bigger; dynamic = relies on system libevent/ncurses (the very libraries we're trying to isolate). Recommendation: static where possible (libevent at least; ncurses can be either). Reviewer signs off on link posture per build engineer's call.

5. **(LOW reversibility) Bin namespace clash**: `/opt/atmux/<v>/bin/tmux` conflicts with operator running `tmux` from PATH. Resolution: ordinary atmux callers keep `resolveTmuxBin()` (override → host PATH), while the driver-only vendored cockpit path uses `resolveVendoredTmuxBin()` on the explicit path. Operator's PATH still hits system tmux. No actual clash. Open to discussion if operator-ergonomics suffers.

## Implementation status

Tracked under Epic e-162046c7 (driver dispatch 2026-05-23, "ship the unshipped"). Source already ratified the technical decision 2026-05-21; this section records what landed when.

**2026-05-23 — Resolver helper + spawn-site migration (be-1)**

- `src/core/resolve-tmux-bin.ts` — ordinary `resolveTmuxBin()` helper landed with the legacy chain (override → host PATH). The vendored cockpit path uses the separate `resolveVendoredTmuxBin()` seam and explicit `/opt/atmux/current/bin/tmux` path instead of a host fallback. Injectable env / existsSync / warn / state seams mirror `resolveDefaultListenerBinary` (`src/abstractions/native-listener.ts`) for parity. Per-process memoization via module-scope state; tests pass their own state record for isolation. Unit coverage 100% lines / 100% funcs in `tests/unit/core/resolve-tmux-bin.test.ts`.
- Call-sites migrated to consume `resolveTmuxBin()`:
  - `src/abstractions/tmux.ts` — `tmuxRunRaw`, `loadBuffer`, `attachSessionInheritStdio` (the 3 spawn primitives in the typed wrapper).
  - `src/abstractions/fallback-cage.ts` — Tier-3+ `sudo -u <agent> env … <tmux>` cage spawn + the operator-tier `capture-pane` post-mortem + the Tier-3+ `kill-session` teardown.
  - `src/verbs/poke.ts` — `sendCageBrief` paste-buffer load/paste for both operator + Tier-3+ paths.
  - `src/verbs/doctor.ts` — `defaultTmuxSpawn` baseline for the tmux-version probe family.
  - `src/core/cursor-recipes/fix-supervisor-missing.ts` — `list-windows` detect probe.
- Header comment in `src/abstractions/tmux.ts` updated — every spawn now reads `cmd: resolveTmuxBin()` instead of the `cmd: "tmux"` literal called out in the original ADR-004 §Socket-injection block. Binary resolution lives in the same closure layer as socket pinning.
- `atmux doctor` probe `checkVendoredTmuxBinary` (src/verbs/doctor.ts) — two yellow rows possible: `vendored-tmux-missing` (vendored binary absent; the install is incomplete until it is restored) + `vendored-tmux-version-drift` (binary present but `tmux -V` doesn't match the ADR-191 3.7c pin). Self-clearing post-`build:install`. Hooked into the main `doctor()` orchestrator next to `checkTmuxVersionMismatch`. 8 unit tests cover the current branches (absent / pinned / drift / unparseable / non-zero exit / throw / custom path+version / default vendored spawn path).

**2026-09-03 — source-build packaging + operator docs**

- `package.json::build:install` now runs `scripts/build-install.ts`, which source-builds exact tmux 3.7c from the SHA-pinned archive and publishes only a validated complete candidate.
- `src/verbs/cockpit.ts` now routes `driverOnly: true` through the vendored binary, `atmux-vendored-cockpit` socket, and exact three-window no-agent topology.
- The deploy/cockpit runbooks and `[Unreleased]` changelog document the separate fail-closed `aca` / `aco` plane, its declarative no-resurrect restore path, and the untouched legacy Homebrew tmux-resurrect/Continuum plane.

**Pending (subsequent landings on Epic e-162046c7)**

- README operator guidance — how to override via `ATMUX_TMUX_BIN`.
- SECURITY.md — supply-chain posture (tmux CVE monitoring + per-release SHA256 publication).
- ADR-162 §Amendment cross-link this ADR (cockpit socket isolation + binary isolation: complete tmux-infrastructure ownership per the operator's framing).

## Cross-refs

- ADR-162 (atmux owns tmux infrastructure — cockpit socket isolation; this ADR completes the binary side)
- ADR-163 (bundled tmux 3.7c — pin version reference)
- ADR-190 (tmux statusline scaling — sibling Epic e-63c97ed8 lands FIRST per operator order; this Epic is the insulation layer on top)
- ADR-171 (tmux.conf.local override — operator escape valve precedent for personalization)
- Memory `project_atmux_install_topology` (existing `/opt/atmux/<v>/bin/<cmd>` install pattern; vendored tmux fits the same shape)
- ASK 1 of driver dispatch driver-2026-05-20-13:25-MYT
- Operator-dotfiles `ee009cc` (cross-Epic context — Epic e-63c97ed8 ports helpers from there)

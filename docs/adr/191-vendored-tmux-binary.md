# ADR-191: atmux ships its own vendored tmux binary — version-pinning + behavior isolation + reproducibility

**Status**: Accepted — ratified by driver 2026-05-21 (vendored tmux at /opt/atmux/<v>/bin/tmux pinned to 3.6a; resolution chain ATMUX_TMUX_BIN → vendored → system fallback; §OQ recommendations as-written)
**Date**: 2026-05-20
**Driver-ref**: driver-2026-05-20-13:25-MYT (ASK 1 of operator's structural-foundations dispatch; sibling to ADR-190 ASK 2 atmux.conf OSS-ready)
**Operator order**: lands AFTER Epic e-63c97ed8 (atmux.conf shipped patterns); ASK 1 is the "insulation layer" on top of the conf-patterns Epic.

## Amendment 2026-09-02 — staged split, pending gate

- Host-facing runtime resolution stays on the legacy resolver.
- 3.7c is a vendored candidate pin pending George gate, not an accepted live-plane pin.
- `binaryPath` and `resolveVendoredTmuxBin()` are prepared seams only; no current production call site is routed through them.

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

Version-pinned to a **known-good** tmux release (recommendation: tmux 3.6a — current ADR-163 bundled version reference; reviewer may pin alternate after security audit). Pin file at `tmux/PINNED_VERSION` in atmux source.

### Spawn-path resolution via `ATMUX_TMUX_BIN`

Every atmux code path that spawns tmux resolves the binary path via:

1. `process.env.ATMUX_TMUX_BIN` if set (operator override)
2. `/opt/atmux/<v>/bin/tmux` if present (vendored binary)
3. Fall back to `/usr/local/bin/tmux` or `which tmux` (operator's system tmux)

Resolution lives in a single helper `resolveTmuxBin()` at `src/abstractions/tmux.ts`. Every spawn site consumes the helper; no scattered `tmux` literal invocations.

### Call-sites to migrate

- `src/abstractions/tmux.ts` — owner of `resolveTmuxBin()` + every tmux spawn primitive
- `src/verbs/start.ts` — tmux server bootstrap for new cages
- `src/verbs/cockpit.ts` — cockpit socket isolation (per ADR-162); cockpit tmux server uses the vendored binary too
- `install.sh` — installer fetches + verifies + symlinks the vendored binary into `/opt/atmux/<v>/bin/tmux`
- Any script or shell call that hard-codes `tmux` — grep + migrate

### Build pipeline

`/opt/atmux/<v>/bin/tmux` is built-from-source as part of atmux release process (NOT runtime download per security posture):

1. Source: tmux upstream tag (e.g. `3.6a`)
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
- Backward compat: if vendored binary absent + ATMUX_TMUX_BIN unset, fall back to system tmux (warn-once via logger)

**SECURITY lane** — bundling a binary adds supply-chain surface:
- Tmux is C code with active maintenance; CVE feed monitoring required (per CHANGELOG mention above)
- Build determinism: same source + deps + flags → same binary (reproducible-builds-style verify; SBOM published)
- Operator may audit the vendored binary; SHA256 published per release

**DOCS lane** — sweep:
- ADR-162 §Amendment cross-link ADR-191 (cockpit socket isolation + binary isolation: complete tmux-infrastructure ownership)
- ADR-163 (bundled tmux 3.6a) — supersede if pin version changes; cross-ref this ADR
- README operator guidance: how to override via ATMUX_TMUX_BIN
- RUNBOOK on rolling back to system tmux (escape valve documented)

### What we give up

- **Install size**: +1-2MB per release tarball
- **Build complexity**: CI needs build deps for tmux (libevent / ncurses / etc); release-engineering surface grows
- **Maintenance overhead**: vendored tmux needs periodic upgrade tracking; operator-relevant CHANGELOG entries on every bump

### Rollback path

`ATMUX_TMUX_BIN=/usr/local/bin/tmux atmux <verb>` always restores system-tmux behavior. Per-invocation; no global state to revert.

For full-fleet rollback (drop the vendored binary entirely), delete `/opt/atmux/<v>/bin/tmux` + atmux falls through to system tmux per `resolveTmuxBin()` step 3. Install.sh release after rollback omits the build step.

## Open questions

1. **(LOW reversibility) Initial pin version**: tmux 3.6a per ADR-163 default. Alternative: pin OLDER (3.4 — no PANE-ACTIVITY `#()` re-eval) which sidesteps the ADR-190 fork-storm hazard at the binary level (in addition to the conf-level TTL-cache mitigation). Recommendation: STICK with 3.6a — operator's daily-driver tmux is also 3.6a; matching versions reduces operator-cognitive-load. ADR-190 §Rule 1+2 mitigations cover the fork-storm sufficiently.

2. **(LOW reversibility) Distribution format**: built binary in release tarball vs source-distribution + build-on-install. Recommendation: built binary (faster install; reproducible-builds verifiable via published SHA + reproducer command). Build-on-install adds build deps to install.sh and is slow.

3. **(LOW reversibility) Cross-platform support**: atmux runs on Linux (hax) + macOS (operator local). Vendored binary must be built per-platform. Recommendation: ship per-platform tarballs; install.sh selects the right one via `uname -s`. Same complexity tier as existing atmux multi-platform CI; no new surface.

4. **(LOW reversibility) Static vs dynamic linking**: static = portable but bigger; dynamic = relies on system libevent/ncurses (the very libraries we're trying to isolate). Recommendation: static where possible (libevent at least; ncurses can be either). Reviewer signs off on link posture per build engineer's call.

5. **(LOW reversibility) Bin namespace clash**: `/opt/atmux/<v>/bin/tmux` conflicts with operator running `tmux` from PATH. Resolution: atmux callers use absolute path via `resolveTmuxBin()`; operator's PATH still hits system tmux. No actual clash. Open to discussion if operator-ergonomics suffers.

## Implementation status

Tracked under Epic e-162046c7 (driver dispatch 2026-05-23, "ship the unshipped"). Source already ratified the technical decision 2026-05-21; this section records what landed when.

**2026-05-23 — Resolver helper + spawn-site migration (be-1)**

- `src/core/resolve-tmux-bin.ts` — `resolveTmuxBin()` helper landed with the 3-tier chain wired (override → vendored at `/opt/atmux/current/bin/tmux` → system `tmux` on PATH + warn-once). Injectable env / existsSync / warn / state seams mirror `resolveDefaultListenerBinary` (`src/abstractions/native-listener.ts`) for parity. Per-process memoization via module-scope state; tests pass their own state record for isolation. Unit coverage 100% lines / 100% funcs in `tests/unit/core/resolve-tmux-bin.test.ts`.
- Call-sites migrated to consume `resolveTmuxBin()`:
  - `src/abstractions/tmux.ts` — `tmuxRunRaw`, `loadBuffer`, `attachSessionInheritStdio` (the 3 spawn primitives in the typed wrapper).
  - `src/abstractions/fallback-cage.ts` — Tier-3+ `sudo -u <agent> env … <tmux>` cage spawn + the operator-tier `capture-pane` post-mortem + the Tier-3+ `kill-session` teardown.
  - `src/verbs/poke.ts` — `sendCageBrief` paste-buffer load/paste for both operator + Tier-3+ paths.
  - `src/verbs/doctor.ts` — `defaultTmuxSpawn` baseline for the tmux-version probe family.
  - `src/core/cursor-recipes/fix-supervisor-missing.ts` — `list-windows` detect probe.
- Header comment in `src/abstractions/tmux.ts` updated — every spawn now reads `cmd: resolveTmuxBin()` instead of the `cmd: "tmux"` literal called out in the original ADR-004 §Socket-injection block. Binary resolution lives in the same closure layer as socket pinning.
- `atmux doctor` probe `checkVendoredTmuxBinary` (src/verbs/doctor.ts) — two yellow rows possible: `vendored-tmux-missing` (binary absent → resolveTmuxBin falls through to system tmux) + `vendored-tmux-version-drift` (binary present but `tmux -V` doesn't match the ADR-191 3.6a pin). Self-clearing post-`build:install`. Hooked into the main `doctor()` orchestrator next to `checkTmuxVersionMismatch`. 7 unit tests cover all branches (absent / pinned / drift / unparseable / non-zero exit / throw / custom path+version).

**Pending (subsequent landings on Epic e-162046c7)**

- `package.json::build:install` extension — fetch + build + install tmux 3.6a alongside the existing `atmux` / `atmux-listener` / `atmux-orchd` / `atmux-cockpit-mirror` artefacts. Gated on driver direction re: build-from-source-in-CI vs pre-built binary tarball per DoD#1 + ADR-191 §OQ2.
- README operator guidance — how to override via `ATMUX_TMUX_BIN`.
- RUNBOOK rollback note — drop `/opt/atmux/<v>/bin/tmux` + atmux falls through to system tmux on next spawn.
- CHANGELOG `[Unreleased] §Added` — vendored tmux binary.
- SECURITY.md — supply-chain posture (tmux CVE monitoring + per-release SHA256 publication).
- ADR-162 §Amendment cross-link this ADR (cockpit socket isolation + binary isolation: complete tmux-infrastructure ownership per the operator's framing).

## Cross-refs

- ADR-162 (atmux owns tmux infrastructure — cockpit socket isolation; this ADR completes the binary side)
- ADR-163 (bundled tmux 3.6a — pin version reference)
- ADR-190 (tmux statusline scaling — sibling Epic e-63c97ed8 lands FIRST per operator order; this Epic is the insulation layer on top)
- ADR-171 (tmux.conf.local override — operator escape valve precedent for personalization)
- Memory `project_atmux_install_topology` (existing `/opt/atmux/<v>/bin/<cmd>` install pattern; vendored tmux fits the same shape)
- ASK 1 of driver dispatch driver-2026-05-20-13:25-MYT
- Operator-dotfiles `ee009cc` (cross-Epic context — Epic e-63c97ed8 ports helpers from there)

# RUNBOOK — atmux build:install + release-event verify

Operator-driven procedure for cutting a new atmux release into the canonical install topology + verifying the cron-armed verbs the new binary unlocks. Pairs with [ADR-147](adr/147-ombudsman-and-release-notes.md) §release-event triggers and [ADR-134](adr/134-in-team-auto-merger.md) §T7 cron-install templates.

## Install topology (canonical, per [ADR-047](adr/047-canonical-install-topology.md))

```
/usr/local/bin/atmux  →  /opt/atmux/current/bin/atmux
                                ↓
                         /opt/atmux/current             ← symlink (atomic swap point)
                                ↓
                         /opt/atmux/<version>/bin/atmux ← versioned binary (bun --compile output)
```

Old versions preserved under `/opt/atmux/<version>/` for one-line rollback (see §Rollback).

## Cut procedure (driver / deploy member only)

1. **Bump version**. Edit `package.json::version` (e.g. `0.7.2 → 0.8.0`). Semver call:
   - **MAJOR** — any removed verb / breaking schema / breaking config-block deprecation removal.
   - **MINOR** — new verb (`committer`, `ombudsman`, …) / new cron-install template / new schema field / new ADR-named surface; all backward-compat.
   - **PATCH** — bug fix / no surface change.

2. **Roll CHANGELOG**. Add a `### 🟢 Shipped — atmux <V> install (<task-id>, <YYYY-MM-DD>)` row at the top of `[Unreleased]`. Include semver rationale + rollback path. Formal `## [V] — <date>` named-section cut can defer to release-housekeeping follow-up (per-section glyphs encode shipped-vs-pending in place).

3. **Commit on trunk** (`geoyws`). `package.json` + `CHANGELOG.md` only; conventional-commits subject (`chore(deploy): bump A.B.C → X.Y.Z + atmux build:install (t-…)`); body documents bump rationale + smoke targets.

4. **Run `sudo "$(command -v bun)" scripts/build-install.ts`** from the trunk worktree (`/root/work/src/atmux` or equivalent). The release flow resolves Bun before sudo and the build-install script stages into a private scratch tree, then:
    1. compiles the host `atmux` binary into the stage root and records its SHA
    2. builds the listener and cockpit mirror binaries and records their SHAs
    3. builds vendored tmux 3.7c from the pinned source archive SHA/build command, rewrites the staged Mach-O closure on Darwin, and records the staged binary and dylib hashes after the rewrites land
    4. refreshes `/opt/atmux/<V>/templates` and `/opt/atmux/<V>/plugins` from the repo copies ← static-assets ship (added per c-003a2a4c / t-17d413b1: compiled bun's `import.meta.dir` walks $bunfs to `/templates` so `atmux init` + brief reads need on-disk templates alongside the binary; the resolver at `src/core/templates-dir.ts` probes `<execPath>/../templates` as the installed-mode fallback after the dev-mode probe misses)
    5. writes the stage manifest, validates the staged bytes, and only then retargets `/opt/atmux/current` ← atomic flip
    6. retargets `/usr/local/bin/atmux`

5. **Push trunk**. `git push origin geoyws` — surfaces the version bump to other members' `git fetch` views.

## Post-install verify (release-event)

Per ADR-147 §release-event triggers. Required acceptance gate before the deploy is signed off — a cron-line installed during an earlier release cycle (`atmux cron-install --template <name>`) sits ARMED-but-no-op against a binary that pre-dates the verb; the release-event verify is what flips ARMED → DRAINING.

### A. `--version` round-trip

```bash
/usr/local/bin/atmux --version
# expect: atmux <V>
```

### B. Verb-presence smoke for newly-installed surfaces

For every new verb / sub-verb the release adds, exercise its happy path under the **cron environment** (so the verify is byte-equal to what cron will actually run):

```bash
# Template — replace <verb> + args with the actual surface.
PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin \
TMUX_TMPDIR=<team-tmux-dir> \
ATMUX_DIR=<team-atmux-dir> \
/usr/local/bin/atmux <verb> <args>
```

Concrete examples (atmux team, 0.8.0 cut):

```bash
# ombudsman tick — expect "sentinel empty — no-op" (steady state) or
# "filed task t-XXXXXXXX" (queue had work)
PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin \
TMUX_TMPDIR=/root/work/src/atmux/.atmux/tmux \
ATMUX_DIR=/root/work/src/atmux/.atmux \
/usr/local/bin/atmux ombudsman tick

# committer --sweep — expect "team='<t>' base='<b>' checked=N queued=… refused=… skipped=…"
PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin \
TMUX_TMPDIR=/root/work/src/atmux/.atmux/tmux \
ATMUX_DIR=/root/work/src/atmux/.atmux \
/usr/local/bin/atmux committer --sweep
```

### C. Cron-log tail proof (pre-install vs post-install)

`tail` the relevant cron log to confirm the pre-install `unknown verb` line shows the previous fire and the post-install line shows real work (or a sentinel-empty no-op):

```bash
tail -5 <atmux-dir>/logs/<verb>.log
# pre-install line:   atmux: unknown verb: <verb>
# post-install line:  <real verb output — drain receipts / state-machine ticks / no-op message>
```

This step is **diagnostic-only** — the manual `B` invocation under cron env is the authoritative acceptance signal. Cron-log tail is the operator-visible audit trail.

### D. ADR-135 hyphenated-window-name resolver smoke (releases ≥ 0.8.0)

If the release includes the ADR-135 resolver, the simplest proof is: any `/usr/local/bin/atmux send <member> "<msg>"` from a driver pane to a member pane now succeeds without `tmux: can't find window: <emoji><member>`. Releases predating ADR-135 fail loudly on the first cross-team send.

Post-[ADR-161](adr/161-default-member-prefix-and-sort-verbs.md) §Part B (TR2 commit 5b5981d), the resolver also handles the `_-prefix` form (`🧭_lead`, `🗺️_planner`, etc.) for default-role members; `resolveExistingWindowName` accepts both shapes during the migration window. The smoke command below works against either form — no operator action needed.

```bash
/usr/local/bin/atmux send lead "smoke ping from deploy-install"
# expect: exit 0, no "can't find window" stderr
```

## Rollback (one-line, atomic)

```bash
sudo ln -sfn /opt/atmux/<prior-version> /opt/atmux/current
```

Next cron tick picks up the rolled-back binary. In-flight long-lived TUIs keep reading from `state.db`; cron-fired verbs re-exec the binary every tick.

Preserved versions enumerable via `ls /opt/atmux/`. Each is a self-contained `bin/atmux` ELF reachable by direct path.

## Vendored tmux binary (ADR-191)

The install pipeline now ships its own `/opt/atmux/<version>/bin/tmux` and wires the installed tree to tmux 3.7c. Ordinary atmux calls still use `resolveTmuxBin()` (`src/core/resolve-tmux-bin.ts`) with the legacy chain `ATMUX_TMUX_BIN` override → system `tmux` on PATH; they do not auto-route through the vendored binary. The future `aca` / `aco` vendored cockpit path will opt into `resolveVendoredTmuxBin()` and its own socket/config/resurrect namespace, fail closed, and never fall back to host tmux. The operator's daily-driver `tmux` from the shell and the old Homebrew tmux/resurrect plane are untouched. The older 3.6a wording in the historical ADR text is historical only.

### Verify after install

```bash
/opt/atmux/current/bin/tmux -V                  # → tmux 3.7c
atmux doctor 2>&1 | rg 'vendored-tmux'          # → no row (green) when binary present + pinned-version match
```

`atmux doctor` warns yellow `vendored-tmux-missing` when `/opt/atmux/current/bin/tmux` is absent. That is an install failure signal, not a deployment fallback: the vendored plane is considered incomplete until the binary is present. `vendored-tmux-version-drift` stays yellow when the binary is present but not 3.7c (hand-staged binary or stale install). Both rows self-clear after the next clean `build:install`.

### Override for testing

```bash
ATMUX_TMUX_BIN=/path/to/operator-tmux atmux <verb>   # process-scope, wins the legacy/live resolver

ATMUX_VENDORED_TMUX_BIN=/opt/atmux/current/bin/tmux atmux <future-vendored-verb>   # prepared seam only
```

Operator-pinned for testing a different tmux version, local dev build, or CI rig deliberately using system tmux. Override is process-scope; no global state.

### Rollback the vendored binary

```bash
# Preferred: select a previously verified complete release tree.
sudo ln -sfn /opt/atmux/<known-good-version> /opt/atmux/current
/opt/atmux/current/bin/tmux -V                    # must print tmux 3.7c
```

Do not delete the vendored binary as a routine rollback. Deliberately removing it disables `aca` / `aco`: the vendored plane fails closed until a complete exact-3.7c release tree is restored. The old Homebrew tmux/resurrect plane remains independent and untouched throughout. Rebuild a complete candidate with `bun run build:install` from a trunk worktree when no verified rollback tree exists.

### Operator daily-driver tmux

UNAFFECTED. The vendored binary lives at an explicit absolute path; the operator's shell still resolves `tmux` (bare) via PATH to whatever the operator has installed personally. `which tmux` from an operator shell should report the operator's personal install, never `/opt/atmux/current/bin/tmux`.

## Trigger discipline (parking-lot Tasks)

ADR-147 release-event verify tasks (e.g. `t-3b2d1a26`) are **dispatch-only** — they sit `todo` with `priority=2` and no owner. Workers must NOT `claim --next` them; the driver / lead dispatches explicitly post-build:install (`atmux dispatch <member> t-<release-event-id>`). The Task body opens with `⚠️ DO NOT CLAIM via claim --next` as the convention marker; reviewer flags any self-pickup.

When a new verb / cron template lands in a future release, the recommended pattern is to file a sibling parking-lot Task at the same time (cross-link the EPIC) so the post-install verify isn't lost to memory.

## Cross-refs

- [ADR-047](adr/047-canonical-install-topology.md) — canonical install topology + `/opt/atmux-stable/` optional fallback tier.
- [ADR-134](adr/134-in-team-auto-merger.md) §T7 — `cron-install --template committer-sweep` shape.
- [ADR-147](adr/147-ombudsman-and-release-notes.md) — ombudsman role + release-notes + the release-event trigger pattern.
- [ADR-135](adr/135-cockpit-naming-convention.md) — hyphenated-window-name resolver (smoke target above).

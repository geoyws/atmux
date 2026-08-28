# ADR-200: Install wizard for atmux — guided first-run setup with prereq probe, cockpit init, account pool config, and per-project bootstrap

**Status**: Accepted — ratified by driver 2026-05-23 (Honker substrate on trunk via Epic A/B/C + orchd P1 merges; deferral condition met). Implementation EPIC [e-b545b70c](../tasks/) carries the wizard impl follow-up — substrate is no longer a blocker.
**Date**: 2026-05-20
**Driver-ref**: 2026-05-20 evening design session — operator request "make sure that we have a wizard to install atmux as well" + "gate it after honker"
**Cross-refs**: [ADR-126](126-sqlite-state-store.md) (state.db introduces install-side concern about extension-load), [ADR-162](162-cockpit-socket-isolation.md) (cockpit tmux socket setup the wizard automates), [ADR-077](077-superdoctor-cockpit-role.md) (medic/superdoctor role wired up at first-run), [ADR-091](091-kanban-driven-auto-merge.md) (epic-team spawn surface that the wizard exposes config for), [ADR-192](192-cron-arm-idempotency-contract.md) (wizard installs the per-team cron blocks), [ADR-199](199-claude-account-pool-for-epic-team-spawning.md) (pool config step), Honker substrate ADR (TBD — forward-ref D6).

## Context

atmux's current install + first-run topology is **artisanal**. The expected sequence is:

1. Clone the repo + build via `bun install && bun run build`.
2. Manually symlink `/usr/local/bin/atmux → /opt/atmux/current` (versioned dirs for rollback per memory `project_atmux_install_topology`).
3. Discover prereqs by trial-and-error (bun ≥1.3.13, tmux ≥3.4 per `package.json::engines`; sqlite for state.db; optional claude-cli, cursor-cli).
4. Per-project: cd into project root, run `atmux team bootstrap` (or hand-write `.atmux/team.json`), then `atmux start <team>`.
5. Cockpit setup (ADR-162 dedicated socket, ADR-077 medic role, sentinel-cron arming per ADR-132) requires running several disjoint verbs that an operator is expected to have memorized.
6. Claude account configuration is hand-managed — per memory `feedback_spawn_epic_claude_account_inheritance_gap`, `claudeAccount` inheritance is broken so first-time epic-team spawns 401 until the operator hand-patches the team.json.

The friction shape:

- **No prereq probe** — missing `tmux`, wrong `bun` version, or sqlite-without-loadable-extension-support (macOS default) surface as opaque runtime errors deep in `atmux start`.
- **No idempotent re-runnable bootstrap** — re-running individual verbs (`bootstrap`, `migrate-state`, `cron-install`) works but the operator has to remember the order. New cages on new hosts mean repeating the same un-documented dance.
- **Cockpit setup is invisible** — the operator doesn't know ADR-162 exists when they first install. Discovers it only when something breaks because they're on the wrong tmux socket.
- **No `--yes` mode** — every step that warrants confirmation is currently a separate verb call (sometimes interactive, sometimes silent); CI / agent-mode installs need a way to accept defaults non-interactively.
- **Honker (incoming, per the forthcoming substrate ADR)** adds another install-side concern — the loadable extension binary needs to be present + linked, and macOS needs `Database.setCustomSQLite()` configured. Without a wizard, this becomes a third manual setup step that everyone re-derives.

The proven shape for this is a **guided wizard** — a single entry-point script that walks numbered steps, checks each prereq, asks before each mutation, caches what it already did, and refuses to proceed if a prereq is broken. The same TUI shape used by other monorepo setups in adjacent projects.

## Decision

Adopt a **two-layer wizard**:

- **Layer 1: system-level install + cockpit setup** — `./scripts/install.sh` (run-once-per-host, idempotent on re-run).
- **Layer 2: per-project bootstrap** — `atmux init` verb (run per repo, re-runnable).

Both follow the same TUI conventions (numbered steps, idempotent, `--yes` agent-mode, `--force` cache-bypass, branded header). Layer 2 depends on Layer 1 having installed the binary.

### D1 — Layer 1: `scripts/install.sh` system-level wizard

Single bash script at `scripts/install.sh` in the repo root. Entry surface:

```bash
# Local clone:
git clone <repo> && cd atmux && ./scripts/install.sh

# Curl one-liner (future, post-publish):
curl -fsSL https://<install-url>/install.sh | bash
```

**Step set (numbered, idempotent, asks before mutating):**

1. **Prereq probe** — verify `bun ≥1.3.13`, `tmux ≥3.4`, `git`, `sqlite3` (with extension-load support — see D6 for macOS handling), optional `claude` CLI, optional `cursor` CLI. Each prereq has an install hint (e.g. "missing bun → curl -fsSL https://bun.sh/install | bash"). Missing required prereqs hard-fail; missing optional prereqs warn + continue.
2. **Build the binary** — `bun install && bun run build` produces `dist/atmux` (or the bun-compiled standalone binary per memory `project_atmux_install_topology`).
3. **Install the binary** — symlink `/usr/local/bin/atmux → /opt/atmux/<version>` with `/opt/atmux/current` as the rolling pointer (matches existing install topology). Re-runs verify symlink + version; no-op if already current.
4. **Cockpit init** — create `~/.atmux/cockpit.json` scaffold (with sane defaults), set up the dedicated cockpit tmux socket per ADR-162, install the cockpit-level cron blocks (sentinel tick per ADR-132, medic tick per ADR-077). Idempotent — re-runs verify state.
5. **Honker substrate install** — see D6.
6. **Claude account pool config** — interactive step that discovers `~/.claude-*` directories, asks which to include in the pool (per ADR-199), validates each by running a `coordination:budget` probe. Operator can skip + configure later via `atmux pool add`. Persists to `~/.atmux/cockpit.json::claudeAccountPool[]`.
7. **Post-install verification** — runs `atmux doctor` to surface any drift; reports green/yellow/red per probe. Doctor failures are non-blocking (wizard exits 0 with a warn summary) — the wizard's job is to install, not to fix.

**Branded TUI header** with version + step counter (`step 3/7`). Per-step output: `✓` for already-done, `→` for in-progress, `✗` for failed, `⏭` for skipped.

### D2 — Layer 2: `atmux init` per-project wizard

Verb on the atmux CLI (not a separate script). Entry surface:

```bash
cd my-project && atmux init                  # interactive
cd my-project && atmux init --yes            # agent / CI mode
cd my-project && atmux init --team alpha     # name the team explicitly
```

**Step set:**

1. **Probe `.atmux/team.json` existing state** — if present, switch to "verify + reconcile" mode; if absent, "fresh init" mode.
2. **Team config** — interactive prompts for team name, lane set (FE/BE/DB/OPS/TEST/REVIEW/MISC default), default members, sentinel/jury choice. Defaults pulled from `~/.atmux/cockpit.json::defaults`.
3. **State.db init + migration** — runs `atmux migrate-state` (idempotent — no-op if already on the SQL canonical per ADR-126). If a legacy `kanban.json` is present, prompt + migrate.
4. **Submodule detection** — if the repo has submodules, offer to run `recursive-checkout.sh` to align them (matches the `/rcheckout` skill pattern in operator dotfiles per memory).
5. **Per-team cron arming** — install the per-team marker-sandwich cron block (ADR-083 idempotency + ADR-192 arm contract). Operator can skip if running `atmux` ad-hoc without cron-backed whip/report cycles.
6. **First `atmux start` offer** — wizard ends by asking "start the team now?" — yes → `atmux start <team>`; no → exits cleanly with the operator's next-command hint.

### D3 — Idempotency + cache

Both wizards cache step-completion fingerprints in `~/.atmux/state/install-cache.json` (Layer 1) and `.atmux/state/init-cache.json` (Layer 2). Each step's fingerprint is content-derived (e.g. `prereq-probe` fingerprint = hash of `bun --version | tmux -V | sqlite3 --version`).

Re-runs:

- Skip steps whose fingerprint matches (`✓ step N — cached`).
- Re-run steps whose fingerprint changed (`→ step N — drift detected, re-running`).
- `--force` bypasses cache; every step re-runs.

Idempotency contract: every step must be safe to re-run. Steps that aren't idempotent (e.g. account-pool config which adds entries) must check existing state before mutating and prompt the operator on duplicate.

### D4 — Flag set

Both wizards accept the same flag set (mnemonic for the operator):

- `-y` / `--yes` — auto-accept every prompt default. Required for agent / CI mode. Defaults encode the safe path (skip on N, proceed on Y).
- `-f` / `--force` — bypass step-completion cache; re-run every step.
- `--no-start` — exit after the final step instead of offering `atmux start`. CI/smoke mode.
- `-h` / `--help` — usage + flag set.
- Env equivalents: `ATMUX_INSTALL_YES=1`, `ATMUX_INSTALL_FORCE=1`, `ATMUX_INSTALL_NO_START=1` (alongside the existing `ATMUX_*` env-var convention).

### D5 — TUI styling

Same convention as other guided setups in adjacent projects:

- Color via `tput` (graceful fallback if no TTY).
- Step counter in header: `step N/M — <title>`.
- Per-line glyph: `✓` done · `→` in-progress · `✗` failed · `⏭` skipped · `?` prompt.
- Section separators on phase boundaries.
- Wait-points clearly marked (`waiting for: <external action>` — e.g. operator must verify account creds before continuing).
- Failure mode: hard-fail step → exit with a single-screen summary of what's done, what's failed, and the specific command to retry.

### D6 — Honker substrate install step (the gating dependency)

Layer 1 step 5 installs the Honker SQLite extension:

- Linux (hax — primary deploy target): download or build the loadable extension binary, place at `~/.atmux/extensions/honker-<version>.so`, persist path to `~/.atmux/cockpit.json::sqliteExtensions[]`. `bun:sqlite` calls `loadExtension()` against this path at process start.
- macOS (operator dev workstation): same as Linux but additionally invokes `Database.setCustomSQLite()` first (Apple's bundled SQLite has extension loading disabled). Wizard probes via `which sqlite3` + version to detect Homebrew sqlite at `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` and prompts to `brew install sqlite` if absent.
- Verification: wizard runs a smoke test (`loadExtension()` + a NOTIFY/LISTEN round-trip) before marking step ✓.

**This step is the reason the ADR is gated.** Until the Honker substrate ADR lands + the extension's install/distribution story is settled, the wizard has nothing to install at this step. Releasing the wizard without it would mean a deprecated step-5 the next release amends — better to wait.

While gated, operators continue with manual install (the artisanal flow in Context). The friction is acceptable for the bounded set of operators currently running atmux. Once Honker substrate ships, this ADR's impl-EPIC follows.

### D7 — Curl-one-liner deferral

The `curl https://<url>/install.sh | bash` form is **explicitly deferred** until:

1. A canonical install URL is published (atmux has no domain today).
2. Binary distribution story is settled (today: clone + bun build; future: pre-built binaries on GitHub releases or similar).

Until then, install is "git clone + `./scripts/install.sh`" only. The wizard contract is identical; only the entry surface changes.

## Consequences

**Becomes easier:**

- First-time install on a fresh host: one command (`./scripts/install.sh`) instead of an N-step undocumented dance.
- Onboarding new operators / dev workstations: prereq probe surfaces missing/wrong-version tools immediately with install hints.
- CI / agent-mode installs: `--yes` flag deterministic; defaults encode safe path.
- Re-runs after host changes / version bumps: idempotent steps + cache means re-run picks up only what drifted.
- Honker substrate adoption (post-gating): wizard handles the macOS `setCustomSQLite` story for every operator; no per-operator re-derivation.
- Per-project bootstrap: `atmux init` replaces the team-bootstrap + migrate-state + cron-install + first-start sequence.

**Becomes harder:**

- New install-side surface to maintain — every new mandatory dep / config field needs a wizard step. Tradeoff: this is exactly the surface that turns silent breakages into explicit probe-fails.
- TUI complexity in bash (Layer 1) — color/glyph handling, terminal detection, fallback when TTY absent. Mitigated by reusing the same conventions as adjacent monorepo setups.
- Test surface: idempotent wizard steps need test coverage that re-runs are safe. Each step's idempotency check is a unit test.
- Onboarding burden for ADR drift: when an existing verb's contract changes (e.g. `atmux migrate-state` adds a flag), the wizard step needs an amendment in the same commit.

**Risks + mitigations:**

- **Risk**: Wizard masks a real install failure by skipping a broken step. **Mitigation**: hard-fail on required-prereq missing; cache fingerprint includes the prereq version, so a drift detects + re-runs.
- **Risk**: macOS dev workstation install fails on the Honker extension step because Apple sqlite blocks extensions. **Mitigation**: wizard explicitly probes for Homebrew sqlite + prompts to `brew install sqlite`; failure mode is documented + actionable, not opaque.
- **Risk**: `--yes` mode silently picks an unsafe default. **Mitigation**: defaults are explicitly encoded as the safe-path branch (skip on N, proceed on Y) — every default is documented in `--help` so agent operators can pre-verify.
- **Risk**: Two-layer wizard fragments the install story (operators run Layer 1, forget Layer 2, hit errors on first `atmux start`). **Mitigation**: Layer 1's final step prints the next command (`cd <project> && atmux init`); Layer 2 detected-but-missing surfaces in `atmux doctor`.
- **Risk**: Wizard goes stale relative to the underlying verbs (e.g. `atmux migrate-state` ships a new required flag and the wizard step doesn't update). **Mitigation**: wizard steps invoke verbs at their public surface — same as any other caller. Verb-level contract tests catch the drift.

## Out of scope (deferred)

- **Pre-built binary distribution** — wizard assumes `bun build` from source. Pre-built binaries on GitHub releases are a separate follow-up.
- **Auto-updater** — wizard doesn't pull new versions. Operator runs `git pull && ./scripts/install.sh` (idempotent re-run picks up the new version).
- **Uninstall verb** — not in scope; operator removes the symlink + `/opt/atmux/<version>/` manually. If demand surfaces, follow-up ADR.
- **Cross-host install** — wizard is single-host. Multi-host atmux cockpits are out of scope.
- **GUI wizard** — TUI only. No Electron / web-based installer.
- **Curl one-liner publication** — deferred per D7 until install URL + binary distribution settles.

## References

- ADR-126 — SQLite state store (motivates the loadable-extension install concern)
- ADR-162 — cockpit socket isolation (Layer 1 step 4)
- ADR-077 — cockpit superdoctor / medic (Layer 1 step 4 wires up)
- ADR-091 — kanban-driven auto-merge / epic-team spawn (wizard exposes config)
- ADR-132 — pluggable sentinel (Layer 1 step 4 arms the cron tick)
- ADR-192 — cron-arm idempotency contract (Layer 2 step 5 follows)
- ADR-199 — Claude account pool (Layer 1 step 6 configures the pool surface)
- Honker substrate ADR (TBD — forward-ref D6; the gating dependency)
- memory `project_atmux_install_topology` — current install topology (symlink + /opt/atmux versioned dirs)
- memory `feedback_spawn_epic_claude_account_inheritance_gap` — pain point Layer 1 step 6 resolves
- memory `project_honker_pubsub_rehaul_design` — substrate dependency the wizard installs

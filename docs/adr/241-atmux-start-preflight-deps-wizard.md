# ADR-241: `atmux start` preflight wizard — installs vendored deps on cold hosts

**Status**: Accepted (operator-direct 2026-05-25 *"let's do the recommended"*)

**Date**: 2026-05-25

**Driver-ref**: 2026-05-25 conversation:
- *"we can start making the next atmux start run on vendored tmux"*
- *"that means atmux start will have a wizard to install the deps including vendored tmux and etc"*
- *"let's do the recommended"*

**Cross-refs**:
- [ADR-191](191-vendored-tmux-binary.md) §Pending — *"`package.json::build:install` extension"* + RUNBOOK rollback note. This ADR is the operator-facing wrapper around that landed `build:install`; the build script is the doer, the wizard is the on-ramp.
- [ADR-162](162-atmux-owns-tmux-infrastructure.md) / [ADR-163](163-bundled-tmux-binary.md) — *atmux owns tmux infrastructure* / *bundled tmux 3.6a*. The wizard makes the install side of those ADRs first-run-automatic instead of "operator reads RUNBOOK and runs `bun run build:install` by hand".
- [ADR-240](240-drop-superorchd-orchd-self-supervises.md) — sibling cleanup-pass ADR (same operator-direct session, same *"simpler is better"* framing). 241 + 242 are the constructive companions to 240's deletion.

## Context

ADR-191 ships the resolver (`resolveTmuxBin`) and names the install side as §Pending. On hax today, `/opt/atmux/current/bin/tmux` does not exist; `resolveTmuxBin` resolves to the host tmux on PATH. Net: ADR-191 is "wired but not dogfooded" — the resolver path is exercised on every spawn but it resolves to the same system binary it always did.

Operator just decided to land the vendored binary on this host. Two operator-facing paths exist today:

1. **Manual**: operator reads ADR-191 §Implementation status, runs `bun run build:install` (once that extension lands), verifies `/opt/atmux/current/bin/tmux -V` returns the pinned version, then runs `atmux start`. Three steps, one of them undocumented in a per-host runbook.
2. **Automatic**: `atmux start` checks for vendored deps at preflight and offers to install what's missing. One step.

Path 2 is what the operator asked for. This ADR specs it.

The same wizard applies to every vendored artifact under `/opt/atmux/<v>/bin/`, not just tmux — `atmux`, `atmux-orchd`, `atmux-listener`, `atmux-cockpit-mirror` are all candidates. The wizard treats them uniformly.

## Decision

### D1 — Preflight phase at top of `src/verbs/start.ts`

`atmux start` gains a preflight phase that runs before any cage-bringup, team-window-spawn, or kanban work:

1. **Probe each vendored artifact** at the canonical install path (`/opt/atmux/current/bin/{tmux,atmux-orchd,atmux-listener,atmux-cockpit-mirror,atmux}`). For each, record `present | absent`.
2. **Probe version pins** for present binaries (where a pin file or `-V` output exists): tmux against `tmux/PINNED_VERSION` per ADR-191 §"Pin file"; Rust binaries against the version baked into their `Cargo.toml` (compiled in via `env!("CARGO_PKG_VERSION")`). Record `pinned | drift | unknown`.
3. **If everything is present + on-pin**, skip the wizard entirely — preflight returns in <100ms, no operator interaction. Same-host re-runs of `atmux start` see no behavior change.
4. **If anything is absent OR drifted**, enter the wizard.

### D2 — Wizard shape

Interactive single-prompt confirmation, not a multi-step Q&A:

```
[atmux start] preflight: 2 vendored deps missing, 1 drifted.
  Missing : tmux (expected /opt/atmux/current/bin/tmux, pinned 3.6a)
  Missing : atmux-cockpit-mirror (expected /opt/atmux/current/bin/atmux-cockpit-mirror)
  Drift   : atmux-orchd (installed 0.8.25, source 0.8.26)
Install/rebuild via `bun run build:install`? [Y/n]
```

- Default `Y` (Enter accepts). Operator types `n` (or `--skip-deps` / `--non-interactive` was passed) → wizard skips the install + emits a one-line warning + continues to the team-bringup phase. Subsequent spawns hit the `resolveTmuxBin` fallback chain as today (`ATMUX_TMUX_BIN` → vendored → system); missing Rust binaries fall through to Bun fallbacks where they exist (per ADR-202 §VII degraded mode) or fail at spawn time where they don't.
- Operator accepts → run `bun run build:install` in the foreground. Stream stdout/stderr unfiltered to the operator's terminal. On non-zero exit: emit a one-line failure summary + skip the team-bringup phase entirely (an `atmux start` that couldn't provision its deps shouldn't paper over the gap by limping forward with system binaries). Operator's recourse is to read the build output, fix the underlying issue (missing libevent headers, network outage, etc.), and re-run `atmux start`.
- On success: re-probe (D1 step 1+2) once to confirm the install landed at the expected paths, then continue to the team-bringup phase.

### D3 — Flags + non-interactive escape

Three flags on `atmux start`:

- `--skip-deps` — preflight runs but the wizard prompt is auto-`n`. Use case: operator wants to start the fleet on system tmux deliberately (e.g. testing the fallback path, or on a host where the build step is broken).
- `--non-interactive` — preflight runs but the wizard prompt is auto-`Y`. Use case: CI / scripted-boot environments where stdin is closed and you want `atmux start` to either install deps or fail loudly (never hang on a prompt). Implicit when `!process.stdin.isTTY`.
- `--no-preflight` — skip the preflight entirely; jump straight to team-bringup. Use case: hot loops in tests / repeated `atmux start` calls during development where the cost of the per-call existsSync probe is annoying. Cheap escape valve; not for production paths.

`--skip-deps` and `--non-interactive` are mutually exclusive — set both → operator-actionable error (one says "don't install", the other says "install without asking"; conflict surfaces at flag-parse time).

### D4 — Marker file for fast-path

After a successful wizard run, write `~/.atmux/state/preflight-<version>.json` with:

```jsonc
{
  "atmux_version": "0.8.26",
  "installed_at": "2026-05-25T02:53:00Z",
  "binaries": {
    "tmux": { "path": "/opt/atmux/0.8.26/bin/tmux", "version": "3.6a" },
    "atmux-orchd": { "path": "/opt/atmux/0.8.26/bin/atmux-orchd", "version": "0.8.26" }
    // ... etc
  }
}
```

On next `atmux start`, if the marker file exists AND its `atmux_version` matches the current `/opt/atmux/current` symlink target, skip the per-binary version-pin probe (D1 step 2) — just confirm each path exists (cheap `existsSync`). Marker invalidation: any per-binary mismatch on the lightweight existsSync sweep → fall back to the full D1 probe + wizard. Manual invalidation: `rm ~/.atmux/state/preflight-*.json` (no verb).

### D5 — Out of scope

- **Cross-platform dep install** (apt-get libevent-dev etc). The wizard runs `bun run build:install`; whatever that script needs in terms of OS-level build deps is its problem, not the wizard's. If `build:install` fails because `libevent` headers aren't on the host, the operator sees that in the streamed output and handles it.
- **Auto-upgrade of vendored deps** outside the wizard. Drift detection in D1 step 2 triggers the wizard, but there's no background poller / cron / startup-skip for drift. Drift only matters at `atmux start` time; once the fleet is running, the existing binaries are pinned for that fleet's lifetime.
- **Per-team or per-driver vendored-tmux selection**. The resolver is process-global (ADR-191 §Decision). If we ever need typed override (e.g. epic teams on a different tmux pin than parent teams), that's a separate ADR — out of scope here.

## Consequences

- `atmux start` gets one new phase before any of its current work. Cold-host first-run becomes interactive (one prompt) but still single-command. Warm-host re-run is unchanged in behavior + adds <100ms preflight latency.
- ADR-191 §Pending §"`package.json::build:install` extension" is the load-bearing prerequisite. This ADR's wizard is dead weight until `build:install` actually fetches+builds+installs the binaries. Implementation order: (a) land `build:install` extension per ADR-191 §Pending, (b) land wizard per this ADR, (c) operator runs `atmux start` on hax and the vendored binary becomes the active tmux. No partial-rollout step needed.
- **`tests/unit/verbs/start.test.ts`** gets new coverage for: wizard-skipped-when-all-present, wizard-runs-on-absent, wizard-prompts-on-drift, `--skip-deps` skips prompt + warns, `--non-interactive` skips prompt + auto-installs, `--no-preflight` skips probe entirely. Mock the `build:install` invocation via injectable seam (same shape as existing test seams in `resolve-tmux-bin.ts`).
- **README** picks up a §"First run on a new host" section: "run `atmux start`; on first cold-host start, you'll be prompted to install vendored deps. Accept (default) to land them at `/opt/atmux/<v>/bin/`." Same-commit per atmux convention.
- **CHANGELOG `[Unreleased] §Added`** — preflight wizard for vendored-deps install at `atmux start`.

## Reversal

If the wizard proves intrusive or fragile:

- Set `ATMUX_START_NO_PREFLIGHT=1` env var or always pass `--no-preflight` to disable the phase entirely. Operator falls back to running `bun run build:install` manually before `atmux start`. No code rollback needed.
- For full revert (delete the preflight code), `src/verbs/start.ts` shrinks by the wizard block + the marker file becomes orphaned (`~/.atmux/state/preflight-*.json` — harmless leftover, operator can rm). ADR-191 §Pending bullet for `build:install` extension stays as the only operator-facing on-ramp.

The wizard is an ergonomic layer over a tool (`build:install`) that already exists or will exist as a standalone verb. Reverting the wizard doesn't undo any decision below it.

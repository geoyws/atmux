# ADR-063: Port `cockpit-rebuild` from operator dotfiles into `atmux cockpit` verb family

**Status**: accepted (implementation landed 2026-05-08)
**Date**: 2026-05-08

2026-09-01 amendment: cockpit placeholder panes must use a portable persistent loop; `sleep infinity` is invalid on BSD/macOS and must not back a live cockpit window.

> **2026-05-14 cockpit-topology updates** — cockpit window order
> expanded by ADR-132 + ADR-133, then renamed by ADR-135:
>
> | # | Window | Authorizing ADR |
> |---|--------|----------------|
> | 1 | `_superdriver` (was `superdriver`) | ADR-063 (this ADR) + ADR-135 §D2 |
> | 2 | `_medic` (was `medic` / `superdoctor`) | ADR-077 + ADR-133 + ADR-135 §D2 |
> | 3 | `_martinet` (was `martinet`; pluggable fleet-wide whip-manager) | ADR-132 §D2 + ADR-135 §D2 |
> | 4..N | per-team viewers (plain team names, no underscore) | ADR-063 (this ADR) |
>
> Backward-compat: each cockpit-level window is opt-in via
> `cockpit.json.medic` / `cockpit.json.martinet` `enabled` flags.
> Cockpit rosters that pre-date these changes (no `medic` / `martinet`
> blocks) retain the original shape (W1 _superdriver + W2..N per-team
> viewers). Loader migration coerces legacy `superdoctor` block →
> medic semantics on read per ADR-133 §D2 deprecation window.
> Cockpit-session and cockpit-role-window names migrate in-place
> (`atmux_teams → atmux_cockpit`; `superdriver → _superdriver`;
> `medic → _medic`; `martinet → _martinet`) on rebuild per ADR-135 §D4
> — idempotent, preserves pane PIDs and attached clients. Verb
> implementation: T8 of ADR-132 (commit t-fb5e4c1f); ADR-135 rename
> (commit t-b3958ee6).
**Driver-ref**: 2026-05-08 hax session — operator ran `cockpit-rebuild` to bring up sopx + atmux teams (with unum disabled via newly-added per-team enable toggle). The rebuild failed mid-cycle: atmux-bun's `start` reported a tmux session created, then immediately failed connecting to `/tmp/atmux-sopx/sock` (ENOENT). Two issues surfaced:
1. The dotfiles script's hardcoded cage paths (`<project>/.atmux/tmux/tmux-0/default`) disagree with atmux-bun's hardcoded socket paths (`/tmp/atmux-<team>/sock` per `core/common.ts:512`). This was a bash-era assumption — atmux-bun's `start` verb doesn't honour `team.json.tmuxTmpdir` yet (`src/verbs/start.ts` file header §"Socket resolver — Phase 2 architectural decision pending").
2. atmux-bun doesn't `mkdir -p` the socket parent before `tmux -S new-session`, so first bring-up on a fresh box fails silently.

Both fixed inline today (cheap fix in dotfiles script: switched cage paths to `/tmp/atmux-<team>/sock`, added `mkdir -p` guard). But the underlying split — orchestration logic in operator-private dotfiles, runtime in atmux — keeps drifting and will keep biting us.

## Context

`cockpit-rebuild` (lives at `~/work/journals/.sb/_dotfiles/bin/cockpit-rebuild.sh`, symlinked to `~/bin/cockpit-rebuild` by `_dotfiles/init.sh`) deterministically (re)builds the operator cockpit:

- Cockpit session `atmux_teams` on the operator's default tmux socket (window 1 = `superdriver`, windows 2..N = one nest-attach viewer per registered team) — per historical decision number 046 (no surviving ADR file).
- One per-team cage tmux server per team — per ADR-018 (per-team-tmux-socket-isolation).
- `bareWindowNames: true` on every team.json — per unlanded decision number 048.
- Registry trimmed to the canonical team set, existing emoji rosters preserved.
- `C-\` cage prefix re-applied on each cage (project-local cage paths miss atmux-bun's auto-prefix-on-`/tmp/atmux-tmux*` heuristic).
- Live-team protection: cages with running claude processes are NOT cycled unless `--force-cycle`.
- Per-team enable toggles (`ENABLE_SOPX=1`, `ENABLE_ATMUX=1`, `ENABLE_UNUM=0` etc.) gate every operation so a team can be brought up alone without losing the others' config.

Every line of that logic is generic atmux orchestration. Nothing in it is operator-specific *except* the roster (which 3 projects, which Claude account env prefix per project).

The script also encodes structural knowledge that atmux owns the source-of-truth for:

- Cage socket path (`/tmp/atmux-<team>/sock` per `core/common.ts:512`).
- Session name convention (`atmux_<team>` for IFCA-account teams, bare `atmux` for the dogfood team — per `getSessionName` in `core/common.ts`).
- Nested-attach pattern for cockpit windows (`while true; do tmux -S <sock> attach -t <session>:driver 2>/dev/null; sleep 1; done`).
- Claude account env prefix wiring (`CLAUDE_CONFIG_DIR=/root/.claude-<account> CLAUDECODE=1 CLAUDE_CODE_EFFORT_LEVEL=xhigh CLAUDE_GUARD_AGENT=1 claude --plugin-dir=... --permission-mode auto`) — written into each team.json's `tuiCommands.claude`.

When atmux-bun lands a change to any of these (e.g. socket resolver finally honours `team.json.tmuxTmpdir`, `getSessionName` defaults shift, `--permission-mode` flag rename), the dotfiles script silently breaks until the operator notices.

## Decision

Introduce an `atmux cockpit` verb family. Roster lives at `~/.atmux/cockpit.json` (atmux's canonical user-config home). Operator dotfiles symlink to it for version control. The dotfiles script becomes a thin wrapper around `atmux cockpit rebuild`.

### D1 — Verb surface

```
atmux cockpit reconcile [--no-cycle] [--force-cycle] # idempotent ensure-up (canonical)
atmux cockpit rebuild [--no-cycle] [--force-cycle]   # DEPRECATED alias for reconcile
atmux cockpit list                                    # show enabled/disabled teams
atmux cockpit add <team> --root <path> --account <id> # append a team to cockpit.json
atmux cockpit remove <team>                           # mark disabled (keeps config) or --hard to delete
atmux cockpit enable <team> | disable <team>          # toggle without re-typing config
atmux cockpit status                                  # cockpit session + per-cage liveness
```

> **[ADR-235](235-cockpit-verb-surface-rationalization.md) §D1 amendment (2026-06-05, t-11-0e88ce87):** the workhorse verb is
> renamed `rebuild → reconcile` (canonical). `rebuild` is retained as a
> one-release **deprecation alias** — it dispatches to the identical
> implementation and emits `[deprecated] use atmux cockpit reconcile`
> to stderr on every call (ADR-235 §OQ4 + [ADR-159](159-gitter-to-committer-rename.md) gitter→committer
> rename precedent). No behaviour change. **ADR-063 is NOT superseded** —
> the verb-port design (own-verb-with-cockpit-config + reconcile-emits-the-
> session + the cage-prefix dance) stands verbatim; only the canonical
> verb name moved. Read every "`rebuild`" below as "`reconcile` (alias:
> `rebuild`)".

`rebuild` (now `reconcile`) is the workhorse — does everything `cockpit-rebuild.sh` does today, plus:

- Honours atmux-bun's actual socket resolver (no path drift).
- Pre-creates the socket parent dir (the `mkdir -p` we just patched into the script).
- Calls atmux's own `start.cycleCage`-equivalent via in-process API rather than shelling out — kills the `env -u TMUX bash -c "cd $root && atmux stop --force"` indirection.
- Doctor preflight rolls in once `doctor` lands in TS (currently deferred per `start.ts` §"3. Resolve doctor mode").

### D2 — Config schema (`~/.atmux/cockpit.json`)

```jsonc
{
  "$schema": "https://atmux.dev/schemas/cockpit.v1.json",
  "cockpitSession": "atmux_teams",        // tmux session name on default socket
  "teams": [
    {
      "name": "sopx",
      "root": "/root/work/ifca/src/sopx-root",
      "enabled": true,
      "claudeAccount": {                  // optional — atmux derives env prefix from this
        "configDir": "/root/.claude-ifca",
        "label": "ifca"                   // for status output / discord pings
      },
      "tuiOverrides": {                   // optional — defaults from atmux
        "effortLevel": "xhigh",
        "permissionMode": "auto",
        "pluginDir": "/root/work/journals/.sb/claude-skills"
      }
    },
    { "name": "atmux", "root": "/root/work/src/atmux", "enabled": true,
      "claudeAccount": { "configDir": "/root/.claude-personal", "label": "personal" } },
    { "name": "unum", "root": "/root/work/unum/src/root", "enabled": false,
      "claudeAccount": { "configDir": "/root/.claude-unum", "label": "unum" } }
  ]
}
```

Order in `teams[]` defines cockpit window order. `enabled: false` keeps the config but skips orchestration on `rebuild`. Claude account block is optional — when present, atmux writes the canonical env prefix into the team's `team.json` `tuiCommands.claude` on `rebuild`. Operators who don't multi-account (single Claude login) leave it unset and atmux uses the inherited shell env.

### D3 — Dotfiles integration

Operator dotfiles owns `cockpit.json` for version control:

```
~/work/journals/.sb/_dotfiles/atmux/cockpit.json   # tracked file
~/.atmux/cockpit.json -> [symlink above]            # created by dotfiles/init.sh
```

`cockpit-rebuild.sh` becomes:

```bash
#!/usr/bin/env bash
exec atmux cockpit rebuild "$@"
```

Or remove the wrapper entirely and document `atmux cockpit rebuild` as the canonical entry point. Operator's preference at port time.

### D4 — Hax-specific bits stay hax-specific

Three things in today's script are operator-machine-specific and should NOT migrate into atmux:

1. **Hardcoded paths** (`/root/work/ifca/...`, `/root/.claude-ifca`) — these come from the operator's `cockpit.json`, which lives in *their* dotfiles, not atmux.
2. **`uname -n == "hax"` host check** — drop. atmux verbs run anywhere; if `cockpit.json` is absent, `cockpit rebuild` says so.
3. **Cron preamble injection (SHELL/PATH/TERM)** — already delegated to `atmux start`'s `cron_install`. No port work needed.

## NOT in scope

- **Auto-discovery of `.atmux/team.json` files on disk to populate cockpit.json.** Explicit roster is clearer than a filesystem walk that picks up archived/unused teams. Operator runs `atmux cockpit add <team>` once per team; that's a one-shot, not recurring friction.
- **Cross-machine cockpit sync.** `cockpit.json` lives in the operator's dotfiles; whatever sync mechanism the dotfiles already use (git, syncthing, etc.) carries it across machines. atmux doesn't need its own sync layer.
- **Multi-cockpit support** (e.g. an operator with both a `work` cockpit and a `personal` cockpit). Single cockpit per machine for now. If a real demand surfaces, add `--cockpit <name>` later — schema supports it via top-level `cockpits[]` extension.
- **Retiring the bash script during atmux-bun Phase 4.** Phase 4 is RUSH (parity matrix expansion). This port is a Phase 5+ enhancement — out of scope until atmux-bun reaches feature parity with bash atmux.

## Consequences

- **+ Sync drift eliminated.** When atmux changes its socket resolver / session-name convention / permission-mode flag, the cockpit verb tracks atomically. Today's bug (cage path mismatch between dotfiles script and atmux-bun) becomes structurally impossible.
- **+ Tested.** Cockpit logic ships with atmux's test suite (vitest + the `tmux abstractions` injector pattern in `src/abstractions/tmux.ts`). No more "operator runs `cockpit-rebuild`, finds out at midnight it's broken."
- **+ Multi-machine portability.** An operator with hax + a Mac or a second Linux box gets the same `atmux cockpit rebuild` UX everywhere. cockpit.json is the only operator-specific piece, and it travels with dotfiles.
- **+ Discoverable.** `atmux help` lists `cockpit` alongside `start`, `stop`, etc. Today's script is invisible unless an operator knows the dotfiles by heart.
- **− Coupling.** atmux now knows about `CLAUDE_CONFIG_DIR` env var (currently only the dotfiles script does). This is acceptable: atmux already encodes Claude-the-TUI knowledge in `team.json.tuiCommands.claude` strings; ADR-024 (per-member-model-selection) explicitly couples atmux to `--model claude-opus-4-7`. Adding `--config-dir` is the same shape.
- **− Migration cost.** Existing operators run `atmux cockpit init` once to seed `~/.atmux/cockpit.json` from their current registry. Estimated 5 minutes per operator. The dotfiles script keeps working unchanged during the transition window.
- **− Phase pressure.** atmux-bun is mid-Phase 4 RUSH. Filing this ADR now (Proposed status) parks the design; implementation is Phase 5+. The cheap-fix dotfiles patch (today, 2026-05-08) carries the workflow until then.

## Implementation outline (when Phase 5 starts)

Rough sizing — half a day to a full day depending on test depth.

1. Schema: `src/schema/cockpit.ts` (zod or similar) for `cockpit.json` shape. Mirror the schema from D2.
2. Loader: `src/core/cockpit.ts` — `loadCockpit(opts)` reads `~/.atmux/cockpit.json` (env override `ATMUX_COCKPIT_CONFIG`). Returns parsed config or throws `ConfigError` with the canonical seed snippet.
3. Verb: `src/verbs/cockpit.ts` — `rebuild`, `list`, `add`, `remove`, `enable`, `disable`, `status`. Each reuses existing primitives:
   - `rebuild` calls `start.run({ cwd: team.root })` per enabled team, gated by a `cageAlive` check (lift the helper from `cockpit-rebuild.sh:60-69`).
   - The cockpit-session reconcile (`tmux new-session -t atmux_teams -n superdriver` + `new-window` per team) uses the `tmux` abstraction injected via `createTmux({ socket: "default" })`.
   - Registry trim uses the existing registry helpers (currently only one writer; centralise if the count grows).
4. Wiring: `src/cli.ts` dispatch case for `cockpit`. README update. ADR moves to Accepted with a "Migration applied" footer like ADR-047.
5. Dotfiles patch: `cockpit-rebuild.sh` becomes the one-line shim or gets retired. Symlink `~/.atmux/cockpit.json` → `_dotfiles/atmux/cockpit.json` added to `init.sh`.

## Migration applied 2026-05-08

Implementation landed in a single session by the driver (operator override of
the standard "atmux source belongs to atmux team's lead" rule — explicit ask
to enforce + implement directly).

### Files added / changed

| Path | Type | Purpose |
|---|---|---|
| `src/schema/cockpit.ts` | new | Zod schema per §D2. Strict on inner objects, passthrough at top. |
| `src/core/cockpit.ts` | new | `loadCockpit`, `enabledTeams`, `cageSocketPath`, `cageSessionName`. |
| `src/core/tui-cmd.ts` | new | Port of `lib/tui.sh::atmux::tui_cmd` — priority chain (member.command → team.tuiCommands[tui] → built-in claude/opencode/kimi/cursor/shell). |
| `src/verbs/cockpit.ts` | new | `cockpit rebuild` verb. Phases: normaliseTeamJson → cycle cages (live-team-aware) → applyCagePrefix → autolaunchTeam → reconcileCockpitSession. Idempotent. |
| `src/cli.ts` | edit | Added `cockpit` dispatch case. |
| `src/verbs/help.ts` | edit | Added cockpit usage line under §Setup. |
| `tests/unit/core/cockpit.test.ts` | new | 18 tests: loader path resolution + roster validation + helpers. 100% coverage on schema/cockpit.ts + core/cockpit.ts. |
| `tests/unit/core/tui-cmd.test.ts` | new | 22 tests: every priority branch + every built-in TUI + UsageError on unknown. 100%/98% on tui-cmd.ts. |
| `tests/unit/verbs/cockpit.test.ts` | new | 24 tests: parseCockpitArgs branches + normaliseTeamJson idempotency + tmux integration tests for cageAlive/applyCagePrefix/reconcileCockpitSession/autolaunchTeam + cockpitRebuild end-to-end with stubbed startFn. ~93% line coverage on verbs/cockpit.ts. |
| `_dotfiles/atmux/cockpit.json` | new | Operator roster: sopx (enabled, claude-ifca) + atmux (enabled, claude-personal) + unum (disabled, claude-unum). |
| `_dotfiles/init.sh` | edit | Added symlink `~/.atmux/cockpit.json → _dotfiles/atmux/cockpit.json`. |
| `_dotfiles/bin/cockpit-rebuild.sh` | rewrite | Reduced to a 1-line shim: `exec atmux cockpit rebuild "$@"`. The 200+ lines of bash orchestration are gone — same behaviour now lives in tested TS. |

### Verification (hax, 2026-05-08 ~02:30 MYT)

```
$ ./bin/atmux cockpit rebuild --no-cycle --no-launch
🔹 atmux cockpit roster: sopx, atmux
🔹 atmux   ✓ sopx → /root/work/ifca/src/sopx-root/.atmux/team.json
🔹 atmux   ✓ atmux → /root/work/src/atmux/.atmux/team.json
🔹 atmux   · window 'sopx' already present
🔹 atmux   · window 'atmux' already present
✅ atmux cockpit ready. attach: tmux attach -t atmux_teams

$ ./bin/atmux cockpit rebuild --no-cycle  # idempotent autolaunch
🔹 atmux   ✓ sopx: launched=0 skipped=18 (already-claude)
🔹 atmux   ✓ atmux: launched=0 skipped=9 (already-claude)
```

Both team.json files normalised (`bareWindowNames=true` + canonical `tuiCommands.claude`). Re-runs are idempotent (skipped count goes up, launched stays 0). Cockpit session `atmux_teams` reconciled with windows `superdriver` + `sopx` + `atmux` per cockpit.json's enabled list (unum is `enabled: false` so its viewer window is absent).

### Scope landed

- `cockpit rebuild` (the workhorse). `--no-cycle`, `--force-cycle`, `--no-launch`, `--config <path>` flags all wired.
- TUI auto-launch via `resolveTuiCommand` (full priority chain).
- Live-team protection — cage with running claude procs preserved unless `--force-cycle`.
- Orphan viewer-window removal (drop a team from cockpit.json → its window disappears next rebuild).

### Scope deferred to follow-up commits

Per §D1, sub-verbs `list`, `add`, `remove`, `enable`, `disable`, `status`, plus `cockpit init` (seed config from existing rosters), and multi-cockpit support. None of these are blocking — operators edit `cockpit.json` by hand or via dotfiles. Tracked as kanban tasks against the atmux team for their own scheduling.

## Open questions

- **Should `atmux cockpit add` write into `cockpit.json` if that file is a symlink into dotfiles?** Two options: (a) atmux follows the symlink and writes through (operator commits the change in dotfiles afterwards); (b) atmux refuses and prints "edit `<resolved-path>` directly". Lean (a) — write-through matches how `team.json` editing works today.
- **Does cockpit-config invalidation cascade to the per-team `team.json`?** E.g. if an operator changes the Claude account in cockpit.json, does atmux re-write `team.json.tuiCommands.claude` automatically on next `rebuild`? Lean yes — that's the whole point of having atmux own the prefix template. But the rewrite needs to be idempotent (no `.bak.<ts>` accumulation; single canonical pass).
- **Cross-account cage-prefix application.** `cockpit-rebuild.sh:127-134` (`apply_cage_prefix`) sets `prefix = C-\` on each cage. atmux-bun's `lib/start.sh` did this only for `/tmp/atmux-tmux*` paths; the bun port may have already addressed this. Confirm at port time.

## §Amendment 2026-05-20 — partial supersession by ADR-135 (cockpit session-name)

This ADR's §Decision references the canonical cockpit-session name as `atmux_teams` throughout — including the example `cockpitSession: "atmux_teams"` config field (lines 23, 38, 84, 161, 198, 205) and the §"Cockpit session reconcile" command (`tmux new-session -t atmux_teams -n superdriver`). The **session-name only** is superseded by [ADR-135 §D2](./135-cockpit-naming-convention.md) — the canonical cockpit session is now `atmux_cockpit`, and the cockpit-tier window names carry an underscore prefix (`_superdriver`, `_medic`, `_sentinel`).

The supersession is **scoped to the session naming**. The §Decision's overall cockpit-verb-port design (own-verb-with-cockpit-config + rebuild-emits-the-session + the cage-prefix dance) stands verbatim. Per ADR-135 §D4 the loader migrates legacy `atmux_teams` session-name in-place on first `atmux cockpit rebuild` (one-release back-compat shim with deprecation-warn); the migrate-socket verb (ADR-162 §Decision-anchor #4 amendment 2026-05-16, `atmux cockpit migrate-socket`) is the operator-facing escape hatch for moving the legacy cockpit to the new socket isolation as well.

**Filed via** t-2d750500 (T2 sweep of [docs/audits/adr-supersession-audit-2026-05-20.md](../audits/adr-supersession-audit-2026-05-20.md) D1 drift #8, 2026-05-20).

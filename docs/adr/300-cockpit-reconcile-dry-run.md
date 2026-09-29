# ADR-300: Cockpit reconcile dry-run preview

**Status**: accepted (operator-direct — George, 2026-09-28, a-0a420779 preflight-then-lift)
**Date**: 2026-09-29
**Driver-ref**: kb atmux t-6a6828f5
**Relates**: [ADR-162](162-atmux-owns-tmux-infrastructure.md) (TR3 `migrate-socket --dry-run` precedent), [ADR-235](235-cockpit-verb-surface-rationalization.md) (reconcile workhorse), [ADR-097](097-tmux-abstraction.md) (TmuxNamespace)

## Context

`atmux cockpit migrate-socket --dry-run` already previews its six-phase
migration without mutating either socket. The canonical workhorse —
`cockpit reconcile` — had no equivalent: an operator who wanted to see
what a reconcile WOULD do (orphan kills, medic relocation, viewer
adds, prefix sets, cage starts) had to run it and read the aftermath.
The t-8b0e077e `--yes` gate refuses destructive runs without
confirmation, but it only names the DESTRUCTIVE subset — the additive
plan (new windows, renames, launches) stayed invisible until applied.

## Decision

### D1 — `reconcile --dry-run` is a read-only preview; exit 0

`parseCockpitArgs` accepts `--dry-run` on `reconcile` (in addition to
`migrate-socket`); `reload` and `attach` still refuse it. A dry-run
reconcile prints one line per planned operation, then the summary line
`dry-run: N rename, M kill, K other operations (nothing executed)`,
and exits 0.

### D2 — Recording tmux wrapper (`src/core/tmux-dry-run.ts`)

Every tmux namespace the reconcile builds routes through
`createDryRunTmux(real, ops)`. Read-only methods (`hasSession`,
`listSessions`, `listWindows`, `capturePane`, `listPanes`,
`displayMessage`, `listClients`, `showOptions`, `hasServer`) delegate
to the real namespace so the preview reflects live state; every other
method records its intent (`kill-window -t …`, `rename-window …`,
`new-window …`, `send-keys …`, `set-option …`, …) and returns a
benign success value without executing. Classification is
conservative: unknown ⇒ mutating (record, do not execute).

Summary categories: `rename*` → rename, `kill*` → kill (session,
window, pane, server), every other mutation → other.

### D3 — Non-tmux side effects are skipped, not recorded

The wrapper cannot intercept work outside tmux, so the reconcile
guards each such phase on the dry-run flag: Phase 1 team.json
normalisation is skipped (logged as would-normalise), Phase 2 cage
`start` + socket-dir creation are skipped (logged as would-start; the
legacy-session rename probe still runs through the recorder), group
socket-dir creation is skipped via `ReconcileGroupServersOpts.dryRun`,
and the Phase 4 TUI readiness probe runs with `skipReadinessProbe`
(a recorded-not-executed send-keys would otherwise poll live panes
for up to 30s for a TUI that was never launched).

### D4 — The `--yes` destructive-op gates are moot under dry-run

Nothing mutates, so `cockpitRebuild` threads `yes: true` into
`reconcileGroupServers` and `reconcileCockpitSession` when dry-run is
set. The planned-op warnings still log (they are part of the
preview); only the refusal throw is bypassed.

## Consequences

- Operators preview with `atmux cockpit reconcile --dry-run`, commit
  without the flag — the same two-step the TR3 migration established.
- The plan is best-effort ordering, not an atomicity promise: live
  state can shift between preview and apply (same documented
  race-window as the `--yes` gate).
- `reload` keeps refusing `--dry-run`: the hot-reload alias is for
  applying topology diffs now, not previewing them.

## Amendment 2026-09-29 — cage liveness recognises omp; `start` is not previewed

The first live run (2026-09-29, t-6a6828f5) printed `0 rename, 0 kill`
but classed all 49 cages `dead/empty`, including the cage running the
run. `cageAlive` matched only `claude`/`node` and probed only each
window's active pane; an omp pane reports `pane_current_command` `bun`.
That silently broke the [ADR-063](063-cockpit-verb-port.md) live-team
protection: a real reconcile would have re-run `start` over every live
omp cage.

- **Liveness.** `cageAlive` now probes every pane of every window and
  treats `claude`, `node`, `omp`, `bun` and `codex` as a live agent TUI.
  Over-matching errs safe (a false "alive" only skips a cycle).
- **Preview limit.** Dry-run skips `start` entirely, so `start`'s own
  tmux mutations are not in the plan. On an existing session without
  `--force` those are: legacy member-window renames (ADR-135, ADR-161)
  and the `__<team>__home` placeholder kill. A `would start cage` line
  on a live server is a prompt to check its window list for those
  names; the plan counts do not cover it.

## Amendment 2026-09-29 — `start`-internal renames/kills are previewed; limit closed (t-eb11cdb4)

The preview limit above is closed. The dry-run Phase 2 branch now probes
each cage it would start (`has-session` + window list, both read-only)
and records the incremental repairs a non-force `start` would perform on
that live session — legacy member-window renames (ADR-135, ADR-161) and
the `__<team>__home` placeholder kill — through the same `DryRunOp`
list, so they land in the plan lines and the summary counts. The kill
follows start's step-9 gate exactly: it is planned only when start would
spawn something (a member window still missing after the renames, or the
ADR-296 superdriver seat) and the placeholder would then sit beside real
windows. A rename-only start spawns nothing and keeps the placeholder. The cage
launch itself (plus team.json writes, socket-dir creation, readiness
probes) stays skipped behind the `would start cage` line.

No-drift construction: the planner lives in
`src/core/start-repairs.ts` (pure `planStartRepairs` over a window-name
list, plus the `previewStartRepairs` probe-and-record driver) and the
real `start` path consumes the same arms (`planMemberRenameArms`) and
the same kill predicate (`shouldKillHomeWindow`) — one shared
implementation, not two matching descriptions. Coverage:
`tests/unit/verbs/cockpit-reconcile-dry-run.test.ts` (legacy+home cage
plans rename+kill with nothing executed; clean cage plans none).

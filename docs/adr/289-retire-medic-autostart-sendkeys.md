# ADR-289: Retire medic autoStart send-keys auto-fire

**Status:** Accepted (reviewer signoff 2026-09-23, t-74c9e79e)
**Date:** 2026-09-23
**Deciders:** Team

## Context

`t-22453c1e` added `autoStartSuperdoctorLoop`: after reconcile (or
`cockpit rotate` respawn) created a fresh medic window, the verb polled
the pane to idle and `tmux send-keys`'d a loop command into it, unless
`medic.autoStart` was `false`. ADR-237 D2 removed that auto-loop; the
t-5c65cb9b medic reinstatement (2026-09-07) brought the helper back
without writing its planned ADR-291 — no ADR-289/290/291 file exists on
disk, so the reintroduction is recorded only on kb t-5c65cb9b.

The reintroduced auto-fire is defective three ways:

1. Board rule r-1376df29 bans send-keys into interactive panes. The
   helper's whole job is that prohibited shape.
2. The auto-typed command is stale. The helper still sends
   `/loop /superdoctor`, but `superdoctor` was renamed to `medic`
   (ADR-133); the `/medic` skill is gone from the operator's plugin
   tree. Either string types a dead command into a live pane.
3. `medic.autoStart` / `autoStartTimeoutSec` in the strict cockpit
   schema keep a dead surface alive: `@@mbp` `cockpit.macos.json`
   carries `autoStart: false`, which would fail load the moment the
   fields are dropped unless the config drops the key in the same step.

## Decision

- Delete `autoStartSuperdoctorLoop`, `AutoStartSuperdoctorOpts`, the
  `SUPERDOCTOR_*` consts and `paneIsReady` (cockpit.ts), both call
  sites (reconcile fresh-window block; rotate respawn re-arm switch),
  and the seams (`ReconcileOpts.autoStartSleep/autoStartCapturePane`;
  `CockpitRotateOpts.autoStartMedicLoop/cadenceLogger/autoStartTimeoutMs`).
- Delete `autoStart` / `autoStartTimeoutSec` from `MedicSessionT`,
  `MedicSession` and `CockpitMedic`. Schemas stay `.strict()`: a stale
  config fails loudly at load, never silently ignored.
- The operator's `cockpit.macos.json` drops its `autoStart: false`
  key in the same step.
- Fresh medic panes start the loop manually: the operator types
  `/loop /medic`. RUNBOOK-cockpit.md documents the manual step.
- `@@hax` `cockpit.json` omits the keys and already has its `_medic`
  window: unaffected.

## Consequences

- No keystroke is ever typed into an interactive pane by reconcile or
  rotate. r-1376df29 holds for the cockpit surface.
- A config still carrying the retired keys errors at load with the
  strict-schema message pointing at the exact key — the intended
  loud failure, not a silent ignore.
- The hourly-medic cadence becomes operator-started. If a future
  auto-start is wanted, it needs a non-send-keys mechanism and a new
  ADR; restoring this helper from git is explicitly not the path
  (the typed command is stale by construction).

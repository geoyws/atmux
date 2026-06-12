# ADR-240: Drop superorchd — orchd self-supervises, bash supervisor retires

**Status**: Accepted (operator-direct 2026-05-24)

**Date**: 2026-05-24

**Supersedes**: [ADR-236](236-three-tier-orchd-supervision.SUPERSEDED.md) — three-tier orchd supervision (D1 internal retry + D2 cockpit superorchd + D3 Discord escalation). This ADR retains D1 only, drops D2 and D3, simplifies the cockpit.

**Driver-ref**: 2026-05-24 conversation:
- *"maybe we can rely on the orchd being there and we can simplify atmux by not having superorchd"*
- *"simpler is better"*

**Cross-refs**:
- [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) — *"trust orchd to run"*; this ADR extends that trust by removing the external supervisor layer too.
- [ADR-202](202-honker-in-db-messaging-substrate.md) §1132 — PIPESTATUS regression in the bash supervisor; the bash-supervisor class of bug is gone once orchd is self-sufficient.
- [ADR-224](224-orchd-rename-and-auto-spawn-loop.md) — `rust/atmux-orchd` crate that gains the internal retry loop.

## Decision

1. **`atmux-orchd` is the only supervisor.** The Rust binary owns its own reliability via an internal retry loop covering the transient-failure cases ADR-236 §D1 enumerated (db-open backoff, `UpdateClosed` re-subscribe, initial-offset-load backoff). orchd exits only on real signals (`SIGTERM`/`SIGINT`/`SIGHUP`/parent-death) or genuine panic. Per-iteration restarts disappear.

2. **No `atmux-superorchd` binary.** The `rust/atmux-superorchd/` crate ADR-236 §D2 proposed is not built. No `__superorchd__` cockpit window. No cross-team liveness scan, no backoff state machine, no `[orchd-supervision-failure]` Discord template, no `superdoctor_attempts` payload writes from a supervisor process.

3. **The bash supervisor at `src/core/orchd-window.ts:206-250` is removed.** `maybeSpawnOrchdWindow` sends keys for a direct invocation only:
   ```
   ATMUX_ORCHD_TEAM_DIR=$(pwd) atmux-orchd .atmux/state.db 2>&1 | tee -a .atmux/logs/orchd.log
   ```
   No loop, no trap, no circuit breaker, no PIPESTATUS gymnastics. The Bun fallback (`atmux orchd --start`) is preserved as today for hosts without the Rust binary on PATH.

4. **Process death is operator-visible, not auto-recovered.** If orchd panics or is killed externally, the `__orchd__` tmux pane shows the exit. The operator notices on next cockpit attach and restarts it (`atmux start <team>` re-creates the window, or manual `tmux send-keys` of the direct invocation above). No Discord ping fires; no medic complaint-box record is written.

## Tradeoff (explicit)

This ADR trades **automatic restart-on-death** for **simplicity**. Failure-detection latency goes from `~30s + Discord ping` (ADR-236 §D2 scan cadence) to `whenever operator next attaches the cockpit`. For solo-operator setups this is acceptable — the operator is the only consumer of orchd output, and a wedged team between cockpit-check intervals is the same cost as a wedged team between Discord-check intervals on a phone they're not looking at.

The mitigation is making orchd-internal-retry (Decision 1) genuinely robust: a real `catch_unwind` panic handler around the main loop, exhaustive transient-error backoff, exit only on real signals. If that's done well, process-death frequency is low enough that the operator's natural cockpit-attach cadence is sufficient supervision.

If process-death frequency turns out to be higher than expected in practice, the reversal path (below) reinstates an external supervisor.

## Consequences

- **Removed work**: `rust/atmux-superorchd/` crate not built. No `__superorchd__` cockpit window. No `[orchd-supervision-failure]` Discord template. No supervisor-side writes to `superdoctor_attempts`. The medic on-demand role (ADR-236 §D4) stays unchanged — still opt-in, still operator-invoked via `atmux medic diagnose <team>`, just without a superorchd-emitted payload to consume.
- **Same-commit doc cleanup** (whoever lands the orchd-window simplification owns these):
  - `docs/medic.md` — strike the "load-bearing for orchd self-healing escalation" callout if any landed; medic's role is operator-on-demand only.
  - [ADR-237](237-no-llm-discord-and-whip-removal.md) §"When you want it" — strike the "After superorchd escalation" hint; the trigger to invoke medic is now operator-spotting-dead-pane, not a Discord ping.
  - [ADR-238](238-orchd-drives-discord.md) §`atmux pulse` row — the deletion justification *"replaced by ... superorchd's supervision-failure escalation"* needs revising; `atmux pulse` deletion now rests solely on orchd's `heartbeat.tick` self-emit, with no external-supervisor backstop.
- **`tests/unit/core/orchd-window.test.ts`** (if it exists; verify on implementation) updates from asserting bash-supervisor content to asserting on the direct-invocation payload.
- **PIPESTATUS-class bugs** in supervisor bash strings: surface goes to zero. There's no bash, no pipe, no supervisor.

## Reversal

If solo-operator-supervision-cadence proves insufficient in practice — e.g. orchd panics more than expected, or operator cockpit-attach cadence is sparser than the wedged-team cost tolerates — the reversal path is to build ADR-236 §D2 (`atmux-superorchd`) as originally specified. ADR-236's text is preserved at `236-three-tier-orchd-supervision.SUPERSEDED.md` so the design is recoverable without re-derivation.

A lighter reversal is restoring just the per-team bash supervisor (`orchd-window.ts:206-250` content), which catches process-death the same way ADR-236 §D2 would have but without the cross-team observability or typed Discord escalation. Cost: the bash-supervisor PIPESTATUS-class bug surface returns.

ADR-233's cron-retirement stays as-is regardless — this ADR builds on it but doesn't depend on its details.

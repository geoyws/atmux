# ADR-289: poke is retired — the verb, the whip estate, and the six whip ADRs

**Status**: accepted — operator-direct (George 2026-09-04, verbatim: *"we don't use poke anymore either"*)
**Date**: 2026-09-23
**Supersedes**:
- [ADR-040](040-whip-audit-integration.SUPERSEDED.md) — whip → audit sub-pass + `[whip-audit]` Discord template
- [ADR-043](043-whip-auto-stop-idle.SUPERSEDED.md) — whip auto-stop on prolonged team idleness
- [ADR-085](085-whip-approvals-watcher.SUPERSEDED.md) — whip approvals-watcher (§2.5 needs-approval scan)
- [ADR-115](115-whip-port-scope.SUPERSEDED.md) — `whip` verb (V-25) port scope + deferred bash-only checks
- [ADR-160](160-whip-to-poke-rename.SUPERSEDED.md) — whip → poke rename (SV register sweep)
- [ADR-177](177-whip-velocity-gate.SUPERSEDED.md) — whip velocity-gate (ground-truth classifier + strike counter)
**Amends / Relates**:
- [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) — cron auto-install disabled; the cron-install side that ever fired poke now emits zero poke-related lines (no-op shims)
- [ADR-237](237-no-llm-discord-and-whip-removal.md) — §D1 proposed the Bucket-B whip-removal half (`src/verbs/whip.ts` deprecated, then deleted); its removals never landed while the file stayed Proposed. This ADR completes that whip half explicitly; ADR-237's Discord/medic halves (D2–D4) are untouched and remain Proposed
- [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) — no-send-keys-to-drivers invariant; poke's member-nudge sends are part of the surface being removed
- [ADR-266](266-shim-sunset-policy-and-first-sweep.md) — dead-code removal precedent; its audit (2026-07-28) still counted the `src/core/whip-*.ts` modules as live via poke — the load-bearing assumption this ADR retires
- E4 wedged-pane follow-up (t-a46557eb) — read-only pane classifier; takes over the DETECTION half only (see Capability loss)

## Context

### What poke did, per tick (measured from source)

`src/verbs/poke.ts:1-53` documents a 5-minute watchdog intended for cron (`*/5 * * * * … atmux poke`), renamed from `whip` per ADR-160 with the legacy `atmux whip` cron lines routing through the `cli.ts` alias. Each tick performed (`src/verbs/poke.ts:11-32`):

1. tmux session liveness, with a 2-tick session-DOWN gate (`classifySessionState`, `src/verbs/poke.ts:679`; wired per tick at `src/verbs/poke.ts:1090-1099` with `readSessionState`/`writeSessionState` anchoring `whip-session-state.json`).
2. Per-member pane TUI verification (expected-TUI vs `pane_current_command` fallback to shell), plus the cross-account drift detector: each member's `CLAUDE_CONFIG_DIR` read via `/proc/<pid>/environ` (`defaultReadMemberEnv`, `src/verbs/poke.ts:811`), compared to the driver's, mismatch surfacing a cross-account spawn finding (`src/verbs/poke.ts:17-19`). macOS (no `/proc`) degrades to "no cross-account check possible" (`src/verbs/poke.ts:52-53`).
3. Per-member idle-with-in-progress-task threshold via `selectStaleTasks` (`src/verbs/poke.ts:750`): staleness anchor `max(claimedAt, dispatchedAt, rotated-epoch)` older than `whip.staleMin` (default 90).
4. Per-member Claude Code banner deterministic detection — HARD rate-limit, Compacting conversation, queued messages (`src/verbs/poke.ts:23-27`); findings fired at `src/verbs/poke.ts:1972-1990`, with the R57-T1 discrete-classifier belt-and-braces at `src/verbs/poke.ts:2131-2142`. The SOFT rate-limit LLM-judge cascade stayed deferred (observed-but-not-acted-on).
5. Lead uptime warning (`checkLeadUptime`, `src/verbs/poke.ts:2344`): ≥45 min warn, ≥`leadMaxMin` recommend rotate; auto-rotate execute deferred.

Later accretions wired into the same tick: the ADR-085 §2.5 needs-approval scan (`runNeedsApprovalCheck`, `src/verbs/poke.ts:1278`) and the ADR-177 velocity-gate pass (`runVelocityGate`, `src/verbs/poke.ts:1361`).

### Why every input is gone

| Former input | State |
|---|---|
| Cron-fired 5-min cadence | No live poke cron lines on @@mbp; cron auto-install disabled per ADR-233 and the cron source surface removed (ADR-237 §Context Bucket A2). Nothing invokes the tick. |
| cron-install scheduling side | No-op shims per ADR-233 — they emit zero poke-related lines. |
| `whip` alias | Already gone from the CLI surface. |
| Operator demand | George 2026-09-04: *"we don't use poke anymore either"* — operator-direct retirement, same authority class as ADR-280. |
| Estate size (E3 measure) | 749 poke\|whip lines across 102 src files — removed per the E3 deletion inventory (E3-T3 deletion task, separate from this ADR). |

A verb with no callers, no scheduler, no alias, and an explicit operator "we don't use it" is dead code with a heartbeat file (`whip-last.hash`, `whip-session-state.json`). The six ADRs above designed behavior for that heartbeat; they retire with it.

## Decision

### D1 — The `poke` verb and the whip estate are retired

`atmux poke` is removed along with the `src/core/whip-*.ts` modules that exist only to serve its tick, per the E3 (e-ca029399) deletion inventory executed as the E3-T3 deletion task (this ADR, t-103ad93c, records the decision only). The `whip.cadence` / `whip.*` config surface goes with it. No deprecation shim: there are no live callers to migrate (see Context table), and ADR-266 already spent the community's shim patience.

### D2 — The six whip ADRs are superseded, not deleted

The files are renamed `NNN-slug.md` → `NNN-slug.SUPERSEDED.md`, each prepended with a `**Status**: Superseded by ADR-289` line naming this ADR + date + one-line reason, bodies untouched, and their INDEX.md rows moved from Live to Superseded — the ADR-286 marker convention. They were true when written; they are kept for trace.

### D3 — ADR-237's whip half is explicitly completed here

ADR-237 §D1 proposed deprecating `src/verbs/whip.ts` (+ `whip-resume-check.ts`) with deletion one release later, but stayed Proposed and its Bucket-B removals never landed. This ADR is the landing: the verb is deleted, not deprecated. ADR-237 itself stays Proposed — its Discord-template (D4) and medic (D2) halves are independent decisions with their own fate.

## Capability loss — accepted and explicit

Three capabilities go away with the tick. Each is source-verified below; nothing else is claimed. For each, what replaces it — or the plain statement that nothing does.

1. **Session-liveness watchdog.** The 2-tick DOWN gate (`classifySessionState`, `src/verbs/poke.ts:679-695`; per-tick wiring `src/verbs/poke.ts:1090-1099`) suppressed false alerts during transient tmux hiccups and reported genuinely-dead sessions. **Replaced by: nothing automatic.** Cages are operator-managed now; a dead cage is noticed by the operator, not by a watchdog. E4 (t-a46557eb) is pane-level classification and does not cover session liveness — stated plainly, that half stays uncovered.

2. **Rate-limit / compaction banner detection.** HARD rate-limit findings (`src/verbs/poke.ts:1980`), SOFT observed-but-not-acted-on (`src/verbs/poke.ts:1982-1988`), Compacting/queued-text handling (`src/verbs/poke.ts:23-27`), plus the R57-T1 discrete re-classifier (`src/verbs/poke.ts:2131-2142`). **Replaced by: E4's read-only pane classifier for the DETECTION half only.** E4 classifies wedged panes; it does not fire Discord pings, does not resubmit queued text, and does not advance any strike counter. The action half (notify + nudge) is gone with no successor.

3. **Cross-account drift detection.** `CLAUDE_CONFIG_DIR` comparison via `/proc/<pid>/environ` (`defaultReadMemberEnv`, `src/verbs/poke.ts:811-818`; spec `src/verbs/poke.ts:17-19`). **Replaced by: nothing.** Spawn-time account discipline (matching driver's account at spawn) remains the practice; the runtime drift detector has no successor, and E4 does not cover it. (On macOS it already degraded to no-check per `src/verbs/poke.ts:52-53`, so the loss is Linux-only in practice.)

## Alternatives considered

1. **Keep the verb manual-only** (`atmux poke` callable on demand, no cadence). Rejected: the operator statement retires the behavior, not just the schedule; a callable-but-never-called verb keeps the 749-line estate (102 files) alive for zero consumers, and ADR-266's "short and sweet" directive points the other way. On-demand pane inspection already exists via `atmux pane-state`.
2. **Strip poke to a detector** (keep banner/drift classification, drop Discord + send-keys + auto-stop). Rejected: that is exactly E4's (t-a46557eb) read-only pane classifier, already tasked separately. Two detectors for the same pane state is the duplication this retirement is meant to end; the tick's action half has no defender.

## Reversal

Restore `src/verbs/poke.ts` + the `src/core/whip-*.ts` modules it imports + the `whip.*` schema block, re-add the six rows to INDEX.md Live, and un-rename the six `.SUPERSEDED.md` files. The cron cadence that made the verb load-bearing (ADR-233) would need its own reversal first — without a scheduler the restored verb is as inert as the one removed here.

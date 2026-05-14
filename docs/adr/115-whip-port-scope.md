# ADR-115: `whip` verb (V-25) — port scope + deferred bash-only checks

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

Bash `lib/whip.sh` (1324 LOC at HEAD `2aadc3f`) declares 19 helper functions invoked from `main()`. The original `PLAN.md §6.2` V-25 LOC estimate (218) reflected the file's docstring header — the **5 documented checks** the verb was originally specified to perform:

```
1. tmux session liveness
2. per-member pane: is pane running the expected TUI?
3. per-member: is the pane idle > $ATMUX_STALE_MIN with in-progress tasks?
4. per-member Claude Code: is "Compacting conversation" or "hit your limit" banner visible?
5. lead: uptime > $ATMUX_LEAD_MAX_MIN minutes → recommend rotate
```

Bash whip then accreted six additional feature classes over time, each landing under emergency-fix umbrellas without ADR coverage on the whip side:

- **ADR-116** — three-tier rate-limit classifier (HARD / SOFT / NONE) + Sonnet LLM-judge integration for SOFT.
- **ADR-041** — brief-version cache + decisions/flags cursor (cache-discipline ordering: stable-shape pointers head, churning content tail).
- **`atmux decisions list` / `atmux flags list`** — bash-only sub-verbs that don't exist in the TS port. Whip's decisions + flags pointer-checks call into them.
- **Audit sub-pass** — `_atmux_whip_check_audit` shells out to `atmux audit --json` and dispatches per-class auto-fixes. Audit verb itself is not in scope of atmux-bun (Phase 5 / super-driver).
- **Phantom-inbox sweep + ledger GC** — orphan inbox cleanup beyond V-24 doctor's read-only check.
- **Two-tick session-DOWN confirmation, auto-stop, failover, rename.lock skip, brief-version drift** — operational gates added under specific incidents.

Porting all 19 helpers in TS would add ~1500 LOC of code that depends on:

- ADRs not yet drafted on the TS side (ADR-116 LLM-judge, ADR-041 cache discipline).
- Bash sub-verbs that don't exist in the TS port (`atmux audit`, `atmux decisions`, `atmux flags`).
- Phase-5-deferred features (super-driver topology, cage isolation, failover budget policy, rename.lock).

The bash-side checks aren't going away — atmux-bash stays live during burn-in per ADR-104, so operators who need those checks run `atmux whip` (bash) on the same machine.

## Decision

V-25's TS port scope is the **docstring-listed core 5-check set** plus the immediate integration items I-1 + I-2 (lead-uptime marker + window-name detection from §6.3). Two-tick session-DOWN confirmation is in scope (false-alert prevention is core observability, not a deferred feature). Single-instance flock + delta hash are in scope (small, no external deps).

| Check / feature | Status | Reason |
|---|---|---|
| Single-instance lock (`whip.lock` flock, non-blocking; skip-tick on contention) | ✅ ported | Core operational hygiene; ~10 LOC. Bun has no native flock — port via `node:fs` `O_EXCL` + tick-skip on EEXIST, or `proper-lockfile`. |
| Two-tick session-DOWN confirmation | ✅ ported | Origin: 2026-04-25 incident (5 false alerts under tmux/swap pressure). Single-tick check ⇒ N false alerts; two-tick gate ⇒ 0 false. False-alert prevention is core observability, not bonus. |
| Check 1: tmux session liveness | ✅ ported | Foundational. Reuses `core/common.ts::sessionExists` (already shipped). |
| Check 2: per-member pane TUI verification (claude / opencode / kimi / cursor) | ✅ ported | Uses existing `tmuxAbstraction.pane.listPanes` + `pane_current_command` field. |
| Check 3: per-member idle-with-in-progress-task (`ATMUX_STALE_MIN` threshold) | ✅ ported | Reads `inbox.inProgress` + last-activity epoch; threshold from `team.json::whip.staleMin` + env override + 90 default per bash:73. |
| Check 4: HARD rate-limit banner (`hit your limit`) | ✅ ported | Deterministic regex, no LLM consult. |
| Check 4: Compacting / queued-msg banner | ✅ ported | Deterministic, independent signal from rate-limit ladder. |
| Check 5: Lead uptime warning (≥45min warn, ≥60min recommend / auto-rotate) | ✅ ported | Reads `~/.claude/teams/<team>/lead-session-start.txt` (I-1 marker). Per-team `whip.autoRotate` gates recommend vs execute (executes deferred — autorotate trigger is V-26 `team rotate-lead`-coupled per ADR-114). |
| I-1 lead-uptime marker write | ✅ ported (writer side) | Whip ticks read it; lead-spawn writes are pinned to V-26 `team` per ADR-114. For Phase 2, `atmux whip --init-lead-marker` or first-tick auto-init writes a placeholder so reads never fail. |
| I-2 lead-window-name marker | ✅ ported (read side) | Whip uses it for lead-pane probes via `tmux capture-pane -t <window>`. Writer side pinned to V-26 per ADR-114; whip falls back to `__<team>__team-lead` when marker absent. |
| `whip-last.hash` delta tracking | ✅ ported (file write) | Records last-tick epoch so subsequent ticks can compute since-last-tick window. Used for delta_block computation; full delta-block content is deferred (see below). |
| Discord findings push (`📢 [whip-progress]` / `🛑 [whip-blocker]` / `⏰ [whip-overdue]` named templates per CLAUDE.md) | ✅ ported | Uses existing `discord.send` (ADR-101-compliant). HARD rate-limit + missing-window + idle-task findings emit. |
| Check 4: SOFT rate-limit (`approaching usage limit` / `N% used`) + LLM-judge consult | ❌ deferred | Depends on bash `lib/llm-judge.sh`. **ADR-116 pins the cascade contract** (Sonnet → Haiku → deterministic fallback) so when SOFT ports, the judge call has a resilient cascade from day one — no single-point-of-failure on a judge that can OOT. HARD-only is conservative-safe in V-25; SOFT signals get observed-but-not-acted-on until `core/llm-judge.ts` ports per ADR-116. |
| Brief-version cache + drift detection (`_atmux_whip_check_brief_versions`) | ❌ deferred | ADR-041-coupled (bash-side cache discipline). Re-enable handle: ADR-041 TS draft. |
| Decisions cursor (`_atmux_whip_check_decisions`) | ❌ deferred | Depends on `atmux decisions list --since` bash sub-verb. Re-enable handle: TS port of `atmux decisions` (not in PLAN §6.2 — separate verb-ID would need adding). |
| Flags cursor (`_atmux_whip_check_flags`) | ❌ deferred | Same — depends on `atmux flags list` bash-only sub-verb. |
| Audit sub-pass (`_atmux_whip_check_audit` + per-class auto-fix dispatch) | ❌ deferred | Depends on `atmux audit --json` + `atmux audit --fix --class <X>` bash-only sub-verbs (Phase 5 / super-driver). Re-enable handle: TS port of `atmux audit`. |
| Phantom-inbox **sweep** (write-mode prune) | ❌ deferred | V-24 doctor already ports the phantom-inbox **read** check. Whip's bash sweep deletes phantoms — destructive op deferred until `--fix` lands per ADR-112. Re-enable handle: ADR-112's deferred `--fix` actions. |
| Phantom ledger GC (`_atmux_whip_phantom_ledger_gc`) | ❌ deferred | Bash-only state file (`phantom-ledger.json`) tracking phantom-inbox seen-history. Marginal value for the TS port at burn-in scale — re-enable post-cutover. |
| Auto-stop check (`_atmux_whip_check_auto_stop`) | ❌ deferred | Phase-5 super-driver concern — auto-stops on cost-budget breach. TS port lacks the budget-policy machinery. Re-enable handle: ADR-046 (super-driver) or whichever Phase-5 ADR scopes auto-stop. **2026-05-07 (t-a3a0e5b1):** the bash-side `_atmux_whip_check_auto_stop` on atmux-geoyws now carries an ADR-052 §Whip-integration eternal-improvement intercept (pre-stop check on `.atmux/state/eternal-improvement.json::active`; if not active, invokes `atmux improve --idle-fallback --default-budget` and returns 0 on success). When the TS port re-enables the auto-stop check, the intercept must be ported alongside (it lives in the same function, not a separate helper). |
| Failover (`_atmux_whip_attempt_failover`) | ❌ deferred | Phase-5 super-driver — peer-with-budget lookup + cross-member handoff. Lacks the V-26 `team` runtime + V-23 `rotate` cross-member machinery. |
| Rename.lock skip (`$(atmux::state_dir)/rename.lock` short-circuit) | ❌ deferred | Phase-5 cage rename (`atmux team rename`) flow. TS port doesn't ship rename. |
| Member-rotated epoch / stale-anchor (`_atmux_whip_member_rotated_epoch` / `_atmux_whip_stale_anchor`) | ❌ deferred | ADR-041-coupled stale-anchor invariants for cache reuse. Bash-side observability concern. |
| Soft-judge cost ledger (`_atmux_whip_judge_soft` / `_atmux_whip_judge_last_reason`) | ❌ deferred | ADR-116-coupled. Cost ledger format pinned in ADR-116 §3 (`<atmuxDir>/state/judge-cost.jsonl` with tier + outcome + USD per call). Re-enables alongside SOFT classifier. |

Rendering: bullet list of findings flushed to Discord via `discord.send` named templates (per CLAUDE.md "Discord message format" rules). One named template per finding class:

- `📢 [whip-progress]` — N tasks shipped, M in-progress, X blockers (the periodic digest)
- `🛑 [whip-blocker]` — per-member blocker findings (window missing, pane crashed, HARD rate-limit)
- `⏰ [whip-overdue]` — idle-with-task findings exceeding `staleMin`
- `💓 [whip-heartbeat]` — green-tick acknowledgment when no findings (suppressible per `team.whip.heartbeat`)

Locally: log to `<atmuxDir>/logs/whip.log` (existing convention). On contention: skip tick, log "another instance is running".

Exit codes:
- `0` — tick completed (with or without findings).
- `1` — fatal error during tick (config issue, tmux unreachable). Cron then keeps trying.

**I-6 deferred from V-25's runtime-side scope.** I-6 (Discord decision-defence template `📋 [autonomous-decision]`) is a **lead-side** Discord post — emitted when the lead applies a recommended default without escalation. Whip is observability of teammates, not autonomous-decision tracking. The named template can be added to `discord.ts` as part of V-25's commit chain (low cost), but its **invocation site** is the lead's `tell-discord`-shaped flow, which lives in V-27 `team` (post-cutover) or a new dedicated verb. Updated §6.3 status: I-6 = `template added in V-25; invocation site = V-27`.

## NOT in scope (V-25 explicitly)

- **Cron template generation** — `crontab -l` parsing + `*/5 * * * *` line insertion. Operator runs `crontab -e` manually with the line documented in `docs/RUNBOOK.md`. Re-enable: ADR-111 immediate-items I-? followup or a dedicated `atmux whip --install-cron` flag.
- **Web UI / dashboard integration** — out of scope for atmux-bun.
- **Multi-tenant whip** (one cron, N teams) — single-team per cron line. Operator multiplexes via separate cron entries.

## Migration plan

1. **Commit A — `feat(verbs): whip — 5-min watchdog, in-scope subset (V-25)`**: full TS implementation of the in-scope checks above. Drops alongside `tests/unit/verbs/whip.test.ts` at 100% coverage. cli.ts dispatch backfill (per ADR-113 §2 lesson) included in the same commit.
2. **Commit B — `docs(adr,plan): R-? + V-25 status`**: this ADR + flip §6.2 V-25 row + add ADR-115 to §7.

Each commit standalone-passes typecheck + 100% coverage gate.

## Out of plan / future work

- Each deferred check is a **durable handle** in this ADR, not a "TODO" comment in code. When ADR-116 (LLM judge) ports, that ADR's "Re-enables" list points back at this row to widen whip's rate-limit ladder to SOFT.
- Whip's commit chain establishes the V-25 verb as the runtime fixture for **all** future cron-driven supervisor checks — auto-stop, failover, audit auto-fix, decisions/flags pointers — when their underlying TS sub-verbs land.

## Consequences

- V-25 ships at ~400 LOC (estimate) instead of ~1500 LOC if we ported everything. ~73% reduction.
- Each deferred row is a durable re-enable handle tied to a specific TS-side ADR or verb-ID — no "TODO" rot.
- Operators get the **operationally critical** checks immediately: missing windows, crashed TUIs, HARD rate-limit, lead uptime, idle-with-task. Bonus features (decisions/flags pointers, audit auto-fix, soft-judge) stay on bash atmux during burn-in.
- §6.3 I-6 splits: template ships in V-25, invocation site moves to V-27 `team` per ADR-114.

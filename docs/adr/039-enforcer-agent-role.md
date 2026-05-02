# ADR-039: `enforcer` agent role — fleet-level audit consumer on the superdriver team

**Status**: accepted
**Date**: 2026-05-02
**Related**: [ADR-021](./021-unblocker-role.md) (unblocker — per-team blocker triage), [ADR-022](./022-discorder-role.md) (discorder — narrative formatter), [ADR-024](./024-per-member-model-selection.md) (per-member model), [ADR-025](./025-superdriver-phase-1.md) (superdriver registry + super-* verbs), [ADR-038](./038-declarative-live-audit-model.md) (audit model + class taxonomy)

## Context

ADR-038 introduces `atmux audit`: per-team drift detector + per-class auto-fix gating, plumbed through whip's 5min cadence. Per-team coverage is necessary but not sufficient:

- **Cross-team patterns are invisible to per-team whip.** The 2026-04-30 inventory found class B (cage-path separator) drift on 3 of 4 teams — symptom of a fleet-wide convention shift, not 3 independent bugs. A fleet-level audit consumer notices the pattern + drives the systematic fix; per-team whip surfaces each finding in isolation and the operator is left to grep across team logs.
- **Ambiguous classes need cross-team judgment.** When whip surfaces a `⚠️` (medium/high blast), someone has to decide: fire the fix, defer to a maintenance window, escalate to driver. Driver doesn't want this on their plate every 5 minutes; the team-lead's whip cycle is local to one team. A dedicated agent at fleet scope owns the call.
- **Convention docs drift faster than ADRs.** New drift classes surface from operational incidents (class F from the 2026-04-30 16:34 MYT glyph regression). Without a designated maintainer, the audit ADR + class table go stale; new classes aren't added; auto-fix gating doesn't update. The enforcer is the responsible agent.

The role taxonomy already has parallels:

- **planner** — decompose only, never dispatch.
- **reviewer** — signoff only, never claim.
- **unblocker** (ADR-021) — detect + classify + route only, never claim, never plan, never auto-mutate kanban.
- **discorder** (ADR-022) — narrative formatter only, no operational decisions.
- **enforcer** (this ADR) — fleet-level audit consumer + convention maintainer + ambiguous-class on-call. **Never claims kanban Tasks. Never plans. Never auto-fires high-blast fixes; surfaces to driver.**

Three shapes considered for placement:

- **A (chosen)** — fleet-level role on the **superdriver** team. Cross-team scope is the role's defining trait; per-team placement contradicts the role. Same reason superdriver itself lives at fleet scope (ADR-025).
- **B (rejected)** — per-team role replicated on every team. Doesn't solve the cross-team-pattern blindness; just multiplies cost.
- **C (rejected)** — fold into superdriver itself. Bloats superdriver's role; same anti-pattern as folding planner into team-lead. Role-discipline split is the norm.

## Decision

**Add `enforcer` to the role enum** for the superdriver team's `team.json` schema validation.

**Scope**: fleet-wide. Walks `~/.claude/teams/registry.json` per tick + invokes per-team `atmux audit --json` for each entry. Aggregates findings + decides per-finding routing.

**Cadence**: ON-DEMAND (matches superdriver Phase 1 per ADR-025). NO whip-cycle in v1. Driver invokes when needed (typically after a fleet-wide change like an ADR amendment landing); whip's per-team auto-fix continues running independently. Phase 2 may add a low-cadence enforcer cron (e.g. daily 06:00) — deferred until v1 logs ≥3 missed-pattern incidents.

**Per-tick responsibilities** (from `templates/briefs/enforcer.md`):

1. Read `atmux super-status --json` + per-team `atmux audit --json` aggregation.
2. Classify each finding:
   - **fleet-wide pattern** (≥2 teams hitting same class) → surface as a digest entry to driver via `super-tell driver` OR write to `~/.claude/teams/superdriver-bypass-log.md` for review at next driver attach.
   - **isolated finding** (one team) — let whip handle; enforcer no-op.
   - **ambiguous medium/high-blast** that whip surfaced as `⚠️` — propose a fix command + safety gate; surface to driver.
   - **convention regression suggesting new class** — draft an ADR-038 amendment proposing the new class + detector + fix. Land via planner's normal ADR flow (enforcer doesn't bypass planner).
3. Maintain `docs/audit.md` operator guide as new classes / patterns emerge.
4. Maintain `docs/adr/038-declarative-live-audit-model.md` class table — submit amendments via planner.
5. NEVER auto-fire high-blast fixes (B, C). NEVER `tmux send-keys` to other teams' panes (use `super-tell` durability chain per ADR-025).
6. NEVER claim kanban Tasks. NEVER plan (planner's job).

**Spawn topology**: standard member window on the superdriver team (cage `/tmp/atmux_tmux_atmux_superdriver`, single-session per ADR-026). Lane: `misc`. Role: `enforcer`. Brief: `templates/briefs/enforcer.md` (new). Model: `claude-opus-4-7` with `CLAUDE_CODE_EFFORT_LEVEL=xhigh` (judgment-heavy work, NOT mechanical pattern-matching) per global CLAUDE.md model selection rule.

**Add via**: `atmux add-member enforcer --role enforcer --tui claude --model default --lane misc` after a manual edit to the superdriver team's `team.json` is acceptable as a transient path; `lib/add-member.sh` already accepts arbitrary role strings + the schema enum check is in `lib/init.sh`. Long-term: add `enforcer` to the wizard role-list in `lib/init.sh`.

**Cron registration**: NONE in v1. Enforcer is ON-DEMAND. Phase 2 may register `0 6 * * * atmux super-attach && atmux send enforcer "tick"` if v1 demonstrates value.

## Consequences

- **`templates/briefs/enforcer.md`** (new, ~120 lines mirroring unblocker.md shape) — role brief: scope, cadence, classification rules, channels, what enforcer does NOT do.
- **`team.json` role enum** for superdriver team — add `"enforcer"` alongside existing roles.
- **`lib/init.sh` wizard role-list** — add `enforcer` (cosmetic; manual `add-member` works without it).
- **`tests/unit/enforcer_brief.bats`** — assert brief loads via `atmux brief-reload`, asserts `add-member enforcer` lands the role-typed member with the right spawn args.
- **`README.md` §Roles** — document enforcer alongside planner/reviewer/unblocker/discorder.
- **No impact on existing teams** — enforcer is opt-in on the superdriver team only. Per-team teams get audit coverage from whip (ADR-040) without enforcer.
- **Cost trade-off accepted**: enforcer burns Opus tokens on cross-team audit aggregation. ON-DEMAND mitigates (no idle cycle). Driver invokes after fleet-wide changes; otherwise zero.
- **Phase 2 trigger documented**: ≥3 missed-pattern incidents (audit class regressions that landed in prod before enforcer caught them) before adding cron schedule.

## Open questions (auto-mode resolved)

1. **OQ B1 (medium): scope — fleet (chosen) vs per-team?** Resolved: fleet via superdriver. Per-team replication misses cross-team patterns. (medium-rev — could split per-team if fleet enforcer proves too coarse.)
2. **OQ B2 (low): cadence — ON-DEMAND (chosen) vs cron-driven?** Resolved: ON-DEMAND for v1. Phase 2 may add low-cadence cron after ≥3 missed-pattern incidents documented. (low-rev)
3. **OQ B3 (low): model — Opus xhigh (chosen) vs Sonnet?** Resolved: Opus xhigh per global CLAUDE.md model selection rule. Cross-team audit is judgment-heavy. (low-rev)
4. **OQ B4 (medium): writes to driver-inbox vs superdriver-bypass-log?** Resolved: superdriver-bypass-log.md (mirrors ADR-025 phase-1 superdriver discipline). Driver reads at next super-attach. Bypassing through driver-inbox would conflict with the lead-routes-driver-asks pattern. (medium-rev)
5. **OQ B5 (medium): can enforcer auto-fix low-blast classes (D, E, F)?** Resolved: NO. Whip already auto-fires those per ADR-040; enforcer second-pass on the same classes is redundant. Enforcer's value is cross-team aggregation + ambiguous-class judgment. (medium-rev — could expand if pattern emerges where whip misses a class.)

## References

- [ADR-021](./021-unblocker-role.md) — role-discipline split pattern (read-only, never claim, never plan)
- [ADR-022](./022-discorder-role.md) — superdriver-team role precedent
- [ADR-025](./025-superdriver-phase-1.md) — superdriver topology + super-* verb chain
- [ADR-038](./038-declarative-live-audit-model.md) — audit model + class taxonomy enforcer consumes
- [ADR-040](./040-whip-audit-integration.md) — whip sub-pass that handles per-team auto-fix

# ADR-014: Verb design debt — deferred v2 redesign (Phase 6)

**Status:** accepted
**Date:** 2026-05-04
**Owner:** lead

## Context

atmux's bash CLI surface evolved organically over many releases. By the time we started planning the Bun port (PLAN.md), we'd identified seven specific verb-design smells in the existing 30-verb surface. None block functionality, but together they make the API harder to learn, asymmetric in coverage, and inconsistent in naming.

The Bun port has two competing goals:

1. **Parity with bash** — preserve cron lines, scripts, muscle memory across 4 production teams (atmux, sopx-mvp, ifca_aux, unum). Renaming verbs mid-rewrite forces every cron entry, every team-coordination script, and every operator's reflexes to migrate simultaneously with a runtime swap. That's two unrelated risks compounded.
2. **Cleaning up the design** — port is the cheapest moment to redesign the surface, since we're already touching every verb.

CLAUDE.md "structural honesty over demo narrative" rule applies: don't introduce new shapes during a port if the existing shape works. So Phase 2 ports at 1:1 parity. But the rough edges should be captured *now* so they don't get lost in the post-cutover relief.

## Decision

**Phase 2 ports verbs at 1:1 name + arg parity with bash.** No renames, no flag changes, no subcommand restructuring during the port itself. The parity harness validates this strictly.

**Phase 6 (post-cutover) executes a v2 verb redesign** addressing the seven smells below. v2 ships deprecation aliases for the old verbs that emit warnings on use; aliases are dropped in v3 after ~3 months.

### The seven smells (port-side captures, deferred to Phase 6)

| # | Smell | v2 shape | Severity |
|---|---|---|---|
| 1 | `claim` and `done` are top-level verbs but logically belong to tasks | `task claim <id>` / `task done <id>` (subcommand of `task`) | Medium — surface bloat |
| 2 | `add-member` exists but no `remove-member`/`rename-member`/`pause-member` — asymmetric API | `member add/rm/rename/pause/resume` namespace. `pause`/`resume` aliases drop. | **High — real API gap, not just naming** |
| 3 | `tell-lead` and `rotate-lead` are hyphenated specials | `tell <to>` / `rotate <name-or-flag>` (kill the `-lead` suffix) | Medium — naming drift |
| 4 | `up` overlaps `start` (`up` = `doctor + start + attach`) | `start --attach` (kill `up`) | Low |
| 5 | `reconfigure` is "init redux" with a different name | `init --reconfigure` | Low |
| 6 | `status` (text) and `dashboard` (TUI) show same data, different chrome | `status [--watch] [--tui]` | Low |
| 7 | `whip` is opaque jargon for "supervisor tick" | Debate at v2 time. Could stay (it's a cron-fired internal verb that users rarely type), could become `super tick`. Decision deferred. | Low — debatable |

### Naming consistency (cosmetic, deprioritised)

The bash verb set mixes:
- subject-verb (`add-member`, `tell-lead`, `rotate-lead`)
- noun-as-verb (`status`, `inbox`, `outbox`, `dashboard`, `cost`, `report`)
- imperatives (`pause`, `resume`, `dispatch`, `handoff`, `claim`, `done`, `send`, `start`, `stop`)
- aliases (`broadcast` → `send --broadcast`, `task` → `kanban`)

A holistic rename pass to enforce one pattern would be a v2 nice-to-have but is not committed scope. It will be discussed during the Phase 6 kickoff ADR and either approved or deferred to v3.

## Consequences

**Positives:**
- Phase 2 stays simple — porters don't make naming judgement calls under deadline pressure.
- Parity harness has zero false-divergences from rename drift.
- Operators don't migrate cron lines twice (once for runtime, once for verb rename).
- The seven smells are *captured* in writing rather than living in informal conversation.

**Negatives:**
- v1 ships with the warts intact. Operators continue typing `add-member` etc. for ~3 months.
- Phase 6 might stall after v1 ships (the "we're done!" relief trap). PLAN.md §13.2 has explicit anti-pattern guards: team is NOT torn down until Phase 6 closes; quarterly audit checkpoint at 90 days post-v1.
- Deprecation aliases in v2 add ~50 LOC of compatibility code that lives for ~3 months.

**Follow-up tickets:**
- ADR-014a (Phase 6 kickoff): subcommand framework choice — does the CLI dispatcher (ADR-010) accommodate `task <sub>` / `member <sub>` cleanly, or does v2 need a refactor?
- ADR-014b (Phase 6 design): `member rm` semantics — does removing a member archive their inbox? hand off their open tasks? ask first?
- ADR-014c (Phase 6 design): deprecation warning UX — stderr line on every old-verb call? once-per-day? how do scripts opt out?

## Alternatives considered

### A. Redesign in Phase 2 (during the port)

Rejected. Compounds runtime swap with API swap; doubles the surface area of the parity harness; turns every `atmux <old-verb>` cron line into a coordinated migration. Violates CLAUDE.md "structural honesty over demo narrative" — Phase 2's job is parity, not improvement.

### B. Redesign in Phase 5 (alongside WIP catch-up)

Rejected. Phase 5 ports moving WIP from bash; mixing in API redesign would muddle which divergences come from WIP differences vs intentional v2 reshaping. Cleaner to sequence Phase 5 (WIP catch-up at parity) → Phase 6 (v2 redesign) than to interleave.

### C. Never redesign — accept the warts permanently

Rejected. The `member` API gap (smell #2) is a real missing feature, not a cosmetic flaw. Deferring forever means atmux never gains `member rm` / `member rename`, which becomes more painful as more teams use atmux long-term.

### D. Redesign as v1 with deprecation aliases included from day 1

Considered. Would mean the port ships ALREADY with both old and new verb names, deprecation warnings live throughout v1. Tradeoff: faster eventual cleanup vs more Phase 2 work. Rejected because it forces porters to design v2 names *before* having lived with the v1 code in production — the "lived experience" of running TS atmux for 30 days will likely surface insights that change the v2 design.

## References

- PLAN.md §5 (phase table — Phase 6 added) and §13.2 (v2 closure definition of done)
- CLAUDE.md "structural honesty over demo narrative" (review/audit discipline section)

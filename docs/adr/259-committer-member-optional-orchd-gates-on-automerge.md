# ADR-259: Committer member is optional — orchd spawn gates on `autoMerge.enabled`, not committer-presence

**Status**: accepted
**Date**: 2026-06-09
**Driver-ref**: George 2026-06-09 — "reduce team-member count, members self-commit/push" (the directive captured as [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) §D6a). Implements the §D6a reduction lever: relax the orchd spawn gate so the human committer/gitter slot is no longer structurally required.
**Relates**: [ADR-202](202-honker-in-db-messaging-substrate.md) §Amendment (the orchd supervisor + its spawn gate, amended here), [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) §D6a (the directive this lands), [ADR-134](134-in-team-auto-merger.md) / [ADR-091](091-kanban-driven-auto-merge.md) (the in-team fan-in merge orchd runs), [ADR-159](159-gitter-to-committer-rename.md) (gitter≡committer role grace, now moot for this gate), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (orchd-is-the-runtime — the daemon that does the merging).

## Context

A 2026-06-07 code sweep (recorded in ADR-258) established that in modern atmux teams **members already self-commit and auto-push** their own `<base>-<member>` branch (`templates/briefs/member.md` §"Commit ownership — no committer, worker self-commits" + `src/core/auto-push.ts` wired into `claim.ts::done`). The committer/gitter role's only remaining job is the **fan-in merge** (`<base>-<member>` → trunk) — and per ADR-202/233 that merge is run **in-process by the no-LLM `atmux-orchd` daemon**, not by a human keystroke. The human committer member is, at most, a near-idle conflict-handler for the `merger_state` `conflict`/`reverted` terminals.

But `src/core/orchd-window.ts::maybeSpawnOrchdWindow` had a **Gate-2** that refused to spawn the orchd window unless the roster contained a member with role ∈ {`committer`, `gitter`}. That over-restricts: it couples "auto-merge runs" (Gate-1, `autoMerge.enabled === true`) to "a human committer slot exists" — forcing a roster slot that does nothing orchd does not already do, and blocking the directive to run leaner teams. A team could set `autoMerge.enabled: true` and still get no merger, silently, purely because it dropped the committer member.

## Decision

**Remove Gate-2.** orchd spawn eligibility (`maybeSpawnOrchdWindow`) now gates on:

1. **Gate-1** — `team.autoMerge?.enabled === true` (unchanged): the team opted into auto-merge.
2. **Gate-3** — `ATMUX_HONKER` not explicitly disabled (unchanged): the Honker NOTIFY/LISTEN wake is orchd's value proposition.

(Plus the pre-existing nested-`.atmux` refusal guard.) The committer/gitter-presence check is deleted. **orchd is the merger; a human committer member is optional.** This amends the ADR-202 §Amendment spawn gate.

Rationale the gate's removal is safe: orchd's merge state machine (ADR-134/091, `BEGIN IMMEDIATE`-serialized `merger_state`) is deterministic and does not read the committer member's identity — it fans in every `<base>-<member>` branch on `task.done` regardless of whether a human committer is in the roster. The committer member, **when present**, remains the manual handler for the `conflict`/`reverted` reset path; **when absent**, orchd still runs the happy-path fan-in and conflicts surface via the existing durable `merger_state.note` + `flag add` + Discord `[merge-conflict]` path (ADR-091 §anchor #2) for the lead/operator to resolve.

## Consequences

- A team with `autoMerge.enabled: true` spawns orchd and auto-merges **without requiring a committer/gitter roster slot** → leaner default rosters (ADR-258 §D6a). The committer becomes an opt-in conflict-handler, not a structural requirement.
- **Docs already aligned:** `templates/briefs/member.md` already states "committer-less is the default for modern atmux teams" — no brief change needed; this ADR makes the spawn path match the brief. The live `.atmux/team.json` keeping its `gitter` member is an operational choice, not a requirement; this ADR does not remove it.
- ADR-159's "legacy `gitter` accepted as committer-equivalent **for this gate**" grace is now moot (the gate no longer inspects role); the `gitter`/`committer` role itself is unaffected everywhere else it is used (lane routing, briefs, fan-in attribution).
- Test `orchd-window.test.ts` "no committer/gitter role → no spawn" flips to "→ spawns (committer optional, ADR-259)"; the header comment's gate list drops the committer clause.

# ADR-210: Eliminate hold-posture deadlock structurally — lead brief fix + pull-protocol dispatch

**Status**: Proposed — filed by driver 2026-05-21 immediately after ADR-209 correction
**Date**: 2026-05-21
**Driver-ref**: sopx driver (geoyws) 2026-05-21 — `atmux tell-lead` 17:00ish MYT explaining ADR-209 captures the detection-and-recovery layer; this ADR proposes the structural fix that makes the deadlock impossible rather than just recoverable.
**Extends**: ADR-090 (epic-team spawn/dissolve), ADR-209 (hold-posture deadlock detection — the workaround layer this ADR makes redundant).
**Relates**: ADR-027 (doctor probes), ADR-132/158 (sentinel), `atmux claim --next` verb semantics.

## Context

ADR-209 surfaces a hold-posture deadlock: lead holds for planner activity, members hold for lead dispatch, kanban populated but nothing dispatches. ADR-209's solution is detect + auto-kick via sentinel — a backstop. It does NOT eliminate the deadlock; it makes recovery automatic. The deadlock pattern stays in the lead's bootstrap brief and member-side bootstrap-hold memory, and any future configuration drift can re-introduce it.

This ADR proposes the **structural fix** — change the agent-orchestration model so the deadlock cannot exist.

## Decision

Two tiers, sequenced. Tier 1 alone removes the active deadlock. Tier 2 adds resilience + makes the lead role optional for routine dispatch.

### Tier 1 — Eliminate hold-for-planner from lead bootstrap (single brief change)

**Current lead bootstrap brief** (effective shape, paraphrased from observed behavior):
```
On first turn:
  1. Read kanban + driver-inbox + lead-outbox
  2. If planner has not yet refined incoming tickets, HOLD for planner activity
  3. Once planner has produced refined tickets, dispatch by role
```

Step 2 is the deadlock. When kanban is populated at spawn time (which it is — `team spawn-epic` populates it from the operator-supplied roster + scope), step 2 fires before any planner activity has occurred. Lead idles. Members idle on bootstrap-hold (waiting for lead). Planner idles (no incoming planning ask). Deadlock.

**Proposed lead bootstrap brief:**
```
On first turn:
  1. Read kanban + driver-inbox + lead-outbox
  2. If kanban.todo > 0:
       a. Immediately claim-next + assign-by-role (fe-* → frontend, be-* → backend, db → db, devops → devops, reviewer ← when work-product surfaces for review)
       b. Planner runs IN PARALLEL on un-refined tickets — refining ticket bodies, splitting epics into stories, adding acceptance criteria. Lead picks up refinements on subsequent dispatches.
  3. If kanban.todo == 0:
       a. HOLD for kanban population (driver task add OR planner-side ticket creation)
       b. Do NOT block on planner activity per se — planner without kanban-to-refine is its own waiting state
```

Key change: **planner moves from gating (synchronous, lead-blocks) to enriching (asynchronous, lead-takes-current-best).**

Implementation surface:
- `templates/briefs/lead.md` (or wherever atmux's lead-bootstrap template lives) — edit step 2
- `templates/briefs/planner.md` — clarify planner's role is async refinement, not gating
- Member briefs — no change; bootstrap-hold + readiness-ping pattern is fine as long as lead actually dispatches (which Tier 1 ensures)

This ALONE removes the deadlock observed in sopx 2026-05-21. Tier 2 adds belt-and-braces.

### Tier 2 — Pull-protocol dispatch for member self-rescue

**Problem Tier 1 doesn't solve:** lead is single-point-of-dispatch. If lead crashes, gets rate-limited mid-turn, gets a stuck tool call, or makes a process error and silently exits, the team blocks again — different cause, same symptom.

**Proposed pull protocol:**

Members' bootstrap brief adds a fallback timer:
```
After sending readiness ping to lead:
  Wait up to T_DISPATCH_TIMEOUT (default 15min) for lead to dispatch a task.
  If no task arrives:
    1. Read kanban directly (atmux task list --status todo --assignee unassigned)
    2. claim-next ONE ticket compatible with my role (fe-* claims FE tickets, be-* claims BE, etc.)
    3. Update lead via atmux reply: "self-claimed t-<id> after lead-dispatch timeout — proceeding"
    4. Begin work
```

`atmux claim --next` already supports this (per memory `[[feedback_atmux_claim_next_semantic_trigger]]`). The change is making it a routine fallback rather than an exceptional verb.

Coordination concerns:
- **Same-ticket double-claim risk.** Two members hit the timeout simultaneously and both claim the next ticket. Mitigation: `atmux claim` already uses kanban lock (per current implementation); first claimant wins, second sees the ticket as in-progress and skips. Verify the lock is robust under concurrent claims; if not, that's a Tier 2 implementation prerequisite.
- **Role-mismatch claims.** A fe-1 member shouldn't claim a BE-scoped ticket. `claim --next` should respect role-tag filters on tickets (`atmux claim --next --role fe`). Ticket-tagging discipline matters here.
- **Lead recovery.** If lead comes back online after a member self-claimed, lead should observe the self-claim via kanban state, not re-dispatch the same ticket. Lead's brief: "on resume after idle, READ kanban state BEFORE dispatching — respect existing in-progress claims".

### Tier 3 — Emerges naturally (no separate work)

Once Tier 2 is mature + lock semantics are proven, the lead role becomes optional for small epics. Lead remains for: priority-setting, ambiguous role-assignment, blocker resolution, sign-off. Routine dispatch is fully pull-based. No ADR needed; the migration happens organically as operators leave the lead off for small spawn-epic invocations.

### Tier 4 — Explicit non-goal

Workflow state machine (atmux as orchestrator with explicit state transitions per ticket) — REJECTED. Too heavy for the team-of-claudes pattern. Kanban + pull-protocol is enough orchestration. State machines impose ceremony that doesn't pay for itself at this team size.

## Implementation slices

| Slice | What | Tier | Effort | Risk |
|---|---|---|---|---|
| S1 | Edit `templates/briefs/lead.md` to replace hold-for-planner with kanban-first dispatch | Tier 1 | XS | Low — text change |
| S2 | Edit `templates/briefs/planner.md` to clarify async-enrichment role | Tier 1 | XS | Low |
| S3 | Backport S1+S2 brief changes to all currently-running epic-teams (re-bootstrap on next /clear) | Tier 1 | S | Medium — existing teams need /clear to pick up new brief |
| S4 | Verify `atmux claim --next` kanban-lock is robust under concurrent claims | Tier 2 | M | Medium — race-condition surface |
| S5 | Add `T_DISPATCH_TIMEOUT` member fallback to member bootstrap brief | Tier 2 | S | Low — text change |
| S6 | Add ticket role-tag filter to `claim --next` (`--role <fe|be|db|...>`) | Tier 2 | M | Low |
| S7 | Lead post-idle resume: read kanban state first to avoid re-dispatching | Tier 2 | S | Low |

Tier 1 (S1+S2+S3) ships first — closes the active deadlock. Tier 2 (S4–S7) ships as a follow-up release once S4 is verified.

## Open questions

- **OQ1 — backport vs new-spawn-only.** Tier 1's brief changes only take effect on NEW spawn-epic invocations (the brief is materialized at spawn). Existing teams need a `/clear` to re-bootstrap. Driver pref: ship as new-spawn-only and announce; let operators choose to /clear existing teams or not. Backport via S3 if specific stuck teams need it.
- **OQ2 — pull-protocol opt-in vs default.** Tier 2's `T_DISPATCH_TIMEOUT` member fallback — default 15min, or longer? Should opt-out be available per-team (`disablePullFallback: true` for teams that really want strict lead-only dispatch)? Driver pref: default 15min, opt-out per-team via team.json flag.
- **OQ3 — interaction with ADR-209 sentinel auto-kick.** If Tier 1 lands, the sentinel auto-kick from ADR-209 §4 becomes redundant in the common case. Keep it as backstop for non-Tier-1-brief-aware teams + edge cases? Driver pref: keep ADR-209 §4 as backstop; lower its priority from sentinel-must-fire to sentinel-only-when-cage-truly-stuck.

## Consequences

**Positive:**
- Deadlock becomes structurally impossible (Tier 1) — not just detectable + recoverable
- Lead role becomes pure orchestration, freed from per-ticket dispatch toil (Tier 3 emergent)
- Teams gain self-rescue under lead failure modes (Tier 2)
- Reduces sentinel kick noise (auto-kicks become rare)

**Negative:**
- Existing in-flight epic teams must /clear to pick up new lead brief (backport friction)
- Pull-protocol kanban-lock is a new concurrency surface to test (Tier 2 risk)
- Operators who relied on lead-as-gatekeeper for routing decisions lose that — must move routing into ticket role-tags (cultural change)

**Neutral:**
- ADR-209 sentinel auto-kick stays as backstop; cohabits with structural fix without conflict

## Evidence / repro

Tier 1 demonstrated to work via the manual workaround. Sopx 2026-05-21:

```bash
# Symptom: 7 epic-teams alive, kanban populated, 0 dispatched, 0 commits
# Manual fix: replicate what Tier 1's brief change would do automatically:
cd /root/work/ifca/src/sopx-root-epics/e-2df34086
ATMUX_CALLER_SCOPE=driver atmux send lead "/bruh — kanban has 3 todos. Dispatch NOW."
# Result: budget meter 5h 57% → 5h 5% (lead processed prompt, began dispatching)
```

The /bruh prompt effectively says "don't hold for planner; dispatch the kanban you already have". That's the Tier 1 lead brief change condensed into a runtime nudge. Doing it at brief-bootstrap time instead of runtime kick = the structural fix.

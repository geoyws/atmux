# ADR-213: Retire `_jury` role — Reviewer absorbs Acceptance-Criteria verification

**Status**: proposed
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator — *"i'm thinking maybe we don't need the jury... we just need reviewer to gate it.... we need to write stronger reviewer gates... the reviewer will check for the Access Criteria and also the Reviewer will review the work according to the access criteria"* — consistent with same-session sentinel retirement (ADR-211) + medic retirement (ADR-212) per the operator's "atmux is getting too complex and we need to simplify" directive.
**Supersedes**: [ADR-204](204-jury-role-acceptance-criteria-contract.md) (`_jury` role + ratify/verdict verbs + ADR-144 state-machine extension) — entire ADR superseded. ADR-204 §Amendment 2026-05-21 (jury runs Opus not cursor) becomes moot — the role itself retires. **Reverts**: [ADR-144 §Amendment 2026-05-21](144-epic-team-test-gate.md) (jury-pending → jury-approved → merge-ready state additions) — without jury, the original ADR-144 state machine (with `review` state) stands; reviewer-signoff is the gate.
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) §D12 (Honker consumer EPIC sequence — `e-honker-jury` EPIC dropped per §D5 below), [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) + [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) (sibling simplification ADRs — sentinel + medic retirements), [ADR-144](144-epic-team-test-gate.md) (epic-team test-gate — original state machine reinstated by reverting §Amendment 2026-05-21), [ADR-091](091-kanban-driven-auto-merge.md) (kanban-driven auto-merge — reviewer-signoff already the gate per existing flow), memory `feedback_opus_all_for_agile_flow` (Opus-only stance — once cursor was rejected, jury's diversity rationale collapsed).

## Context

ADR-204 introduced `_jury` as a separate cursor-based adversarial-LLM gate. The justification was **adversarial-LLM-diversity**: reviewer (Opus) and members (Opus) share blind spots; a different LLM (cursor composer-2.5-fast) catches what same-family review misses. That premise was the entire load-bearing argument.

The premise collapsed on 2026-05-21:

1. **ADR-201 rejected cursor across atmux** — cursor is OUT at every tier.
2. **ADR-204 §Amendment 2026-05-21** flipped `_jury` from cursor → Claude Opus. Same model + same effort level as reviewer. The diversity argument evaporated — it's now Opus-checking-Opus, two passes of the same model family.
3. **Operator's same-session simplification directive** (in ADR-212): "atmux is getting too complex and we need to simplify."

What jury added structurally:
- New default member per team (`_jury`)
- New verb pair (`atmux jury ratify` pre-work + `atmux jury verdict` post-work)
- New state-machine extension to ADR-144 (jury-pending → jury-approved → merge-ready + jury-rejected → in-progress)
- New ping-pong cap + lead-arbitration verb (`atmux jury arbitrate`)
- New Honker consumer EPIC (`e-honker-jury` — already spawned as `e-5a5110d0`, soft-stopped)
- Stage 0 dogfooding manual-mode flag

What jury actually delivered beyond what reviewer-with-AC could deliver:
- A pre-work AC-completeness check (jury ratify) — extra layer
- A second pass on shipped work — extra cost, same model

The **acceptance-criteria contract** is the load-bearing concept. The **role doing the verification** is the implementation detail. Both jury AND reviewer can do that verification. Reviewer is already in the chain, already trusted, already a default member, already consumes `story.tested` per ADR-144's existing flow. Folding AC verification into the reviewer eliminates the whole jury scaffolding.

## Decision

### D1 — Retire the `_jury` role entirely

No production atmux configuration ships `_jury`. Same shape as ADR-211 §D1 (sentinel) + ADR-212 §D1 (medic):

- `_jury` is NOT added as a default member to any team going forward
- The `e-5a5110d0` EPIC (Honker jury consumer, spawned 2026-05-21, soft-stopped post-spawn for trunk-rename) is dissolved — see §D5
- Verbs `atmux jury ratify` / `atmux jury verdict` / `atmux jury arbitrate` are not implemented (impl-EPIC `e-honker-jury` per ADR-202 §D12 dropped per §D4)
- The `--manual` Stage 0 flag (ADR-204 §D7) is moot — no autonomous mode to bootstrap toward

### D2 — Reviewer absorbs Acceptance-Criteria verification

The reviewer brief grows a mandatory **§Acceptance-Criteria verification** section. Reviewer signoff REQUIRES per-AC pass/fail. AC list lives at `stories.extra.acceptance_criteria[]` exactly as ADR-204 §D2 specified — that schema decision stands; only the actor verifying it changes.

**Reviewer signoff contract becomes** (extends existing reviewer flow):

```
reviewer reads:
  - cumulative diff across the story's child Tasks
  - test-gate result (must be `tested` per ADR-144)
  - stories.extra.acceptance_criteria[] list

reviewer signs:
  - per-AC verdict: every AC item gets `pass` | `fail` with notes
  - overall: APPROVED (all pass) | REJECTED (any fail)
  - REJECTED routes story back to `in-progress` per ADR-144's original review state
  - APPROVED transitions story to merge-ready; gitter merges per existing flow

reviewer refuses to sign:
  - if acceptance_criteria is empty/absent → auto-REJECTED with "AC list missing" feedback
  - same auto-reject pattern as ADR-144 §reviewer-signoff "empty acceptanceCriteria is automatic REJECT"
```

### D3 — Pre-work AC ratification dropped

ADR-204 §D5 specified `atmux jury ratify <story-id>` — jury approves planner's AC before work begins, 3-strike ping-pong with lead arbitration. This pre-work gate is **dropped** in this ADR.

Rationale: pre-work ratification was insurance against incomplete AC. The same insurance is now obtained at **review time** — reviewer auto-rejects a story whose AC was incomplete (per §D2's auto-reject on empty AC). If reviewer can't grade against the AC because the AC itself is vague, reviewer rejects with "AC #N too vague to grade" feedback; planner revises AC; reviewer re-signs.

The 1-2 ratify-cycle latency saved by pre-work ratification doesn't justify the role + verbs + state-machine + ping-pong scaffolding. Reviewer absorbing the same pattern at signoff time is cheaper.

Planner discipline: planner brief amends to require AC be filled in on Story creation (Zod-schema-level — `acceptance_criteria.length >= 1` enforced at `atmux story add` time). Operator can flip a strictness flag to permit empty AC if specific stories warrant (audit-storage workflow already supports this via Zod `.optional()`).

### D4 — Revert ADR-144 §Amendment 2026-05-21

ADR-144 §Amendment 2026-05-21 added jury-pending / jury-approved / jury-rejected states to the story state machine + introduced `--bypass-jury` flag mirror. With jury retired:

- The jury-states amendment becomes **superseded** by this ADR. ADR-144 §Amendment 2026-05-21 gets an inline annotation pointing here.
- Original ADR-144 state machine (with `review` state) stands:
  ```
  planning → ready → in-progress → testing → tested → review → done
                                   ↘ test-failed → in-progress
                                                              ↘ review-rejected → in-progress
  ```
- `--bypass-jury` flag is moot — never implemented, never referenced.
- `juryGateMode` config field (ADR-144 §Amendment 2026-05-21) is moot — never implemented.

Gitter refuses to merge unless story state is `review` (signoff-stamped) per the original ADR-144 + ADR-091 flow. Same kill-switch shape; one fewer state to track.

### D5 — Drop the `e-honker-jury` consumer EPIC + dissolve `e-5a5110d0`

ADR-202 §D12 listed `e-honker-jury` as the first real Honker consumer (spawned as `e-5a5110d0` on 2026-05-21). Per this ADR, that EPIC has no scope:

- The jury verbs aren't implemented (no consumer needed).
- Reviewer is **already** a Honker subscriber per ADR-202 §D12's `e-honker-cleanup` reviewer-eventize work (deferred — reviewer can stay cron-based for now).
- AC-related event topics from ADR-203 §D2 (`story.jury.*`) are dropped from the closed v1 topic set. **Five topics removed**: `story.jury.ratified`, `story.jury.pending`, `story.jury.verdict`, `story.jury.escalated`, `story.jury.ratify-rejected`. TOPICS registry count drops from 39 → 34.

**Dissolution of e-5a5110d0** (operator runs in their own session):
```bash
ATMUX_CALLER_SCOPE=driver atmux team dissolve-epic e-5a5110d0
# Verifies + removes worktree + cockpit.json registry entry +
# cron block (per ADR-197 cron-reaper teardown contract).
```

The kanban EPIC entry for e-5a5110d0 transitions to `done` with reason `superseded by ADR-213 — jury retired`. Worktree at `/root/work/src/atmux-epics/e-5a5110d0` removed by dissolve-epic.

**Updated ADR-202 §D12 EPIC sequence — 4 consumer EPICs after substrate (down from 5 per ADR-212 §D4):**

| EPIC | Scope |
|---|---|
| e-honker-substrate | Phase-1 shipped (commit `a8875cb..ef22584`) |
| ~~e-honker-jury~~ | **DROPPED per ADR-213** |
| e-honker-gitter | gitter listens for `task.done` → merge. **Now the first real consumer EPIC.** |
| e-honker-observation-watchdogs | Sentinel + medic functions absorbed (per ADR-211 §D2 + ADR-212 §D4 + §D7 context-pct enrichment) |
| e-honker-whip | `/whip run` becomes event-consumer |
| e-honker-cleanup | Delete sentinel.ts + medic verb + jury references + cron-backstops ≥30 days stable + ADR-091/134/145 §Amendments + jury-related event-topic schemas |

**Net architecture:** 4 consumer EPICs after substrate. Down from 5 (ADR-212 amendment), 10 (ADR-211 amendment), 8 (original ADR-202 §D12). The simplification accelerates with each retirement.

### D6 — Brief + memory sweep

- `templates/briefs/reviewer.md` gets a mandatory §"Acceptance-Criteria verification" section per §D2 contract. Required AC checklist + per-AC verdict format + auto-reject conditions.
- `templates/briefs/planner.md` gets §"AC discipline" reminder — write testable AC; reviewer will reject vague AC; revise + re-signoff is the loop.
- `templates/briefs/jury.md` (if present) deleted in cleanup-EPIC.
- Memory `feedback_opus_all_for_agile_flow` already reaffirmed 2026-05-21 covers this stance.

### D7 — Doctor probe

Single probe row `jury-config-residue` (yellow → red post-cleanup-EPIC) when any `team.json::members[]` has `name === "_jury"` or `id === "_jury"`. Hint: per ADR-213, jury retired — remove member; reviewer absorbs verification.

Merges with `medic-config-residue` (ADR-212 §D6) + `sentinel-config-residue` (ADR-211 §D3) in cleanup-EPIC. **Three retirement-residue probes → one consolidated `retired-role-config-residue` probe** in cleanup.

## Consequences

**Becomes easier:**

- One fewer default member per team (no `_jury` pane spawned)
- One fewer verb family to implement (`atmux jury *`)
- One fewer state-machine extension to maintain (ADR-144 jury-states reverted)
- One fewer Honker consumer EPIC (e-honker-jury dropped → e-5a5110d0 dissolved)
- TOPICS registry simpler (39 → 34)
- AC contract still exists + still enforced — just by an existing actor
- Reviewer scope grows naturally — reviewer was already the post-test signoff actor; AC verification fits its role

**Becomes harder:**

- Reviewer's responsibility broader — more risk of reviewer being a bottleneck. Mitigation: reviewer brief documents triage; lead can rotate reviewer if backlog grows; reviewer is Opus + xhigh already, so judgment quality stays.
- No second pass — if reviewer misses an AC failure, gitter merges + the gap ships. Mitigation: existing reviewer brief already requires per-line diff review; AC verification is an additional structured checklist on top; misses get caught at the next signoff cycle when downstream AC depends on the missed one.
- Pre-work AC ratification removed — incomplete AC discovered at review time, not at planning time. Mitigation: planner brief amendment requires non-empty AC at story-add time (schema-level enforcement); operator can flip strictness per team.

**Risks + mitigations:**

- **Risk**: Reviewer signs off without actually reading the AC (rubber-stamp). **Mitigation**: signoff verb requires per-AC verdict payload; absent payload = signoff refused at schema gate. Auditable trail (every signoff carries the AC verdicts).
- **Risk**: Planner writes vague AC; reviewer rejects; planner revises; loop. **Mitigation**: same ping-pong cap pattern from ADR-204 §D5 applies — 3-strike then escalate to lead. Reused mechanism, no new code.
- **Risk**: e-5a5110d0 EPIC dissolution leaves stale references (cron, cockpit, kanban). **Mitigation**: `atmux team dissolve-epic` per ADR-197 cron-reaper teardown contract handles cleanup. Doctor probe catches residue.
- **Risk**: Operator changes stance — wants jury back. **Mitigation**: ADR-204 stays Accepted (superseded ADRs aren't deleted). Re-adding jury is a new ADR + reverting this one's §D1.

## Out of scope (deferred)

- **Re-adding `_jury` for any future LLM** — separate ADR + impl-EPIC if/when needed.
- **Cross-AC review correlation** (e.g. "AC #3 across multiple stories trends as repeatedly-failing → planner-pattern-flag") — operator-driven analysis via `coordination:bau` or new `atmux audit ac` verb; not in this ADR.
- **Automated AC scoring** (LLM grades each AC pass/fail without operator-supplied criteria) — out of scope; reviewer is the actor.
- **Pre-work ratification reintroduced via lead** — operator option later if the auto-reject-on-vague-AC pattern proves too slow; not in this ADR.

## References

- ADR-204 — `_jury` role + AC contract (entire ADR superseded by this one — `_jury` retires; AC contract stays via reviewer)
- ADR-144 — epic-team test-gate (§Amendment 2026-05-21 reverted by §D4)
- ADR-211 — sentinel retirement (sibling simplification)
- ADR-212 — medic retirement (sibling simplification)
- ADR-202 §D12 — Honker substrate consumer EPIC sequence (amended per §D5 — drops e-honker-jury)
- ADR-203 §D2 — event topic taxonomy (drops 5 jury-prefixed topics; TOPICS count 39 → 34)
- ADR-091 — kanban-driven auto-merge (reviewer-signoff is already the gate per existing flow)
- ADR-197 — cron-reaper teardown contract (used by dissolve-epic for e-5a5110d0 cleanup)
- memory `feedback_opus_all_for_agile_flow` — Opus-only stance; once cursor was rejected, jury's diversity rationale collapsed
- memory `project_honker_pubsub_rehaul_design` — design state; needs annotation that jury EPIC dropped + e-5a5110d0 dissolved

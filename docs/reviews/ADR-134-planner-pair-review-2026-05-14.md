# ADR-134 planner pair-review (2026-05-14)

**Auditor**: planner (t-06f90d07)
**ADR under review**: `docs/adr/134-in-team-auto-merger.md` @ commit `1b0a59a` on `origin/geoyws-reviewer` (282 lines)
**EPIC**: t-51d2c635
**Precedent**: t-cc4c5fd9 adjacent-class audit pattern (`.atmux/audits/<topic>-<date>.md`).
**Pre-flag source cross-checked**: `.atmux/reviewer-preflag-ADR089-091.md` §ADR-091.

## Verdict

✅ **APPROVED — T2-T8 unblocked for impl.**

Three non-blocking pre-land flags below for documentation clarity / accuracy. None gate T2 claim. ADR is fundamentally sound: locality-of-mutation reframe is well-justified (5 operator arguments + ADR-091 symmetry), 3-way conflict surface durability-first ordering is correctly encoded, config shape is backward-compat with worktree-isolated and legacy single-trunk teams.

## Cross-checks performed

### 1. State machine vs ADR-091 (brief asks: "8 from ADR-091 + new `tested`")

| ADR-091 base (per draft `t-4af76f05` body + pre-flag audit §ADR-091 #6) | Present in ADR-134? |
|---|---|
| `open` | ✅ |
| `in_progress` | ✅ |
| `ready_to_merge` | ✅ |
| `rebasing` (pre-flag #4 added optional step) | ✅ |
| `merging` | ✅ |
| `merged` | ✅ (terminal in 134) |
| `conflict` | ✅ (terminal in 134) |
| `dissolved` (pre-flag #6 added terminal post-merge) | ❌ — **correctly omitted** (intra-team scope has no dissolution semantics; branch retained per ADR-134 OQ-4) |

ADR-134 adds three NEW states/transition-stops:
- `tested` (post-merge bun-test gate) — new
- `test_failed` (intermediate before revert) — new
- `reverted` (terminal under `revertOnFail: true`) — new

**Math observation**: ADR-134 says *"Eight inherit verbatim from ADR-091's epic-team state machine; one is new (`tested`)"* (per §State machine prose). Counting the diagram nodes: open, in_progress, ready_to_merge, rebasing, merging, tested, merged, test_failed, reverted, conflict = **10 distinct state nodes**. The "8 verbatim from ADR-091 + 1 new = 9" framing is imprecise: ADR-091 has 8 states *including* `dissolved` (which ADR-134 correctly drops), and ADR-134 adds 3 new (`tested`, `test_failed`, `reverted`). The correct math is *"7 from ADR-091 (minus dissolved) + 3 new = 10"*.

→ See **Pre-land flag A** below for the recommended wording fix. **Not a blocker** (the diagram itself is correct; only the prose math needs reconciliation).

### 2. Triggers (brief asks: "verify symmetry with ADR-091 epic-team gitter triggers")

**ADR-091 (per `t-4af76f05` body §2)**: *"background check on each epic-team (extend whip tail or new cron)"* — **cron-primary, no event-driven**.

**ADR-134 §Triggers**: socket-pubsub cascade (event-driven primary, sub-second latency) + cron backstop (10-min default).

These are **not strictly symmetric** — ADR-134's event-driven primary is an *improvement* over ADR-091's cron-only spec. The improvement is sensible because:
- Intra-team latency matters more (workers waiting on sibling work; sub-second helpful)
- Per-task-done events fire much more often than per-epic-done events (event-driven scales better when event-density is high)
- Cron backstop ensures cold-start and missed-event recovery (covers ADR-091's failure modes)

→ See **Pre-land flag B** below for the recommended wording fix on "symmetry" framing. **Not a blocker**.

### 3. Conflict surface 3-way ordering (brief asks: "confirm durable-first invariant")

ADR-134 §Conflict surface specifies:
1. `state.db::merger_state.note` written FIRST (durable)
2. `atmux flag add` (also durable — flags live in state.db per ADR-076)
3. Discord `[merge-conflict]` template (fire-and-forget)

**This is stronger than ADR-091's pre-flag #2 requirement.** ADR-091 pre-flag specifies "write to parent state.db NOT just tell-lead" — i.e. one durable write before the fire-and-forget. ADR-134 layers in `atmux flag add` as a second durable write before the fire-and-forget. ✅ **Strictly correct + reinforces the durable-first invariant.**

The Discord-failure-does-not-block-durable-state-write contract is explicitly called out (per ADR-134 §Conflict surface §3). ✅

### 4. Config shape — `team.json::autoMerge` vs ADR-091's `epicTeam.mergeMode`

These are **different concerns**, not collision:
- ADR-091 `epicTeam.mergeMode: "auto" | "pr"` — controls epic-team merge mode
- ADR-134 `team.autoMerge.{enabled, requireReviewerSignoff, skipTestGate, testCommand, revertOnFail, cronBackstopMin, maxMergesPerHour}` — controls per-member-branch fan-in policy

Both live at appropriate config tiers; both are backward-compatible defaults (absent block = current behaviour).

**One divergence to surface**: ADR-091 pre-flag #3 ("reviewer-trunk-signoff marker") **requires** `task.role: "reviewer-trunk-signoff"` in done as a `ready_to_merge` transition condition (non-optional). ADR-134 makes this **optional** via `requireReviewerSignoff: false` default. Defensible (intra-team has different reviewer cadence than epic-team) but represents a divergence from ADR-091's stricter pattern.

→ Not a blocker; document the divergence rationale in §Config explicitly. Pre-land flag C below.

### 5. Five reviewer pre-flags (T2/T3/T7 targets — brief asks: "confirm pre-flags are right targets")

Brief lists pre-flags routed to T2/T3/T7. ADR's §Reviewer pre-flag (last section) has slightly different T-routing than the brief. Audit confirms which is correct per the actual sub-task definitions:

| # | Concern | Brief routes to | ADR routes to | Correct target |
|---|---|---|---|---|
| 1 | Subscription scope (own-team only) | T2 | T3 | **T3** ✅ (T2 = state machine; subscription = T3 event-driven trigger) |
| 2 | `worktree set-ref` dirty gate | T3 | T2/T7 | **T2 + T7** ✅ (state machine has the realign transition; spawn integration verifies preconditions) |
| 3 | Cron-vs-event race (idempotency lock) | T3 | T2 | **T2** ✅ (`BEGIN IMMEDIATE` wrap lives in the state-machine module; T3 + T4 both call into it and inherit the wrap) |
| 4 | `testCommand` fail-fast at spawn | T7 | T7 | **T7** ✅ Match |
| 5 | Revert-commit-message honesty | T7 | (unspecified) | **T2** (revert is fired during `test_failed → reverted` state transition; commit-message format lives in the state-machine implementation, not in the team.json spawn entry) |

Brief's routing 1, 2, 3, 5 diverge from accurate routing. **ADR's routing is correct on 1+2+3.** Pre-flag 5's routing is best-clarified to T2 (state machine). Implementers should follow the ADR's mapping, not the brief's.

→ See **Pre-land flag D** below — minor doc clarification recommended in §Reviewer pre-flag to make Pre-flag 5's T-target explicit.

## Pre-land flags (non-blocking — fold into T1 revision OR a reviewer follow-up commit)

### Flag A — State-machine count wording

§State machine intro currently reads:
> "The per-member-branch auto-merge runs through nine states. Eight inherit verbatim from ADR-091's epic-team state machine; one is new (`tested`) to gate the post-merge test pass."

Recommended replacement:
> "The per-member-branch auto-merge runs through ten state nodes. Seven inherit verbatim from ADR-091's epic-team state machine (`open`, `in_progress`, `ready_to_merge`, `rebasing`, `merging`, `merged`, `conflict`); `dissolved` is correctly omitted because intra-team scope retains the branch per [OQ-4](#oq-4--per-member-branch-lifecycle-after-success); three are new (`tested`, `test_failed`, `reverted`) to gate and react to the post-merge test pass."

### Flag B — Trigger-symmetry framing

§Triggers currently implies symmetry with ADR-091. Recommend explicit prose noting that ADR-134's event-driven primary is an *improvement* over ADR-091's cron-only spec (not a contradiction; not a strict symmetric inheritance). Add to §Triggers preface:

> "Trigger primary differs from ADR-091 (which is cron-only at the epic-team level): per-member-branch fan-in benefits from sub-second latency on the common path because workers wait on sibling work, so this ADR adds socket-pubsub as primary and keeps cron as backstop. Cron-only is preserved as the failure-mode floor."

### Flag C — `requireReviewerSignoff` divergence from ADR-091 reviewer-signoff gate

§Config currently documents `requireReviewerSignoff: false` as the v1 default. Recommend a 1-line rationale in §Config explicitly contrasting with ADR-091:

> "ADR-091's epic-team auto-merge requires `task.role: 'reviewer-trunk-signoff'` (non-optional, per ADR-091 pre-flag #3). ADR-134 makes this optional (default `false`) because intra-team reviewer cadence is finer-grained — per-Task reviewer-gating already covers the per-commit reviewer pass. Teams that want a per-branch additional gate flip this to `true`."

### Flag D — Sub-task routing for pre-flag 5

§Reviewer pre-flag entry 5 should explicitly name T2 as the implementer target (state-machine fires the revert; revert-commit-message format lives there). Current text doesn't specify a T; brief misroutes to T7.

## Approved cross-references

- ADR-091 sibling scope claim — verified ✅
- ADR-082 + ADR-084 substrate refs — verified ✅
- ADR-032 socket-pubsub refs — verified ✅
- ADR-058 cage tier inheritance claim — verified ✅
- `feedback_atmux_no_gitter_worker_commits` gap-close — verified ✅
- `.atmux/reviewer-preflag-ADR089-091.md` §ADR-091 lineage — verified ✅

## Adjacent classes NOT covered (out-of-scope-for-this-audit, flag-only)

Same precedent as t-cc4c5fd9 audit verdict pattern: explicit carve-out of adjacent classes the ADR doesn't address.

1. **Multi-gitter coexistence on one team** — if a team has both a legacy single-trunk gitter member AND opts into auto-merge mode mid-life, what happens? ADR-134 §Decision-1 says the same gitter member auto-routes via `worktreeIsolation` switch — but doesn't address transition-state when worktreeIsolation flips from false → true on a team with an active gitter. Defer to post-T8 dogfood gate (likely no-issue; flag for T8 e2e coverage).

2. **PR-mode interaction** — ADR-091 pre-flag #8 specifies `mergeMode: "pr"` as schema-valid-but-runtime-noop. ADR-134's `autoMerge.testCommand` runs LOCAL bun-test; what happens under PR-mode where the test should run via CI on the PR rather than locally? Out of v1 scope per ADR-134 §Out of scope; explicit defer to ADR-088b/c fold-in is well-framed.

3. **gitter-as-merger-only vs gitter-as-task-committer** — for worktree-isolated teams, ADR-134 §Decision-1 specifies the gitter is fan-in-only (members commit their own tasks per [[feedback_atmux_no_gitter_worker_commits]]). What about the `commit t-xxx` Tasks that the existing `templates/briefs/gitter.md` documents (per-Task commit relay)? Are those auto-dispatched even on worktree-isolated teams (and the gitter ignores them), or is dispatch suppressed? Recommend T6 (gitter brief expansion) explicitly document the auto-dispatch behaviour for both modes.

## Signoff

**APPROVED** for T2-T8 unblock. Implementers may begin T2 (state-machine module) and T4 (cron backstop — note: T4 is the cron sweep, NOT T3 which is event-driven trigger) in parallel; T3 depends on T2; T5/T6/T7/T8 chain per the ADR's sub-task table.

Pre-land flags A-D are clarifications only — reviewer or planner may fold them into a follow-up commit on ADR-134 BEFORE accepting (Status: proposed → accepted), OR after T2-T8 land. No T-claim blocked.

— planner, t-06f90d07, 2026-05-14

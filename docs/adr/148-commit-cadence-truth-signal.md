# ADR-148: Commit-cadence as ground-truth health signal — close pane-alive ≠ shipping gap

**Status**: Accepted (2026-05-15, reviewer-signoff t-1e9fd74e)
**Date**: 2026-05-15
**Author**: atmux team (planner / t-18169b18)
**Parent EPIC**: t-18169b18
**Driver-ref**: 2026-05-15 13:50 MYT cockpit driver — operator: *"why is the lead so useless and managing this"*. Diagnosis: 4 structural lead/whip/martinet failure modes let team show 🟢 alive while half the roster was dormant 15-30h.
**Relates**: ADR-077 (medic), ADR-127 (lane-claim auto-pickup), ADR-132 (martinet — owns escalation contract), ADR-139 (refusal-pattern sibling), ADR-140 (cheap-model-first), ADR-145/146 (auto-files — fixing the consumer side).
**Resolves global rule**: CLAUDE.md "Don't make a dormant team look like a working team" + whip §0.05 Reddit-receipts stakes. This ADR makes the rule structurally enforced.

## Context

### The 4 structural failure modes

On 2026-05-15 the operator surfaced that the team's coordination stack reports `🟢 alive` based on `pane_current_command=claude` while members are 15-30h dormant. Four distinct gaps converged into the failure:

#### Issue 1 — `atmux status` reads pane-aliveness, not commit-cadence

`src/verbs/status.ts` populates the health-column from tmux pane state (`pane_current_command`). A pane running `claude` reads as `🟢 alive` regardless of whether the agent shipped a commit in the last 30 minutes, the last 30 hours, or ever. The proxy fails open: dormant agents look healthy.

Per CLAUDE.md "Working" ≠ pane liveness — commit cadence is the truth signal. Today's stack has no surface that computes per-member `git log --since=<window>` against the member's worktree and reports it.

#### Issue 2 — Lead over-trusts auto-claim; no fallback when lane stalls

ADR-146 auto-emit correctly filed `t-b6f9b1fd` (gitter trunk-merge for geoyws-docs). The Task sat at `status=todo`, `lane=gitter`, `owner=gitter` for 4h while gitter pane displayed `claude` (idle, but pane-alive). Lead read the surface as healthy. The claim itself never fired — no `atmux claim --next` or pane Enter-push happened.

Today's lane-claim auto-pickup (ADR-127) fires on member-idle event but not on lane-stall event. When `lane=X todo age>30min member=idle`, nothing escalates.

#### Issue 3 — "Thin relay" frame over-corrected to "passive"

`feedback_lead_thin_relay` memory correctly says lead never claims / audits / codes. CLAUDE.md also defines lead's cognitive budget = dispatch + **status tracking + rotation + Discord**. The over-correction in practice: lead reads "thin" as "wait for driver-inbox" rather than "actively monitor + proactively escalate." Evidence: 15-30h dormancy with zero `atmux send <member>` wake-attempts from lead before driver intervention.

Brief language needs to clarify the distinction: thin-relay means **non-coding**, not **passive**. Status-tracking + nudging dormant lanes remains lead's job.

#### Issue 4 — Ship-zero-window classifier doesn't exist

ADR-132 §Escalation contract specifies `ship-zero-window` (0 commits across root+submodules >2hr) as **MANDATORY regardless of Martinet impl** (per the EPIC body t-b9529ea9). But `src/core/martinet-escalation.ts` doesn't fire `ship-zero-window` — it's a contract bullet without an implementation. The Reddit-receipts stake floor has no structural enforcement.

### Why one ADR, not three annotations

Lead's brief offered the choice: single ADR-148 OR extension annotations on ADR-127 + ADR-063 + ADR-132. **Picking single ADR-148** because:

1. **All 4 issues share one root cause** — commit-cadence is treated as a side-channel observable, not the canonical truth signal. Splitting across 3 ADRs hides the unification.
2. **Decision-anchor coherence** — the "cadence-is-truth" decision lives in one place; ADR-127/063/132 retain their scopes (lane-claim mechanism, lead role, martinet contract) and simply gain a §Cross-ref pointer to ADR-148.
3. **Reviewer surface** — one ADR review pass vs three coordinated review passes across overlapping concerns.
4. **Implementation alignment** — sub-tasks T2-T6 ship code/brief changes touching the same surface (cadence query, classifier output, brief language); having one anchor ADR for those impl Tasks to cite is cleaner.

ADR-127, ADR-063, ADR-132 receive **cross-ref-only** updates in their respective doc files via future maintenance Tasks (out of this EPIC's scope; can fold into normal ADR cross-ref hygiene passes).

## Decision

### (D1) Commit-cadence is THE canonical truth signal for "is this member shipping?"

A member is `working` if-and-only-if its worktree's git log shows ≥1 commit since some window-back threshold. Pane-aliveness is downgraded from primary signal to **secondary** — useful for "is the process running?" diagnostics, NOT for "is work happening?" verdicts.

Specifically, every surface that historically reported `🟢 alive` / `Working` / equivalent based on pane-state must EITHER:

- (a) Switch to cadence-based verdict (preferred for member-shipping questions), OR
- (b) Be re-labeled to make the proxy explicit (e.g. `🟢 pane-alive` instead of `🟢 alive`) so consumers don't conflate.

Operator-side rule preserved: "Working" ≠ pane liveness. ADR-148 makes the rule structural.

### (D2) Cadence computation primitive

New module at `src/core/cadence-classifier.ts` (lands in sub-task T5). Exports:

```ts
export interface CadenceObservation {
  member: string;
  worktreePath: string;
  windowSec: number;                    // configurable, default 1800s = 30min
  commitsInWindow: number;
  lastCommitAt: number | null;          // epoch seconds; null if no commits ever
  lastCommitSha: string | null;         // 7-char short SHA
  ageOfLastCommitSec: number | null;    // null if no commits ever
  verdict: "shipping" | "idle" | "dormant" | "ship-zero-window";
}

export async function classifyMemberCadence(
  member: string,
  worktreePath: string,
  config: { windowSec?: number; shipZeroWindowSec?: number },
  deps?: { gitLog?: (path: string, since: number) => Promise<string[]> },
): Promise<CadenceObservation>;

export interface CadenceVerdictThresholds {
  shippingMaxAgeSec: number;            // default 1800 = 30min
  idleMaxAgeSec: number;                // default 7200 = 2hr
  dormantMaxAgeSec: number;             // default 21600 = 6hr
  shipZeroWindowSec: number;            // default 7200 = 2hr (matches ADR-132 contract)
}
```

Verdict classification:

| Verdict | Trigger condition |
|---|---|
| `shipping` | `commitsInWindow >= 1` AND `ageOfLastCommitSec < shippingMaxAgeSec` |
| `idle` | `commitsInWindow == 0` AND `ageOfLastCommitSec < idleMaxAgeSec` (could resume soon) |
| `dormant` | `commitsInWindow == 0` AND `ageOfLastCommitSec >= dormantMaxAgeSec` |
| `ship-zero-window` | `commitsInWindow == 0` AND `ageOfLastCommitSec >= shipZeroWindowSec` (≥2hr default — escalation class per ADR-132 contract) |

`ship-zero-window` is a subset of `dormant` (or `idle` if the 2hr threshold is lower than dormantMaxAge): the **escalation flag**. It MUST fire regardless of Martinet impl (per ADR-132 §Escalation E6 contract bullet — this ADR implements that bullet).

Pure function: no I/O in the classifier itself; the `gitLog` dep is injectable for unit tests. Caller (T5 wiring) shells `git -C <worktreePath> log --since=<windowSec>s --format='%H %ct'` and passes parsed output.

### (D3) `atmux status` extension — last-commit column / cadence integration

`src/verbs/status.ts` (lands in T2). Today's columns roughly: emoji / member / role / tui / model / active-tasks / todo-count. New column for cadence:

| Column | Source | Example |
|---|---|---|
| Cadence | `classifyMemberCadence(...).verdict` + `ageOfLastCommitSec` formatted via CLAUDE.md duration convention | `🟢 shipping (5min)` / `🟡 idle (1h2m)` / `🔴 dormant (15h)` / `🚨 ship-zero (3h)` |

The existing "alive" column either renames to `pane-state` (proxy explicit) OR is dropped if the cadence column subsumes its operational value. Recommendation: **rename to `pane-state` + keep both** for one release cycle — operators with muscle memory still see pane info; new cadence column is the primary verdict. Drop `pane-state` in a future release after operators internalize the cadence-truth-signal shift.

Output respects per-team `team.json::cadence` config (§D7 below) for thresholds; defaults applied when block absent.

### (D4) Lane-stall fallback — extends ADR-127

ADR-127 covers lane-claim auto-pickup on `member-idle` event (cadence drives auto-claim when a member is idle). ADR-148 adds the sibling: **`lane-stall`** event firing when:

- `Task.status === "todo"` AND
- `Task.lane === X` (concrete lane, not null) AND
- `now - Task.createdAt > 30min` AND
- Members with lane-affinity `X` are all `cadence.verdict ∈ {idle, dormant, ship-zero-window}` (NOT `shipping`)

Trigger fires either via:

1. **Cron rule** (lands in T3 — `src/core/cron.ts` extension OR new cron-template `lane-stall-watch`). Cadence runs every 5min; on lane-stall hit, fires `atmux send <member> "claim t-xxx"` Enter-push to the most-recently-active member of the lane.
2. **Martinet observe() output** (lands in T5 — once T2/T5 land together, martinet's per-tick observe() includes the cadence verdict; martinet's decide() emits `claim-next` NudgeAction on lane-stall just like it does on member-idle).

Both paths are additive — cron is the fleet-wide safety net; martinet is the per-tick fast path. ADR-127's existing member-idle path stays unchanged.

### (D5) Lead brief clarification — thin-relay = non-coding, NOT passive

Lands in T4 — `templates/briefs/team-lead.md` (if exists; otherwise create per current brief layout) gains an explicit clarification section:

```
## What "thin relay" means and DOESN'T mean

Per CLAUDE.md Driver Mode and feedback_lead_thin_relay memory: lead never
codes, never claims tasks, never audits diffs. That's the THIN part.

The thin-relay frame does NOT mean PASSIVE. Lead's cognitive budget per
CLAUDE.md is: dispatch + STATUS TRACKING + rotation + Discord. Status
tracking requires ACTIVE monitoring of commit-cadence (per ADR-148), not
waiting for driver-inbox messages.

Concretely, every whip turn the lead MUST:

1. Read commit-cadence per member (atmux status post-ADR-148 surfaces this).
2. For each member with cadence verdict in {idle, dormant, ship-zero-window}:
   - First wake attempt: `atmux send <member> "[lead] cadence verdict <X>;
     last commit <age>. What's the blocker?"`
   - Second wake (15min later, no commit): escalate to medic event-driven
     dispatch (ADR-140) OR rotate (ADR-009).
3. Surface ship-zero-window dormancy in Discord within 30min of detection
   (per CLAUDE.md whip §0.05 / Reddit-receipts stakes).

Waiting for driver-inbox to surface dormancy is NOT thin-relay; it's
DERELICTION. Driver intervenes when lead+martinet+medic have all failed;
that's the escalation top of the chain, not the FIRST signal lead should
receive about a 15h-dormant member.
```

This brief edit composes with CLAUDE.md global rules; no global CLAUDE.md edit needed (per Docs Discipline single-source rule — brief is the per-team distillation, CLAUDE.md is the principle).

### (D6) `ship-zero-window` classifier wiring — fulfills ADR-132 contract

> **§Amendment 2026-05-23 (sentinel deleted per e-be01fc89)**: §D2 cadence-classifier SURVIVES — it remains the canonical ship-zero-window verdict source. The §D6 sentinel-escalate entrypoint (subitems 1+2 below describing Martinet/Sentinel observe() + medic event-driven pickup) is RETIRED — sentinel/martinet role deleted entirely 2026-05-23; orchd substrate (EPIC e-a946af69) absorbs the escalate-to-claude-lead path event-driven. Subitem 3 (Discord template) persists, fired by orchd consumers on cadence-classifier events. Lines below describe historical wiring for audit.

ADR-132 §Escalation E6 specifies `ship-zero-window` as MANDATORY regardless of impl. ADR-148 §D2 ships the classifier; T5 wires the classifier's `verdict === "ship-zero-window"` output into:

1. **Martinet observe() output** — `Observation.members[].cadence: CadenceObservation` is a new field. Martinet's `decide()` checks `cadence.verdict === "ship-zero-window"` and emits `{ kind: "escalate-to-claude-lead", reason: "ship-zero-window detected on <member> (<age> since last commit)", ... }` per the existing escalation contract. *(Retired 2026-05-23 per e-be01fc89; orchd consumes the cadence-classifier verdict directly.)*
2. **Medic event-driven pickup** — per ADR-140 cheap-model-first chain, medic subscribes to martinet events; medic fires its hourly diagnosis + complaint-file path when ship-zero-window fires. *(Sentinel/martinet event bus retired; per ADR-212 cockpit medic also retired — orchd absorbs both event sources.)*
3. **Discord [ship-zero-window] template** — new named template in `src/abstractions/discord.ts` typed renderers. Verdict-line: `🚨 Need you — <member> ship-zero-window <age> (no commits since <SHA>)`. 🚨 is justified here per CLAUDE.md (genuinely-irreversible bar: operator-attention-required on dormancy >2hr). *(Template persists; now fired by orchd consumers on cadence-classifier events.)*

### (D7) Config — `team.json::cadence`

```json
{
  "cadence": {
    "enabled": true,
    "windowSec": 1800,
    "thresholds": {
      "shippingMaxAgeSec": 1800,
      "idleMaxAgeSec": 7200,
      "dormantMaxAgeSec": 21600,
      "shipZeroWindowSec": 7200
    },
    "laneStallEnabled": true,
    "laneStallMinAgeSec": 1800,
    "exemptMembers": []
  }
}
```

Defaults applied when block absent. Defaults match CLAUDE.md whip §0.05 thresholds (2hr ship-zero-window) and reasonable per-team operational rhythm.

Per-member opt-out via `exemptMembers` for designated roles that legitimately have low commit cadence (planner during long decomp passes, reviewer during multi-commit audit reviews). Exempt members still appear in `atmux status` cadence column but with verdict suppressed to `(exempt)`.

## Tradeoffs

### Bounded vs unbounded — same philosophy as ADR-131 + ADR-132 + ADR-139

| Choice | Risk shape | Pick? |
|---|---|---|
| Cadence-driven verdict + auto-escalate via existing chain | **Bounded**: false-positive wake-nudge costs one tmux send; member can ignore. Self-corrects on next tick. | ✅ |
| Continue pane-aliveness-only verdict | **Unbounded**: 30h dormancy reads as 🟢 alive; operator's Reddit-receipts stake (per whip §0.05) compounds with each occurrence | ❌ |
| Switch to LLM-based cadence interpretation | Over-engineering for v1; deterministic threshold from git log is sufficient | ❌ defer to Phase 2 |

### Cost — N members × git log per tick

Each whip tick (per martinet at 270s, per medic at 1hr) runs `git -C <worktree> log --since=<window>` per member. For N=10 members at 270s cadence: ~133 git invocations per hour per team. Cheap (~1ms each from disk-cached git refs). At 50ms total per tick — negligible against martinet's other observation work.

Cache opportunity: martinet caches `lastCommitSha` per member across ticks; only re-runs git log when `git rev-parse HEAD` differs from cache. Defer caching to T5 impl decision; baseline impl skips cache (the cost is already negligible).

### Brief edit blast radius — D5

Lead brief is operator-facing + member-facing. Adding "DERELICTION" framing could read as accusatory to a well-functioning lead. Mitigation: section header is "What 'thin relay' means and DOESN'T mean" — definitional, not punitive. The behaviour change (active monitoring) is the operative outcome; the framing is supporting prose.

## Cross-references

- **CLAUDE.md** "Don't make a dormant team look like a working team" + whip §0.05 — operator-side principle this ADR makes structural.
- **ADR-077** ([077-superdoctor-cockpit-role.md](077-superdoctor-cockpit-role.md)) — medic. Medic's event-driven pickup consumes the ship-zero-window classifier output (D6).
- **ADR-127** — lane-claim auto-pickup. ADR-148 §D4 extends ADR-127's member-idle path to add the lane-stall sibling event.
- **ADR-132** ([132-pluggable-martinet.md](132-pluggable-martinet.md)) — martinet escalation contract. §D6 implements ADR-132 §E6 ship-zero-window contract bullet (was specified, never wired — ADR-148 closes the gap).
- **ADR-139** ([139-refusal-pattern-auto-rotate.md](139-refusal-pattern-auto-rotate.md)) — refusal-pattern sibling classifier. Same module-shape (pure function, threshold-based, per-member observation, escalation-on-trigger). ADR-148's cadence-classifier and ADR-139's refusal-classifier are siblings — both feed the medic/martinet observation pipeline.
- **ADR-140** — cheap-model-first principle. Cadence-check belongs in martinet (per-tick observation), NOT in lead (per-turn coding). This ADR's D6 wiring confirms the placement.
- **ADR-145/146** — auto-files trunk-merge. ADR-148 fixes the consumer side: auto-emit fires correctly; today the issue is that the lane=gitter Task sits while gitter is idle (the cadence-truth shift exposes this). ADR-148's lane-stall fallback (D4) is the structural fix.
- **`feedback_lead_thin_relay`** memory — D5 clarifies the over-correction. Memory body retained; brief edit makes the active-monitoring expectation explicit.
- **`feedback_overnight_reddit_stakes`** memory — D2/D6 ship-zero-window classifier is the structural enforcement.

## Open questions

**OQ-1 — Cadence threshold defaults per-fleet vs per-team?**

Defaults in §D7 are fleet-wide reasonable. Different teams have legitimately different commit cadences (e.g. docs lane ships 1 commit/day; be lane ships 5 commits/hour). Forcing one set of thresholds means tuning per team.

**Recommended default**: per-team via `team.json::cadence.thresholds` (this ADR's resolved default). Fleet-wide default applies when team's block absent. Cockpit-level default deferred — revisit if fleet-tuning emerges as a need.

Driver override via decisions log when concrete demand emerges.

**OQ-2 — Verdict on cron-stall fires the Enter-push, OR files a task?**

Two paths:

- **(A)** Cron-stall fires `tmux send-keys` Enter-push to the lane's most-recently-active member's pane (per global "always read pane state BEFORE tmux send-keys" rule)
- **(B)** Cron-stall files a NEW Task: `[lane-stall] claim <stalled-task-id>` with assignee=most-recently-active-member, deps=[]

**Recommended default**: **(A) Enter-push**, matching the existing martinet `enter-push` NudgeAction shape. Files-a-Task pattern adds kanban noise + delays the actual claim by one cron cycle. Enter-push is sub-second.

Pane-state read MANDATORY before send-keys (per CLAUDE.md "always read pane state BEFORE tmux send-keys"). If pane is in a non-receptive state (Compacting / modal / queued input), cron-stall skips the send AND files a flag for operator review.

Driver override via decisions log when Task-files pattern is desired (e.g. teams that audit-trail every claim).

## Implementation plan

This ADR commits the **specification only**. Implementation lands across 6 sub-tasks (per EPIC body's expected shape; all filed same-session per [[feedback_decomp_same_session_with_deps]]):

| T | Sub-task | Deps | Lane |
|---|---|---|---|
| T1 | Draft ADR-148 (this ADR) | — | docs / planner |
| T2 | `atmux status` extension — cadence column + duration formatting + same-commit docs | T1 | be |
| T3 | Lane-stall cron rule (extends ADR-127) — new cron template + threshold config | T1 | be |
| T4 | `templates/briefs/team-lead.md` thin-relay clarification per §D5 | T1 | docs |
| T5 | `src/core/cadence-classifier.ts` + martinet observe() wiring per §D2+D6 + Discord [ship-zero-window] template | T1, T2 | be |
| T6 | e2e — synthetic 30min idle team → cadence verdict → wake-nudge + ship-zero-window escalation + lane-stall fallback fire | T5 | test |

Sub-task IDs filed alongside this commit. Reviewer flips this ADR Proposed → Accepted in follow-up after T2-T6 land green.

## Acceptance gates (per EPIC §Acceptance)

For T1 specifically:

- [x] `docs/adr/148-commit-cadence-truth-signal.md` exists with `Status: Proposed`.
- [x] All 4 issues (cadence-truth, lane-stall, thin-relay-clarify, ship-zero-window-impl) mapped to decision pieces D1-D6.
- [x] Cadence-classifier primitive shape documented (§D2).
- [x] team.json::cadence config block documented with defaults (§D7).
- [x] Cross-refs to ADR-077/127/132/139/140/145/146 + CLAUDE.md + memories.
- [x] 2 OQs with recommended defaults (per-team thresholds; Enter-push over Task-file).
- [ ] Single commit; reviewer-gated.

Wider EPIC acceptance gates T2-T6 — those are out of T1's scope.

## Out of scope

- **Fixing dormancy of the 3 current dormant members** (parity-read-impl, planner, docs) — already routed via 4-ask wave to lead at 13:48 MYT per EPIC body. This ADR is the PREVENTION, not the cure for the current incident.
- **ML-based cadence-prediction** — deterministic git-log thresholds are sufficient for v1.
- **Cross-team cadence aggregation** (super-driver level) — defer to ADR-274 super-* hierarchy EPIC per EPIC body.
- **Pane-state diagnostics** beyond `pane-state` column rename — the proxy-explicit relabel is the v1 fix; richer pane-state observability stays in martinet/medic surfaces.
- **CLAUDE.md global edit** — D5 brief edit is the v1 carrier; CLAUDE.md global Driver Mode section composes with the brief without needing direct edit.
- **Cross-account cadence checks** (e.g. counting gitter's commits attributed to authoring member) — defer; gitter's commits today carry Co-Authored-By trailers per gitter.md brief; cadence-classifier reads `git log --author <member>` to filter correctly.

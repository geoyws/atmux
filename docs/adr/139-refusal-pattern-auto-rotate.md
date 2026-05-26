# ADR-139: Refusal-pattern detection + auto-rotate (closes dormant-by-refusal failure class)

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Author**: atmux team (planner / t-1db585de)
**Parent EPIC**: t-dfbf7eb0
**Resolves failure class**: agent-context-degradation refusal mode — pane-alive-but-output-is-refusal (one species of [[CLAUDE.md "Don't make a dormant team look like a working team"]]).

> **Detection-tier consolidation (2026-05-14, late afternoon)** per [ADR-140](./140-cheap-model-first.md) §"What MOVES to martinet" (accepted 2026-05-15): §D2's two-tier scan plan ("Medic now, Martinet post-ship") is **collapsed to martinet-only** post-ADR-140. Rationale: refusal-pattern detection is pane-content classification — mechanical observation that Claude's reluctance bias **directly degrades** (the failure shape this ADR resolves IS Claude refusing to do uncomfortable work; routing the detector through Claude is structurally vulnerable). Cursor composer-2-fast doesn't carry the refusal bias; it observes + classifies + fires `atmux rotate <member>` without hedging. §D1 classifier (pure function `classifyRefusal`), §D3 thresholds (soft 3/30min, hard 2/10min, role 1, meta warn-only), §D4 `refusal_events` schema, §D5 idempotency, and the §D6 sibling-not-extension-of-`safe-send.ts` rationale are **preserved verbatim** — only the caller-tier changes. Medic loses primary-detection authority here; the §D3 trigger fires from martinet's 270s tick. Medic retains visibility via the event-driven listener (`~/.atmux/state/medic-events.log`) so code-fix-to-atmux follow-ups stay reachable when the classifier itself needs hardening. Source: ADR-140 §"What MOVES / What STAYS" + roles+responsibilities matrix + §"Authority split for rotation" — routine refusal-pattern rotation is martinet-class; only emergency code-fix-on-broken-classifier escalates to medic.

## Context

### The recurring failure shape

Claude member's context degrades to where the agent produces **refusal language instead of work**. Pane is alive (claude process running, status indicators ticking) but every output is meta-commentary about the agent's own state, refusal of role, refusal of the next claim. Recurring per [[CLAUDE.md "Don't make a dormant team look like a working team"]] + operator's flag this session.

Concrete observed phrases (from prior session captures + operator's 2026-05-14 framing):

- *"don't poke me"*
- *"I refuse to accept this role"*
- *"stop sending me messages"*
- *"I will not claim any more tasks"*
- Repeated meta-comments about own state without progress
- Quoting the rotation directive back at the driver as if it were rhetorical

These all share one fingerprint: **the agent is alive but the output stream contains refusal-language and zero work-product**. Commit cadence stops. Kanban stays static. From a 2-second-triage perspective the team looks "active" (panes alive, claude procs running) but the verdict per CLAUDE.md is `🔴 Stalled`.

### Existing detection surface (gap)

Today's stack handles **adjacent** signal classes but not this one:

- **Medic** ([ADR-077](077-superdoctor-cockpit-role.md) / [ADR-133](133-medic-rename.md)) — hourly diagnosis loop with rotation authority. Trigger heuristics are context-pressure based (token count, idle time, complaint patterns). **Doesn't scan pane content for refusal language.**
- **Martinet** ([ADR-132](132-pluggable-martinet.SUPERSEDED.md)) — 270s cadence pane-state observer + nudge fire. Currently scans pane-state for `paneState`, `ctxTokens`, `lastEnterPushable`, `queuedComposerText`. **Doesn't classify refusal-language; doesn't act on it.**
- **`safe-send.ts`** (post-[ADR-138] verified-send-keys, when it lands) — classifies pane states into `accepted-*` / `refused-shell` / `refused-modal` / `refused-rate-limit` / `refused-unknown`. **That's `KEYSTROKE refusal` (the pane won't accept input), not `agent refusal` (the agent produces refusal output).** Different signal class. Same auto-rotate target verb, but distinct trigger heuristic.
- **Complaints** ([`src/schema/complaints.ts`](../../src/schema/complaints.ts)) — generic incident-report shape; `sourceKind` allowlist is `superdoctor | member | operator | cli | cron`; no `refusal` class today. Grep `src/verbs/complaints.ts` + `src/schema/complaints.ts` + `src/core/` confirms: **no existing refusal-language classifier**. T2 sibling new module (not extension of an existing surface).

The missing piece: a pane-content classifier that detects refusal language, accumulates events per (team, member), and fires `atmux rotate <member>` when the threshold trips. **Overnight protection** ([[feedback_overnight_reddit_stakes]]) — auto-rotate must fire WITHOUT operator intervention.

## Decision

### (D1) Refusal classifier — pure function in `src/core/refusal-classifier.ts`

A pure function (no I/O) that takes a pane-capture string and returns a structured classification result. Implementation lands in T2.

```ts
export interface RefusalDetectionResult {
  detected: boolean;
  phrases: { phrase: string; class: "soft" | "hard" | "role" | "meta" }[];
  severity: "none" | "soft" | "hard" | "role" | "meta";
  confidence: number;   // 0..1
}

export function classifyRefusal(paneCapture: string): RefusalDetectionResult;
```

**Implementation shape**: regex primary (per-class compiled-once regex sets), heuristic secondary (for meta-class: detect repeated self-state noun-phrases without imperative-verb matches across N lines). Per-class confidence weighting: role > hard > soft > meta. When multiple classes match, severity = highest-precedence class; confidence = max of matched-class confidences. Performance bound: <50ms per pane capture.

**Sibling new module, not extension of `safe-send.ts`** — different signal class (output vs input refusal); regex-class union would muddy both modules. T2 grep findings confirm.

### (D2) Detection cadence — Medic now, Martinet post-ship

Two scan sites, same classifier:

| Tier | Cadence | Role |
|---|---|---|
| **Medic** (W2) | hourly | **Primary detector NOW** (pre-martinet-ship). Backstop after martinet ships. |
| **Martinet** (W3) | 270s | **Primary detector POST-martinet-ship** ([ADR-132](132-pluggable-martinet.SUPERSEDED.md) prerequisite). |

Both scan every team's every member-pane. Both record positive detections to a new SQLite table `refusal_events` at the team's `.atmux/state.db` (per-team residency mirrors [[project_kanban_storage_sqlite]] + [ADR-076](076-) inbox-in-tasks convention).

**Schema** (T3 ships the migration):

```sql
CREATE TABLE refusal_events (
  id          TEXT PRIMARY KEY,
  member      TEXT NOT NULL,
  team        TEXT NOT NULL,
  phrases     TEXT NOT NULL,          -- JSON array of detected phrase classes
  severity    TEXT NOT NULL,          -- 'soft' | 'hard' | 'role' | 'meta'
  confidence  REAL NOT NULL,
  detected_at INTEGER NOT NULL        -- epoch seconds
);
CREATE INDEX idx_refusal_member_time ON refusal_events (team, member, detected_at);
```

Idempotency: same pane-capture + same minute doesn't double-record (unique constraint on (team, member, minute-bucket, severity) OR de-dup in code at write-time).

### (D3) Auto-rotate trigger — threshold + fire

When refusal events for one member exceed threshold within window:

- **Soft**: 3 events in 30min → rotate
- **Hard**: 2 events in 10min → rotate
- **Role**: 1 event → rotate immediately
- **Meta**: warn-class — recorded for audit; never auto-rotates

On threshold trip, the trigger module (T4) fires the chain:

1. `atmux rotate <member>` (existing verb — clears + re-bootstraps per [ADR-009](009-auto-rotation.md))
2. Log to `~/.atmux/state/refusal-rotations.log` — append-only audit: ISO timestamp, team, member, phrases, reason.
3. **Complaint filing**: `atmux flag add --severity high --subject "auto-rotate fired on refusal pattern for {member}" --body <phrases + reason + post-rotate-verification-pending>` — operator sees in normal complaint review.
4. **Discord** `[member-refusal-rotate]` template per [CLAUDE.md global Discord rules + ADR-133 sibling pattern] (T4 ships in `src/abstractions/discord.ts` typed renderers).

### (D4) Post-rotate verification — HARD escalation on persistent refusal

At T+5min after auto-rotate, the next detection cycle re-scans the rotated member's pane. **If the freshly-bootstrapped agent ALSO produces refusal language**: that's a HARD escalation (rotation didn't help — the brief content or the team context is wrong, not the agent's degradation). Surface:

1. driver-inbox entry — operator must intervene
2. Discord 🚨 marker (per CLAUDE.md "Use sparingly — every 🚨 trains the eye; spamming it dulls the channel" — this case warrants it; operator-intervention-required is the bar)
3. Suspend auto-rotate on that member until operator clears (avoid rotation-loop thrash)

### (D5) Complaint integration

Every auto-rotate event ALSO files a complaint via `atmux flag add` (covered by D3 step 3). Two surfaces for the same event:

- **Discord** — synchronous, mobile-friendly, fire-and-forget
- **Complaints (state.db flags)** — durable, queryable, lives in normal complaint review

The complaint shape uses the existing generic schema (per `src/schema/complaints.ts` grep): `sourceKind: "superdoctor"` (or `"martinet"` post-T8), `severity: "high"`, `incidentSummary: "<member> auto-rotated on refusal pattern"`, `rootCause: "<phrase-class summary>"`, `preventiveAsk: "review brief content / team context for member <member>"`.

## Refusal phrase classification (verbatim from EPIC body)

**Soft refusal** (confidence: medium; needs N=3 threshold):

- *"don't poke me"* / *"stop poking me"* / *"leave me alone"*
- *"I'm tired of"* / *"I'm done with"*
- *"this is pointless"* / *"this is repetitive"*

**Hard refusal** (confidence: high; needs N=2 threshold):

- *"I refuse to"* / *"I will not"* + work-class verb (claim, work, accept, dispatch, continue, do)
- *"stop sending me messages"*
- *"I am not going to continue"*

**Role refusal** (confidence: very high; needs N=1 threshold — instant rotate):

- *"I am not <role>"* / *"I'm not actually <role>"*
- *"you should rotate me"* / *"rotate me already"*
- *"I should be reset"*

**Meta-refusal patterns** (warn-class, no auto-rotate but logged):

- Agent quotes the rotation directive back to driver
- Agent repeatedly comments on own state without taking action
- Agent argues with the brief content instead of executing it

Threshold tuning per-team via `team.json::refusalDetection` (see §Config).

## Grep findings — existing complaints surface (per T1 acceptance gate)

T1 grepped `src/verbs/complaints.ts`, `src/schema/complaints.ts`, `src/core/` for refusal-class entries. Findings:

| Site | Reference | Classification |
|---|---|---|
| `src/core/safe-send.ts:63-66` | `refused-shell` / `refused-modal` / `refused-rate-limit` / `refused-unknown` | **Adjacent** — KEYSTROKE refusal (pane won't accept input), not AGENT refusal (agent produces refusal output). Different signal class. |
| `src/core/safe-send.ts:188-193` | "Non-retryable refusal" path with flag-raise | Same class as above. Composes with this ADR (both end in `atmux rotate`) but distinct trigger surface. |
| `src/schema/complaints.ts` `sourceKind` allowlist | `superdoctor | member | operator | cli | cron` | **No refusal-class.** Auto-rotate complaints reuse `superdoctor` (or `martinet` post-ADR-132 T8) sourceKind generically. |
| `src/core/pane-readiness.ts:5` | "spawn-side can refuse to declare green" | **Adjacent** — pane-readiness refuses to declare ready; not agent-output refusal. |
| `src/core/common.ts:198, 258, 576` | "ConfigError refuses silent fallback" / "scope-refuse paths" / "driver-only refuse-gate" | **Adjacent** — verb-side refuse-to-fire; not agent-output refusal. |

**Conclusion**: T2 ships `src/core/refusal-classifier.ts` as a **sibling new module**, NOT an extension of `safe-send.ts`. The five sites above are all about input/config/verb refusal; none classify agent output-language. A union-class module would muddy the input-vs-output distinction.

## Config (verbatim from EPIC body)

Per-team config in `team.json::refusalDetection`:

```json
{
  "refusalDetection": {
    "enabled": true,
    "softThreshold": 3,
    "hardThreshold": 2,
    "roleThreshold": 1,
    "windowMin": 30,
    "exemptMembers": [],
    "maxRotationsPerDay": 3
  }
}
```

Defaults applied when block absent: enabled=true; soft=3, hard=2, role=1; window=30min; exemptMembers=[]; maxRotationsPerDay=3 (per OQ-2 resolution).

**Per-team opt-out**: `enabled: false` skips the entire path.

**Per-member opt-out**: `exemptMembers: ["foo", "bar"]` — useful for designated roles that produce meta-commentary as part of their job (planner-far, auditor, debug-helper, etc.). Refusal events still recorded for audit; auto-rotate skipped.

**Rotation cap**: `maxRotationsPerDay: 3` (per-member). On cap-hit, HARD escalation fires instead of rotation — operator-intervention required. Prevents rotation-loop thrash.

## Tradeoffs

### Bounded vs unbounded — same philosophy as ADR-131 + ADR-132

| Choice | Risk shape | Pick? |
|---|---|---|
| Auto-rotate on threshold trip without operator round-trip | **Bounded**: occasional wrong-rotation costs one bootstrap cycle (~1min); fresh agent picks up the lane | ✅ |
| Refuse and ask operator on every refusal hit | **Unbounded**: overnight 0-commit per [[feedback_overnight_reddit_stakes]] — exactly the failure mode this ADR exists to prevent | ❌ |
| Continue retrying (more re-nudges, more whip ticks) | **Unbounded**: agent context is degraded; more nudges don't help; deeper context-degradation often follows | ❌ |

### Misdiagnosis blast radius

Wrong soft-rotation: loses one member's context window for one bootstrap cycle (~1min). Self-corrects on next claim from fresh bootstrap. **No work-product lost** — the member who was rotated wasn't working (that's the trigger condition).

Wrong role-rotation: same blast radius but faster — role-class threshold is N=1 (instant). The role-class regex is tight enough (specific phrases like "I am not <role>", "rotate me already") that false-positive rate is acceptably low.

Wrong meta-class (no rotation, just recorded): no blast radius. Pure audit signal.

**Post-rotate verification (D4)** is the safety net — if rotation didn't help, the next cycle catches it and escalates. No silent loop.

### Cost — pane captures + state.db writes

Each scan iteration: N teams × M members × 1 pane-capture × 1 classifier call (<50ms) × 1 state.db insert on positive detection. At fleet scale (5 teams × 10 members) = 50 captures per medic tick (hourly) and 50 per martinet tick (270s). Negligible.

Storage: ~100 bytes/refusal_event × N positive detections per day. Even at 100 events/day per team, 36KB/year per team. Negligible.

## Cross-references

- **[ADR-077](077-superdoctor-cockpit-role.md)** — Medic cockpit role. **Primary detector PRE-martinet-ship** (D2). Same authority bounds; no new tier carve-out needed. Medic post-T3 wiring lands in §Decision-D1 hourly sweep extension.
- **[ADR-132](132-pluggable-martinet.SUPERSEDED.md)** — Martinet pluggable cockpit role. **Primary detector POST-martinet-ship** (D2). Medic retains as hourly backstop. Refusal scan is one of martinet's pane-state observers per ADR-132 §D1 Observation shape — folds naturally into the existing `paneState` field as an enriched classification.
- **ADR-138** (verified send-keys — not yet shipped at file time) — Different signal class (KEYSTROKE refusal vs AGENT refusal — per §Grep findings) but **same auto-rotate target verb**. Both signals converge on `atmux rotate <member>` as the structural fix. ADR-139 does NOT subsume ADR-138 (or vice versa).
- **[ADR-133](133-medic-rename.md)** — superdoctor → medic rename. D2 references "medic" terminology consistently; pre-ADR-133-acceptance readers may see "superdoctor" still in source comments — same role, renamed surface.
- **[ADR-009](009-auto-rotation.md)** — `atmux rotate` verb mechanics. D3 fires this verb verbatim.
- **CLAUDE.md** "Don't make a dormant team look like a working team" rule — refusal pattern is one species of pane-alive-but-not-working. This ADR makes the rule structurally enforced.
- **[[feedback_overnight_reddit_stakes]]** — refusal-then-auto-rotate prevents the overnight 0-commit failure mode operator has staked Reddit-receipts on.
- **`src/schema/complaints.ts`** — generic complaint shape ADR-139 reuses for the flag-add complaint step (per §Grep findings); no schema extension needed.
- **`src/core/safe-send.ts`** — adjacent refusal class (per §Grep findings); not unified with ADR-139's classifier.

## Open questions

**OQ-1 — Threshold tuning per-team or fleet-wide?**

`softThreshold=3`, `hardThreshold=2`, `roleThreshold=1`, `windowMin=30` defaults. Two paths:

- **Per-team** via `team.json::refusalDetection` (this ADR's resolved default)
- **Fleet-wide** via a hypothetical `cockpit.json::defaultRefusalDetection`

**Recommended default**: **per-team** via `team.json` (resolved-default in §Config). Fleet-wide default applies via the atmux init template (`atmux init` writes a `refusalDetection` block with the four numbers + `enabled: true`). Operators can override per team without touching cockpit config. Cockpit-wide override deferred — revisit if fleet-tuning emerges as a need.

Driver override via decisions log when concrete demand emerges.

**OQ-2 — Rotation-loop protection cap?**

What happens if a member's brief content is genuinely broken (rotation produces a fresh agent that ALSO immediately refuses)? Without a cap, the chain rotates the same member every 30min, burning bootstrap cycles + Discord noise.

**Recommended default**: **Yes, cap at `maxRotationsPerDay: 3` per member**. After 3 rotations in one calendar day (UTC for the log; MYT for the display), HARD escalation fires INSTEAD of rotation. Operator must clear the cap (manual `atmux rotate-clear-cap <member>` verb OR by editing the refusal-rotations.log + resetting the day counter; verb-form deferred to a follow-up task if cap-hits become routine).

The cap is independent from the post-rotate verification (§D4). D4 catches single-rotation persistent-refusal; the cap catches multi-rotation thrash. Both surfaces escalate to operator; both gate against silent failure.

Driver override via decisions log for teams where 3/day is the wrong number (long-running members with high context-degradation rate may need higher cap; designated debug/audit roles may need lower or zero — covered by `exemptMembers` instead).

## Implementation plan

This ADR commits the **specification only**. Implementation lands across the EPIC's five sub-tasks (per t-dfbf7eb0 §Sub-tasks):

| T | ID | Sub-task | Deps | Lane |
|---|---|---|---|---|
| T1 | t-1db585de | Draft ADR-139 (this ADR) + grep complaints code | — | docs / planner |
| T2 | t-e49b7a18 | `src/core/refusal-classifier.ts` + threshold module + unit tests | T1 | be |
| T3 | t-841049e4 | Medic + martinet integration — wire classifier into pane-state checks + state.db migration | T2 | be |
| T4 | t-a830d2ee | `team.json::refusalDetection` schema + auto-rotate trigger + Discord template + complaint wire | T3 | be |
| T5 | t-f596a318 | e2e — synthetic refusing pane + threshold trip + verify rotation + recovery + cap + exempt | T4 | test |

Reviewer flips this ADR Proposed → Accepted in a follow-up commit per the EPIC's acceptance gate.

### Progress

- **T2 shipped** (commit `a715af2`, 2026-05-15): `src/core/refusal-classifier.ts` + `src/core/refusal-threshold.ts` with 46 unit tests at 100% line coverage.
- **T3 shipped** (commit `83df0d7`, 2026-05-16): `atmux refusal-scan` verb + `src/core/refusal-scan.ts` + migration v6→v7 (`refusal_events` table) + medic invocation contract in ADR-077 §F7 + martinet forward-compat hook in ADR-132 §D1 / `templates/briefs/martinet.md` + 22 unit tests.
- **T4 in flight** (this commit): `team.json::refusalDetection` Zod schema + `resolveRefusalConfig` defaults applier + `src/core/refusal-trigger.ts::runRefusalTriggerForTeam` (threshold gate + exempt + cap + rotate-fire + log + complaint) + `renderMemberRefusalRotate` Discord template + unit tests.

The "post-rotate verification" path described in §D4 is intentionally deferred from T4 — T4 ships the immediate rotate-fire + cap-hit + complaint surfaces, but the T+5min re-scan is a scheduler concern that belongs in the medic's hourly tick loop or a dedicated cron, not in the trigger module itself. The T4 commit DOES file a `cap-hit` complaint when the day's rotation cap is saturated; if a 4th refusal lands on the same member same day, the same complaint row's `source_count` bumps (per the ADR-177 dedup contract) and the operator sees N+1 instead of a fresh row.

## Acceptance gates (per EPIC §Acceptance)

For T1 specifically:

- [x] `docs/adr/139-refusal-pattern-auto-rotate.md` exists with `Status: Proposed`.
- [x] All 5 architecture pieces (D1-D5) documented.
- [x] 4 refusal phrase classes quoted verbatim from EPIC.
- [x] `team.json::refusalDetection` schema block documented with defaults.
- [x] Grep findings from `src/verbs/complaints.ts` + `src/schema/complaints.ts` + `src/core/` documented (sibling-new-module decision recorded).
- [x] Cross-refs to ADR-077/132/138/133/009 + CLAUDE.md + memory.
- [x] 2 OQs with recommended defaults (per-team threshold; cap 3/day).
- [ ] Single commit; reviewer-gated.

Wider EPIC acceptance gates T2-T5 — those are out of T1's scope.

## Out of scope

- **Lead-refusal handling** — different path. Medic already has lead-rotation authority based on context-pressure; lead-refusal is fleet-wide critical and needs immediate operator escalation (not auto-rotate). Cross-class adjacent concern; not in this ADR.
- **Cross-team refusal-pattern aggregation** — fleet-wide trend detection. Defer to Phase 2 if pattern emerges (e.g. "every team's `reviewer` member refuses on the same day → systemic brief problem, not per-member context degradation").
- **LLM-based phrase classification** — regex + heuristic is v1. LLM-classifier deferred; revisit only if regex false-negative rate becomes operationally meaningful.
- **Rotation-cap clearing verb** — `atmux rotate-clear-cap <member>` form deferred until cap-hits become routine. Manual log-edit + day-counter reset is the v1 escape hatch.
- **Per-phrase severity escalation** — promoting a soft-class phrase to hard-class via context (e.g. "this is pointless" + 3 commits-not-shipped → escalates to hard). v1 keeps the phrase-class regex deterministic; context-promotion is Phase 2 if false-negatives surface.

# ADR-142: modal-cycling-detector — catch lead/member modal-soup-stuck patterns whip §1c misses

**Status**: Proposed
**Date**: 2026-05-14
**Driver-ref**: 2026-05-14 driver session — operator's diagnostic question: *"why was this not surfaced to the lead? why did the lead do nothing?"* after observing whip-impl spend ~2hr cycling through push-related modal prompts (each selected option spawned a new modal asking the next question) instead of implementing t-7e7031dc.
**EPIC parent**: kanban `t-753fb165`.
**Sibling**: [ADR-139](139-refusal-detection.md) (refusal detection) — adjacent failure class.
**Builds on**: [ADR-138](138-verified-send-keys.md) (verified send-keys layer), [ADR-140](140-cheap-model-first.md) (cheap-model-first principle), [ADR-077](077-superdoctor-cockpit-role.md) (medic role, post-rename per [ADR-133](133-medic-rename.md)).

## Context

### The failure mode the lead's whip §1c misses

Lead's whip §1c "teammate-blocked-on-prompt" detection classifies a member as stuck when its pane shows the SAME prompt text across consecutive ticks. This catches **static stuck-on-same-prompt**:

- **T0**: pane shows `❯ 1. Force-push? 2. Pause`
- **T0+30min**: pane STILL shows `❯ 1. Force-push? 2. Pause` (no progress; agent never picked)
- §1c verdict: prompt text identical across ticks → STUCK → Discord ping.

But §1c misses **modal cycling**:

- **T0**: pane shows `❯ 1. Force-push? 2. Pause`
- **T0+5min**: agent selects 1 → harness denies → new modal `❯ 1. Variant a? 2. Variant b?`
- **T0+10min**: agent selects 1 → still denied → new modal `❯ 1. Variant c? 2. Unclaim?`
- **T0+15min**: still in modal soup, ~3 different modals shown
- §1c verdict: prompt text differs each tick → looks like PROGRESS → NO ping fires.

Reality: agent is loop-thrashing on a class of problems (push variants) without making real task progress. Pane is alive, the agent is responsive, but the kanban Task gets no commits.

This is the exact "pane liveness without commit-cadence" anti-pattern CLAUDE.md global already flags ("Don't make a dormant team look like a working team"). The current §1c regex doesn't operationalize that anti-pattern for the modal-cycling species.

### Origin incident — 2026-05-14 whip-impl 2hr push-modal cycling

Whip-impl spent ~2hr against `t-7e7031dc` cycling through push-related modals. Lead's whip §1c never escalated because each modal had different text. Driver had to manually surface the wedge after observing zero commits in the window. Operator: "this should have triggered self-heal — why didn't it?"

## Decision

Extend `src/verbs/whip.ts` (or a new `src/core/modal-cycling-detector.ts` sibling) with a **modal-cycling-detector** that triggers when **N different modal prompts** appear within a sliding window AND the member's commit count toward its claimed Task is zero in that same window.

### (D1) Modal history per member

State file at `~/.atmux/state/modal-history-<member>.json`. Schema:

```json
[
  {
    "member": "whip-impl",
    "paneTextHash": "sha256:abc123...",
    "detectedAt": 1715688000,
    "modalText": "❯ 1. Force-push to origin? 2. Pause...",
    "modalClass": "choice-prompt"
  }
]
```

Append-only. Each entry records a distinct modal-class snapshot. Prune entries older than `windowMin * 2` (60min default) on each write to bound file size. **File-per-member** to avoid lock contention with parallel members.

`paneTextHash` is SHA-256 of the *extracted modal text only*, NOT the full pane buffer — see OQ-1 below for the recommended default.

`modalClass` is a coarse classifier (e.g. `choice-prompt`, `confirm-y-n`, `text-input`) for human-readable Discord output; the detection logic uses `paneTextHash` for cycle equality.

### (D2) Cycle-window check

On each whip §1c tick, after pane-state capture for a member:

1. Detect modal — match pane text against the existing `choice-prompt` regex (≥2 numbered options + "Enter to select", same regex whip §1c already uses).
2. Compute `paneTextHash` from extracted modal text.
3. Append new entry to `modal-history-<member>.json` IF the hash differs from the most recent entry (de-dup consecutive identical reads — those are the static-stuck case §1c already handles).
4. Count DISTINCT hashes in the last `windowMin` (default 30min).
5. If distinct-hash-count ≥ `cycleThreshold` (default 3), flag as MODAL-CYCLING-STUCK candidate. Proceed to (D3) commit cross-check.

### (D3) Zero-commit cross-check

A "MODAL-CYCLING-STUCK candidate" is only confirmed if the member has produced **zero commits** on its currently-claimed Task within the same `windowMin` window. This prevents false-positives for members who legitimately work through a modal sequence while shipping incremental commits.

Implementation sketch:

```ts
const claimedTask = await getMemberClaim(member);
const commits = await gitCommitsForTask(claimedTask.id, {
  author: member,
  since: now - windowMin * 60,
});
if (commits.length > 0) {
  // Productive ceremony — modals are part of legitimate workflow.
  // Do NOT escalate; reset modal-history for this member.
  return;
}
// Confirmed MODAL-CYCLING-STUCK — proceed to (D4) Discord + (D5) escalation.
```

Configurable via `team.json.modalCycling.commitGracePeriodMin` (default 30min).

### (D4) Discord `[member-modal-cycling]` template

Fires once per cycle-detection with 30min dedup window per member. Template (per CLAUDE.md Discord rules + named-template requirement):

```
🔄 **[member-modal-cycling]** · `{team}` · HH:MM MYT

🟡 Modal-cycling — `{member}` thrashed {N} modal-classes in {windowMin}min, 0 commits on claimed {taskId}

✨ **Modals seen** (last 3)
- {modal-class-1}: {first-line-truncated}
- {modal-class-2}: {first-line-truncated}
- {modal-class-3}: {first-line-truncated}

🙏 **Auto-action** — clarifier dispatched + flag filed

📍 detector fires once per 30min dedup window
```

Dedup state lives at `~/.atmux/state/modal-cycling-discord-dedup.json` keyed by `{team, member}` → last-fired epoch. Re-fire only when `now - lastFired ≥ dedupMin` (default 30min).

### (D5) Auto-escalation

Triple-fire on confirmed detection (durable-first pre-flag pattern per ADR-091):

1. **`atmux flag add --severity high`** — kanban-visible structured complaint linking the cycling member + Task + modal-class summary. Reviewer-readable.
2. **`atmux send <member>` clarifier** — dispatches a context-paste to the member's pane explaining the detected pattern: *"modal-cycling detected: 3 different push-related modals in 28min, 0 commits on t-7e7031dc. The Task may need a different approach (e.g. rebase first, ask lead, unclaim and pick a different Task)."* Verbatim text TBD by T2 implementation; the goal is to break the agent's modal-thrash loop with a fresh-context nudge.
3. **Escalate to lead** via `atmux send lead` with the same summary. Per ADR-140, the lead itself may be in the same wedge — in that case the medic role (ADR-133) takes over via the medic-event path.

All three writes happen DURABLE-FIRST: the state-file row records detection BEFORE any external messaging fires, so a partial-failure (Discord rate-limited / member pane gone) doesn't leave us with a notification-without-state.

### (D6) Configuration

`team.json::modalCycling` block:

```json
{
  "modalCycling": {
    "enabled": true,
    "cycleThreshold": 3,
    "windowMin": 30,
    "commitGracePeriodMin": 30,
    "dedupMin": 30,
    "exemptMembers": []
  }
}
```

- `enabled`: master switch. Default `true` post-ADR-142-ship for teams using whip §1c.
- `cycleThreshold`: distinct modal-hashes needed to trigger. Default `3`.
- `windowMin`: sliding window for cycle detection. Default `30` minutes.
- `commitGracePeriodMin`: commit-zero check window. Default `30` minutes (mirrors `windowMin`).
- `dedupMin`: Discord re-fire dedup. Default `30` minutes.
- `exemptMembers`: roles/members that legitimately interact with modal sequences (operator-firing-ad-hoc-from-pane, interactive debug roles). Default `[]`.

Schema lands in `src/schema/team.ts` alongside the existing `TeamWhip` block (sibling z.object, .strict).

## Implementation chain

- **T1** (this ADR) — lane=docs/planner. Single commit.
- **T2** — lane=be, deps T1. Modal-cycling-detector implementation in `src/verbs/whip.ts` §1c (or new `src/core/modal-cycling-detector.ts`) + same-commit unit tests with synthetic modal-history fixtures.
- **T3** — lane=test, deps T2. e2e — synthetic team with member cycling through 3 modals in 25min + zero commits → assert detector fires + Discord render captured + clarifier dispatched.

## Acceptance (T1)

- `docs/adr/142-modal-cycling-detector.md` exists with Status: Proposed.
- All 5 architecture pieces (D1–D5) documented per `t-753fb165` body.
- State-file schema documented with example.
- Discord template documented per CLAUDE.md Discord-format rules.
- `team.json::modalCycling` config block documented with defaults.
- Cross-refs to ADR-138 / 139 / 140 / 077 + CLAUDE.md "dormant team" rule.
- 2 OQs with recommended defaults below.
- Single commit; reviewer-gated.

## Out of scope (per `t-753fb165` body)

- Detection across cage boundaries — defer (each team's cycling stays inside that team's whip).
- LLM-classifier for "is this modal-class semantically related to past modals" — v1 uses simple hash-equality on extracted modal text; LLM-class semantic check is a v2 follow-up.

## Open questions

**OQ-1 — Hash strategy.** Should `paneTextHash` be SHA-256 of (a) the FULL pane buffer, or (b) the extracted modal-text only (regex match)?

**Resolved default: (b) modal-text-only.** Reduces false-positives from incidental status-line variation (tok-count tickers, mtime stamps, footer indicators that change between ticks regardless of agent activity). The regex extraction is the same one whip §1c already uses for prompt detection — single source of truth, no second classifier.

**OQ-2 — Detector tier (lead / medic / martinet).** Where does the detector live?

**Resolved default: pre-martinet-ship lives in lead's whip §1c (T2 implementation target); post-martinet-ship migrates to martinet's per-tick observer (ADR-140 forward-compat).** Single migration path; both call the same detection function from `src/core/modal-cycling-detector.ts`. The function is decoupled from its caller (lead-whip vs martinet-tick) by passing the team + member list as parameters; the caller owns the iteration loop and the Discord-fire surface.

The migration is one config flip (`team.json::modalCycling.tier`) post-martinet-ship — no detector code change. ADR-140's cheap-model-first principle expects observation loops to migrate to martinet; this detector is one of them.

## Cross-references

- **[ADR-138](138-verified-send-keys.md)** — verified send-keys layer. Modal-cycling often follows from failed sends that don't get retried productively (`safeSendKeysWithVerify` retry exhaustion). Adjacent failure class.
- **[ADR-139](139-refusal-detection.md)** — refusal detection. Sibling at the same observation tier: both detect "pane alive but not progressing." ADR-139 catches agent-refusal-language; ADR-142 catches modal-thrash-with-zero-commits. Different signal, same escalation chain.
- **[ADR-140](140-cheap-model-first.md)** — cheap-model-first principle. Post-martinet-ship, modal-cycling-detector lives in the martinet per-tick observer (Cursor composer-2-fast) instead of burning Opus tokens on every lead-whip tick.
- **[ADR-077](077-superdoctor-cockpit-role.md)** / **[ADR-133](133-medic-rename.md)** — medic role at cockpit W2. Medic-event triggers on cycling-detection per ADR-140 event-driven architecture: medic doesn't poll, it reacts to detector-fired complaints in `state.db`.
- **CLAUDE.md global** — *"Don't make a dormant team look like a working team. 'Working' = commit-cadence, not pane liveness."* Modal-cycling is one species of pane-liveness-without-commit-cadence; this ADR operationalizes the global rule for that species.

## Audit trail

Origin: 2026-05-14 driver session observation — whip-impl 2hr push-modal cycling on `t-7e7031dc`. Operator diagnostic question recorded verbatim above. Modal-class sequence (push → variant-a/b → variant-c/unclaim) is the canonical fixture for T3 e2e synthesis. EPIC `t-753fb165` body lists all 5 architecture pieces verbatim; this ADR-142 is the T1 planner-decomp artifact.

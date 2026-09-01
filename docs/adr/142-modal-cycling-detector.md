# ADR-142: Modal-cycling detector — catch lead/member modal-soup-stuck patterns whip §1c misses

**Status**: Accepted (2026-05-15, operator-batch-flip)
**Date**: 2026-05-14
**Author**: atmux team (planner / t-6dc9a673)
**Parent EPIC**: t-753fb165
**Driver-ref**: 2026-05-14 driver session — operator's diagnostic question: *"why was this not surfaced to the lead? why did the lead do nothing?"* after observing whip-impl spend ~2hr cycling through push-related modal prompts (each selected option spawned a new modal asking the next question) instead of implementing t-7e7031dc.
**Resolves failure class**: agent-cycling-through-modal-soup (pane-alive-with-changing-prompts-and-zero-commits) — adjacent to ADR-139 refusal class but distinct in fingerprint.

## Context

### The failure mode whip §1c didn't catch

On 2026-05-14, `whip-impl` spent **~2 hours** cycling through push-related modal prompts instead of implementing its claimed task `t-7e7031dc`. Each modal selection spawned a new modal asking the next question (force-push variant → ref-style variant → unclaim-or-retry variant), so from §1c's vantage every tick saw a *new* prompt text — looked like progress. Reality: agent was loop-thrashing across a class of related prompts (push variants) without any real task progress. Zero commits attributed to `whip-impl` during the cycling window.

Operator's diagnostic question at session close: *"why was this not surfaced to the lead? why did the lead do nothing?"*

The answer: `whip §1c teammate-blocked-on-prompt` detection only matches **STATIC stuck-on-same-prompt**. The threshold compares last-tick's prompt-hash to current-tick's prompt-hash; if they differ, the member reads as *making progress*. Modal **CYCLING** (different prompts in sequence) bypasses that threshold.

### Static stuck vs cycling — distinct signal fingerprints

| | Static stuck-on-prompt | Modal cycling |
|---|---|---|
| T+0 pane | `❯ 1. Force-push? 2. Pause` | `❯ 1. Force-push? 2. Pause` |
| T+5min pane | (same text) | `❯ 1. Variant a? 2. Variant b?` |
| T+10min pane | (same text) | `❯ 1. Variant c? 2. Unclaim?` |
| Prompt hashes | identical across ticks | distinct across ticks |
| Per-tick freshness | stale | fresh-looking |
| `whip §1c` verdict | STUCK (surfaces) | PROGRESS (silent) |
| Reality | stuck | also stuck — looping over a problem-class |

The two signals share one root cause (agent not making task progress) but require different detection heuristics:

- **Static stuck** → hash-equality across ticks + freshness threshold (covered today by whip §1c).
- **Modal cycling** → ≥N distinct hashes within a window + zero-commit cross-check.

### Adjacent failure classes

- **[ADR-139](139-refusal-pattern-auto-rotate.md)** — agent-output-language refusal (*"don't poke me"*, *"I refuse this role"*). Same outcome (pane-alive-but-not-progressing) but agent is *outputting refusal text*, not *navigating modals*.
- **ADR-138** (verified send-keys, not yet shipped at file time) — KEYSTROKE refusal (pane won't accept send-keys; harness modal blocks input). Modal cycling often *follows* from failed sends that retry productively into modal-soup.
- **`whip §1c`** static-stuck — same target (catch dormant members) but distinct heuristic.

This ADR fills the gap between these three.

## Decision

Stable rule: classify the pane as modal before queued-text resubmit, and
never auto-submit a recognized modal prompt as composer text.

### (D1) Modal history per member at `~/.atmux/state/modal-history-<member>.json`

A per-member append-only state file capturing detected modal events:

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

**Shape rules**:

- File per member (avoids cross-member lock contention).
- Append-only writes; prune entries older than `windowMin * 2` (60min default) on each write.
- `paneTextHash` is **SHA256 of the extracted modal-text region only** (per OQ-1) — NOT the full pane. Reduces false-positives from incidental status-line variation.
- `modalText` truncated to 200 chars for compact storage; full text is hashed before truncation.
- `modalClass` is a coarse label (`choice-prompt`, `confirm-prompt`, `enter-prompt`) — for future cross-class semantic check; v1 uses simple hash-equality (per §Out of scope LLM deferral).

### (D2) Cycle-window check — ≥3 distinct hashes in 30min window (configurable)

The detection function reads the member's modal-history file, filters entries within `windowMin`, counts distinct `paneTextHash` values:

```ts
shouldFireCycleDetection(history, config):
  recent = history.filter(detectedAt within windowMin)
  distinct_hashes = unique(recent.map(h => h.paneTextHash))
  if distinct_hashes.length >= cycleThreshold AND commits_in_window === 0:
    fire = true, reason = "<N> distinct modal-classes in <windowMin>min window, 0 commits on claimed <taskId>"
```

Defaults (per §Config below): `cycleThreshold: 3`, `windowMin: 30`, `commitGracePeriodMin: 30`.

### (D3) Zero-commit cross-check — modals must be unproductive

Cycling through ≥3 modals is *productive ceremony* when the agent is also shipping commits — e.g. a reviewer member responding to multiple approval prompts as part of normal review flow. Cross-check eliminates the false-positive:

- Query git log on the member's worktree for commits attributed to the member matching their currently-claimed task during the cycling window.
- If `commits_in_window >= 1` within `commitGracePeriodMin`: classify as *productive ceremony* — record the history but do not fire detection.
- If `commits_in_window === 0`: classify as MODAL-CYCLING-STUCK.

`commitGracePeriodMin` matches `windowMin` by default (30min). Separate field allows tuning the commit-window independently from the modal-window for teams with different cadences.

### (D4) Discord `[member-modal-cycling]` template — fires once per cycle-detection

Per [CLAUDE.md global Discord rules + ADR-133 sibling pattern]. New named template in `src/abstractions/discord.ts` typed renderers (T2 ships):

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

**Dedup**: if last fire on this (team, member) was <`dedupMin` ago, skip Discord re-fire. History recording continues; only the surface action is deduped. Default `dedupMin: 30` matches `windowMin`.

**Verdict line**: `🟡 Modal-cycling` (per CLAUDE.md verdict-first vocabulary — modal cycling is **stalled-by-accident**, not **stalled-with-deliberate-pause**; 🟡 is appropriate, escalating to 🔴 / 🚨 only if post-clarifier the cycling resumes — Phase 2).

### (D5) Auto-escalation — clarifier dispatched + flag filed + lead escalation

On detection fire:

1. **Clarifier dispatch** — `atmux send <member> "[detector] modal-cycling detected — {N} prompts in {windowMin}min, 0 commits on {taskId}. Recommend: unclaim + retry from clean, or surface blocker via atmux reply if the prompt class is genuinely blocking work."` — non-destructive; agent reads + can decide.
2. **Flag filing** — `atmux flag add --severity high --subject "modal-cycling detected on <member>" --body "<modals seen + taskId + windowMin>"` — operator sees in normal complaint review.
3. **Lead escalation** — `atmux tell-lead "[detector] modal-cycling on {member} — see flag {fid}"` — lead may itself be stuck per ADR-140 medic-event path, in which case the flag is the durable audit trail.

Three surfaces (clarifier, flag, tell-lead) layered for resilience: clarifier might be ignored, tell-lead might race with stuck-lead, flag is the durable backstop. **Durable-first** per ADR-091: the modal-history state-file row records detection BEFORE any external messaging fires, so a partial failure (Discord rate-limited / member pane gone) doesn't leave us with notification-without-state.

## State-file format (§D1 expanded)

`~/.atmux/state/modal-history-<member>.json`:

```json
[
  {
    "member": "whip-impl",
    "paneTextHash": "sha256:abc123...",
    "detectedAt": 1715688000,
    "modalText": "❯ 1. Force-push to origin? 2. Pause...",
    "modalClass": "choice-prompt"
  },
  {
    "member": "whip-impl",
    "paneTextHash": "sha256:def456...",
    "detectedAt": 1715688600,
    "modalText": "❯ 1. Use --force-with-lease? 2. Use --force?...",
    "modalClass": "choice-prompt"
  }
]
```

**Retention**: prune entries older than `windowMin * 2` (60min default) on each write — covers the cycle-window analysis bound plus a small audit tail. Operator can extend by editing the file directly OR by raising the `windowMin` config.

**File-per-member** rationale: avoids cross-member write-lock contention; lets a single team have N concurrent detectors writing in parallel without serialization. Trade-off: cross-member aggregation requires reading N files — fine since the detection logic is per-member-scoped.

**Corrupt-file fallback**: T2 reader validates via Zod; corrupt JSON resets to `[]` and logs a recovery line. No exception thrown; detection continues from empty history.

## Discord template format (§D4 verbatim — see CLAUDE.md "Discord Message Format")

(Spec body above repeated verbatim — single source.) **Banned per CLAUDE.md**: prose walls, bare timestamps, SHA-dumps as bullets, "check team-log" pointers. The 🙏 Auto-action line is intentionally short — operator's normal default is "let auto-action work; check flag later"; only deviates to 🚨 / 🔴 on persistent-cycling escalation (Phase 2).

## Configuration — `team.json::modalCycling`

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

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. Set `false` to disable detection entirely for the team. |
| `cycleThreshold` | `3` | Minimum distinct modal-hashes within window to trigger. |
| `windowMin` | `30` | Modal-history analysis window in minutes. |
| `commitGracePeriodMin` | `30` | Commit-search window (matches windowMin by default). Separate field for cadence-mismatched teams. |
| `dedupMin` | `30` | Discord + clarifier dedup window. Matches windowMin by default. |
| `exemptMembers` | `[]` | Per-member opt-out — designated roles that legitimately interact with modal sequences (operator-firing-ad-hoc-from-pane, debug-helper, etc.). History still records; detection skips. |

Defaults applied when `modalCycling` block absent — `enabled: true` is the v1 stance (overnight-protection per CLAUDE.md "Don't make a dormant team look like a working team"). Backward-compat: existing teams without the block get default behaviour silently.

## Tradeoffs

### Bounded vs unbounded — same philosophy as ADR-139 + ADR-131

| Choice | Risk shape | Pick? |
|---|---|---|
| Auto-fire clarifier + flag + tell-lead on cycle-detection without operator round-trip | **Bounded**: occasional false-positive sends a clarifier the agent can ignore; cost = one tmux send-keys | ✅ |
| Refuse and ask operator on every cycle hit | **Unbounded**: overnight 0-commit per [[feedback_overnight_reddit_stakes]] — exactly the failure mode this ADR exists to prevent | ❌ |
| Static-stuck only (current §1c) — accept modal-cycling blind spot | **Unbounded** — observed 2hr blind-window on whip-impl 2026-05-14; recurring across atmux history | ❌ |

### Misdiagnosis blast radius

**False-positive cycle-fire** (productive-ceremony classified as cycling): clarifier dispatched to a member doing real work. Worst case: member ignores it (clarifier is non-destructive; non-bypassing). No commits lost, no rotation triggered. Self-corrects on next tick when commit count exceeds 0.

**False-negative** (cycling missed): same blast radius as the §1c blind spot today — `whip §1c` static check still covers the stuck-but-not-cycling case; this ADR is purely additive. Worst case under false-negative is the prior status-quo.

**Wrong modal-classification** (legitimate-prompt classified as cycling-prompt): the regex match for `classifyPaneAsModal` (T2) tightens this — only triggers on `≥2 numbered options + "Enter to select" OR ❯ marker + numbered list pattern`. Free-form text doesn't match.

### Cost — pane captures + state-file writes

Each whip tick: classifyPaneAsModal call (regex match, ~0.5ms), one append + prune to state-file (~5ms I/O), one read for cycle-check (~5ms). At fleet scale (5 teams × 10 members × 270s cadence martinet OR 60min cadence medic) — negligible.

Storage: ~250 bytes per modal-history entry × ~60min retention × N members. Even at peak detection rate (1 modal/min), ~15KB/member at retention boundary. Negligible.

## Cross-references

- **[ADR-138](138-)** (verified send-keys, not yet shipped at file time) — adjacent failure class. Modal cycling often *follows* failed sends; this ADR is the downstream detection layer when sends don't recover productively.
- **[ADR-139](139-refusal-pattern-auto-rotate.md)** — sibling pane-content classifier. ADR-139 detects refusal *language*; ADR-142 detects modal *thrashing*. Both end in clarifier dispatch + flag + lead escalation. Both share the same auto-rotate target verb (via clarifier → if persistent, escalation chain rotates).
- **ADR-140** (cheap-model-first, EPIC t-83dcef6b) — post-martinet-ship, this detector lives in martinet's per-tick observe pass (one call to `classifyPaneAsModal` + `shouldFireCycleDetection` per member-pane per tick). Pre-martinet-ship, lives in lead's `whip §1c`. **Single migration path**: the detection function in `src/core/modal-cycling-detector.ts` is called from both call sites; only the caller changes.
- **[ADR-077](077-superdoctor-cockpit-role.md) / [ADR-133](133-medic-rename.md)** — medic. Medic-event triggers on cycle-detection per ADR-140 event-driven architecture (medic doesn't run the detector itself at hourly cadence; martinet's per-tick detector emits events medic reacts to).
- **[ADR-132](132-pluggable-martinet.SUPERSEDED.md)** — martinet observe pass folds in modal-history as an enriched observation field per ADR-132 §D1 Observation shape.
- **CLAUDE.md** "Don't make a dormant team look like a working team" rule + whip §0.05 — this ADR makes the rule structurally enforced for the modal-cycling species.
- **CLAUDE.md** Discord Message Format — `[member-modal-cycling]` template follows verdict-first / milestone-grade / ask-loudly conventions verbatim.
- **[[feedback_overnight_reddit_stakes]]** — modal-cycling-then-auto-clarify prevents the overnight 0-commit failure mode operator has staked Reddit-receipts on.

## Open questions

**OQ-1 — Hash strategy: full-pane SHA256 vs modal-text-only SHA256?**

- **(A)** Full-pane SHA256 — every status-line variation (token count tick, ascii-clock blink, "Tools available: N" line) changes the hash. Easy to compute; high false-positive rate (each tick reads as "new modal").
- **(B)** Modal-text-only SHA256 — extract the modal region (between `❯` marker and next blank line OR end-of-block) and hash that. Tighter false-positive rate; matches the operator-visible signal.

**Recommended default**: **(B) modal-text-only SHA256.** The detection target is "agent navigated a different prompt", not "any byte changed in the pane." Status-line variation is incidental noise. T2 implementation extracts the modal region first, hashes that.

Driver override via decisions log when operational data shows modal-text-only misses legitimate cycle patterns.

**OQ-2 — Detector tier: lead/medic/martinet?**

Three placement options:

- **(A) Lead's `whip §1c`** — pre-martinet-ship reality. Lead pane runs the detector at its own whip cadence.
- **(B) Medic (W2 hourly)** — too slow for cycling detection; medic catches static-stuck at hourly but cycling can finish a 2hr binge before medic re-checks. Inappropriate primary; OK as backstop.
- **(C) Martinet (W3 270s)** — post-ADR-132-ship. Per-tick cadence catches cycling much faster (90% of 30min-window cycles get 6+ ticks of detection opportunity).

**Recommended default**: **start at (A) pre-martinet-ship; migrate to (C) post-martinet-ship.** The detection function in `src/core/modal-cycling-detector.ts` is the same; only the call-site changes. T2 lands the function + lead `whip §1c` wire-in; ADR-140 chain ports the call to martinet when martinet ships.

Driver override via decisions log when the migration timing shifts.

## Implementation plan

This ADR commits the **specification only**. Implementation lands across the EPIC's three sub-tasks (per t-753fb165 §Sub-tasks):

| T | ID | Sub-task | Deps | Lane |
|---|---|---|---|---|
| T1 | t-6dc9a673 | Draft ADR-142 (this ADR) + state-file format + Discord template + config block | — | docs / planner |
| T2 | t-751e098e | `src/core/modal-cycling-detector.ts` + state-file caller + whip §1c wire-in + unit tests | T1 | be |
| T3 | t-c5738732 | e2e — synthetic 3-modal-cycle scenario + assert detector + Discord + clarifier dispatch | T2 | test |

Reviewer flips this ADR Proposed → Accepted in a follow-up commit per the EPIC's acceptance gate.

## Acceptance gates (per t-6dc9a673 §Acceptance)

For T1 specifically:

- [x] `docs/adr/142-modal-cycling-detector.md` exists with `Status: Proposed`.
- [x] All 5 architecture pieces (D1-D5) documented per t-753fb165 body.
- [x] State-file schema documented with example.
- [x] Discord template documented per CLAUDE.md format rules.
- [x] `team.json::modalCycling` config block documented with defaults.
- [x] Cross-refs to ADR-138/139/140/077/132/133 + CLAUDE.md.
- [x] 2 OQs with recommended defaults (modal-text-only hash; lead-now → martinet-post-ship migration path).
- [ ] Single commit; reviewer-gated.

Wider EPIC acceptance gates T2-T3 — those are out of T1's scope.

## Out of scope (per t-753fb165 body)

- **Detection across cage boundaries** — modal cycling within one team is in scope; cycling pattern correlation across teams (e.g. "every team's `reviewer` hits modal-cycling on the same prompt class → systemic prompt bug") deferred to Phase 2 if pattern emerges.
- **LLM-classifier for modal-class semantic similarity** — v1 uses simple hash-equality on the modal-text region. "Is modal #2 semantically *the same problem* as modal #1?" is a richer question that the LLM-classifier could answer (catches near-duplicate prompts with slight wording variation that escape hash-equality). Deferred until regex+hash false-negative rate becomes operationally meaningful.
- **Auto-rotation on modal-cycling** — v1 escalation chain is *clarifier + flag + tell-lead*, not rotation. Modal-cycling may be a brief-content problem (wrong instructions causing the prompt loop) rather than agent-context-degradation; rotating the agent doesn't fix a wrong brief. Rotation as remediation deferred to Phase 2 (after observing whether clarifier dispatch resolves the common cases).
- **Productive-cycling whitelist** (modal patterns that are always-productive even with zero commits, e.g. multi-step deploy approval flows) — v1 covers via `exemptMembers` per-member opt-out. Per-modal-class whitelist deferred until concrete demand emerges.

## Audit trail

Origin: 2026-05-14 driver session observation — whip-impl 2hr push-modal cycling on `t-7e7031dc`. Operator diagnostic question recorded verbatim in frontmatter above. Modal-class sequence (push → variant-a/b → variant-c/unclaim) is the canonical fixture for T3 e2e synthesis. EPIC `t-753fb165` body lists all 5 architecture pieces verbatim; this ADR-142 is the T1 planner-decomp artifact.

Merge-resolution note: this ADR was independently drafted on both `geoyws-planner` and `geoyws-up-impl` branches under the same Task `t-6dc9a673`. The trunk-side draft (more thorough — comparison table, adjacent-failure-class survey, tradeoff matrix) is preserved as the canonical body; the up-impl draft's `Driver-ref` frontmatter, durable-first reference, and this Audit-trail section have been folded in. Resolved at trunk-merge time by gitter per `t-84d73310`.

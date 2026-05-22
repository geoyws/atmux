# ADR-214: Retire Ombudsman role — Lead absorbs complaint adjudication via Honker push

**Status**: Accepted — ratified by driver 2026-05-21 (Ombudsman role retires entirely; ADR-147 role half superseded but release-notes layout half PERSISTS as operator-facing convention; ADR-150 cross-team complaint routing PERSISTS — semantics preserved via `atmux tell-lead --team <target>` in the consumer; §D2 canonical Honker complaint-adjudication path complaint.filed→consumer wakes ~1ms→atmux tell-lead → Lead's Claude adjudicates with resolve/wontfix/promote-epic/dismiss/escalate decision matrix; rate-limit at consumer (1 complaint/min/team batched; bursts collapse into summary entry); §D3 complaint.filed topic stays in TOPICS, zero topics added or removed; §D4 folds into e-honker-observation-watchdogs EPIC alongside sentinel+medic functions, no new EPIC, EPIC count unchanged at 4 post-substrate; §D5 brief sweep — lead brief grows §Complaint-adjudication, ombudsman brief deleted in cleanup-EPIC; §D6 ombudsman-config-residue probe merges into consolidated retired-role-config-residue probe; §D7 sequencing — retires alongside medic+jury in same wave, ≥30 days observed-stable cutover at cleanup-EPIC; §OQ recommendations as-written; sibling simplification to ADR-211/212/213)
**Date**: 2026-05-21
**Driver-ref**: 2026-05-21 operator — *"let's retire the ombudsman... because honker can help push complaints to lead"* + *"we need to simplify atmux... it is too bloated"* — continuation of the same-session simplification arc: ADR-211 (sentinel retire) + ADR-212 (medic retire) + ADR-213 (jury retire) + this ADR.
**Supersedes**: [ADR-147](147-ombudsman-and-release-notes.md) §"Ombudsman role" — role retires. ADR-147's **release-notes layout** half persists (operator-facing convention; not coupled to ombudsman). [ADR-150](150-cross-team-complaints-routing.md) cross-team complaint routing semantics ALSO persist — the storage-side decisions stand; only the role-actor changes.
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) §D12 (Honker substrate consumer EPIC sequence — `complaint.filed` consumer folds into `e-honker-observation-watchdogs`), [ADR-203](203-event-topic-taxonomy.md) §D2 (`complaint.filed` event topic — stays in TOPICS registry), [ADR-211](211-retire-sentinel-role-distribute-to-honker-consumers.md) + [ADR-212](212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) + [ADR-213](213-retire-jury-reviewer-absorbs-acceptance-criteria.md) (sibling simplification ADRs — same lead-gated pattern), memory `feedback_opus_all_for_agile_flow` (operator stance).

## Context

ADR-147 introduced the Ombudsman role to **adjudicate** complaints filed by medic / whip / operator / member sources. The complaint storage already existed (`src/schema/complaints.ts` + `src/verbs/complaints.ts` + `src/core/complaints.ts`); what was missing was an actor that read open complaints and decided their fate (resolve / wontfix / promote-to-epic / dismiss).

That role was a per-team pane (e.g. `geoyws-ombudsman` worktree, now `atmux-geoyws-ombudsman` post trunk-rename) running Claude Opus. It was cron-poked to process pending complaints periodically.

The Honker substrate (ADR-202) replaces the polling model:

- `complaint.filed` event already in ADR-203 §D2 topic taxonomy (mirrors to cockpit per ADR-203 §D4).
- A Honker consumer wakes ~1ms after complaint INSERT.
- The consumer calls `atmux tell-lead "<complaint summary + adjudication prompt>"` per the lead-gated pattern from ADR-212 §D2.
- Lead's Claude reads inbox + adjudicates (same decisions ombudsman made: resolve / wontfix / promote-epic / dismiss / escalate-to-driver).

Lead is **already in the chain**, already a default member, already trusted with judgment-class decisions. Folding complaint-adjudication into the lead removes the whole ombudsman pane + verbs + brief + crontab arming.

What ombudsman did that lead absorbs cleanly:
- Read pending complaints — Honker `complaint.filed` consumer reads them
- Adjudicate — lead's Claude reads the inbox entry, decides
- Resolve via `atmux complaints resolve` — lead runs the verb after deciding
- Promote to EPIC via `atmux epic add` — lead does it under existing lead authority
- Log response in release-notes — lead writes per ADR-147's release-notes convention (still in scope)

What was unique about ombudsman that lead doesn't naturally have:
- A dedicated pane focused only on complaints. Without ombudsman, complaints contend with other lead inbox traffic. Mitigation: lead's brief grows a §"Complaint adjudication" triage section; rate-limit at the Honker consumer (one complaint per N min batched to inbox) so the lead isn't flooded.

## Decision

### D1 — Retire the Ombudsman role entirely

No production atmux configuration ships `ombudsman` as a default member. Same shape as ADR-211/212/213 retirements:

- `ombudsman` is NOT added as a default member to any team going forward.
- `src/verbs/ombudsman.ts` + `src/core/ombudsman.ts` + the `atmux ombudsman tick` verb deleted in cleanup-EPIC.
- The per-team `geoyws-ombudsman` worktree (now `atmux-geoyws-ombudsman` post-trunk-rename) is scheduled for removal — operator runs `atmux worktree remove <path>` + `git branch -d atmux-geoyws-ombudsman` in their own session.
- Cron block `atmux:ombudsman-tick` (if present in operator crontab) removed via ADR-197 cron-reaper teardown contract during cleanup-EPIC.
- `templates/briefs/ombudsman.md` deleted in cleanup-EPIC.

What persists from ADR-147:
- **Release-notes layout** convention — operator-facing pattern, not coupled to ombudsman role. Stays.
- **Complaint storage + verbs** (`atmux complaints file|list|resolve`) — already-shipped storage substrate; only the adjudicating role retires.
- **Per-team complaint routing** (ADR-150) — cross-team complaint write semantics stay; the actor reading them changes.

### D2 — Complaint adjudication via Honker → lead-gated pattern

```
atmux complaint file → INSERT into complaints table + emit `complaint.filed` event
                                              ↓
                       Honker NOTIFY fires (~1ms)
                                              ↓
                       Consumer (in e-honker-observation-watchdogs EPIC) wakes
                                              ↓
                       Consumer calls: atmux tell-lead "<complaint summary + asks>"
                                              ↓
                       Lead's tmux pane gets keystroke wake + driver-inbox entry
                                              ↓
                       Lead's Claude reads inbox on next turn, decides:
                         - resolve  → atmux complaints resolve <c-id> --reason "..."
                         - wontfix  → atmux complaints resolve <c-id> --reason "..." --wontfix
                         - promote  → atmux epic add "<derived title>" + complaints resolve <c-id> --epic <e-id>
                         - dismiss  → atmux complaints resolve <c-id> --reason "..." --dismiss
                         - escalate → atmux tell-driver "<reason>" + complaint stays open
```

Same lead-gated pattern as sentinel / medic / jury retirements. Detection automated, judgment + execution gated by Claude lead's reasoning.

**Rate-limit** at the consumer: one complaint per minute per team batched to the lead's inbox; bursts (e.g. 10 complaints fired in same second by medic's hygiene drain) batch into a single inbox entry with a summary line + per-complaint detail.

**Cross-team complaints** (per ADR-150) route to the TARGET team's lead via `atmux tell-lead --team <target>`, NOT the originating team's lead. ADR-150 semantics preserved.

### D3 — `complaint.filed` topic stays; ombudsman-related topics removed

`complaint.filed` event topic (ADR-203 §D2) stays — it's the trigger for the lead-gated consumer.

If any ombudsman-internal events were enumerated (per a quick re-read, none in current ADR-203 §D2 — the v1 taxonomy doesn't have `ombudsman.*`), they would be dropped here. Net change: zero topics added or removed from ADR-203 §D2 v1 set.

### D4 — Drop the would-be `e-honker-ombudsman` consumer EPIC

ADR-202 §D12's revised sequence per ADR-212 §D4 lists `e-honker-observation-watchdogs` as the absorber of sentinel + medic functions. **Complaint-adjudication consumer folds into the SAME EPIC** — no new EPIC needed. Per ADR-212 §D4 "every continuous-observation function migrates to one consumer EPIC, lead-gated for destructive actions."

Updated `e-honker-observation-watchdogs` scope:
- Sentinel functions (pane-classifier, wedge-clearer, refusal-handler, silent-team-detector)
- Medic functions (hygiene-violation handler, lead-uptime watchdog, member-stall watchdog)
- **NEW**: Complaint-adjudication consumer (`complaint.filed` → tell-lead)
- Context-pct enrichment of all rotation-candidate events (ADR-212 §D7)

**No EPIC count change.** Still 4 consumer EPICs after substrate per ADR-213 §D5:
- e-honker-gitter
- e-honker-observation-watchdogs (absorbs sentinel + medic + ombudsman functions)
- e-honker-whip
- e-honker-cleanup

### D5 — Brief + memory sweep

- `templates/briefs/lead.md` grows §"Complaint adjudication" — triage shape (severity by source: medic-filed > whip-filed > member-filed), per-complaint decision matrix, resolve verb usage, escalation paths.
- `templates/briefs/ombudsman.md` deleted in cleanup-EPIC.
- Memory `feedback_ombudsman_brief_reply_to_outbox_stale` becomes obsolete after retirement — annotation pointer to this ADR.

### D6 — Doctor probe

Single probe row `ombudsman-config-residue` (yellow → red post-cleanup-EPIC) when any `team.json::members[]` has `name === "ombudsman"` or `id === "ombudsman"`. Hint: per ADR-214, ombudsman retired — remove member; lead absorbs adjudication.

Merges with prior retirement-residue probes (sentinel-config-residue + medic-config-residue + jury-config-residue) into the consolidated `retired-role-config-residue` probe in cleanup-EPIC.

### D7 — Sequencing

Ombudsman retires alongside medic + jury — same wave per ADR-212 §D5 + ADR-213 §D5. Cutover sharp at cleanup-EPIC after ≥30 days of `e-honker-observation-watchdogs` running stable. Until then ombudsman pane continues running (Opus backend) as the safety net; new complaints fired during the rollout are double-handled (ombudsman + lead both see them) — harmless redundancy.

## Consequences

**Becomes easier:**

- One fewer default per-team member (no `ombudsman` pane spawned + no worktree to provision/dissolve).
- One fewer verb family in the active surface (`atmux ombudsman *`).
- Complaint adjudication latency drops from cron-cadence (~5-15min) to Honker-event (~1ms wake + Claude lead turn time).
- Lead becomes the single judgment-class actor for the team — clearer accountability vs scattered across ombudsman + medic + sentinel.
- ADR-147's release-notes convention persists (operator-facing surface unaffected).

**Becomes harder:**

- Lead's inbox traffic grows by another event class. **Mitigation**: rate-limit per §D2 (batched bursts), brief documents triage, lead can ask operator to throttle complaint sources if volume problematic.
- No dedicated pane for complaint history audit. **Mitigation**: complaints stay in `state.db` per ADR-150 — `atmux complaints list --status all` returns the same audit surface.
- Operator may have habit muscle of `tmux switchc -t atmux-...:ombudsman` to read complaint state. **Mitigation**: shift to `atmux complaints list` or `atmux complaints show <c-id>` for the same data.

**Risks + mitigations:**

- **Risk**: Complaint volume during incidents floods lead's inbox. **Mitigation**: rate-limit at the consumer per §D2. Burst-batching + summary line. Lead can mass-resolve via `atmux complaints resolve --all-from <source> --reason "..."` if a single source goes haywire (existing verb feature).
- **Risk**: Lead misses a critical complaint (rubber-stamp or forget). **Mitigation**: complaint.filed events have severity field; consumer escalates `severity: high` complaints to operator-gated tier (driver-inbox + Discord ping) per ADR-212 §D2 second tier.
- **Risk**: ADR-150 cross-team routing semantics break under the lead-gated model. **Mitigation**: §D2 explicitly preserves the routing — consumer uses `atmux tell-lead --team <target>` for cross-team complaints; the routing decision is at the consumer's filed-by-X-targeting-Y logic, not at the lead's inbox.
- **Risk**: Ombudsman retirement removes the only actor that promoted complaints to EPICs autonomously. **Mitigation**: lead can do this via `atmux epic add` under existing lead authority (lead already files EPICs from driver asks). Same verb; different actor.

## Out of scope (deferred)

- **Cross-team complaint correlation** (e.g. "5 complaints in 1h about same root cause across teams → infrastructure issue, file global EPIC") — operator-driven analysis via `coordination:bau` or new `atmux audit complaints` verb; not in this ADR.
- **LLM auto-adjudication** (consumer LLM-judges complaints autonomously without lead) — explicitly rejected per the lead-gated pattern. Same reason cursor sentinel was rejected: autonomous LLM making structural calls.
- **Re-adding ombudsman role** — possible via new ADR + revert §D1. Not anticipated; lead-gated covers the function.
- **Migrating the per-team `<team>-ombudsman` worktrees to a different role** — worktrees scheduled for removal per §D1, no repurposing planned.

## References

- ADR-147 — Ombudsman role + release-notes layout (role superseded; release-notes layout persists)
- ADR-150 — cross-team complaint routing (preserved per §D2)
- ADR-202 §D12 — Honker substrate consumer EPIC sequence (absorbed into e-honker-observation-watchdogs per §D4)
- ADR-203 §D2 — event topic taxonomy (`complaint.filed` topic stays; no changes)
- ADR-211 — sentinel retirement (sibling simplification — same lead-gated pattern)
- ADR-212 — medic retirement (sibling simplification — same lead-gated pattern + §D2 lead-gated canonical)
- ADR-213 — jury retirement (sibling simplification — reviewer-absorbs variant)
- memory `feedback_ombudsman_brief_reply_to_outbox_stale` — becomes obsolete after retirement; annotation pointer to this ADR
- memory `feedback_opus_all_for_agile_flow` — Opus-only stance; lead is already Opus

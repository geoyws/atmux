# ADR-210 reviewer-pass — Eliminate hold-posture deadlock structurally

**Reviewer**: reviewer (team `atmux`)
**Date**: 2026-05-24 08:13 MYT
**ADR under review**: `docs/adr/210-eliminate-hold-posture-deadlock-structurally.md` (Status: Proposed — filed 2026-05-21)
**Sibling ADR**: ADR-209 (detection + recovery layer — coexists per §Tier 2 / §Consequences neutral row)

## Verdict

**APPROVE** — Planner can flip Status: Proposed → accepted. The Tier 1 structural fix is **already shipped in code**; the ADR documents the decision the briefs now embody. Tiers 2–4 stay as design contract for follow-up; no impl gates remain to APPROVE the document itself.

## Why APPROVE — code-doc parity audit

ADR-210 §Tier 1 calls for two brief edits (S1 + S2 from §Implementation slices). Both are present in the templates as of HEAD:

| Surface | ADR-210 contract | Implementation in tree | Verdict |
|---|---|---|---|
| Lead bootstrap | §Tier 1 "kanban-first dispatch; planner moves from gating to enriching" | `templates/briefs/lead.md` §Your loop step 2 (`Kanban-first dispatch (BEFORE driver-inbox routing) — per ADR-210 §Tier 1`) | ✅ in tree |
| Planner role | §Tier 1 "planner enriches asynchronously, lead never blocks on planner activity" | `templates/briefs/planner.md` §intro (`Async-enrich, not gating — per ADR-210 §Tier 1. You are NOT a gate on lead dispatch.`) | ✅ in tree |

Both blocks cite ADR-210 §Tier 1 with same-doc anchor — satisfies CLAUDE.md §Same-commit doc + ADR-pointer update gate. Backport via S3 is per-spawn (operator opts in by re-spawning epic-teams); zero action required from this ADR's signoff.

## Audit checklist (per `templates/briefs/reviewer.md` §Audit checklist)

| Column | Verdict |
|---|---|
| Acceptance criteria coverage | ✅ Tier 1 (S1+S2) shipped; Tier 2–4 are explicit follow-up scope, not gating |
| Schema hygiene | ✅ ADR adds no JSON / kanban shape — pure brief edits |
| Authz / boundary writes | N/A — no code-path changes |
| Secrets | ✅ none |
| Test coverage on tracked paths | N/A — brief edits are not a tracked test path; `templates/briefs/*.md` is a docs surface |
| No bypass mechanisms | ✅ none |
| Vocabulary | ✅ lowercase lane tokens in JSON examples; UPPER-CASE in prose |
| ADR alignment | ✅ briefs cite ADR-210 §Tier 1 verbatim; deadlock language matches the ADR |
| `doc-update` | ✅ ADR + briefs land same-surface; no documented-surface drift |
| `paneMatchesRegex` justification | N/A — no pane-state code in this ADR |

## Internal coherence checks

- **§Tier 1 vs §Tier 2 boundary clean.** Tier 1 fixes lead's hold-for-planner; Tier 2 adds member-side pull fallback for lead-failure modes. Distinct failure classes; non-overlapping mitigations. ✅
- **§Tier 4 explicit non-goal (state-machine orchestration) documented.** Prevents scope creep on follow-up. ✅
- **§OQ3 cross-ADR interaction with ADR-209 §4 (sentinel auto-kick).** Driver pref: keep as backstop, lower priority. ADR-209 review (pending) needs to honor this when its §4 lands. Flag for ADR-209 reviewer pass: confirm sentinel-kick check guards against "Tier 1 brief was applied; auto-kick redundant" — likely via probe order (check `lastDispatchHeartbeatAt` updated BEFORE firing kick).
- **Backport friction acknowledged (§Consequences negative).** Existing in-flight teams need `/clear` to pick up new brief; called out + S3 covers it. ✅

## OQ resolutions noted (driver prefs in ADR body — non-blocking)

| OQ | Driver pref | Reviewer note |
|---|---|---|
| OQ1 — backport scope | new-spawn-only + S3 on-demand | ✅ minimal-friction default; matches "operator chooses" doctrine |
| OQ2 — pull-protocol opt-out | default 15min timeout + opt-out per team.json flag | ✅ defers Tier 2 to follow-up; OK |
| OQ3 — interaction w/ ADR-209 §4 | keep as backstop, lower priority | ✅ structural fix + detection backstop is a clean defense-in-depth |

## Tier 2–4 — not gated by this signoff

- **Tier 2 (S4–S7)** — pull-protocol member fallback. Requires S4 (verify `claim --next` lock robust under concurrent claims) as prerequisite. Lands as follow-up release; signoff for this ADR does NOT block on Tier 2 impl.
- **Tier 3 (lead-as-optional)** — emergent, no separate ADR required per §Tier 3 body. Self-documents through operator behavior.
- **Tier 4 (workflow state machine)** — explicit REJECTED. Clean non-goal statement; no follow-up required.

## Cross-refs

- ADR-209 — detection + recovery layer (paired; awaiting its own reviewer pass)
- `templates/briefs/lead.md` §step 2 — Tier 1 lead-side implementation
- `templates/briefs/planner.md` §intro — Tier 1 planner-side implementation
- ADR-218 §D3 — extends ADR-210 §Tier 1 doctrine to sweep-epic verdicts (separate ADR; its own signoff)

## Follow-up — non-blocking, surfaced for planner

1. **ADR-209 review (paired).** Recommend approving ADR-209 as design contract since its bugs are well-evidenced; Tier 1's existence means ADR-209 §4 (sentinel auto-kick) should land lower-priority per OQ3.
2. **CHANGELOG entry** for ADR-210 §Tier 1 shipping (briefs changed) — likely already in flight if planner queued it; if not, file as docs Task.
3. **Tier 2 prerequisite S4** (`claim --next` concurrent-claim lock audit) — separate Task in the BE lane; not gated by this ADR's Status flip.

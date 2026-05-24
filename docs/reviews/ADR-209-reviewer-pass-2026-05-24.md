# ADR-209 reviewer-pass — Epic-team hold-posture deadlock + cage-state probe false-negative + sweep lastCommitHoursAgo semantic

**Reviewer**: reviewer (team `atmux`)
**Date**: 2026-05-24 08:13 MYT
**ADR under review**: `docs/adr/209-never-started-epic-team-detection.md` (Status: Proposed — filed 2026-05-21, corrected same day)
**Sibling ADR**: ADR-210 (structural fix — reviewer-pass APPROVE, see `docs/reviews/ADR-210-reviewer-pass-2026-05-24.md`)

## Verdict

**CONDITIONAL APPROVE** — design contract is sound (4 bugs well-evidenced, fixes mechanical, slice decomposition reasonable). Two §Amendment items must land before Status: Proposed → accepted flip — both are documentation-coherence fixes, no design rework, no module-impl ripple:

1. **STALE-OQ-RESOLUTION RECONCILE** — `.atmux/decisions.md` d-1a2150ff / d-595c16af / d-66c08fb1 reference the PRE-correction ADR-209 (NEVER-STARTED verdict, `epic-meta.json` filename, 6h grace clock). The current ADR body's §OQs are different questions about Bug 4 auto-kick (kick cadence, kick payload, opt-out vs opt-in). Either supersede the stale decisions with `d-* SUPERSEDED — ADR-209 corrected 2026-05-21; OQ-set replaced` annotations, OR re-route the new OQs through `decisions add` so the decision log matches the ADR body. As-is, a future reader hitting decisions.md hunting "ADR-209 OQ1" finds answers to a question the ADR no longer asks.
2. **FILENAME COHERENCE: `team-meta.json` vs `epic-meta.json`** — ADR §D2 body says `.atmux/state/team-meta.json` (new). The stale decisions.md entries say `epic-meta.json`. The semantic is unambiguous (per-epic-team metadata file), but the filename token must be one OR the other consistently. ADR body's `team-meta.json` is the canonical pick (matches the "team-spawn-epic writes" prose). Add a §Naming-note paragraph: "Pre-correction draft used `epic-meta.json`; canonical name is `team-meta.json` per §D2. Implementation must not split-name."

Both fixes are single-edit (one §Naming-note paragraph + 3 d-* SUPERSEDED annotations). Planner can fold them in the same edit that flips Status.

## Why CONDITIONAL not REJECT — design substance is approved

The four-bug diagnosis is exemplary:

| Bug | Evidence | Fix | Reviewer verdict |
|---|---|---|---|
| Bug 1: `lastCommitHoursAgo` reads merge-base, not branch-local commit | §Evidence step 3 (`git rev-list --count $(merge-base)..$branch → 0` proves zero branch-local commits) | merge-base-aware count + 99999 sentinel | ✅ correct fix; simple + unambiguous |
| Bug 2: no productivity signal alongside liveness | `cageState: up` for every member but 0 commits + 0 dispatches | new `team-meta.json` supplies `lastDispatchHeartbeatAt` + `lastCommitOnBranchAt` | ✅ minimal substrate; supports Bugs 3, 4 |
| Bug 3: `cageState` probe false-negative | §Evidence step 1 (capture-pane shows alive claude; `atmux status --json` says `down`) | tmux socket pane-PID + descendant walk for registered TUI | ✅ correct probe; risk-row (inverse false-positive) acknowledged in §Consequences |
| Bug 4: hold-posture deadlock has no auto-unstick | §Context para 5 (driver had to `/bruh` 7 teams by hand) | sentinel auto-kick gated by `(all-up) AND (todos>0) AND (no-dispatch-30min)` + debounce | ✅ sound; ADR-210 §Tier 1 makes this rarer (defense-in-depth) |

## Audit checklist (per `templates/briefs/reviewer.md` §Audit checklist)

| Column | Verdict |
|---|---|
| Acceptance criteria coverage | ✅ Each bug has a §Decision sub-section with concrete patch sketch |
| Schema hygiene | ⚠️ New `team-meta.json` shape proposed in §D2 — schema lives in the ADR prose; needs `src/schema/team-meta.ts` Zod schema in impl Task (S1) for `doc-update` gate when S1 lands |
| Authz / boundary writes | N/A — design doc, no code |
| Secrets | ✅ none |
| Test coverage on tracked paths | N/A — design doc; impl Tasks (S1–S7) carry the coverage burden |
| No bypass mechanisms | ✅ none |
| Vocabulary | ✅ verdict tokens UPPER-CASE in prose (DRAIN, SAFE-DISSOLVE, IDLE-WITH-TODOS); field names lowercase in JSON examples |
| ADR alignment | ⚠️ STALE-OQ-RESOLUTION — see Amendment 1 |
| `doc-update` | N/A for the design doc itself; impl Tasks must same-commit `team-meta.json` schema + sentinel auto-kick wiring |
| `paneMatchesRegex` justification | N/A |

## Internal coherence checks

- **CORRECTION header is honest.** Retracts original Bug 3 ("atmux up lies about session existence"); explains the `tmux -S` socket-probe error; retains old title for traceability. ✅ exemplary post-filing correction discipline.
- **Bug 4 auto-kick interacts with ADR-210 §Tier 1.** Tier 1 ships first (already in templates/briefs per ADR-210 reviewer-pass); auto-kick becomes a backstop for the case where the lead's bootstrap brief didn't get reloaded. ADR-210 §OQ3 driver-pref ("keep ADR-209 §4 as backstop; lower priority") aligns with this — non-conflicting defense-in-depth. ✅
- **§D5 IDLE-WITH-TODOS vs §D6 auto-dissolve scope.** §D6 explicitly: "IDLE-WITH-TODOS surfaces + kicks but NOT auto-dissolves — they have real planning to execute." Clean carve-out from SAFE-DISSOLVE. ✅
- **Title↔body disagreement.** Title says "Epic-team hold-posture deadlock + cage-state probe false-negative + sweep `lastCommitHoursAgo` semantic" — accurate post-correction. The "NEVER-STARTED" original framing is gone from the body; the title retention is explicitly for filing-commit traceability (`a7fec9f`) per the CORRECTION note. ✅ acceptable.

## Implementation slice readiness

| Slice | Verdict | Notes for impl-Task body |
|---|---|---|
| S1 — `team-meta.json` schema + writer + post-commit hook | Ready | Add Zod schema in `src/schema/team-meta.ts`; same-commit unit tests; post-commit hook is per-epic-worktree (install at `team spawn-epic` time per CLAUDE.md docs discipline) |
| S2 — `lastDispatchHeartbeatAt` stamp | Ready | Single field-write at the dispatch call site; small test |
| S3 — `lastCommitHoursAgo` merge-base-aware fix | Ready, **highest ROI single-slice** | Quick-win; ship first per the ADR's own §Implementation slices ordering note |
| S4 — `cageState` tmux pane-PID probe | Ready, **highest ROI single-slice** | Quick-win; replaces stale-flag probe; needs careful test for inverse-false-positive (Per §Consequences negative row 3) |
| S5 — IDLE-WITH-TODOS verdict | Ready | After S1 + S3; small classifier edit |
| S6 — sentinel auto-kick + debounce | Ready | After S1 + S2 + S5; debounce per `(team, kanban-todo-count)` tuple per §D4 |
| S7 — verdict surfacing in dashboard / driver-inbox | Ready | After S5 + S6; cosmetic |

## OQ resolutions (need re-routing — see Amendment 1)

The ADR body lists three OQs about Bug 4 auto-kick (cadence/payload/opt-in). These are NOT yet in decisions.md. Three different OQs ARE in decisions.md (d-1a2150ff, d-595c16af, d-66c08fb1) about pre-correction NEVER-STARTED detection. Net: ZERO of the ADR's stated OQs have resolutions; THREE stale decisions reference a design the ADR no longer carries.

Recommended actions:
1. Annotate the three stale d-* entries with `SUPERSEDED — ADR-209 corrected 2026-05-21; OQ-set replaced` so the decision log stays append-only-but-honest.
2. `atmux decisions add` for the three current OQs (cadence/payload/opt-in) per the ADR body's driver-pref defaults.
3. Or: take driver's body-text prefs as de-facto resolutions, mark the OQs with `RESOLVED in §Open questions body text per driver-pref` in the ADR itself + flip Status: accepted.

Path 3 is the lowest-ceremony — body-text resolution is acceptable per ADR template if cited cleanly. Path 1+2 is decision-log-purest. Planner's call.

## Cross-refs

- ADR-210 — structural fix (sibling, already approved this pass; Tier 1 in tree); §Tier 1 makes Bug 4 auto-kick rarer-fire, not redundant
- `.atmux/decisions.md` d-1a2150ff / d-595c16af / d-66c08fb1 — stale OQ-resolutions referencing pre-correction NEVER-STARTED design (see Amendment 1)
- 2026-05-21 sopx 12-epic-team incident — primary driver-ref + repro evidence
- Filing commit `a7fec9f` — retained in title for traceability per CORRECTION header

## Follow-up — non-blocking, surfaced for planner

1. **Spawn impl-Tasks for S3 + S4 first** (highest-ROI quick-wins per §Implementation slices ordering note); land in BE lane.
2. **S1+S2 together as a single Story** — they share the `team-meta.json` substrate; couple the schema definition with the first writer to enforce schema-first discipline.
3. **S6 sentinel auto-kick** — depends on Tier-1 brief being baseline. Implement guard: if `lastDispatchHeartbeatAt` was set in the same tick, skip kick (Tier-1 lead just dispatched; auto-kick is redundant noise).

# ADR-195: epic-team EPIC-done — transfer follow-up Tasks to parent kanban before dissolve

**Status**: accepted
**Date**: 2026-05-20
**Related**: [ADR-091](./091-kanban-driven-auto-merge.md) §EPIC-done definition (the section this ADR amends), [ADR-090](./090-epic-team-lifecycle.md) §`dissolve-epic` (the dissolve mechanism that destroys the kanban), [ADR-134](./134-in-team-auto-merger.md) (intra-team merger sibling — same scope-mirror question one level down).

## Context

### Trigger case

During the ADR-027 EPIC `e-1e223687` (team-rename verb) on 2026-05-20, **fe-1 filed `t-f0adc3bc`** ("Wire rename-lock guards into cron'd consumers") in the epic-team's kanban while shipping T7 docs sweep. T7's grep audit caught a real implementation gap: ADR-027 §Consequences specified `[[ -f rename.lock ]] && return 0` entry-guards at every cron'd consumer (sentinel, cron-orphans, etc.), but T3 (`492f1fa`) only shipped the lock-file creation side — consumer-side guards were never wired. The body is fully self-contained (cites ADR-027 §Consequences, names `src/verbs/sentinel.ts` + `src/verbs/cron-orphans.ts`, gives the `rg` verification command, enumerates scope).

The Task is **BE-lane prio=3**, owner-null, deps empty — a clean follow-up. It is **not** in scope for the current EPIC (the EPIC ships the verb; this Task hardens an adjacent cron-consumer surface).

### The hazard

Per [ADR-090](./090-epic-team-lifecycle.md) §`dissolve-epic` + [ADR-091](./091-kanban-driven-auto-merge.md) §State-machine `merged → dissolved` terminal, the epic-team's cage tears down on dissolve:

- Worktree pruned (`<parentRoot>-epics/<epicId>/` removed).
- Cockpit entry removed.
- `.atmux/state.db` evaporates with the worktree.

**Every Task in the epic-team's kanban that didn't move to `done` evaporates with it.** Today's flow has no carry-forward; the parent team's planner has no signal that a follow-up Task was filed mid-EPIC. The Task is orphan-dropped.

This isn't a hypothetical — it happens **right now** in `e-1e223687`. T7 ships, EPIC reaches `merged → dissolved`, `t-f0adc3bc` disappears with the worktree. The cron-consumer guard gap stays open; the ADR-027 §Deviations note in T7 docs is the only artifact pointing at the gap, and a future contributor reading that artifact has to re-derive the Task from scratch.

### Why ADR-091 §EPIC-done is the right place to lock this

[ADR-091](./091-kanban-driven-auto-merge.md) §EPIC-done definition (the 4-condition canonical) is the gate that triggers `ready_to_merge → merging → merged → dissolved`. The current 4 conditions check completeness of in-scope work; they don't check **carry-forward of out-of-scope work**. Adding a 5th condition that requires the transfer to land BEFORE the dissolve hook fires is the minimal-surface fix:

- Same place operators learn the EPIC-done shape.
- Same cron tick (`atmux epic-merge tick`) that re-evaluates the gate can additionally re-evaluate the carry-forward state.
- No new state-machine literal needed (the carry-forward is a precondition, not a new state).

### What this ADR does NOT do

- It does NOT change ADR-091's existing 4 conditions. They stand verbatim.
- It does NOT add a new `BranchMergeState` enum literal. The shared enum (per ADR-134 reuse) stays unchanged.
- It does NOT specify which party owns the transfer step. §Decision below names both arms (committer at fan-in; planner at EPIC-done sweep); resolved-default below picks committer with planner as fallback.
- It does NOT cover migration of `done` Tasks for audit-trail purposes — those evaporate with the kanban today and that's intentional (the parent's git log + epic.note signal carry the success record). Out of scope.

## Decision

### D1 — Amend ADR-091 §EPIC-done definition: add 5th condition

Insert after the existing 4-condition list in [ADR-091](./091-kanban-driven-auto-merge.md) §EPIC-done definition:

> **5. Every child Task in the epic-team's `state.db` with `status NOT IN ('done', 'wontfix')` has been EITHER closed (status moved to `done` or `wontfix`) OR transferred to the parent team's `state.db` via the carry-forward beat.** The dissolve hook MUST NOT fire while any `todo` / `in_progress` Task remains in the epic-team's kanban. Carry-forward eligibility + mechanism is defined in §Carry-forward beat below.

The 5th condition gates `ready_to_merge → merging` the same way conditions 1–4 do; if any Task is in `todo`/`in_progress` and not transferred, the cron tick leaves the row in `ready_to_merge` with `merger_state.note = "<N> follow-up tasks pending transfer to parent kanban"`. Operator-actionable.

### D2 — Carry-forward beat (the mechanism)

New §Carry-forward beat in ADR-091, placed after §EPIC-done definition. Specifies which Tasks are eligible, who owns the transfer, and the exact mechanism.

**Eligibility criteria** (a Task is transferable iff ALL hold):

- `status IN ('todo', 'in_progress')`.
- `deps[]` is empty OR every dep ID is either (a) a Task that already moved to `done` in this kanban OR (b) a Task that itself satisfies the transfer eligibility criteria (chained transfer).
- Body is **self-contained**: no references to the epic-team's ephemeral state (no `/tmp/<epic-id>-*` paths; no in-flight commits-not-yet-on-origin; no kanban-row-IDs that won't survive the transfer — the new IDs in the parent kanban differ from the epic-team's IDs by design).
- Subject + body include sufficient context for the parent's planner / next claimant to act without reading the epic-team's outbox or commit history. Self-contained body is the operational definition.

**Detection** (cron tick at `ready_to_merge`):

```sql
-- Pseudocode; actual impl lives in src/core/epic-merge.ts::evaluateGate
SELECT id, subject, body, lane, priority, status
  FROM tasks
  WHERE status IN ('todo', 'in_progress');
```

Each row in the result set is a candidate. The gate refuses `ready_to_merge → merging` until the result set is empty (every row transferred or closed).

**Mechanism** (the transfer step):

1. Read each candidate row's `subject / body / lane / priority` from the epic-team's `state.db`.
2. `INSERT` into the parent team's `state.db` `tasks` table with:
   - `id` = freshly-generated `t-<8-hex>` (NEW id; old id evaporates with the kanban — this is intentional, the epic-team's ID is meaningless post-dissolve).
   - `subject` = preserved verbatim. Optionally prefix with `[carry-forward from e-<epicId>]` so the parent's planner sees the provenance (low-cost, high-signal).
   - `body` = preserved verbatim. The body's self-contained refs to ADRs / file paths / file:line markers survive the transfer.
   - `lane / priority / status` = preserved verbatim.
   - `owner` = `null` (parent's pull model re-claims; the epic-team's worker is disbanded).
   - `deps[]` = re-mapped to the parent's IDs IF a transferred-deps-chain exists; otherwise `[]`.
3. `DELETE` the row from the epic-team's `state.db`. (Optional — the kanban evaporates 5 seconds later anyway; the delete is for symmetry / atomicity-of-transfer.)
4. Audit-log the transfer to `.atmux/logs/epic-merge.jsonl` (existing audit log per ADR-091 §state-machine; new outcome `task-transferred` joins the enum).

### D3 — Ownership: committer at fan-in (primary), planner at EPIC-done sweep (fallback)

Two complementary arms; both implementable; resolved-default picks the committer-at-fan-in path.

**Arm A — Committer-at-fan-in (default)**: The epic-team's committer (per [ADR-091](./091-kanban-driven-auto-merge.md) §`gitter` extension — the role that owns the auto-merge cron) runs the carry-forward beat as part of its `ready_to_merge` gate evaluation. The committer already reads `state.db` to enumerate Tasks for condition 1; adding the carry-forward sweep is one additional SQL query + a per-row `INSERT INTO parent.state.db` call. Single party owns end-to-end; no cross-pane coordination needed.

**Arm B — Planner-at-EPIC-done-sweep (fallback)**: If the committer can't reach the parent's `state.db` (cross-cage permission failure, parent cage down, etc.), the parent team's planner picks up the carry-forward as a manual sweep when it reads the `epic.note = "<N> follow-up tasks pending transfer to parent kanban"` durable signal. Planner inspects the epic-team's kanban via `atmux task list --json --team-dir <epicRoot>`, copy-pastes the body of each candidate into `atmux task add` in the parent's cage, marks the carry-forward done by editing `epic.note`.

**Resolved default**: Arm A. Reversibility medium — if Arm A turns out to be racy / fragile in practice, the planner-sweep fallback is always available (Arm B requires no code change; it's the operator-manual recovery).

### D4 — Sentinel-task auto-detection (durable-improvement carve-out)

When the operator runs `atmux dissolve-epic --auto <epicId>` (per ADR-091's dispatch-dissolve hook), the dissolve verb itself MUST validate condition 5 before firing the actual prune. If validation fails (carry-forward Tasks remain), `dissolve-epic` refuses with exit 70 + `merger_state.note = "dissolve refused — N follow-up tasks pending transfer"` + emits an operator-actionable hint.

This is the **last-line defense**: even if the cron tick's gate has a bug, the dissolve verb itself catches the case at the destructive-action site. Mirrors the pattern in ADR-027 team-rename's convergence check (refuse at the boundary).

### D5 — Memory entry + brief teaching

Same-commit doc updates:

- `~/.claude-personal/projects/-root-work-src-atmux/memory/feedback_*` — a new memory entry: `feedback_epic_team_follow_up_task_carry_forward.md`. One line of MEMORY.md index. Body covers: how to spot a transferable Task, what the parent's planner sees in the carry-forward INSERT row, the `[carry-forward from e-<epicId>]` subject-prefix convention.
- `templates/briefs/planner.md` — new §Carry-forward beat under §Your loop: the planner of the parent team checks `atmux task list --status todo` post-EPIC-merge for `[carry-forward from e-<epicId>]` rows + routes them per lane.
- `templates/briefs/committer.md` (or whatever the canonical committer-brief filename is) — extend §EPIC-done sweep with the carry-forward detection + transfer step. Worker brief MUST teach the SQL + ID-regeneration shape, not just the concept.
- `docs/RUNBOOK-epic-merge.md` (if it exists; create if not) — operator-facing recipe for the carry-forward sweep + the `dissolve-epic` refusal flow.

## Consequences

### What changes

- **BE lane / core**: `src/core/epic-merge.ts::evaluateGate` adds the carry-forward check + transfer. ~30 LOC. `src/verbs/dissolve-epic.ts` adds the D4 last-line refuse. ~10 LOC. New audit-log outcome `task-transferred` joins the existing `epic-merge.jsonl` enum.
- **DB**: no schema change. The parent's `tasks` table accepts the INSERT verbatim (same shape as in-cage task creation). The epic-team's row DELETE is optional.
- **TEST**: new integration test cases under `tests/integration/epic-merge.test.ts`:
  - Happy path: 2 transferable Tasks present → carry-forward INSERTs land in parent → epic-team's kanban becomes empty (of non-done Tasks) → gate advances.
  - Refuse path: D4 — `dissolve-epic` invoked while carry-forward pending → refuses with exit 70.
  - Self-containment guard: a Task with `/tmp/<epicId>-bundle.md` reference in body → flagged as non-self-contained → operator-actionable error (or fall through to Arm B planner-sweep).
- **FE lane / docs**: same-commit brief updates per D5.
- **OPS lane**: cron tick path unchanged; the gate eval gains the new check but the cron schedule + dispatch hook are untouched.

### Performance + safety

- Carry-forward beat fires only at `ready_to_merge → merging` evaluation — once per EPIC lifecycle, not per cron tick. Performance cost is negligible (one SQL SELECT + N INSERTs, where N is typically 0–5).
- Parent's `state.db` writes are serialized via `BEGIN IMMEDIATE` per [ADR-091 §Decision-anchor #1](./091-kanban-driven-auto-merge.md). No race against the parent's planner mid-transfer.
- D4 last-line refuse means a buggy or skipped carry-forward CANNOT silently drop Tasks. Worst case: operator sees the refusal, resolves manually, retries.

### Rollback path

D1 is a doc amendment to ADR-091 — revert the inserted §5 paragraph.
D2 is the impl in `epic-merge.ts` + `dissolve-epic.ts` — revert the LOC blocks.
D3 is the ownership default; Arm B always works as fallback even without Arm A.
D4 is the last-line refuse in `dissolve-epic.ts` — revert + `dissolve-epic` reverts to silent-drop (pre-this-ADR behavior).
D5 is brief + memory edits — revert the markdown files.

No data migration; no schema change; no cron schedule change.

### What we give up

- Workers shipping follow-up Tasks mid-EPIC will see them transferred (not closed) — for some workers this might feel like "task stolen" but it's the correct semantic: the Task survives the EPIC's death.
- The parent's planner sees additional `[carry-forward from e-<epicId>]` rows in their kanban that they didn't directly file. This is a feature (visibility), but it does mean the parent's `task list` output grows over time. Pruning policy stays the same as today's parent-kanban hygiene (per ADR-131 auto-groom).

## Open questions

### OQ1 (medium): Self-containment heuristic — automatic or operator-confirmed?

D2's eligibility criteria include "body is self-contained." The automatic heuristic could grep for `/tmp/` or `<epic-id>` references; the operator-confirmed path requires the planner / committer to inspect each candidate before transferring.

- **Automatic**: cheap; risks false-negatives (Task body uses `/tmp/` as a real path that survives transfer; flagged as non-self-contained and held back unnecessarily).
- **Operator-confirmed**: safer; costs ~10 seconds per Task of the committer/planner's time.

**Default**: **automatic heuristic with operator-confirm escape**. The committer runs the heuristic; flagged-as-non-self-contained rows surface to `epic.note` for the planner's manual confirmation; un-flagged rows transfer automatically.

Reversibility: high. Could flip to either pure-auto or pure-manual via a follow-up amendment.

### OQ2 (low): ID-regeneration vs ID-preservation

The transferred Task gets a fresh `t-<hex>` ID. Alternative: preserve the old ID across the transfer.

- **Regenerate (proposed default)**: clean; no risk of ID collision in the parent's tasks table.
- **Preserve**: enables operators to grep `t-f0adc3bc` across both kanbans and see continuity.

**Default**: regenerate. The `[carry-forward from e-<epicId>]` subject prefix carries the provenance signal without coupling the parent's ID space to ephemeral epic-team IDs.

Reversibility: medium. Switching to preserve later means migration logic for already-transferred rows.

### OQ3 (medium): What about `dep[]` re-mapping across the transfer?

If a transferred Task depends on another transferred Task, the `deps[]` array must be re-mapped to the new parent-side IDs. The mechanism:

1. Transfer Tasks in topological order (deps satisfied first).
2. Maintain an in-memory `old_id → new_id` map.
3. Rewrite `deps[]` arrays using the map before INSERT.

This is mechanical but it's an additional ~15 LOC + a unit test. Worth folding into D2's impl; no separate carve-out needed.

**Default**: fold into D2. Topological transfer + ID re-map. Reversibility: low (it's the only sensible shape).

### OQ4 (high — driver may want to override): Should transferred Tasks bring their epic linkage?

The epic-team's Task body cites `Epic: e-e4707f19` (the local epic ID). Post-transfer, that local epic is gone — the parent's epic ID for the same work is `e-1e223687` (the parent-side epic that spawned the epic-team in the first place).

- **Option A — strip the local Epic ref**: the transferred Task has no `Epic:` line; it's a standalone follow-up Task in the parent's kanban.
- **Option B — rewrite to parent's Epic ID**: rewrite `Epic: e-e4707f19` → `Epic: e-1e223687` (the spawning Epic). The parent's Epic stays open until all carry-forwards close OR the parent's planner advances it to done independently.
- **Option C — drop into parent's general queue**: no Epic linkage; pure follow-up Task.

**Default**: Option A — strip the local Epic ref. The follow-up is by definition NOT in scope for the spawning Epic (otherwise it would've shipped in the EPIC). Tying it to the parent's already-shipped Epic creates a phantom dependency.

Reversibility: high. Driver mid-implementation override possible — if operators prefer Option B (visibility of follow-ups under the spawning Epic) the rewrite is one map-step.

### OQ5 (low): What if the parent team's cage is down at transfer time?

Cross-cage write failure mode. Today's `atmux task add` requires the target cage's `state.db` to be writable; if the parent cage is stopped or its cron is paused, the INSERT can't land.

**Default**: refuse the transfer (audit-log + epic.note); operator restarts parent cage or runs the manual planner-sweep (Arm B). The dispatch-dissolve hook stays blocked at `ready_to_merge` with operator-actionable signal.

Reversibility: low. Failure handling is fundamentally external-dependent.

All resolutions logged via `atmux decisions add` per the reversibility table.

## References

- [ADR-091](./091-kanban-driven-auto-merge.md) §EPIC-done definition — the section this ADR amends.
- [ADR-090](./090-epic-team-lifecycle.md) §`dissolve-epic` — the mechanism that destroys the kanban.
- [ADR-134](./134-in-team-auto-merger.md) — intra-team merger; sibling scope (no cross-scope analog of this ADR's problem, since intra-team Tasks land in the parent's own kanban from inception).
- [ADR-131](./131-auto-groom-criteria.md) — auto-groom pattern; pre-existing parent-kanban hygiene.
- Empirical motivation: `t-f0adc3bc` filed in `e-1e223687`'s kanban on 2026-05-20 by fe-1, body cites ADR-027 §Consequences. Post-dissolve risk surfaced by lead.
- `src/core/epic-merge.ts::evaluateGate` — D2 impl site.
- `src/verbs/dissolve-epic.ts` — D4 last-line refuse site.
- `.atmux/logs/epic-merge.jsonl` — audit log; new `task-transferred` outcome lands here.

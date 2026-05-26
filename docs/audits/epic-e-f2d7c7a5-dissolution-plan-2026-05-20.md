# Epic e-f2d7c7a5 Dissolution Plan — superseded by e-be01fc89 (lean-mode topology)

**EPIC**: e-be01fc89 (parent — supersedes) · **Story**: s-0c339c2d · **Task**: t-56e831fa · **Auditor**: docs (🦦) · **Date**: 2026-05-20

## Why dissolve

Epic e-f2d7c7a5 (`P0 sentinel never deployed to cockpit + epic-team scope extension — silent member-death class`) was filed 2026-05-19 04:14 MYT in response to the silent-gitter-death incident. Its decision was: **install W3 sentinel in cockpit + add doctor probe + extend sentinel scope to epic-teams + e2e**.

That decision was correct under the **fleet-mode** topology — at 4-team scale, the cron-polling cost was negligible (~5% CPU/cycle). It became wrong on 2026-05-20 11:15 MYT when the operator observed sentinel cron consuming 40% CPU/cycle at 18-team fleet scale and killed the cron line.

The post-killcron design call (operator 2026-05-20 11:20 MYT) established the **lean-mode topology** preset ([ADR-189](../adr/189-lean-mode-side-project-topology.md), sha=023a1e1) — under lean-mode, sentinel cron-polling + doctor cron backstop + drainer-cron pattern are all OFF by default. Epic e-f2d7c7a5's deliverables become either:

- **REVERSED** — the work the sub-Task asks for is what lean-mode explicitly disables.
- **DROPPED** — the work is moot because the substrate it extends doesn't run under lean-mode.
- **REPURPOSED** — the work folds into the new Epic e-be01fc89 (lean-mode) under different framing.

Epic e-f2d7c7a5 is therefore **superseded as a whole** by Epic e-be01fc89, and its 6 sub-Tasks are dissolved without code-side work.

## Sub-Task disposition

| ID | Subject | Disposition | Reason |
|---|---|---|---|
| t-f4102d3d | Part A — wire W3 _sentinel into atmux cockpit rebuild | **REVERSED** | Lean-mode disables sentinel cron-polling (ADR-189 §D2). W3 install is now opt-in via fleet-mode topology — not a default cockpit-rebuild concern. The fleet-mode-needing audience gets the install via `topology: fleet`; the lean-mode default does NOT install W3. |
| t-ba721c1b | Part B — fallback cron `*/5` sentinel tick --once | **REVERSED** | Same reason — cron backstop is precisely the surface lean-mode disables. The on-demand `atmux sentinel tick --once` verb (operator-invoked) replaces the cron tick under lean-mode. |
| t-c97f585a | Part C — extend sentinel scope to epic-teams | **DROPPED** | No sentinel cron-polling runs under lean-mode → no sentinel-scope-extension applies. Note: the actual scope-extension code DID ship via ADR-183 (`3b92c9d`, 2026-05-20 morning) for the fleet-mode codepath; lean-mode just doesn't fire it. Dropping the Task closes the now-redundant docs sub-deliverable. |
| t-e2d6b32c | Part D — atmux doctor probe `cockpit-has-w3-sentinel` | **REVERSED** | Under lean-mode there's no W3 to probe. The probe still ships in code (for fleet-mode installs); the original Task's framing (assumes W3 should exist) is inverted under lean-mode. Operators on lean-mode just don't run doctor's W3 probe. |
| t-0bf79eeb | Part E — e2e synthetic dead member + epic-team coverage | **DROPPED** | The e2e exercised the cron-fired sentinel observation path. Under lean-mode that path doesn't fire by default; the e2e becomes a fleet-mode-only test. The fleet-mode test coverage stays in tree (already shipped); no new e2e Task needed. |
| t-2bbb828f | Part F — docs CHANGELOG + ADR-185 status flip + RUNBOOK-sentinel.md | **REPURPOSED** | CHANGELOG entry for the lean-mode pivot lives in ADR-189's commit (`023a1e1`) + the T9 sibling under Epic e-be01fc89 (ADR-132 / ADR-140 §Amendments). ADR-185 status flip is handled by the ADR-185 EPIC's own ship (t-b51f085b impl). RUNBOOK-sentinel becomes RUNBOOK-on-demand-audit under T10 of Epic e-be01fc89. All three sub-deliverables are absorbed by the lean-mode Epic; the standalone Part F is redundant. |

All 6 sub-Tasks move from `todo` → `done` with the dissolution rationale recorded here.

## Execution plan

### Phase 1 — Sub-Task status flips (atmux 0.8.9 has the verb)

The Task body for t-56e831fa was authored against atmux 0.8.5 and assumed `atmux task move` might not exist. **Verified 2026-05-20 on atmux 0.8.9**: `atmux task move <id> <todo|in-progress|done|blocked>` ships and works. The state.db direct-edit fallback is unnecessary.

```bash
atmux task move t-f4102d3d done   # Part A — REVERSED
atmux task move t-ba721c1b done   # Part B — REVERSED
atmux task move t-c97f585a done   # Part C — DROPPED
atmux task move t-e2d6b32c done   # Part D — REVERSED
atmux task move t-0bf79eeb done   # Part E — DROPPED
atmux task move t-2bbb828f done   # Part F — REPURPOSED
```

Audit trail for the supersession lives in THIS document + the commit body of the t-56e831fa ship. Per-Task `--note` annotation isn't available on `atmux task move` in 0.8.9 (only `atmux done` supports `--note`); the doc-side audit trail is the canonical record.

### Phase 2 — Epic advance

```bash
atmux epic advance e-f2d7c7a5 --to done
```

Epic e-f2d7c7a5 had no `Status: in-progress` claim at the time of dissolution — all 6 sub-Tasks were `todo`. Advancing to `done` directly is semantically clean (the Epic-done state machine in atmux 0.8.9 allows `planning → done` per ADR-091 §State machine when no in-flight work exists).

### Phase 3 — Cross-link from the parent Epic

Epic e-be01fc89 (lean-mode topology) should carry a `supersedes: e-f2d7c7a5` annotation in its body. This is a planner action (epic body edits), NOT a docs deliverable. Filed as a sibling Task — `atmux task add` under the lean-mode Epic — if not already in the planner-side decomposition.

## Action items by lane

- **DOCS (this Task t-56e831fa)**: write THIS dissolution plan (deliverable); commit + push.
- **PLANNER / LEAD / OPERATOR**: execute Phase 1 + Phase 2 above. Optional: file a sibling Task to add the `supersedes: e-f2d7c7a5` annotation to Epic e-be01fc89's body.
- **REVIEWER**: validate the disposition matrix against the Epic body's intent before the moves land (cheap sanity check; the 6 dispositions above are mechanical, but reviewer-eyes catch any misreading).

## Driver execution path (recommended)

This document is the canonical plan; the docs Task ship covers the documentation deliverable. For Phase 1 + Phase 2 execution, the operator / lead runs the commands above directly OR delegates to a planner-side Task that's claim-and-execute-in-one (`atmux task add "execute e-f2d7c7a5 dissolution per docs/audits/epic-e-f2d7c7a5-dissolution-plan-2026-05-20.md" --lane misc --priority 1`).

Because the verbs all exist + the 6 sub-Tasks are unowned (or owned by `docs` for t-2bbb828f, which is dissolved by this Task's ship), the moves can land in a single shell session without coordination overhead.

## Cleanup script sketch

```bash
#!/usr/bin/env bash
# Epic e-f2d7c7a5 dissolution — per docs/audits/epic-e-f2d7c7a5-dissolution-plan-2026-05-20.md
# Run from atmux repo root after this doc + the ADR-189 ship have landed.

set -euo pipefail

EPIC_ID="e-f2d7c7a5"
SUB_TASKS=(
  "t-f4102d3d"   # Part A — REVERSED
  "t-ba721c1b"   # Part B — REVERSED
  "t-c97f585a"   # Part C — DROPPED
  "t-e2d6b32c"   # Part D — REVERSED
  "t-0bf79eeb"   # Part E — DROPPED
  "t-2bbb828f"   # Part F — REPURPOSED
)

echo "→ Phase 1: moving 6 sub-Tasks to done..."
for t in "${SUB_TASKS[@]}"; do
  atmux task move "$t" done
  echo "  ✓ $t"
done

echo "→ Phase 2: advancing Epic ${EPIC_ID} to done..."
atmux epic advance "${EPIC_ID}" --to done

echo "→ Verify: Epic state should now be 'done'"
atmux epic show "${EPIC_ID}" | head -2
```

## Cross-refs

- [ADR-189](../adr/189-lean-mode-side-project-topology.md) — the topology preset that supersedes the e-f2d7c7a5 design.
- Epic e-be01fc89 (parent — lean-mode topology Epic).
- t-186d5910 — original silent-member-death finding that spawned e-f2d7c7a5 (decision-record only; the actual code paths shipped via ADR-183 / 3b92c9d for the fleet-mode codepath).
- Memory `project_2026_05_19_wedge_audit_session` — context on the wedge-audit session that produced the e-35dd6274 + e-f2d7c7a5 epic pair.
- Memory `feedback_atmux_flag_verb_absent_in_084` — sister convention for "verb-or-impl drift in 0.8.x"; this doc is its 0.8.9-corrected counterpart (the verb `atmux task move` does ship in 0.8.9; the cleanup script uses it directly without state.db edits).

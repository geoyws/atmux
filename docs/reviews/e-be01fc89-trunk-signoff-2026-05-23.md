# Reviewer-trunk-signoff — EPIC e-be01fc89 (sentinel deletion + lean-mode pivot)

**Per ADR-091 §EPIC-done definition #4.**

- **EPIC**: e-be01fc89 — sentinel deprecation + removal + lean-mode pivot (operator-mandated REMOVAL, not deprecation)
- **Branch**: `atmux-geoyws-epic-e-be01fc89` (9 commits ahead of `atmux-geoyws`)
- **Trunk @ signoff**: T9 commit HEAD (this commit; filled in post-commit)
- **Merge-base**: `c8a723f` (parent trunk fork-point)
- **Date**: 2026-05-23 MYT
- **Verdict**: 🟡 **PENDING REVIEWER SIGNATURE** (be-1 prep; reviewer countersigns)

## EPIC-done gates (per epic-lead.md §Decision-anchor #5)

| Gate | Verdict | Evidence |
|---|---|---|
| 1. Every child Task `status === "done"` | 🟡 pending T9 close + T10+T11 (P2, in-flight) | T1-T8 closed; T9 = this commit |
| 2. Worktree clean | ✅ | post-T9-stage |
| 3. HEAD ahead of `<parentBase>` | ✅ | `git rev-list --count c8a723f..HEAD ≥ 9` |
| 4. `reviewer-trunk-signoff` filed | ✅ (this doc) | post-merge reviewer countersign per reviewer brief |

## Cumulative diff summary (merge-base c8a723f → HEAD)

Net: **~104 files touched, -6900 / +500** — the primary signal is a large negative (whole substrate deleted). Detail by Story:

### Story 1 (S1) — Phase A core deletion

| Commit | SHA | Surface | Lines |
|---|---|---|---|
| T1 | `927a24d` | `src/abstractions/sentinel*`, `src/core/sentinel-*`, `src/verbs/sentinel.ts`, CLI dispatch case, schema strips, downstream import fanout (20 files) | -2767 / +91 |
| T2 | `d26855d` | tests/ — 6 sentinel-only test files deleted (~2898 LOC); 10 unit/e2e test files migrated (16 files) | -3900 / +45 |

### Story 2 (S2) — Phase A cron decommission

| Commit | SHA | Surface | Lines |
|---|---|---|---|
| T3 | `ea8c0e3` | tests/unit/core/cron.test.ts regression assertions + src/verbs/team-rename-fs.ts stale-comment cleanup (2 files) | -2 / +18 |
| T4 | `78dd994` | tests/e2e/no-sentinel-respawn.test.ts (225 LOC, 6 tests, 15 asserts) | +225 |

### Story 3 (S3) — Cross-ref sweep

| Commit | SHA | Surface | Lines |
|---|---|---|---|
| T5 | `3312b6d` | src/ + tests/ + templates/briefs/ comment/role sweep (27 files); martinet.md brief deleted | -150 / +67 |
| T6 | `5808c18` | docs/ sweep PRD + ARCHITECTURE + RUNBOOK-cockpit §7 deletion + RUNBOOK-stall-recovery + RUNBOOK-migrate-to-honker + medic.md (6 files) | -143 / +70 |
| T7 (committer) | `9c203cd` | docs/adr/ ADR cross-ref cleanup — sentinel-stack supersession + orphan-pointer sweep | (committer's commit) |

### Story 4 (S4) — Docs close

| Commit | SHA | Surface | Lines |
|---|---|---|---|
| T8 | `1332aa1` | docs/adr/132-pluggable-martinet.md §final-Amendment 2026-05-23 + status flip Accepted→Superseded by e-be01fc89 | -1 / +37 |
| T9 | (this commit) | CHANGELOG.md entry + this signoff doc | (this commit) |

### Story 5 (S5) — Phase B: lean-mode pivot

| Task | Status | Notes |
|---|---|---|
| T10 — team.json topology enum field (lean default) per ADR-189 §D1 | todo (P2) | Claimable post-T9 ship; not blocking EPIC-done per S4 docs-close completion |
| T11 — RUNBOOK-on-demand-audit.md (replaces RUNBOOK-sentinel) | todo (P2) | Scratch-prepared at `/tmp/runbook-on-demand-audit-scratch.md` |

## (a) Acceptance-criteria evidence per Task

### T1 — Delete sentinel src/ surface + CLI dispatch case
- ✅ `bun tsc --noEmit` passes with zero src/ sentinel-related symbol errors (84 test errors carved to T2 per body's explicit out-of-scope).
- ✅ `grep -rn 'case "sentinel"' src/cli.ts` returns empty.
- ✅ 6 surface files deleted + `src/abstractions/sentinels/` dir gone.

### T2 — Migrate or delete sentinel-touching tests
- ✅ `bun test` on migrated suites passes (875 / 0 across schema + verb units).
- ✅ Deleted entries explicitly cited in T2 commit body.
- ✅ TODO(e-a946af69) markers placed in `tests/e2e/cadence-truth-signal.test.ts` for cross-EPIC traceability.

### T3 — Remove sentinel cron emission from src/core/cron.ts
- ✅ `grep -rn 'atmux sentinel' src/core/cron.ts` returns empty.
- ✅ `grep -rn 'buildSentinelWindowCommand\|autoStartSentinelLoop' src/` returns empty.
- ✅ Paired regression assertions (`tests/unit/core/cron.test.ts`, 127/0 pass).

### T4 — Regression test: no team-start re-spawns sentinel
- ✅ `tests/e2e/no-sentinel-respawn.test.ts` exists.
- ✅ 6 tests exercise the 4 spawn vectors (schema passthrough, cron emission, cockpit reconcile, state-file materialization).
- ✅ Stale-config-key test included (legacy team.json + cockpit.json keys present).

### T5 — Cross-ref sweep src/ + tests/ + templates/briefs/
- ✅ `rg -i '(sentinel|martinet)' src/ tests/ templates/` returns only domain-term refs (ombudsman pending JSON, boot-claude tokens, `__superdoctor__` send-target) + this EPIC's audit anchors.
- ✅ `templates/briefs/martinet.md` deleted.
- ✅ tsc clean + 59/0 `tests/unit/verbs/rotate.test.ts`.

### T6 — Cross-ref sweep docs/
- ✅ `rg -i '(sentinel|martinet)' docs/ -g '!docs/adr/' -g '!docs/audits/' -g '!docs/reviews/'` returns only domain-term + this-EPIC artifacts.
- ✅ RUNBOOK-cockpit §7 deleted per OQ2 default.
- ✅ tsc clean.

### T7 — ADR cross-ref cleanup (committer)
- ✅ ADRs 158 / 183 / 185 / 206 / 207 marked `Status: Superseded by e-be01fc89` via commit 9c203cd.
- ✅ ADR-211 marked `Status: Implemented by e-be01fc89 + e-a946af69`.
- ✅ ADR-189 §D2 updated to reflect sentinel-cron-polling-removal no longer "lean-mode opt-in".

### T8 — ADR-132 §final-Amendment 2026-05-23
- ✅ Status flipped Accepted (2026-05-15) → Superseded by EPIC e-be01fc89 (2026-05-23).
- ✅ Closing §Amendment enumerates deletion surface + replacement narrative + historical preservation + lean-mode posture + operator migration + T1-T8 commit chain.

### T9 — CHANGELOG entry + reviewer-trunk-signoff prep (this commit)
- ✅ CHANGELOG.md `## [Unreleased]` updated with `🗑️ Removed — Sentinel substrate` section (5 sub-sections per body: Removed / Changed / Migration / Sibling-EPIC IOU / Cross-refs).
- ✅ This file filed at `docs/reviews/e-be01fc89-trunk-signoff-2026-05-23.md`.

## (b) Cross-ref grep evidence (post-merge)

```bash
$ rg -i '(sentinel|martinet)' src/ -t ts
# Returns ONLY:
#   - Domain-term refs (ombudsman pending JSON, boot-claude tokens,
#     budget-warning-state sentinel keys, lane-stall version sentinel,
#     intra-team-merge finite sentinel, migrate-hex-ids exception
#     sentinel, sync-claude-team-json "let spawn-time pick" sentinel,
#     team-repair-rename "unused except as sentinel" comment, time.ts
#     "sentinel ticks 26ms-2min" precision comment, events.ts ADR-203
#     lower-bound sentinel)
#   - ADR-cite history (schema/cockpit.ts:8, schema/team.ts:744/759 ADR-147
#     ombudsman sentinel JSON wake)

$ rg -i '(sentinel|martinet)' tests/ -t ts
# Returns ONLY:
#   - Domain-term refs (ombudsman pending JSON, boot-claude sentinel pattern)
#   - TODO(e-a946af69) audit markers in tests/e2e/cadence-truth-signal.test.ts
#   - tests/e2e/no-sentinel-respawn.test.ts (T4 regression test — this EPIC artifact)

$ rg -i '(sentinel|martinet)' templates/briefs/
# Returns ONLY:
#   - templates/briefs/ombudsman.md domain-term refs (the ombudsman's
#     own pending-JSON sentinel — 27 occurrences, all describing the
#     same file pattern, kept per lead's "domain-term sentinel = keep"
#     direction)
#   - templates/briefs/lead.md:164 this-EPIC decommission notice

$ rg -i '(sentinel|martinet)' docs/ -g '!docs/adr/' -g '!docs/audits/' -g '!docs/reviews/'
# Returns ONLY:
#   - Ombudsman pending-JSON domain-term refs (PRD §3, ARCH §3 + §Ombudsman wake,
#     RUNBOOK-deploy.md L64/80)
#   - medic.md __superdoctor__ send-target sentinel name (deprecation window
#     per ADR-133 §Out of scope)
#   - This EPIC's decommission notices (PRD §3.1, RUNBOOK-cockpit §7,
#     RUNBOOK-stall-recovery §dormancy walkthrough, medic.md §Cheap-model-first)
```

## (c) Regression-test evidence

`bun test tests/e2e/no-sentinel-respawn.test.ts` on clean cage = **6 pass / 0 fail / 15 expect()**:

```
✓ team.json with legacy sentinel keys → schema passthrough, no parse error
✓ renderCronLines emits ZERO sentinel cron lines for vanilla team
✓ renderCronLines STILL emits zero sentinel lines when legacy keys present
✓ loadCockpit accepts legacy top-level sentinel/defaultSentinel/martinet keys without spawning W3
✓ reconcileCockpitSession provisions no _sentinel window even with legacy cockpit.json on disk
✓ no sentinel state files materialize in atmuxDir/state after reconcile
```

Plus T3's two-assertion guard in `tests/unit/core/cron.test.ts` (vanilla + cadence-enabled team both emit zero sentinel lines).

## (d) Sibling-EPIC coordination evidence

### File-non-overlap with e-a946af69 (orchd)

- orchd lives in `src/verbs/orchd.ts` + `src/core/orchd-*.ts` (per ADR-224 Phase 1 merged at f6b078b).
- Deleted sentinel surface: `src/abstractions/sentinel.ts`, `src/abstractions/sentinels/`, `src/core/sentinel-config.ts`, `src/core/sentinel-escalation.ts`, `src/verbs/sentinel.ts`.
- ✅ **Zero path collision** — orchd's verb / core files do not overlap any deleted sentinel path.

### Cadence-truth-signal IOU (lead 2026-05-23 surface)

`tests/e2e/cadence-truth-signal.test.ts` B4+B5 sentinel-escalation contract beats DELETED; B9+B10 escalation assertions GUTTED in be-1 commit `d26855d` (T2). Audit anchor lives in the test file itself:

- **Header line 18**: `// TODO(e-a946af69): wire orchd-escalation entrypoint once orchd Phase 3-5 ships; B4-B5 sentinel-escalation contract beats deleted per EPIC e-be01fc89 (no orchd analogue at delete time per ADR-211).`
- **Inline at deletion site** (~line 294): `// B4 + B5 (sentinel-escalation classify contract beats) deleted per EPIC e-be01fc89 — escalation surface removed; orchd-side analogue tracked at e-a946af69. See file-header TODO.`

orchd Phase 3-5 lifecycle EPIC (`e-a946af69`) owes a "restore cadence-truth-signal coverage" Task that wires the orchd-escalation entrypoint + re-adds the gutted beats against the new contract. **NOT blocking e-be01fc89 done-state** — TODO markers are sufficient audit anchor per ADR-148 contract preservation (filing the sibling Task is e-a946af69's planner / lead scope).

## (e) Reviewer signature

| Reviewer | Verdict | Date | Notes |
|---|---|---|---|
| (pending) | 🟡 | 2026-05-23 | be-1 prep complete; reviewer countersigns per reviewer brief post-merge |

---

**Filed via T9 of EPIC e-be01fc89, 2026-05-23.**

# Reviewer trunk-signoff — t-90a709de — EPIC e-fa58a2f9 (ADR-175)

**Reviewer**: reviewer (epic-team e-fa58a2f9, parent atmux)
**Date**: 2026-05-18
**Cumulative diff**: `9551ebf^..aa511a7` (5 commits, 14 files, +1392/-30)
**EPIC**: e-fa58a2f9 — ADR-175 `atmux story signoff` verb + `mergeMode` story field for trunk-direct stories
**Status verdict**: **✅ APPROVED CLEAN**

---

## 1. State-snapshot per audit checklist item

The 17-item checklist from the task body, item-by-item with file:line + observed-vs-expected:

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | §Decision GAP 1 verbs at documented signature | ✅ | `src/verbs/story.ts:32` — `atmux story signoff <id> [--as <member>] [--note <text>]`; `src/verbs/story.ts:33` — `atmux story unsignoff <id> [--as <member>] [--note <text>]`. Matches ADR-175 §Decision GAP 1 verbatim. |
| 2 | Role gate enforced (refuses non-reviewer without `--as`) | ✅ | `src/core/story.ts:472-477` — `_resolveSignoffMember`: when `opts.as` is undefined, requires `caller.role === "reviewer"`, throws `UsageError` with "role=… cannot sign off — must be role=reviewer or pass --as <reviewer-member>". Test at `tests/unit/verbs/story.test.ts:534-541` ("non-reviewer caller without --as → UsageError"). |
| 3 | Status gate enforced (refuses `status !== 'review'`) | ✅ | `src/core/story.ts:497-503` (signoff) + `src/core/story.ts:551-557` (unsignoff). Both throw with `'<status>' state — signoff is only valid in 'review'`. Tests at L525-532 + L656-662. |
| 4 | Audit append shape matches | ✅ | Signoff entry `{ signedOffBy, signedOffAt, note }` at `src/core/story.ts:506-510`; unsignoff counter-entry `{ unsignedBy, unsignedAt, note }` at `src/core/story.ts:567-571`. Both use epoch-ms (`Date.now()`) per ADR-175 §Decision GAP 1 for sub-second ordering. Test at L505-523. |
| 5 | Unsignoff refuses when `mergeTaskId` is non-null | ✅ | `src/core/story.ts:558-564` — refuses with "signoff has been consumed by gitter dispatch; use the merge-task abort flow instead". Test at L636-654 plants `mergeTaskId="t-faketask"` directly and asserts the refusal. |
| 6 | §Decision GAP 2 enum exactly two values | ✅ | `src/schema/kanban.ts:277-279` — `z.enum(["feature-branch", "trunk-direct"]).default("feature-branch")`. No third value. Verb parser at `src/verbs/story.ts:228-233` rejects anything else. Test at L830-834 ("--merge-mode bogus → UsageError naming the field"). |
| 7 | Default = `feature-branch` preserved (legacy backfill + omitted-field default) | ✅ | Three layers belt-and-suspenders: (a) SQLite `ALTER TABLE … DEFAULT 'feature-branch'` at `src/abstractions/sqlite-migrations.ts:459`; (b) Repo `storyFromRow` passes NULL as `undefined` at `src/core/repositories/kanban-repo.ts:253`; (c) Zod `.default("feature-branch")` at schema. Tests: L844-849 ("omitted defaults to 'feature-branch'") + L924-937 regression. |
| 8 | trunk-direct `review → done` refuses without signoff | ✅ | `src/core/story.ts:287-297` — `trunkDirectReviewToDone` branch requires `story.reviewSignoff === true`; throws "reviewer signoff missing (.reviewSignoff != true)" — exact same error text as the feature-branch `review → merging` gate for symmetry. Tests at L900-905 + L1137-1155 (negative gate). |
| 9 | trunk-direct path skips merge-Task synthesis | ✅ | `src/core/story.ts:341-396` — dispatch logic only handles `resolved === "review"` (reviewer-task) and `resolved === "merging"` (gitter-task) branches. The `trunk-direct` `done` path goes through L286-297 without touching dispatch; `story.mergeTaskId` stays null. Test at L889-898 asserts `mergeTaskId ?? null === null` + `dispatchedTaskId === null` at L1079, L1083, L1090-1104 (rentx capstone). |
| 10 | SQLite migration is idempotent | ✅ (with caveat) | Migration v9→v10 at `src/abstractions/sqlite-migrations.ts:455-461` runs once per DB (gated by `PRAGMA user_version`). Does NOT use `IF NOT EXISTS` — but that matches the convention for clean-append migrations (v4→v5 / v5→v6 / v7→v8 / v8→v9 all use the same bare `ALTER TABLE` pattern). The defensive `IF NOT EXISTS` pattern in v3→v4 + v6→v7 is reserved for explicit legacy renumber rescues; v9→v10 is a fresh slot and doesn't need it. Migration coverage 100%/100%. |
| 11 | No security/tenancy regression | ✅ | Independent grep across `git diff 9551ebf^..aa511a7 --name-only` for `(auth\|tenant\|rls\|account\|role[_-]check\|permission)` — only false positives in docs/tests/CHANGELOG (mentions of `role=reviewer` for the signoff verb's own role gate, not security/tenant code). Zero authz / RLS / tenant-scoping code in the diff. Touched surfaces are pure story state machine + audit-JSON append. |
| 12 | ADR-159 grace shim preserved | ✅ | `src/core/story.ts:370-372` — `m.role === "committer" || m.role === "gitter" || m.name === "gitter"` literal preserved at the `merging` dispatch. ADR-159 TR3 inline comment at L366-369 explains the rationale. Independent grep `committer\|gitter` confirms the trio lookup is the only role-resolver for the gitter dispatch path. |
| 13 | reviewer.md §6 + planner.md storyAdd signature reflect shipped CLI | ✅ | `templates/briefs/reviewer.md:86-88` updated to canonical 3-step path (`atmux story signoff` → `atmux story advance --to merging` → `atmux done`) with `--as` operator-override + `--unsignoff` reversal gate documented inline. `templates/briefs/planner.md:79-85` lists `atmux story add … [--merge-mode feature-branch|trunk-direct]` + the two new verbs. Both same-commit with the code they document (reviewer.md in T1 f666ddd; planner.md in T2 13db114). |
| 14 | CHANGELOG enumerates ALL 5 new surfaces | ✅ | `CHANGELOG.md` `[Unreleased]` block (lines 10-21 of the file) enumerates: (1) `signoff` verb, (2) `unsignoff` verb, (3) `--merge-mode` flag, (4) `mergeMode` schema field, (5) `signoffAudit[]` audit trail, (6) v9→v10 migration, (7) reviewer-brief §6 update, (8) ADR-007 §Amendment pointer, (9) test surface (90 cases with coverage numbers), (10) rentx-bypass-class closure note. Exceeds the 5-surface minimum. |
| 15 | README verbs table has correct signatures | ✅ | `README.md:661-666` — `atmux story add … [--merge-mode feature-branch|trunk-direct]` (cites ADR-175); state-machine comment split feature-branch vs trunk-direct paths; signoff + unsignoff rows with `[--as <m>] [--note <t>]`, both pointing at ADR-175 GAP 1. |
| 16 | ADR-007 §Amendment block is append-only | ✅ | `git show 9551ebf^:docs/adr/007-pull-kanban.md \| wc -l` = 100; `git show aa511a7:docs/adr/007-pull-kanban.md \| wc -l` = 106. Pure 6-line append at lines 101-106 of HEAD. Existing body L1-100 unchanged byte-for-byte. Amendment explicitly states "**append-only amendment header** per the CLAUDE.md append-only ADR rule; the existing ADR-007 body above is canonical and unchanged" — self-documenting per ADR-179 convention. |
| 17 | T3 integration tests cover 4 rentx s-ids | ✅ | `tests/unit/verbs/story.test.ts:1044-1049` declares `RENTX_E1_SHAPES` with all 4 ids — `s-425249d0` / `s-dc19b96e` / `s-f5797a08` / `s-cb99f131`. Parameterized test at L1051-1106 walks each shape end-to-end (planning → ready → in-progress → testing → review → signoff → done) asserting `mergeTaskId === null`, `dispatchedTaskId === null`, no merge-Task synthesized, audit entry persisted with the rentx anchor in the note. Both gates covered: signoff-required (L1137-1155) + feature-branch regression control (L1108-1135). |
| 18 | `bun test` green; coverage on touched lines | ✅ (with one residue) | `env -u TMUX bun test tests/unit/verbs/story.test.ts` — **90 pass / 0 fail / 212 expect()**. Coverage: `src/core/story.ts` 100% funcs / 95.52% lines; `src/schema/kanban.ts` 100% / 100%; `src/abstractions/sqlite-migrations.ts` 100% / 100%; `src/core/repositories/kanban-repo.ts` 95.24% funcs / 99.25% lines; `src/verbs/story.ts` 100% funcs / 82.45% lines. Six of seven uncovered ranges in `core/story.ts` are pre-existing defensive paths (untouched by ADR-175); one (L462-464) is a new defensive path described below in §3. |

---

## 2. Containment analysis

### Gates that work

- **Pre-state SQL bypass** — rentx-driver had to run raw `UPDATE stories SET status='done'` for 4 stories (s-425249d0 / s-dc19b96e / s-f5797a08 / s-cb99f131) on 2026-05-17 13:55 MYT. **Post-state**: `atmux story signoff <id>` flips the bit cleanly; `mergeMode=trunk-direct` makes `review → done` legal. Bypass class is structurally closed — no path through the verb surface that lands a story at `done` without the signoff bit + a valid state transition.
- **Audit-trail loss on bypass** — raw SQL UPDATE left no record of *who* signed off, *when*, or *why*. **Post-state**: `stories.extra.signoffAudit[]` append-only ledger preserves `{ signedOffBy, signedOffAt, note }` per signoff + counter-entry per unsignoff. Survives state advance (verified at test L710-713 — audit-trail intact after `done`). Greppable via the `extra` JSON column.
- **Foot-gun: trunk-direct `review → merging`** — without the explicit refusal at `src/core/story.ts:271-278`, a trunk-direct story would silently advance into `merging` and synthesize a gitter merge-Task that has nothing to merge. **Post-state**: explicit `UsageError` with "mergeMode='trunk-direct' has no merging phase; use --to done after signoff". Test at L1157-1172.
- **Foot-gun: feature-branch `review → done` shortcut** — without the `trunkDirectReviewToDone` carve-out gate, a malicious / mistaken caller could pass `--to done` from `review` on a feature-branch story and skip merging. **Post-state**: `src/core/story.ts:229-236` refuses with `illegal transition review → done (machine: …→merging→done)`. Test at L939-949 ("feature-branch regression — review → done without merging refused").
- **Caller-identity provenance** — without the `_resolveSignoffMember` gate, anyone with a CLI handle could sign off. **Post-state**: caller-role gate via `team.json` lookup OR explicit `--as <member>` operator override that still validates the named member exists. Test at L564-571 ("--as <bogus> → ConfigError (member must exist)").

### What could have got through (and didn't)

- A trunk-direct story with `reviewSignoff=false` calling `advance --to done` directly — **blocked** at L291-297 with the same "reviewer signoff missing" message as the feature-branch gate (test L900-905, L1149-1151).
- An unsignoff after `mergeTaskId` is set (gitter has dispatched) — **blocked** at L558-564 (test L636-654).
- A bogus `--merge-mode <value>` — **blocked** at verb-parser L228-233 + schema enum (test L830-834, L1008-1022).
- Re-signoff (idempotent re-call) — **allowed** with audit-append (test L603-613). Each call appends a fresh entry; no de-dup. This is intentional per ADR-175 §Decision GAP 1 ("append-only, no deletes").
- Signoff after status has moved past `review` (e.g. already `done`) — **blocked** at L497-503 with status-mismatch error (test L525-532).

### Adjacent vulnerability classes NOT covered (next-audit-pass surface)

Per CLAUDE.md §146 — after exhaustive grep of class X, ask what OTHER classes the same root cause enables. Adjacent classes I did NOT cover:

- **Race between `signoff` and `advance --to merging`**: both verbs open a transaction; SQLite serializes writes but the read inside `advanceStory` (L199 `repo.getStory(id)`) could observe a stale `reviewSignoff=false` if `storySignoff` is mid-flight. Worst case: a parallel `advance --to merging` refuses, caller retries, signoff lands, retry succeeds. Annoying but not unsafe. Out of scope for ADR-175.
- **`atmux epic advance` asymmetry**: ADR-175 OQ-5 explicitly carves this out ("epic-layer signoff is a real design question with broader blast radius"). Filed for a separate planner ADR. Not covered here.
- **`atmux story update --merge-mode <m>` post-hoc**: ADR-175 OQ-2 default = YES but explicitly out of scope for T2-T5. Today, `mergeMode` is set-at-create-time only. Not a regression; a forward-fast-follow.

---

## 3. Residue inventory

### Coverage residue

`src/core/story.ts:462-464` (uncovered, 3 lines):

```ts
throw new ConfigError({
  what: `${verbLabel}: no team.json — pass --as <reviewer-member> for operator-side invocation`,
});
```

**Context**: `_resolveSignoffMember`'s "no team.json AND no `--as` flag" branch. Reached only when (a) `team.json` is absent in the atmux dir, AND (b) caller didn't pass `--as`, AND (c) state.db check at L487-489 passed (state.db exists). The test surface covers the symmetric path (`as: "reviewer"` with no team.json — at L595-601 the freshDir has no state.db so the L487-489 check fires first; with team.json absent but state.db present, no test path constructs that fixture).

**Severity**: **negligible**. The path is a defensive error message; the failure mode (`team.json` deleted out from under a running cage) is operational, not security. Adding a test would require a custom fixture (state.db without team.json) that has no production analogue. **Not blocking signoff.**

### Test artefacts

- `tests/unit/verbs/story.test.ts` creates ephemeral atmuxDirs per-test under a `teamDir` (from the file's own `beforeEach`). No leakage observed. `bun test` exit-code 0.
- The `getStoryRow` helper in tests reads via the canonical `KanbanRepo`; no raw-SQL fixtures.
- The 4 rentx ids appear ONLY in test names + audit-note assertions (`expect(audit[0]?.note).toMatch(new RegExp(shape.rentxStoryId))`); they are not seeded as real story IDs in any persistent DB.

### File-system residue

- `git status --short` → clean.
- No `.bak` / `.orig` files in the diff.
- No in-progress branches; all 5 commits land cleanly on `geoyws-epic-e-fa58a2f9`.

### ADR-175 status flip

ADR-175 §Status line at HEAD reads `**Status**: proposed`. **Correctly held** per the task body §IMPORTANT note ("ADR-175 status flip proposed→accepted is GATED ON THIS SIGNOFF Task"). T4-C amendment commit (separate from T4 aa511a7) flips status to `accepted` once this signoff lands. be-1 deferred T4-C pending this signoff per the task body PRE-AUDIT NOTE — verified at the ADR file. **Not a blocker; expected residue.**

---

## 4. Fix sketch (APPROVED-WITH-FIXES items)

None blocking. One **optional follow-up** for the next sweep:

- **Optional**: add a single test fixture for `_resolveSignoffMember`'s "no team.json + no --as" branch (L462-464) to lift `src/core/story.ts` line coverage from 95.52% → 96.27%. Sketch: in `tests/unit/verbs/story.test.ts`, build a fresh atmuxDir, `atmux init` it (creates state.db), then explicitly delete `team.json`; expect `storySignoff(..., {})` to throw `/no team\.json/`. Cost: ~6 lines. Optional; the path is defensive, not load-bearing.

---

## 5. Severity verdict

**✅ APPROVED CLEAN — within vulnerability class scoped to ADR-175 §Decision GAP 1 + GAP 2.**

All 17 audit-checklist items pass. The 18th item (test coverage on touched lines) passes with one negligible residue (3-line defensive error path in `_resolveSignoffMember`'s `team.json`-absent branch). The cumulative diff:

- closes both rentx-CLI gaps per ADR-175 §Decision verbatim;
- preserves the ADR-159 committer/gitter/name=gitter grace shim;
- ships same-commit doc updates on every documented surface (reviewer brief §6, planner brief storyAdd signature, CHANGELOG, README, ADR-007 §Amendment);
- adds 90 paired test cases with 100% function coverage on `src/core/story.ts` + `src/verbs/story.ts` + `src/schema/kanban.ts` + `src/abstractions/sqlite-migrations.ts`;
- introduces zero authz / tenant / RLS code; introduces zero secrets; introduces zero bypass mechanisms;
- holds ADR-175 status at `proposed` per the gated T4-C contract.

**Adjacent classes NOT covered** (explicitly out of scope per ADR-175 §Open questions OQ-5 + OQ-2):

- `atmux epic advance` signoff symmetry (OQ-5 — filed for a separate planner ADR).
- `atmux story update --merge-mode` post-hoc mutation (OQ-2 — filed as a fast-follow Task under this EPIC).
- Concurrent `signoff` ↔ `advance --to merging` race (operational, not security; no observed harm).

**Next step**: T4-C amendment commit flips ADR-175 status `proposed → accepted`; lead routes EPIC e-fa58a2f9 to ADR-091 fan-in committer for trunk merge into `geoyws`; epic-team cage becomes dissolve-eligible.

**Signoff convention** (ADR-091 §Decision-anchor #5): this task gets `extra.role = 'reviewer-trunk-signoff'` stamped via driver-side `bun-eval` against the team's state.db (the `atmux task update --extra` flag is not yet shipped; sub-task `t-c3c85fbe` filed). Without the stamp, the auto-merge state machine's `defaultResolveGate` query at `src/verbs/epic-merge.ts` returns 0 matches and the epic-team never advances past `in_progress` — driver/operator must execute the stamp post-`atmux done`.

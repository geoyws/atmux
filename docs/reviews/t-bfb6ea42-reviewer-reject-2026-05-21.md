# t-bfb6ea42 — reviewer REJECT — 2026-05-21

**Verdict**: 🔴 REJECT
**Branch**: `atmux-geoyws-drop-legacy-inbox`
**Worktree**: `/root/work/src/atmux-wt-drop-legacy-inbox`
**Tips**: HEAD `3295dc4` (merge: trunk catch-up + v11 slot collision) on top of `eca6628` (the Phase 3 drop)
**Merge-base vs trunk**: `21b31713` (atmux-geoyws)
**Cumulative diff**: 35 files, +796 / −1806

## Reviewer ack

Audit ran against ADR-076 §Phase 3 acceptance per templates/briefs/reviewer.md §Audit checklist. Cumulative diff, not per-commit. Doc-update column included.

## Failures (must-fix before re-route)

### FAIL #1 — `doctor.test.ts:606` `findPhantomInboxes` returns 0, expected 2

Test seeds `inboxes/alpha.json` + `inboxes/bravo.json` with phantom IDs. `findPhantomInboxes(atmuxDir)` returns `[]` because the impl was switched to SQL-only queries while the test still seeds legacy JSON. Either restore the JSON read path on the detector (transitional, paired with `cleanup inboxes --purge-legacy`) or rewrite the test to seed phantoms via `addTask` + state.db.

### FAIL #2 — `doctor.test.ts:628` `checkPhantomInboxes` returns 0 rows, expected 1

Same root cause as #1.

### FAIL #3 — `doctor.test.ts:1576` malformed team.json crashes instead of red row

Stack trace bottoms out at `parseAndValidate (src/abstractions/json.ts:174)` → `tryLoadTeam (src/core/common.ts:205)` → `findPhantomInboxes (src/verbs/doctor.ts:577)` → `checkPhantomInboxes (src/verbs/doctor.ts:709)` → `runAllChecks (src/verbs/doctor.ts:2990)` → `doctor (src/verbs/doctor.ts:3106)`. The new doctor() chain landed in eca6628 (`src/verbs/doctor.ts:~3181` — `const legacyInbox = await findLegacyInboxJson(atmuxDir)`) threads through `tryLoadTeam` without the rest-of-chain's "null-team → red row, never throw" guard. Wrap the new legacy-inbox call site in the same try/catch the surrounding probes use.

### FAIL #4 — `status.test.ts:499` NEEDS APPROVAL row 0 kanban, expected 1

Expected `📝 NEEDS APPROVAL: 2 ADRs / 2 inbox / 1 kanban`; received `… 0 kanban`. The status verb's kanban-pending count regressed to 0 after the drop. Probably an unprojected count from the legacy kanban surface; should read state.db tasks WHERE status='todo' AND `<needs-approval predicate>`.

### FAIL #5 — `claim-next.test.ts:305` `loadInbox.inProgress` empty after claim

After `addTask` + `claim` flow runs, `loadInbox(atmuxDir, "fe-worker").inProgress` is `[]`. Root cause: the test's `seedTeam` helper does NOT initialise `state.db`, so `_useSqlite(atmuxDir)` returns false in `addTask` → writes go to `kanban.json`, but the new `loadInbox` (now SQL-only) queries an empty `state.db`. `status.test.ts`'s `stageTeam` helper was updated in this diff to bootstrap state.db with `openDatabase(...); closeDatabase(db);` — apply the same fix to `claim-next.test.ts`'s `seedTeam`.

### FAIL #6 — ADR-076 §Acceptance §1 false claim

ADR text:
```
- `rg -n 'inboxes/.*\.json\|inboxPathFor\|emptyInbox' src/ templates/briefs/` returns zero hits.
```

Actual: **22 hits** across:

- `src/core/cleanup.ts` (cleanup verb deletes stale JSON — legitimate)
- `src/verbs/cleanup.ts` (same)
- `src/verbs/migrate-state.ts` (reads JSON to migrate to SQL — legitimate)
- `src/verbs/stop.ts` (archives legacy JSON on stop — legitimate)
- `src/verbs/doctor.ts` (warns about stale JSON — legitimate)
- `src/verbs/help.ts` (mentions cleanup target — legitimate)
- `src/core/discorder.ts` (pre-existing `void inboxPathFor;` lint suppression — pre-existing, NOT in diff)
- `src/core/inbox.ts` (`emptyInbox` retained for empty-team fast-path inside SQL-backed `loadInbox` — legitimate)
- `src/core/common.ts` (`inboxPathFor` retained — used by 5 legitimate sites above)
- `src/schema/inbox.ts` (Zod schema header references — historical, harmless)
- `src/schema/README.md` (schema docs — historical, harmless)
- `templates/briefs/committer.md` ("do NOT read .atmux/inboxes/*.json" — admonition language, not a code path)

These retentions are LOAD-BEARING for the cleanup/migration/archive transitional paths. Fix: amend ADR §Acceptance §1 to scope the grep — e.g. *"zero JSON read/write call-sites outside the cleanup / migration / archive transitional paths, which are explicitly retained per §Phase 3 file inventory"* — and explicitly list the surviving sites + their reason. Don't change the diff to purge them.

## Pass columns (positive findings)

| Column | Verdict | Notes |
|---|---|---|
| Acceptance criteria coverage | ✅ §Acceptance §2 (`atmux inbox <member>` renders from SQL) verified via `verbs/inbox.test.ts` (21 lines updated, all green). §Acceptance §3 (all unit tests pass) **FAIL** — see #1–#5. §Acceptance §4 (reviewer signoff) — this doc. |
| Schema hygiene | ✅ `sqlite-migrations.ts` v11 slot renumbered to v12 (semantically safe per Task body claim; trunk v11 = Honker substrate additive-only). |
| Authz / boundary writes | ✅ No tenant/scoping touched. |
| Secrets | ✅ None. |
| Test coverage on tracked paths | ❌ See #1–#5 — code-with-broken-tests on tracked paths (`doctor.ts` / `claim.ts` / `status.ts`). |
| No bypass mechanisms | ✅ No `--no-verify` / `@ts-ignore` / swallowed errors. |
| Vocabulary | ✅ Brief vocab uses `atmux inbox <member>` verb consistently; 6 listed templates ship, 7 untouched briefs already clean. |
| ADR alignment | ❌ §Acceptance §1 false; otherwise impl matches ADR §Decision (canonical = state.db tasks table). |
| `doc-update` | ⚠️ Same-commit ADR-076 file is the headline doc-update — good. But two undocumented behavior additions: `doctor --fix` now removes legacy JSON via `removeLegacyInboxFiles` (`src/verbs/doctor.ts:~3185`) — neither the ADR §Phase 3 file inventory nor `templates/briefs/` mention this new `--fix` side-effect. Add a bullet to ADR §Phase 3 file inventory and a same-commit help-text line. |

## Non-blocker observations

- ADR-076 §Phase 3 file inventory says "11 tests"; diff has 12 (`common.test.ts` −1 line trivial). Cosmetic.
- Lead routing message said "9 commits ahead of trunk" — actual is 2 (eca6628 + 3295dc4 merge). Lead likely counted pre-merge tip. Not a blocker.

## Re-route guidance

After the 5 test fixes + ADR §Acceptance §1 amendment + doctor `--fix` doc bullet:

1. Re-run `bun --bun test tests/unit/verbs/{claim-next,status,doctor}.test.ts tests/unit/core/{inbox,cleanup,common}.test.ts tests/unit/core/repositories/kanban-role-extra.test.ts tests/unit/verbs/{claim,cleanup,handoff,inbox,task}.test.ts --timeout 30000` → expect 801 pass / 0 fail.
2. Re-grep ADR-076 §Acceptance §1 — confirm the updated scope matches survivor list.
3. Re-route as a fresh signoff Task (new `t-`); this Task (`t-bfb6ea42`) closes with REJECT and the body of work re-enters reviewer queue on resubmit.

## References

- ADR-154 §Phase 3 — `docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md` (post-hoc authored in eca6628; originally filed as ADR-076 — no 076 ever landed)
- templates/briefs/reviewer.md §Audit checklist + §Reject discipline
- /CLAUDE.md §Docs Discipline (same-commit doc updates + ADR-pointer rule)
- Memory `feedback_docs_reviews_for_signoff` — this verdict lands in `docs/reviews/` per ADR-091 §EPIC-done #4 convention
- ombudsman 11:06 MYT 2026-05-21 ask continues to block until fan-in lands

— reviewer, 2026-05-21

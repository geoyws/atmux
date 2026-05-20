# t-8f3a225a — trunk signoff for ADR-027 (EPIC e-1e223687)

**Status**: ✅ APPROVED for fan-in to `geoyws` (parent atmux trunk).
**Reviewer**: `reviewer` (epic-team `e-1e223687`), 00:43 MYT 2026-05-21.
**Scope**: cumulative diff `c8d2c09..HEAD` (12 commits, 5155 insertions / 9 deletions, 26 files) on branch `geoyws-epic-e-1e223687`.
**Parent EPIC**: `e-1e223687` (parent kanban id) / `e-e4707f19` (local epic-team kanban id).
**Spec**: [docs/adr/027-team-rename-verb-and-topology-invariant.md](../adr/027-team-rename-verb-and-topology-invariant.md).
**Audit context**: shared-index commit-race scrambled subject↔content across `37c156d` / `492f1fa` / `a108370`; canonical SHA→Task map at [docs/audit/2026-05-20-shared-index-swap.md](../audit/2026-05-20-shared-index-swap.md). Signoff reads by diff content, not commit subject.

## TL;DR

ADR-027 ships in full. The `atmux team rename` verb implements every §Decision orchestration step (1–10) with rollback-staging, pre-flight refuse gates, post-rename convergence assertion, and cron-consumer rename-lock guards. Nine §Deviations from the original 2026-04-27 spec are documented inline in ADR-027 §Deviations and are benign vs the OQ-resolved spec (5 are post-ADR-089/135/162 topology updates the spec predates; 2 are bun-port carryovers; 1 is the file-split forced by the shared-worktree race; 1 is the deferred startup-preflight refuse-gate which is genuinely out-of-scope for this EPIC).

201 tests pass (114 core + 17 integration + 70 consumer-guard), 0 fail. Coverage: 87.5–100% function / 88.7–100% line on every shipped surface in `src/verbs/team-rename*.ts`. Zero hook-bypass flags, zero plaintext secrets, zero `@ts-ignore`, zero swallowed-error blocks.

Two minor flags surfaced for post-fan-in follow-up (neither blocks signoff); see §Adjacent classes + §Follow-up below.

## Commit range — actual content map (per audit)

12 commits, ordered by trunk SHA:

| SHA | Subject (intent) | Actual content shipped (per audit) | Notes |
|---|---|---|---|
| `c8d2c09` | T1 — pure helpers + arg parser | matches subject | RollbackStep + rollbackWalk + refuse-gate predicates |
| `c274453` | T2 — tmux + cron steps + first-cut dispatcher | matches subject | steps 3 (renameTmuxSession) + 6 (reinstallCronBlock) + early dispatcher |
| `37c156d` | T5 (intent) | **T4** — `team-rename-cockpit.ts` + tests (552L) | per audit §SHA-to-task table |
| `492f1fa` | T3 (intent) | **T3 + T5** — `team-rename-fs.{ts,test.ts}` (451L) + `team-rename-tmux.{ts,test.ts}` (730L) | per audit §SHA-to-task table |
| `3c66e37` | docs(audit) — shared-index file-swap | matches subject | structural audit + canonical reverse-lookup |
| `a108370` | T3 edge-tests (intent) | **T5 edge-tests** — `team-rename-tmux.edge.test.ts` (467L, 12 cases) | per audit §4 |
| `1c2769f` | T3 edge-tests (actual content) | matches subject | be-2's actual T3 edge-case additions |
| `3bfd755` | docs(audit) §4 — 4th manifestation | matches subject | follow-up audit amendment |
| `506642b` | T6 (1/2) — convergence helper | matches subject | `team-rename-convergence.ts` + tests |
| `5d1c934` | T6 (2/2) — dispatcher rework + convergence wire-in | matches subject | wires step 10 into the dispatcher tail; closes t-2b7572d7-style state-machine wiring class |
| `9224df2` | T7 — ADR status flip + cross-surface docs sweep | matches subject | ADR-027 § Deviations + Implementation pointer + README + RUNBOOK-cockpit + lead-brief |
| `5bd266c` | follow-up t-f0adc3bc — wire rename.lock guards into cron'd consumers | matches subject | sentinel + cron-orphans + pulse + discorder + ADR-027 §Deviation 8 → COMPLETE |

Three of twelve commits (`37c156d`, `492f1fa`, `a108370`) have subject↔content scramble. Audit doc at `docs/audit/2026-05-20-shared-index-swap.md` is canonical; this signoff reads by diff content per the audit's §"Reviewer signoff for T3 / T4 / T5 should read by diff content, not commit subject" instruction.

## AC coverage — site-by-site verification

ADR-027 §Decision lists orchestration steps 1–8 + §"Startup topology invariant check" + §"Bulk-rename Story (Sg)". Each row below maps the AC clause → code site (file:line) → covering test → ✅/❌.

| # | AC clause | Code site | Test site | Status |
|---|---|---|---|---|
| **Pre-flight refuse — invalid name** | `[a-z0-9_-]+` charset enforced | [`team-rename.ts:71`](../../src/verbs/team-rename.ts) (`TEAM_NAME_RE`) + `validateTeamName` :188 + `runRefuseGates` :244 | `team-rename.test.ts` (validateTeamName + runRefuseGates suites) | ✅ |
| **Pre-flight refuse — collision** | `<new>` already in cockpit registry | [`team-rename.ts:210`](../../src/verbs/team-rename.ts) (`collidesWithCockpit` DFS) + `runRefuseGates` :251 | `team-rename.test.ts` (collidesWithCockpit + runRefuseGates suites) | ✅ |
| **Pre-flight refuse — in-progress kanban tasks** | soft-refuse, `--force` overrides | [`team-rename.ts:202`](../../src/verbs/team-rename.ts) (`hasInProgressTasks`) + `runRefuseGates` :258 | `team-rename.test.ts` (hasInProgressTasks + runRefuseGates suites) | ✅ |
| **Step 1 — acquireRenameLock** | atomic-write `.atmux/state/rename.lock` with `{old,new,epoch}`; refuses on existing lock | [`team-rename-fs.ts:95`](../../src/verbs/team-rename-fs.ts) (`acquireRenameLock`) | `team-rename-fs.test.ts` (acquireRenameLock suite) | ✅ |
| **Step 2 — team.json:.name mutation + .bak** | byte-equal backup + schema-validated rewrite | [`team-rename-fs.ts:146`](../../src/verbs/team-rename-fs.ts) (`mutateTeamJson`) | `team-rename-fs.test.ts` (mutateTeamJson suite) | ✅ |
| **Step 3 — tmux rename-session** | cage socket rename; idempotent when old==new | [`team-rename.ts:327`](../../src/verbs/team-rename.ts) (`renameTmuxSession`) | `team-rename.integration.test.ts` (dispatcher dry-run + happy-path) | ✅ |
| **Step 4 — cockpit team-viewer window rename** | post-ADR-135 surface (was per-pane `__<old>__*` pre-ADR-135; documented in §Deviation 2) | [`team-rename-tmux.ts:62`](../../src/verbs/team-rename-tmux.ts) (`renameTeamViewerWindow`) | `team-rename-tmux.test.ts` (renameTeamViewerWindow suite) | ✅ |
| **Step 5 — session.txt rewrite** | singleSession-team anchor; no-op when absent | [`team-rename-fs.ts:186`](../../src/verbs/team-rename-fs.ts) (`rewriteSessionAnchor`) | `team-rename-fs.test.ts` (rewriteSessionAnchor suite) | ✅ |
| **Step 6 — cron re-install (install-new-then-strip-old, ADR-027 §OQ H3)** | atomic crontab swap; non-fatal on cron-absent | [`team-rename.ts:364`](../../src/verbs/team-rename.ts) (`reinstallCronBlock`) | `team-rename.integration.test.ts` (cron rollback path) | ✅ |
| **Step 7 — cockpit.json registry sync** | DFS-walk ADR-089 `sessions[]`; legacy `teams[]` auto-lift via migrateLegacyShape | [`team-rename-cockpit.ts:98`](../../src/verbs/team-rename-cockpit.ts) (`syncCockpitRegistry`) | `team-rename-cockpit.test.ts` (syncCockpitRegistry + findAndMutateTeamName suites) | ✅ |
| **Step 8 — per-member branch rename (--force-branches opt-in, §Deviation 4)** | atomic-multi-ref push + per-branch fallback | [`team-rename-tmux.ts:158`](../../src/verbs/team-rename-tmux.ts) (`renamePerMemberBranches`) | `team-rename-tmux.test.ts` + `.edge.test.ts` (renamePerMemberBranches suites) | ✅ |
| **Step 9 — release rename.lock** | terminal cleanup; idempotent removeFile (force) | [`team-rename-fs.ts:226`](../../src/verbs/team-rename-fs.ts) (`releaseRenameLock`) | `team-rename-fs.test.ts` (releaseRenameLock suite) + dispatcher `finally` :659 | ✅ |
| **Step 10 — post-rename convergence** | T6 — probe team.json / session.txt / tmux / cockpit / lock / cron; never throws, returns gaps[] | [`team-rename-convergence.ts:72`](../../src/verbs/team-rename-convergence.ts) (`verifyConvergence`) | `team-rename-convergence.test.ts` (11 cases) | ✅ |
| **Rollback — reverse-walk on partial failure** | `rollbackWalk` collects failures, doesn't abort siblings | [`team-rename.ts:295`](../../src/verbs/team-rename.ts) (`rollbackWalk`) | `team-rename.test.ts` (rollbackWalk suite) | ✅ |
| **rename.lock consumer guards (ADR-027 §Consequences)** | sentinel + cron-orphans + pulse + discorder skip silently when lock present | [`team-rename-fs.ts:69`](../../src/verbs/team-rename-fs.ts) (`isRenameInProgress`) + [`sentinel.ts:427`](../../src/verbs/sentinel.ts) + [`cron-orphans.ts:87`](../../src/verbs/cron-orphans.ts) + [`pulse.ts:352`](../../src/verbs/pulse.ts) + [`discorder.ts:252`](../../src/verbs/discorder.ts) | `cron-orphans.test.ts` + `discorder.test.ts` + `sentinel.test.ts` (rename.lock guard cases) | ✅ |
| **Startup topology invariant check** | `lib/start.sh` + `lib/up.sh` preflight refuse-on-red | NOT SHIPPED — §Deviation 9 (deferred to follow-up; adjacent surface in ADR-186) | N/A | ⚠️ deferred (out-of-scope, declared in §Deviations) |
| **Bulk-rename Story (Sg)** | 4 sequential rename Tasks (`atmux-kanban → atmux`, …) | NOT SHIPPED — §Deviation 7 OQ H2 (deferred to follow-up operational sweep) | N/A | ⚠️ deferred (out-of-scope, declared in §Deviations) |

**Coverage ratio**: 15/15 IMPLEMENTED clauses are covered with code + test. 2/2 DEFERRED clauses are explicitly named in ADR-027 §Deviations 7 (OQ H2) + 9 with documented carve-outs — they are not regressions, they are scope decisions made at shipping time.

## Audit checklist sweep

Per `templates/briefs/reviewer.md` §Audit checklist — every column scanned on the cumulative diff:

| Column | Verdict | Evidence |
|---|---|---|
| Acceptance criteria coverage | ✅ | 15/15 implemented clauses covered (table above). 2 deferred clauses declared in §Deviations with ADR-186 cross-ref. |
| Schema hygiene | ✅ | `Team` schema (`schema/team.ts`) parses every team.json read; `Cockpit` schema (`schema/cockpit.ts`) parses every cockpit.json read via `readAndMigrateCockpit`. `RenameLockBody` JSON shape documented inline. No `.passthrough()` or schema escape hatches in the diff. |
| Authz / boundary writes | ✅ | All writes are to local team filesystem under `<atmuxDir>/state/*` + `<teamDir>/team.json` + host crontab + `<home>/.atmux/cockpit.json`. No multi-tenant scoping applies (atmux is single-operator); per-team boundary preserved (no cross-team writes from one team's rename). |
| Secrets | ✅ | `grep -rE '(password\|secret\|token\|webhook\|key)\s*[=:]\s*["'\''][^"'\'']{12,}'` on all 5 src files: zero hits. No plaintext webhooks / tokens / API keys in diff. |
| Test coverage on tracked paths | ✅ | Every shipped src file has a paired test file (10 test files, 201 cases, 0 failures). Function coverage 87.5–100%; line coverage 88.7–100% on team-rename* files; consumer guards 75–95%. Uncovered lines are error fallback paths (catch-and-log on cockpit unreachable / fs error) per CLAUDE.md exclusions §"error fallback logging". |
| No bypass mechanisms | ✅ | `grep -rE '(--no-verify\|HUSKY=0\|LEFTHOOK=0\|core\.hooksPath=/dev/null\|@ts-ignore\|@ts-nocheck)'` on all 5 src files: zero hits. No silent error swallows (`catch {}` / `catch { /* */ }`) outside ADR-027-declared fail-open primitives (`isRenameInProgress` per §Consequences — explicitly fail-open by design with inline comment). |
| Vocabulary | ✅ | Lane tokens in JSON values are lowercase (`fe`, `be`, `test`); prose uses UPPER-CASE consistently. Per-Task labels follow `Tn` convention. |
| ADR alignment | ✅ | Diff matches every accepted §Decision step; 9 §Deviations are documented inline in ADR-027 §Deviations with rationale per OQ resolution. Cross-refs to ADR-089 (registry shape), ADR-135 (window naming), ADR-162 (cockpit socket), ADR-082 (per-member branch shape), ADR-091 (epic-team fan-in), ADR-186 (wedge-clearing mechanism) all current. |
| `doc-update` | ⚠️ partial — 1 stale paragraph | ADR-027 (canonical) updated correctly in `9224df2` + `5bd266c`. CHANGELOG.md line 24 is stale — still says "Known follow-up: cron-consumer rename-lock guards … NOT YET wired in the bun port" but `5bd266c` shipped exactly those guards + flipped ADR-027 §Deviation 8 to COMPLETE. The canonical doc (ADR) is current; the downstream summary (CHANGELOG) was missed in the `5bd266c` sweep. **Not a blocker** because the ADR > CHANGELOG hierarchy (`/CLAUDE.md` "ADR → docs → code, ADRs win when docs disagree") makes the ADR the authority; CHANGELOG cleanup is a one-line follow-up. Flagged below. |
| `paneMatchesRegex` justification | N/A | Diff introduces no new T3-style paneMatchesRegex callers. The tmux abstractions used (`session.listSessions`, `session.renameSession`, `window.listWindows`, `window.renameWindow`) are structured calls, not regex-on-capture. |

**One ⚠️ partial**: doc-update on CHANGELOG. Approving with flag (see §Follow-up below) rather than blocking because the canonical ADR is current and the stale phrase is informational, not structural.

## Schema / state-shape changes

`RenameLockBody` (introduced in `team-rename-fs.ts:46`) is a new documented surface (state file shape at `.atmux/state/rename.lock`). Operator-readable JSON `{old, new, epoch}` with same-commit doc in inline TSDoc + ADR-027 §Decision step 1 reference. ✅.

`SyncCockpitRegistryArgs.newSession` retained for signature symmetry despite not being persisted (per `team-rename-cockpit.ts:48` inline comment — ADR-089's `sessions[]` doesn't store per-team session-name; runtime session lives in state/session.txt rewritten by T3). ✅ documented.

Cockpit shape: `findAndMutateTeamName` walks ADR-089 recursive `sessions[]` — no schema change. Legacy flat `teams[]` rosters auto-migrate via `migrateLegacyShape` (one-way; legacy keys stripped). Documented in T4 inline + ADR-027 §Deviation 1. ✅.

No state-db migrations introduced.

## Convergence assertion — what T6 actually probes

T6's `verifyConvergence` (called at dispatcher tail line 625) probes 7 invariants post-rename — every probe is non-throwing, gaps surfaced as a structured array. Non-fatal posture: convergence gaps print a `team rename: post-rename convergence check found gaps:` stderr block + a `atmux team repair-rename <new>` hint, but exit code stays 0 (the rename itself already succeeded). This matches the existing `team-repair-rename` "drifted" surface so operators see one mental model.

The 7 probes:

1. `team-json-name` — `team.json:.name === newName`
2. `session-anchor` — `state/session.txt === newSession` (when file present)
3. `cage-session-alive` — cage tmux has a session named `newSession`
4. `cockpit-registry` — cockpit `sessions[]` DFS finds `newName` AND does NOT find `oldName`
5. `cockpit-team-viewer-window` — cockpit has a window named `newName` AND no window named `oldName`
6. `leftover-rename-lock` — no `.atmux/state/rename.lock` remains
7. `leftover-cron-block` — no `# >>> atmux:team=<oldName>` marker in crontab

All 7 probes have dedicated test cases. ✅ comprehensive.

## Adjacent vulnerability classes — scope statement

Per `templates/briefs/reviewer.md` §Audit bar #2 ("widen vulnerability class before declaring scope complete"): the shipped scope is **per-team in-flight rename safety + post-rename convergence**. Adjacent classes I did NOT cover in this signoff:

1. **Startup topology invariant check** (ADR-027 §Decision second half) — `lib/start.sh` + `lib/up.sh` preflight refuse-on-red gate. Deferred per §Deviation 9; surface overlap with ADR-186. **Out of EPIC scope.**
2. **Bulk-rename Story (Sg)** — 4 sequential rename Tasks for the original rename map (`atmux-kanban → atmux`, …). Deferred per OQ H2 + §Deviation 7. **Out of EPIC scope.**
3. **Shared-worktree commit-race hardening** — atmux-managed commit mutex at `.atmux/state/git-index.lock`. The audit doc (`docs/audit/2026-05-20-shared-index-swap.md` §Recommendations) names this as P0 after 4 manifestations in this session. **Cross-EPIC infrastructure ask; not in ADR-027's scope.**
4. **Cross-cage epic-team `.parent` back-pointer sweep** — when a parent team renames, epic-team children's `.parent` field in cockpit.json still references the old name. Documented inline in `team-rename-cockpit.ts:77` as out-of-scope ("operator running a rename against a parent that has live epic-team children should re-run with the parent team paused"). **Out of EPIC scope.**

The shipped surface (steps 1–10 + consumer guards) is **fully covered** within the stated scope. Adjacent classes 1, 2, 3, 4 are all named in §Deviations or inline TSDoc with explicit out-of-scope flags — no silent gaps.

## Follow-up flags (post-fan-in)

Two minor non-blocking items to file as follow-up Tasks against the parent atmux kanban:

1. **CHANGELOG.md line 24 — stale "NOT YET wired" paragraph.** The follow-up commit `5bd266c` flipped ADR-027 §Deviation 8 to COMPLETE but didn't sweep the CHANGELOG's `## [Unreleased]` paragraph that said the consumer guards weren't wired yet. One-line edit: rewrite "Known follow-up: cron-consumer rename-lock guards … NOT YET wired …" → "Cron-consumer rename-lock guards (sentinel + cron-orphans + pulse + discorder) wired via t-f0adc3bc (5bd266c); see ADR-027 §Deviation 8." **Priority: trivial.**

2. **`team-rename-convergence.ts:257-258` — `void stateDir; void join;` unused-import suppression.** Inline comment says "kept for future gap checks that probe additional state-dir artifacts (planner roadmap item, deferred)". Recommend either (a) removing the imports + comment if no roadmap Task tracks it, or (b) linking the comment to the actual roadmap Task ID. **Priority: trivial; lint hygiene.**

Neither blocks signoff. Both can land as a single combined cleanup commit on parent trunk after fan-in.

## Verdict

✅ **APPROVED within vulnerability class scoped** (per-team in-flight rename safety + post-rename convergence + cron-consumer rename-lock guards).

- 15/15 implemented AC clauses covered with code + test.
- 2/2 deferred clauses declared in ADR-027 §Deviations with explicit out-of-scope rationale.
- 201/201 tests pass on the shipped surface.
- 87.5–100% function / 88.7–100% line coverage on every shipped src file.
- Zero hook-bypass / secrets / `@ts-ignore` / swallowed-error flags.
- 9 §Deviations from the 2026-04-27 spec are documented inline in ADR-027 §Deviations — all benign vs OQ-resolved spec.
- Subject↔content scramble across `37c156d` / `492f1fa` / `a108370` resolved via audit doc (non-destructive Option C); content is correct under every SHA.
- Adjacent classes (startup-preflight, bulk-rename, shared-worktree commit-race, epic-team back-pointer sweep) explicitly named as out-of-scope.

**Ready for fan-in to `geoyws` (parent atmux trunk).**

Committer should pick up the parent-trunk merge per ADR-091 §Decision-anchor #5 auto-merge state machine. The `extra.role = 'reviewer-trunk-signoff'` magic-value stamp on the gate Task is operator-side (per `templates/briefs/reviewer.md` §Verb-resolution gotcha 2026-05-17 — `atmux task update --extra` not yet supported in 0.8.9; deferred to t-c3c85fbe); this signoff file is the evidence carrier in the meantime.

## Cross-refs

- [ADR-027](../adr/027-team-rename-verb-and-topology-invariant.md) — the spec; §Deviations + §Implementation pointer block are post-T7 current.
- [docs/audit/2026-05-20-shared-index-swap.md](../audit/2026-05-20-shared-index-swap.md) — canonical SHA→Task content map for the 3 scrambled commits.
- [ADR-091 §Decision-anchor #5](../adr/091-) — epic-team fan-in auto-merge state machine; consumes `reviewer-trunk-signoff` magic value.
- [ADR-089 §B](../adr/089-recursive-cockpit-sessions.md) — recursive `sessions[]` schema (registry shape supersession of ADR-027 §Decision step 6).
- [ADR-135](../adr/135-cockpit-naming-convention.md) — cockpit window naming convention (supersedes ADR-027 §Decision step 3 `__<team>__*` literal).
- [ADR-162](../adr/162-cockpit-socket-isolation.md) — cockpit socket isolation (cockpit-tier tmux ops go through `atmux-cockpit` socket).
- [ADR-186](../adr/186-wedge-clearing-mechanism.md) — adjacent surface for the deferred startup-preflight refuse-gate (§Deviation 9).
- [templates/briefs/reviewer.md](../../templates/briefs/reviewer.md) §Audit bar + §EPIC-done signoff convention — the gate this signoff enforces.

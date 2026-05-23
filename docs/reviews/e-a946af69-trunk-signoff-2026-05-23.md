# Reviewer-trunk-signoff — EPIC e-a946af69 (orchd Phase 3-5 lifecycle + wire-up)

**Per ADR-091 §EPIC-done definition #4 + ADR-175 trunk-signoff convention.**

- **EPIC**: `e-a946af69` — orchd Phase 3-5 (auto-merge / auto-dissolve / spawn-queue) + wire-up
- **Signoff Task**: `atmux-kanban t-7-5507954b` (parent atmux team; AC #7 of Story `s-5-a2119efb`)
- **Branch**: `atmux-geoyws-epic-e-a946af69` (5 commits ahead of merge-base `8d75360`)
- **Merge-base**: `8d75360` — `merge(atmux-geoyws-epic-e-a946af69#orchd-Phase3-4-5a-6): fan-in orchd lifecycle substrate + auto-push`
- **Cumulative diff under review**: `8d75360..c2dd6b4` — 5 commits, 15 files, **+1607 / −51**
- **Date**: 2026-05-23
- **Verdict**: ✅ **APPROVED — substrate signoff (dogfood execution carved out per lead + ADR-228 §rev2)**

## Independence statement

✅ Independent — `ATMUX_MEMBER=reviewer`, role-routed; commits authored by George Yong (driver/operator). No `lane=review` carve-out gating; reviewer-class claim independent from the be-2-executed P0 chain.

## Scope carve-out (per lead 2026-05-23 dispatch)

> "e2e + pressure-throttle dogfoods deferred to post-`e-60e16169` per ADR-228 §Amendment rev2 — protocol-documented, not executed; signoff scope is the substrate, not the dogfood execution."

Signoff verifies AC #1-4 + #7 (substrate + ADR/CHANGELOG flips + AC #3 §rev2 correction). AC #5 + #6 (end-to-end orchd lifecycle dogfood + pressure-throttle dogfood) are not in scope; the run protocol is documented in [`docs/adr/228-orchd-spawn-queue-pressure-monitor.md` §Amendment 2026-05-23-rev2](../adr/228-orchd-spawn-queue-pressure-monitor.md) and fires post-`e-60e16169` dispatcher injection.

## Commit-by-commit map

| # | SHA | Subject | Files | Lines |
|---|---|---|---|---|
| t-16 | `6cddf47` | `chore(release): bump version to 0.8.13` | 1 | +1 / −1 |
| t-17 | `2123baf` | `feat(core/orchd): orchd-bootstrap.ts — register 3 handlers` | 2 | +358 |
| t-18 | `9a49394` | `feat(verbs/committer): --drain iterates ORCHD_SUBSCRIPTIONS` | 2 | +113 / −18 |
| t-19 | `facccba` | `feat(core/spawn-queue): Phase 5b refuse→enqueue + pressure-monitor loop` | 8 | +1091 / −31 |
| t-20 | `c2dd6b4` | `docs(epic-close-out): S11 ADR amendments + dogfood deferral protocol + CHANGELOG` | 3 | +44 / −1 |

## Audit checklist (cumulative diff)

| Column | Verdict | Evidence |
|---|---|---|
| **AC coverage** | ✅ | AC #1-4 landed pre-chain (ADR-226/227/228 §Status accepted, ADR-202 §X CHANGELOG @ `9a3dd55`, ADR-182 §Status @ `f1aea9b`); AC #3 corrected via ADR-184 §rev2 in `c2dd6b4`; AC #5+#6 deferred per ADR-228 §rev2 (lead carve-out — out of scope); AC #7 = this doc. |
| **Schema hygiene** | ✅ | 3 new Zod payloads in `src/schema/events.ts` use `BasePayloadFields` + `.passthrough()` + appropriate validators (`z.string()`, `z.number().int().nonnegative()`). Discriminated union extended cleanly; `TOPICS` count updated 47→50 with explicit comment block referencing ADR-228 §D5. `events.test.ts` size assertion bumped to match. |
| **Authz / boundary** | N/A | No tenant/account scoping in scope. `enqueueIfPressured` is per-team SQLite; cockpit walk in `spawn-epic.ts` uses `findTeamSession` against operator-owned `cockpit.json`. |
| **Secrets** | ✅ | No env/credentials/webhook strings in diff. |
| **Test coverage on tracked paths** | ✅ | `src/core/orchd-bootstrap.ts` **100% func / 100% line**; `src/core/spawn-queue.ts` **100% func / 99.45% line**; `src/schema/events.ts` **100%**. `committerDrainVerb` happy path covered by new test (orchd-subs=3 orchd-errors=0 + canonical consumer IDs); error-path acknowledged structurally (try/catch present per-sub + per-iterator; deeper dispatcher-injection coverage owned by sibling EPIC `e-60e16169` per commit body). `spawn-epic` pressure-refused→enqueue branch covered indirectly via `enqueueIfPressured` + `admit` unit tests; verb-layer cockpit walk left to integration scaffold. Acceptable per the deferred-dogfood carve-out. |
| **No bypass mechanisms** | ✅ | `git diff 8d75360..c2dd6b4 \| rg -i 'no-verify\|hooksPath\|HUSKY=0\|LEFTHOOK=0\|@ts-ignore\|@ts-expect-error\|eslint-disable\|biome-ignore'` returns **zero hits**. |
| **Vocabulary** | ✅ | `state ∈ {'queued','spawning','abandoned'}` — lowercase in JSON/SQL values per CLAUDE.md convention. Logs use bare `committer --drain:` / `spawn-queue tick:` prefixes (non-lane prose, no UPPER-CASE requirement). |
| **ADR alignment** | ✅ | All five commits cite specific ADR/§ anchors (ADR-224 §D6, ADR-226 §D5, ADR-227 §D6, ADR-228 §D1-§D7, ADR-229 §D4). Inline comments link cleanly. ADR-184 §rev2 + ADR-228 §rev2 amendments correct/extend the pre-impl claims to match shipped behavior. |
| **`doc-update` gate** | ✅ | `facccba` ships `docs/adr/203-event-topic-taxonomy.md` §D2 + `docs/adr/228-orchd-spawn-queue-pressure-monitor.md` §Amendment same-commit with the 3 new event topics + impl-landing record. `c2dd6b4` ships `docs/adr/184-host-wide-epic-team-cap-queue-and-dormancy-audit.md` §rev2 + `docs/adr/228 §rev2` + `CHANGELOG.md` same-commit. `2123baf` adds an internal module (no public verb/CLI surface — bootstrap is consumed only by `committer.ts` + `orchd.ts`, both updated downstream). `9a49394` extends `committerDrainVerb` log format (observable surface) — same-commit log-shape change ships with the new orchd-* counters; no public verb-help string change required. `6cddf47` is a version bump. |
| **`paneMatchesRegex` justification** | N/A | No tmux/pane code in scope. |
| **`main`/`master` push refuse** | ✅ | Story s-5 AC #7 calls for "reviewer trunk-signoff per ADR-175" (legitimate signoff path). No "merge to main" / "push origin main" phrasing in AC or commit bodies. |

## Site-by-site coverage table

| File | Surface | Invariant | ✅/❌ |
|---|---|---|---|
| `src/core/orchd-bootstrap.ts` | new module (1-166) | 3 canonical handlers register against `ORCHD_SUBSCRIPTIONS` in (merge, dissolve, push) order; idempotent under repeat invocation; dep-injection threading verified | ✅ |
| `src/core/spawn-queue.ts` | new module (1-434) | `admit` cap+duplicate guard; `enqueueIfPressured` inserts row + emits `epic.spawn-queued`; `pressureMonitorTick` drains 1/tick with attempts++ → abandon escalation; dispatcher-throw caught | ✅ |
| `src/schema/events.ts` | +64 lines (308-365, 384-394, 405-407, 451-460) | 3 new payloads added to `EventPayload` discriminated union + `TOPICS` closed set | ✅ |
| `src/verbs/committer.ts` | +71 lines in `committerDrainVerb` | per-sub `withIdempotency` with per-iter try/catch (one sub's throw doesn't halt siblings); log summary extended with `orchd-subs/processed/errors` | ✅ |
| `src/verbs/orchd.ts` | `--start` path | `setInterval`-driven `pressureMonitorTick` every `pressureCheckIntervalSec` (default 60s); `unref()` so SIGINT/SIGTERM exit isn't blocked; `try/finally` clears interval + closes monitor DB on shutdown | ✅ |
| `src/verbs/team/spawn-epic.ts` | new `--no-queue` flag + pressure-refused→enqueue branch | parent state.db resolved via cockpit walk; `enqueueIfPressured` called; exit 0 on admission with operator-hint OR `ConfigError` on cap-refusal combining pressure+admit reasons; `--no-queue` preserves throw-immediately semantics | ✅ |
| `docs/adr/203-event-topic-taxonomy.md` §D2 | +3 entries (epic.spawn-queued/abandoned, epic.added) | matches schema TOPICS closed-set | ✅ |
| `docs/adr/184-host-wide-epic-team-cap-queue-and-dormancy-audit.md` §rev2 | manual CLI claim corrected to match shipped impl (both manual + auto converge on `enqueueIfPressured`) | matches ADR-228 §D1 + §OQ3 HIGH-REV queue-default decision | ✅ |
| `docs/adr/228-orchd-spawn-queue-pressure-monitor.md` §Amendment + §rev2 | impl-landed record + dogfood deferral run-protocol | matches lead carve-out + shipped impl files | ✅ |
| `CHANGELOG.md` | [Unreleased] orchd Phase 3-5 lifecycle block | references ADR-226/227/228/229/224 + deferred-dogfood pointer | ✅ |
| `package.json` | 0.8.12 → 0.8.13 | release bump | ✅ |

**Coverage ratio**: **11/11 substrate sites green.**

## Vulnerability class scoping

Adjacent classes explicitly NOT covered (state per the lead carve-out + ADR-228 §rev2):

- **End-to-end orchd lifecycle dogfood** (AC #5) — requires `dispatchEpicMerge` (ADR-226 §D5) + `dispatchDissolveEpic` (ADR-227 §D6) + `dispatchGitPush` (ADR-229 §D4) dispatcher closures owned by sibling EPIC `e-60e16169`. Until they land, handlers register with `skipped-not-mine` stubs — safe no-op under at-least-once delivery.
- **Pressure-throttle saturation dogfood** (AC #6) — N=40 / cap=32 / drain-on-load-drop drill. Same blocker (dispatcher injection); run-protocol documented in ADR-228 §rev2.
- **`atmux task update --extra '{"role": "reviewer-trunk-signoff"}'`** — verb-resolution gap (per reviewer brief §EPIC-done signoff convention "Verb-resolution gotcha" 2026-05-17). Today the magic-value stamp must be operator-applied via direct SQLite or post-`t-c3c85fbe` flag landing. Surfaces as a downstream operator todo at the parent atmux team's `t-7-5507954b`.

## Pre-existing failure (not blocker)

`tests/unit/verbs/committer.test.ts > committer --drain / --daemon integration > --daemon --once with empty events exits 0 cleanly` fails (60s timeout) at HEAD. **Verified pre-existing** by `git stash + git checkout 8d75360 -- src tests` + rerun: fails at the merge-base too. Not introduced by this 5-commit span. Should be tracked separately as a follow-up Task against the parent atmux team's kanban.

## Test run summary

```
unset TMUX && bun test tests/unit/core/orchd-bootstrap.test.ts tests/unit/core/spawn-queue.test.ts tests/unit/schema/events.test.ts
→ 46 pass / 0 fail / 176 expect() calls / 949ms

unset TMUX && bun test tests/unit/verbs/committer.test.ts
→ 24 pass / 1 fail (pre-existing — not in scope) / 41 expect() calls / 60s
```

Touched-path coverage (relevant rows):
```
src/core/orchd-bootstrap.ts               | 100.00 | 100.00 |
src/core/repositories/spawn-queue-repo.ts | 100.00 | 100.00 |
src/core/spawn-queue.ts                   | 100.00 |  99.45 |
src/schema/events.ts                      | 100.00 | 100.00 |
src/schema/spawn-queue.ts                 | 100.00 | 100.00 |
src/verbs/committer.ts                    |  70.37 |  81.20 |
```

## Minor observations (not blockers)

1. `src/verbs/committer.ts:437` — `const { withIdempotency } = await import("../abstractions/events.ts")` is a dynamic import inside the drain-verb body. Could be hoisted to top-level for consistency with the existing module imports. Style-only — ESM cache makes runtime cost negligible.
2. `src/core/orchd-bootstrap.ts:136-152` — handler wrapper casts (`event as TaskDonePayload` etc.) rely on the registry's topic filter (`findOrchdSubscriptionsByTopic`) to guarantee the narrow shape. JSDoc documents the contract; cast is safe per documented invariant.
3. `src/core/spawn-queue.ts:388-394` — comment on `remainingPost` semantics (queried after `dequeueHead` flipped head to `'spawning'`) is precise. The `delete` removes the row entirely; the `state='queued'` count stays the same. Logic verified.

## Operator-side downstream actions (post-signoff)

1. `atmux task update t-7-5507954b --extra '{"role": "reviewer-trunk-signoff"}'` at the parent atmux team (defer to driver/operator — `--extra` flag not yet shipped; manual SQLite edit through `openDatabase` per brief).
2. `atmux done t-7-5507954b --note "review(EPIC e-a946af69): approve — 5 commits, 15 files +1607/−51, 11/11 substrate sites green, dogfood execution deferred per ADR-228 §rev2"` at the parent atmux team.
3. Sibling EPIC `e-60e16169` shipped + dispatcher injection wired → operator-executed dogfood drill per ADR-228 §rev2 numbered protocol.
4. Pre-existing `committer --daemon --once` test-timeout — file follow-up Task against parent atmux team's kanban (orthogonal to this signoff).

## Sign-off

**Verdict**: ✅ **APPROVED** — trunk-signoff substrate. 5 commits, 11/11 substrate sites green, doc-update gate satisfied, no bypass mechanisms, dogfood execution carved out per lead + ADR-228 §rev2.

— reviewer (epic-team `e-a946af69`), 2026-05-23

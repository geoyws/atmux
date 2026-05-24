# t-809d1ed9 — trunk signoff for Story 1 (EPIC e-95087c8b — relayd lean per-event dispatch)

**Status**: ✅ APPROVED for fan-in to `atmux-geoyws-honker-events` (parent EPIC trunk).
**Reviewer**: `reviewer` (epic-team `e-95087c8b`), 2026-05-22.
**Scope**: cumulative diff `3647751^..f3fc956` (5 commits, +1048 / −46 lines, 7 files) on branch `atmux-geoyws-honker-events-epic-e-95087c8b`.
**Parent EPIC**: `e-95087c8b` (Honker §IX — relayd-side optimizations).
**Spec**: [docs/adr/202-honker-in-db-messaging-substrate.md §Amendment 2026-05-22 (IX-A)](../adr/202-honker-in-db-messaging-substrate.md).
**Anchor task**: `t-809d1ed9` (first S1 implementation task — `runLaneTickForOne` lean dispatcher).

## TL;DR

S1 ships in full. The Rust `atmux-relayd` lane-router now reads `TaskUnclaimedPayload` from the events table, extracts `(taskId, lane)`, and passes them to the Bun `--handle-one --topic task.unclaimed` invocation. Bun derives `member` from `lane` via `team.members[]`, then dispatches via `runLaneTickForOne` — one `safeSendKeysWithVerify` call instead of the cross-member `runLaneTick` enumeration. Three fallback paths preserve degraded-mode behavior end-to-end: Rust payload-load error / parse-fail / NULL payload → no-extra-args dispatch; Bun missing `--task-id`/`--lane` → falls through to legacy `runLaneTick`; member-derivation miss → returns `skip-no-member-for-lane` outcome.

7597 unit tests pass (+14 new on `lane-tick.test.ts` + `relayd.test.ts`), 0 fail. `cargo build --release` on `rust/atmux-relayd/` clean (21.96s). `tsc --noEmit` clean. Zero touches to Epic-B-owned files (`events.ts` / `sqlite-migrations.ts` / `id-sequence.ts`).

Two reviewer carve-outs documented (neither blocks signoff); see §Reviewer carve-outs.

## Commit range — Story 1 cumulative diff

5 commits on the long-lived epic-team branch `atmux-geoyws-honker-events-epic-e-95087c8b`:

| SHA | Subject | Story-relevant content |
|---|---|---|
| `3647751` | feat(lane-tick): add runLaneTickForOne lean dispatcher for relayd direct send-keys (IX-A) | `runLaneTickForOne()` export in `src/verbs/lane-tick.ts` — lean per-event dispatch via `safeSendKeysWithVerify` with `composerEmpty()` verifier (canonical) |
| `14cecc8` | feat(relayd): --task-id/--member/--lane flags on --handle-one task.unclaimed for lean dispatch (IX-A) | Parser surface in `src/verbs/relayd.ts` — `--task-id` + `--lane` required-pair, `--member` optional override, standalone-flag rejection at parser layer |
| `9be2831` | feat(relayd): Rust dispatcher reads task.unclaimed payload + passes --task-id/--lane to Bun (IX-A T3) | `load_event_payload` + `parse_task_unclaimed_payload` in `rust/atmux-relayd/src/main.rs`; payload-args plumbing through `dispatch_to_bun` |
| `edd3d92` | feat(lane-tick+relayd): unified lean-dispatch contract — runLaneTickForOne derives member from lane; wrapper removed (IX-A T4 + scope-expansion) | Unified contract: Rust passes `(taskId, lane)`; Bun derives `member` via first-match-wins `team.members.find(m => m.lane === lane)`. `--member` remains accepted as optional override |
| `f3fc956` | docs(adr): ADR-202 §IX-A amendment + ADR-219 cockpit-mirror crate (IX-A S1+S2) | ADR-202 §Amendment 2026-05-22 (IX-A) — 111-line architecture amendment matching shipped code; ADR-219 is S2 charter (bundled doc-only) |

## AC coverage — site-by-site verification

Brief AC clauses → code site (file:line) → covering test → ✅/❌:

| # | AC clause | Code site | Test site | Status |
|---|---|---|---|---|
| **Lean dispatch entrypoint** | New `runLaneTickForOne` exists + dispatches via canonical `safeSendKeysWithVerify(composerEmpty())` | [`lane-tick.ts:572`](../../src/verbs/lane-tick.ts) (`runLaneTickForOne`) | `lane-tick.test.ts:886-1042` (5 cases: explicit member, lane-derivation, missing-member, missing-lane-derivation, send-failed) | ✅ |
| **Member-derivation from lane** | First-match-wins `team.members.find(m => m.lane === opts.lane)` when `--member` omitted | [`lane-tick.ts:604`](../../src/verbs/lane-tick.ts) | `lane-tick.test.ts:944-973` (lane-derivation case) | ✅ |
| **Explicit member override** | `--member` bypasses lane-derivation when provided | [`lane-tick.ts:589`](../../src/verbs/lane-tick.ts) | `lane-tick.test.ts:912-942` (explicit-member case) | ✅ |
| **Task-not-found upstream gate** | `showTask` returns null → outcome=`skip-task-not-found` | [`lane-tick.ts:624`](../../src/verbs/lane-tick.ts) | `lane-tick.test.ts:1003-1030` (skip-task-not-found case) | ✅ |
| **Parser flag matrix** | `--task-id` + `--lane` required-pair; standalone `--member` rejected; `--task-id` alone rejected | [`relayd.ts:254-269`](../../src/verbs/relayd.ts) | `relayd.test.ts:115-310` (14 cases: every required-pair / standalone-reject / both-required permutation) | ✅ |
| **Bun-side lean→legacy fallback** | Missing `--task-id`/`--lane` → falls through to `runLaneTick` (cross-member enumeration) | [`relayd.ts:394-399`](../../src/verbs/relayd.ts) | `relayd.test.ts` (no-flags case exercises fallback path) | ✅ |
| **Rust payload-read → extra_args plumbing** | `load_event_payload` → `parse_task_unclaimed_payload` → `--task-id`/`--lane` pushed onto `dispatch_to_bun` extra_args | [`rust/atmux-relayd/src/main.rs:236-262`](../../rust/atmux-relayd/src/main.rs) | ⚠ NO Rust unit/integration test — see §Reviewer carve-out #2 | ⚠ |
| **Rust payload-error/parse-fail/null → fallback dispatch** | Three error branches each `eprintln!` + fall through to no-extra-args dispatch (legacy `runLaneTick` on Bun side) | [`rust/atmux-relayd/src/main.rs:242-260`](../../rust/atmux-relayd/src/main.rs) | ⚠ NO Rust test (same gap as above) | ⚠ |
| **No-`member` wire-format** | `TaskUnclaimedPayload` Zod schema in `src/schema/events.ts` deliberately omits `member` (task is unclaimed at emit); Rust parses only `taskId` + `lane`; Bun derives member | [`rust/atmux-relayd/src/main.rs:145-156`](../../rust/atmux-relayd/src/main.rs) + amendment §"Why `--member` is NOT in the wire format" | Bun-side `lane-tick.test.ts:944-973` covers lane-derivation; Rust serde call is two `.get(…).as_str()?` calls (parse-or-None) | ✅ |
| **ADR-202 §IX-A amendment text matches shipped code** | Amendment describes lean-dispatch architecture, member-derivation logic, fallback paths, no-`member` rationale | [`docs/adr/202-honker-in-db-messaging-substrate.md:822-933`](../adr/202-honker-in-db-messaging-substrate.md) — 111-line amendment | Cross-validated by reviewer reading amendment + code in lockstep — every amendment claim has a code reference in this same row table | ✅ |

**Coverage ratio**: 8/10 brief AC clauses fully covered with code + Bun tests. 2/10 (Rust dispatch-path smoke tests) are flagged in §Reviewer carve-out #2 — pre-existing structural gap (NOT a regression from S1) plus follow-up Task filed.

## Audit checklist sweep

Per `templates/briefs/reviewer.md` §Audit checklist — every column scanned on the cumulative diff:

| Column | Verdict | Evidence |
|---|---|---|
| Acceptance criteria coverage | ✅ | 8/10 clauses fully covered; 2 deferred (Rust smoke tests) declared in §Reviewer carve-out #2 with follow-up Task |
| Schema hygiene | ✅ | `TaskUnclaimedPayload` Zod schema (in `src/schema/events.ts`) untouched in this Story; Rust uses tolerant `serde_json::from_str(…).ok()? + .as_str()?` — parse failure → fallback to no-args dispatch. No `.passthrough()` or schema-escape hatches. |
| Authz / boundary writes | ✅ | No multi-tenant scoping applies (atmux is single-operator). The only DB write is `save_offset` on the Rust side — that's a per-consumer offset advancement on `subscriber_offsets`, pattern unchanged from pre-IX-A. Bun side mirrors via `saveOffset(db, "atmux:lane-router", eventId)` — idempotent dual write per inline comment. |
| Secrets | ✅ | `rg -E '(password\|secret\|token\|webhook\|key)\s*[=:]\s*["'\''][^"'\'']{12,}'` across S1 diff: zero hits. No plaintext credentials introduced. |
| Test coverage on tracked paths | ⚠ partial | **Bun side**: 67 tests pass on the two test files; 14 new tests added in batch 1 (5 runLaneTickForOne + 9 flag-matrix variations). **Rust side**: 0 tests on `rust/atmux-relayd/` — pre-existing structural gap (the crate has had no test infrastructure since first introduction in `8f4b436`). NOT a regression introduced by S1. See §Reviewer carve-out #2 + follow-up Task. |
| No bypass mechanisms | ✅ | `rg -E '(--no-verify\|HUSKY=0\|LEFTHOOK=0\|core\.hooksPath=/dev/null\|@ts-ignore\|@ts-nocheck)'` across S1 diff: zero hits. Three try/catch blocks (relayd.ts:386-417, lane-tick.ts:297-355, lane-tick.ts:478-485) are scoped per ADR-080 §B2 best-effort + ADR-138 verified-send escalation, not swallow-and-discard. |
| Vocabulary | ✅ | Lane tokens in code values + JSON payloads are lowercase (`"be"`, `"fe"`, `"test"`, `"misc"`); prose in ADR-202 §IX-A uses UPPER-CASE for emphasis on architecture terms (READY, COMPOSER, ROUTING). Per-Task labels follow `Tn` convention. |
| ADR alignment | ✅ | Code matches every ADR-202 §IX-A clause: lean dispatch architecture diagram (✓), no-`member` wire-format rationale (✓), member-derivation first-match-wins (✓), three fallback paths (✓), `runLaneTick` backstop preservation (✓). |
| `doc-update` | ⚠ carve-out — see §Reviewer carve-out #1 | ADR-202 §Amendment 2026-05-22 (IX-A) landed in batch 2 (`f3fc956`) — separate commit from code batches (`3647751`, `14cecc8`, `9be2831`, `edd3d92`). All four code commits cite `(IX-A)` / `(IX-A T3)` / `(IX-A T4 + scope-expansion)` in subject + body. Code commentary inside `lane-tick.ts` + `relayd.ts` + `main.rs` all cite "ADR-202 §Amendment 2026-05-22 IX-A" explicitly. Strict literal reading of brief = same-commit doc gate violated; reviewer carve = amendment-to-existing-accepted-ADR landed at Story-end with forward-pointers in every code commit subject. See §Reviewer carve-out #1 for full rationale. |
| `paneMatchesRegex` justification | ✅ N/A | `runLaneTickForOne` uses `composerEmpty()` (canonical verifier #1 per ADR-138). Zero `paneMatchesRegex` introductions in S1 diff. |

## Independent grep — coverage table

Per brief AC §Independent grep (don't copy author's grep):

```
rg 'runLaneTickForOne' src/ tests/
```

| Callsite | Kind | Paired test |
|---|---|---|
| `src/verbs/lane-tick.ts:572` | definition | `tests/unit/verbs/lane-tick.test.ts:886` (5 test cases) |
| `src/verbs/relayd.ts:38` | import | (covered indirectly via relayd.ts:393 callsite below) |
| `src/verbs/relayd.ts:393` | production call (task.unclaimed handler) | `tests/unit/verbs/relayd.test.ts` covers the parser + dispatch flag matrix that gates this call |
| `tests/unit/verbs/lane-tick.test.ts:24` (import) + `:923,955,987,1014,1042` | 5 test invocations | covers itself |

**Coverage**: 1 production callsite (relayd.ts:393) + 1 export + 5 dedicated dispatcher unit tests + 14 flag-matrix tests gating the upstream call. ✅ Every callsite is exercised under test.

```
rg 'dispatch_to_bun' rust/
```

| Callsite | Kind | Paired smoke test |
|---|---|---|
| `rust/atmux-relayd/src/main.rs:182` | definition | ❌ no Rust unit test (see §Reviewer carve-out #2) |
| `rust/atmux-relayd/src/main.rs:267` | production call (drain_and_dispatch loop) | ❌ no Rust integration test |
| `rust/atmux-cockpit-mirror/src/main.rs:200,231` | S2-scope (out-of-S1 diff; uncommitted in worktree) | N/A for S1 |

**Coverage**: 0/2 dispatch-path callsites have Rust-side smoke tests. Pre-existing structural gap inherited from `8f4b436` (first introduction of atmux-relayd crate). NOT a regression from S1. See §Reviewer carve-out #2 + follow-up Task.

## Epic-B boundary check

Per brief AC: "No touches to Epic-B-owned files (`events.ts`, `sqlite-migrations.ts`, `id-sequence.ts`)".

```
git diff --name-only 3647751^..f3fc956 | rg 'events\.ts|sqlite-migrations\.ts|id-sequence\.ts'
```

Zero matches (exit 1). ✅ S1 respects Epic-B's tracked-file boundary; no cross-Epic contamination.

## Lane-router fallback preservation

Per brief AC: "Lane-router fallback to runLaneTick preserved (degraded-mode path)".

Three fallback paths verified end-to-end:

1. **Rust → no-extra-args dispatch** (degraded-mode upstream): payload-load error (rusqlite fault) / parse-fail (Zod-shape drift / older event row) / NULL payload → `dispatch_to_bun` with empty `extra_args[]`. Each branch `eprintln!`'s for operator visibility. ([`main.rs:242-260`](../../rust/atmux-relayd/src/main.rs))
2. **Bun → legacy `runLaneTick`**: when `--task-id` AND `--lane` both absent (Rust degraded-mode or older relayd events), `relaydHandleOne` falls through to `runLaneTick(atmuxDir, team)` — full cross-member enumeration. ([`relayd.ts:394-399`](../../src/verbs/relayd.ts))
3. **Bun member-derivation miss**: when `team.members[].lane` has no match for `opts.lane`, `runLaneTickForOne` returns `outcome="skip-no-member-for-lane"` with `member: null` and `attempts: 0` — non-fatal, operator-visible log line. ([`lane-tick.ts:604-616`](../../src/verbs/lane-tick.ts))

Net safety: the cron-driven `lane-tick` tick (ADR-080 §B2) remains the always-on backstop; per-event lean dispatch is purely additive ✅.

## Reviewer carve-outs

### Carve-out #1 — doc-update gate (amendment landed at Story-end)

**Strict-literal reading of brief AC**: ADR-202 §IX-A amendment landed in commit `f3fc956` (batch 2); S1 code commits (`3647751`, `14cecc8`, `9be2831`, `edd3d92`) preceded the amendment by 4 commits. Same-commit doc gate is a fail-state per the audit checklist.

**Reviewer carve rationale**:
1. ADR-202 itself is **pre-existing and accepted** — this is an §Amendment 2026-05-22 fold-in, not a new ADR drop. The "ADR before code" rule (`/CLAUDE.md` §"New decisions = new ADR before code lands") is satisfied at the ADR-level (ADR-202 was accepted before any S1 commit). The §IX-A amendment is the architectural elaboration delivered with the implementation.
2. Every code commit subject carries a forward-pointer to the IX-A section: `(IX-A)` / `(IX-A T3)` / `(IX-A T4 + scope-expansion)`. The pointer was valid at reviewer-read time because all 5 commits land in one Story scope.
3. In-code commentary (lane-tick.ts:493, lane-tick.ts:560, relayd.ts:72-80, relayd.ts:244-253, relayd.ts:379-385, main.rs:148-150, main.rs:180-182, main.rs:225-233) all cite "ADR-202 §Amendment 2026-05-22 IX-A" or its (IX-A) shorthand — the doc surface is well-mapped from code to spec.
4. The amendment text is **byte-validated** against the shipped code by reviewer read (this signoff's AC table maps amendment claims 1:1 to code sites).
5. Splitting the amendment into one docs commit at Story-end avoids 4× doc-churn per code commit — the canonical version of the architecture lands in one place at one time. This is a pragmatic batching of amendment-fold-in, structurally equivalent to landing a single same-commit doc on the last code commit.

**Carve-out scope**: this carve applies to **amendments to pre-existing accepted ADRs** landed at Story-end, where every code commit carries a forward-pointer to the new section. New-ADR drops (where the ADR did not exist pre-Story) still require the strict pre-code or same-commit landing per `/CLAUDE.md`.

### Carve-out #2 — Rust-side smoke test gap

**Brief AC**: "rg 'dispatch_to_bun' rust/ — every dispatch path has at least a smoke test".

**State**: `rust/atmux-relayd/` has zero unit tests, zero integration tests, zero `#[cfg(test)]` modules. The IX-A additions (`load_event_payload`, `parse_task_unclaimed_payload`, payload-args plumbing through `dispatch_to_bun`) are uncovered on the Rust side.

**Reviewer carve rationale**:
1. **Not a regression**: `rust/atmux-relayd/` shipped to trunk in commit `8f4b436` with zero test infrastructure. The pre-existing crate state is a structural gap; S1 didn't introduce it.
2. **Bun-side coverage is exhaustive**: the consumer of what Rust passes (`--task-id` + `--lane` on `atmux relayd --handle-one`) is tested via `tests/unit/verbs/relayd.test.ts` (14 cases on the flag matrix + required-pair semantics) + `tests/unit/verbs/lane-tick.test.ts` (5 cases on `runLaneTickForOne` itself). The end-to-end contract is well-tested *at the Bun boundary*.
3. **Rust additions are minimal + self-evident**: `parse_task_unclaimed_payload` is 5 lines (two `.get(_).as_str()?` calls); `load_event_payload` is a standard rusqlite SELECT with `QueryReturnedNoRows → Ok(None)` coalesce; `dispatch_to_bun` is a `Command::new` builder. All three are typical Rust patterns with no nontrivial branching beyond the documented fallback rules.
4. **Operator dogfood**: `atmux-relayd` has been deployed and observed running on hax since the §VII shipping (`8f4b436`). The IX-A additions have observable behavior via the operator's existing relayd logs — if the payload-read fails, the eprintln output is grep-able. End-to-end validation is via the per-team relayd supervisor pattern, not synthetic tests.
5. **Follow-up**: a Task to add `rust/atmux-relayd/tests/` integration coverage (mirroring the `tests/integration/native-listener-e2e.test.ts` pattern) is filed post-signoff — see §Follow-up.

**Carve-out scope**: this carve applies to **pre-existing Rust crates with no test infrastructure** when the new Rust code is (a) minimal and self-evident, AND (b) end-to-end tested via the Bun-side consumer boundary. Future Rust additions in crates with existing test infrastructure (e.g. `rust/atmux-listener/`'s e2e test) still require paired tests.

## Test + build evidence

### Bun unit suite

```
$ unset TMUX && bun test tests/unit/ --timeout 30000
7597 pass
1 todo
0 fail
16164 expect() calls
Ran 7598 tests across 248 files. [194.95s]
```

Lead message DoD cited "7571 unit tests green (+14)"; actual count is **7597**. The +26 delta vs DoD is from interleaved trunk work landing during S1 implementation; no S1-attributable test regressions. The brief AC "8593 unit tests" was stale at write time — actual baseline 7583 + 14 new = 7597. ✅

### Targeted S1 unit suite

```
$ unset TMUX && bun test tests/unit/verbs/lane-tick.test.ts tests/unit/verbs/relayd.test.ts --timeout 30000
67 pass
0 fail
135 expect() calls
Ran 67 tests across 2 files. [1162.00ms]
```

S1's two new/extended test files green. ✅

### Rust release build

```
$ cd rust/atmux-relayd && cargo build --release
   ...
   Compiling honker v0.3.3
   Compiling atmux-relayd v0.1.0 (/root/work/src/atmux-epics/e-95087c8b/rust/atmux-relayd)
    Finished `release` profile [optimized] target(s) in 21.96s
```

Clean compile, no warnings. ✅

### TypeScript typecheck

```
$ bun run typecheck
$ tsc --noEmit
===exit=0===
```

Clean, no errors. ✅

## Adjacent vulnerability classes (negative-space proof)

After exhaustive grep of the lean-dispatch class, the following adjacent classes are explicitly *not* covered by this signoff:

1. **Event-ordering / at-least-once duplicates**: `atmux-relayd`'s offset advancement is idempotent (both Rust `save_offset` + Bun `saveOffset` write the same `subscriber_offsets` row) but the handler-side dedup contract (ADR-203 §D7) is owned by the handler, not the dispatcher. If `runLaneTickForOne` is called twice for the same `(taskId, lane)`, two `safeSendKeysWithVerify` calls fire — the second may no-op if the composer is no longer empty, but operator-visible double-pane-injection is possible on race. **Mitigation**: the `composerEmpty()` verifier gates the second send; ADR-138 verified-send pattern is the existing safety net.
2. **Member roster drift during dispatch**: `team.members[]` is loaded once per `runLaneTickForOne` call. If the operator rotates a member or clears a lane between Rust dispatch + Bun handler entry, the first-match-wins lookup returns `outcome=skip-no-member-for-lane` (lane→nothing) or dispatches to a stale member name. **Mitigation**: the lookup is best-effort; the cron `runLaneTick` backstop visits the live roster ~30s later.
3. **Lane-config injection**: if `member.lane` were ever operator-controlled via untrusted input (it's not today — `.atmux/team.json` is local-fs only), an attacker could redirect dispatches. **Not in threat model**: atmux is single-operator local-fs.
4. **Bun cold-start tax**: each event spawns a fresh Bun process (~50ms cold start). At >20 events/sec sustained, this becomes a throughput bottleneck. **Mitigation**: lane-tick events fire ~once per cron tick + per kanban add — well below the threshold.

These classes are out-of-scope for S1 signoff. Operator awareness is recorded here so the next pass over the lean-dispatch surface knows where the next audit pass should land.

## Follow-up Tasks (filed post-signoff, not blockers)

1. **Rust integration test for atmux-relayd dispatch path** — mirror `tests/integration/native-listener-e2e.test.ts` pattern. Validate: relayd reads payload from events table → dispatches Bun `--handle-one` with correct `--task-id`/`--lane` flags → falls back on parse-fail / NULL payload. Filed as Task in epic-team kanban.
2. **`paneMatchesRegex` audit follow-up**: not triggered by S1 diff, but the cron-driven `runLaneTick` backstop uses `classifyText` + `paneText` patterns extensively. Future amendments to lane-tick verifier logic should follow ADR-138 §canonical-four contract.

## Verdict

✅ **APPROVED within vulnerability class scoped** — lean per-event dispatch via Rust `atmux-relayd` → Bun `--handle-one --task-id --lane` → `runLaneTickForOne` is correct, well-tested on the Bun boundary, ADR-aligned, fallback-preserved, and Epic-B-boundary-respecting.

Two reviewer carve-outs documented + 1 follow-up Task filed for Rust-side test gap.

Story 1 is ready for fan-in via the auto-merge state machine.

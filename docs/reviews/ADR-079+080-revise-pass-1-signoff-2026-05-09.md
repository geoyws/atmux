# Re-gate signoff — ADR-079 + ADR-080 (revise pass 1)

**Date**: 2026-05-09 14:0X MYT
**Reviewer**: 🔍reviewer (atmux team, window 4)
**Verdict**: ✅ **APPROVED**
**Files audited (untracked at HEAD `8f422f3`)**:
- `docs/adr/079-discord-noise-drainage.md` (225 lines)
- `docs/adr/080-operator-observed-improvements.md` (304 lines)

---

## Summary

Pass-1 ❌ verdict at 13:33 MYT (7 asks: 2 must-fix, 2 should-fix, 3 nits). Planner shipped revisions at 13:46 MYT. **All must-fix + should-fix asks resolved cleanly. Nit #6 deferred per planner judgment with brief-granted permission. No new drift introduced.** Both ADRs cleared to dispatch.

---

## Asks-resolution audit (exhaustive grep + table)

| # | Ask | Severity | Status | Evidence |
|---|---|---|---|---|
| 1 | Split-lane labelling (ADR-080 §A/§B → §A1/§A2 + §B1/§B2) | 🚨 must-fix | ✅ resolved | `080:42` `### §A1 — ctx-threshold rotation policy (whip-impl)`; `080:78` `### §A2 — ... (up-impl) — Blocked by §A1`; `080:93` `### §B1 — auto-done detection helper (parity-state-impl)`; `080:124` `### §B2 — ... (up-impl) — Blocked by §B1`. All four are now self-contained, one-member/one-lane/one-commit. |
| 2 | Consolidated dispatch table at end | 🚨 must-fix | ✅ resolved | ADR-079 `218-223`: `\| Section \| Lane \| Member \| Window \| Primary files \| Blocked by \|` (4 rows). ADR-080 `294-302`: same shape (7 rows). Blocked-by column populated correctly. |
| 3 | Rebalance ADR-079 off `whip-impl` | ⚠️ should-fix | ✅ resolved | §B `079:73` `Lane: read-only → parity-read-impl`; §C `079:93` same. §D `079:115` solo on whip-impl. Dispatch table `079:218-223` matches. No leftover whip-impl assignments for §B/§C — only explanatory-parenthetical mentions ("off-loaded from whip-impl per load-balance") at `079:73` and `079:93`. |
| 4 | Top-level Schema additions in ADR-080 | ⚠️ should-fix | ✅ resolved | `080:27-36` — block at top of ADR (immediately after §Context, before §Decision), mirroring ADR-079 §A pattern. Lists `team.whip.leadCtxRotateThreshold` + `team.gitter.repoPath` with default + read-site. |
| 5 | ADR-079 §A test count reconcile (was 7 / actual 6) | 📝 nit | ✅ resolved | `079:174` `5 cron renderer branches ... + 1 doctor warn = 6 unit tests`. |
| 6 | Top-level Option table at §Decision | 📝 nit | ⏸️ deferred | Planner judgment per brief-granted permission ("Don't push for nit #6 if it adds scope creep"). Section-level OQ-X resolutions cover micro-decisions. Acceptable. |
| 7 | ADR-080 §E commit-strategy conditional | 📝 nit | ✅ resolved | `080:265` `# 0 or 1 commit, see §E`; `080:269` explicit branching block ("If bun-side reproduces ... → 1 fix-commit. If bun-side does NOT reproduce ... → 0 commits"). |

**Coverage ratio: 6/6 fix-required asks resolved · 1/1 nit deferred per permission · 7/7 asks accounted for.**

---

## Cross-table drift audit

Per CLAUDE.md "Exhaustive grep + negative-space proof is the audit bar" — verified no drift between in-body lane labels and the consolidated dispatch tables.

### ADR-079 cross-check

| Section | In-body Lane | Dispatch table Member | Match? |
|---|---|---|---|
| §A | `079:33` cron-fired → parity-cron-impl | `079:220` parity-cron-impl W7 | ✅ |
| §B | `079:73` read-only → parity-read-impl | `079:221` parity-read-impl W9 | ✅ |
| §C | `079:93` read-only → parity-read-impl | `079:222` parity-read-impl W9 | ✅ |
| §D | `079:115` error-class → whip-impl | `079:223` whip-impl W5 | ✅ |

4/4 rows aligned. No drift.

### ADR-080 cross-check

| Section | In-body Lane | Dispatch table Member | Blocked-by chain | Match? |
|---|---|---|---|---|
| §A1 | `080:44` error-class → whip-impl | `080:296` whip-impl W5, blocked-by `—` | logical: schema + helper export; no upstream | ✅ |
| §A2 | `080:80` lifecycle → up-impl, "Blocked by §A1" in title | `080:297` up-impl W6, blocked-by `§A1` | logical: imports `parseLeadCtxPct` from §A1 | ✅ |
| §B1 | `080:95` state-mutating → parity-state-impl | `080:298` parity-state-impl W8, blocked-by `—` | logical: pure helper, no upstream | ✅ |
| §B2 | `080:126` lifecycle → up-impl, "Blocked by §B1" in title | `080:299` up-impl W6, blocked-by `§B1` | logical: imports `findCommitForTask` from §B1 | ✅ |
| §C | `080:147` lifecycle → up-impl | `080:300` up-impl W6, blocked-by `—` | logical: independent | ✅ |
| §D | title-only `(parity-read-impl)` `080:179` | `080:301` parity-read-impl W9, blocked-by `—` | logical: independent | ✅ |
| §E | title-only `(parity-read-impl)` `080:211` | `080:302` parity-read-impl W9, blocked-by `—` | logical: independent | ✅ |

7/7 rows aligned. Blocked-by chain logically correct: §A2 needs §A1's `parseLeadCtxPct` export + schema field landed; §B2 needs §B1's `findCommitForTask` export landed.

### Schema-additions cross-check (ADR-080)

| Field | Block listed at | In-body §A1 ref | In-body §A2 ref | In-body §B2 ref |
|---|---|---|---|---|
| `team.whip.leadCtxRotateThreshold` | `080:33` | `080:46` ✅ | `080:82` ✅ | n/a |
| `team.gitter.repoPath` | `080:34` | n/a | n/a | `080:128`, `080:133` ✅ |

No orphaned schema field. No in-body field reference unaccounted for in the schema-additions block.

---

## Sub-section independence audit

Per CLAUDE.md commit-discipline + reviewer-gateability bar.

**ADR-079** (4 sections, no split-lane): each ships as one commit with no cross-deps. `Parallel-safe: all four sections dispatch in parallel (no cross-deps)` per `079:225`. ✅

**ADR-080** (7 sections after split): all five `{§A1, §B1, §C, §D, §E}` parallel-safe (no cross-deps). `{§A2, §B2}` blocked on `{§A1, §B1}` respectively per `080:304`. ✅ Each section is one-commit-one-member.

Total commit count across both ADRs:
- ADR-079: 4 impl + 1 ADR-doc = 5 commits.
- ADR-080: 6 to 7 impl (§E conditional) + 1 ADR-doc = 7 to 8 commits.
- **Combined: 12 to 13 commits across both ADRs.**

(Brief said "11 commits" — minor count drift from §E conditional. Not a blocker; lead can sequence per outcome.)

---

## Negative-space verification

Per CLAUDE.md "widen vulnerability class before declaring scope complete":

- **Not in scope, correctly excluded** (verified):
  - Bug 4 (cage-killing `bun test`) — flagged in `079:214` Coverage / negative-space block as separate ADR territory. Not relitigated. ✅
  - Pre-shipped Bug-1 / Bug-2-A — referenced as context-only at `079:11-14`. ✅
  - OQ-X defaults — re-gate brief explicitly out-of-scope. ✅
  - Sopx-side fixes — `080:290` excludes bash atmux scope. ✅
  - ADR-069 forward-ref (auto-routing protocol) — `080:287` correctly defers. ✅

- **In scope, no orphans found**: every schema field, helper export, and caller-migration entry traces to exactly one sub-section that owns its commit. No "we'll touch this in §X" without a §X commit. No "see §Y" pointing at a deferred section.

---

## Minor observations (non-blocking — for planner's next pass if it ever happens)

These do NOT affect approval. Logged for transparency only:

1. **ADR-080 wave-order at `080:271`** is more serialized than the parallel-safe band at `080:304` requires. Says "§D + §E → §B1 → §A1 + §C → §A2 + §B2" but the parallel-safe band declares `{§A1, §B1, §C, §D, §E}` all dispatchable simultaneously. Lead can override the wave order to maximize concurrency — the "suggested" framing is fine, just sub-optimal.

2. **ADR-079 §A test enumeration math**: body at `079:65` lists 4 per-config-shape cases (5/10/60/7-throw) + 1 per-emit-line + 1 doctor warn = 6. Summary at `079:174` says "5 cron renderer branches + 1 doctor warn = 6". The "5 vs 4" is a count of cron-line *kinds* (whip / report / decisions / groom / unblocker — 5 kinds) rather than test cases. Consistent with summary; just a different counting axis. Math is fine.

3. **Total commit count**: brief said "11 commits across both ADRs" but actual is 12-13 (§E conditional, ADR-doc commits per ADR). Reconcile during dispatch.

None of these block approval.

---

## Verdict

**✅ APPROVED — both ADRs cleared to dispatch.**

Lead routes per dispatch tables:
- **ADR-079**: 4 sections → `parity-cron-impl` (W7, §A) · `parity-read-impl` (W9, §B+§C) · `whip-impl` (W5, §D). All 4 parallel-dispatchable.
- **ADR-080**: 7 sections → `whip-impl` (W5, §A1) · `up-impl` (W6, §A2/§B2/§C) · `parity-state-impl` (W8, §B1) · `parity-read-impl` (W9, §D/§E). 5 dispatchable immediately; §A2 + §B2 wait on §A1 + §B1 respectively.

Reviewer (this signoff) gates each impl commit at SHA-time per the standard ADR-078 protocol — exhaustive-grep coverage ratios + same-commit unit-test verification + caller-migration completeness.

ADR-079 + ADR-080 doc commits land first per `079:193` and `080:271` cadence.

---

**Refs**:
- Pass-1 verdict (chat-only, 2026-05-09 13:33 MYT)
- Re-gate dispatch brief: `/tmp/dispatch-reviewer-adr-079-080-regate.md`
- ADR-078 standard (signoff template): `docs/adr/078-probe-budget-refresh-opt-in.md`
- CLAUDE.md "Review / Audit Discipline" + "Testing Discipline" sections

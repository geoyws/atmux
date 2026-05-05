# ADR-026: Parity matrix iter-1 scope (refs ADR-009 §3)

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

Phase 1 shipped the parity harness foundation per ADR-009 §3 — five sequential commits (`1f9f427` → `66d495a`) landing **1521 LOC across 12 files** under `tests/parity/`:

```
tests/parity/
  runner.ts              318 LOC  — Bun.spawn wrapper, 5-channel capture (stdout/stderr/exit/fs/discord)
  compare.ts             282 LOC  — semantic diff per ADR-009 §3 table
  intercept-discord.ts   123 LOC  — env-override webhook recorder (ADR-008-owned)
  matrix.ts               47 LOC  — PARITY_MATRIX type + empty array
  index.test.ts           59 LOC  — bun:test entry, iterates PARITY_MATRIX
  fixtures/factory.ts    101 LOC  — makeFixture() — `minimal` working, `lifecycle` + `multi-team` throw
  + 6 per-verb skeletons: version (active), unknown-verb (active), init/start/send/add-member (test.todo)
  README.md
```

Status at Phase 2 close (HEAD `bd69735`):

- `bun test tests/parity` → **2 pass / 4 todo / 0 fail** (version + unknown-verb green; 4 verb skeletons parked).
- `PARITY_MATRIX` is `[]` — the matrix-driven dispatch in `index.test.ts` runs zero rows (the early-return on empty matrix is intentional skeleton behaviour per ADR-009 §3).
- `index.test.ts::materializeFixture` + `cleanupFixture` are throw-not-implemented stubs awaiting matrix wire-up (lines 46–58).
- `fixtures/factory.ts:75-86` — `lifecycle` + `multi-team` presets `throw new Error("not yet implemented")`. Only `minimal` is wired.
- 25/25 verbs are TS-ported (Phase 2 close per HANDOFF.md) — every verb has a real TS implementation that the harness can spawn.

PLAN.md §8.4 (functional parity) calls for the harness to "exercise every cron-fired scenario (whip, report, decisions-digest, groom) and every interactive verb against fixture `.atmux/` dirs simulating the 4 prod teams' state shapes". That's the Phase 3 north-star — but porting all of it in iteration 1 would re-trip the maximalist-port trap that ADR-022 (whip) and ADR-019 (doctor) carved out of.

The actual Phase-3 iteration-1 gap is **matrix population + `lifecycle` fixture preset implementation** — NOT a redesign of the harness shape (ADR-009 §3 is the canonical contract and stands).

This ADR fixes the iter-1 scope before code lands. Analogous to ADR-022's V-25 whip carve-out: name what ports now, name what defers, attach durable re-enable handles to each deferred row.

## Decision

V-26 parity-matrix iter-1 scope is the **matrix-row population for the 5 existing verb skeletons** plus the **`lifecycle` fixture preset implementation** plus **4 state-mutating verb rows** (task / dispatch / inbox / done) that exercise the kanban UPDATE-path vulnerability class (CLAUDE.md "widen vulnerability class").

**This ADR does NOT redesign the harness shape.** ADR-009 §3 is the canonical contract for stdout/stderr/exit/fs/discord capture, diff strategies (timestamp-mask regex, JSON Zod-canonical, byte-exact, inbox tuple-match), runner contract types (`ParityRun` / `Divergence` / `runVerb` / `compare`), fixture factory API, ADR-008-owned Discord webhook interception, CI flow, and the Bun 1.3.13 threshold-gap workaround. That contract is implemented and operational. Iter 1 fills the matrix; the shape is fixed.

| Item | Status | Reason |
|---|---|---|
| `PARITY_MATRIX` rows for 5 existing verb skeletons (version / unknown-verb / init / start / send / add-member) | ✅ iter-1 | Skeletons exist and reference `makeFixture({preset:"minimal"})`. Adding matrix rows + flipping `index.test.ts`'s `materializeFixture` stub from throw → factory call activates matrix-driven dispatch. Test files stay alongside the matrix entries (decision-rationale: standalone files have rich docstrings + per-verb sanity rails the matrix row alone can't carry — keep both per "structural honesty" until matrix expressivity catches up). |
| `lifecycle` fixture preset (4-member team mirroring `tests/e2e/lifecycle.bats:13-18`) | ✅ iter-1 | Replaces `factory.ts:75-86` throw. Members: `lead` (team-lead), `reviewer` (reviewer), `gitter` (gitter), `w1` (member). All `tui:"shell"`, `model:"default"`, `cwd: <fixture-tmpdir>`. Materialises `.atmux/{team.json,kanban.json,driver-inbox.md,inboxes/,logs/,state/}` with the same shape `lifecycle.bats:setup()` builds. Zod-validated per ADR-005 (interim schemas in `tests/parity/fixtures/schemas.ts` until `src/schema/*` lands). Unblocks state-mutating verb parity. |
| 4 state-mutating verb rows: `task add` / `dispatch` / `inbox` / `done` (using `lifecycle` preset) | ✅ iter-1 | Highest-value parity coverage class — these exercise the kanban UPDATE-path, not just READ-path. CLAUDE.md "widen vulnerability class": cross-channel UPDATE coverage catches divergences READ-only verbs hide. Rows added to `PARITY_MATRIX`; corresponding test files NOT created (matrix dispatch is sufficient for the deterministic happy-path; the standalone-file pattern is reserved for verbs needing rich sanity rails). |
| `index.test.ts::materializeFixture` + `cleanupFixture` stub flip | ✅ iter-1 | Mechanical — replace the two throws (lines 46–58) with `makeFixture({preset: row.fixturePreset})` + `handle.cleanup()` calls. Lands inside the matrix wire-up commit. |
| Multi-team fixture preset (4-prod-team variants: atmux / sopx-mvp / ifca_aux / unum) | ❌ iter-2 | PLAN.md §8.4 north-star, but iter 1 doesn't need it. **Re-enable handle:** when CI surfaces a 4-team-divergence demand OR when porters add a verb whose behaviour varies by team-name (tenant-isolation logic, team-scoped state-dir resolution). Stays as `throw new Error("not yet implemented")` in factory.ts. |
| Cron-fired scenario parity (whip / report / decisions-digest / groom) | ❌ iter-2+ | These verbs run from cron with an implicit time-of-day argument; parity testing them requires a cron-aware test runner that injects a frozen clock. **Re-enable handle:** when `tests/parity/cron-runner.ts` lands (separate ADR; not scoped here). Whip + report ports already exist (V-25 + V-13); their parity tests just need the cron harness. |
| Remaining 16 verbs not in iter-1 matrix (attach / dashboard / doctor / handoff / help / outbox / pause / reconfigure / reply / resume / rotate / rotate-lead / status / stop / tell-lead / up / wizard / etc.) | ❌ iter-2+ | Incremental matrix adds. **Re-enable handle:** ADR-026 follow-up commits add rows in priority order (operator-touched verbs first: status / doctor / handoff; then config-touched: reconfigure / rotate-lead; then read-only: outbox / dashboard). No single ADR-style ratification needed — matrix adds are mechanical. |
| CI gate wiring (`bun test:parity:<verb>` script entries; `package.json` scripts) | ❌ iter-2 | PLAN.md §9 reviewer-gate item 4 ("`bun test:parity:<verb>` for any verb touched"). Requires iter-1 matrix shape stabilising before scripts crystallise. **Re-enable handle:** ADR-009 §6 CI-flow update + a `package.json scripts` block defining one entry per verb in the matrix (or a single `bun test:parity` that uses path-filter regex). Iter 2. |
| `tests/parity/**` inclusion in lcov-gate coverage denominator | ❌ iter-2 | ADR-009 §2 explicitly excludes `tests/**` from the 100% coverage gate. Iter 1 keeps that exclusion — the harness is *test infrastructure*, and gating its own coverage is meta-circular. **Re-enable handle:** if porters want explicit coverage on `runner.ts` / `compare.ts` because their bug-blast-radius is "every parity test silently false-greens", carve them out per-file via an explicit `tests/parity/runner.ts` entry in the tracked set. Separate ADR-009 amendment if pursued. |

Rendering: matrix-driven `bun:test` rows produce one row label per `(verb, args, fixturePreset)` tuple; comparator output is `Divergence[]` per ADR-009 §3. Failures emit the 5-element bug-report shape (CLAUDE.md test-finding pattern).

Exit codes:
- `0` — matrix ran, all rows green (zero divergences).
- nonzero — at least one row's `compare()` returned `Divergence[].length > 0`. Reviewer triages per ADR-009 §3.

## NOT in scope of THIS commit (per ADR-022 / ADR-025 craftsmanship pattern)

- **Matrix row authoring** — this ADR pins the iter-1 row set; the actual `PARITY_MATRIX = [...]` lines land in commit 2 (`feat(parity): wire PARITY_MATRIX — 5 existing verb tests as matrix rows`).
- **Lifecycle fixture preset implementation** — this ADR pins the 4-member shape; the `factory.ts:75-86` replacement lands in commit 3 (`feat(parity): implement lifecycle fixture preset (4-member team mirroring lifecycle.bats)`).
- **State-mutating verb row additions** — this ADR names the 4 verbs; the rows land in commit 4 (`test(parity): 4 state-mutating verb rows using lifecycle preset (task/dispatch/inbox/done)`).
- **ADR-009 §3 amendment** — the canonical shape contract is unchanged; if iter 2 reveals a missing channel (e.g. environment variables read by the verb), that's an ADR-009 §3 amendment, not an ADR-026 expansion.
- **`test.todo` → `test` flip on init / start / send / add-member skeletons** — those flips are scoped commits owned by the verb-porter responsible for each (the test.todo body's reconciliation expectations belong with the porter who owns the bash↔TS error-rendering decision; e.g. `start.test.ts` defers `bash exit 1` vs `TS ConfigError exits 78` to the start-verb porter per its docstring at lines 92–98). Iter-1 matrix dispatch tests the **happy path** alongside the standalone files; the standalone files' error-path test.todo bodies are independent work.
- **Bash side `ATMUX_DISCORD_RECORDER` honour** — ADR-008 owns this; bash atmux's recorder support is a separate porter-B follow-up (per ADR-009 §3). Iter-1 matrix rows for verbs that don't emit Discord (the 5 starting verbs are all non-Discord-emitting in their basic invocations) don't need it.

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr,plan): ADR-026 — parity matrix iter-1 scope (refs ADR-009 §3)`**: this ADR file + PLAN.md §7 backlog row + PLAN.md §8.4 footnote pointing at the iter-1 carve-out.
2. **Commit B — `feat(parity): wire PARITY_MATRIX — 5 existing verb tests as matrix rows`**: 5 rows added to `tests/parity/matrix.ts`; `index.test.ts::materializeFixture` + `cleanupFixture` stubs flipped to `makeFixture()` calls; standalone test files stay alongside.
3. **Commit C — `feat(parity): implement lifecycle fixture preset (4-member team mirroring lifecycle.bats)`**: `tests/parity/fixtures/factory.ts:75-86` lifecycle case replaced with the 4-member team materialisation. Multi-team STAYS stubbed.
4. **Commit D — `test(parity): 4 state-mutating verb rows using lifecycle preset (task/dispatch/inbox/done)`**: 4 matrix rows added using `fixturePreset: "lifecycle"`.

Each commit standalone-passes typecheck + 100% coverage gate. Reviewer gates each per the 8-check protocol (PLAN.md §9). Reviewer scans this ADR against ADR-009 to verify it's a scope carve-out, NOT a shape redesign.

## Out of plan / future work

- **Iter 2 matrix expansion.** Each deferred row above is a durable handle; iter-2 commits flip individual rows from ❌ → ✅ as porters land coverage. No new ADR needed for incremental adds — ADR-026 is the rationale source.
- **Cron-aware test runner.** When iter-2+ wants whip / report / decisions-digest / groom parity, a separate harness (`tests/parity/cron-runner.ts`) injects a frozen clock + simulated cron tick. Likely its own ADR (ADR-027 or later).
- **Multi-team fixture variants.** When a verb's behaviour varies by team-name OR when CI surfaces 4-team divergence, the factory's `multi-team` case implements per-team `.atmux/` shapes. PLAN.md §8.4's north-star realised here.
- **CI gate wiring.** `bun test:parity` / `bun test:parity:<verb>` script entries land alongside iter-2 matrix expansion, not inside iter 1.
- **Standalone-test-file fate.** Iter 1 keeps both standalone files + matrix rows. If matrix expressivity grows (e.g. row-level sanity rails, per-row before/after hooks), the standalone files become redundant and a follow-up commit drops them. Decision deferred — no rush.

## Consequences

- **Iter 1 ships ~50 LOC of matrix-row entries + ~80 LOC of lifecycle preset implementation** instead of the ~500 LOC the original Phase-3 dispatch implied. ~75% reduction by avoiding shape-redesign work that ADR-009 §3 already did.
- **Each deferred row is a durable re-enable handle** tied to a specific iter-2+ trigger (CI demand, cron runner ADR, per-verb porter follow-up). No "TODO" rot.
- **ADR-009 §3 stays as the canonical shape contract.** Future porters who want to add a channel (env-var capture, file-mode tracking, sigchld signal capture) amend ADR-009, not ADR-026.
- **Phase 3 makes immediate parity progress** — 5 existing skeletons go from `test.todo` parked to matrix-active, and 4 state-mutating verbs gain UPDATE-path coverage in iter 1. Reviewer + auditor get real divergence signals to triage from day one of iter 2.
- **Standalone-test-file pattern is preserved** for verbs that need rich sanity rails (per-verb error-path expectations, multi-arg variants). Matrix rows are sufficient for happy-path deterministic verbs; the two coexist without conflict.
- **Lifecycle preset becomes the hub** for state-mutating verb parity. Once it lands, the marginal cost of adding a state-mutating verb's matrix row drops to ~5 LOC (one tuple). Cron / multi-team presets follow the same pattern in iter 2+.

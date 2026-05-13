# ADR-119: Parity matrix iter-1 scope (refs ADR-102 §3)

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

Phase 1 shipped the parity harness foundation per ADR-102 §3 — five sequential commits (`1f9f427` → `66d495a`) landing **1521 LOC across 12 files** under `tests/parity/`:

```
tests/parity/
  runner.ts              318 LOC  — Bun.spawn wrapper, 5-channel capture (stdout/stderr/exit/fs/discord)
  compare.ts             282 LOC  — semantic diff per ADR-102 §3 table
  intercept-discord.ts   123 LOC  — env-override webhook recorder (ADR-101-owned)
  matrix.ts               47 LOC  — PARITY_MATRIX type + empty array
  index.test.ts           59 LOC  — bun:test entry, iterates PARITY_MATRIX
  fixtures/factory.ts    101 LOC  — makeFixture() — `minimal` working, `lifecycle` + `multi-team` throw
  + 6 per-verb skeletons: version (active), unknown-verb (active), init/start/send/add-member (test.todo)
  README.md
```

Status at Phase 2 close (HEAD `bd69735`):

- `bun test tests/parity` → **2 pass / 4 todo / 0 fail** (version + unknown-verb green; 4 verb skeletons parked).
- `PARITY_MATRIX` is `[]` — the matrix-driven dispatch in `index.test.ts` runs zero rows (the early-return on empty matrix is intentional skeleton behaviour per ADR-102 §3).
- `index.test.ts::materializeFixture` + `cleanupFixture` are throw-not-implemented stubs awaiting matrix wire-up (lines 46–58).
- `fixtures/factory.ts:75-86` — `lifecycle` + `multi-team` presets `throw new Error("not yet implemented")`. Only `minimal` is wired.
- 25/25 verbs are TS-ported (Phase 2 close per HANDOFF.md) — every verb has a real TS implementation that the harness can spawn.

PLAN.md §8.4 (functional parity) calls for the harness to "exercise every cron-fired scenario (whip, report, decisions-digest, groom) and every interactive verb against fixture `.atmux/` dirs simulating the 4 prod teams' state shapes". That's the Phase 3 north-star — but porting all of it in iteration 1 would re-trip the maximalist-port trap that ADR-115 (whip) and ADR-112 (doctor) carved out of.

The actual Phase-3 iteration-1 gap is **matrix population + `lifecycle` fixture preset implementation** — NOT a redesign of the harness shape (ADR-102 §3 is the canonical contract and stands).

This ADR fixes the iter-1 scope before code lands. Analogous to ADR-115's V-25 whip carve-out: name what ports now, name what defers, attach durable re-enable handles to each deferred row.

## Decision

V-26 parity-matrix iter-1 scope is the **matrix-row population for the 2 currently-parity-green verb skeletons** (version + unknown-verb) plus the **`lifecycle` fixture preset implementation**.

Originally the scope also included **4 state-mutating verb rows** (`task add` / `dispatch` / `inbox` / `done`). Commit-4 prep (2026-05-05) discovered the happy-paths are NON-deterministic on random IDs + epoch timestamps and require ADR-120 (parity channel-mask contract) + `compare.ts` mask infrastructure + `index.test.ts` per-side fixture cloning before they can land green — row 3 below is relabeled `❌ iter-2` accordingly, and the 4 rows roll into iter-2 lead-off. See this commit's body for the probe trace.

**This ADR does NOT redesign the harness shape.** ADR-102 §3 is the canonical contract for stdout/stderr/exit/fs/discord capture, diff strategies (timestamp-mask regex, JSON Zod-canonical, byte-exact, inbox tuple-match), runner contract types (`ParityRun` / `Divergence` / `runVerb` / `compare`), fixture factory API, ADR-101-owned Discord webhook interception, CI flow, and the Bun 1.3.13 threshold-gap workaround. That contract is implemented and operational. Iter 1 fills the matrix; the shape is fixed.

| Item | Status | Reason |
|---|---|---|
| `PARITY_MATRIX` rows for 2 currently-parity-green verbs (version + unknown-verb) | ✅ iter-1 | The 6 standalone test files exist (version + unknown-verb active; init / start / send / add-member parked as `test.todo`). Adding matrix rows for the 2 active verbs + flipping `index.test.ts`'s `materializeFixture` stub from throw → factory call activates matrix-driven dispatch. The 4 `test.todo` skeletons stay parked — see new "Reconciliation of bash↔TS error-rendering divergence" deferred row below. Test files stay alongside the matrix entries (decision-rationale: standalone files have rich docstrings + per-verb sanity rails the matrix row alone can't carry — keep both per "structural honesty" until matrix expressivity catches up). |
| `lifecycle` fixture preset (4-member team mirroring `tests/e2e/lifecycle.bats:13-18`) | ✅ iter-1 | Replaces `factory.ts:75-86` throw. Members: `lead` (team-lead), `reviewer` (reviewer), `gitter` (gitter), `w1` (member). All `tui:"shell"`, `model:"default"`, `cwd: <fixture-tmpdir>`. Materialises `.atmux/{team.json,kanban.json,driver-inbox.md,inboxes/,logs/,state/}` with the same shape `lifecycle.bats:setup()` builds. Zod-validated per ADR-098 (interim schemas in `tests/parity/fixtures/schemas.ts` until `src/schema/*` lands). Unblocks state-mutating verb parity. |
| State-mutating verb happy-path rows (`task add` / `dispatch` / `inbox` / `done`) using `lifecycle` preset | ✅ iter-2 done | Iter-1 in-scope at ADR authoring; relabeled `❌ iter-2` during commit-4 prep (2026-05-05) per `/tmp/parity-probe` trace (random 8-hex IDs + Unix-epoch `createdAt`; `compare.ts` had no state-after JSON-field masks; parallel `runVerb` raced shared-fixture writes). Iter-2 delivered via `1890278` — 4 `task add` VARIANT rows (bare / `--priority` / `--body` / `--assignee`) using `lifecycle` preset, exercising the INSERT mutation class with channel-mask elision (random ID stdout + bash-only confirmation stderr + `kanban.tasks[*].{id,createdAt}` state-after); enabled by `766c213` (ADR-120 contract), `14644d6` (`compare.ts` mask infra + `ParityRow.mask`), `fa59f46` (per-side fixture cloning). Verb-set deviation from original 4-distinct: `dispatch` / `inbox` / `done` need iter-3 vocabulary (UPDATE-with-dependency / channel-asymmetric stderr / multi-file state-after) — captured in §Consequences iter-3 entry list. |
| `index.test.ts::materializeFixture` + `cleanupFixture` stub flip | ✅ iter-1 | Mechanical — replace the two throws (lines 46–58) with `makeFixture({preset: row.fixturePreset})` + `handle.cleanup()` calls. Lands inside the matrix wire-up commit. |
| Multi-team fixture preset (4-prod-team variants: atmux / sopx-mvp / ifca_aux / unum) | ❌ iter-2 | PLAN.md §8.4 north-star, but iter 1 doesn't need it. **Re-enable handle:** when CI surfaces a 4-team-divergence demand OR when porters add a verb whose behaviour varies by team-name (tenant-isolation logic, team-scoped state-dir resolution). Stays as `throw new Error("not yet implemented")` in factory.ts. |
| Cron-fired scenario parity (whip / report / decisions-digest / groom) | ❌ iter-2+ | These verbs run from cron with an implicit time-of-day argument; parity testing them requires a cron-aware test runner that injects a frozen clock. **Re-enable handle:** when `tests/parity/cron-runner.ts` lands (separate ADR; not scoped here). Whip + report ports already exist (V-25 + V-13); their parity tests just need the cron harness. |
| Remaining 16 verbs not in iter-1 matrix (attach / dashboard / doctor / handoff / help / outbox / pause / reconfigure / reply / resume / rotate / rotate-lead / status / stop / tell-lead / up / wizard / etc.) | ❌ iter-2+ | Incremental matrix adds. **Re-enable handle:** ADR-119 follow-up commits add rows in priority order (operator-touched verbs first: status / doctor / handoff; then config-touched: reconfigure / rotate-lead; then read-only: outbox / dashboard). No single ADR-style ratification needed — matrix adds are mechanical. |
| CI gate wiring (`bun test:parity:<verb>` script entries; `package.json` scripts) | ❌ iter-2 | PLAN.md §9 reviewer-gate item 4 ("`bun test:parity:<verb>` for any verb touched"). Requires iter-1 matrix shape stabilising before scripts crystallise. **Re-enable handle:** ADR-102 §6 CI-flow update + a `package.json scripts` block defining one entry per verb in the matrix (or a single `bun test:parity` that uses path-filter regex). Iter 2. |
| `tests/parity/**` inclusion in lcov-gate coverage denominator | ❌ iter-2 | ADR-102 §2 explicitly excludes `tests/**` from the 100% coverage gate. Iter 1 keeps that exclusion — the harness is *test infrastructure*, and gating its own coverage is meta-circular. **Re-enable handle:** if porters want explicit coverage on `runner.ts` / `compare.ts` because their bug-blast-radius is "every parity test silently false-greens", carve them out per-file via an explicit `tests/parity/runner.ts` entry in the tracked set. Separate ADR-102 amendment if pursued. |
| Reconciliation of bash↔TS error-rendering divergence (init / start / send / add-member) | ✅ iter-2 done | Probe at `/tmp/parity-probe` (2026-05-05) confirmed divergence on no-team config-error path: bash emits `💥 atmux no team.json at <p> — run 'atmux init' first`/exit 1; TS emits `atmux: config: no team.json at <p> (hint: run 'atmux init' first)`/exit 78 (BSD `EX_CONFIG`). George chose Option B (parity-mask the noise; ADR-099 stands — TS keeps BSD sysexits + structured-tag stderr; bash side frozen). Iter-2 delivered via `a2fcef6` — 4 error-rendering matrix rows (init `lifecycle` already-initialized; start/send/add-member `minimal` no-team) with 3-pattern stderr mask: `(💥 atmux \|atmux: \S+: )` prefix divergence + `(\.bash\|\.ts)(?=\/\.atmux\/)` per-side fixture-clone path suffix (per `fa59f46`) + `(?: — \| \(hint: )run 'atmux init' first\)?` bash em-dash vs TS parens hint phrasing; plus `exitCode: true` channel skip per ADR-099 sysexits divergence. 2-pattern variant for init (no hint divergence — both sides emit identical em-dash + `— pass --force`). |

Rendering: matrix-driven `bun:test` rows produce one row label per `(verb, args, fixturePreset)` tuple; comparator output is `Divergence[]` per ADR-102 §3. Failures emit the 5-element bug-report shape (CLAUDE.md test-finding pattern).

Exit codes:
- `0` — matrix ran, all rows green (zero divergences).
- nonzero — at least one row's `compare()` returned `Divergence[].length > 0`. Reviewer triages per ADR-102 §3.

## NOT in scope of THIS commit (per ADR-115 / ADR-118 craftsmanship pattern)

- **Matrix row authoring** — this ADR pins the iter-1 row set; the actual `PARITY_MATRIX = [...]` lines land in commit 2 (`feat(parity): wire PARITY_MATRIX — 5 existing verb tests as matrix rows`).
- **Lifecycle fixture preset implementation** — this ADR pins the 4-member shape; the `factory.ts:75-86` replacement lands in commit 3 (`feat(parity): implement lifecycle fixture preset (4-member team mirroring lifecycle.bats)`).
- **State-mutating verb row additions** — original commit-4 plan; commit-4 prep relabeled the row to `❌ iter-2` (see Decision §row 3 + this commit's body for the discovery). Iter-2 lead-off after ADR-120 + `compare.ts` masks + `index.test.ts` per-side fixture cloning land.
- **ADR-102 §3 amendment** — the canonical shape contract is unchanged; if iter 2 reveals a missing channel (e.g. environment variables read by the verb), that's an ADR-102 §3 amendment, not an ADR-119 expansion.
- **`test.todo` → `test` flip on init / start / send / add-member skeletons** — those flips are scoped commits owned by the verb-porter responsible for each (the test.todo body's reconciliation expectations belong with the porter who owns the bash↔TS error-rendering decision; e.g. `start.test.ts` defers `bash exit 1` vs `TS ConfigError exits 78` to the start-verb porter per its docstring at lines 92–98). Iter-1 matrix dispatch tests the **happy path** alongside the standalone files; the standalone files' error-path test.todo bodies are independent work.
- **Bash side `ATMUX_DISCORD_RECORDER` honour** — ADR-101 owns this; bash atmux's recorder support is a separate porter-B follow-up (per ADR-102 §3). Iter-1 matrix rows for verbs that don't emit Discord (the 5 starting verbs are all non-Discord-emitting in their basic invocations) don't need it.

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr,plan): ADR-119 — parity matrix iter-1 scope (refs ADR-102 §3)`**: this ADR file + PLAN.md §7 backlog row + PLAN.md §8.4 footnote pointing at the iter-1 carve-out.
2. **Commit B — `feat(parity): wire PARITY_MATRIX — 5 existing verb tests as matrix rows`**: 5 rows added to `tests/parity/matrix.ts`; `index.test.ts::materializeFixture` + `cleanupFixture` stubs flipped to `makeFixture()` calls; standalone test files stay alongside.
3. **Commit C — `feat(parity): implement lifecycle fixture preset (4-member team mirroring lifecycle.bats)`**: `tests/parity/fixtures/factory.ts:75-86` lifecycle case replaced with the 4-member team materialisation. Multi-team STAYS stubbed.
4. **Commit D — `docs(adr-bun): ADR-119 update — state-mutating non-determinism + iter-2`**: this update — relabel state-mutating row from `✅ iter-1` → `❌ iter-2`, add re-enable handle pointing at ADR-120 + `compare.ts` masks + `index.test.ts` per-side fixture cloning, append iter-1 actual delivery summary to Consequences. Original commit-4 plan (4 matrix rows) deferred to iter-2 lead-off (delivered iter-2; rows 3 + 6 closed — see §Consequences "Iter-2 actual delivery").

Each commit standalone-passes typecheck + 100% coverage gate. Reviewer gates each per the 8-check protocol (PLAN.md §9). Reviewer scans this ADR against ADR-102 to verify it's a scope carve-out, NOT a shape redesign.

## Out of plan / future work

- **Iter 2 matrix expansion.** Each deferred row above is a durable handle; iter-2 commits flip individual rows from ❌ → ✅ as porters land coverage. No new ADR needed for incremental adds — ADR-119 is the rationale source.
- **Cron-aware test runner.** When iter-2+ wants whip / report / decisions-digest / groom parity, a separate harness (`tests/parity/cron-runner.ts`) injects a frozen clock + simulated cron tick. Likely its own ADR (ADR-120 or later).
- **Multi-team fixture variants.** When a verb's behaviour varies by team-name OR when CI surfaces 4-team divergence, the factory's `multi-team` case implements per-team `.atmux/` shapes. PLAN.md §8.4's north-star realised here.
- **CI gate wiring.** `bun test:parity` / `bun test:parity:<verb>` script entries land alongside iter-2 matrix expansion, not inside iter 1.
- **Standalone-test-file fate.** Iter 1 keeps both standalone files + matrix rows. If matrix expressivity grows (e.g. row-level sanity rails, per-row before/after hooks), the standalone files become redundant and a follow-up commit drops them. Decision deferred — no rush.

## Consequences

- **Iter 1 ships ~50 LOC of matrix-row entries + ~80 LOC of lifecycle preset implementation** instead of the ~500 LOC the original Phase-3 dispatch implied. ~75% reduction by avoiding shape-redesign work that ADR-102 §3 already did.
- **Each deferred row is a durable re-enable handle** tied to a specific iter-2+ trigger (CI demand, cron runner ADR, per-verb porter follow-up). No "TODO" rot.
- **ADR-102 §3 stays as the canonical shape contract.** Future porters who want to add a channel (env-var capture, file-mode tracking, sigchld signal capture) amend ADR-102, not ADR-119.
- **Phase 3 makes immediate parity progress** — 5 existing skeletons go from `test.todo` parked to matrix-active, and 4 state-mutating verbs gain UPDATE-path coverage in iter 1. Reviewer + auditor get real divergence signals to triage from day one of iter 2.
- **Standalone-test-file pattern is preserved** for verbs that need rich sanity rails (per-verb error-path expectations, multi-arg variants). Matrix rows are sufficient for happy-path deterministic verbs; the two coexist without conflict.
- **Lifecycle preset becomes the hub** for state-mutating verb parity. Once it lands, the marginal cost of adding a state-mutating verb's matrix row drops to ~5 LOC (one tuple). Cron / multi-team presets follow the same pattern in iter 2+.

### Iter-1 actual delivery (4 commits)

- `f86f3da` — `docs(adr,plan): ADR-119 — parity matrix iter-1 scope (refs ADR-102 §3)` — this ADR.
- `8e82ed2` — `feat(parity): wire PARITY_MATRIX with version + unknown-verb (2 rows; init/start/send/add-member deferred per ADR-119)` — matrix-driven dispatch active for 2 verbs.
- `38bb902` — `feat(parity): implement lifecycle fixture preset (4-member team mirroring lifecycle.bats)` — `factory.ts:75-86` throw replaced; Zod-validated 4-member materialisation.
- This commit — `docs(adr-bun): ADR-119 update — state-mutating non-determinism + iter-2` — captures commit-4-prep discovery and relabels row 3.

### Iter-2 lead-off entry list

1. ADR-120 author — parity channel-mask contract (covers BOTH error-rendering masks for `init` / `start` / `send` / `add-member` per row 6 AND state-after JSON-field masks for state-mutating verbs per row 3).
2. `compare.ts` mask infrastructure — per-channel masking hooks per ADR-120 (timestamp regex + JSON field-elision for `id` / `createdAt`).
3. `index.test.ts` per-side fixture cloning — addresses parallel `runVerb` race per `version.test.ts:46-50` limitation.
4. 4 state-mutating happy-path rows (TaskList #12 — `task add` / `dispatch` / `inbox` / `done`).
5. 4 error-rendering masks for row 6 verbs (`init` / `start` / `send` / `add-member`).

### Iter-2 actual delivery (5 commits)

- `766c213` — `docs(adr,plan): ADR-120 — parity channel-mask contract (Option B per George)` — divergence-class taxonomy (error-rendering + state-after) + 4-channel mask config + reviewer-grep binding rule with named target.
- `14644d6` — `feat(parity): channel-mask infrastructure (compare.ts + ParityRow.mask)` — `ChannelMask` type + 4 helpers (`applyChannelMask` / `applyStateAfterMasks` / `parseStateAfterPath` / `elideAtPath`) + `STATE_AFTER_MASKED_SENTINEL` + 18 self-tests (100% branch coverage on touched helpers).
- `fa59f46` — `fix(parity): per-side fixture cloning (resolves runVerb state-write race)` — `index.test.ts` clones fixture into `.bash` / `.ts` siblings before parallel `runVerb`; resolves the `version.test.ts:46-50` race-write limitation.
- `1890278` — `test(parity): 4 task-add rows with masks (state-mutating, ADR-119 row 3)` — closes row 3 via 4 `task add` VARIANT rows (INSERT class, lifecycle preset). Verb-set deviation from original 4-distinct (`dispatch` / `inbox` / `done`) accepted by lead; deferred to iter-3 entry list below.
- `a2fcef6` — `test(parity): 4 error-rendering rows with masks (closes ADR-119 row 6)` — closes row 6 via 3-pattern stderr regex (prefix + path-suffix + hint-phrasing) + `exitCode: true` skip per ADR-099. Lead-spec verb-set integrity restored.

### Iter-3 lead-off entry list

1. UPDATE/DELETE/channel-asymmetric state-mutating verbs — `dispatch <member> <id>` (preset extension for pre-seeded task + tmux side effects), `inbox <member>` (channel-asymmetric stderr — bash emits stylistic header, TS doesn't), `done <id>` (UPDATE-with-dependency on dispatch chain or manual seed). Captures `1890278`'s verb-set deviation as durable handle. Adds new mask sub-classes (channel-asymmetric stderr / header-rendering elision) beyond iter-2's vocabulary.
2. Multi-team fixture preset (atmux / sopx-mvp / ifca_aux / unum) per PLAN.md §8.4 north-star. **Re-enable handle:** when CI surfaces 4-team-divergence demand OR a verb's behaviour varies by team-name (tenant-isolation, team-scoped state-dir resolution).
3. Cron-fired scenario parity (whip / report / decisions-digest / groom). Requires `tests/parity/cron-runner.ts` with frozen-clock injection (separate ADR; not scoped here).
4. Remaining 16 verbs not in iter-1/iter-2 matrix — incremental adds in priority order: operator-touched (status / doctor / handoff) → config-touched (reconfigure / rotate-lead) → read-only (outbox / dashboard).
5. CI gate wiring per PLAN.md §9 reviewer-gate item 4 — `bun test:parity:<verb>` script entries OR a single `bun test:parity` with path-filter regex. ADR-102 §6 CI-flow update.
6. Optional `TASK_ADD_NOISE_MASK` constant extraction — once a second verb-family variant-set lands, evaluate de-duplicating shared mask shapes across rows. Today's per-row `// reason:` cite-locality is honest about the per-row contract; deduplication centralises but at cost of cite-locality. Neutral until duplication grows.
7. Optional biome lint-gate upgrade — change `bun run lint` from `biome lint .` to `biome check .` so format violations become a hard lint-gate failure (reviewer's Option B per `a2fcef6` verdict). ADR-worthy decision (touches team workflow); flag for iter-3 deferred-table.

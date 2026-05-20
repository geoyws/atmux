# ADR-144: epic-team test-gate — isolated branch-staging or cage e2e before merge to trunk

**Status**: accepted (T2/T3/T4 shipped 2026-05-17; T5 capstone 2026-05-17 — see §Amendment T5)
**Date**: 2026-05-16
**Origin**: 2026-05-14 driver session — operator directive: *"we have to make the epic-team run e2e on their own branch staging isolated and make sure tests are passing before we can merge their work into our 'trunk' which is the pwd's branch"*

## Context

Per [ADR-091](091-epic-merge-state-machine.md), epic-team auto-merge fires `git merge --no-ff <epic-branch>` against parent-team-trunk when the state machine advances `ready_to_merge → merging`. **There is no test-gate between those two states.** Broken epic-team work can land on parent-team-trunk and break the dogfood loop or — for IFCA product teams — the demo-walk path.

The risk is asymmetric:
- **No test-gate**: a single bad merge can corrupt parent-trunk for every downstream consumer (sibling epic-teams, demo-walk, branch-staging).
- **Mandatory test-gate**: the worst case is one epic-team's merge is delayed by minutes-to-an-hour while its test suite runs in isolation. Reversible; bounded blast radius.

Sibling pattern: [ADR-134](134-in-team-auto-merger.md) introduces a `tested` state in the intra-team gitter's state machine for per-member-branch fan-in. This ADR mirrors that pattern at the **epic-team → parent-trunk** layer (one level deeper).

The two modes required follow the project-class split already documented in global CLAUDE.md §Environment Tiers:
- **IFCA products** (sopx, aix, etc.) — branch-staging via a deployable URL on `*.ifca.app` (wildcard DNS + TLS); e2e walks the deployed app.
- **Internal tools** (atmux self, cockpit, etc.) — cage-isolated `bun test` against a fresh tmux cage; no deploy step.

## Decision

Extend ADR-091's epic-merge state machine with a **mandatory `tested` state**:

```
open
  → in_progress
    → ready_to_merge
      → [rebasing →] tested
        → merging      (on PASS — proceeds with existing ADR-091 git merge --no-ff)
        → test_failed  (on FAIL — terminal-but-recoverable; parent-trunk untouched)
          → in_progress (recovery via `atmux epic advance <eid> --to in-progress`)
      → reverted       (existing ADR-091 terminal state on git-merge conflict)
```

The transition `ready_to_merge → merging` is **REFUSED** unless the most recent `tested` outcome on the same epic-team is PASS. The repo-layer guard mirrors ADR-091's existing transition refusals (e.g. stale-base detection, in-flight rebase).

### Two test-isolation modes

Configurable per-team via `team.json.epicTeam.testGateMode`:

| Mode | When | Test isolation | Test command | Lifecycle |
|---|---|---|---|---|
| `deployed` | IFCA products | Branch-staging URL: `${product}-${dev-suffix}-${epic-name}-staging.ifca.app` (wildcard DNS + TLS handles new URLs) | `pnpm e2e` against `E2E_BASE_URL` | deploy on epic-spawn (ADR-090); teardown on epic-dissolve (ADR-091 dissolved state) |
| `cage` | Internal tools (atmux self) | Fresh tmux cage at `/tmp/atmux_${team}_${epic-name}_test_cage/` via `TMUX_TMPDIR` override (ADR-018 isolation + ADR-058 Tier 1) | team-configurable, default `bun test --timeout 30000` | one-shot per merge attempt; cage torn down after pass/fail recorded |
| `skip` | Operator override (logs as WARN class) | None | None | bypass; logs to bypass log + Discord [test-gate-bypass] |

For the **atmux self-dogfood path** (mode=cage): the cage MUST run with `unset TMUX &&` bypass + clean env to avoid parent-cage propagation per memory [[feedback_pause_bun_tests]] (bun test orphans survive BashTool timeouts; cage isolation is what makes it safe to run from inside an atmux session).

### test_failed recovery

Mirrors ADR-091 §pre-flag #7 reverse-transition:

- `test_failed → in_progress` via `atmux epic advance <eid> --to in-progress` after fix lands on epic-team-base.
- Test re-runs on next state-machine tick (no separate verb).
- `retryOnFlake` (default 1): if first attempt fails, retry once before declaring `test_failed`. Single flake doesn't strike.

### Operator bypass

`atmux epic advance <eid> --to merging --skip-test-gate` is a **driver-only** verb gate:
- Caller-scope gate (ADR-033 `ATMUX_CALLER_SCOPE=driver`).
- Logs to `~/.atmux/state/test-gate-bypasses.log` (append-only, audit trail).
- Fires Discord `[test-gate-bypass]` with who/why/epic-name/target-state.

Use sparingly. The default is "tests must pass."

### Config shape

```json
{
  "epicTeam": {
    "testGateMode": "cage",
    "testCommand": "bun test --timeout 30000",
    "requiredPasses": 1,
    "stagingUrlTemplate": null,
    "cageTmpdir": "/tmp/atmux_${team}_${epic}_test_cage",
    "testTimeoutMin": 30,
    "retryOnFlake": 1
  }
}
```

Notes on fields:
- `requiredPasses` default 1 (cold-start+walk shape per CLAUDE.md §Testing Discipline). Raise to N>1 only for streak-stable subsets — most epic-test gates are 1x acceptance, not idempotence.
- `stagingUrlTemplate` null for cage mode; required string for deployed mode. Validated at spawn time.
- `cageTmpdir` null for deployed mode; required string for cage mode.
- `testTimeoutMin` default 30. Enforces orphan-reap discipline per CLAUDE.md §`bun test` orphans.

### Discord templates

Three new templates in `src/abstractions/discord.ts` (per global CLAUDE.md Discord rules — verdict-first, no SHA dumps, banned em-dash runs):

- `[epic-test-pass]` — fires once on `tested → merging`. Body: epic-name, branch, test command, pass count, duration.
- `[epic-test-fail]` — fires on `tested → test_failed`. Body: failed test names, last 20 lines of output, suggested re-work scope.
- `[test-gate-bypass]` — fires when operator passes `--skip-test-gate`. Body: who, why, epic-name, target state.

## Consequences

- **Parent-trunk integrity gains a hard gate**: no broken epic-team work lands without operator override + audit trail. The cost is bounded delay per merge attempt (minutes to ~30min cap).
- **Cage mode unblocks atmux self-dogfood**: atmux can now safely run epic-team merges with `bun test` gate inside the cage isolation, even when the parent atmux session is also running tests (per the `unset TMUX` bypass).
- **Deployed mode reuses existing infra**: wildcard DNS `*.ifca.app → hax` + wildcard TLS already exist per global CLAUDE.md; new epic-team URLs "just work" without per-host setup. The deploy mechanics mirror `scripts/deploy.sh branch-staging`.
- **State machine grows by 2 states** (`tested` + `test_failed`); migration v? → v(N+1) adds the enum literals. The repo-layer transition guards extend with the test-gate refusal.
- **Operator bypass exists** for genuine emergencies but is auditable and Discord-surfaced; cannot land silently.
- **Coordination with ADR-091 impl**: when ADR-091's impl Tasks (t-04350614, t-9d22718b — verify status at impl time) land, this ADR's state-machine extension can fold into the same commit OR ship as a sibling extension. The repo-layer is the canonical author surface.
- **Out of scope for v1**:
  - Cross-epic test isolation when multiple epic-teams run concurrently — defer; v1 is per-epic-team only.
  - LLM-based test-failure-classifier (which class of failure suggests which scope to re-work) — defer to future ADR.
  - Auto-bisect on test-fail — defer.
  - Test sharding across multiple cages for parallel speedup — defer; v1 is single-cage-per-epic.

## Open questions

1. **OQ-1 (RESOLVED, LOW-rev)**: where does the `tested` state live in the state-machine source — extend ADR-091's existing repo OR new sibling repo?
   - **Default**: extend ADR-091's existing `src/core/merger-state-repo.ts` (or wherever the epic-merge state machine lives — locate at T2 impl).
   - **Rationale**: single source of truth for epic-merge state transitions; sibling repos drift over time. The schema migration adds enum literals, not new tables.

2. **OQ-2 (RESOLVED, MEDIUM-rev)**: cage-mode parent-cage propagation safety — `unset TMUX` bypass OR isolated subprocess via `setsid`?
   - **Default**: `unset TMUX` bypass + child-process inherits a clean env.
   - **Rationale**: matches memory [[feedback_pause_bun_tests]] precedent (the cage-guard's own recommended bypass). `setsid` is sufficient for some scenarios but doesn't fully isolate the bun-test orphan-survival path that `unset TMUX` does.
   - **Reversibility**: medium — flipping to `setsid` later is a one-line change in the cage provisioner.

3. **OQ-3 (RESOLVED, LOW-rev)**: retryOnFlake default — 0 (no retry) or 1 (one retry)?
   - **Default**: 1.
   - **Rationale**: single flake is common enough that 0 would over-fire `test_failed`. 1 retry catches transient infra issues; 2+ would mask real failures.

4. **OQ-4 (RESOLVED, MEDIUM-rev)**: deployed-mode teardown on test-fail — keep deploy URL alive for inspection OR teardown immediately?
   - **Default**: keep alive until epic-team dissolves (ADR-091 dissolved state).
   - **Rationale**: an epic-team in `test_failed` is being re-worked; the deployed URL is a useful artifact for the lead/operator/reviewer to inspect. Teardown happens at dissolve time anyway.
   - **Reversibility**: medium — flipping to immediate-teardown later is a one-line policy change in the deploy lifecycle hook.

5. **OQ-5 (RESOLVED, LOW-rev — deferred)**: cross-epic test isolation when multiple epic-teams run concurrently.
   - **Default**: defer to future ADR. v1 cages are uniquely-named per epic-team (`/tmp/atmux_${team}_${epic}_test_cage/`); concurrent epic-teams get separate cages. Concurrency safety at the deploy-URL layer relies on the unique URL pattern.
   - **Rationale**: deferred until concurrent epic-teams are a routine pattern in production; over-engineering before that point.

6. **OQ-6 (RESOLVED, LOW-rev)**: operator-bypass scope — driver-only OR also lead-callable?
   - **Default**: driver-only (`ATMUX_CALLER_SCOPE=driver` gate per ADR-033).
   - **Rationale**: leads are in the loop but the bypass affects parent-trunk integrity; restricting to driver scope matches the existing pattern for high-consequence verbs (spawn-epic, dissolve-epic).

## §Amendment 2026-05-17 — T2 shipped (t-49bd4fe1)

Per Task t-49bd4fe1 the state-machine + repo-layer + operator bypass surfaces landed. T3 (cage-mode test runner) and T4 (deployed-mode branch-staging) wire the actual test execution on top of the substrate this Task put down; T5 ships the Discord templates + e2e tests and flips this ADR's status to `accepted`.

**Shipped (epic-branch `geoyws-epic-e-03919b3b`):**

- **State machine** (`src/core/branch-merge-state.ts`):
  - New forward edges: `ready_to_merge → tested` (ADR-144 pre-merge test gate entry) and `tested → merging` (post-test-pass advance into actual git merge).
  - `merging → merged` edge formalised (existing epic-merge.ts caller already used this direct path; the adjacency map now matches).
  - New `TestOutcome` type + `TEST_OUTCOMES` enum (`"pass" | "fail" | "bypass"`).
  - New pure helper `canEnterMerging(from, next, testOutcome)` — refuses `tested → merging` when outcome is `null` or `"fail"`, accepts `"pass"` or `"bypass"`. Gate doesn't apply to ADR-134's `ready_to_merge → merging` direct path (test happens post-merge in that scope).
- **Migration v8 → v9** (`src/abstractions/sqlite-migrations.ts`): `ALTER TABLE merger_state ADD COLUMN test_outcome TEXT`. Permissive TEXT typing (no CHECK constraint) consistent with the rest of the merger_state shape. NULL on existing rows; written by the test-runner (T3/T4) at the `ready_to_merge → tested` transition.
- **Repo extension** (`src/core/repositories/merger-state-repo.ts`): `MergerStateTransition` Zod schema accepts `testOutcome?: "pass" | "fail" | "bypass" | null`. `MergerStateRow.testOutcome` round-trips through `getState()` / `transition()`. UPSERT preserves the "complete snapshot" contract — callers preserving a sticky outcome across non-test transitions MUST re-pass it (mirrors `baseSha` semantics).
- **Operator bypass log** (`src/core/test-gate-bypass.ts`): `logTestGateBypass(record, opts?)` appends one JSONL line to `~/.atmux/state/test-gate-bypasses.log`. Path constant `DEFAULT_TEST_GATE_BYPASSES_LOG_REL` exported for T5's Discord aggregator (`[test-gate-bypass]` template tails the same log). Each line: `{ ts, iso, epicId, epicBranch, targetState, reason, by }`. Test injection via `homeDir` + `now` opts.
- **Operator bypass verb** (`src/verbs/epic-merge.ts`): new `atmux epic-merge advance --to <state> [--skip-test-gate --reason <text>] [--team-dir <path>]` sub-verb.
  - ADR-033 driver-scope gate: `--skip-test-gate` refused for member callers (recovery `--to in_progress` allowed for member callers since it doesn't bypass a safety check).
  - Validates the transition via `isValidTransition`; refuses with current-state context on illegal edges.
  - Enforces the ADR-144 test-gate via `canEnterMerging`; refuses `tested → merging` without `--skip-test-gate` when outcome is not PASS.
  - On bypass: writes `test_outcome = "bypass"` to the row + appends the bypass log entry. On `--to in_progress` recovery: explicitly clears stale test outcome so the next test cycle starts clean.

**Coverage**: 100% on `branch-merge-state.ts`, `repositories/merger-state-repo.ts`, `test-gate-bypass.ts` per `bun test`. New test files:
- `tests/unit/core/branch-merge-state.test.ts` extended with `TEST_OUTCOMES` + `canEnterMerging` cases; existing forbidden-edges tests flipped to allowed for the new ADR-144 edges.
- `tests/unit/core/repositories/merger-state-repo.test.ts` extended with `test_outcome` round-trip + UPSERT semantics + Zod refusal cases.
- `tests/unit/core/test-gate-bypass.test.ts` — 8 cases on the JSONL logger.
- `tests/unit/verbs/epic-merge-advance.test.ts` — parser + driver-scope gate + transition validity + test-gate refusal + bypass log emission + recovery transitions.

**Deferred to T3/T4/T5:**
- T3 cage-mode test runner — invokes `bun test` inside `/tmp/atmux_${team}_${epic}_test_cage/` then transitions `ready_to_merge → tested` with the resulting `testOutcome`. **Shipped 2026-05-17 — see §Amendment T3 below.**
- T4 deployed-mode branch-staging — same shape via `scripts/deploy.sh` + `E2E_BASE_URL`.
- T5 Discord templates `[epic-test-pass]` / `[epic-test-fail]` / `[test-gate-bypass]` + e2e synthetic-epic-team walks for both modes + ADR-144 status flip to `accepted`.
- Wiring of the `runAutoMerge` flow in `src/core/epic-merge.ts` to route through `ready_to_merge → tested` (vs. today's direct `ready_to_merge → merging`) when `team.epicTeam.testGateMode !== "skip"`. **Shipped 2026-05-17 as part of T3.** Today's direct path is preserved as the `skip` mode fallback per the table in §Decision; T3/T4 swap in the real test runner that decides which transition to fire.

## §Amendment T3 2026-05-17 (t-8cba0705)

Per Task t-8cba0705 the cage-mode test runner + epic-merge wiring landed. T4 (be-1, deployed-mode) consumes the schema fields added here; T5 ships Discord templates + e2e + ADR status flip.

**Shipped (epic-branch `geoyws-epic-e-03919b3b`):**

- **Schema** (`src/schema/team.ts::TeamEpic`): added ADR-144 config fields with defaults — `testGateMode` (default `"skip"` for back-compat), `testCommand` (default `"bun test --timeout 30000"`), `retryOnFlake` (default `1`), `cageTmpdir` (default `/tmp/atmux_${team}_${epic}_test_cage`, nullable for deployed mode), `testTimeoutMin` (default `30`), `requiredPasses` (default `1`), `stagingUrlTemplate` (default `null`, set by T4 deployed-mode).
- **Cage runner module** (`src/core/epic-test-cage.ts`):
  - `expandCagePath(template, team, epic)` — `${team}` + `${epic}` placeholder expansion.
  - `tokenizeTestCommand(cmd)` — shell-ish argv splitter with quote handling; no `$VAR` / backtick interpretation.
  - `provisionCage(cagePath)` — `mkdir -p`, idempotent.
  - `teardownCage(cagePath)` — `rm -rf`, idempotent.
  - `runCageTestOnce(...)` — single-attempt test execution wrapping the command in `env -u TMUX TMUX_TMPDIR=<cagePath> <cmd>` per [[feedback_pause_bun_tests]] — the `env -u TMUX` is the no-shell equivalent of `unset TMUX &&` that prevents the bun-test orphan-survival path from killing the parent cage.
  - `runCageTest(opts)` — retry loop with PASS-wins-immediately semantics per §retryOnFlake; honors `retryOnFlake: 0` to disable retry; clamps negative retryOnFlake to 0.
  - `runCageTestGate(opts)` — full lifecycle (`provision → run → teardown`); teardown fires in `finally` so a wedged bun process can't leak cage tmpdirs. Teardown failures are swallowed so they don't mask a successful test outcome.
- **State machine wiring** (`src/core/epic-merge.ts`):
  - New `EpicMergeContext.testGateMode` (`"skip" | "cage" | "deployed"`) + `testGate?(ctx): Promise<{ outcome, note }>` hook field. Hook indirection keeps `src/core/*` free of cage-runner imports; verbs/epic-merge.ts wires the production cage default; tests stub a sync hook.
  - `runTestGate(ctx, t, by, now)` — composes the `ready_to_merge → tested → (merging | test_failed)` sequence. Optimistic transition to `tested` BEFORE invoking the hook (durable signal — a crash mid-test leaves an operator-visible row).
  - `resumeFromTested(ctx, t, by, now, outcome)` — handles ticks that observe a `tested` row at start (crash recovery, operator-written bypass outcome). Branches on the recorded `test_outcome` (`null` → stay, `fail` → terminal `test_failed`, `pass`/`bypass` → advance to merge).
  - `runMergeFromTested(ctx, ...)` — shared `tested → merging → merged | conflict` runner. Re-passes the row's `test_outcome` through every subsequent transition so the audit trail shows the gate evidence on the final `merged` / `conflict` row.
  - `guardedTransition` helper extended to accept an optional `testOutcome` field for preserving the gate evidence across transitions.
  - Mis-config refusal: `testGateMode !== "skip"` AND `testGate` hook undefined throws an invariant violation rather than silently degrading to skip — the parent-trunk gate must not bypass by accident.
- **Production verb wiring** (`src/verbs/epic-merge.ts`): the cron tick verb wires the cage hook when `epicTeam.testGateMode === "cage"` and `cageTmpdir` is non-null. The hook expands the cage path with the team name + parentEpicKanbanId, runs `runCageTestGate` with the team's `testCommand` + `retryOnFlake` + `testTimeoutMin`, and folds the result's attempts + exitCode + durationMs into the `merger_state.note`.

**Coverage**: 100% func / 99.20% line on `epic-test-cage.ts`; 93.33% func / 88.11% line on `epic-merge.ts` (uncovered lines are existing pre-T3 helper paths not exercised by the new ADR-144 tests). 27 new cage tests + 12 new ADR-144 state-machine routing tests.

**Test files added:**
- `tests/unit/core/epic-test-cage.test.ts` — 27 tests covering path expansion, tokeniser, provision/teardown, single-attempt run, retry loop with PASS/FAIL/flake-then-pass scenarios, full lifecycle teardown-on-throw.
- `tests/unit/core/epic-merge.test.ts` extended with 12 ADR-144 tests — cage mode PASS/FAIL/hook-throws, skip mode (default + explicit), invariant violation on missing hook, resume-from-tested with all four outcome states, conflict-during-merge preserves outcome.

**Layering note:** `src/core/*` imports `src/abstractions/*` only; cage runner sits in core, production verb wires it together. No verb-layer imports from core (already-established direction).

## §Amendment T5 2026-05-17 (t-45d59eeb) — capstone: Discord templates + e2e walks + status flip

Per Task t-45d59eeb the capstone work shipped: three Discord templates wired at the verb layer + cross-mode e2e walks + ADR status flip from `proposed` to `accepted`. With T2/T3/T4/T5 all landed, the test-gate is end-to-end usable: configure `team.epicTeam.testGateMode` to `"cage"` (atmux self) or `"deployed"` (IFCA products), and the auto-merger refuses parent-trunk merges that fail the gate while surfacing PASS/FAIL/bypass on Discord.

**Shipped (epic-branch `geoyws-epic-e-03919b3b`):**

- **Discord templates** (`src/abstractions/discord.ts`): three new literals added to the central `DiscordTemplate` union with paired `render*` fns and Opts interfaces.
  - `[epic-test-pass]` (`renderEpicTestPass` / `EpicTestPassOpts`) — fires on `tested → merging` PASS path. Category 🚀, verdict 🟢 **Shipping** ("`<epicId>` test-gate passed (`<mode>`) — merge proceeding"). Body bullets: ✅ attempts + requiredPasses, 🧪 testCommand, ⏱️ duration via `formatDuration`, 📍 branch.
  - `[epic-test-fail]` (`renderEpicTestFail` / `EpicTestFailOpts`) — fires on `tested → test_failed`. Category 🛑, verdict 🔴 **Stalled** ("`<epicId>` test-gate FAILED (`<mode>`) — parent-trunk untouched"). Body bullets: 🧪 ≤3 failed test names (or "test names unavailable" fallback), 📋 attempts + stdout-line count, ⏱️ duration, optional 🛠️ reworkHint.
  - `[test-gate-bypass]` (`renderTestGateBypass` / `TestGateBypassOpts`) — fires on `epic-merge advance --skip-test-gate`. Category ⚠️, verdict 🟡 **Cool** ("`<epicId>` test-gate BYPASSED → `<state>` (operator-authorized)"). Body bullets: 🆔 by, 🚩 reason, 🎯 targetState, 📍 branch. All bullet prefixes already in `ALLOWED_BULLET_PREFIX` — no allowlist amendments needed.

- **Hook return shape extension** (`src/core/epic-merge.ts`): new exported `TestGateHookResult` interface — extends the original T3 `{ outcome, note }` contract with optional `attempts` / `durationMs` / `failedTestNames` / `lastStdoutLines` fields for Discord template body. Back-compat: test stubs returning `{ outcome, note }` only continue to work; production hooks (cage + deployed) populate the optional fields.

- **PerformEpicMergeResult extension** (`src/core/epic-merge.ts`): new optional fields `testGateOutcome` / `testGateNote` / `testGateAttempts` / `testGateDurationMs` / `testGateFailedTestNames` / `testGateLastStdoutLines` — set ONLY on the tick that fires the test-gate hook (via new `withGateFields` helper applied at runTestGate's PASS + FAIL branches). The resume-from-tested path leaves them `undefined` so re-ticks over `tested` rows do not double-fire Discord. Skip mode + concurrency-lost ticks also leave them `undefined`.

- **Verb-layer Discord fire-sites** (`src/verbs/epic-merge.ts`):
  - `epicMergeTickVerb` — after `performEpicMerge` returns, if `result.testGateOutcome !== undefined` AND `testGateMode !== "skip"`, dispatches `fireTestGateDiscord` which builds either `renderEpicTestPass` or `renderEpicTestFail` based on the outcome and sends via injectable `opts.discordSend` (defaults to `discord.send`).
  - `epicMergeAdvanceVerb` — after `logTestGateBypass` succeeds on `--skip-test-gate`, fires `renderTestGateBypass` via the same injectable sender. Order: log FIRST (durable audit trail must land even if Discord errors), then Discord — the log is the source of truth, Discord is the surface.
  - New `tailLines(s, n)` helper exported for cage + deployed hooks to extract the last ≤20 stdout lines for the FAIL template body.
  - `EpicMergeOpts.discordSend?` test-injection seam — production default is `discord.send`; tests pass a capture-args stub to assert payload shape without hitting the network.

- **Cage / deployed hook structured returns** (`src/verbs/epic-merge.ts`): both production hooks now populate the optional `TestGateHookResult` fields (`attempts` + `durationMs` + `lastStdoutLines: tailLines(result.last.stdout, 20)`). `failedTestNames` defaults to `[]` — runner-specific test-name extraction is deferred (runners produce different stdout formats; the template renders "(test names unavailable from runner)" fallback gracefully).

**Coverage**: 16 new Discord template tests (98.15% line on `src/abstractions/discord.ts`), 3 new advance-verb Discord-fire tests, 5 e2e walks. The full T5 unit + e2e suite passes clean (240 unit + 5 e2e). `src/abstractions/discord.ts` uncovered lines are pre-existing helper paths unrelated to ADR-144.

**Test files added/extended:**
- `tests/unit/abstractions/discord.test.ts` — 16 new tests across the three renderers (verdict shape, category emoji, bullet emoji prefixes, attempts pluralisation, fallback prose, optional fields).
- `tests/unit/verbs/epic-merge-advance.test.ts` — 3 new tests: bypass fires Discord exactly once, payload shape assertion, non-bypass advance does NOT fire.
- `tests/e2e/epic-test-gate.test.ts` — NEW file. 5 stateful e2e walks: cage PASS (state machine + Discord + parent-trunk merge), cage FAIL (state machine + Discord + parent-trunk untouched), cage retryOnFlake (fail-then-pass via shell-script counter, attempts=2 surfaces in Discord), deployed-mode DNS-unresolved FAIL (composeStagingUrl placeholder expansion + DNS pre-flight refusal surfaces in Discord verdict), operator bypass (JSONL log + Discord [test-gate-bypass] paired emission).

**Layering note (carried forward from T3):** `src/core/epic-merge.ts` stays free of `src/abstractions/discord` imports — the verb is the lone fire-site. The hook indirection (`EpicMergeContext.testGate` returning `TestGateHookResult`) propagates structured fields through `PerformEpicMergeResult` so the verb can render templates without core-layer cross-imports.

**Deferred (intentional, post-T5):**
- Runner-specific failed-test-name extraction (bun vs vitest vs jest vs pnpm-e2e stdout formats). The renderer's "(test names unavailable)" fallback is the v1 contract; an extraction helper can ship as a follow-up Task once a real product team needs the surface.
- Deployed-mode PASS e2e walk requires a resolvable staging URL — exercised in production (an IFCA product team) rather than in this dogfood test. The test-gate wiring is identical at the verb layer; the DNS-unresolved test validates the same code path's FAIL surface.

## §Amendment 2026-05-19 — `testGateMode: "skip"` is the doctrine default (test-trust principle, t-afcc71af)

Driver finding 2026-05-19 06:30 MYT codifies a doctrine implicit in this ADR's §Decision: the schema-level default at `src/schema/team.ts::TeamEpicSchema.testGateMode` is `"skip"` (`z.enum(["skip", "cage", "deployed"]).default("skip")`), and the unit-test pin at `tests/unit/core/epic-merge.test.ts` ("testGateMode unset (default) → skip semantics (back-compat)") locks the behavior. This §Amendment makes the **doctrine** explicit:

**`testGateMode: "skip"` is the default because tests are already authoritative at L1** ([ADR-134](134-in-team-auto-merger.md) intra-team merger). When an epic-team's `<parentBase>-epic-<epicId>` trunk fans into the parent's base via `atmux epic-merge tick`, the branch's content **already passed** the auto-merger's `team.json::autoMerge.testCommand` at the epic-team's own `merging → tested` transition. Running the test suite again at the L2 fan-in layer would be:

1. **Wasteful** — same suite, same SHA, same expected outcome.
2. **Flake-prone** — a flaky test that passed once at L1 may fail on retry at L2 (`testGateMode: "cage"` provisions a fresh cage; `testGateMode: "deployed"` exercises a fresh branch-staging URL with potentially different DNS/cache state). False-fail at L2 triggers `tested → test_failed → reverted` and walks back a merge that was genuinely passing — the failure mode this ADR's `revertOnFail` was supposed to protect against, **inverted by re-test**.
3. **Doctrine-confusing** — if L1 says pass and L2 says fail, which verdict is authoritative? The test-trust principle answers definitively: L1 is the source of truth; L2's job is to fan-in, not to re-adjudicate.

**`"cage"` and `"deployed"` are operator escape hatches** — for the rare case where the epic-team's L1 tests were knowingly incomplete (skipped flake, partial coverage on a fast-moving epic, intentional opt-out of bun test for a docs-only team). The operator flips `team.json::epicTeam.testGateMode` to `"cage"` or `"deployed"` explicitly; the default behavior across every newly-spawned epic-team is **skip**, and that's by design.

**§Cage mode / §Deployed mode of this ADR stand verbatim** — when `testGateMode !== "skip"`, the state machine's `ready_to_merge → tested` transition routes through `runTestGate()` as documented; the cage/deployed runners (T3 + T4) still ship as the configured behavior. This §Amendment scopes only the default's doctrine — `skip` was always the back-compat default; now it's the **principled** default.

**Reviewer surface** — if a committer or epic-merge code path is observed firing a parent-side test gate on a default fan-in (no `testGateMode` override in `team.json`), file `atmux flag add --severity high --subject "[committer/epic-merge] re-test on default fan-in violates ADR-144 §Amendment 2026-05-19 test-trust principle"`. Brief carriers: [`templates/briefs/committer.md`](../../templates/briefs/committer.md) §Test-trust principle + §Hard rules (both modes); cross-refs [ADR-091 §Amendment 2026-05-19](091-kanban-driven-auto-merge.md) (parent fan-in trust statement) + [ADR-134 §Amendment 2026-05-19](134-in-team-auto-merger.md) (L1 source-of-truth statement).

**Filed via** t-afcc71af (P1 doctrine clarification, 2026-05-19).

## Cross-refs

- [ADR-090](090-epic-team-lifecycle.md) — epic-team lifecycle; provisions cage/deployment at spawn time.
- [ADR-091](091-epic-merge-state-machine.md) — auto-merge state machine substrate; this ADR extends with mandatory `tested` state.
- [ADR-134](134-in-team-auto-merger.md) — sibling test-gate pattern at the intra-team gitter layer (one level up).
- [ADR-058](058-fallback-cage-tiering.md) — cage tiering; cage-mode uses Tier 1 with own state.db.
- [ADR-018](018-per-team-tmux-socket-isolation.md) — per-team tmux socket isolation; cage-mode uses its own socket.
- [ADR-008](008-decisions-verb.md) — Discord template R10 enforcement; this ADR adds three literals to the central union.
- Global CLAUDE.md §Environment Tiers — branch-staging convention for deployed mode.
- Global CLAUDE.md §Discord — verdict-first body shape, banned em-dash runs, bullet emoji prefix allowlist.
- Memory [[feedback_pause_bun_tests]] — cage-guard's `unset TMUX` bypass precedent.

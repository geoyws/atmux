# ADR-144: epic-team test-gate — isolated branch-staging or cage e2e before merge to trunk

**Status**: proposed
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

## Cross-refs

- [ADR-090](090-epic-team-lifecycle.md) — epic-team lifecycle; provisions cage/deployment at spawn time.
- [ADR-091](091-epic-merge-state-machine.md) — auto-merge state machine substrate; this ADR extends with mandatory `tested` state.
- [ADR-134](134-in-team-auto-merger.md) — sibling test-gate pattern at the intra-team gitter layer (one level up).
- [ADR-058](058-fallback-cage-tiering.md) — cage tiering; cage-mode uses Tier 1 with own state.db.
- [ADR-018](018-per-team-tmux-socket-isolation.md) — per-team tmux socket isolation; cage-mode uses its own socket.
- Global CLAUDE.md §Environment Tiers — branch-staging convention for deployed mode.
- Memory [[feedback_pause_bun_tests]] — cage-guard's `unset TMUX` bypass precedent.

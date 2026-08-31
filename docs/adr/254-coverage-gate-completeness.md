# ADR-254: coverage gate must diff the tracked-source universe, not iterate the lcov

**Status**: Accepted (2026-06-05)

**Date**: 2026-06-05

**Driver-ref**: P0 finding — the coverage gate was itself failing the project's bottom-up test ("if the feature were entirely broken, would this still pass?"). Empirically proven during the ADR-254 backfill pass:

- Finding `test-lcov-gate-blind-to-zero-coverage` — the gate prints "✅ 100%" + exits 0 for a fully-untested file.
- Finding `test-orchd-housekeep-untested-destructive` — `src/core/orchd-housekeep.ts` (4 DELETEs + `unlinkSync`, fired automatically every 24h by Rust orchd) sat at 0% coverage, invisible to the gate.
- Finding `test-orchd-context-scan-untested` — `src/core/orchd-context-scan.ts` (emits durable `member.context-high` events every 15min) sat at 0% coverage, invisible to the gate.

**Cross-refs**:
- ADR-009 §6 (`tests/lcov-gate.ts` header + `bunfig.toml` header) — the hand-rolled gate this ADR fixes. ADR-009 §6 established the gate because Bun 1.3.13 PARSES `coverageThreshold` in `bunfig.toml` but silently NO-OPS it. This ADR closes the gate's own blind spot.
- The **"100% test coverage on tracked paths"** contract (global `CLAUDE.md` §Engineering: "100% test coverage on tracked paths (resolvers / handlers / authz / UI with logic / utils / validators), same commit as code"). The gate is the enforcement mechanism for that contract; a gate that can't see a 0%-coverage file silently voids the contract.
- ADR-0067 (no-test-skip enforcement gate, cited in global `CLAUDE.md` §Engineering "NO LIES on e2e tests"). Same doctrine family: a gate that asserts nothing is a lie. A `test.skip` that hides an untested path and a coverage gate blind to an untested file are the same failure class — green that asserts nothing.

## Context

`tests/lcov-gate.ts` (ADR-009 §6) is the CI coverage gate. It parses `coverage/lcov.info`, applies `coveragePathIgnorePatterns` from `bunfig.toml` as the narrowed denominator, and fails CI when any tracked file is below 100% on line / function / branch.

The gate had a structural blind spot. `evaluateGate` iterated **only the files present in the parsed lcov** (the `SF:` records). But Bun emits **no `SF:` record at all** for a source file that no test ever loads — there is nothing in the lcov to iterate. Empirically validated: a `src/**` /`.ts` file imported by zero tests produces zero lcov output for that path, so the per-file `%%` loop never visits it, `failures` stays empty, `ok` is `true`, and the gate prints:

```
lcov-gate: ✅ N tracked file(s) at 100% (M ignored)
```

— exit 0. The file is at 0% coverage and the gate cannot see it.

This is the gate **itself** failing the bottom-up test from `CLAUDE.md` §Engineering: read the gate bottom-up and ask "if the feature were entirely broken (every tracked file at 0%), would this still pass?" The answer was **yes** — every untested file is invisible, so a project that wrote zero tests would pass the gate. That is a lie in exactly the sense the NO-LIES doctrine forbids.

The concrete cost: two daily-firing destructive modules shipped with 0% coverage, masked by the green gate:

- `src/core/orchd-housekeep.ts` — fires from Rust orchd's 24h ticker; runs four `DELETE` statements (events, subscriber_offsets, merger_state terminal rows) plus a filesystem `unlinkSync` of rotated logs. A regression that pruned too aggressively would silently destroy live data, with no test asserting the cutoff math or the MIN-offset safety floor.
- `src/core/orchd-context-scan.ts` — fires from orchd's 15min ticker; emits durable `member.context-high` events. No test pinned the threshold comparison, the dedup window, or the emit path.

## Decision

### D1 — the gate diffs an enumerated tracked-source universe against the lcov, not the lcov alone

`tests/lcov-gate.ts` enumerates the **real on-disk tracked-source universe** and FAILS the gate for any tracked file absent from the lcov (reported as a distinct 0%-coverage breach, by filename). Concretely:

1. `enumerateTrackedSources(cwd, ignorePatterns)` scans `src/**` /`.ts` via `new Bun.Glob("src/**/*.ts").scanSync({ cwd, absolute: true })` (rooted at `src/`, never `/`, per `CLAUDE.md` filesystem-walker discipline), minus any path matched by `coveragePathIgnorePatterns`. The filter reuses the existing `isIgnored` helper — **single source of truth**, no divergent duplication of the ignore logic.
2. `evaluateGate` accepts an optional `trackedUniverse` (cwd-relative POSIX paths). When supplied, it builds the set of `SF:`-present paths (normalized to cwd-relative via the new `toRelative` helper — Bun emits cwd-relative `SF:` paths while the glob yields absolute paths, so both sides funnel through one normalizer) and reports every universe member with no `SF:` record in a new `result.missing` array.
3. `result.ok` is now `failures.length === 0 && missing.length === 0`. A 0%-coverage file fails the gate.
4. `runCli` always supplies the enumerated universe (the completeness check is the point). The `--no-completeness` flag opts back into legacy lcov-only mode for scratch/CI experiments that point `--lcov` at a synthetic file with no matching `src/` tree on disk.

The per-file `%%` checks for present files are unchanged — partial-coverage breaches and 0%-coverage (missing) breaches both fail the gate, and the report counts and lists both classes, with the 0%-coverage class labeled explicitly (`0% (no SF: record in lcov)`).

### D1.1 — exact-path-only denominator exclusions for compile-time seams

The gate universe is the set of tracked executable source files after `coveragePathIgnorePatterns` is applied. The denominator stays honest because the only exclusions are exact paths for compile-time-only seams that TypeScript erases and that Bun cannot express as meaningful executable coverage:

- `src/abstractions/agent-backend.ts`
- `src/abstractions/issue-tracker.ts`
- `src/abstractions/voice-provider.ts`
- `src/core/cursor-recipes/types.ts`
- `src/core/sync-claude-team-json/types.ts`

This is exact-path-only policy, not a filename class policy. A suffix such as `types.ts` is never sufficient on its own, because runtime-bearing `types.ts` files remain tracked. For example, `src/verbs/doctor/types.ts` stays in the denominator, and `src/core/spawn-override.ts` stays tracked as a runtime source. No allowlist switch is introduced or implied; the gate still hard-fails for every tracked runtime source with incomplete or absent coverage.

### D2 — backfill the two masked destructive modules to 100%

`tests/unit/core/orchd-housekeep.test.ts` and `tests/unit/core/orchd-context-scan.test.ts` are added in the same commit, both at 100% line + function coverage of their subject module. They seed in-memory `bun:sqlite` on both sides of every cutoff (and the MIN-offset safety floor), assert exact deleted-row counts for all four `housekeep` DELETEs, the empty-`activeConsumerIds` branch, the rotated-log `unlinkSync` path, and the context-scan threshold / dedup-window / emit branches — including the error-containment catch arms.

### D3 — the residual tail is a reported follow-up, not a fake-green

The completeness fix will surface every other 0%-coverage tracked file at integration time, not just the two backfilled here. That residual tail is reconciled by the orchestrator at integration (sibling agents' tests land their own coverage; e.g. `src/core/auto-merge-invoke.ts` is covered by a sibling). The honest posture per `CLAUDE.md` ("real fix over fast hack; no blanket ignore"):

- The gate **hard-fails immediately** on any uncovered tracked file. There is no allowlist escape hatch baked into the gate — an allowlist would re-introduce the same "invisible untested file" failure class the ADR exists to kill, just spelled differently.
- If integration surfaces an uncovered file that genuinely cannot be tested this cycle, the correct move is a tracked Task (docs/kanban) to write the test, NOT a gate suppression. The gate staying red until the test lands is the contract working as designed.

## Consequences

- A new tracked `src/**` /`.ts` file with zero tests now fails CI loudly, by name, instead of passing silently. This is the intended friction.
- `enumerateTrackedSources` scans the disk on every gate run (a few hundred files, one-shot CLI — not a hot path).
- The `GateResult` shape gains a `missing: ReadonlyArray<string>` field. Callers constructing `GateResult` literals (the gate's own tests) supply `missing` explicitly; this is a test-helper surface, not a documented public API, so no further doc fan-out is required.
- Coverage of `coveragePathIgnorePatterns` continues to govern the denominator: a file legitimately excluded (generated code, barrels, fixtures, `tests/**`) is filtered out of the universe by the same `isIgnored` logic, so it is neither required-present nor flagged-missing.

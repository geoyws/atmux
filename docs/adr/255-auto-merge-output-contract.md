# ADR-255: auto-merge tick-result output contract + bounded subprocess wait

**Status**: Accepted — 2026-06-05.
**Date**: 2026-06-05
**Driver-ref**: P0 fix (finding `test-auto-merge-invoke-untested-dispatch`). `src/core/auto-merge-invoke.ts` shipped as untested dispatch code with latent stdout-parse bugs that flowed CORRUPT `mergeSha` / `parentBase` into emitted `epic.merged` event payloads, plus an unbounded subprocess wait that could freeze orchd's single thread.
**Cross-refs**: [ADR-202](202-honker-in-db-messaging-substrate.md) (Honker in-DB messaging substrate — the `epic.merged` event this invoker's payload feeds is emitted onto), [ADR-090](090-epic-team-lifecycle.md) (epic-team lifecycle — `parentBase` + the `<grandparent>/<base>` fan-in target this invoker reports), [ADR-091](091-kanban-driven-auto-merge.md) (kanban-driven auto-merge — the `epic-merge tick` state machine this invoker spawns + parses), [ADR-231](231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D failure-isolation (a hung tick must not freeze orchd's single thread — the bound in §D2 enforces this), [ADR-099](099-error-handling.md) R4 + [ADR-100](100-spawn-pattern.md) (`src/abstractions/spawn.ts` is the ONLY module allowed to call `Bun.spawn` — this ADR moves the invoker onto that abstraction).

## Context

The in-cage auto-merge invoker (`src/core/auto-merge-invoke.ts::invokeAutoMergeInCage`) spawns `atmux epic-merge tick --team-dir <teamDir>` as a one-shot subprocess (per ADR-091's state machine, run from each cage's own orchd process per ADR-233's cron-decommission). It then PARSES the subprocess stdout to decide whether a merge happened, and — when it did — extracts `mergeSha` + `parentBase` to populate the `epic.merged` event payload that `src/core/orchd-merge.ts::createAutoMergeHandler` emits onto the Honker substrate (ADR-202).

The producer of that stdout is `src/verbs/epic-merge.ts::logTickResult`, which printed:

```
epic-merge tick: team='<team>' parentBase='<parentBase>' state='<state>' <verdict>[ sha=<sha>][ dissolve-dispatched] reason='<reason>'
```

The consumer's parser had three latent bugs, none caught because the module shipped with ZERO test coverage (finding `test-auto-merge-invoke-untested-dispatch`):

1. **Merge-detection drift.** The producer printed `state='merged'` (single-quoted); the consumer matched `state=merged` (unquoted) — which NEVER matched. Merge-detection survived ONLY by an accidental `/MERGED/i` substring fallback over the whole line. That fallback ALSO false-triggered on the word "merged" appearing in the `reason='…'` prose (e.g. `reason='branch already merged upstream'`) — so a no-op tick whose reason merely mentioned "merged" would be reported as a real merge.

2. **`mergeSha` always empty.** The producer emitted `sha=<sha>`; the consumer's `extractMergeSha` read `mergeSha[=:]<sha>` — a key the verb never prints. Every "merged" result therefore carried an empty `mergeSha`, which flowed into the emitted `epic.merged` payload.

3. **`parentBase` carried quotes.** The producer wrote `parentBase='<branch>'`; the consumer's `extractParentBase` captured `'<branch>'` INCLUDING the surrounding single-quotes.

Separately, `defaultSpawnEpicMergeTick` used a raw `Bun.spawn` + unbounded `await child.exited`. ADR-099 R4 (+ ADR-100) forbids raw `Bun.spawn` outside `src/abstractions/spawn.ts`, and an unbounded wait means a hung tick (git lock, never-returning test-gate) freezes orchd's single thread indefinitely (violates ADR-231 §D failure-isolation).

## Decision

### D1 — Single shared serializer/parser pair for the tick-result line

The tick-result line is a **documented surface** (per `~/work/src/atmux/CLAUDE.md` §Binding-discipline #2: kanban/event schema + state shape). Producer (`epic-merge.ts::logTickResult`) and consumer (`auto-merge-invoke.ts::invokeAutoMergeInCage`) MUST NOT carry two independently-drifting regexes for it.

The contract is now a single shared shape exported from `src/core/auto-merge-invoke.ts`:

- `interface TickResultLine` — the structured fields (`team`, `parentBase`, `state`, `verdict`, optional `mergedSha`, `dissolveDispatched`, `reason`).
- `serializeTickResult(fields): string` — the PRODUCER. `epic-merge.ts::logTickResult` delegates to it; the printed line is byte-identical to the prior format (no observable change for log-grep / cron-capture consumers).
- `parseTickResult(stdout): TickResultLine | null` — the CONSUMER. Anchored to the `key='value'` shape the serializer emits.
- `const TICK_RESULT_PREFIX = "epic-merge tick:"` — the one greppable marker both halves reference.

Co-location means a field rename is a compile-time edit in one module, not a silent runtime drift across two files. This is why the producer-side edit (`epic-merge.ts`) lands in the SAME commit as the consumer-side fix.

Parser invariants (fixing the three bugs):

- **Merge-detection is EQUALITY on the quoted `state` field**, never a substring of the whole line. `parseTickResult` extracts `state='([^']*)'` and the caller checks `parsed.state === "merged"`. A `reason='…merged…'` prose mention or a `state='merging'` no-op can no longer false-trigger.
- **`mergedSha` reads the `sha=` key the verb actually emits**, bounded to git's `[0-9a-f]{7,40}` SHA shape so a stray `sha=` in prose cannot smuggle a non-SHA value.
- **Single-quoted captures are quote-stripped by the `'([^']*)'` group itself** — `parentBase` no longer carries quotes.
- **Fail closed on a malformed/truncated line.** A line carrying the prefix but missing a required quoted field (e.g. the subprocess was SIGKILL'd mid-line) returns `null` — never a half-populated object that could read as a merge. The parser scans for the LAST contract line (the verb logs it once, at the end of the tick, after other output like test-gate hooks + dissolve logs).

### D2 — Bound the subprocess wait; a hung tick is gate-held, not merged

`defaultSpawnEpicMergeTick` now routes through the R4-blessed `spawn()` abstraction (`src/abstractions/spawn.ts`) instead of a raw `Bun.spawn`. This both fixes the ADR-099 R4 violation and inherits the abstraction's `timeoutMs` machinery (SIGTERM → 1s grace → SIGKILL).

- The wait is bounded by `DEFAULT_TICK_TIMEOUT_MS = 120_000` (exported + overridable via the `timeoutMs` parameter — injectable for tests; production callers accept the default).
- `expectExitCode: "any"` means a NONZERO exit is RETURNED (mapped to gate-held by the caller), not thrown; only a timeout throws `SpawnTimeoutError`, which the adapter catches and maps to `{ timedOut: true }`.
- On timeout the child is already SIGTERM→SIGKILL'd by `spawn()`; `invokeAutoMergeInCage` maps `timedOut` to `{ state: "gate-held", reason }` — emphatically **NOT** `merged`. A hung tick can never emit a phantom `epic.merged`. This is the ADR-231 §D failure-isolation guarantee applied to the auto-merge dispatch seam.

### D3 — Outcome map (the dispatch contract)

`invokeAutoMergeInCage` maps the subprocess outcome to a `DispatchEpicMergeResult` (consumed by `orchd-merge.ts::createAutoMergeHandler`):

| Subprocess outcome | Result | Downstream |
|---|---|---|
| spawn threw (e.g. `atmux` not on PATH) | `gate-held` | `epic.merge-blocked` |
| timed out (reaped by `spawn()`) | `gate-held` | `epic.merge-blocked` |
| exit non-zero | `gate-held` | `epic.merge-blocked` |
| exit 0 + parsed `state='merged'` | `merged` (with extracted `parentBase` + `mergeSha`) | `epic.merged` |
| exit 0 + no merged indicator | `skipped-not-mine` | (no emit) |

A `merged` state may legitimately omit `sha=` (no-op merge, nothing ahead) — we still report `merged` with an empty `mergeSha`; the handler logs the epicId regardless.

## Consequences

- The corrupt-payload class is closed: `epic.merged` events now carry the real `mergeSha` + an unquoted `parentBase`, or are not emitted at all (gate-held / skipped).
- The drift class is closed: producer + consumer share one shape; a future field rename is a type error, not a silent runtime miss.
- orchd's single thread can no longer be frozen by a hung tick.
- `src/core/auto-merge-invoke.ts` carries full test coverage (`tests/unit/core/auto-merge-invoke.test.ts`): all four dispatch outcomes (asserting EXACT extracted `mergeSha` + `parentBase` against a REAL `serializeTickResult` string), the false-trigger guard (substring `merged` in prose + `state='merging'`), the empty-`sha` regression, the quote-strip regression, the malformed-line fail-closed path, and the timed-out path.

## Out of scope

- In-process invocation (vs subprocess). The subprocess boundary stays per the module header rationale — `epicMergeTickVerb` calls process-global helpers (cwd-bound `requireTeam`, env reads) that would need cwd manipulation + risk pollution in-process.
- Structured (JSON) tick-result output. A line-format contract is sufficient + keeps the human-greppable cron-capture log readable; the shared serializer/parser pair already removes the drift risk a JSON migration would otherwise justify.

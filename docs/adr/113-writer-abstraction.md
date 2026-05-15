# ADR-113: `Writer` abstraction + shared `core/io.ts` for verb stdout/stderr injection

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

Nine verbs (`rotate`, `handoff`, `doctor`, `cost`, `report`, `dashboard`, `init`, `start`, `add-member`) accept injected `stdout` / `stderr` writers in their `*Opts` shape so tests can assert output without spying on `process.stdout`/`process.stderr` globals. Each of those verbs independently defines:

```ts
export function defaultStdoutWrite(s: string): boolean {
  return process.stdout.write(s);
}

export function defaultStderrWrite(s: string): boolean {
  return process.stderr.write(s);
}
```

Plus a one-liner unit test per file forcing the default-branch through with `expect(defaultStdoutWrite("")).toBe(true)` (or similar) so the function-coverage column hits 100%.

That's roughly 60 LOC of duplicated boilerplate plus 9 trivial test blocks. The `Writer` shape is also typed inconsistently across verbs:

| Verb | Field type |
|---|---|
| `rotate.ts` | `(line: string) => void` |
| `doctor.ts` | `(s: string) => void` |
| `cost.ts` | `(line: string) => void` |
| `handoff.ts` | (matches doctor) |
| `report.ts` | (matches cost) |

Different parameter names, all `void` return — they're the same type wearing different labels. R-5 in `PLAN.md §6.2` has been pending since Phase 1 specifically to lift this duplication once enough verbs landed to make the abstraction concrete.

The `defaultStdoutWrite` / `defaultStderrWrite` functions have **no per-verb specialization** — every copy is byte-identical. This is the textbook case for "extract to shared module."

## Decision

### 1. New module `src/core/io.ts`

```ts
// src/core/io.ts
//
// Shared output-sink abstraction for verbs that take injectable
// stdout/stderr writers in their *Opts shape. Lifts the
// previously-duplicated `defaultStdoutWrite` / `defaultStderrWrite`
// from per-verb files (rotate, handoff, doctor, cost, report, ...) so
// there's one canonical sink + one canonical type.
//
// `Writer` matches `process.stdout.write`'s shape with the return
// value relaxed to `void` — tests don't care about the drain-hint
// boolean, and `boolean` widens to `void` so existing
// `process.stdout.write.bind(process.stdout)` call-sites keep working.

/** A line-sink for verbs. Matches the contract of `process.stdout.write`
 *  with the drain-hint return relaxed to `void` since no caller branches
 *  on it. Tests pass `(s) => buf += s` style stubs. */
export type Writer = (s: string) => void;

/** Standard verb-IO injection shape. Verbs whose `*Opts` interface needs
 *  output redirection extend or compose with this. */
export interface IoSinks {
  stdout?: Writer;
  stderr?: Writer;
}

/** Default stdout sink — `process.stdout.write` passthrough. The
 *  `boolean` return is widened to `void` per `Writer`'s contract; no
 *  caller branches on it. */
export function defaultStdoutWrite(s: string): boolean {
  return process.stdout.write(s);
}

/** Default stderr sink — `process.stderr.write` passthrough. */
export function defaultStderrWrite(s: string): boolean {
  return process.stderr.write(s);
}
```

100% coverage required like every other tracked file.

### 2. Verb migration

Verbs with local `defaultStdoutWrite` / `defaultStderrWrite` definitions delete them and import from `core/io.ts`:

```diff
- export function defaultStdoutWrite(s: string): boolean {
-   return process.stdout.write(s);
- }
- export function defaultStderrWrite(s: string): boolean {
-   return process.stderr.write(s);
- }
+ import { defaultStdoutWrite, defaultStderrWrite, type Writer } from "../core/io.ts";
```

The `*Opts` interface keeps its `stdout` / `stderr` fields (with the `Writer` type tightened, parameter name unified to `s`) but removes the per-verb default re-export.

Verb tests that previously imported the local `defaultStdoutWrite` for assertions switch to `import { defaultStdoutWrite } from "../../src/core/io.ts"`. Per-verb tests that exercised the `defaultStdoutWrite` default-branch round-trip get deleted (single canonical test in `tests/unit/core/io.test.ts` covers it once).

### 3. NOT in scope

- **Forcing trivial verbs (`version`, `help`, `pause`, `dispatch`, `claim`, `stop`, etc.) to adopt `*Opts`.** Those verbs call `process.stdout.write` / `process.stderr.write` directly without injection — fine and pragmatic. Adding empty `*Opts` shapes for symmetry costs LOC without test-quality gain. Verbs adopt `*Opts` *when the test needs injection*, not before. Status quo holds.
- **Verb-as-registry pattern for `cli.ts`.** Investigated: lines 123-137 of `cli.ts` flagged uncovered are stale-test gaps (8 verbs added without backfilling `tests/unit/cli.test.ts` dispatch-smoke blocks), not a structural problem with the switch dispatcher. Fix is mechanical test backfill — no registry refactor needed. ADR-103's hand-rolled switch stands.
- **`Writer` return-type widening.** Default sinks return `boolean` (drain hint) and the Writer type erases it to `void`. No caller ever branches on the boolean; back-pressure handling for atmux's small-line outputs (status banners, JSON blobs) is not load-bearing. Keep simple.
- **Replacing `console.log` in `version.ts` with a Writer.** `version.ts` is 25 LOC with 100% coverage and no test-injection need. `console.log` adds a trailing newline — switching to `defaultStdoutWrite` would require manually appending `\n`, which is a regression in clarity. Keep status quo.
- **Generalising further (`Reader` for stdin, fancy `Logger` with levels).** YAGNI. Add when a real verb needs it.

## Migration plan (this ADR's commit chain)

1. **Commit A — `feat(core): io.ts — shared Writer + default sinks (R-5)`**: new `src/core/io.ts` + `tests/unit/core/io.test.ts`. Greenfield, no other changes.
2. **Commit B — `refactor(verbs): import default writers from core/io.ts`**: update each affected verb (`rotate`, `handoff`, `doctor`, `cost`, `report`, `dashboard`, `init`, `start`, `add-member`) — delete local `defaultStdoutWrite` / `defaultStderrWrite`, switch import. Update affected tests. lcov-gate stays green throughout.
3. **Commit C — `test(cli): backfill dispatch-smoke for 8 missing verbs`**: add the 8 missing dispatch tests in `tests/unit/cli.test.ts` (dashboard, reconfigure, rotate, rotate-lead, handoff, report, cost, doctor). Closes `cli.ts` lines 123-137 to 100%. Independent of A+B but lands in the same chain since both are R-5-related cleanup.
4. **Commit D — `docs(adr,plan): R-5 done — ADR-113 + flip §6.2 status`**: this ADR file + flip R-5 row in `PLAN.md`.

Each commit standalone-passes typecheck + 100% coverage gate.

## Out of plan / future work

- If a future verb needs **structured logging** (levels, timestamps, JSON output to a side-channel), revisit with a `Logger` interface — but only when concrete. Don't pre-build.
- If a future verb needs **stdin injection** for interactive prompts (currently only `init --wizard` reads stdin via Bun's process API), add `Reader` + `IoSinks { stdin?: Reader }`. `init.ts` already does this ad-hoc — refactor when there's a second consumer.
- The `Writer` type's `void` return is narrower than `process.stdout.write`'s `boolean`. If a future caller genuinely needs the drain hint (writing huge JSONL streams, e.g. a `cost --since 0` over years of session logs), widen to `boolean | void` then. Trivial diff.

## Consequences

- ~60 LOC of duplicated boilerplate deleted across 9 verb files.
- One canonical `Writer` type — verb signatures uniform on this axis. Future verbs that need injectable output have a single import path: `import { type Writer, type IoSinks, defaultStdoutWrite, defaultStderrWrite } from "../core/io.ts"`.
- No public-API churn (the `*Opts` shapes' `stdout` / `stderr` fields keep their semantics; only the parameter name normalises to `s`).
- R-5 status flips to `✅ done` in `PLAN.md §6.2` — one fewer pending refactor before Phase 2 closes.
- V-25 whip + V-01 up will write against the canonical shape from day one.

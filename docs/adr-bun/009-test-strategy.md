# ADR-009: Test strategy — `bun:test`, narrowed coverage, parity harness

**Status:** accepted
**Date:** 2026-05-04
**Owner:** tester (primary), architect (review)

## Context

The bash atmux at HEAD ships **24 bats specs** (23 unit + 1 e2e `lifecycle.bats`) covering 22/27 lib files. Five libs have zero coverage: `attach.sh`, `dashboard.sh`, `inbox.sh`, `reconfigure.sh`, `rotate.sh`. The bats setup helper (`tests/helpers/setup.bash`) provides a sandboxed `.atmux/` workspace via `atmux_setup_sandbox`, sets `NO_COLOR=1` + `ATMUX_SPAWN_WAIT=0`, and points `ATMUX_BIN` at the repo-local binary.

The Bun port has three testing imperatives the bash codebase does not:

1. **Strict coverage gating.** CLAUDE.md requires 100% on a *narrowed denominator* — code that makes decisions, validates inputs, or talks to the outside world. Generated and boilerplate code is excluded but tracked paths fail CI below 100%.
2. **Parity validation against bash.** The TS port must match bash@2aadc3f byte-for-byte on every observable: stdout, exit code, `.atmux/` post-state, and Discord webhook calls. PLAN.md §4.2 frames the parity harness as the source of truth — no verb merges without parity-green.
3. **E2E discipline.** CLAUDE.md "stateful e2e specs are not repeatable smokes" — a spec that walks `start → send → dispatch → done → ...` consumes seed state and is a **1x cold-start+walk acceptance test**, not a streak-runnable smoke. The bats `lifecycle.bats` re-creates the sandbox per `@test` (so each is independent); the TS port intentionally inverts this to one cold-start across all eleven beats so the spec proves the *chain*, not the steps in isolation.

This ADR fixes the runner, the coverage shape, the parity harness contract, and the bats port plan.

## Decision

### 1. Runner — `bun:test`

`bun:test` is the runner. Vitest-compatible API, native to the runtime, no extra install. Coverage via the built-in `bun test --coverage --coverage-reporter=lcov`. Output goes to `coverage/lcov.info`; CI uploads as artifact + fails on threshold breach.

### 2. Narrowed coverage denominator (100% gate)

Tracked (must hit 100% line + branch):

- `src/verbs/**/*.ts` — domain verb handlers
- `src/abstractions/**/*.ts` — tmux, json, http, lock, fs, time, spawn, discord
- `src/core/**/*.ts` — atmux-specific reusables (per ADR-003: 4 core libs `common`, `tui`, `send`, `pause`)
- `src/schema/**/*.ts` — Zod schemas + validation helpers
- `src/errors.ts` — typed error helpers (single-file per ADR-006)
- `src/cli.ts` — CLI dispatcher (per ADR-010): alias routing, unknown-verb→`UsageError`→exit 64, `--help` / `--version` paths, top-level catch→`AtmuxError`→tagged stderr. Pure dispatch logic, unit-testable without e2e — included in the tracked set per architect's review of this ADR.

Excluded from the denominator (no coverage requirement):

- `src/types/generated/**` — generated type files, if any
- Barrel re-exports (`**/index.ts` files that only re-export)
- `tests/**` — fixture data and helper code
- `src/**/*.fixtures.ts` — co-located fixture factories

Configuration lives in `bunfig.toml`:

```toml
[test]
coverage = true
coverageThreshold = { line = 1.0, function = 1.0, statement = 1.0, branch = 1.0 }
coveragePathIgnorePatterns = [
  "src/types/generated/**",
  "**/index.ts",
  "tests/**",
  "**/*.fixtures.ts",
]
```

NB: glob shape — Bun 1.3.13 needs `tests/**` (recursive) not `tests/` (directory-prefix); see §6 "Bun threshold gap" below for the broader gap that necessitates `tests/lcov-gate.ts`.

Reviewer enforces tests-with-code in the per-commit gate (PLAN.md §9 check 2). Code lands in the same commit as its tests — no "tests later" split.

### 3. Parity harness — `tests/parity/`

Layout:

```
tests/parity/
  fixtures/
    factory.ts            # Zod-validated factory: makeFixture({verb, members, kanban, inboxes, flags})
    schemas.ts            # local Zod schemas (interim until ADR-005 publishes src/schema/)
    presets/
      minimal.ts          # 2-member team, empty kanban — smallest passing fixture per verb
      lifecycle.ts        # 4-member team mirroring lifecycle.bats template (lead/reviewer/gitter/w1)
      multi-team.ts       # state shapes for atmux/sopx-mvp/ifca_aux/unum used in Phase 3
  runner.ts               # spawn bash atmux + capture {stdout, exit, fsDiff, discordCalls}
  compare.ts              # semantic diff: JSON-aware for state, byte-exact for stdout
  matrix.ts               # parity matrix — list of {verb, args, fixturePreset, expect}
  index.test.ts           # bun:test entry; iterates matrix, calls runner+compare per row
```

**Captured observables (per side):**

| Channel | Capture mechanism | Diff strategy |
|---|---|---|
| stdout | `Bun.spawn` stdout, decoded UTF-8 | Byte-exact when bash output is stable; semantic-aware when it embeds timestamps (mask `\d{2}:\d{2} MYT` → `HH:MM MYT`) |
| stderr | Same | Same; reviewer rule §9.5 means stderr divergence is a real signal |
| exit code | `proc.exited` | Strict equality |
| `.atmux/` post-state | Walk + read every file under `$ATMUX_DIR` after the verb returns | JSON files diffed via Zod-parsed canonical form; markdown/text byte-exact (after timestamp mask); inbox files match by `(member, lineCount, lastMsgID)` tuple to allow stable ordering |
| Discord webhook calls | Recording stub injected via env override (mechanism owned by ADR-008) — both runners emit each call as a JSONL line `{ts, payload, runner: bash|ts}` to a harness-managed sink | JSON-array semantic diff with `ts` masked; per-bullet emoji + named-template assertions per CLAUDE.md Discord format rule |

**Discord interception — mechanism owned by ADR-008; contract owned here.** ADR-008 (committed `d6ed626`) ratifies the env-override knob — `ATMUX_DISCORD_RECORDER` pointing at a JSONL sink path, with both bash and TS sides honouring it via the canonical `~/.claude/skills/whip/scripts/ping-discord.sh` routing (script-override path preserves CLAUDE.md's "all sends route through ping-discord.sh" rule). What this ADR contracts: every parity run produces an array `DiscordCall[] = {ts: ISO8601, payload: {content: string, ...}, runner: "bash" | "ts"}` and the harness compares them post-mask. Bash-side support for `ATMUX_DISCORD_RECORDER` is a porter-B Phase 2 follow-up per ADR-008's references.

**Runner contract:**

```ts
type ParityRun = {
  side: "bash" | "ts"
  verb: string
  args: string[]
  fixture: FixtureHandle           // path + cleanup
  stdout: string
  stderr: string
  exit: number
  fsState: FsSnapshot              // {path -> {bytes, mode, isJson, parsed?}}
  discordCalls: DiscordCall[]      // [{ts, payload}] from intercepted JSONL
  durationMs: number
}

type Divergence = {
  verb: string
  channel: "stdout" | "stderr" | "exit" | "fs" | "discord"
  bashSide: unknown
  tsSide: unknown
  detail: string                   // human-readable diff with file path or json-pointer
}

runVerb(side, verb, args, fixturePath): Promise<ParityRun>
compare(bash: ParityRun, ts: ParityRun): Divergence[]
```

`runVerb` is **idempotent at the fixture-handle level** — the harness creates a fresh tmpdir per call, copies the fixture preset in, then runs. Caller is responsible for cleanup; `bun:test` `afterEach` handles it.

**TS side stub for Phase 0.** Until a real TS verb exists, `runVerb("ts", …)` returns `exit=2`, `stdout=""`, `stderr="atmux-bun: not implemented"`. The Phase 0 deliverable is the harness *shape* — diff pipeline operational end-to-end on the stub. Phase 1 swaps the stub for the real `atmux-bun` binary as verbs land.

**Exit-status semantics — strict, no warning tier.** A parity test passes IFF `compare()` returns `[]`. Any non-empty `Divergence[]` fails the test, hard. There is no "soft" / "warning" / "expected-divergence-allowlist" tier — divergences are either fixed in code or addressed via an explicit ADR carve-out (CLAUDE.md "structural honesty over demo narrative"). This applies channel-by-channel:

- **exit code:** byte-equal int. `bash exit 1` ≠ `ts exit 2`. No "both nonzero" coalescing.
- **stdout:** byte-equal after masking only the documented timestamp pattern (`\d{2}:\d{2} MYT`). Any other diff is a real signal — silent whitespace drift, trailing-newline drift, ANSI escape drift all fail.
- **stderr:** byte-equal under the same mask. Reviewer rule §9.5 (no silent-error swallows) means stderr is part of the contract, not a debug channel.
- **fs state:** Zod-canonicalised JSON byte-equal; non-JSON files byte-equal; inbox files match by `(member, lineCount, lastMsgID)` tuple to allow stable tail ordering without losing append-only semantics.
- **discord:** every call's `payload` byte-equal in order, post-`ts`-mask.

Any divergence emits the 5-element bug-report shape (CLAUDE.md test-finding pattern): state-snapshot at every step, containment analysis, fix sketch with file:line, residue inventory, severity-with-context.

### 3.5 Reviewer regex enforcement (codified in CI alongside coverage)

PLAN.md §9 lists the 8-check gate by category; this ADR enumerates the exact regexes the reviewer (and CI lint pass) enforces. Coverage gating alone is necessary-not-sufficient — these regexes catch shape violations coverage can't see.

| Rule | Regex (multiline, `src/**/*.ts` only unless noted) | Allowed exception |
|---|---|---|
| No `JSON.parse` in domain code | `\bJSON\.parse\s*\(` | `src/abstractions/json.ts` ONLY (the IO boundary; ADR-005). Schemas use Zod's `schema.parse()` not raw `JSON.parse`. |
| No silent-error swallows | Empty: `catch\s*(?:\([^)]*\))?\s*\{\s*\}`. Non-empty without rethrow / `expected:` marker: `catch\s*(?:\([^)]*\))?\s*\{(?![^}]*\bthrow\b)(?![^}]*\bexpected:)` (broadened per ADR-006 R1 — `catch (e) { logger.warn(e) }` IS silent) | Inline preceding comment `// expected: <reason>` (per ADR-006); rethrow within the catch body; or wrap in `tagAndRethrow()` from `src/errors.ts` |
| No bash-style stderr suppression escapees | `2\s*>\s*\/dev\/null` (only matches if it leaks into TS as a literal string) | `src/abstractions/spawn.ts` (the spawn wrapper that justifies it once, ADR-007) |
| No raw `Date` formatting outside `time.ts` | `new Date\([^)]*\)\.toLocale|new Date\([^)]*\)\.toIso|Date\.now\(\)\.toString\(36\)` | `src/abstractions/time.ts` (ADR-012) |
| No raw `fetch` outside `http.ts` | `\bfetch\s*\(` | `src/abstractions/http.ts` (ADR-008 owns Discord layer on top) |
| No `Bun.spawn` outside `spawn.ts` | `\bBun\.spawn\s*\(` | `src/abstractions/spawn.ts` (ADR-007), `tests/parity/runner.ts` (harness needs raw spawn) |
| Conventional commit subject | `^(feat\|fix\|chore\|refactor\|test\|docs)(\(.+\))?:` (commitlint or git-hook) | None |
| ADR cross-ref on new src module | A `// ADR-NNN: <title>` comment within first 20 lines of any new `src/**/*.ts` (excluding generated, tests, fixtures) | Files with no architectural decision (pure helpers) explicitly carve out via `// ADR: pure helper, no design decision` |

Reviewer runs these as a `biome` plugin (preferred — single-tool config) or as a hand-rolled `tests/lint-rules.ts` invoked from CI before `bun test`. Implementation choice: TBD by foundation porter during ADR-007/008 work; this ADR ratifies the **rule set**, not the runner.

Each rule violation blocks the commit. The "explicit carve-out" mechanism — same as bypass discipline — requires a commit-body line `Approved exception: <reason>` AND a one-line code comment naming the rule waived. Lead acks via DM before reviewer merge-ok.

### 4. Bats spec port plan — `tests/e2e/<verb>.test.ts`

Each `tests/unit/<verb>.bats` ports 1:1 to `tests/e2e/<verb>.test.ts`:

- Every `@test "X"` block becomes one `test("X", ...)` call.
- `setup()` becomes `beforeEach`, `teardown()` becomes `afterEach`.
- `atmux_setup_sandbox` becomes `await makeFixture({preset: "minimal"})`.
- `run "$ATMUX_BIN" <verb>` becomes `await runVerb("ts", verb, args, fixture)`.
- Assertions on `$status`, `$output` become assertions on the `ParityRun` shape.

Mapping table maintained in `tests/e2e/PORT-MAP.md` so reviewer can verify 1:1 coverage at every commit.

### 5. `lifecycle.bats` — sequenced 1x-cold-start spec

The bats `lifecycle.bats` has 10 `@test` blocks each re-running `setup()` for independence. The TS port at `tests/e2e/lifecycle.test.ts` **inverts this** — one `beforeAll` cold-start, then 10 sequenced `test.step()` beats matching the bats blocks 1:1:

1. `start` creates session + one window per member
2. `send w1 "..."` lands text in pane
3. `dispatch + claim + done round-trip` (`task add` → `dispatch w1 <id>` → `done <id> --as w1`; kanban full-cycle in one beat)
4. `tell-lead` appends to driver-inbox + pings lead pane
5. `status` reports `session=<name>` + `[up]`
6. `whip` reports `all clean` while session is up
7. `whip` reports `DOWN` after `stop --force` (subsidiary `start` again to restore state for beats 8–10)
8. `stop` archives state (the second stop, post beat-7 restart)
9. `report --no-discord` produces shipped section with a completed task
10. `broadcast` lands in non-driver panes (requires fresh `start` if beat 8 stopped — sequenced spec opens a new tmux session for the broadcast beat per the bats `broadcast` test's setup expectations)

NB: PLAN.md §8.3 says "11 sequenced steps" — that count predates this ADR's bats audit. The bats reality is 10 blocks; I propose PLAN.md update to "10 sequenced beats matching `tests/e2e/lifecycle.bats` block-for-block, with intra-beat sub-actions captured as `test.step()` children". Lead to adjudicate. Architect's count of 13 in their review reflects expanding the dispatch beat into its 3 atomic actions (`task add` / `dispatch` / `done`) — those become `test.step()` children inside beat 3, not top-level beats. The shape: 10 top-level beats matching bats, with sub-steps for atomicity inside.

This is **stateful, non-idempotent — 1x cold-start+walk acceptance test**, NOT a streak-runnable smoke. CLAUDE.md test discipline requires this be documented in the spec's header docstring with the specific dependency chain.

**Header docstring template** (mandatory for any sequenced or seed-consuming e2e):

```ts
/**
 * Lifecycle e2e — 1x cold-start sequenced acceptance test.
 *
 * Non-idempotent. State chain (10 beats, 1:1 with lifecycle.bats blocks):
 * start → send → dispatch+claim+done → tell-lead → status → whip(clean)
 * → whip(DOWN after stop --force) → stop+archive → report → broadcast.
 *
 * DO NOT run this in a streak loop or stability soak. Each beat depends on
 * the prior beat's mutation (kanban row, archive dir, tmux session). Re-running
 * mid-chain triggers stale-state failures that look like flakes but are
 * actually the spec doing its job.
 *
 * Three signoff-grade shapes (CLAUDE.md):
 *   - 1x cold-start+walk: this spec, run as acceptance gate
 *   - Nx with cold-start-between: expensive idempotence proof, manual only
 *   - Non-consuming subset streak: selector-stability only, separate spec
 *
 * Pair: docs/adr-bun/009-test-strategy.md §5; PLAN.md §8.3.
 */
```

Pair this with PLAN.md §8.3 + any `DEMO.md` / `RUNBOOK.md` beat names — every runbook beat name must equal one `test.step()` label verbatim (CLAUDE.md "Pair demo runbook beats with rehearsal spec steps").

### 6. CI integration shape

`.github/workflows/ci.yml` runs in this order (all required for green):

1. `bun install --frozen-lockfile`
2. `biome lint && biome format --check`
3. `bun typecheck` (`tsc --noEmit`)
4. `bun test --coverage --coverage-reporter=lcov` — unit + e2e + parity-stub all in one run; `bun:test` collects per-file coverage and writes `coverage/lcov.info`
5. `bash tests/run.sh --shellcheck` — bash side keeps running until cutover; parity needs the bash binary green
6. **Manual lcov threshold gate** (see "Bun threshold gap" below) — parse `coverage/lcov.info`, compute per-file + aggregate line/function/branch coverage against the narrowed denominator, fail nonzero if any tracked file is below 100%
7. Upload `coverage/lcov.info` as artifact for trend-tracking

Parity tests run in CI on every commit that touches `src/verbs/**`, `src/abstractions/**`, or `tests/parity/**`. Path-filter via GH Actions `paths:` — full matrix on `main` and on PRs whose touched paths intersect those globs.

#### Bun threshold gap (1.3.13 — empirically validated)

`bunfig.toml`'s `coverageThreshold` is **parsed but not enforced** in Bun 1.3.13. Verified during ADR-009 §3 parity-skeleton review (`501cb1d` follow-up): a probe with `coverageThreshold = 1.00` against an `uncovered.ts` showing 66.67% line coverage **exited 0** (no gate fire). Both inline-table (`{ line = 1.0, ... }`) and table-section (`[test.coverageThreshold]`) and scalar (`coverageThreshold = 1.00`) syntaxes parse without error and silently no-op.

We can't rely on `bun test` self-enforcing the threshold today. Step 6 in the CI flow above replaces the built-in gate with a hand-rolled lcov parser that:

1. Reads `coverage/lcov.info` (lcov format: `SF:<path>` then `DA:<line>,<hits>` etc.).
2. Filters records by the narrowed denominator (apply `coveragePathIgnorePatterns` from `bunfig.toml` as the source of truth — single config point).
3. Computes line-hit% / function-hit% / branch-hit% per file.
4. Fails nonzero if any tracked file is below 100% on any of the four dimensions.
5. Emits a structured failure report listing which file/dimension breached, so reviewer can triage without re-running.

The parser lives at `tests/lcov-gate.ts` (lands in Phase 1; reviewer may wire from Phase 0 CI to fail the empty-skeleton case loudly with "no tracked files yet — gate vacuously passes" until `src/` lands). When upstream Bun fixes the threshold-enforcement bug we revisit this — likely keep the lcov parser anyway since it gives us per-file failure attribution Bun's built-in doesn't.

`coveragePathIgnorePatterns` glob shape — Bun 1.3.13 also has glob-matching quirks. Use `tests/**` (recursive) not `tests/` (directory-prefix). The narrowed denominator's exclusion globs (§2 above) follow this convention. Verify post-bump with `bunx bun-lcov-gate --dry-run` (Phase 1 deliverable).

## Consequences

**Positives:**

- Single runner (`bun:test`) — no Jest/Vitest/Playwright fragmentation. Test files run unit + e2e + parity through the same harness.
- 100% narrowed gate stays honest — the denominator names exactly what's tracked, so coverage can't be gamed by adding `index.ts` re-exports.
- Parity harness shape is now contract-level explicit — porters know exactly what stdout-vs-fs-vs-discord channels they need to match. Divergences surface as structured `Divergence[]` rows the auditor can triage without re-deriving the diff.
- Lifecycle e2e's non-idempotence is *captured* (header docstring, ADR cross-ref, CLAUDE.md citation) rather than living as folklore.
- Bash-side Discord interception via `ATMUX_DISCORD_WEBHOOK_URL=file://...` lets us prove webhook parity *during the port*, not just after — first parity-harness commit unblocks every Discord-emitting verb.

**Negatives:**

- Coverage gate at 100% is unforgiving. A single uncovered branch fails CI; reviewer becomes the unblock path. Mitigation: narrowed denominator already excludes the unforgiving categories (boilerplate, generated, dispatcher).
- `bun:test` is younger than Jest/Vitest. Coverage tooling (lcov reporter) had rough edges in pre-1.2 Bun. Current pin is 1.3.13 where this is stable, but a future regression is a real risk. Mitigation: pin Bun version in `mise.toml` + `engines.bun` in `package.json`; bump deliberately.
- Parity harness adds ~500 LOC of test infrastructure before any verb is testable end-to-end. This is Phase 0 + Phase 1 cost; pays back from Phase 2 onward.
- The `lifecycle.bats` → sequenced port loses the "each step is independent" property the bats spec had. Trade-off: bats version proved 11 isolated pieces work; TS version proves the chain works. We need both *eventually* — Phase 2 ports lifecycle as sequenced; a follow-up "selector-stability subset streak" spec covers the streak-runnable shape.

**Follow-up tickets:**

- ADR-005 (architect, Phase 0) — Zod schemas for `team.json` / `kanban.json` / inboxes. Parity fixture factory cross-refs these once published; until then `tests/parity/fixtures/schemas.ts` is the interim owner.
- ADR-007 (foundation, Phase 1) — `Bun.spawn` wrapper. Parity runner uses this for both bash and TS subprocess invocations; spawn pattern decisions feed back into runner.ts.
- ADR-008 (foundation, Phase 1) — Discord webhook layer. The `file://` interceptor pattern is contracted here; ADR-008 ratifies it from the producer side.
- ADR-010 (architect, Phase 0) — CLI dispatcher. `src/cli.ts` is in the tracked-coverage set (§2); `tests/unit/cli.test.ts` covers alias routing / unknown-verb / help-version / top-level-catch unit-style. `tests/e2e/cli.test.ts` (port of `cli.bats`) covers the dispatch-as-process e2e path.

## Alternatives considered

### A. Vitest + bash subprocess for parity

Rejected. Adds a second runner + its config + node-on-bun shim work. `bun:test` is API-compatible with Vitest's `describe/test/expect`, so migration cost is zero if we ever need to swap.

### B. Coverage at module-set granularity (e.g. "≥90% on `verbs/`, ≥80% on `lib/`")

Rejected. Different thresholds per dir produces a permanent argument about which branch is which dir's responsibility. 100% on a narrowed denominator is the simpler invariant — code is either tracked or not, with clear written rules for each.

### C. Lifecycle as 11 independent specs (mirroring bats)

Rejected. CLAUDE.md "stateful e2e" rule explicitly states a chain spec is a 1x cold-start acceptance test, not a stability smoke. Mirroring bats would mean re-creating the sandbox 11 times — each cold-start costs ~1–2s of tmux session setup, so 11x amplifies CI runtime for no semantic gain. The chain *is* the test; isolating beats hides chain bugs.

### D. Skip parity harness — rely on unit + e2e equivalence

Rejected. Unit tests prove the TS code matches its own spec, not that it matches *bash's behaviour*. CLAUDE.md "verify green from the right path" — a 200 from the TS verb tells us nothing about the bash verb's 200 unless we ran them both and diffed. Parity is the only honest cutover gate.

### E. Property-based testing (fast-check) for verb invariants

Considered, deferred. Property tests are valuable for pure transformations (kanban state machines, schema validators). Most atmux verbs are I/O-heavy with side effects (tmux, disk, network) where shrinking is hard and seed reproducibility matters more than search. Revisit in Phase 2 for `kanban.ts` or `cost.ts` if we find a pure-function nucleus worth fuzzing.

## References

- PLAN.md §8 (testing strategy), §9 (reviewer 8-check gate), §14 (auto-progression — parity harness IS the Phase 2/3 gate)
- CLAUDE.md "Testing Discipline" — narrowed denominator, stateful e2e, test-finding 5-element pattern, runbook-beat-spec pairing
- CLAUDE.md "Verification Discipline" — verify green from the right path
- ADR-005 (forthcoming) — Zod schemas for boundary JSON
- ADR-007 (forthcoming) — `Bun.spawn` wrapper
- ADR-008 (forthcoming) — Discord webhook layer
- ADR-014 §C — "redesign in v2" framing reinforces Phase 2 parity gate

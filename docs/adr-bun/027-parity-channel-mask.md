# ADR-027: Parity channel-mask contract (Option B per George 2026-05-05)

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

Phase 3 iter-1 (ADR-026) shipped the parity matrix foundation — `PARITY_MATRIX` populated for `version` + `unknown-verb` (2 rows green, both deterministic byte-equal cases) plus the `lifecycle` fixture preset. Iter-1 commit-2 prep (`8e82ed2`) and commit-4 prep (`33125ec`) probed at `/tmp/parity-probe` surfaced **two distinct classes of bash↔TS divergence** that block straightforward matrix-row activation for the remaining 8 ADR-026-tracked verbs.

### Class 1 — error-rendering style (init / start / send / add-member, ADR-026 row 6)

Probe at `/tmp/parity-probe` (~20:30 MYT) on the no-team config-error path:

- bash emits `💥 atmux <op> no team.json at <p> — run 'atmux init' first` to stderr / exits `1`.
- TS emits `atmux: config: no team.json at <p> (hint: run 'atmux init' first)` to stderr / exits `78` (BSD `EX_CONFIG` per ADR-006).

Same semantic outcome (both refuse + emit a no-team hint), different stylistic surface (emoji-tag vs structured-tag prefix; `1` vs `78`). ADR-006 is the canonical decision — TS keeps BSD sysexits; bash side stays frozen.

### Class 2 — state-after non-determinism (task / dispatch / inbox / done, ADR-026 row 3)

Probe at `/tmp/parity-probe` (~21:00 MYT) on `atmux task add 'test'`:

- `kanban.json` written with `id="t-XXXXXXXX"` (8-hex random) on each invocation.
- `createdAt` field is Unix epoch — differs on each invocation.

Both bash and TS write the same JSON shape with the same field set; only the random ID + timestamp values diverge. `compare.ts:176-189` does byte-equal / canonicalised JSON; without per-field masking, every invocation pushes a `Divergence` on `fs.<file>.parsed`.

### The shape problem

Both classes are **stylistic** divergence (rendering / random IDs / timestamps), not **semantic** divergence (state mutation, business logic, authz, missing tasks). The parity gate's purpose is catching the latter, not the former. ADR-009 §3 already establishes timestamp-mask precedent for stdout (e.g. `\[\d+ms\]` durations). What's missing is a uniform per-row, per-channel mask config that lets each row declare its noise channels inline + cite the divergence class.

George's call (2026-05-05 ~20:35 MYT, Option B): **mask the noise, don't reconcile the rendering.** ADR-006 stands; bash-side error rendering is frozen; TS keeps structured-tag + sysexits. The harness adapts.

## Decision

### 1. `ParityRow.mask` field — per-row, per-channel mask config

`tests/parity/matrix.ts`'s `ParityRow` type gains an optional `mask` field:

```ts
export type ParityRow = {
  verb: string;
  args: string[];
  fixturePreset: FixturePreset;
  expect: string;
  mask?: ChannelMask;
};

export type ChannelMask = {
  exitCode?: true;                      // skip exit-code channel comparison
  stdout?: RegExp | string;             // mask matching segments before byte-equal
  stderr?: RegExp | string;             // mask matching segments before byte-equal
  stateAfter?: Record<string, RegExp>;  // JSON-path-glob → field-value regex elision
};
```

Existing rows (`version`, `unknown-verb`) leave `mask` undefined — comparison stays byte-equal / exact. New rows opt in per channel.

### 2. `compare.ts` honours mask config

Each channel-comparison branch upgrades to honour the mask if present:

- **`exitCode`**: when `mask.exitCode === true`, skip the channel entirely (no `Divergence` regardless of value). Cited reason: `bash exit 1` vs `TS exit 78` (ADR-006 BSD sysexits).
- **`stdout` / `stderr`**: when `mask` is present, apply `String.replace(pattern, "")` (or empty-string substitution) to BOTH sides before byte-equal. Mirrors existing timestamp-mask precedent (ADR-009 §3).
- **`stateAfter`**: when `mask.stateAfter` is present, walk each `<json-path-glob>` (e.g. `kanban.tasks[*].id`), elide matching field values from BOTH sides' parsed JSON before deep-equal. The glob shape is `<top-level>.<key>[*].<field>` — wildcard array index, single-level for iter-2 (nested wildcards deferred).

Where a channel's mask is absent: existing exact comparison stands. The mask is purely additive.

### 3. Per-row mask schema convention

Mask additions in matrix rows must:

1. Cite the divergence class inline via `// reason:` comment on each entry.
2. Reference the ADR class — `(ADR-027 error-rendering class)` or `(ADR-027 state-after class)`.
3. Be specific — regex must match only the divergent surface, not silently broaden to absorb semantic differences.

Example (state-after mask):

```ts
{ verb: "task", args: ["add", "test"], fixturePreset: "lifecycle",
  expect: "exit-zero-stable-stdout",
  mask: {
    stateAfter: {
      "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/,        // reason: 8-hex random per invocation (ADR-027 state-after class)
      "kanban.tasks[*].createdAt": /^\d{10,}$/,        // reason: Unix epoch per invocation (ADR-027 state-after class)
    },
  },
},
```

Example (error-rendering mask):

```ts
{ verb: "init", args: ["--dry-run"], fixturePreset: "minimal",
  expect: "exit-nonzero-stable-stderr",
  mask: {
    exitCode: true,                                    // reason: bash exit 1 vs TS exit 78 (BSD sysexits per ADR-006)
    stderr: /^(💥 atmux \S+ |atmux: \S+: )/,           // reason: bash emoji-tag vs TS structured-tag prefix (ADR-027 error-rendering class)
  },
},
```

### 4. Reviewer discipline rule

Reviewer rejects mask additions that:

- Lack inline `// reason:` cite.
- Reference an undefined divergence class (must be `ADR-027 error-rendering class` or `ADR-027 state-after class`, or a future class added by ADR-027 amendment).
- Use a regex broad enough to absorb semantic content (e.g. `stderr: /.*/ ` would mask the entire channel — banned).

Reviewer's grep target: `mask:` blocks in `tests/parity/matrix.ts` — every entry must have an adjacent `// reason:` line.

### 5. NOT in scope of THIS commit

- **Mask infrastructure implementation.** This ADR pins the contract; `compare.ts` + `ParityRow` type changes land in commit 2 (`feat(parity): channel-mask infrastructure (compare.ts + ParityRow.mask)`).
- **Per-side fixture cloning.** Resolves the parallel-`runVerb` race documented at `version.test.ts:46-50`; lands in commit 3 (`fix(parity): per-side fixture cloning`).
- **State-mutating happy-path matrix rows.** ADR-026 row 3's 4 verbs (`task add` / `dispatch` / `inbox` / `done`) — land in commit 4 with state-after masks per §3 above.
- **Error-rendering matrix rows.** ADR-026 row 6's 4 verbs (`init` / `start` / `send` / `add-member`) — land in commit 5 with exitCode + stderr masks per §3 above.
- **ADR-006 amendment.** ADR-006 stands. TS keeps BSD sysexits + structured-tag stderr. Bash side stays frozen (out of scope per ADR-026 §Scope).
- **Bash-side error rendering changes.** Bash emits what bash emits (`💥` + exit 1). The mask absorbs the divergence on the harness side; bash source is untouched.
- **New mask classes.** Iter-2 covers error-rendering + state-after. Future classes (e.g. SHA-bearing log lines, environment-variable-injected paths) land via ADR-027 amendment + new class label.

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr,plan): ADR-027 — parity channel-mask contract (Option B per George)`**: this ADR file + PLAN.md §7 backlog row.
2. **Commit B — `feat(parity): channel-mask infrastructure (compare.ts + ParityRow.mask)`**: `ParityRow` extended; `compare.ts` upgraded to honour mask config across all 4 channels; harness self-tests added.
3. **Commit C — `fix(parity): per-side fixture cloning (resolves runVerb state-write race)`**: `index.test.ts` clones the fixture dir per-side before each row's `runVerb` pair; resolves `version.test.ts:46-50` limitation.
4. **Commit D — `test(parity): 4 state-mutating happy-path rows with masks (task/dispatch/inbox/done)`**: ADR-026 row 3 resolved.
5. **Commit E — `test(parity): 4 error-rendering rows with masks (init/start/send/add-member, ADR-026 row 6)`**: ADR-026 row 6 resolved.
6. **Commit F — `docs(adr-bun): ADR-026 — rows 3 + 6 done after iter-2 mask landings`**: ADR-026 update mirroring `33125ec` shape; rows 3 + 6 → ✅ done; §Consequences extended with iter-2 actual delivery.

Each commit standalone-passes typecheck + 100% coverage gate. Reviewer gates each per the 8-check protocol (PLAN.md §9).

## Out of plan / future work

- **Nested JSON-path globs in `stateAfter`.** Iter-2 ships single-level (`<top>.<key>[*].<field>`). When a verb writes nested random data (e.g. `kanban.tasks[*].history[*].id`), extend the glob parser. Likely additive amendment to this ADR.
- **Mask classes beyond error-rendering + state-after.** SHA-bearing stdout (e.g. `git log` snippets in verb output), environment-variable paths (e.g. `$HOME/.atmux/...` literal in stderr), or PID-bearing log lines may surface as iter-2+ porters add rows. Each new class adds a label + a §3 example block.
- **Mask coverage gate.** When iter-3+ matures, a CI assertion that no row uses a `.*`-broad mask (i.e. any mask must elide a regex narrower than total) could harden §4. Not yet — the cite-the-reason discipline is the iter-2 gate.
- **Cron-aware mask harness.** Cron-fired scenarios (whip / report / decisions-digest / groom) need a frozen-clock injector (ADR-026 row 6 deferred). When that lands, the timestamp-mask channel may move from per-row regex to harness-level clock injection — separate ADR.

## Consequences

- **Parity gate detects semantic divergence; ignores stylistic divergence.** State mutation correctness, business logic, authz, missing tasks → caught. Error-rendering shape, random IDs, timestamps → masked + cited.
- **ADR-006 stands.** TS keeps BSD sysexits + structured-tag stderr. No per-verb mirror-bash reconciliation commits needed (the original ADR-026 row 6 plan).
- **Bash side stays frozen.** Bash atmux's lib/** is unchanged; mask absorbs the divergence harness-side.
- **Matrix rows self-document divergence.** Every mask carries an inline `// reason:` cite + ADR class label. Reviewer's grep gate makes hidden masks impossible.
- **Iter-2 delivers 8 new rows + harness extensions in 6 commits.** ADR-026 rows 3 + 6 close together; iter-3+ inherits a working mask vocabulary for new divergence classes.
- **Mask vocabulary is forward-compatible.** New classes are additive (§5); existing rows unaffected by new class additions.

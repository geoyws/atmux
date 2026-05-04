# tests/parity — bash↔TS parity harness

**Spec:** [`docs/adr-bun/009-test-strategy.md`](../../docs/adr-bun/009-test-strategy.md) §3.

## Purpose

The parity harness runs every atmux verb twice — once via the bash binary at `bin/atmux` (frozen reference at HEAD 2aadc3f, the bash atmux this repo is porting *from*), once via the TS binary at `bin/atmux-bun` (port target) — against an identical fixture `.atmux/` directory, then semantic-diffs the two runs across five channels:

1. `stdout` — byte-equal after masking only the documented timestamp pattern (`\d{2}:\d{2} MYT`).
2. `stderr` — same mask. Reviewer rule §9.5 (no silent-error swallows) means stderr is contract, not debug.
3. `exit code` — strict integer equality.
4. `.atmux/` post-state — JSON files diffed via Zod-canonicalised form; non-JSON byte-equal; inboxes match by `(member, lineCount, lastMsgID)` tuple.
5. Discord webhook calls — JSONL captured via the recording stub (mechanism owned by ADR-008); diff strategy: ordered-array semantic equality with `ts` masked.

A parity test passes IFF the comparator returns `Divergence[] = []`. Any divergence is hard-fail and emits the 5-element bug-report shape (state-snapshot, containment, fix sketch, residue inventory, severity-with-context) per CLAUDE.md test-finding pattern.

## Layout

```
tests/parity/
  README.md              ← you are here
  runner.ts              ← spawn one side; capture stdout/stderr/exit/fs/discord
  compare.ts             ← semantic diff of two ParityRun captures
  matrix.ts              ← parity matrix — list of {verb, args, fixturePreset, expect}
  intercept-discord.ts   ← env-override webhook recording stub (ADR-008 ratifies mechanism)
  index.test.ts          ← bun:test entry; iterates matrix, calls runner+compare per row
  fixtures/
    README.md            ← Zod-validated factories live here, per ADR-005
    factory.ts           ← (forthcoming) makeFixture({preset, overrides}) → FixtureHandle
    schemas.ts           ← (forthcoming) interim Zod schemas, replaced by src/schema/* once ADR-005 lands
    presets/             ← (forthcoming) minimal / lifecycle / multi-team
```

## Phase 0 status

Skeleton only. `runner.ts`, `compare.ts`, and `intercept-discord.ts` have typed signatures with `// TODO(phase-1)` bodies that throw `not-implemented`. `matrix.ts` exports an empty array. `index.test.ts` iterates the empty matrix → zero tests run cleanly:

```
$ bun test tests/parity
 0 pass / 0 fail
```

This is intentional. The skeleton commits the **shape** — the diff pipeline contract — without yet exercising any verb. Phase 1 (foundation porter) wires the bash side first, then progressively the TS side as verbs land in Phase 2.

## How to add a verb to the matrix (Phase 2 onward)

```ts
// matrix.ts
export const PARITY_MATRIX: ParityRow[] = [
  { verb: "status", args: [], fixturePreset: "minimal", expect: "exit-zero-stable-stdout" },
  // ...
]
```

Then `bun test tests/parity` runs `runVerb("bash", ...)` + `runVerb("ts", ...)` + `compare(...)` per row and reports any `Divergence[]` as a hard fail.

## References

- ADR-009 §3 — full harness contract
- ADR-005 (forthcoming) — Zod schemas the fixture factory parses through
- ADR-007 (forthcoming) — `Bun.spawn` wrapper used by `runner.ts` (the harness gets the carve-out exception per §3.5)
- ADR-008 (forthcoming) — Discord webhook layer; ratifies the recording-stub env-override
- PLAN.md §8.2 + §14 — parity harness IS the gate for Phase 2/3 advancement
- CLAUDE.md "Verification Discipline" — verify green from the right path; truthy ≠ valid

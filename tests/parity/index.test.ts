// ADR-009: Test strategy — parity test entry.
//
// bun:test entry that iterates `PARITY_MATRIX` and runs runner+compare
// per row. Phase 3 iter-1 (ADR-026) wired the first 2 rows (version +
// unknown-verb); fixture materialisation goes through the factory.
//
// Subsequent porters add matrix rows + (where needed) fixture presets;
// this file does not change as rows are added — it iterates whatever
// `PARITY_MATRIX` exports.
//
// Per-side fixture cloning (ADR-027 commit 3): each row clones the
// materialised fixture into `<path>.bash` + `<path>.ts` BEFORE invoking
// the parallel `runVerb` pair. Each side mutates its own clone, so
// state-mutating verbs (task / dispatch / inbox / done) don't race
// each other's writes — `fsState` snapshots are independent. Read-only
// verbs (version, not-a-verb) are unaffected by the cloning; the
// per-side dirs just hold identical pre-state.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { PARITY_MATRIX, type ParityRow } from "./matrix.ts";
import { applyPreState } from "./pre-state.ts";
import { runVerb } from "./runner.ts";

describe("parity harness", () => {
  for (const row of PARITY_MATRIX) {
    const label = row.label ?? `${row.verb} ${row.args.join(" ")} [${row.fixturePreset}]`.trim();
    test(label, async () => {
      const fixture = await materializeFixture(row);
      const bashFixture = `${fixture.path}.bash`;
      const tsFixture = `${fixture.path}.ts`;
      await Promise.all([
        fs.cp(fixture.path, bashFixture, { recursive: true }),
        fs.cp(fixture.path, tsFixture, { recursive: true }),
      ]);
      // ADR-029 §3 — apply row-level pre-state to BOTH cloned sides
      // identically, AFTER clone + BEFORE runVerb. State-mutating
      // UPDATE-class rows seed kanban / inbox files here so dispatch /
      // claim / done have something to operate on.
      await Promise.all([
        applyPreState(bashFixture, row.preState),
        applyPreState(tsFixture, row.preState),
      ]);
      try {
        const [bashRun, tsRun] = await Promise.all([
          runVerb("bash", row.verb, row.args, bashFixture),
          runVerb("ts", row.verb, row.args, tsFixture),
        ]);
        const divergences = compare(bashRun, tsRun, row.mask);
        expect(divergences).toEqual([]);
      } finally {
        await Promise.all([
          fs.rm(bashFixture, { recursive: true, force: true }),
          fs.rm(tsFixture, { recursive: true, force: true }),
        ]);
        await fixture.cleanup();
      }
    });
  }
});

/**
 * Materialise a fresh fixture for the row's preset. Returns a
 * `FixtureHandle` so the caller can call `cleanup()` in a `finally`
 * block — the factory owns tmpdir lifetime per ADR-009 §3.
 *
 * The original handle holds the parent template; the test body clones
 * it into per-side dirs (`<path>.bash` + `<path>.ts`) so each side's
 * mutations are isolated. The original is cleaned up alongside the
 * clones in the test's `finally`.
 */
async function materializeFixture(row: ParityRow): Promise<FixtureHandle> {
  return makeFixture({ preset: row.fixturePreset });
}

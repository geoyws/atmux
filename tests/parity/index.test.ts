// ADR-009: Test strategy — parity test entry.
//
// bun:test entry that iterates `PARITY_MATRIX` and runs runner+compare
// per row. Phase 3 iter-1 (ADR-026) wired the first 2 rows (version +
// unknown-verb); fixture materialisation goes through the factory.
//
// Subsequent porters add matrix rows + (where needed) fixture presets;
// this file does not change as rows are added — it iterates whatever
// `PARITY_MATRIX` exports.

import { describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { PARITY_MATRIX, type ParityRow } from "./matrix.ts";
import { runVerb } from "./runner.ts";

describe("parity harness", () => {
  for (const row of PARITY_MATRIX) {
    const label = row.label ?? `${row.verb} ${row.args.join(" ")} [${row.fixturePreset}]`.trim();
    test(label, async () => {
      const fixture = await materializeFixture(row);
      try {
        const [bashRun, tsRun] = await Promise.all([
          runVerb("bash", row.verb, row.args, fixture.path),
          runVerb("ts", row.verb, row.args, fixture.path),
        ]);
        const divergences = compare(bashRun, tsRun);
        expect(divergences).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

/**
 * Materialise a fresh fixture for the row's preset. Returns a
 * `FixtureHandle` so the caller can call `cleanup()` in a `finally`
 * block — the factory owns tmpdir lifetime per ADR-009 §3.
 */
async function materializeFixture(row: ParityRow): Promise<FixtureHandle> {
  return makeFixture({ preset: row.fixturePreset });
}

// ADR-009: Test strategy — parity test entry.
//
// bun:test entry that iterates `PARITY_MATRIX` and runs runner+compare
// per row. Phase 0 ships an EMPTY matrix on purpose — `bun test
// tests/parity` exits 0 with zero tests, proving the skeleton type-checks
// and the diff pipeline shape compiles, without yet exercising any verb.
//
// Phase 2 porters add matrix rows incrementally; this file does NOT need
// to change as rows are added — it iterates whatever is exported.

import { describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { PARITY_MATRIX, type ParityRow } from "./matrix.ts";
import { runVerb } from "./runner.ts";

describe("parity harness", () => {
  if (PARITY_MATRIX.length === 0) {
    // Phase 0 skeleton — empty matrix is intentional. We declare
    // nothing; bun:test reports zero tests for this describe block.
    // (Per ADR-009: "bun test tests/parity exits 0 with zero tests.")
    return;
  }

  for (const row of PARITY_MATRIX) {
    const label = row.label ?? `${row.verb} ${row.args.join(" ")} [${row.fixturePreset}]`.trim();
    test(label, async () => {
      const fixturePath = await materializeFixture(row);
      try {
        const [bashRun, tsRun] = await Promise.all([
          runVerb("bash", row.verb, row.args, fixturePath),
          runVerb("ts", row.verb, row.args, fixturePath),
        ]);
        const divergences = compare(bashRun, tsRun);
        expect(divergences).toEqual([]);
      } finally {
        await cleanupFixture(fixturePath);
      }
    });
  }
});

/**
 * Phase 1 deliverable — wired to `tests/parity/fixtures/factory.ts`.
 * Phase 0 throws so an accidentally-non-empty matrix fails loudly.
 */
async function materializeFixture(_row: ParityRow): Promise<string> {
  throw new Error(
    "materializeFixture(): not implemented (Phase 0 skeleton — fixtures factory lands in Phase 1 once ADR-005 publishes schemas)",
  );
}

/**
 * Phase 1 deliverable — `rm -rf` the tmpdir created by the factory.
 */
async function cleanupFixture(_fixturePath: string): Promise<void> {
  throw new Error(
    "cleanupFixture(): not implemented (Phase 0 skeleton — fixtures factory lands in Phase 1)",
  );
}

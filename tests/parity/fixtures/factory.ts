// ADR-009 §3 + ADR-005: Parity fixture factory.
//
// Each parity test starts from a fresh `.atmux/` directory. This factory
// builds presets and materialises them on disk under a fresh tmpdir.
//
// Phase 1 implementation surface — `version`-verb stub only:
//   - `minimal` preset: empty fixture (no `.atmux/`). Sufficient for
//     verbs that don't read state, like `version`.
//   - `lifecycle` and `multi-team` presets throw `not-implemented`;
//     they land in Phase 2 alongside ADR-005's published Zod schemas.
//
// Phase 2 expansion:
//   - `lifecycle`: 4-member team mirroring `tests/e2e/lifecycle.bats`
//     (lead/reviewer/gitter/w1)
//   - `multi-team`: state shapes covering atmux/sopx-mvp/ifca_aux/unum
//
// Why Zod here when the production runtime already validates?
// Defence in depth at the FIXTURE AUTHORING boundary. Hand-written JSON
// drifts; a fixture that accidentally adds a key the runtime doesn't
// read produces a parity test that passes for the wrong reason. Parsing
// fixture inputs through the same schemas as runtime catches authoring
// errors at test-write time, not at parity-divergence time.
// CLAUDE.md "verify green from the right path".

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Fixture preset names. Mirrors `tests/parity/matrix.ts::FixturePreset`
 * — kept in sync there until ADR-005 publishes a single canonical type.
 */
export type FixturePreset = "minimal" | "lifecycle" | "multi-team";

/**
 * Handle returned by `makeFixture`. The caller (a `bun:test` `beforeEach`
 * or a parity-runner) holds onto `path` for the duration of the test
 * and `await cleanup()`s in `afterEach` — even on test failure.
 */
export type FixtureHandle = {
  /** Absolute path to the fixture root (the dir that contains `.atmux/`). */
  path: string;
  /** Idempotent. Removes the fixture tmpdir. */
  cleanup: () => Promise<void>;
};

export type MakeFixtureOpts = {
  preset: FixturePreset;
};

/**
 * Allocate a fresh fixture root under `os.tmpdir()` and materialise the
 * preset's `.atmux/` shape (or no shape, for `minimal`). Returns a
 * handle with absolute `path` + `cleanup()`.
 *
 * The `minimal` preset is the only one wired in Phase 1. It exists for
 * verbs that don't read or write `.atmux/` state — `version`, `--help`,
 * `doctor` (read-only path) — where the cheapest correct fixture is
 * "no fixture at all". Both bash and TS atmux MUST tolerate a fresh
 * cwd with no `.atmux/` for these verbs (and the version verb's case
 * statement in `bin/atmux` exits BEFORE the `atmux::maybe_offer_wizard`
 * check, confirming this is a safe shape).
 */
export async function makeFixture(opts: MakeFixtureOpts): Promise<FixtureHandle> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `atmux-parity-${opts.preset}-`));

  switch (opts.preset) {
    case "minimal":
      // No `.atmux/` materialised. The `version` verb (and any other
      // state-free verb) runs against an empty cwd. Both sides must
      // agree this is a valid invocation context.
      break;

    case "lifecycle":
    case "multi-team":
      // Cleanup the tmpdir before throwing so we don't leak filesystem
      // state on the not-implemented path.
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // expected: idempotent — best-effort cleanup on the throw path
      }
      throw new Error(
        `makeFixture: preset "${opts.preset}" not yet implemented (lands in Phase 2 once ADR-005 publishes src/schema/* and porters land state-touching verbs)`,
      );
  }

  let cleaned = false;
  return {
    path: dir,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // expected: idempotent — tmpdir may already be gone
      }
    },
  };
}

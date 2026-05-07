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
import * as path from "node:path";
import { compare, compareGolden, maskChannel } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { PARITY_MATRIX, type ParityRow } from "./matrix.ts";
import { applyPreState } from "./pre-state.ts";
import { runVerb } from "./runner.ts";

/**
 * Directory holding `bashOnly: true` row golden snapshots (ADR-028).
 * Created on first capture; absent until a bash-only row lands.
 */
const GOLDEN_DIR = path.join(import.meta.dir, "golden");

/**
 * Capture flag (ADR-028 golden-file harness mode). When set, bash-only
 * rows write/overwrite their golden file with the post-mask bash stdout
 * and pass without comparison. Operator runs:
 *   `ATMUX_PARITY_UPDATE_GOLDENS=1 bun test tests/parity/`
 * to seed/refresh goldens after intentional bash-side changes.
 */
const UPDATE_GOLDENS = process.env.ATMUX_PARITY_UPDATE_GOLDENS === "1";

/**
 * Slugify a row's label (or verb + args) into a filesystem-safe id for
 * `tests/parity/golden/<id>.txt`. Lowercase, non-alphanumerics → `-`,
 * collapsed runs → single `-`, trimmed leading/trailing `-`.
 */
function rowGoldenId(row: ParityRow): string {
  const raw = row.label ?? `${row.verb}-${row.args.join("-")}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

describe("parity harness", () => {
  for (const row of PARITY_MATRIX) {
    const label = row.label ?? `${row.verb} ${row.args.join(" ")} [${row.fixturePreset}]`.trim();
    test(label, async () => {
      const fixture = await materializeFixture(row);
      try {
        if (row.bashOnly === true) {
          await runBashOnlyRow(row, fixture);
        } else {
          await runFullParityRow(row, fixture);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

/**
 * Execute a full bash↔TS row: clone fixture per side, apply preState,
 * spawn both sides in parallel, run comparator. Existing path —
 * unchanged behaviour for every row without `bashOnly: true`.
 */
async function runFullParityRow(row: ParityRow, fixture: FixtureHandle): Promise<void> {
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
  }
}

/**
 * Execute a bash-only golden-file row (ADR-028): clone fixture for
 * bash side only, apply preState, spawn bash with optional `bashBin`
 * override. In capture mode (`ATMUX_PARITY_UPDATE_GOLDENS=1`) write the
 * post-mask stdout to `tests/parity/golden/<row-id>.txt` and pass; in
 * comparison mode, read the golden and call `compareGolden`.
 */
async function runBashOnlyRow(row: ParityRow, fixture: FixtureHandle): Promise<void> {
  const bashFixture = `${fixture.path}.bash`;
  await fs.cp(fixture.path, bashFixture, { recursive: true });
  await applyPreState(bashFixture, row.preState);
  try {
    const bashRun = await runVerb(
      "bash",
      row.verb,
      row.args,
      bashFixture,
      row.bashBin !== undefined ? { bashBin: row.bashBin } : undefined,
    );
    const goldenPath = path.join(GOLDEN_DIR, `${rowGoldenId(row)}.txt`);
    if (UPDATE_GOLDENS) {
      await fs.mkdir(GOLDEN_DIR, { recursive: true });
      await fs.writeFile(goldenPath, maskChannel(bashRun.stdout, row.mask?.stdout));
      // Pass unconditionally in capture mode; surface to operator that
      // a golden was written so the audit trail isn't silent.
      // eslint-disable-next-line no-console
      console.log(`[parity] updated golden: ${goldenPath}`);
      return;
    }
    let golden: string;
    try {
      golden = await fs.readFile(goldenPath, "utf8");
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
        throw new Error(
          `golden missing: ${goldenPath}\n` +
            `Run \`ATMUX_PARITY_UPDATE_GOLDENS=1 bun test tests/parity/\` to capture.`,
        );
      }
      throw err;
    }
    const divergences = compareGolden(bashRun, golden, row.mask);
    expect(divergences).toEqual([]);
  } finally {
    await fs.rm(bashFixture, { recursive: true, force: true });
  }
}

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

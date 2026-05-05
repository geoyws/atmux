/**
 * Parity harness — unknown-verb path (`not-a-verb`).
 *
 * **Exit-code divergence proof.** The `version` parity test (commit
 * `18cd48a`) proves the harness works on the happy path: stdout-equal,
 * exit-zero, no state, no Discord. This fixture proves it ALSO catches
 * a different divergence channel — exit-code-class — by exercising the
 * unknown-verb error path where bash and TS must both exit 64 (BSD
 * `EX_USAGE`) with a byte-equal two-line stderr.
 *
 * Why two parity tests instead of one? Phase 2 / Phase 3 confidence
 * needs the harness's *negative-space* coverage: a parity test that
 * only ever sees the success path can't prove it would catch an
 * exit-code drift. By running a verb that intentionally fails, every
 * comparator channel that mattered for `version` (exit, stdout, stderr,
 * fs, discord) gets exercised in its non-zero / non-empty shape too.
 *
 * Bash side spec — `tests/unit/cli.bats:41-45`:
 *   @test "cli: unknown verb exits 64" {
 *     run "$ATMUX_BIN" not-a-verb
 *     [ "$status" -eq 64 ]
 *     [[ "$output" =~ "unknown verb" ]]
 *   }
 *
 * TS side spec — `src/cli.ts::dispatch` throws `UsageError`, caught by
 * `reportError` which writes `atmux: <what>\n  <hint>\n` to stderr and
 * returns exit 64 (per ADR-006 `EX_USAGE` mapping). Verified post-#9
 * (commit ratifying the 1→64 fix shipped before this fixture lands).
 *
 * Idempotent — fresh fixture per test, no `.atmux/` materialised
 * (unknown-verb path in bash dispatcher exits BEFORE the wizard /
 * team.json checks). Safe to run in a streak loop. Same shape as
 * `version.test.ts`: non-consuming, non-stateful, all three CLAUDE.md
 * signoff-grade shapes apply.
 *
 * Pair: docs/adr-bun/009-test-strategy.md §3 (harness contract);
 *       docs/adr-bun/006-error-handling.md (`UsageError` → exit 64);
 *       PLAN.md §8.2 (parity gate);
 *       Task #9 (TS exit-code 1→64 fix); Task #11 (this fixture);
 *       tests/unit/cli.bats:41-45 (bash bats spec we mirror);
 *       tests/parity/version.test.ts (sister fixture, happy-path proof).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { runVerb } from "./runner.ts";

describe("parity: unknown verb (`not-a-verb` exit-code divergence proof)", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "minimal" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("bash and ts both exit 64 + emit 'unknown verb' stderr, no state, no discord", async () => {
    const [bash, ts] = await Promise.all([
      runVerb("bash", "not-a-verb", [], fixture.path),
      runVerb("ts", "not-a-verb", [], fixture.path),
    ]);

    // Sanity rails — verify each side independently before trusting
    // the diff. CLAUDE.md "verify green from the right path": a
    // parity-green result against a wedged child is false-green. Here
    // we additionally pin the EXIT CODE CLASS to 64 (BSD EX_USAGE) so
    // a "both sides accidentally exit 1" regression fails this test
    // even if comparator returns [].
    expect(bash.exit).toBe(64);
    expect(ts.exit).toBe(64);
    expect(bash.stdout).toBe("");
    expect(ts.stdout).toBe("");
    expect(bash.stderr).toContain("unknown verb");
    expect(ts.stderr).toContain("unknown verb");
    expect(bash.discordCalls).toEqual([]);
    expect(ts.discordCalls).toEqual([]);
    expect(bash.fsState).toEqual({});
    expect(ts.fsState).toEqual({});

    // The actual parity contract — comparator returns `[]` IFF every
    // observable channel matches post-mask. This includes the BYTE-
    // EQUAL stderr check (not just the substring rail above), so a
    // hint-line drift, indent drift, or trailing-newline drift would
    // surface here.
    const divergences = compare(bash, ts);
    expect(divergences).toEqual([]);
  });
});

/**
 * Parity harness — `version` verb.
 *
 * **First operational parity-verb stub** per PLAN.md §14 Phase 1 → Phase 2
 * exit gate: "parity harness operational with at least one stub TS verb".
 *
 * The `version` verb is the smallest possible parity surface: it touches
 * no `.atmux/` state, emits no Discord webhook calls, and just prints
 * `atmux 0.3.0` and exits 0. That makes it the right first verb to prove
 * the diff pipeline shape end-to-end before larger verbs (whip, status,
 * report) land in Phase 2.
 *
 * Idempotent — each `test()` makes a fresh fixture and tears it down on
 * completion. SAFE to run in a streak loop, unlike `lifecycle.test.ts`
 * (per ADR-009 §5 + CLAUDE.md "stateful e2e specs are not repeatable
 * smokes"). The version verb is the *opposite* of stateful: zero state
 * mutated, zero Discord posted, run-N is identical to run-1.
 *
 * Three signoff-grade shapes (CLAUDE.md), all valid for this spec:
 *   - 1x cold-start+walk: trivial — there's nothing to walk
 *   - Nx with cold-start-between: equally trivial
 *   - Non-consuming subset streak: this whole file IS that shape
 *
 * Pair: docs/adr-bun/009-test-strategy.md §3 (harness contract);
 *       PLAN.md §8.2 + §14 (parity gate, Phase 1 → Phase 2 criterion);
 *       src/verbs/version.ts (TS implementation, commit bda7941);
 *       lib/common.sh::atmux::version + bin/atmux dispatcher (bash impl).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { runVerb } from "./runner.ts";

describe("parity: version (first operational stub per PLAN.md §14)", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "minimal" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("bash and ts both emit `atmux 0.3.0`, exit 0, no state, no discord", async () => {
    // Run both sides in parallel against the same fresh fixture cwd.
    // The version verb doesn't read/write `.atmux/` so parallel is safe;
    // verbs that touch state will need sequential runs against separate
    // fixture clones (Phase 2 harness expansion).
    const [bash, ts] = await Promise.all([
      runVerb("bash", "version", [], fixture.path),
      runVerb("ts", "version", [], fixture.path),
    ]);

    // Sanity rails — verify each side independently before trusting the
    // diff. CLAUDE.md "verify green from the right path": a parity-green
    // result against a wedged child is false-green.
    expect(bash.exit).toBe(0);
    expect(ts.exit).toBe(0);
    expect(bash.stdout).toBe("atmux 0.3.0\n");
    expect(ts.stdout).toBe("atmux 0.3.0\n");
    expect(bash.stderr).toBe("");
    expect(ts.stderr).toBe("");
    expect(bash.discordCalls).toEqual([]);
    expect(ts.discordCalls).toEqual([]);
    expect(bash.fsState).toEqual({});
    expect(ts.fsState).toEqual({});

    // The actual parity contract — comparator returns `[]` IFF every
    // observable channel matches post-mask. Any non-empty array is a
    // hard fail, with structured Divergence rows surfacing the diff.
    const divergences = compare(bash, ts);
    expect(divergences).toEqual([]);
  });
});

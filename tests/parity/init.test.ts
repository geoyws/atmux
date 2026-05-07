/**
 * Parity harness — `init` verb (lifecycle MVP wave skeleton).
 *
 * Bash side scaffolds `.atmux/team.json` from `templates/team.example.json`
 * (default non-wizard mode), creates `inboxes/`, `logs/`, `state/`,
 * `archive/` dirs, primes per-member inbox JSONs, and writes
 * `kanban.json` + `driver-inbox.md`. TS port lands via Task #13
 * (`porter-a1`); until that ships this skeleton is `test.todo` so the
 * wiring is parked but does not fail CI (verified: `test.todo` body
 * is registered for the typechecker but not executed; `beforeEach` /
 * `afterEach` hooks also do not run when no active `test()` exists in
 * the describe block — see Bun 1.3.13 probe in skeleton's commit msg).
 *
 * Bash source-cite (per CLAUDE.md "lead must source-grep bash before
 * writing parity-port task descriptions"):
 *   `lib/init.sh:10-60`  — `main()`: arg parse, dir scaffold, dispatch
 *                          to wizard or template path, prime kanban +
 *                          driver-inbox + per-member inbox JSONs.
 *   `lib/init.sh:62-69`  — `_atmux_init_template`: `jq` clone of
 *                          `templates/team.example.json` with `name` +
 *                          `members[].cwd` stamped to invocation cwd.
 *   `templates/team.example.json` — canonical 9-member shape init
 *                                   reproduces in non-wizard mode.
 *   `bin/atmux:117-118` — dispatcher carve-out: `init|wizard|doctor|up`
 *                          skip the auto-wizard offer.
 *
 * **Default-mode determinism.** Non-wizard `init` does NO emoji
 * assignment (template is cloned as-is then `name` + `members[].cwd`
 * are stamped). That makes parity-green tractable — wizard mode
 * randomises emoji and is intentionally OUT of scope for the skeleton.
 *
 * **Idempotent** — fresh tmpdir per test via
 * `makeFixture({preset:"minimal"})`. Both bash and TS write to the same
 * fixture cwd, so the JSON's stamped `cwd` field collapses to the same
 * absolute path on both sides; the comparator's snapshot-rel-path
 * mapping handles tmpdir-name variation across runs without divergence.
 *
 * Three signoff-grade shapes (CLAUDE.md):
 *   - 1x cold-start+walk: trivial — `init` scaffolds, no chain to walk
 *   - Nx with cold-start-between: equally trivial (idempotent across runs)
 *   - Non-consuming subset streak: this whole file IS that shape
 *
 * Pair: `docs/adr-bun/009-test-strategy.md` §3 (harness contract);
 *       `PLAN.md` §8.2 + §14 (parity gate, Phase 2 progression);
 *       Task #13 (init verb port — flip `test.todo` → `test` once landed);
 *       Task #21 (this skeleton);
 *       `lib/init.sh` + `templates/team.example.json` (bash impl);
 *       `tests/parity/version.test.ts` (sister fixture, pattern source).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { runVerb } from "./runner.ts";

describe("parity: init (lifecycle MVP skeleton — bash captured, ts-side todo until #13 lands)", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "minimal" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test.todo("init --name <team>: bash and ts both scaffold .atmux/ from templates/team.example.json", async () => {
    const args = ["--name", "parity-skeleton-team"] as const;
    const [bash, ts] = await Promise.all([
      runVerb("bash", "init", args, fixture.path),
      runVerb("ts", "init", args, fixture.path),
    ]);

    // Sanity rails — verify bash side independently green BEFORE
    // trusting the comparator. CLAUDE.md "verify green from the right
    // path": a parity-green result against a wedged child is false-green.
    expect(bash.exit).toBe(0);
    expect(bash.stdout).toContain("initialized atmux team 'parity-skeleton-team'");
    expect(bash.stderr).toBe("");
    expect(bash.discordCalls).toEqual([]);
    // Bash creates 9 inbox files + driver-inbox.md + kanban.json +
    // team.json + dirs — fsState non-empty post-run.
    expect(Object.keys(bash.fsState).length).toBeGreaterThan(0);
    expect(bash.fsState[".atmux/team.json"]).toBeDefined();
    expect(bash.fsState[".atmux/kanban.json"]).toBeDefined();
    expect(bash.fsState[".atmux/driver-inbox.md"]).toBeDefined();

    // TS side rails — porter #13 must reproduce the same shape
    // byte-equal to flip this test green.
    expect(ts.exit).toBe(0);
    expect(ts.discordCalls).toEqual([]);

    // The actual parity contract — comparator returns `[]` IFF every
    // observable channel matches post-mask across stdout / stderr /
    // exit / fs / discord. Non-empty array surfaces structured
    // Divergence rows the porter triages without re-running.
    const divergences = compare(bash, ts);
    expect(divergences).toEqual([]);
  });
});

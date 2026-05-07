/**
 * Parity harness — `start` verb (lifecycle MVP wave skeleton).
 *
 * `start` brings up the team's tmux session + spawns one window per
 * member. The happy path requires (a) a valid `team.json` AND (b) an
 * isolated tmux socket (per CLAUDE.md "tmux tests must use `-L
 * <unique-socket>`, never the default server"). Neither is plumbed in
 * this skeleton — the harness uses the default tmux socket today, and
 * the fixture factory's `lifecycle` preset still throws `not-implemented`.
 *
 * What this skeleton DOES test (via the `test.todo` body porters flip
 * on once Task #14 lands `src/verbs/start.ts`): the **no-team error
 * path** — `atmux start --no-doctor` against an empty fixture. Both
 * sides should reach `requireTeam()` and emit the same "no team.json"
 * stderr + exit code. This is testable WITHOUT touching the user's
 * default tmux server because `--no-doctor` skips the preflight and
 * `requireTeam()` fires before any tmux call.
 *
 * The **happy-path lifecycle test** (start spawns N windows, kills
 * them clean) is OUT OF SCOPE for the skeleton and lands as a Phase 2
 * follow-up alongside the `lifecycle` preset + tmux-socket isolation
 * (likely the same commit that ports `tests/e2e/lifecycle.bats`).
 *
 * Bash source-cite (per CLAUDE.md "lead must source-grep bash before
 * writing parity-port task descriptions"):
 *   `lib/start.sh:9-24`   — `main()`: arg parse for `--force` /
 *                            `--doctor` / `--no-doctor`.
 *   `lib/start.sh:11-12`  — `atmux::require_team` call: dies with
 *                            "no team.json at <path> — run 'atmux init'
 *                            first" + exit 1 when fixture is empty.
 *   `lib/start.sh:26-39`  — doctor preflight gate (skipped via
 *                            `--no-doctor`; relevant because skipping
 *                            is what makes the no-team path testable).
 *   `lib/common.sh:102-106` — `atmux::require_team` impl (the shared
 *                              die-message both sides must match).
 *
 * **Idempotent** — fresh tmpdir per test via
 * `makeFixture({preset:"minimal"})`. The verb dies BEFORE the
 * `tmux new-session` line (`lib/start.sh:57`), so no tmux state leaks
 * across runs. Safe to run in a streak loop, unlike a happy-path
 * lifecycle spec (CLAUDE.md "stateful e2e specs are not repeatable
 * smokes").
 *
 * Pair: `docs/adr-bun/009-test-strategy.md` §3 (harness contract) + §5
 *       (lifecycle e2e separate from this skeleton);
 *       `PLAN.md` §8.2 + §14 (parity gate);
 *       Task #14 (start verb port — flip `test.todo` → `test` once
 *       landed and reconcile bash `💥 atmux …` vs TS `atmux: config:`
 *       error rendering for parity-green);
 *       Task #21 (this skeleton);
 *       `lib/start.sh` + `lib/common.sh::atmux::require_team` (bash
 *       impl); `tests/parity/version.test.ts` (sister, happy-path proof);
 *       `tests/parity/unknown-verb.test.ts` (sister, error-path proof).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { runVerb } from "./runner.ts";

describe("parity: start (lifecycle MVP skeleton — no-team error path; happy-path waits on lifecycle preset + tmux isolation)", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "minimal" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test.todo("start --no-doctor: bash and ts both die with 'no team.json' on empty fixture", async () => {
    const args = ["--no-doctor"] as const;
    const [bash, ts] = await Promise.all([
      runVerb("bash", "start", args, fixture.path),
      runVerb("ts", "start", args, fixture.path),
    ]);

    // Sanity rails — bash side independently green (the no-team die
    // path) BEFORE the comparator is trusted. CLAUDE.md "verify green
    // from the right path".
    expect(bash.exit).toBe(1);
    expect(bash.stdout).toBe("");
    expect(bash.stderr).toContain("no team.json");
    expect(bash.stderr).toContain("run 'atmux init' first");
    expect(bash.discordCalls).toEqual([]);
    // No fixture mutation — the verb dies before any mkdir / tmux call.
    expect(bash.fsState).toEqual({});

    // TS side rails — porter #14 reconciles `ConfigError` rendering
    // (currently `atmux: config: no team.json at <p>`) with the bash
    // `💥 atmux no team.json at <p> — run 'atmux init' first` shape.
    // Exit code reconciliation: bash dies exit 1, TS `ConfigError`
    // exits 78 (EX_CONFIG) — porter chooses one and amends ADR-006 if
    // diverging from BSD sysexits.
    expect(ts.discordCalls).toEqual([]);

    // The actual parity contract — comparator returns `[]` IFF every
    // observable channel matches post-mask. Stderr byte-equal,
    // exit-code byte-equal, no fs side-effects, no discord.
    const divergences = compare(bash, ts);
    expect(divergences).toEqual([]);
  });
});

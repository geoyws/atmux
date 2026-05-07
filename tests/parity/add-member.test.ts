/**
 * Parity harness — `add-member` verb (lifecycle MVP wave skeleton).
 *
 * `add-member` appends a new member to `team.json`, primes their inbox
 * JSON, and (if a tmux session is up) spawns their window. The happy
 * path runs against a pre-existing `team.json` and either DOES or
 * DOESN'T touch tmux depending on session state — when no session
 * exists, bash logs "  run 'atmux start' …" and exits 0, no tmux side
 * effects. That makes the happy path testable WITHOUT tmux isolation,
 * once the fixture factory's `lifecycle` preset (or an inline minimal
 * `team.json`) is plumbed.
 *
 * Pending that, this skeleton parks the **no-team error path** —
 * `atmux add-member newbie --role member --tui claude` against an empty
 * fixture. `lib/add-member.sh:11` calls `atmux::require_team`, which
 * dies with "no team.json at <path> — run 'atmux init' first" + exit 1
 * BEFORE the tmux session-existence check (`lib/add-member.sh:55`).
 * Both sides should match on this shape once Task #16 lands
 * `src/verbs/add-member.ts` and routes through `requireTeam()` in
 * `src/core/common.ts`.
 *
 * The **happy-path test** (member appended to team.json + emoji stamp +
 * inbox primed) is OUT OF SCOPE for the skeleton and lands as a Phase 2
 * follow-up alongside the `lifecycle` preset implementation, since
 * happy-path requires a pre-existing team.json which the `minimal`
 * preset deliberately omits.
 *
 * Bash source-cite (per CLAUDE.md "lead must source-grep bash before
 * writing parity-port task descriptions"):
 *   `lib/add-member.sh:11-12`  — `atmux::require_team` call: dies on
 *                                 empty fixture before any state mutation.
 *   `lib/add-member.sh:14-30`  — arg parse: positional `name` +
 *                                 `--role` / `--tui` / `--model` /
 *                                 `--cwd` / `--command` flags.
 *   `lib/add-member.sh:42-47`  — `atmux::jq_update` writes the new
 *                                 member (with emoji) to team.json.
 *   `lib/add-member.sh:55-60`  — tmux-session branch: spawns the
 *                                 window IF a session exists; logs the
 *                                 "run start" hint otherwise.
 *   `lib/common.sh:102-106`    — `atmux::require_team` shared impl
 *                                 (the die-message both sides must match).
 *
 * **Idempotent** — fresh tmpdir per test via
 * `makeFixture({preset:"minimal"})`. The verb dies before any
 * `jq_update` / `tmux new-window` call, so no fixture state mutates and
 * no tmux server is touched. Safe to run in a streak loop.
 *
 * Pair: `docs/adr-bun/009-test-strategy.md` §3 (harness contract);
 *       `PLAN.md` §8.2 + §14 (parity gate);
 *       Task #16 (add-member verb port — flip `test.todo` → `test`
 *       once landed; happy-path follow-up needs `lifecycle` preset);
 *       Task #21 (this skeleton);
 *       `lib/add-member.sh` + `lib/common.sh::atmux::require_team`
 *       (bash impl); `tests/parity/start.test.ts` (sister error-path
 *       skeleton in the same wave).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { runVerb } from "./runner.ts";

describe("parity: add-member (lifecycle MVP skeleton — no-team error path; happy-path waits on lifecycle preset)", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "minimal" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test.todo("add-member newbie --role member --tui claude: bash and ts both die with 'no team.json' on empty fixture", async () => {
    const args = ["newbie", "--role", "member", "--tui", "claude"] as const;
    const [bash, ts] = await Promise.all([
      runVerb("bash", "add-member", args, fixture.path),
      runVerb("ts", "add-member", args, fixture.path),
    ]);

    // Sanity rails — bash side independently green (the no-team die
    // path) BEFORE the comparator is trusted. CLAUDE.md "verify green
    // from the right path".
    expect(bash.exit).toBe(1);
    expect(bash.stdout).toBe("");
    expect(bash.stderr).toContain("no team.json");
    expect(bash.stderr).toContain("run 'atmux init' first");
    expect(bash.discordCalls).toEqual([]);
    // No fixture mutation — the verb dies before jq_update / inbox-prime.
    expect(bash.fsState).toEqual({});

    // TS side rails — porter #16 reconciles `ConfigError` rendering
    // and exit code with bash's `atmux::die` shape (see start.test.ts
    // header for the exit-1 vs exit-78 reconciliation note).
    expect(ts.discordCalls).toEqual([]);

    // The actual parity contract — comparator returns `[]` IFF every
    // observable channel matches post-mask. Stderr byte-equal,
    // exit-code byte-equal, no fs side-effects, no discord.
    const divergences = compare(bash, ts);
    expect(divergences).toEqual([]);
  });
});

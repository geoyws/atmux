/**
 * Parity harness — `send` verb (lifecycle MVP wave skeleton).
 *
 * `send` writes text into a member's TUI pane via `tmux send-keys`
 * (load-buffer + paste-buffer + Enter). The happy path requires (a) a
 * valid `team.json` AND (b) a running tmux session (per
 * `lib/send.sh:62`: dies with "no tmux window for <m> (is the team
 * running?)" otherwise). Both prerequisites need fixture machinery
 * that's still pending — `lifecycle` preset for team.json,
 * tmux-socket-isolation for the session — so the skeleton parks the
 * **no-team error path** instead.
 *
 * Bash side: `atmux send w1 "hello"` against an empty fixture hits
 * `atmux::require_team` (`lib/send.sh:11`) and dies with "no team.json
 * at <path> — run 'atmux init' first" + exit 1, BEFORE any
 * `tmux capture-pane` / `tmux send-keys` call. That makes this
 * testable without touching the user's default tmux server, satisfying
 * the CLAUDE.md "tmux tests must use `-L <unique-socket>`" rule by
 * never reaching the tmux call at all.
 *
 * The **happy-path test** (`send` verifies pane state, load-buffers
 * the message, sends Enter, soft-checks consumption) is OUT OF SCOPE
 * for the skeleton and lands as a Phase 2 follow-up alongside Task #7
 * (`src/core/send.ts` foundation, in_progress) + Task #17 (`send` verb
 * CLI wrapper, blocked on #7) + tmux-socket isolation work.
 *
 * Bash source-cite (per CLAUDE.md "lead must source-grep bash before
 * writing parity-port task descriptions"):
 *   `lib/send.sh:11-12`     — `atmux::require_team` call: dies on
 *                              empty fixture before any tmux call.
 *   `lib/send.sh:35-43`     — arg parse: `<member> <msg…>` after
 *                              `--include-driver` / `--no-submit` /
 *                              `--no-verify` flags consumed.
 *   `lib/send.sh:58-110`    — `atmux::send_to_member` happy path:
 *                              capture pane + ready heuristic + load /
 *                              paste / Enter + verify (tmux dependent;
 *                              out of skeleton scope).
 *   `lib/common.sh:102-106` — `atmux::require_team` shared impl (the
 *                              die-message both sides must match).
 *
 * **Idempotent** — fresh tmpdir per test via
 * `makeFixture({preset:"minimal"})`. Verb dies before any tmux /
 * load-buffer / send-keys call. No fixture state mutates, no tmux
 * server touched. Safe to run in a streak loop.
 *
 * Pair: `docs/adr-bun/009-test-strategy.md` §3 (harness contract);
 *       `PLAN.md` §8.2 + §14 (parity gate);
 *       Task #7 (`src/core/send.ts` foundation — happy-path follow-up
 *       depends on this);
 *       Task #17 (send verb CLI wrapper — flip `test.todo` → `test`
 *       once landed; happy-path follow-up needs lifecycle preset +
 *       tmux isolation);
 *       Task #21 (this skeleton);
 *       `lib/send.sh` + `lib/common.sh::atmux::require_team` (bash impl);
 *       `tests/parity/start.test.ts`, `tests/parity/add-member.test.ts`
 *       (sister error-path skeletons in the same wave).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compare } from "./compare.ts";
import { type FixtureHandle, makeFixture } from "./fixtures/factory.ts";
import { runVerb } from "./runner.ts";

describe("parity: send (lifecycle MVP skeleton — no-team error path; happy-path waits on #7+#17 + tmux isolation)", () => {
  let fixture: FixtureHandle;

  beforeEach(async () => {
    fixture = await makeFixture({ preset: "minimal" });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test.todo(
    "send w1 'hello': bash and ts both die with 'no team.json' on empty fixture",
    async () => {
      const args = ["w1", "hello"] as const;
      const [bash, ts] = await Promise.all([
        runVerb("bash", "send", args, fixture.path),
        runVerb("ts", "send", args, fixture.path),
      ]);

      // Sanity rails — bash side independently green (the no-team die
      // path) BEFORE the comparator is trusted. CLAUDE.md "verify green
      // from the right path".
      expect(bash.exit).toBe(1);
      expect(bash.stdout).toBe("");
      expect(bash.stderr).toContain("no team.json");
      expect(bash.stderr).toContain("run 'atmux init' first");
      expect(bash.discordCalls).toEqual([]);
      // No fixture mutation — verb dies before any logs/send-<m>.log
      // append or tmux call.
      expect(bash.fsState).toEqual({});

      // TS side rails — porter #17 reconciles `ConfigError` rendering
      // and exit code with bash's `atmux::die` shape (see start.test.ts
      // header for the exit-1 vs exit-78 reconciliation note).
      expect(ts.discordCalls).toEqual([]);

      // The actual parity contract — comparator returns `[]` IFF every
      // observable channel matches post-mask. Stderr byte-equal,
      // exit-code byte-equal, no fs side-effects, no discord.
      const divergences = compare(bash, ts);
      expect(divergences).toEqual([]);
    },
  );
});

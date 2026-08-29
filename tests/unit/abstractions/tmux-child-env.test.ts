// ADR-281 §D2/§D3 — the tmux child-environment policy, at every site.
//
// Why this file exists. ADR-281's stated reason for `TMUX_CHILD_UNSET_ENV`
// being a shared constant rather than three inline literals is "the
// failure this prevents is a FUTURE CALL SITE FORGETTING". Nothing
// detected that. On 2026-08-28 a reviewer deleted `unsetEnv` from six of
// the seven sites — loadBuffer, attachSessionInheritStdio,
// fallback-cage's capture-pane, doctor's defaultTmuxSpawn,
// fix-supervisor-missing's list-windows and poke's sendCageBrief (at
// commit bb47d0b6: tmux.ts:811, tmux.ts:874, fallback-cage.ts:661,
// doctor/types.ts:60, fix-supervisor-missing.ts:77, poke.ts:1720) — and
// the full 10,404-test suite came back BYTE-IDENTICAL. `rg
// TMUX_CHILD_UNSET_ENV tests/` returned zero hits. The constant was
// documented, not enforced.
//
// THE POLICY HAS TWO HALVES AND BOTH ARE DRIVEN HERE. The spawn-level
// `unsetEnv` covers the seven direct `spawn()` sites; the `env(1)` argv
// prefix `TMUX_CHILD_ENV_ARGV` covers the sudo branches, where sudo's
// `env_reset` discards a spawn-level override. The argv half had ZERO
// call-site coverage until 2026-08-29 — removing all three
// `...TMUX_CHILD_ENV_ARGV` spread lines from `src/` left this suite
// entirely unchanged. Two of the three sites are reachable and are now
// driven; the third is provably unreachable and is pinned as dead rather
// than given a test that cannot fail. See the §D2 argv describe below.
//
// Sites are named rather than numbered in the test titles below, because
// a line number is stale the moment anything above it moves.
//
// What is asserted. Each leg drives a real call site with
// `process.env.NO_COLOR = "1"` and reads the environment that actually
// reached `Bun.spawn`. `NO_COLOR` must be ABSENT — not empty, which is a
// different observable state and the one ADR-277 §D1 rejected.
//
// Asserting the effective environment rather than the `unsetEnv` option
// is deliberate: an `unsetEnv` still passed but no longer honoured by
// `mergeEnv` would satisfy an options check and fail this one. That is a
// measured claim, not an aspiration — an earlier revision had one leg
// (fallback-cage's capture-pane) injecting a fake `spawnFn` and checking
// the OPTION, and deleting the `unsetEnv` block from `mergeEnv` left that
// one leg green while the other six went red. It now runs the real
// `spawn()` like the rest; re-measured 2026-08-29, the same mutation
// turns ALL SEVEN red.
//
// No tmux server is started anywhere in this file, and no socket is
// touched: every subprocess is answered by `true(1)`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CageHandle } from "../../../src/abstractions/fallback-cage.ts";
import {
  createFallbackCage,
  destroyFallbackCage,
  FallbackTierDroppedError,
  TIER_AGENT,
} from "../../../src/abstractions/fallback-cage.ts";
import {
  createTmux,
  TMUX_CHILD_ENV_ARGV,
  TMUX_CHILD_UNSET_ENV,
} from "../../../src/abstractions/tmux.ts";
import { makeFixSupervisorMissingRecipe } from "../../../src/core/cursor-recipes/fix-supervisor-missing.ts";
import { defaultTmuxSpawn } from "../../../src/verbs/doctor/types.ts";
import { sendCageBrief } from "../../../src/verbs/poke.ts";
import { installSpawnRecorder, type SpawnRecorder } from "../../helpers/spawn-recorder.ts";

const SOCKET_PATH = "/tmp/atmux-child-env-never-created/s";

let rec: SpawnRecorder | null = null;
let priorNoColor: string | undefined;

beforeEach(() => {
  // The fault ADR-281 reproduces: an agent Bash tool's environment.
  priorNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  rec = installSpawnRecorder();
});

afterEach(() => {
  rec?.restore();
  rec = null;
  if (priorNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = priorNoColor;
});

/** Every recorded spawn's environment, asserted clean in one shot so a
 *  failure names which call leaked rather than just "false". */
function assertNoColorAbsentEverywhere(recorder: SpawnRecorder): void {
  const seen = recorder.calls.map((c) => ({
    cmd: c.cmd[0] ?? "",
    noColor: c.env === undefined ? "INHERITED-UNSCRUBBED" : (c.env.NO_COLOR ?? "absent"),
  }));
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toEqual(seen.map((s) => ({ cmd: s.cmd, noColor: "absent" })));
}

describe("ADR-281 §D3 — every tmux spawn site deletes NO_COLOR from the child", () => {
  test("abstractions/tmux.ts — tmuxRunRaw (every namespace method routes here)", async () => {
    const tmux = createTmux({ socketPath: SOCKET_PATH });
    await tmux.server.hasServer();
    assertNoColorAbsentEverywhere(rec as SpawnRecorder);
  });

  test("abstractions/tmux.ts — buffer.loadBuffer (bypasses tmuxRun for stdin)", async () => {
    const tmux = createTmux({ socketPath: SOCKET_PATH });
    await tmux.buffer.loadBuffer({ data: "brief body", name: "b" });
    assertNoColorAbsentEverywhere(rec as SpawnRecorder);
  });

  test("abstractions/tmux.ts — client.attachSessionInheritStdio (attach starts a server)", async () => {
    const tmux = createTmux({ socketPath: SOCKET_PATH });
    await tmux.client.attachSessionInheritStdio("probe");
    assertNoColorAbsentEverywhere(rec as SpawnRecorder);
  });

  test("abstractions/fallback-cage.ts — destroyFallbackCage capture-pane on teardown", async () => {
    // NO explicit `spawnFn`, deliberately. An earlier revision injected a
    // fake one and asserted the `unsetEnv` OPTION, which is a weaker
    // statement than every other leg here makes — and measurably so: a
    // reviewer removed the `unsetEnv` deletion block from `mergeEnv` and
    // this was the ONE leg of seven that stayed green, because the option
    // was still being passed. Letting the real `spawn()` run puts this leg
    // on the same footing as the rest: it reads the environment that
    // actually reached `Bun.spawn`.
    //
    // Nothing real executes — the recorder answers every spawn with
    // `true(1)`, so the `mkdir`, the `capture-pane`, the `tee` and the
    // `kill-session` all resolve without touching a socket or the disk.
    const handle: CageHandle = {
      tier: 2,
      team: "t",
      lane: "driver-2",
      taskId: "t-0",
      agent: "operator",
      tmuxTmpdir: "/tmp/atmux-child-env-never-created",
      tmuxSocket: "atmux-child-env-never-created",
      workDir: "/tmp/atmux-child-env-never-created/work",
      sessionName: "s",
      windowName: "w",
      createdAt: 0,
    };
    await destroyFallbackCage(handle, {
      atmuxDir: "/tmp/atmux-child-env-never-created/.atmux",
      tmuxFactory: () => createTmux({ socketPath: SOCKET_PATH }),
    });
    const recorder = rec as SpawnRecorder;
    // TMUX CALLS ONLY, and that scoping is the policy rather than a
    // convenience: ADR-281 §D6 deliberately does NOT apply the deletion
    // inside `mergeEnv`, so the `mkdir` and `tee` this teardown also
    // spawns keep `NO_COLOR` — correctly. Asserting "absent everywhere"
    // here would be asserting the opposite of the decision.
    //
    // `cmd[0]` is an ABSOLUTE path by the time it reaches `Bun.spawn`
    // (`/usr/bin/sudo`, `<mise>/tmux`), so match on the suffix.
    const tmuxCalls = recorder.calls.filter((c) => (c.cmd[0] ?? "").endsWith("tmux"));
    expect(tmuxCalls.length).toBeGreaterThan(0);
    expect(
      tmuxCalls.map((c) =>
        c.env === undefined ? "INHERITED-UNSCRUBBED" : (c.env.NO_COLOR ?? "absent"),
      ),
    ).toEqual(tmuxCalls.map(() => "absent"));
  });

  test("verbs/doctor/types.ts — defaultTmuxSpawn (a read-only probe still starts a server)", async () => {
    await defaultTmuxSpawn(["-V"]);
    assertNoColorAbsentEverywhere(rec as SpawnRecorder);
  });

  test("core/cursor-recipes/fix-supervisor-missing.ts — list-windows on an unpinned socket", async () => {
    const recipe = makeFixSupervisorMissingRecipe();
    await recipe.detect({
      atmuxDir: "/tmp/atmux-child-env-never-created/.atmux",
      projectCwd: "/tmp/atmux-child-env-never-created",
      nowSec: 0,
      teamName: "t",
      sessionName: "s",
    });
    assertNoColorAbsentEverywhere(rec as SpawnRecorder);
  });

  test("verbs/poke.ts — sendCageBrief, operator branch (load/paste/send-keys)", async () => {
    await sendCageBrief(
      {
        tier: 2,
        team: "t",
        lane: "driver-2",
        taskId: "t-0",
        agent: "operator",
        tmuxTmpdir: "/tmp/atmux-child-env-never-created",
        tmuxSocket: "atmux-child-env-never-created",
        workDir: "/tmp/atmux-child-env-never-created/work",
        sessionName: "s",
        windowName: "w",
        createdAt: 0,
      },
      "brief body",
    );
    const recorder = rec as SpawnRecorder;
    // All three subprocesses — load-buffer, paste-buffer, send-keys.
    expect(recorder.calls.length).toBe(3);
    assertNoColorAbsentEverywhere(recorder);
  });

  test("control — a spawn with no policy DOES carry NO_COLOR through", async () => {
    // The honesty leg. Every assertion above reads "absent"; if `spawn()`
    // simply never passed NO_COLOR to any child, they would all be green
    // for a reason that has nothing to do with ADR-281. This drives the
    // same seam with no `unsetEnv` and requires the variable to arrive.
    const { spawn } = await import("../../../src/abstractions/spawn.ts");
    await spawn({ cmd: "true", expectExitCode: "any" });
    const recorder = rec as SpawnRecorder;
    expect(recorder.calls.map((c) => c.env?.NO_COLOR)).toEqual(["1"]);
  });
});

describe("ADR-281 §D2 — the env(1) argv prefix, at the sites that build one", () => {
  // Why this block exists. Until 2026-08-29 the argv half of the policy had
  // ZERO call-site coverage: the block below pinned the two CONSTANTS
  // against each other, and nothing anywhere checked that a call site put
  // `TMUX_CHILD_ENV_ARGV` on an argv. A reviewer removed all three
  // `...TMUX_CHILD_ENV_ARGV` spread lines and the whole suite was
  // unchanged. The argv form is the one that matters most, because it is
  // the branch running under another UID where sudo's `env_reset` throws a
  // spawn-level `unsetEnv` away.
  //
  // There are THREE such sites in `src/`. Two are reachable and are driven
  // below; the third is provably unreachable and is pinned as such rather
  // than given a test that could never fail.

  /** A Tier-3 handle. `agent !== "operator"` is what selects the sudo
   *  branch at every one of these sites. */
  const tier3Handle: CageHandle = {
    tier: 3,
    team: "t",
    lane: "driver-2",
    taskId: "t-0",
    agent: "kimi-agent",
    tmuxTmpdir: "/tmp/atmux-child-env-never-created",
    tmuxSocket: "atmux-child-env-never-created",
    workDir: "/tmp/atmux-child-env-never-created/work",
    sessionName: "s",
    windowName: "w",
    createdAt: 0,
  };

  /** The `env(1)` prefix as it must appear on a `sudo -u <agent> env …`
   *  argv: contiguous, immediately after the literal `env`. Asserting the
   *  position and not merely `argv.includes("-u")` is what makes this fail
   *  if the flags are dropped, reordered, or land after the tmux binary
   *  where `env(1)` would treat them as the child's arguments. */
  function envPrefixAfterEnv(argv: ReadonlyArray<string>): string[] {
    const at = argv.indexOf("env");
    if (at < 0) return [];
    return argv.slice(at + 1, at + 1 + TMUX_CHILD_ENV_ARGV.length);
  }

  test("fallback-cage.ts — destroyFallbackCage's sudo kill-session carries the prefix", async () => {
    await destroyFallbackCage(tier3Handle, {
      atmuxDir: "/tmp/atmux-child-env-never-created/.atmux",
      tmuxFactory: () => createTmux({ socketPath: SOCKET_PATH }),
    });
    const recorder = rec as SpawnRecorder;
    // `cmd[0]` is absolute by the time it reaches `Bun.spawn`
    // (`/usr/bin/sudo`), so match on the suffix, not equality.
    const killCalls = recorder.calls.filter(
      (c) => (c.cmd[0] ?? "").endsWith("sudo") && c.cmd.includes("kill-session"),
    );
    expect(killCalls.length).toBe(1);
    expect(envPrefixAfterEnv(killCalls[0]?.cmd ?? [])).toEqual([...TMUX_CHILD_ENV_ARGV]);
  });

  test("poke.ts — sendCageBrief's sudo branch carries the prefix on all three calls", async () => {
    await sendCageBrief(tier3Handle, "brief body");
    const recorder = rec as SpawnRecorder;
    const sudoCalls = recorder.calls.filter((c) => (c.cmd[0] ?? "").endsWith("sudo"));
    // load-buffer, paste-buffer, send-keys — every one of them starts a
    // tmux process under the agent's UID.
    expect(sudoCalls.length).toBe(3);
    expect(sudoCalls.map((c) => envPrefixAfterEnv(c.cmd))).toEqual(
      sudoCalls.map(() => [...TMUX_CHILD_ENV_ARGV]),
    );
  });

  test("fallback-cage.ts — createFallbackCage's sudo new-session site is UNREACHABLE", async () => {
    // The third `TMUX_CHILD_ENV_ARGV` site is dead code, and this pins the
    // two facts that make it dead rather than asserting nothing:
    //
    //   1. `createFallbackCage` is the ONLY entry to that branch, and it
    //      throws `FallbackTierDroppedError` for every `tier !== 2`
    //      (ADR-050 v1 + t-706655ee, the 2026-05-14 scope reduction).
    //   2. The branch is guarded by `agent !== "operator"`, where
    //      `agent = TIER_AGENT[tier]` — and `TIER_AGENT[2]` is
    //      `"operator"`.
    //
    // Together: tier is always 2 there, so agent is always "operator", so
    // the sudo branch cannot execute. A behavioural test for it would be a
    // test that can never fail, which is the kind of coverage `/CLAUDE.md`
    // §Engineering calls a lie. If either fact below changes, this leg goes
    // red and the site needs a real test instead.
    expect(TIER_AGENT[2]).toBe("operator");
    await expect(
      createFallbackCage({
        tier: 3,
        team: "t",
        lane: "driver-2",
        taskId: "t-0",
        projectCwd: "/tmp/atmux-child-env-never-created",
        atmuxDir: "/tmp/atmux-child-env-never-created/.atmux",
      }),
    ).rejects.toBeInstanceOf(FallbackTierDroppedError);
  });
});

describe("ADR-281 §D2 — the sudo argv form cannot drift from the spawn-level list", () => {
  test("TMUX_CHILD_ENV_ARGV is exactly TMUX_CHILD_UNSET_ENV expressed as env(1) flags", () => {
    // ADR-281 §D2 calls this "byte-for-byte equivalent … so the sudo path
    // can never drift into a second colour policy". Until 2026-08-28 that
    // invariant was prose and nothing enforced it: adding a name to one
    // list and not the other was silent, and the sudo branch is the one
    // that runs under another UID where a spawn-level `unsetEnv` is
    // discarded by sudo's `env_reset`.
    expect([...TMUX_CHILD_ENV_ARGV]).toEqual(TMUX_CHILD_UNSET_ENV.flatMap((n) => ["-u", n]));
  });

  test("both lists are frozen, so no caller can mutate the shared policy", () => {
    expect({
      unsetEnv: Object.isFrozen(TMUX_CHILD_UNSET_ENV),
      argv: Object.isFrozen(TMUX_CHILD_ENV_ARGV),
    }).toEqual({ unsetEnv: true, argv: true });
  });

  test("the policy is a deletion of NO_COLOR and nothing else", () => {
    // Pins the withdrawal in ADR-281 §D2: atmux SETS no colour variable
    // on a tmux child. A `COLORTERM` element reappearing here would be
    // the withdrawn half coming back.
    expect([...TMUX_CHILD_UNSET_ENV]).toEqual(["NO_COLOR"]);
  });
});

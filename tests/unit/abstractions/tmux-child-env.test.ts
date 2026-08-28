// ADR-281 §D3 — the tmux child-environment policy, at every site (ADR-283 §B1).
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
// `mergeEnv` would satisfy an options check and fail this one.
//
// No tmux server is started anywhere in this file, and no socket is
// touched: every subprocess is answered by `true(1)`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CageHandle } from "../../../src/abstractions/fallback-cage.ts";
import { destroyFallbackCage } from "../../../src/abstractions/fallback-cage.ts";
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
    // This site takes an explicit `spawnFn`, so the option itself is
    // visible here as well as its effect.
    const seen: Array<{ cmd: string; unsetEnv: ReadonlyArray<string> | undefined }> = [];
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
      spawnFn: async (opts) => {
        seen.push({
          cmd: opts.cmd,
          unsetEnv: (opts as { unsetEnv?: ReadonlyArray<string> }).unsetEnv,
        });
        return {
          cmd: opts.cmd,
          argv: opts.argv ?? [],
          exitCode: 0,
          signalled: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
        };
      },
      tmuxFactory: () => createTmux({ socketPath: SOCKET_PATH }),
    });
    const tmuxCalls = seen.filter((s) => s.cmd.endsWith("tmux"));
    expect(tmuxCalls.length).toBeGreaterThan(0);
    expect(tmuxCalls.map((c) => c.unsetEnv)).toEqual(tmuxCalls.map(() => TMUX_CHILD_UNSET_ENV));
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

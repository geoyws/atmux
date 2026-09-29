// t-2ff4f48e — every atmux code path that can CREATE a tmux server must
// carry `-f <atmux conf>` on the creating argv.
//
// A tmux server freezes its own environ at start and hands it to every
// pane; tmux starts that server implicitly for ANY subcommand against a
// dead socket (measured: `list-keys` and `attach` both created conf-less
// production servers carrying NO_COLOR=1). The creating argv therefore
// cannot be identified by subcommand — every production tmux namespace
// bakes `-f` in at factory construction, and every raw cage-socket spawn
// splices it after the socket flag.
//
// What is asserted. Each leg drives a REAL production factory (not a
// reimplementation) through `session.newSession` — the canonical
// server-creating subcommand — with `Bun.spawn` recorded, and requires
// `-f <canonical conf>` on the recorded argv. The attach + vox-supervise
// + killServer legs drive the verb-level seams that issue
// server-creating (or implicitly server-creating) subcommands. The
// control leg builds a conf-less namespace and requires `-f` to be
// ABSENT, proving the assertion is sensitive to the factory wiring
// rather than to the recorder.
//
// No tmux server is started anywhere in this file and no socket is
// touched: every subprocess is answered by `true(1)`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { defaultKillServer } from "../../../src/core/groom.ts";
import { getAtmuxTmuxConfPath } from "../../../src/core/tmux-paths.ts";
import { attachWithTmux, defaultAttachTmux } from "../../../src/verbs/attach.ts";
import { buildTmuxConfig } from "../../../src/verbs/audit.ts";
import { defaultCageTmuxFactory } from "../../../src/verbs/cockpit.ts";
import { defaultFleetTmux } from "../../../src/verbs/fleet.ts";
import { defaultBuildTmux as defaultHandoffTmux } from "../../../src/verbs/handoff.ts";
import { defaultBuildTmux as defaultHealthTmux } from "../../../src/verbs/health.ts";
import { defaultNudgeTmux } from "../../../src/verbs/nudge.ts";
import { defaultBuildTmux as defaultRotateTmux } from "../../../src/verbs/rotate.ts";
import { defaultBuildTmux as defaultRepairRenameTmux } from "../../../src/verbs/team-repair-rename.ts";
import { defaultVoxTmux, superviseVox } from "../../../src/verbs/vox.ts";
import { installSpawnRecorder, type SpawnRecorder } from "../../helpers/spawn-recorder.ts";

const SOCKET_PATH = "/tmp/atmux-conf-path-never-created/s";
const EXPECTED_CONF = getAtmuxTmuxConfPath();

let rec: SpawnRecorder | null = null;

beforeEach(() => {
  rec = installSpawnRecorder();
});

afterEach(() => {
  rec?.restore();
  rec = null;
});

/** Require `-f <canonical conf>` on the recorded argv of one spawn. */
function expectConfOnArgv(cmd: ReadonlyArray<string>): void {
  const flag = cmd.indexOf("-f");
  expect(flag).toBeGreaterThanOrEqual(0);
  expect(cmd[flag + 1]).toBe(EXPECTED_CONF);
}

/** The recorded `new-session` argv, failing loudly when nothing ran. */
function recordedNewSession(): ReadonlyArray<string> {
  const calls = (rec as SpawnRecorder).calls;
  const hit = calls.find((c) => c.cmd.includes("new-session"));
  expect(hit).toBeDefined();
  return (hit as SpawnRecorder["calls"][number]).cmd;
}

describe("t-2ff4f48e — production tmux factories bake `-f <conf>` into the creating argv", () => {
  const factories: ReadonlyArray<{ name: string; build: () => TmuxNamespace }> = [
    { name: "verbs/attach.ts — defaultAttachTmux", build: () => defaultAttachTmux(SOCKET_PATH) },
    {
      name: "verbs/cockpit.ts — defaultCageTmuxFactory",
      build: () => defaultCageTmuxFactory(SOCKET_PATH),
    },
    { name: "verbs/fleet.ts — defaultFleetTmux", build: () => defaultFleetTmux(SOCKET_PATH) },
    { name: "verbs/handoff.ts — defaultBuildTmux", build: () => defaultHandoffTmux(SOCKET_PATH) },
    { name: "verbs/health.ts — defaultBuildTmux", build: () => defaultHealthTmux(SOCKET_PATH) },
    { name: "verbs/nudge.ts — defaultNudgeTmux", build: () => defaultNudgeTmux(SOCKET_PATH) },
    { name: "verbs/rotate.ts — defaultBuildTmux", build: () => defaultRotateTmux(SOCKET_PATH) },
    {
      name: "verbs/team-repair-rename.ts — defaultBuildTmux",
      build: () => defaultRepairRenameTmux(SOCKET_PATH),
    },
    { name: "verbs/vox.ts — defaultVoxTmux", build: () => defaultVoxTmux() },
    {
      name: "verbs/audit.ts — buildTmuxConfig (socketPath form)",
      build: () => createTmux(buildTmuxConfig({ name: "t" }, SOCKET_PATH)),
    },
    {
      name: "verbs/audit.ts — buildTmuxConfig (team-resolve form)",
      build: () => createTmux(buildTmuxConfig({ name: "t" })),
    },
  ];

  for (const { name, build } of factories) {
    test(`${name} — new-session carries -f <conf>`, async () => {
      const tmux = build();
      await tmux.session.newSession({ name: "probe" });
      const hit = (rec as SpawnRecorder).calls.find((c) => c.cmd.includes("new-session"));
      expect(hit).toBeDefined();
      expectConfOnArgv(hit?.cmd ?? []);
    });
  }

  test("control — a conf-less namespace issues new-session WITHOUT -f", async () => {
    const tmux = createTmux({ socketPath: SOCKET_PATH });
    await tmux.session.newSession({ name: "probe" });
    const hit = (rec as SpawnRecorder).calls.find((c) => c.cmd.includes("new-session"));
    expect(hit).toBeDefined();
    expect(hit?.cmd.includes("-f")).toBe(false);
  });
});

describe("t-2ff4f48e — verb-level creating paths carry `-f <conf>`", () => {
  test("attachWithTmux over the default attach namespace — attach-session carries -f", async () => {
    // hasSession is answered by true(1) → exit 0 → session "exists", so
    // the leg reaches the implicitly server-creating attach-session.
    await attachWithTmux(defaultAttachTmux(SOCKET_PATH), "probe");
    const hit = (rec as SpawnRecorder).calls.find((c) => c.cmd.includes("attach-session"));
    expect(hit).toBeDefined();
    expectConfOnArgv(hit?.cmd ?? []);
  });

  test("superviseVox over the default vox namespace — new-session carries -f", async () => {
    const tmux = defaultVoxTmux();
    await superviseVox({
      tmux: {
        ...tmux,
        session: { ...tmux.session, hasSession: async () => false },
      },
      binPath: "/bin/true",
      log: () => {},
    });
    expectConfOnArgv(recordedNewSession());
  });

  test("core/groom.ts — defaultKillServer carries -f", async () => {
    await defaultKillServer(SOCKET_PATH);
    const hit = (rec as SpawnRecorder).calls.find((c) => c.cmd.includes("kill-server"));
    expect(hit).toBeDefined();
    expectConfOnArgv(hit?.cmd ?? []);
  });
});

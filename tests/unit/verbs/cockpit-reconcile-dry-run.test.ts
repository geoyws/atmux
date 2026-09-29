// Unit tests for `atmux cockpit reconcile --dry-run` (t-6a6828f5):
// the read-only preview wrapper (src/core/tmux-dry-run.ts) + the
// reconcile wiring (factory wrap, side-effect guards, plan print).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import {
  createDryRunTmux,
  type DryRunOp,
  formatDryRunSummary,
} from "../../../src/core/tmux-dry-run.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import { cockpitRebuild, parseCockpitArgs } from "../../../src/verbs/cockpit.ts";

function makeLogger(): { logger: Logger; logs: string[] } {
  const logs: string[] = [];
  return {
    logger: {
      log: (m: string) => logs.push(`log: ${m}`),
      ok: (m: string) => logs.push(`ok: ${m}`),
      warn: (m: string) => logs.push(`warn: ${m}`),
      err: (m: string) => logs.push(`err: ${m}`),
    },
    logs,
  };
}

/** Full fake TmuxNamespace: reads answer from canned state, every
 *  mutation lands in `calls` (the "real execution" the wrapper must
 *  never trigger). */
function makeFake(calls: string[]): TmuxNamespace {
  const mark = (name: string) => {
    calls.push(name);
  };
  return {
    session: {
      newSession: async () => {
        mark("session.newSession");
      },
      hasSession: async (name: string) => name.includes("test_cockpit"),
      killSession: async () => {
        mark("session.killSession");
      },
      listSessions: async () => [{ name: "test_cockpit", windows: 2, created: 0 }],
      renameSession: async () => {
        mark("session.renameSession");
      },
      setEnvironment: async () => {
        mark("session.setEnvironment");
      },
    },
    window: {
      newWindow: async () => {
        mark("window.newWindow");
        return { sessionName: "test_cockpit", windowIndex: 9 };
      },
      killWindow: async () => {
        mark("window.killWindow");
      },
      listWindows: async () => [
        { index: 0, id: "@1", name: "_superdriver", active: true },
        { index: 1, id: "@2", name: "oldteam", active: false },
      ],
      renameWindow: async () => {
        mark("window.renameWindow");
      },
      selectWindow: async () => {
        mark("window.selectWindow");
      },
      moveWindow: async () => {
        mark("window.moveWindow");
      },
      swapWindow: async () => {
        mark("window.swapWindow");
      },
    },
    pane: {
      sendKeys: async () => {
        mark("pane.sendKeys");
      },
      capturePane: async () => "pane-content",
      listPanes: async () => [],
      displayMessage: async () => "bash",
      killPane: async () => {
        mark("pane.killPane");
      },
      splitWindow: async () => {
        mark("pane.splitWindow");
        return { sessionName: "test_cockpit", windowIndex: 0, paneIndex: 0 };
      },
    },
    buffer: {
      loadBuffer: async () => {
        mark("buffer.loadBuffer");
      },
      pasteBuffer: async () => {
        mark("buffer.pasteBuffer");
      },
      deleteBuffer: async () => {
        mark("buffer.deleteBuffer");
      },
    },
    client: {
      attachSession: async () => {
        mark("client.attachSession");
      },
      attachSessionInheritStdio: async () => {
        mark("client.attachSessionInheritStdio");
      },
      switchClient: async () => {
        mark("client.switchClient");
      },
      listClients: async () => [{ name: "c0", session: "test_cockpit", tty: "/dev/ttys000" }],
    },
    option: {
      setOption: async () => {
        mark("option.setOption");
      },
      showOptions: async () => ({ prefix: "F1" }),
    },
    server: {
      hasServer: async () => false,
      killServer: async () => {
        mark("server.killServer");
      },
    },
  };
}

describe("createDryRunTmux", () => {
  test("records kill-window; the real kill never runs", async () => {
    const calls: string[] = [];
    const ops: DryRunOp[] = [];
    const dry = createDryRunTmux(makeFake(calls), ops);
    await dry.window.killWindow("test_cockpit:oldteam");
    expect(calls).toEqual([]);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.category).toBe("kill");
    expect(ops[0]?.description).toContain("kill-window");
    expect(ops[0]?.description).toContain("oldteam");
  });

  test("records rename-window; the real rename never runs", async () => {
    const calls: string[] = [];
    const ops: DryRunOp[] = [];
    const dry = createDryRunTmux(makeFake(calls), ops);
    await dry.window.renameWindow("test_cockpit:superdoctor", "medic");
    await dry.session.renameSession("atmux_cockpit", "atx");
    expect(calls).toEqual([]);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.category === "rename")).toBe(true);
  });

  test("read-only calls pass through and record nothing", async () => {
    const calls: string[] = [];
    const ops: DryRunOp[] = [];
    const dry = createDryRunTmux(makeFake(calls), ops);
    expect(await dry.session.hasSession("test_cockpit")).toBe(true);
    expect(await dry.session.listSessions()).toHaveLength(1);
    expect(await dry.window.listWindows("test_cockpit")).toHaveLength(2);
    expect(await dry.pane.capturePane({ target: "test_cockpit:0" })).toBe("pane-content");
    expect(await dry.pane.displayMessage({ target: "t", format: "f" })).toBe("bash");
    expect(await dry.pane.listPanes("t")).toEqual([]);
    expect(await dry.client.listClients()).toHaveLength(1);
    expect(await dry.option.showOptions()).toEqual({ prefix: "F1" });
    expect(await dry.server.hasServer()).toBe(false);
    expect(ops).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("every other mutation records (never executes) with a benign return", async () => {
    const calls: string[] = [];
    const ops: DryRunOp[] = [];
    const dry = createDryRunTmux(makeFake(calls), ops);
    await dry.session.newSession({ name: "s" });
    await dry.session.killSession("s");
    await dry.session.setEnvironment({ name: "K", value: "v" });
    const wid = await dry.window.newWindow({ sessionName: "s", name: "w" });
    expect(wid.sessionName).toBe("s");
    await dry.window.selectWindow("s:0");
    await dry.window.moveWindow({ source: "s:0", target: "s:1", kill: true });
    await dry.window.swapWindow({ source: "s:0", target: "s:1" });
    await dry.pane.sendKeys({
      target: { kind: "member", member: "m", team: "t", target: "s:0" },
      keys: "hi",
    });
    await dry.pane.killPane("s:0.0");
    const pid = await dry.pane.splitWindow({ target: "s:0" });
    expect(pid.paneIndex).toBe(0);
    await dry.buffer.loadBuffer({ data: "x" });
    await dry.buffer.pasteBuffer({
      target: { kind: "member", member: "m", team: "t", target: "s:0" },
    });
    await dry.buffer.deleteBuffer("b");
    await dry.client.attachSession("s");
    await dry.client.attachSessionInheritStdio("s");
    await dry.client.switchClient({ target: "s" });
    await dry.option.setOption({ name: "prefix", value: "F1", global: true });
    await dry.server.killServer();
    expect(calls).toEqual([]);
    expect(ops.length).toBeGreaterThan(10);
    // kill-session, move-window -k (destroys the target slot), kill-pane, kill-server.
    expect(ops.filter((o) => o.category === "kill")).toHaveLength(4);
    expect(ops.find((o) => o.description.startsWith("move-window"))?.category).toBe("kill");
  });

  test("summary counts are exact", () => {
    const ops: DryRunOp[] = [
      { category: "rename", description: "rename-window -t s:a b" },
      { category: "rename", description: "rename-session x → y" },
      { category: "kill", description: "kill-window -t s:c" },
      { category: "other", description: "new-window -s s -n d" },
      { category: "other", description: "set-option -g prefix F1" },
    ];
    expect(formatDryRunSummary(ops)).toBe(
      "dry-run: 2 rename, 1 kill, 2 other operations (nothing executed)",
    );
    expect(formatDryRunSummary([])).toBe(
      "dry-run: 0 rename, 0 kill, 0 other operations (nothing executed)",
    );
  });
});

describe("parseCockpitArgs --dry-run scoping", () => {
  test("reconcile accepts --dry-run", () => {
    expect(parseCockpitArgs(["reconcile", "--dry-run"]).dryRun).toBe(true);
  });
  test("reload still refuses --dry-run", () => {
    expect(() => parseCockpitArgs(["reload", "--dry-run"])).toThrow(UsageError);
  });
  test("attach still refuses --dry-run", () => {
    expect(() => parseCockpitArgs(["attach", "--dry-run"])).toThrow(UsageError);
  });
});

describe("cockpitRebuild --dry-run", () => {
  let homeDir: string;
  let projRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-dryrun-home-"));
    await mkdir(join(homeDir, ".atmux"), { recursive: true });
    projRoot = await mkdtemp(join(tmpdir(), "atmux-dryrun-proj-"));
    await mkdir(join(projRoot, ".atmux"), { recursive: true });
    await writeFile(
      join(projRoot, ".atmux", "team.json"),
      JSON.stringify({
        name: "demo",
        members: [{ name: "lead", role: "team-lead", tui: "claude" }],
      }),
      "utf8",
    );
    await writeFile(
      join(homeDir, ".atmux", "cockpit.json"),
      JSON.stringify({
        cockpitSession: "test_cockpit",
        medic: { enabled: true },
        teams: [{ name: "demo", root: projRoot, enabled: true }],
      }),
      "utf8",
    );
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projRoot, { recursive: true, force: true });
  });

  test("previews without mutating: exit 0, no start, no team.json write, exact summary", async () => {
    const calls: string[] = [];
    const { logger, logs } = makeLogger();
    let startCalls = 0;
    const code = await cockpitRebuild(
      {
        subverb: "reconcile",
        noCycle: false,
        forceCycle: false,
        ackDangerous: false,
        noLaunch: true,
        yes: false,
        dryRun: true,
      },
      {
        env: { HOME: homeDir },
        tmuxFactory: () => makeFake(calls),
        logger,
        startFn: async () => {
          startCalls += 1;
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    // Nothing executed against the (fake) live server …
    expect(calls).toEqual([]);
    // … no cage was launched …
    expect(startCalls).toBe(0);
    // … team.json untouched (Phase 1 skipped) …
    const tj = JSON.parse(await readFile(join(projRoot, ".atmux", "team.json"), "utf8"));
    expect(tj.bareWindowNames).toBeUndefined();
    // … the orphan kill was planned …
    const text = logs.join("\n");
    expect(text).toContain("kill-window");
    expect(text).toContain("oldteam");
    // … with exact counts: 0 renames, 1 kill (oldteam), 4 other
    // (new-window _medic, new-window demo, 2× set-option prefix).
    expect(text).toContain("dry-run: 0 rename, 1 kill, 4 other operations (nothing executed)");
  });
});

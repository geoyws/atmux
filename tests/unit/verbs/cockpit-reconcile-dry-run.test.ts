// Unit tests for `atmux cockpit reconcile --dry-run` (t-6a6828f5):
// the read-only preview wrapper (src/core/tmux-dry-run.ts) + the
// reconcile wiring (factory wrap, side-effect guards, plan print).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { planStartRepairs, shouldKillHomeWindow } from "../../../src/core/start-repairs.ts";
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

describe("planStartRepairs (shared start/dry-run planner)", () => {
  test("legacy no-separator window plans an ADR-135 rename and NO home kill (a rename spawns nothing)", () => {
    const plan = planStartRepairs({
      teamName: "t",
      session: "t",
      members: [{ name: "w1", role: "member" }],
      existingNames: ["🐝w1", "__t__home"],
    });
    expect(plan.renames).toEqual([
      { memberName: "w1", from: "🐝w1", to: "🐝-w1", migration: "ADR-135" },
    ]);
    expect(plan.spawns).toEqual([]);
    expect(plan.killHome).toBe(false);
  });

  test("hyphen window wins over the legacy form when both exist (ADR-161 priority)", () => {
    const plan = planStartRepairs({
      teamName: "t",
      session: "t",
      members: [{ name: "lead", role: "team-lead" }],
      existingNames: ["🧭lead", "🧭-lead", "__t__home"],
    });
    expect(plan.renames).toEqual([
      { memberName: "lead", from: "🧭-lead", to: "🧭_lead", migration: "ADR-161" },
    ]);
    expect(plan.killHome).toBe(false);
  });

  test("clean cage plans nothing", () => {
    const plan = planStartRepairs({
      teamName: "t",
      session: "t",
      members: [{ name: "lead", role: "team-lead" }],
      existingNames: ["🧭_lead"],
    });
    expect(plan.renames).toEqual([]);
    expect(plan.killHome).toBe(false);
  });

  test("start step 9: the placeholder dies only when start would spawn something", () => {
    const base = { teamName: "t", session: "t" };
    // Canonical window + home, nothing to spawn: start keeps the home window.
    expect(
      planStartRepairs({
        ...base,
        members: [{ name: "lead", role: "team-lead" }],
        existingNames: ["🧭_lead", "__t__home"],
      }).killHome,
    ).toBe(false);
    // A missing member window is spawned, then the home window goes.
    const spawnPlan = planStartRepairs({
      ...base,
      members: [
        { name: "lead", role: "team-lead" },
        { name: "w1", role: "member" },
      ],
      existingNames: ["🧭_lead", "__t__home"],
    });
    expect(spawnPlan.spawns).toEqual(["🐝-w1"]);
    expect(spawnPlan.killHome).toBe(true);
    // Home alone plus a spawn: the spawned window makes home killable.
    expect(
      planStartRepairs({
        ...base,
        members: [{ name: "w1", role: "member" }],
        existingNames: ["__t__home"],
      }).killHome,
    ).toBe(true);
  });

  test("an inserted superdriver seat counts as a spawn (ADR-296); a present seat does not", () => {
    const opts = {
      teamName: "t",
      session: "t",
      members: [{ name: "lead", role: "team-lead" }],
      superdriverEnabled: true,
    };
    const seat = planStartRepairs({ ...opts, existingNames: ["🧭_lead", "__t__home"] });
    expect(seat.seatSpawn).toBe(true);
    expect(seat.killHome).toBe(true);
    const present = planStartRepairs({
      ...opts,
      existingNames: ["superdriver", "🧭_lead", "__t__home"],
    });
    expect(present.seatSpawn).toBe(false);
    expect(present.killHome).toBe(false);
  });

  test("an explicit empty emoji keeps start's `??` semantics (bare name, no role default)", () => {
    const plan = planStartRepairs({
      teamName: "t",
      session: "t",
      members: [{ name: "w1", role: "member", emoji: "" }],
      existingNames: ["w1"],
    });
    // start names this member's window from emoji "" — it already exists.
    expect(plan.renames).toEqual([]);
    expect(plan.spawns).toEqual([]);
  });

  test("home alone (no real windows) never plans a kill", () => {
    expect(shouldKillHomeWindow(["__t__home"], "__t__home")).toBe(false);
    expect(shouldKillHomeWindow(["__t__home", "🧭_lead"], "__t__home")).toBe(true);
    expect(shouldKillHomeWindow(["🧭_lead"], "__t__home")).toBe(false);
  });
});

describe("cockpitRebuild --dry-run previews start repairs (t-eb11cdb4)", () => {
  let homeDir: string;
  let projRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atmux-dryrun-repair-home-"));
    await mkdir(join(homeDir, ".atmux"), { recursive: true });
    projRoot = await mkdtemp(join(tmpdir(), "atmux-dryrun-repair-proj-"));
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

  /** Cage fake: existing `demo` session; every mutation lands in `calls`
   *  (the "real execution" the dry-run wrapper must never trigger). */
  function makeCageFake(
    calls: string[],
    windows: Array<{ index: number; id: string; name: string; active: boolean }>,
  ): TmuxNamespace {
    const mark = (name: string) => {
      calls.push(name);
    };
    return {
      session: {
        newSession: async () => {
          mark("cage.session.newSession");
        },
        hasSession: async (name: string) => name === "=demo",
        killSession: async () => {
          mark("cage.session.killSession");
        },
        listSessions: async () => [{ name: "demo", windows: windows.length, created: 0 }],
        renameSession: async () => {
          mark("cage.session.renameSession");
        },
        setEnvironment: async () => {
          mark("cage.session.setEnvironment");
        },
      },
      window: {
        newWindow: async () => {
          mark("cage.window.newWindow");
          return { sessionName: "demo", windowIndex: 9 };
        },
        killWindow: async () => {
          mark("cage.window.killWindow");
        },
        listWindows: async () => windows,
        renameWindow: async () => {
          mark("cage.window.renameWindow");
        },
        selectWindow: async () => {
          mark("cage.window.selectWindow");
        },
        moveWindow: async () => {
          mark("cage.window.moveWindow");
        },
        swapWindow: async () => {
          mark("cage.window.swapWindow");
        },
      },
      pane: {
        sendKeys: async () => {
          mark("cage.pane.sendKeys");
        },
        capturePane: async () => "pane-content",
        listPanes: async () => [],
        displayMessage: async () => "bash",
        killPane: async () => {
          mark("cage.pane.killPane");
        },
        splitWindow: async () => {
          mark("cage.pane.splitWindow");
          return { sessionName: "demo", windowIndex: 0, paneIndex: 0 };
        },
      },
      buffer: {
        loadBuffer: async () => {
          mark("cage.buffer.loadBuffer");
        },
        pasteBuffer: async () => {
          mark("cage.buffer.pasteBuffer");
        },
        deleteBuffer: async () => {
          mark("cage.buffer.deleteBuffer");
        },
      },
      client: {
        attachSession: async () => {
          mark("cage.client.attachSession");
        },
        attachSessionInheritStdio: async () => {
          mark("cage.client.attachSessionInheritStdio");
        },
        switchClient: async () => {
          mark("cage.client.switchClient");
        },
        listClients: async () => [],
      },
      option: {
        setOption: async () => {
          mark("cage.option.setOption");
        },
        showOptions: async () => ({ prefix: "F2" }),
      },
      server: {
        hasServer: async () => true,
        killServer: async () => {
          mark("cage.server.killServer");
        },
      },
    };
  }

  async function runReconcile(
    cageWindows: Array<{ index: number; id: string; name: string; active: boolean }>,
  ): Promise<{ code: number; calls: string[]; text: string; startCalls: number }> {
    const calls: string[] = [];
    const { logger, logs } = makeLogger();
    let startCalls = 0;
    const cage = makeCageFake(calls, cageWindows);
    const cockpitNs = makeFake(calls);
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
        tmuxFactory: (cfg) => ("socketPath" in cfg ? cage : cockpitNs),
        logger,
        startFn: async () => {
          startCalls += 1;
          return 0;
        },
      },
    );
    return { code, calls, text: logs.join("\n"), startCalls };
  }

  test("legacy window + home placeholder yield rename and kill ops, nothing executed", async () => {
    const { code, calls, text, startCalls } = await runReconcile([
      { index: 0, id: "@0", name: "🧭lead", active: true },
      { index: 1, id: "@1", name: "__demo__home", active: false },
    ]);
    expect(code).toBe(0);
    // Nothing executed against the (fake) live servers …
    expect(calls).toEqual([]);
    // … no cage was launched …
    expect(startCalls).toBe(0);
    // … the start-internal repairs are in the plan …
    expect(text).toContain("would rename legacy window '🧭lead' → '🧭_lead' (ADR-135 migration)");
    expect(text).toContain("rename-window -t demo:🧭lead 🧭_lead");
    expect(text).toContain("would kill placeholder window '__demo__home'");
    expect(text).toContain("kill-window -t demo:__demo__home");
    // … with exact counts: 1 rename + 1 kill over the base plan's
    // 0 rename, 1 kill (cockpit orphan), 4 other.
    expect(text).toContain("dry-run: 1 rename, 2 kill, 4 other operations (nothing executed)");
  });

  test("clean cage (canonical window, no home) plans no start repairs", async () => {
    const { code, calls, text, startCalls } = await runReconcile([
      { index: 0, id: "@0", name: "🧭_lead", active: true },
    ]);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(startCalls).toBe(0);
    expect(text).not.toContain("would rename legacy window");
    expect(text).not.toContain("would kill placeholder window");
    expect(text).toContain("dry-run: 0 rename, 1 kill, 4 other operations (nothing executed)");
  });
});

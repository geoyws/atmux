import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PaneRoleValue,
  type PaneTarget,
  serializeTarget,
  type Target,
  type TmuxNamespace,
} from "../../../src/abstractions/tmux.ts";
import type { GitSpawn } from "../../../src/abstractions/worktree.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError } from "../../../src/errors.ts";
import { start } from "../../../src/verbs/start.ts";

interface FakePane {
  id: string;
  index: number;
  pid: number;
  title: string;
  left: number;
  width: number;
  height: number;
  role?: string;
}

interface FakeWindow {
  id: string;
  index: number;
  name: string;
  active: boolean;
  panes: FakePane[];
}

interface FakeSession {
  windows: FakeWindow[];
}

interface FakeCall {
  method: string;
  opts?: unknown;
}

interface FakeState {
  sessions: Map<string, FakeSession>;
  calls: FakeCall[];
  nextWindowId: number;
  nextPaneId: number;
  nextPid: number;
  attentionRoleOverride?: string;
  splitWindowMutator?: (window: FakeWindow, newPane: FakePane) => void;
}

interface Fixture {
  teamName: string;
  atmuxDir: string;
  logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[];
  logger: Logger;
  state: FakeState;
  tmux: TmuxNamespace;
  gitSpawn: GitSpawn;
  writeTeamJson(body: Record<string, unknown>): Promise<void>;
  seedSession(sessionName: string, windows: Array<Pick<FakeWindow, "name" | "panes">>): void;
  runStart(args?: ReadonlyArray<string>): Promise<number>;
}

let env: Fixture;
let rootDir: string;
let priorTmux: string | undefined;
let priorNoCron: string | undefined;

function paneSeed(
  overrides: Partial<FakePane> & Pick<FakePane, "id" | "index" | "pid" | "left">,
): FakePane {
  return {
    id: overrides.id,
    index: overrides.index,
    pid: overrides.pid,
    title: overrides.title ?? overrides.id,
    left: overrides.left,
    width: overrides.width ?? 80,
    height: overrides.height ?? 24,
    ...(overrides.role !== undefined ? { role: overrides.role } : {}),
  };
}

function clonePane(pane: FakePane): FakePane {
  return { ...pane };
}

function normalizeSessionTarget(name: string): string {
  return name.startsWith("=") ? name.slice(1) : name;
}

function normalizeWindowTarget(
  target: Target,
): { sessionName: string; windowName: string } | undefined {
  const serialized = serializeTarget(target);
  const [sessionName, rest] = serialized.split(":", 2);
  if (sessionName === undefined || rest === undefined) return undefined;
  const windowName = rest.split(".", 1)[0];
  if (windowName === undefined) return undefined;
  return { sessionName, windowName };
}

function createFakeTmux(
  state: FakeState,
  options: { withSetPaneRole?: boolean } = {},
): TmuxNamespace {
  const withSetPaneRole = options.withSetPaneRole ?? true;
  const findSession = (name: string): FakeSession | undefined => state.sessions.get(name);

  const findWindow = (
    target: Target,
  ): { sessionName: string; window: FakeWindow; index: number } | undefined => {
    const parsed = normalizeWindowTarget(target);
    if (parsed === undefined) return undefined;
    const { sessionName, windowName } = parsed;
    const session = findSession(sessionName);
    if (session === undefined) return undefined;
    const numericIndex = Number.parseInt(windowName, 10);
    const window =
      session.windows.find((w) => w.name === windowName) ??
      (Number.isInteger(numericIndex) && numericIndex > 0
        ? session.windows[numericIndex - 1]
        : undefined);
    if (window === undefined) return undefined;
    const index = session.windows.indexOf(window);
    if (index < 0) return undefined;
    return { sessionName, window, index };
  };

  const tmux: TmuxNamespace = {
    session: {
      async hasSession(name) {
        return state.sessions.has(normalizeSessionTarget(name));
      },
      async newSession(opts) {
        state.calls.push({ method: "session.newSession", opts: { ...opts } });
        const session = findSession(opts.name) ?? { windows: [] };
        const windowId = state.nextWindowId + 1;
        state.nextWindowId = windowId;
        const paneId = state.nextPaneId + 1;
        state.nextPaneId = paneId;
        const pid = state.nextPid + 1;
        state.nextPid = pid;
        const window: FakeWindow = {
          id: `@${windowId}`,
          index: 1,
          name: opts.windowName ?? "window-1",
          active: true,
          panes: [
            {
              id: `%${paneId}`,
              index: 0,
              pid,
              title: opts.windowName ?? "window-1",
              left: 0,
              width: 80,
              height: 24,
            },
          ],
        };
        session.windows = [window];
        state.sessions.set(opts.name, session);
      },
      async killSession(name) {
        state.calls.push({ method: "session.killSession", opts: { name } });
        state.sessions.delete(normalizeSessionTarget(name));
      },
      async setEnvironment(opts) {
        state.calls.push({ method: "session.setEnvironment", opts: { ...opts } });
      },
      async listSessions() {
        return [...state.sessions.entries()].map(([name, session], index) => ({
          id: `$${index + 1}`,
          name,
          windows: session.windows.length,
          created: 0,
        }));
      },
      async renameSession(oldName, newName) {
        state.calls.push({ method: "session.renameSession", opts: { oldName, newName } });
        const session = state.sessions.get(normalizeSessionTarget(oldName));
        if (session === undefined) return;
        state.sessions.delete(normalizeSessionTarget(oldName));
        state.sessions.set(normalizeSessionTarget(newName), session);
      },
    },
    window: {
      async newWindow(opts) {
        state.calls.push({ method: "window.newWindow", opts: { ...opts } });
        const session = findSession(opts.sessionName);
        if (session === undefined) throw new Error(`missing session: ${opts.sessionName}`);
        const windowId = state.nextWindowId + 1;
        state.nextWindowId = windowId;
        const paneId = state.nextPaneId + 1;
        state.nextPaneId = paneId;
        const pid = state.nextPid + 1;
        state.nextPid = pid;
        const window: FakeWindow = {
          id: `@${windowId}`,
          index: session.windows.length + 1,
          name: opts.name ?? `window-${session.windows.length + 1}`,
          active: true,
          panes: [
            {
              id: `%${paneId}`,
              index: 0,
              pid,
              title: opts.name ?? `window-${session.windows.length + 1}`,
              left: 0,
              width: 80,
              height: 24,
            },
          ],
        };
        const insert = opts.insert;
        if (insert !== undefined) {
          const found = findWindow(insert.target);
          if (found !== undefined) {
            const insertAt = insert.position === "before" ? found.index : found.index + 1;
            session.windows.splice(insertAt, 0, window);
          } else {
            session.windows.push(window);
          }
        } else {
          session.windows.push(window);
        }
        return {
          sessionName: opts.sessionName,
          windowIndex: session.windows.findIndex((entry) => entry.id === window.id) + 1,
        };
      },
      async killWindow(target) {
        state.calls.push({ method: "window.killWindow", opts: { target } });
        const found = findWindow(target);
        if (found === undefined) return;
        const session = findSession(found.sessionName);
        if (session === undefined) return;
        session.windows.splice(found.index, 1);
      },
      async listWindows(sessionName) {
        return (
          findSession(sessionName)?.windows.map((window, index) => ({
            index: index + 1,
            id: window.id,
            name: window.name,
            active: window.active,
          })) ?? []
        );
      },
      async renameWindow(target, name) {
        state.calls.push({ method: "window.renameWindow", opts: { target, name } });
        const found = findWindow(target);
        if (found !== undefined) found.window.name = name;
      },
      async selectWindow(target) {
        state.calls.push({ method: "window.selectWindow", opts: { target } });
      },
      async moveWindow(opts) {
        state.calls.push({ method: "window.moveWindow", opts: { ...opts } });
      },
      async swapWindow(opts) {
        state.calls.push({ method: "window.swapWindow", opts: { ...opts } });
      },
    },
    pane: {
      async sendKeys(opts) {
        state.calls.push({ method: "pane.sendKeys", opts: { ...opts } });
        throw new Error("unexpected sendKeys");
      },
      async capturePane(opts) {
        state.calls.push({ method: "pane.capturePane", opts: { ...opts } });
        return "";
      },
      async listPanes(target) {
        const found = findWindow(target);
        return found?.window.panes.map(clonePane) ?? [];
      },
      ...(withSetPaneRole
        ? {
            async setPaneRole(opts: { target: PaneTarget; value: PaneRoleValue }) {
              state.calls.push({ method: "pane.setPaneRole", opts: { ...opts } });
              const paneId =
                typeof opts.target === "object" && "paneId" in opts.target
                  ? opts.target.paneId
                  : undefined;
              if (paneId === undefined) return;
              for (const session of state.sessions.values()) {
                for (const window of session.windows) {
                  const pane = window.panes.find((entry) => entry.id === paneId);
                  if (pane !== undefined) {
                    if (opts.value === "attention" && state.attentionRoleOverride !== undefined) {
                      pane.role = state.attentionRoleOverride;
                    } else {
                      pane.role = opts.value;
                    }
                    return;
                  }
                }
              }
            },
          }
        : {}),
      async displayMessage(opts) {
        state.calls.push({ method: "pane.displayMessage", opts: { ...opts } });
        const found = findWindow(opts.target);
        const pane = found?.window.panes[0];
        if (pane === undefined) return "";
        if (opts.format.includes("#{pane_pid}")) return String(pane.pid);
        if (opts.format.includes("#{@atmux_driver_pane_role}")) return pane.role ?? "";
        return "";
      },
      async killPane(target) {
        state.calls.push({ method: "pane.killPane", opts: { target } });
      },
      async splitWindow(opts) {
        state.calls.push({ method: "pane.splitWindow", opts: { ...opts } });
        const found = findWindow(opts.target);
        if (found === undefined)
          throw new Error(`missing window for ${serializeTarget(opts.target)}`);
        const paneId = state.nextPaneId + 1;
        state.nextPaneId = paneId;
        const pid = state.nextPid + 1;
        state.nextPid = pid;
        const pane: FakePane = {
          id: `%${paneId}`,
          index: found.window.panes.length,
          pid,
          title: found.window.name,
          left: found.window.panes.length,
          width: 80,
          height: 24,
        };
        found.window.panes.push(pane);
        state.splitWindowMutator?.(found.window, pane);
        return {
          sessionName: found.sessionName,
          windowIndex: found.window.index,
          paneIndex: pane.index,
        };
      },
    },
    buffer: {
      async loadBuffer(opts) {
        state.calls.push({ method: "buffer.loadBuffer", opts: { ...opts } });
      },
      async pasteBuffer(opts) {
        state.calls.push({ method: "buffer.pasteBuffer", opts: { ...opts } });
      },
      async deleteBuffer(name) {
        state.calls.push({ method: "buffer.deleteBuffer", opts: { name } });
      },
    },
    client: {
      async attachSession(name) {
        state.calls.push({ method: "client.attachSession", opts: { name } });
      },
      async attachSessionInheritStdio(name) {
        state.calls.push({ method: "client.attachSessionInheritStdio", opts: { name } });
      },
      async switchClient(opts) {
        state.calls.push({ method: "client.switchClient", opts: { ...opts } });
      },
      async listClients() {
        state.calls.push({ method: "client.listClients" });
        return [];
      },
    },
    option: {
      async setOption(opts) {
        state.calls.push({ method: "option.setOption", opts: { ...opts } });
      },
      async showOptions(opts) {
        state.calls.push({ method: "option.showOptions", opts: { ...opts } });
        return {};
      },
    },
    server: {
      async hasServer() {
        state.calls.push({ method: "server.hasServer" });
        return true;
      },
      async killServer() {
        state.calls.push({ method: "server.killServer" });
      },
    },
  };

  return tmux;
}

function writeTeamJsonFactory(atmuxDir: string) {
  return async (body: Record<string, unknown>) => {
    const withName = body.name === undefined ? { name: env.teamName, ...body } : body;
    await writeFile(join(atmuxDir, "team.json"), `${JSON.stringify(withName, null, 2)}\n`, "utf8");
  };
}

function fakeGitSpawn(): GitSpawn {
  return async () => ({
    exitCode: 128,
    stdout: "",
    stderr: "not a git repository",
    argv: [],
    cmd: "git",
    signalled: null,
    durationMs: 0,
  });
}

function findCall<T extends string>(state: FakeState, method: T): FakeCall[] {
  return state.calls.filter((call) => call.method === method);
}

async function runStartWithTmux(
  tmux: TmuxNamespace,
  args: ReadonlyArray<string> = [],
): Promise<number> {
  return start(args, {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir, ATMUX_NO_CRON: "1" },
    cwd: rootDir,
    logger: env.logger,
    tmuxFactory: () => tmux,
    gitSpawn: env.gitSpawn,
    loadCockpitFn: async () => null,
    cockpitReconcileFn: async () => undefined,
    briefsDir: join(rootDir, "briefs"),
    spawnWaitMs: 0,
    sleep: async () => {},
  });
}

function driverRoster(count: number): Array<{ name: string; cwd: string; tui: string | null }> {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    return {
      name: ordinal === 1 ? "driver" : `driver-${ordinal}`,
      cwd: ordinal === 1 ? "." : `.atmux/worktrees/driver-${ordinal}`,
      tui: null,
    };
  });
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "atmux-start-driver-pair-"));
  const teamName = `t${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const atmuxDir = join(rootDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  const logs: Fixture["logs"] = [];
  const logger: Logger = {
    log: (msg) => logs.push({ kind: "log", msg }),
    ok: (msg) => logs.push({ kind: "ok", msg }),
    warn: (msg) => logs.push({ kind: "warn", msg }),
    err: (msg) => logs.push({ kind: "err", msg }),
  };
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  priorNoCron = process.env.ATMUX_NO_CRON;
  process.env.ATMUX_NO_CRON = "1";
  const state: FakeState = {
    sessions: new Map(),
    calls: [],
    nextWindowId: 1,
    nextPaneId: 1,
    nextPid: 1000,
  };
  const tmux = createFakeTmux(state, { withSetPaneRole: true });
  const writeTeamJson = writeTeamJsonFactory(atmuxDir);
  env = {
    teamName,
    atmuxDir,
    logs,
    logger,
    state,
    tmux,
    gitSpawn: fakeGitSpawn(),
    writeTeamJson,
    seedSession(sessionName, windows) {
      state.sessions.set(sessionName, {
        windows: windows.map((window, index) => ({
          id: `@seed${index + 1}`,
          index: index + 1,
          name: window.name,
          active: index === 0,
          panes: window.panes.map(clonePane),
        })),
      });
    },
    async runStart(args = []) {
      return start(args, {
        env: { ...process.env, ATMUX_DIR: atmuxDir, ATMUX_NO_CRON: "1" },
        cwd: rootDir,
        logger,
        tmuxFactory: () => tmux,
        gitSpawn: env.gitSpawn,
        loadCockpitFn: async () => null,
        cockpitReconcileFn: async () => undefined,
        briefsDir: join(rootDir, "briefs"),
        spawnWaitMs: 0,
        sleep: async () => {},
      });
    },
  };
});

afterEach(async () => {
  try {
    await env.tmux.server.killServer();
  } catch {
    // fake server
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  else delete process.env.TMUX;
  if (priorNoCron !== undefined) process.env.ATMUX_NO_CRON = priorNoCron;
  else delete process.env.ATMUX_NO_CRON;
  await rm(rootDir, { recursive: true, force: true });
});

describe("start — driver pair safety matrix", () => {
  test("fresh default roster materializes worker-left / attention-right and omits attention shellCommand when null", async () => {
    await env.writeTeamJson({ members: [] });

    expect(await env.runStart()).toBe(0);

    const windows = [...(await env.tmux.window.listWindows(env.teamName))];
    expect(windows.map((window) => window.name)).toEqual(["driver", "driver-2", "driver-3"]);

    const newSessionCall = findCall(env.state, "session.newSession")[0]?.opts as
      | { shellCommand?: string }
      | undefined;
    expect(newSessionCall?.shellCommand).toBe("zsh");
    const newWindowCalls = findCall(env.state, "window.newWindow");
    expect(newWindowCalls).toHaveLength(2);
    for (const call of newWindowCalls) {
      const opts = call.opts as { shellCommand?: string };
      expect(opts.shellCommand).toBe("zsh");
    }

    const splitCalls = findCall(env.state, "pane.splitWindow");
    expect(splitCalls).toHaveLength(3);
    for (const call of splitCalls) {
      const opts = call.opts as { shellCommand?: string };
      expect(Object.hasOwn(opts, "shellCommand")).toBe(false);
    }

    for (const driverName of ["driver", "driver-2", "driver-3"] as const) {
      const panes = env.state.sessions
        .get(env.teamName)
        ?.windows.find((window) => window.name === driverName)?.panes;
      expect(panes).toBeDefined();
      expect(panes).toHaveLength(2);
      expect(panes?.[0]?.role).toBe("worker");
      expect(panes?.[1]?.role).toBe("attention");
      expect((panes?.[0]?.left ?? 0) < (panes?.[1]?.left ?? 0)).toBe(true);
    }
  });

  test("fresh roster passes the explicit attention shellCommand through splitWindow", async () => {
    await env.writeTeamJson({
      members: [],
      driverPair: {
        layout: "horizontal",
        panes: [
          { role: "worker", side: "left" },
          {
            role: "attention",
            side: "right",
            workflow: "kb-att",
            authority: "decision-only",
            command: "printf attention",
          },
        ],
      },
    });

    expect(await env.runStart()).toBe(0);
    const splitCalls = findCall(env.state, "pane.splitWindow");
    expect(splitCalls).toHaveLength(3);
    for (const call of splitCalls) {
      const opts = call.opts as { shellCommand?: string };
      expect(opts.shellCommand).toBe("printf attention");
    }
  });

  test("invalid later driver fails closed before any missing-driver creation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 101, left: 0, role: "worker" })],
      },
      {
        name: "driver-2",
        panes: [
          paneSeed({ id: "%2", index: 0, pid: 202, left: 0, role: "worker" }),
          paneSeed({ id: "%3", index: 1, pid: 203, left: 1, role: "worker" }),
        ],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("run atmux doctor");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
    expect(findCall(env.state, "window.newWindow")).toHaveLength(0);
    const workerPid = env.state.sessions
      .get(env.teamName)
      ?.windows.find((window) => window.name === "driver")?.panes[0]?.pid;
    expect(workerPid).toBe(101);
  });

  test("safe singleton preserves the worker PID while materializing the roster", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 301, left: 0, role: "worker" })],
      },
    ]);

    expect(await env.runStart()).toBe(0);
    const panes = env.state.sessions
      .get(env.teamName)
      ?.windows.find((window) => window.name === "driver")?.panes;
    expect(panes).toHaveLength(2);
    expect(panes?.[0]?.pid).toBe(301);
    expect(panes?.[0]?.role).toBe("worker");
    expect(panes?.[1]?.role).toBe("attention");
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(6);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(3);
  });

  test("a fully populated valid roster needs no pair mutation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [
          paneSeed({ id: "%1", index: 0, pid: 401, left: 0, role: "worker" }),
          paneSeed({ id: "%2", index: 1, pid: 402, left: 1, role: "attention" }),
        ],
      },
      {
        name: "driver-2",
        panes: [
          paneSeed({ id: "%3", index: 0, pid: 403, left: 0, role: "worker" }),
          paneSeed({ id: "%4", index: 1, pid: 404, left: 1, role: "attention" }),
        ],
      },
      {
        name: "driver-3",
        panes: [
          paneSeed({ id: "%5", index: 0, pid: 405, left: 0, role: "worker" }),
          paneSeed({ id: "%6", index: 1, pid: 406, left: 1, role: "attention" }),
        ],
      },
    ]);

    expect(await env.runStart()).toBe(0);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
  });

  test("incremental singleton driver inserts the canonical roster in order", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 501, left: 0, role: "worker" })],
      },
    ]);

    expect(await env.runStart()).toBe(0);
    const windows = await env.tmux.window.listWindows(env.teamName);
    expect(windows.map((window) => window.name)).toEqual(["driver", "driver-2", "driver-3"]);
    const driverPanes = env.state.sessions
      .get(env.teamName)
      ?.windows.find((window) => window.name === "driver")?.panes;
    expect(driverPanes).toHaveLength(2);
    expect(driverPanes?.[0]?.pid).toBe(501);
    expect(driverPanes?.[0]?.role).toBe("worker");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(3);
    expect(findCall(env.state, "window.newWindow")).toHaveLength(2);
  });

  test("missing driver inserts before the next configured driver, not after a member", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver-2",
        panes: [
          paneSeed({ id: "%1", index: 0, pid: 611, left: 0, role: "worker" }),
          paneSeed({ id: "%2", index: 1, pid: 612, left: 1, role: "attention" }),
        ],
      },
      {
        name: "driver-3",
        panes: [
          paneSeed({ id: "%3", index: 0, pid: 621, left: 0, role: "worker" }),
          paneSeed({ id: "%4", index: 1, pid: 622, left: 1, role: "attention" }),
        ],
      },
      {
        name: "🧭_alpha",
        panes: [paneSeed({ id: "%5", index: 0, pid: 631, left: 0, role: "worker" })],
      },
    ]);

    expect(await env.runStart()).toBe(0);
    const ordered = [...(await env.tmux.window.listWindows(env.teamName))].sort(
      (a, b) => a.index - b.index,
    );
    expect(ordered.map((window) => window.name)).toEqual([
      "driver",
      "driver-2",
      "driver-3",
      "🧭_alpha",
    ]);
    expect(findCall(env.state, "window.newWindow")).toHaveLength(1);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(1);
  });

  test("legacy-session reversed configured drivers fail closed before rename", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(`atmux-${env.teamName}`, [
      {
        name: "driver-3",
        panes: [
          paneSeed({ id: "%1", index: 0, pid: 711, left: 0, role: "worker" }),
          paneSeed({ id: "%2", index: 1, pid: 712, left: 1, role: "attention" }),
        ],
      },
      {
        name: "driver-2",
        panes: [
          paneSeed({ id: "%3", index: 0, pid: 721, left: 0, role: "worker" }),
          paneSeed({ id: "%4", index: 1, pid: 722, left: 1, role: "attention" }),
        ],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.reversed_order");
    expect(findCall(env.state, "session.renameSession")).toHaveLength(0);
    expect(findCall(env.state, "window.newWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
  });

  test("configured driver after a member fails closed before any mutation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 731, left: 0, role: "worker" })],
      },
      {
        name: "🧭_alpha",
        panes: [paneSeed({ id: "%2", index: 0, pid: 732, left: 0, role: "worker" })],
      },
      {
        name: "driver-3",
        panes: [
          paneSeed({ id: "%3", index: 0, pid: 733, left: 0, role: "worker" }),
          paneSeed({ id: "%4", index: 1, pid: 734, left: 1, role: "attention" }),
        ],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("front block before members");
    expect(findCall(env.state, "session.renameSession")).toHaveLength(0);
    expect(findCall(env.state, "window.newWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
  });

  test("explicit 4-10 additions create the roster in order and rerun noop", async () => {
    for (const count of [4, 10] as const) {
      await env.writeTeamJson({ members: [], drivers: driverRoster(count) });
      env.seedSession(env.teamName, [
        {
          name: "driver",
          panes: [paneSeed({ id: "%1", index: 0, pid: 601, left: 0, role: "worker" })],
        },
      ]);

      expect(await env.runStart()).toBe(0);
      const ordered = [...(await env.tmux.window.listWindows(env.teamName))].sort(
        (a, b) => a.index - b.index,
      );
      expect(ordered.map((window) => window.name)).toEqual(
        driverRoster(count).map((driver) => driver.name),
      );
      expect(findCall(env.state, "window.newWindow")).toHaveLength(count - 1);
      expect(findCall(env.state, "pane.splitWindow")).toHaveLength(count);

      env.state.calls.length = 0;
      expect(await env.runStart()).toBe(0);
      expect(findCall(env.state, "window.newWindow")).toHaveLength(0);
      expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
      env.state.calls.length = 0;
      env.state.sessions.clear();
    }
  });

  test("invalid old driver layout is bypassed by --force kill/recreate", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [
          paneSeed({ id: "%1", index: 0, pid: 701, left: 0, role: "worker" }),
          paneSeed({ id: "%2", index: 1, pid: 702, left: 1, role: "worker" }),
        ],
      },
    ]);

    expect(await env.runStart(["--force"])).toBe(0);
    expect(findCall(env.state, "session.killSession")).toHaveLength(1);
    expect(findCall(env.state, "session.newSession")).toHaveLength(1);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(3);
  });

  test("bogus driver pane id metadata fails closed without mutation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 801, left: 0, role: "worker" })],
      },
    ]);
    const session = env.state.sessions.get(env.teamName);
    const pane = session?.windows[0]?.panes[0];
    if (pane !== undefined) {
      pane.id = "pane-1";
    }

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("run atmux doctor");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
  });

  test("bogus driver pane pid metadata fails closed without mutation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 801, left: 0, role: "worker" })],
      },
    ]);
    const session = env.state.sessions.get(env.teamName);
    const pane = session?.windows[0]?.panes[0];
    if (pane !== undefined) {
      pane.pid = 0;
    }

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("run atmux doctor");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
  });

  test("bogus driver pane left metadata fails closed without mutation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 801, left: 0, role: "worker" })],
      },
    ]);
    const session = env.state.sessions.get(env.teamName);
    const pane = session?.windows[0]?.panes[0];
    if (pane !== undefined) {
      pane.left = -1;
    }

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("run atmux doctor");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
  });

  test("bogus driver pane index metadata fails closed without mutation", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 801, left: 0, role: "worker" })],
      },
    ]);
    const session = env.state.sessions.get(env.teamName);
    const pane = session?.windows[0]?.panes[0];
    if (pane !== undefined) {
      pane.index = -1;
    }

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("run atmux doctor");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(0);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(0);
  });

  test("final planner-not-noop failure rejects after a bad attention role write", async () => {
    await env.writeTeamJson({ members: [] });
    env.state.attentionRoleOverride = "attention-bad";
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 901, left: 0, role: "worker" })],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("materialization failed");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(1);
    expect(findCall(env.state, "pane.setPaneRole")).toHaveLength(2);
  });

  test("duplicate pane ids after split fails closed before final noop", async () => {
    await env.writeTeamJson({ members: [] });
    env.state.splitWindowMutator = (window, newPane) => {
      newPane.id = window.panes[0]?.id ?? newPane.id;
    };
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 951, left: 0, role: "worker" })],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("lost its attention pane");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(1);
  });

  test("worker PID changed after split fails closed before final noop", async () => {
    await env.writeTeamJson({ members: [] });
    env.state.splitWindowMutator = (window) => {
      const worker = window.panes[0];
      if (worker !== undefined) worker.pid += 1;
    };
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 961, left: 0, role: "worker" })],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("worker pane process");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(1);
  });

  test("post-split pane count != 2 fails closed before final noop", async () => {
    await env.writeTeamJson({ members: [] });
    env.state.splitWindowMutator = (window) => {
      window.panes.pop();
    };
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 971, left: 0, role: "worker" })],
      },
    ]);

    const rejected = env.runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("did not settle to two panes");
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(1);
  });

  test("missing setPaneRole fails clearly when pair materialization needs it", async () => {
    await env.writeTeamJson({ members: [] });
    const localState: FakeState = {
      sessions: new Map(),
      calls: [],
      nextWindowId: 1,
      nextPaneId: 1,
      nextPid: 1000,
    };
    const tmux = createFakeTmux(localState, { withSetPaneRole: false });
    localState.sessions.set(env.teamName, {
      windows: [
        {
          id: "@seed1",
          index: 1,
          name: "driver",
          active: true,
          panes: [paneSeed({ id: "%1", index: 0, pid: 1001, left: 0 })],
        },
      ],
    });

    const rejected = runStartWithTmux(tmux);
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("missing_set_pane_role");
    expect(findCall(localState, "pane.splitWindow")).toHaveLength(0);
  });

  test("explicit driver rosters of 3 and 10 materialize ordered worker-attention pairs", async () => {
    for (const count of [3, 10] as const) {
      await env.writeTeamJson({ members: [], drivers: driverRoster(count) });
      expect(await env.runStart()).toBe(0);
      const names = [...(await env.tmux.window.listWindows(env.teamName))]
        .sort((a, b) => a.index - b.index)
        .map((window) => window.name);
      expect(names).toEqual(driverRoster(count).map((driver) => driver.name));
      for (const driver of driverRoster(count)) {
        const panes = env.state.sessions
          .get(env.teamName)
          ?.windows.find((window) => window.name === driver.name)?.panes;
        expect(panes).toHaveLength(2);
        expect(panes?.[0]?.role).toBe("worker");
        expect(panes?.[1]?.role).toBe("attention");
      }
      expect(findCall(env.state, "pane.splitWindow")).toHaveLength(count);
      env.state.calls.length = 0;
      env.state.sessions.clear();
    }
  });

  test("--force preserves the explicit kill/recreate contract", async () => {
    await env.writeTeamJson({ members: [] });
    env.seedSession(env.teamName, [
      {
        name: "driver",
        panes: [paneSeed({ id: "%1", index: 0, pid: 601, left: 0, role: "worker" })],
      },
    ]);

    expect(await env.runStart(["--force"])).toBe(0);
    expect(findCall(env.state, "session.killSession")).toHaveLength(1);
    expect(findCall(env.state, "session.newSession")).toHaveLength(1);
    expect(findCall(env.state, "pane.splitWindow")).toHaveLength(3);
    const panes = env.state.sessions
      .get(env.teamName)
      ?.windows.find((window) => window.name === "driver")?.panes;
    expect(panes).toHaveLength(2);
    expect(panes?.[0]?.role).toBe("worker");
    expect(panes?.[1]?.role).toBe("attention");
  });
});

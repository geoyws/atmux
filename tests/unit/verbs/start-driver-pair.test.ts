// ADR-288 pair runtime — rollout-gated materialization + reconcile.
//
// Scratch-socket integration (mirrors tests/unit/verbs/start.test.ts):
// real tmux server per test, real `start` verb, real `listPanes` /
// `setPaneRole` / `splitWindow` round-trips. Plus hand-built namespace
// unit tests for `ensureDriverPairMaterialized`'s fail-closed branches
// that a live server cannot produce (missing metadata, lost splits,
// PID swaps).
//
// Fixture teams are drivers-only (members: [], superdriver disabled)
// with shell-only drivers (tui: null), so no TUI launch, brief paste,
// or worktree provisioning can fire.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneInfo, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError } from "../../../src/errors.ts";
import { Team } from "../../../src/schema/team.ts";
import { checkDriverPaneState } from "../../../src/verbs/doctor/driver.ts";
import { ensureDriverPairMaterialized, start } from "../../../src/verbs/start.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

// ---------- Scratch-socket fixture ----------

interface TestEnv {
  atmuxDir: string;
  homeDir: string;
  socketPath: string;
  tmux: TmuxNamespace;
  team: string;
  logs: { kind: "log" | "ok" | "warn" | "err"; msg: string }[];
  logger: Logger;
}

let env: TestEnv;
let socketDir: string;
let priorTmux: string | undefined;
let priorNoCron: string | undefined;
let restoreHome: (() => void) | null = null;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-pair-sock-"));
  const homeDir = await mkdtemp(join(tmpdir(), "atmux-pair-home-"));
  const socketPath = join(socketDir, "sock");
  const atmuxDir = await mkdtemp(join(tmpdir(), "atmux-pair-dir-"));
  const team = `p${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await mkdir(atmuxDir, { recursive: true });
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  priorNoCron = process.env.ATMUX_NO_CRON;
  process.env.ATMUX_NO_CRON = "1";
  restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
  const logs: TestEnv["logs"] = [];
  const logger: Logger = {
    log: (msg) => logs.push({ kind: "log", msg }),
    ok: (msg) => logs.push({ kind: "ok", msg }),
    warn: (msg) => logs.push({ kind: "warn", msg }),
    err: (msg) => logs.push({ kind: "err", msg }),
  };
  env = {
    atmuxDir,
    homeDir,
    socketPath,
    tmux: createCanonicalAtmuxTmux({ socketPath }),
    team,
    logs,
    logger,
  };
});

afterEach(async () => {
  try {
    await env.tmux.server.killServer();
  } catch {
    // expected: server may already be gone (idempotent teardown)
  }
  restoreHome?.();
  restoreHome = null;
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  else delete process.env.TMUX;
  if (priorNoCron !== undefined) process.env.ATMUX_NO_CRON = priorNoCron;
  else delete process.env.ATMUX_NO_CRON;
  await rm(socketDir, { recursive: true, force: true });
  await rm(env.atmuxDir, { recursive: true, force: true });
  await rm(env.homeDir, { recursive: true, force: true });
});

async function writeTeamJson(opts: { materialize?: boolean }): Promise<void> {
  const body: Record<string, unknown> = {
    name: env.team,
    members: [],
    drivers: [
      { name: "driver", tui: null, cwd: "." },
      { name: "driver-2", tui: null, cwd: "." },
    ],
    driverPair: {
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          tui: null,
          command: null,
        },
      ],
      ...(opts.materialize === true ? { materialize: true } : {}),
    },
    driverSession: { tui: null },
    superdriver: { enabled: false },
  };
  await writeFile(join(env.atmuxDir, "team.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

type StartOpts = NonNullable<Parameters<typeof start>[1]>;

async function runStart(args: ReadonlyArray<string> = []): Promise<number> {
  const startOpts: StartOpts = {
    env: { ...process.env, ATMUX_DIR: env.atmuxDir },
    cwd: env.atmuxDir,
    logger: env.logger,
    loadCockpitFn: async () => null,
    preflightDeps: {
      existsSync: () => true,
      tmuxVersion: () => "tmux 3.6a",
      readPin: () => "3.6a",
      homeDir: env.atmuxDir,
    },
    legacySocketDeps: {
      exists: () => false,
      isLive: async () => false,
      remove: () => {
        throw new Error("legacySocketDeps.remove must not run in unit tests");
      },
      log: () => {},
    },
    sleep: async () => {},
    spawnWaitMs: 0,
    briefsDir: env.atmuxDir,
  };
  return await start([...args, "--socket-path", env.socketPath], startOpts);
}

async function listDriverPanes(name: string): Promise<PaneInfo[]> {
  return await env.tmux.pane.listPanes(`${env.team}:${name}`);
}

async function loadParsedTeam(): Promise<Team> {
  const raw = await readFile(join(env.atmuxDir, "team.json"), "utf8");
  return Team.parse(JSON.parse(raw) as unknown);
}

function byLeft(panes: PaneInfo[]): PaneInfo[] {
  return [...panes].sort((a, b) => (a.left ?? 0) - (b.left ?? 0));
}

// ---------- Flag on: fresh creation ----------

describe("start — driver pair fresh creation (materialize: true)", () => {
  test("every driver window gains worker-left / attention-right with role metadata", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);

    for (const name of ["driver", "driver-2"]) {
      const panes = await listDriverPanes(name);
      expect(panes).toHaveLength(2);
      const [left, right] = byLeft(panes);
      expect(left?.role).toBe("worker");
      expect(right?.role).toBe("attention");
      expect(left?.id).toMatch(/^%[0-9]+$/);
      expect(right?.id).toMatch(/^%[0-9]+$/);
      expect(left?.id).not.toBe(right?.id);
      expect(left?.pid).toBeGreaterThan(0);
      expect(right?.pid).toBeGreaterThan(0);
      expect(left?.pid).not.toBe(right?.pid);
    }
  });

  test("rerun is a no-op (same pane ids and PIDs)", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);
    const before = new Map(
      await Promise.all(
        ["driver", "driver-2"].map(async (name) => [name, await listDriverPanes(name)] as const),
      ),
    );
    expect(await runStart()).toBe(0);
    for (const name of ["driver", "driver-2"]) {
      const after = await listDriverPanes(name);
      const prior = before.get(name) ?? [];
      expect(after.map((p) => p.id).sort()).toEqual(prior.map((p) => p.id).sort());
      expect(after.map((p) => p.pid).sort()).toEqual(prior.map((p) => p.pid).sort());
    }
  });

  test("missing right pane is repaired with the left pane and PID preserved", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);
    const before = byLeft(await listDriverPanes("driver"));
    const workerId = before[0]?.id ?? "";
    const workerPid = before[0]?.pid ?? 0;
    await env.tmux.pane.killPane(before[1]?.id ?? "");

    expect(await runStart()).toBe(0);
    const after = byLeft(await listDriverPanes("driver"));
    expect(after).toHaveLength(2);
    expect(after[0]?.id).toBe(workerId);
    expect(after[0]?.pid).toBe(workerPid);
    expect(after[0]?.role).toBe("worker");
    expect(after[1]?.role).toBe("attention");
  });

  test("missing driver window is reported, not created, on the incremental path", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);
    await env.tmux.window.killWindow(`${env.team}:driver-2`);

    env.logs.length = 0;
    expect(await runStart()).toBe(0);
    expect(
      env.logs.some((l) => l.msg.includes("driver-2") && l.msg.includes("window missing")),
    ).toBe(true);
    const names = (await env.tmux.window.listWindows(env.team)).map((w) => w.name);
    expect(names).not.toContain("driver-2");
    // The surviving pair is untouched (still a no-op reconcile).
    expect((await listDriverPanes("driver")).map((p) => p.role).sort()).toEqual([
      "attention",
      "worker",
    ]);
  });
});

// ---------- Flag on: fail-closed ----------

describe("start — driver pair fail-closed (materialize: true)", () => {
  test("three-pane window fails closed with no pane killed + red doctor row", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);
    await env.tmux.pane.splitWindow({
      target: `${env.team}:driver`,
      detached: true,
      cwd: env.atmuxDir,
    });
    expect(await listDriverPanes("driver")).toHaveLength(3);

    const rejected = runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("run atmux doctor");
    expect(await listDriverPanes("driver")).toHaveLength(3);

    const rows = await checkDriverPaneState(await loadParsedTeam(), env.atmuxDir, {
      probeDeps: { tmux: env.tmux },
    });
    const pairRows = rows.filter((r) => r.label === "driver-pane-pair");
    expect(
      pairRows.some((r) => r.status === "red" && (r.detail ?? "").includes("pair.too_many_panes")),
    ).toBe(true);
  });

  test("reversed role metadata fails closed with no pane killed + red doctor row", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);
    const [left, right] = byLeft(await listDriverPanes("driver"));
    await env.tmux.pane.setPaneRole?.({ target: { paneId: left?.id ?? "" }, value: "attention" });
    await env.tmux.pane.setPaneRole?.({ target: { paneId: right?.id ?? "" }, value: "worker" });

    const rejected = runStart();
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.two.reversed_geometry");
    const panes = await listDriverPanes("driver");
    expect(panes).toHaveLength(2);
    expect(byLeft(panes).map((p) => p.role)).toEqual(["attention", "worker"]);

    const rows = await checkDriverPaneState(await loadParsedTeam(), env.atmuxDir, {
      probeDeps: { tmux: env.tmux },
    });
    const pairRows = rows.filter((r) => r.label === "driver-pane-pair");
    expect(
      pairRows.some(
        (r) => r.status === "red" && (r.detail ?? "").includes("pair.two.reversed_geometry"),
      ),
    ).toBe(true);
  });
});

// ---------- Flag on: healthy doctor ----------

describe("doctor — healthy pair (materialize: true)", () => {
  test("valid pairs surface a green driver-pane-pair row per driver", async () => {
    await writeTeamJson({ materialize: true });
    expect(await runStart()).toBe(0);
    const rows = await checkDriverPaneState(await loadParsedTeam(), env.atmuxDir, {
      probeDeps: { tmux: env.tmux },
    });
    const pairRows = rows.filter((r) => r.label === "driver-pane-pair");
    expect(pairRows).toHaveLength(2);
    expect(pairRows.every((r) => r.status === "green")).toBe(true);
  });
});

// ---------- Flag off: today's behaviour ----------

describe("start — driver pair gate off", () => {
  test("single-pane driver windows, no role metadata, rerun stable", async () => {
    await writeTeamJson({});
    expect(await runStart()).toBe(0);
    for (const name of ["driver", "driver-2"]) {
      const panes = await listDriverPanes(name);
      expect(panes).toHaveLength(1);
      expect(panes[0]?.role).toBeUndefined();
    }
    const before = await listDriverPanes("driver");
    expect(await runStart()).toBe(0);
    const after = await listDriverPanes("driver");
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
    expect(after.map((p) => p.pid)).toEqual(before.map((p) => p.pid));
  });

  test("gate off: doctor stays silent on single-pane windows", async () => {
    await writeTeamJson({});
    expect(await runStart()).toBe(0);
    const rows = await checkDriverPaneState(await loadParsedTeam(), env.atmuxDir, {
      probeDeps: { tmux: env.tmux },
    });
    expect(rows.filter((r) => r.label === "driver-pane-pair")).toHaveLength(0);
  });
});

// ---------- ensureDriverPairMaterialized fail-closed unit matrix ----------

interface FakeRow {
  id?: string;
  index?: number;
  pid?: number;
  title?: string;
  left?: number;
  width?: number;
  height?: number;
  role?: string;
}

function makePaneFake(
  initial: FakeRow[],
  opts: {
    omitSetPaneRole?: boolean;
    onSplit?: (rows: FakeRow[]) => void;
    ignoreAttentionTag?: boolean;
    attentionCommandSeen?: { shellCommand?: string | undefined; hasKey: boolean };
  } = {},
): { tmux: TmuxNamespace; calls: { split: number; setRole: number } } {
  const rows = initial.map((r) => ({ ...r }));
  const calls = { split: 0, setRole: 0 };
  const pane: Record<string, unknown> = {
    listPanes: async () => rows.map((r) => ({ ...r })),
    splitWindow: async (splitOpts: { shellCommand?: string }) => {
      calls.split += 1;
      if (opts.attentionCommandSeen !== undefined) {
        opts.attentionCommandSeen.hasKey = "shellCommand" in splitOpts;
        opts.attentionCommandSeen.shellCommand = splitOpts.shellCommand;
      }
      if (opts.onSplit !== undefined) {
        opts.onSplit(rows);
      } else {
        rows.push({
          id: `%${90 + rows.length}`,
          index: rows.length,
          pid: 900 + rows.length,
          left: 80,
          width: 80,
          height: 24,
        });
      }
      return { sessionName: "s", windowIndex: 1, paneIndex: rows.length - 1 };
    },
  };
  if (opts.omitSetPaneRole !== true) {
    pane.setPaneRole = async (setOpts: { target: { paneId: string }; value: string }) => {
      calls.setRole += 1;
      if (opts.ignoreAttentionTag === true && setOpts.value === "attention") return;
      const row = rows.find((r) => r.id === setOpts.target.paneId);
      if (row !== undefined) row.role = setOpts.value;
    };
  }
  return { tmux: { pane } as unknown as TmuxNamespace, calls };
}

function healthySingleton(): FakeRow[] {
  return [{ id: "%1", index: 0, pid: 11, title: "shell", left: 0, width: 160, height: 24 }];
}

describe("ensureDriverPairMaterialized — fail-closed matrix", () => {
  test("valid pair is a no-op with zero mutations", async () => {
    const { tmux, calls } = makePaneFake([
      {
        id: "%1",
        index: 0,
        pid: 11,
        title: "shell",
        left: 0,
        width: 80,
        height: 24,
        role: "worker",
      },
      {
        id: "%2",
        index: 1,
        pid: 12,
        title: "shell",
        left: 80,
        width: 80,
        height: 24,
        role: "attention",
      },
    ]);
    const outcome = await ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    expect(outcome).toBe("noop");
    expect(calls).toEqual({ split: 0, setRole: 0 });
  });

  test("null attention command splits without shellCommand (plain shell)", async () => {
    const seen: { shellCommand?: string | undefined; hasKey: boolean } = { hasKey: false };
    const { tmux } = makePaneFake(healthySingleton(), { attentionCommandSeen: seen });
    expect(
      await ensureDriverPairMaterialized({
        tmux,
        session: "s",
        driverName: "driver",
        driverCwd: "/tmp",
        attentionCommand: null,
      }),
    ).toBe("repaired");
    expect(seen.hasKey).toBe(false);
  });

  test("explicit attention command passes through splitWindow", async () => {
    const seen: { shellCommand?: string | undefined; hasKey: boolean } = { hasKey: false };
    const { tmux } = makePaneFake(healthySingleton(), { attentionCommandSeen: seen });
    expect(
      await ensureDriverPairMaterialized({
        tmux,
        session: "s",
        driverName: "driver",
        driverCwd: "/tmp",
        attentionCommand: "kb-att --watch",
      }),
    ).toBe("repaired");
    expect(seen.hasKey).toBe(true);
    expect(seen.shellCommand).toBe("kb-att --watch");
  });

  test("three panes fail closed before any mutation", async () => {
    const { tmux, calls } = makePaneFake([
      { id: "%1", index: 0, pid: 11, left: 0, role: "worker" },
      { id: "%2", index: 1, pid: 12, left: 80, role: "attention" },
      { id: "%3", index: 2, pid: 13, left: 160 },
    ]);
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.too_many_panes");
    expect(calls).toEqual({ split: 0, setRole: 0 });
  });

  test.each([
    ["missing id", [{ index: 0, pid: 11, left: 0 }]],
    ["non-positive pid", [{ id: "%1", index: 0, pid: 0, left: 0 }]],
    ["missing left", [{ id: "%1", index: 0, pid: 11 }]],
    ["negative index", [{ id: "%1", index: -1, pid: 11, left: 0 }]],
  ] as Array<
    [string, FakeRow[]]
  >)("bad metadata (%s) fails closed without mutation", async (_label, initial) => {
    const { tmux, calls } = makePaneFake(initial);
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.missing_required_metadata");
    expect(calls).toEqual({ split: 0, setRole: 0 });
  });

  test("split that duplicates the worker id fails closed (lost attention pane)", async () => {
    const { tmux } = makePaneFake(healthySingleton(), {
      onSplit: (rows) => {
        rows.push({ id: "%1", index: 1, pid: 999, left: 80, width: 80, height: 24 });
      },
    });
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("lost its attention pane");
  });

  test("absent setPaneRole fails closed after classification", async () => {
    const { tmux } = makePaneFake(healthySingleton(), { omitSetPaneRole: true });
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.missing_set_pane_role");
  });

  test("split that does not settle to two panes fails closed", async () => {
    const { tmux } = makePaneFake(healthySingleton(), {
      onSplit: () => {},
    });
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.repair_split_failed");
  });

  test("worker PID swap during split fails closed", async () => {
    const { tmux } = makePaneFake(healthySingleton(), {
      onSplit: (rows) => {
        rows.push({ id: "%2", index: 1, pid: 999, left: 80, width: 80, height: 24 });
        const worker = rows.find((r) => r.id === "%1");
        if (worker !== undefined) worker.pid = 555;
      },
    });
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.worker_pid_changed");
  });

  test("final layout that is not a pair fails closed", async () => {
    const { tmux } = makePaneFake(healthySingleton(), { ignoreAttentionTag: true });
    const rejected = ensureDriverPairMaterialized({
      tmux,
      session: "s",
      driverName: "driver",
      driverCwd: "/tmp",
      attentionCommand: null,
    });
    await expect(rejected).rejects.toThrow(ConfigError);
    await expect(rejected).rejects.toThrow("pair.two.missing_role");
  });
});

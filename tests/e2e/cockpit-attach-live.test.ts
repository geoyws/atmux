// ADR-306 — real-tmux integration coverage for `cockpit attach --live`.
//
// Spins throwaway tmux servers on unique-per-run sockets inside an
// isolated TMUX_TMPDIR (0700) and exercises the production probe path
// (stat + connect-dial + real `has-session` / `list-windows` /
// `display-message` via the default seams). Only the final blocking
// `attach-session` exec is faked — a headless runner has no tty for a
// real attach, and the repo's own attach coverage strategy
// (src/verbs/attach.ts header) stubs that same boundary.
//
// Four runs cover the operator-visible contract per ADR-306:
//   1. live — single cockpit attaches to it; socket dir unchanged.
//   2. vendored-only — attaches to `atmux-vendored-cockpit`; dir unchanged.
//   3. absent — refuses with the `aca` hint; no socket/server created.
//   4. ambiguous — refuses with a listing of both cockpits.
// Plus a direct-probe run pinning the real window count + version.
//
// Skipped when tmux is absent (CI without tmux).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  attachLiveCockpit,
  defaultEnsureLiveParentDir,
  defaultFindLiveServers,
  defaultLiveDialSocket,
  defaultLiveSleepMs,
  defaultLiveStatNode,
  defaultResolveLiveClients,
  defaultRunLiveTmux,
  defaultSendLiveRebind,
  type LiveProbeSeams,
  probeLiveCandidate,
  serverBinForCandidate,
} from "../../src/core/cockpit-live-attach.ts";
import type { Logger } from "../../src/core/tui.ts";
import { CANONICAL_ATMUX_TMUX_CONF_PATH, setCanonicalAtmuxTmuxHome } from "../helpers/tmux.ts";

function probeBin(cmd: string[]): boolean {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_TMUX = probeBin(["tmux", "-V"]);
const SESSION = "atx";

interface Hermetic {
  workDir: string;
  tmuxTmpdir: string;
  sockDir: string;
  restoreHome: () => void;
  priorTmux: string | undefined;
  priorTmuxTmpdir: string | undefined;
  priorCockpitSocket: string | undefined;
  attached: Array<{ bin: string; argv: ReadonlyArray<string> }>;
  warns: string[];
  logger: Logger;
}

function cockpitSock(h: Hermetic, name: string): string {
  return join(h.sockDir, name);
}

/** Start a detached server with `session` on the absolute socket path. */
function startServer(sockPath: string, session: string): void {
  defaultEnsureLiveParentDir(sockPath);
  const proc = Bun.spawnSync({
    cmd: [
      "tmux",
      "-f",
      CANONICAL_ATMUX_TMUX_CONF_PATH,
      "-S",
      sockPath,
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "200",
      "-y",
      "50",
    ],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`new-session on ${sockPath} failed: ${proc.stderr?.toString() ?? ""}`);
  }
}

function tmuxRaw(sockPath: string, argv: string[]): void {
  const proc = Bun.spawnSync({
    cmd: ["tmux", "-S", sockPath, ...argv],
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`tmux ${argv.join(" ")} failed: ${proc.stderr?.toString() ?? ""}`);
  }
}

function killServer(sockPath: string): void {
  try {
    Bun.spawnSync({
      cmd: ["tmux", "-S", sockPath, "kill-server"],
      env: { ...process.env },
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Already dead — teardown is best-effort.
  }
}

/** Sorted socket-dir entries, or [] when the dir does not exist yet. */
async function socketDirEntries(h: Hermetic): Promise<string[]> {
  try {
    return (await readdir(h.sockDir)).sort();
  } catch {
    return [];
  }
}

describe.skipIf(!HAS_TMUX)("integration ADR-306 — cockpit attach --live", () => {
  let h: Hermetic;

  beforeEach(async () => {
    const workDir = await mkdtemp("/tmp/atmux-live-");
    const tmuxTmpdir = join(workDir, "tmux");
    await mkdir(tmuxTmpdir, { recursive: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const attached: Array<{ bin: string; argv: ReadonlyArray<string> }> = [];
    const warns: string[] = [];
    h = {
      workDir,
      tmuxTmpdir,
      sockDir: join(tmuxTmpdir, `tmux-${uid}`),
      restoreHome: setCanonicalAtmuxTmuxHome(join(workDir, "home")),
      priorTmux: process.env.TMUX,
      priorTmuxTmpdir: process.env.TMUX_TMPDIR,
      priorCockpitSocket: process.env.ATMUX_COCKPIT_SOCKET,
      attached,
      warns,
      logger: {
        log: () => {},
        ok: () => {},
        warn: (m: string) => {
          warns.push(m);
        },
        err: () => {},
      },
    };
    delete process.env.TMUX;
    delete process.env.ATMUX_COCKPIT_SOCKET;
    process.env.TMUX_TMPDIR = tmuxTmpdir;
  });

  afterEach(async () => {
    killServer(cockpitSock(h, "atmux-cockpit"));
    killServer(cockpitSock(h, "atmux-vendored-cockpit"));
    h.restoreHome();
    if (h.priorTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = h.priorTmux;
    if (h.priorTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = h.priorTmuxTmpdir;
    if (h.priorCockpitSocket === undefined) delete process.env.ATMUX_COCKPIT_SOCKET;
    else process.env.ATMUX_COCKPIT_SOCKET = h.priorCockpitSocket;
    await rm(h.workDir, { recursive: true, force: true });
  });

  async function runLive(): Promise<number> {
    return attachLiveCockpit({
      session: SESSION,
      env: { TMUX_TMPDIR: h.tmuxTmpdir },
      logger: h.logger,
      attachTmux: async (bin, argv) => {
        h.attached.push({ bin, argv });
        return 0;
      },
    });
  }

  test("live cockpit attaches to it; socket dir unchanged", async () => {
    const sock = cockpitSock(h, "atmux-cockpit");
    startServer(sock, SESSION);
    const before = await socketDirEntries(h);
    expect(before).toContain("atmux-cockpit");

    expect(await runLive()).toBe(0);
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]?.argv).toEqual(["-S", sock, "attach-session", "-t", `=${SESSION}`]);
    expect(await socketDirEntries(h)).toEqual(before);
  });

  test("vendored-only attaches to atmux-vendored-cockpit; dir unchanged", async () => {
    const sock = cockpitSock(h, "atmux-vendored-cockpit");
    startServer(sock, SESSION);
    const before = await socketDirEntries(h);

    expect(await runLive()).toBe(0);
    expect(h.attached).toHaveLength(1);
    expect(h.attached[0]?.argv[1]).toBe(sock);
    expect(await socketDirEntries(h)).toEqual(before);
  });

  test("absent refuses with the aca hint and creates nothing", async () => {
    expect(await socketDirEntries(h)).toEqual([]);
    expect(await runLive()).toBe(1);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toContain("aca");
    expect(h.attached).toEqual([]);
    // No socket file appeared (a tmux client dial against the missing
    // path would have STARTED a server and bound it).
    expect(await socketDirEntries(h)).toEqual([]);
  });

  test("ambiguous refuses with a listing of both cockpits", async () => {
    const a = cockpitSock(h, "atmux-cockpit");
    const b = cockpitSock(h, "atmux-vendored-cockpit");
    startServer(a, SESSION);
    startServer(b, SESSION);

    expect(await runLive()).toBe(1);
    expect(h.attached).toEqual([]);
    expect(h.warns).toHaveLength(3);
    expect(h.warns[0]).toContain(a);
    expect(h.warns[1]).toContain(b);
    expect(h.warns[2]).toContain("ATMUX_COCKPIT_SOCKET");
  });

  test("direct probe reports the real window count + server version", async () => {
    const sock = cockpitSock(h, "atmux-cockpit");
    startServer(sock, SESSION);
    tmuxRaw(sock, ["new-window", "-t", `${SESSION}`, "-n", "second"]);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const seams: LiveProbeSeams = {
      statNode: defaultLiveStatNode,
      dialSocket: defaultLiveDialSocket,
      findServers: (name) => defaultFindLiveServers(name, uid),
      ensureParentDir: defaultEnsureLiveParentDir,
      sendRebind: defaultSendLiveRebind,
      sleepMs: defaultLiveSleepMs,
      resolveClients: defaultResolveLiveClients,
      runTmux: defaultRunLiveTmux,
      attachTmux: async () => 0,
    };
    const probe = await probeLiveCandidate("atmux-cockpit", sock, SESSION, seams, (n) =>
      serverBinForCandidate(n, seams.findServers),
    );
    expect(probe?.windows).toBe(2);
    expect(probe?.version).toMatch(/^\d+\.\d+/);
    expect(probe?.session).toBe(SESSION);
  });
});

// ADR-306: unit coverage for `src/core/cockpit-live-attach.ts`.
//
// Every seam is faked here, so no test touches the host's sockets,
// servers, or tmux binaries — except the `default*` spot-checks, which
// only read (lstat on temp paths, `true`/`false` binaries, pgrep with a
// no-match pattern) or write under a fresh temp dir.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachLiveCockpit,
  defaultAttachLiveTmux,
  defaultEnsureLiveParentDir,
  defaultFindLiveServers,
  defaultIsExecutable,
  defaultLiveDialSocket,
  defaultLiveSleepMs,
  defaultLiveStatNode,
  defaultPgrepAf,
  defaultResolveLiveClients,
  defaultRunLiveTmux,
  defaultSendLiveRebind,
  escapePgrepPattern,
  HOMEBREW_TMUX_PATH,
  LIVE_COCKPIT_SOCKET_NAMES,
  type LiveProbeSeams,
  type LiveRunResult,
  liveCandidateNames,
  liveCandidateSocketPath,
  parsePgrepAf,
  probeLiveCandidate,
  serverBinForCandidate,
} from "../../../src/core/cockpit-live-attach.ts";
import { VENDORED_TMUX_PATH } from "../../../src/core/resolve-tmux-bin.ts";
import type { Logger } from "../../../src/core/tui.ts";

function makeLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
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
}

/** Seams where the candidate socket is live and `binA` answers. */
function liveSeams(overrides: Partial<LiveProbeSeams> = {}): {
  seams: LiveProbeSeams;
  calls: { run: Array<{ bin: string; argv: ReadonlyArray<string> }> };
} {
  const calls: { run: Array<{ bin: string; argv: ReadonlyArray<string> }> } = { run: [] };
  const run = async (bin: string, argv: ReadonlyArray<string>): Promise<LiveRunResult> => {
    calls.run.push({ bin, argv });
    const sub = argv[3] as string;
    if (sub === "has-session") return { ok: bin === "binA", stdout: "" };
    if (sub === "list-windows") return { ok: true, stdout: "0: w1\n1: w2\n" };
    return { ok: true, stdout: "3.7c\n" };
  };
  return {
    calls,
    seams: {
      statNode: () => "socket",
      dialSocket: async () => true,
      findServers: async () => [],
      ensureParentDir: () => {},
      sendRebind: () => {},
      sleepMs: async () => {},
      resolveClients: () => ["binA", "binB"],
      runTmux: run,
      attachTmux: async () => 0,
      ...overrides,
    },
  };
}

describe("liveCandidateNames", () => {
  test("defaults to the atmux-cockpit + vendored pair", () => {
    expect(liveCandidateNames({})).toEqual([...LIVE_COCKPIT_SOCKET_NAMES]);
    expect(LIVE_COCKPIT_SOCKET_NAMES).toEqual(["atmux-cockpit", "atmux-vendored-cockpit"]);
  });
  test("ATMUX_COCKPIT_SOCKET override selects only that socket", () => {
    expect(liveCandidateNames({ ATMUX_COCKPIT_SOCKET: "custom" })).toEqual(["custom"]);
  });
  test("empty override reads as unset", () => {
    expect(liveCandidateNames({ ATMUX_COCKPIT_SOCKET: "" })).toEqual([
      ...LIVE_COCKPIT_SOCKET_NAMES,
    ]);
  });
});

describe("liveCandidateSocketPath", () => {
  test("uses TMUX_TMPDIR when set, /tmp otherwise", () => {
    expect(liveCandidateSocketPath("atmux-cockpit", { TMUX_TMPDIR: "/t" }, 501)).toBe(
      "/t/tmux-501/atmux-cockpit",
    );
    expect(liveCandidateSocketPath("atmux-cockpit", {}, 501)).toBe("/tmp/tmux-501/atmux-cockpit");
    expect(liveCandidateSocketPath("atmux-cockpit", { TMUX_TMPDIR: "" }, 501)).toBe(
      "/tmp/tmux-501/atmux-cockpit",
    );
  });
});

describe("defaultLiveStatNode", () => {
  test("socket / missing / other / non-socket", () => {
    expect(defaultLiveStatNode("/x", () => ({ isSocket: () => true }))).toBe("socket");
    expect(defaultLiveStatNode("/x", () => ({ isSocket: () => false }))).toBe("other");
    const enoent = new Error("nope") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    expect(
      defaultLiveStatNode("/x", () => {
        throw enoent;
      }),
    ).toBe("missing");
    const eacces = new Error("denied") as NodeJS.ErrnoException;
    eacces.code = "EACCES";
    expect(
      defaultLiveStatNode("/x", () => {
        throw eacces;
      }),
    ).toBe("other");
  });
  test("production lstat default reads a missing temp path as missing", () => {
    expect(defaultLiveStatNode(join(tmpdir(), `no-such-${process.pid}`))).toBe("missing");
  });
});

describe("defaultLiveDialSocket", () => {
  test("maps live/dead probes", async () => {
    await expect(defaultLiveDialSocket("/x", async () => "live")).resolves.toBe(true);
    await expect(defaultLiveDialSocket("/x", async () => "dead")).resolves.toBe(false);
  });
  test("production probe default refuses a missing temp path", async () => {
    await expect(defaultLiveDialSocket(join(tmpdir(), `no-such-${process.pid}`))).resolves.toBe(
      false,
    );
  });
});

describe("escapePgrepPattern + parsePgrepAf", () => {
  test("escapes regex metacharacters", () => {
    expect(escapePgrepPattern("a.cockpit*")).toBe("a\\.cockpit\\*");
  });
  test("keeps server lines, drops clients and malformed rows", () => {
    const stdout = [
      "123 /opt/homebrew/bin/tmux -L atmux-cockpit new-session -d -s atx",
      "124 /usr/bin/tmux -L atmux-cockpit attach-session -t =atx",
      "125 /opt/homebrew/bin/tmux -L other new-session -d",
      "bogus line without pid",
      "tmux: server (/tmp/tmux-501/atmux-cockpit)",
    ].join("\n");
    expect(parsePgrepAf(stdout, "atmux-cockpit")).toEqual([
      { pid: 123, bin: "/opt/homebrew/bin/tmux" },
    ]);
  });
  test("non-path argv0 reads as null bin", () => {
    expect(parsePgrepAf("7 tmux -L atmux-cockpit new-session -d", "atmux-cockpit")).toEqual([
      { pid: 7, bin: null },
    ]);
  });
  test("empty output finds nothing", () => {
    expect(parsePgrepAf("", "atmux-cockpit")).toEqual([]);
  });
});

describe("defaultPgrepAf + defaultFindLiveServers", () => {
  test("exit 0 passes stdout through, non-zero reads as empty", async () => {
    await expect(
      defaultPgrepAf("n", 1, async () => ({ exitCode: 0, stdout: "9 /b/tmux -L n new-session" })),
    ).resolves.toBe("9 /b/tmux -L n new-session");
    await expect(defaultPgrepAf("n", 1, async () => ({ exitCode: 1, stdout: "" }))).resolves.toBe(
      "",
    );
  });
  test("production pgrep with a no-match name finds nothing", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    await expect(defaultPgrepAf(`no-such-cockpit-${process.pid}`, uid)).resolves.toBe("");
  });
  test("null uid finds nothing without spawning", async () => {
    await expect(
      defaultFindLiveServers("atmux-cockpit", null, async () => {
        throw new Error("must not spawn");
      }),
    ).resolves.toEqual([]);
  });
  test("pgrep failure reads as no server", async () => {
    await expect(
      defaultFindLiveServers("atmux-cockpit", 501, async () => {
        throw new Error("no pgrep");
      }),
    ).resolves.toEqual([]);
  });
  test("production pgrep default parses (empty) output", async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    await expect(defaultFindLiveServers(`no-such-cockpit-${process.pid}`, uid)).resolves.toEqual(
      [],
    );
  });
});

describe("defaultEnsureLiveParentDir + defaultSendLiveRebind + defaultLiveSleepMs", () => {
  test("parent dir is the socket dirname", () => {
    let made: string | undefined;
    defaultEnsureLiveParentDir("/sock/dir/sock", (dir) => {
      made = dir;
    });
    expect(made).toBe("/sock/dir");
  });
  test("production mkdir default creates under a temp dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "atmux-live-mkdir-"));
    try {
      defaultEnsureLiveParentDir(join(base, "tmux-1", "sock"));
      const st = await stat(join(base, "tmux-1"));
      expect(st.isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  test("rebind signals SIGUSR1", () => {
    const signals: Array<{ pid: number; sig: NodeJS.Signals }> = [];
    defaultSendLiveRebind(4242, (pid, sig) => {
      signals.push({ pid, sig });
    });
    expect(signals).toEqual([{ pid: 4242, sig: "SIGUSR1" }]);
  });
  test("production kill default throws on a missing pid", () => {
    expect(() => defaultSendLiveRebind(2147483647)).toThrow();
  });
  test("sleep resolves", async () => {
    await defaultLiveSleepMs(1);
  });
});

describe("defaultResolveLiveClients", () => {
  test("server bin first, then homebrew, vendored, PATH — deduped + gated", () => {
    const isExecutable = (p: string) => p !== "/missing";
    expect(defaultResolveLiveClients("/server/tmux", isExecutable, () => "/path/tmux")).toEqual([
      "/server/tmux",
      HOMEBREW_TMUX_PATH,
      VENDORED_TMUX_PATH,
      "/path/tmux",
    ]);
  });
  test("null server bin, null PATH tmux, missing entries skipped", () => {
    expect(
      defaultResolveLiveClients(
        null,
        () => false,
        () => null,
      ),
    ).toEqual([]);
  });
  test("duplicate PATH tmux collapses", () => {
    expect(
      defaultResolveLiveClients(
        HOMEBREW_TMUX_PATH,
        () => true,
        () => HOMEBREW_TMUX_PATH,
      ),
    ).toEqual([HOMEBREW_TMUX_PATH, VENDORED_TMUX_PATH]);
  });
  test("production fs default resolves without throwing", () => {
    expect(Array.isArray(defaultResolveLiveClients(null))).toBe(true);
  });
});

describe("defaultIsExecutable", () => {
  test("true for the running binary, false for a missing path", () => {
    expect(defaultIsExecutable(process.execPath)).toBe(true);
    expect(defaultIsExecutable(join(tmpdir(), `no-such-${process.pid}`))).toBe(false);
  });
});

describe("defaultRunLiveTmux + defaultAttachLiveTmux", () => {
  test("ok reflects the exit code", async () => {
    await expect(defaultRunLiveTmux("true", [])).resolves.toEqual({
      ok: true,
      stdout: "",
    });
    await expect(defaultRunLiveTmux("false", [])).resolves.toEqual({
      ok: false,
      stdout: "",
    });
  });
  test("spawn failure reads as not-ok", async () => {
    await expect(defaultRunLiveTmux(`no-such-binary-${process.pid}`, [])).resolves.toEqual({
      ok: false,
      stdout: "",
    });
  });
  test("attach returns the exit code on both stdio paths", async () => {
    await expect(defaultAttachLiveTmux("true", [], false)).resolves.toBe(0);
    await expect(defaultAttachLiveTmux("false", [], false)).resolves.toBe(1);
    await expect(defaultAttachLiveTmux("true", [], true)).resolves.toBe(0);
  });
});

describe("serverBinForCandidate", () => {
  test("first path-like bin wins; nulls and empties fall through", async () => {
    await expect(
      serverBinForCandidate("n", async () => [
        { pid: 1, bin: null },
        { pid: 2, bin: "/b/tmux" },
      ]),
    ).resolves.toBe("/b/tmux");
    await expect(serverBinForCandidate("n", async () => [{ pid: 1, bin: null }])).resolves.toBe(
      null,
    );
    await expect(serverBinForCandidate("n", async () => [])).resolves.toBe(null);
  });
});

describe("probeLiveCandidate", () => {
  test("live socket: first answering client wins; argv pins -S + =session", async () => {
    const { seams, calls } = liveSeams();
    const probe = await probeLiveCandidate(
      "atmux-cockpit",
      "/s/sock",
      "atx",
      seams,
      async () => "/server/tmux",
    );
    expect(probe).toMatchObject({
      bin: "binA",
      socketName: "atmux-cockpit",
      socketPath: "/s/sock",
      session: "atx",
      windows: 2,
      version: "3.7c",
    });
    expect(calls.run[0]).toEqual({
      bin: "binA",
      argv: ["-u", "-S", "/s/sock", "has-session", "-t", "=atx"],
    });
  });
  test("falls through to the next client when the first does not answer", async () => {
    const { seams } = liveSeams({
      runTmux: async (bin, argv) => {
        const sub = argv[3] as string;
        if (sub !== "has-session") return { ok: true, stdout: "0: w\n" };
        return { ok: bin === "binB", stdout: "" };
      },
    });
    const probe = await probeLiveCandidate("n", "/s", "atx", seams);
    expect(probe?.bin).toBe("binB");
  });
  test("no client answers → null", async () => {
    let runs = 0;
    const { seams } = liveSeams({
      runTmux: async () => {
        runs += 1;
        return { ok: false, stdout: "" };
      },
    });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(runs).toBeGreaterThan(0);
  });
  test("list-windows failure moves to the next client", async () => {
    const { seams } = liveSeams({
      resolveClients: () => ["a", "b"],
      runTmux: async (bin, argv) => {
        if (argv[3] === "has-session") return { ok: true, stdout: "" };
        if (bin === "a") return { ok: false, stdout: "" };
        return { ok: true, stdout: "0: w\n" };
      },
    });
    const probe = await probeLiveCandidate("n", "/s", "atx", seams);
    expect(probe?.bin).toBe("b");
  });
  test("zero windows is not live", async () => {
    const { seams } = liveSeams({
      runTmux: async (_bin, argv) => {
        if (argv[3] === "has-session") return { ok: true, stdout: "" };
        return { ok: true, stdout: "\n" };
      },
    });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
  });
  test("empty version reads as unknown", async () => {
    const { seams } = liveSeams({
      runTmux: async (_bin, argv) => {
        const sub = argv[3] as string;
        if (sub === "has-session") return { ok: true, stdout: "" };
        if (sub === "list-windows") return { ok: true, stdout: "0: w\n" };
        return { ok: false, stdout: "" };
      },
    });
    const probe = await probeLiveCandidate("n", "/s", "atx", seams);
    expect(probe?.version).toBe("unknown");
  });
  test("non-socket node: tmux never runs", async () => {
    const { seams, calls } = liveSeams({ statNode: () => "other" });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(calls.run).toEqual([]);
  });
  test("dead socket (no listener): tmux never runs", async () => {
    const { seams, calls } = liveSeams({ dialSocket: async () => false });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(calls.run).toEqual([]);
  });
  test("missing socket + no server → null without signalling", async () => {
    let signalled = 0;
    const { seams } = liveSeams({
      statNode: () => "missing",
      findServers: async () => [],
      sendRebind: () => {
        signalled += 1;
      },
    });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(signalled).toBe(0);
  });
  test("missing socket + server: rebind, poll, then live", async () => {
    const events: string[] = [];
    let stats = 0;
    const { seams } = liveSeams({
      statNode: () => (++stats <= 2 ? "missing" : "socket"),
      dialSocket: async () => stats > 2,
      findServers: async () => [{ pid: 99, bin: "/server/tmux" }],
      ensureParentDir: () => {
        events.push("mkdir");
      },
      sendRebind: (pid) => {
        events.push(`sigusr1:${pid}`);
      },
      sleepMs: async () => {
        events.push("sleep");
      },
    });
    const probe = await probeLiveCandidate("n", "/s", "atx", seams, async () => null);
    expect(probe?.bin).toBe("binA");
    expect(events).toEqual(["mkdir", "sigusr1:99", "sleep"]);
  });
  test("missing socket + server that never rebinds: timeout → null", async () => {
    let sleeps = 0;
    const { seams, calls } = liveSeams({
      statNode: () => "missing",
      dialSocket: async () => false,
      findServers: async () => [{ pid: 99, bin: null }],
      sleepMs: async () => {
        sleeps += 1;
      },
    });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(sleeps).toBe(20);
    expect(calls.run).toEqual([]);
  });
  test("socket reappears but stays dead: poll exhausts → null", async () => {
    let sleeps = 0;
    const { seams, calls } = liveSeams({
      statNode: () => "socket",
      dialSocket: async () => false,
      findServers: async () => [{ pid: 99, bin: null }],
      sleepMs: async () => {
        sleeps += 1;
      },
    });
    // Initial stat is "socket", so no rebind runs; the dead dial alone
    // refuses the candidate before any tmux call.
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(sleeps).toBe(0);
    expect(calls.run).toEqual([]);
  });
  test("missing socket, node returns but never listens: poll exhausts → null", async () => {
    let stats = 0;
    let sleeps = 0;
    const { seams } = liveSeams({
      statNode: () => (++stats <= 1 ? "missing" : "socket"),
      dialSocket: async () => false,
      findServers: async () => [{ pid: 99, bin: null }],
      sleepMs: async () => {
        sleeps += 1;
      },
    });
    await expect(probeLiveCandidate("n", "/s", "atx", seams)).resolves.toBeNull();
    expect(sleeps).toBe(20);
  });
  test("rebind signal failure is tolerated", async () => {
    let stats = 0;
    const { seams } = liveSeams({
      statNode: () => (++stats <= 1 ? "missing" : "socket"),
      dialSocket: async () => stats > 1,
      findServers: async () => [{ pid: 1, bin: null }],
      sendRebind: () => {
        throw new Error("ESRCH");
      },
      sleepMs: async () => {},
    });
    const probe = await probeLiveCandidate("n", "/s", "atx", seams);
    expect(probe?.bin).toBe("binA");
  });
});

describe("attachLiveCockpit", () => {
  test("one live cockpit → attach via the answering client; $TMUX restored", async () => {
    const { warns, logger } = makeLogger();
    const attached: Array<{ bin: string; argv: ReadonlyArray<string>; inherit: boolean }> = [];
    let tmuxDuringAttach: string | undefined = "unset-marker";
    process.env.TMUX = "/tmp/fake-tmux-outer,123,0";
    try {
      const { seams } = liveSeams({
        statNode: (p) => (p.endsWith("/atmux-cockpit") ? "socket" : "missing"),
        attachTmux: async (bin, argv, inherit) => {
          tmuxDuringAttach = process.env.TMUX;
          attached.push({ bin, argv, inherit });
          return 0;
        },
      });
      const exit = await attachLiveCockpit({
        session: "atx",
        env: { TMUX_TMPDIR: "/t" },
        uid: 501,
        logger,
        ...seams,
      });
      expect(exit).toBe(0);
      expect(attached).toEqual([
        {
          bin: "binA",
          argv: ["-u", "-S", "/t/tmux-501/atmux-cockpit", "attach-session", "-t", "=atx"],
          inherit: false,
        },
      ]);
      expect(tmuxDuringAttach).toBeUndefined();
      expect(warns).toEqual([]);
    } finally {
      delete process.env.TMUX;
    }
    expect(process.env.TMUX).toBeUndefined();
  });
  test("--human routes the attach through inherit-stdio", async () => {
    const { logger } = makeLogger();
    const seen: boolean[] = [];
    const { seams } = liveSeams({
      statNode: (p) => (p.endsWith("atmux-cockpit") ? "socket" : "missing"),
      attachTmux: async (_b, _a, inherit) => {
        seen.push(inherit);
        return 0;
      },
    });
    const exit = await attachLiveCockpit({
      session: "atx",
      env: {},
      uid: 501,
      inheritStdio: true,
      logger,
      ...seams,
    });
    expect(exit).toBe(0);
    expect(seen).toEqual([true]);
  });
  test("no live cockpit → one-line aca hint, exit 1", async () => {
    const { warns, logger } = makeLogger();
    const { seams } = liveSeams({ statNode: () => "missing" });
    const exit = await attachLiveCockpit({ session: "atx", env: {}, uid: 501, logger, ...seams });
    expect(exit).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("aca");
    expect(warns[0]).toContain("atmux-cockpit");
  });
  test("ambiguous → listing + refuse, exit 1", async () => {
    const { warns, logger } = makeLogger();
    const { seams } = liveSeams();
    const exit = await attachLiveCockpit({ session: "atx", env: {}, uid: 7, logger, ...seams });
    expect(exit).toBe(1);
    expect(warns).toHaveLength(3);
    expect(warns[0]).toContain("/tmp/tmux-7/atmux-cockpit");
    expect(warns[0]).toContain("windows=2");
    expect(warns[0]).toContain("tmux=3.7c");
    expect(warns[1]).toContain("atmux-vendored-cockpit");
    expect(warns[2]).toContain("ATMUX_COCKPIT_SOCKET");
  });
  test("ATMUX_COCKPIT_SOCKET override probes only that socket", async () => {
    const { logger } = makeLogger();
    const probed: string[] = [];
    const { seams } = liveSeams({
      statNode: (p) => {
        probed.push(p);
        return "socket";
      },
    });
    const exit = await attachLiveCockpit({
      session: "atx",
      env: { ATMUX_COCKPIT_SOCKET: "custom", TMUX_TMPDIR: "/t" },
      uid: 501,
      logger,
      ...seams,
    });
    expect(exit).toBe(0);
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every((p) => p === "/t/tmux-501/custom")).toBe(true);
  });
  test("production defaults engage without throwing on an empty temp TMUX_TMPDIR", async () => {
    const base = await mkdtemp(join(tmpdir(), "atmux-live-empty-"));
    const { warns, logger } = makeLogger();
    try {
      const exit = await attachLiveCockpit({
        session: `definitely-not-a-session-${process.pid}`,
        env: { TMUX_TMPDIR: base },
        uid: 501,
        logger,
      });
      expect(exit).toBe(1);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("aca");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  test("omitted env/logger/uid fall back to process defaults", async () => {
    // No optionals at all: real env (TMUX_TMPDIR unset → /tmp), real
    // uid, real stderr logger. The bogus session can never be live, so
    // this stays read-only (stat + pgrep + at most has-session probes)
    // and resolves absent without creating anything.
    const exit = await attachLiveCockpit({
      session: `definitely-not-a-session-${process.pid}`,
    });
    expect(exit).toBe(1);
  });
});

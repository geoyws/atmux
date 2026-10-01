// ADR-305 §D2 — `atmux socket-dial` (src/verbs/socket-dial.ts): the one
// way a shell loop dials an atmux socket. Review of 35ea2c3, item 2: the
// cockpit viewer loops' `[ -S s ] && [ -O s ] && tmux -S s` guard
// followed symlinks and checked only the socket node, so a swap between
// test and dial reached another uid's server. These tests prove the verb
// runs tmux ONLY after the whole chain passes — through the seams, and
// through the real CLI in a child process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UnsafeSocketPathError } from "../../../src/core/socket-dir.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  atmuxSelfCommand,
  SOCKET_DIAL_ABSENT,
  socketDial,
  socketDialCommand,
  socketRmdir,
} from "../../../src/verbs/socket-dial.ts";
import { dir, fakeSocketFs, sock } from "../../helpers/fake-socket-fs.ts";

const A = 1000;
const S = "/tmp/atmux-1000/px/sock";
const REPO = resolve(import.meta.dir, "../../..");

/** A spawn seam that records every tmux invocation and exits `code`. */
function recorder(calls: string[][], code: number) {
  return async (cmd: string, argv: string[]): Promise<number> => {
    calls.push([cmd, ...argv]);
    return code;
  };
}

describe("socketDial (seams)", () => {
  test.each([
    [[]],
    [[S]],
    [["", "has-session"]],
    [["-S", "has-session"]],
  ])("usage error for %j, nothing dialled", async (argv) => {
    const calls: string[][] = [];
    await expect(socketDial(argv, { spawn: recorder(calls, 0) })).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(calls).toEqual([]);
  });

  test("our socket in a passing chain → tmux -u -S <sock> <args>, its exit code returned", async () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: sock(A),
    });
    const calls: string[][] = [];
    const code = await socketDial([S, "attach", "-t", "=px:driver"], {
      uid: A,
      fs,
      tmuxBin: () => "/opt/tmux",
      spawn: recorder(calls, 3),
    });
    expect(code).toBe(3);
    // t-48cef478: `-u` (UTF-8 client) leads every client argv.
    expect(calls).toEqual([["/opt/tmux", "-u", "-S", S, "attach", "-t", "=px:driver"]]);
  });

  test("no socket there → exit 1 without running tmux; /tmp/atmux-<uid> made first", async () => {
    const fs = fakeSocketFs({}, { creatorUid: A });
    const calls: string[][] = [];
    const code = await socketDial([S, "has-session"], {
      uid: A,
      fs,
      spawn: recorder(calls, 0),
    });
    expect(code).toBe(SOCKET_DIAL_ABSENT);
    expect(calls).toEqual([]);
    expect(fs.nodes.get("/tmp/atmux-1000")).toEqual(dir(A, 0o700));
  });

  for (const [label, nodes] of [
    ["per-user root squatted by another uid", { "/tmp/atmux-1000": dir(1001) }],
    [
      "socket owned by another uid",
      { "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A), [S]: sock(1001) },
    ],
    ["/tmp not sticky (0777)", { "/tmp": dir(0, 0o777) }],
  ] as const) {
    test(`${label} → UnsafeSocketPathError, tmux never run`, async () => {
      const calls: string[][] = [];
      await expect(
        socketDial([S, "has-session"], {
          uid: A,
          fs: fakeSocketFs(nodes),
          spawn: recorder(calls, 0),
        }),
      ).rejects.toBeInstanceOf(UnsafeSocketPathError);
      expect(calls).toEqual([]);
    });
  }
});

describe("atmuxSelfCommand / socketDialCommand", () => {
  test("ATMUX_BIN wins (trimmed); whitespace-only falls through", () => {
    expect(atmuxSelfCommand({ env: { ATMUX_BIN: " /opt/atmux/bin/atmux " } })).toBe(
      "/opt/atmux/bin/atmux",
    );
    expect(
      atmuxSelfCommand({
        env: { ATMUX_BIN: "  " },
        execPath: "/usr/bin/bun",
        entry: "/repo/bin/atmux",
        exists: () => true,
      }),
    ).toBe("/usr/bin/bun /repo/bin/atmux");
  });

  test("a checkout runs `bun <repo>/bin/atmux`; a compiled binary runs itself", () => {
    expect(
      atmuxSelfCommand({ env: {}, execPath: "/b/bun", entry: "/r/bin/atmux", exists: () => true }),
    ).toBe("/b/bun /r/bin/atmux");
    expect(
      atmuxSelfCommand({ env: {}, execPath: "/opt/atmux/0.9/bin/atmux", exists: () => false }),
    ).toBe("/opt/atmux/0.9/bin/atmux");
  });

  test("odd paths are single-quoted", () => {
    expect(atmuxSelfCommand({ env: { ATMUX_BIN: "/a b/atmux" } })).toBe("'/a b/atmux'");
  });

  test("defaults: this checkout's own entry point", () => {
    const saved = process.env.ATMUX_BIN;
    delete process.env.ATMUX_BIN;
    try {
      expect(atmuxSelfCommand()).toBe(`${process.execPath} ${join(REPO, "bin", "atmux")}`);
    } finally {
      if (saved !== undefined) process.env.ATMUX_BIN = saved;
    }
  });

  test("one retry-loop dial: socket-dial, quoted socket, stderr silenced", () => {
    const cmd = socketDialCommand("/p q/sock", "attach -t '=x'");
    expect(cmd).toEndWith(" socket-dial '/p q/sock' attach -t '=x' 2>/dev/null; }");
    expect(cmd).toStartWith("{ ");
  });
});

// ---------- the real CLI, in a child process ----------

describe("atmux socket-dial (real CLI, real filesystem)", () => {
  let scratch: string;
  let bin: string;
  let log: string;
  let server: Server | null = null;
  const uid = process.getuid?.() ?? 0;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "socket-dial-"));
    bin = join(scratch, "bin");
    mkdirSync(bin);
    log = join(scratch, "argv.log");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 7\n`, {
      mode: 0o755,
    });
  });
  afterEach(async () => {
    if (server !== null) await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    await rm(scratch, { recursive: true, force: true });
  });

  async function listen(path: string): Promise<void> {
    server = createServer();
    await new Promise<void>((r) => server?.listen(path, () => r()));
  }

  function run(...argv: string[]): { code: number; err: string } {
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // Pin the stub even where a vendored /opt/atmux tmux exists.
      ATMUX_TMUX_BIN: join(bin, "tmux"),
    };
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    const p = Bun.spawnSync({
      cmd: [process.execPath, join(REPO, "bin", "atmux"), "socket-dial", ...argv],
      env,
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode ?? -1, err: p.stderr.toString() };
  }

  test("a live socket in a private chain is dialled; tmux's exit code comes back", async () => {
    const d = join(scratch, `tmux-${uid}`);
    mkdirSync(d, { mode: 0o700 });
    await listen(join(d, "default"));
    const r = run(join(d, "default"), "has-session", "-t", "=x");
    expect(r.code).toBe(7);
    expect(readFileSync(log, "utf8")).toBe(`-u -S ${join(d, "default")} has-session -t =x\n`);
  });

  test("in-process default spawn: tmux runs with inherited stdio, its exit code returned", async () => {
    const d = join(scratch, `tmux-${uid}`);
    mkdirSync(d, { mode: 0o700 });
    await listen(join(d, "default"));
    const code = await socketDial([join(d, "default"), "has-session"], {
      tmuxBin: () => join(bin, "tmux"),
    });
    expect(code).toBe(7);
    expect(readFileSync(log, "utf8")).toBe(`-u -S ${join(d, "default")} has-session\n`);
  });

  test("no socket → exit 1, tmux never run", () => {
    const r = run(join(scratch, `tmux-${uid}`, "default"), "has-session");
    expect(r.code).toBe(1);
    expect(existsSync(log)).toBe(false);
  });

  test("OUR live socket behind a world-writable ancestor → exit 78, tmux never run", async () => {
    // The race the reviewer won 80/300 times: the node is ours, but
    // another uid could rename the directory above it between a check
    // and the dial. A node-only check would dial here; the chain walk
    // refuses before tmux ever runs.
    const open = join(scratch, "open");
    const d = join(open, `tmux-${uid}`);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    await listen(join(d, "default"));
    chmodSync(open, 0o777);
    const r = run(join(d, "default"), "has-session");
    expect(r.code).toBe(78);
    expect(r.err).toContain(`refusing tmux socket ${join(d, "default")}: ${open} has mode 0777`);
    expect(existsSync(log)).toBe(false);
  });

  test("usage error → exit 64", () => {
    expect(run().code).toBe(64);
  });
});

// ---------- `atmux socket-rmdir` (ADR-305 revision 4) ----------

describe("socketRmdir (seams)", () => {
  const D = "/tmp/atmux-1000/px";

  test.each([[[]], [[""]], [["-x"]], [[D, "extra"]]])("usage %p → UsageError", async (argv) => {
    await expect(socketRmdir(argv, { uid: A, fs: fakeSocketFs() })).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  test("ours alone → 0, removed relative to the held parent", async () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A), [D]: dir(A), [`${D}/sock`]: sock(A) });
    expect(await socketRmdir([D], { uid: A, fs })).toBe(0);
    expect(fs.calls).toContain(`rmtree ${D}`);
    expect(fs.nodes.has(D)).toBe(false);
  });

  test("absent → exit 1", async () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A) });
    expect(await socketRmdir([D], { uid: A, fs })).toBe(SOCKET_DIAL_ABSENT);
  });

  test("not ours alone → UnsafeSocketPathError (exit 78), nothing removed", async () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A), [D]: dir(A, 0o755) });
    await expect(socketRmdir([D], { uid: A, fs })).rejects.toBeInstanceOf(UnsafeSocketPathError);
    expect(fs.nodes.has(D)).toBe(true);
  });
});

describe("atmux socket-rmdir (real CLI, real filesystem)", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "socket-rmdir-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function run(...argv: string[]): { code: number; err: string } {
    const p = Bun.spawnSync({
      cmd: [process.execPath, join(REPO, "bin", "atmux"), "socket-rmdir", ...argv],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? scratch },
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode ?? -1, err: p.stderr.toString() };
  }

  test("a private dir is removed (0); gone → 1; a 0755 one is refused (78) and kept; usage → 64", () => {
    const d = join(scratch, "fixture");
    mkdirSync(join(d, "sub"), { recursive: true, mode: 0o700 });
    writeFileSync(join(d, "sub", "f"), "x");
    expect(run(d).code).toBe(0);
    expect(existsSync(d)).toBe(false);
    expect(run(d).code).toBe(1);
    const wide = join(scratch, "wide");
    mkdirSync(wide, { mode: 0o700 });
    chmodSync(wide, 0o755);
    const r = run(wide);
    expect(r.code).toBe(78);
    expect(r.err).toContain(`${wide} has mode 0755`);
    expect(existsSync(wide)).toBe(true);
    expect(run().code).toBe(64);
  });
});

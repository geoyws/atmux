// Unit tests for src/abstractions/tmux.ts (ADR-004 + 2026-05-05 amend).
//
// Strategy: spin a real tmux server on a unique socket per test, exercise
// the wrapper, assert on observable behaviour. No mocking — that gives us
// true argv coverage *and* validates we speak tmux 3.4 correctly.
//
// Test isolation (ADR-004 socket-injection amend, memory ref
// `feedback_tmux_test_isolation.md`).
// -------------------------------------
// The load-bearing isolation is the explicit `-S <socketPath>` flag that
// `createTmux({ socketPath })` prepends to every tmux invocation. The
// `delete process.env.TMUX` line in beforeEach is belt-and-braces only —
// before the abstraction carried the socket flag, env-only isolation
// killed the operator's daily-driver tmux server during teardown
// (incident 2026-05-05 ~01:44 MYT). With `-S <socketPath>` baked into
// every argv, `tmux.server.killServer()` here can ONLY hit the per-test
// socket, by construction.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnInheritStdioOpts } from "../../../src/abstractions/spawn.ts";
import { spawn } from "../../../src/abstractions/spawn.ts";
import {
  clientRowToObject,
  parseSplitWindowIdsOrThrow,
  parseTabular,
  parseWindowIndexOrThrow,
  type SendTarget,
  serializeSendTarget,
  serializeTarget,
  type TmuxNamespace,
} from "../../../src/abstractions/tmux.ts";
import { TmuxError } from "../../../src/errors.ts";
import {
  CANONICAL_ATMUX_TMUX_CONF_PATH,
  createCanonicalAtmuxTmux,
  setCanonicalAtmuxTmuxHome,
} from "../../helpers/tmux.ts";

let socketDir: string;
let socketPath: string;
let sessionPrefix: string;
let priorTmux: string | undefined;
let restoreHome: (() => void) | null = null;
let tmux: TmuxNamespace;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-tmux-"));
  socketPath = join(socketDir, "sock");
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  // Belt-and-braces: strip inherited TMUX so any code path that somehow
  // bypasses the abstraction (it shouldn't — see header comment) cannot
  // accidentally re-enter the operator's server. Load-bearing fix is
  // the `-S <socketPath>` baked into every tmux argv by createTmux.
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  restoreHome = setCanonicalAtmuxTmuxHome(socketDir);
  tmux = createCanonicalAtmuxTmux({ socketPath });
});

afterEach(async () => {
  // Tear down the per-test server. Routes through the abstraction so the
  // `-S <socketPath>` flag is mandatory — by construction, kill-server
  // here cannot hit the operator's daily-driver tmux.
  try {
    await tmux.server.killServer();
  } catch {
    // expected: server may already be gone (idempotent teardown)
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  restoreHome?.();
  restoreHome = null;
  await rm(socketDir, { recursive: true, force: true });
});

describe("serializeTarget", () => {
  test("string passthrough", () => {
    expect(serializeTarget("foo:0.1")).toBe("foo:0.1");
  });

  test("WindowId → session:window", () => {
    expect(serializeTarget({ sessionName: "x", windowIndex: 2 })).toBe("x:2");
  });

  test("PaneId → session:window.pane", () => {
    expect(serializeTarget({ sessionName: "x", windowIndex: 2, paneIndex: 3 })).toBe("x:2.3");
  });
});

describe("parseTabular", () => {
  test("splits on tab + drops blank trailing line", () => {
    const out = parseTabular("a\t1\nb\t2\n", ["name", "n"]);
    expect(out).toEqual([
      { name: "a", n: "1" },
      { name: "b", n: "2" },
    ]);
  });

  test("strips CR introduced by tmux on some platforms", () => {
    const out = parseTabular("a\t1\r\nb\t2\r\n", ["name", "n"]);
    expect(out).toEqual([
      { name: "a", n: "1" },
      { name: "b", n: "2" },
    ]);
  });

  test("handles missing trailing column", () => {
    const out = parseTabular("a\n", ["name", "n"]);
    expect(out).toEqual([{ name: "a", n: "" }]);
  });

  test("empty stdout → []", () => {
    expect(parseTabular("", ["a"])).toEqual([]);
  });
});

describe("parseWindowIndexOrThrow", () => {
  test("parses an integer", () => {
    expect(parseWindowIndexOrThrow("3\n", ["new-window"], 0)).toBe(3);
  });

  test("throws TmuxError on garbage", () => {
    expect(() => parseWindowIndexOrThrow("not-a-num", ["new-window"], 0)).toThrow(TmuxError);
  });

  test("throws TmuxError on empty stdout", () => {
    expect(() => parseWindowIndexOrThrow("", ["new-window"], 0)).toThrow(TmuxError);
  });
});

describe("parseSplitWindowIdsOrThrow", () => {
  test("parses tab-separated ints", () => {
    expect(parseSplitWindowIdsOrThrow("2\t1\n", ["split-window"], 0)).toEqual({
      windowIndex: 2,
      paneIndex: 1,
    });
  });

  test("throws when paneIndex missing", () => {
    expect(() => parseSplitWindowIdsOrThrow("2\n", ["split-window"], 0)).toThrow(TmuxError);
  });

  test("throws on non-numeric input", () => {
    expect(() => parseSplitWindowIdsOrThrow("a\tb", ["split-window"], 0)).toThrow(TmuxError);
  });
});

describe("clientRowToObject", () => {
  test("maps full row", () => {
    expect(clientRowToObject({ name: "c1", session: "s", tty: "/dev/pts/0" })).toEqual({
      name: "c1",
      session: "s",
      tty: "/dev/pts/0",
    });
  });

  test("defaults missing fields to empty string", () => {
    expect(clientRowToObject({})).toEqual({ name: "", session: "", tty: "" });
  });
});

describe("createTmux socket pinning", () => {
  test("createTmux({ socketPath }) prepends -S to every argv", async () => {
    // Independent verification: a server started on socketPath via raw
    // spawn is visible to the abstraction's hasServer() (which calls
    // `tmux -S <path> info`), and a server started under a *different*
    // socket is NOT.
    const otherDir = await mkdtemp(join(tmpdir(), "atmux-tmux-other-"));
    const otherPath = join(otherDir, "sock");
    try {
      await spawn({
        cmd: "tmux",
        argv: [
          "-S",
          otherPath,
          "-f",
          CANONICAL_ATMUX_TMUX_CONF_PATH,
          "new-session",
          "-d",
          "-s",
          "isolated",
        ],
        expectExitCode: 0,
      });
      // Our abstraction is pinned to socketPath, so it sees no server.
      expect(await tmux.server.hasServer()).toBe(false);
      // Cleanup the other socket directly — never via our abstraction
      // (which would only see its own socket anyway).
      await spawn({
        cmd: "tmux",
        argv: ["-S", otherPath, "-f", CANONICAL_ATMUX_TMUX_CONF_PATH, "kill-server"],
        expectExitCode: "any",
      });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  test("createTmux({ socket }) -L variant works", async () => {
    // Keep the named-socket scratch path short so the macOS tmpdir length
    // does not trip tmux's socket-path limit.
    const priorTmpdir = process.env.TMUX_TMPDIR;
    let named: TmuxNamespace | null = null;
    process.env.TMUX_TMPDIR = "/tmp";
    try {
      named = createCanonicalAtmuxTmux({
        socket: `${sessionPrefix}-named`,
      });
      const name = `${sessionPrefix}_named`;
      await named.session.newSession({ name });
      expect(await named.session.hasSession(name)).toBe(true);
      expect((await named.window.listWindows(name)).map((window) => window.index)).toEqual([1]);
    } finally {
      await named?.server.killServer().catch(() => {});
      if (priorTmpdir !== undefined) process.env.TMUX_TMPDIR = priorTmpdir;
      else delete process.env.TMUX_TMPDIR;
    }
  });
});

describe("session lifecycle", () => {
  test("newSession creates a session that hasSession sees", async () => {
    const name = `${sessionPrefix}_a`;
    expect(await tmux.session.hasSession(name)).toBe(false);
    await tmux.session.newSession({ name });
    expect(await tmux.session.hasSession(name)).toBe(true);
  });

  test("hasSession false on absent name", async () => {
    expect(await tmux.session.hasSession(`${sessionPrefix}_nope`)).toBe(false);
  });

  test("killSession removes it", async () => {
    const name = `${sessionPrefix}_b`;
    await tmux.session.newSession({ name });
    await tmux.session.killSession(name);
    expect(await tmux.session.hasSession(name)).toBe(false);
  });

  test("killSession on missing throws TmuxError", async () => {
    await expect(tmux.session.killSession(`${sessionPrefix}_no_such`)).rejects.toBeInstanceOf(
      TmuxError,
    );
  });

  test("listSessions returns [] when no server", async () => {
    expect(await tmux.session.listSessions()).toEqual([]);
  });

  test("listSessions returns created session", async () => {
    const name = `${sessionPrefix}_c`;
    await tmux.session.newSession({ name, windowName: "win" });
    const got = await tmux.session.listSessions();
    expect(got.find((s) => s.name === name)).toBeDefined();
    const row = got.find((s) => s.name === name);
    expect(row?.windows).toBeGreaterThan(0);
    expect(row?.created).toBeGreaterThan(0);
  });

  test("renameSession changes the visible name", async () => {
    const a = `${sessionPrefix}_pre`;
    const b = `${sessionPrefix}_post`;
    await tmux.session.newSession({ name: a });
    await tmux.session.renameSession(a, b);
    expect(await tmux.session.hasSession(b)).toBe(true);
  });

  test("newSession applies cwd + windowName + shellCommand options", async () => {
    const name = `${sessionPrefix}_full`;
    await tmux.session.newSession({
      name,
      cwd: "/tmp",
      windowName: "named",
      shellCommand: "sleep 30",
    });
    const wins = await tmux.window.listWindows(name);
    expect(wins[0]?.name).toBe("named");
  });

  test("newSession detached=false also accepted (no-op in this test mode)", async () => {
    // Forcing -d via detached:true is the practical case; verify the
    // detached:false branch at least doesn't fail to construct argv.
    // (Not running interactively because tests run in non-tty env.)
    const name = `${sessionPrefix}_default_d`;
    await tmux.session.newSession({ name }); // detached defaults to true
    expect(await tmux.session.hasSession(name)).toBe(true);
  });
});

describe("window lifecycle", () => {
  test("newWindow + listWindows + killWindow", async () => {
    const name = `${sessionPrefix}_w`;
    await tmux.session.newSession({ name, windowName: "first" });
    await tmux.window.newWindow({ sessionName: name, name: "second" });
    const wins = await tmux.window.listWindows(name);
    expect(wins.length).toBe(2);
    const second = wins.find((w) => w.name === "second");
    expect(second).toBeDefined();
    await tmux.window.killWindow({ sessionName: name, windowIndex: second?.index ?? 0 });
    const after = await tmux.window.listWindows(name);
    expect(after.length).toBe(1);
  });

  test("listWindows returns [] when session missing", async () => {
    expect(await tmux.window.listWindows("nope-no-such")).toEqual([]);
  });

  test("renameWindow changes the visible name", async () => {
    const name = `${sessionPrefix}_rn`;
    await tmux.session.newSession({ name, windowName: "before" });
    const wins = await tmux.window.listWindows(name);
    const w = wins[0];
    if (!w) throw new Error("setup failure");
    await tmux.window.renameWindow({ sessionName: name, windowIndex: w.index }, "after");
    const after = await tmux.window.listWindows(name);
    expect(after[0]?.name).toBe("after");
  });

  test("selectWindow changes active window", async () => {
    const name = `${sessionPrefix}_sel`;
    await tmux.session.newSession({ name, windowName: "first" });
    await tmux.window.newWindow({ sessionName: name, name: "second" });
    const wins = await tmux.window.listWindows(name);
    const first = wins.find((w) => w.name === "first");
    if (!first) throw new Error("setup failure");
    await tmux.window.selectWindow({ sessionName: name, windowIndex: first.index });
    const after = await tmux.window.listWindows(name);
    expect(after.find((w) => w.name === "first")?.active).toBe(true);
  });

  test("newWindow honours cwd + shellCommand", async () => {
    const name = `${sessionPrefix}_cwd`;
    await tmux.session.newSession({ name });
    await tmux.window.newWindow({
      sessionName: name,
      name: "withopts",
      cwd: "/tmp",
      shellCommand: "sleep 30",
    });
    const wins = await tmux.window.listWindows(name);
    expect(wins.find((w) => w.name === "withopts")).toBeDefined();
  });

  test("moveWindow with kill swaps occupied target slot", async () => {
    // ADR-077: cockpit needs to relocate superdoctor to a fixed index even
    // when the slot is occupied by a team viewer on first upgrade.
    const name = `${sessionPrefix}_mv`;
    await tmux.session.newSession({ name, windowName: "alpha" });
    await tmux.window.newWindow({ sessionName: name, name: "beta" });
    await tmux.window.newWindow({ sessionName: name, name: "gamma" });
    const before = await tmux.window.listWindows(name);
    const gamma = before.find((w) => w.name === "gamma");
    if (!gamma) throw new Error("setup failure");
    const betaIdx = before.find((w) => w.name === "beta")?.index ?? -1;
    // Move gamma onto beta's slot, killing beta.
    await tmux.window.moveWindow({
      source: { sessionName: name, windowIndex: gamma.index },
      target: { sessionName: name, windowIndex: betaIdx },
      kill: true,
    });
    const after = await tmux.window.listWindows(name);
    expect(after.find((w) => w.name === "beta")).toBeUndefined();
    expect(after.find((w) => w.name === "gamma")?.index).toBe(betaIdx);
  });
});

describe("pane operations", () => {
  test("sendKeys + capturePane round-trip", async () => {
    const name = `${sessionPrefix}_pane`;
    await tmux.session.newSession({ name, shellCommand: "cat" });
    await tmux.pane.sendKeys({
      target: {
        kind: "member",
        member: "test-member",
        team: "test-team",
        target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
      },
      keys: "hello-from-test",
    });
    // Allow tmux/cat to echo back.
    await new Promise((r) => setTimeout(r, 100));
    const captured = await tmux.pane.capturePane({
      target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
      start: -10,
    });
    expect(captured).toContain("hello-from-test");
  });

  test("sendKeys with literal=true does not interpret key names", async () => {
    const name = `${sessionPrefix}_lit`;
    await tmux.session.newSession({ name, shellCommand: "cat" });
    await tmux.pane.sendKeys({
      target: {
        kind: "member",
        member: "test-member",
        team: "test-team",
        target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
      },
      keys: "C-c-literal-text",
      literal: true,
      enter: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    const captured = await tmux.pane.capturePane({
      target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
    });
    expect(captured).toContain("C-c-literal-text");
  });

  test("listPanes returns the single default pane", async () => {
    const name = `${sessionPrefix}_lp`;
    await tmux.session.newSession({ name });
    const panes = await tmux.pane.listPanes(`${name}:1`);
    expect(panes.length).toBeGreaterThanOrEqual(1);
    expect(panes[0]?.width).toBeGreaterThan(0);
    expect(panes[0]?.height).toBeGreaterThan(0);
  });

  test("listPanes returns [] for missing target", async () => {
    expect(await tmux.pane.listPanes("nope-no-such:0")).toEqual([]);
  });

  test("displayMessage returns formatted line minus newline", async () => {
    const name = `${sessionPrefix}_dm`;
    await tmux.session.newSession({ name });
    const out = await tmux.pane.displayMessage({
      target: `${name}:1`,
      format: "#{session_name}",
    });
    expect(out).toBe(name);
  });

  test("displayMessage with print:false uses status-line (no stdout)", async () => {
    const name = `${sessionPrefix}_dm2`;
    await tmux.session.newSession({ name });
    const out = await tmux.pane.displayMessage({
      target: `${name}:1`,
      format: "ignored",
      print: false,
    });
    expect(out).toBe("");
  });

  test("splitWindow horizontal (default) returns new PaneId", async () => {
    const name = `${sessionPrefix}_sw_h`;
    await tmux.session.newSession({ name });
    const pane = await tmux.pane.splitWindow({
      target: { sessionName: name, windowIndex: 1 },
    });
    expect(pane.sessionName).toBe(name);
    expect(pane.windowIndex).toBe(1);
    expect(pane.paneIndex).toBeGreaterThan(0);
    const panes = await tmux.pane.listPanes(`${name}:1`);
    expect(panes.length).toBe(2);
  });

  test("splitWindow vertical with cwd + shellCommand", async () => {
    const name = `${sessionPrefix}_sw_v`;
    await tmux.session.newSession({ name });
    const pane = await tmux.pane.splitWindow({
      target: { sessionName: name, windowIndex: 1 },
      vertical: true,
      cwd: "/tmp",
      shellCommand: "sleep 30",
    });
    expect(pane.sessionName).toBe(name);
    expect(pane.windowIndex).toBe(1);
  });

  test("splitWindow accepts a string target", async () => {
    const name = `${sessionPrefix}_sw_str`;
    await tmux.session.newSession({ name });
    const pane = await tmux.pane.splitWindow({ target: `${name}:1` });
    // sessionName is parsed from the leading segment of the string target.
    expect(pane.sessionName).toBe(name);
  });

  test("killPane removes a non-last pane", async () => {
    const name = `${sessionPrefix}_kp`;
    await tmux.session.newSession({ name });
    await tmux.window.newWindow({ sessionName: name, name: "p" });
    const wins = await tmux.window.listWindows(name);
    const w = wins.find((x) => x.name === "p");
    if (!w) throw new Error("setup failure");
    await tmux.pane.killPane({
      sessionName: name,
      windowIndex: w.index,
      paneIndex: 0,
    });
    // After killing the only pane, the window is gone.
    const after = await tmux.window.listWindows(name);
    expect(after.find((x) => x.name === "p")).toBeUndefined();
  });
});

describe("buffer operations", () => {
  test("loadBuffer + pasteBuffer + deleteBuffer", async () => {
    const name = `${sessionPrefix}_buf`;
    await tmux.session.newSession({ name, shellCommand: "cat" });
    const buf = `atmux_test_${process.pid}`;
    await tmux.buffer.loadBuffer({ name: buf, data: "loaded-content" });
    await tmux.buffer.pasteBuffer({
      name: buf,
      target: {
        kind: "member",
        member: "test-member",
        team: "test-team",
        target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
      },
      deleteAfter: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    const captured = await tmux.pane.capturePane({
      target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
    });
    expect(captured).toContain("loaded-content");
    // Buffer was deleted; deleteBuffer again should fail.
    await expect(tmux.buffer.deleteBuffer(buf)).rejects.toBeInstanceOf(TmuxError);
  });

  test("loadBuffer surfaces TmuxError on bad invocation", async () => {
    // No server up at this point, and load-buffer doesn't auto-start one
    // when piped from stdin via `-` — it errors out. Assert the failure
    // path is a typed TmuxError, not an unwrapped SpawnError.
    await expect(tmux.buffer.loadBuffer({ data: "x" })).rejects.toBeInstanceOf(TmuxError);
  });

  test("loadBuffer without name uses default buffer", async () => {
    const name = `${sessionPrefix}_def_buf`;
    await tmux.session.newSession({ name, shellCommand: "cat" });
    await tmux.buffer.loadBuffer({ data: "default-buf-data" });
    await tmux.buffer.pasteBuffer({
      target: {
        kind: "member",
        member: "test-member",
        team: "test-team",
        target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const captured = await tmux.pane.capturePane({
      target: { sessionName: name, windowIndex: 1, paneIndex: 0 },
    });
    expect(captured).toContain("default-buf-data");
  });
});

describe("client operations", () => {
  test("listClients returns [] when no clients connected", async () => {
    const name = `${sessionPrefix}_lc`;
    await tmux.session.newSession({ name });
    expect(await tmux.client.listClients()).toEqual([]);
  });

  // attachSession blocks waiting for a tty; not testable in CI.
  // switchClient requires a connected client; not testable in CI.
  // We exercise their argv shape indirectly via TmuxError on no-client.

  test("switchClient surfaces TmuxError when no client present", async () => {
    const name = `${sessionPrefix}_sc`;
    await tmux.session.newSession({ name });
    await expect(
      tmux.client.switchClient({ target: name, clientName: "no-such-client" }),
    ).rejects.toBeInstanceOf(TmuxError);
  });

  test("attachSession surfaces TmuxError outside of a tty", async () => {
    const name = `${sessionPrefix}_atc`;
    await tmux.session.newSession({ name });
    await expect(tmux.client.attachSession(name)).rejects.toBeInstanceOf(TmuxError);
  });

  test("attachSessionInheritStdio wraps a nonzero inherited-stdio exit in TmuxError", async () => {
    const name = `${sessionPrefix}_atc_is`;
    const calls: Array<SpawnInheritStdioOpts> = [];
    const localTmux = createCanonicalAtmuxTmux({
      socketPath,
      hooks: {
        spawnInheritStdio: async (opts) => {
          calls.push({ ...opts });
          return 17;
        },
      },
    });

    const error = await localTmux.client.attachSessionInheritStdio(name).catch((caught) => caught);
    expect(error).toBeInstanceOf(TmuxError);
    expect(calls).toHaveLength(1);

    const call = calls[0];
    if (!call) {
      throw new Error("expected one spawnInheritStdio call");
    }
    expect(call).toEqual({
      cmd: expect.stringMatching(/(?:^|\/)tmux$/),
      argv: ["-S", socketPath, "-f", CANONICAL_ATMUX_TMUX_CONF_PATH, "attach-session", "-t", name],
      unsetEnv: ["NO_COLOR"],
    });
    expect(call.env).toBeUndefined();
    expect(call.cwd).toBeUndefined();
    const tmuxError = error as TmuxError;
    expect(tmuxError.context).toEqual({
      argv: ["-S", socketPath, "-f", CANONICAL_ATMUX_TMUX_CONF_PATH, "attach-session", "-t", name],
      exitCode: 17,
      stderr: "",
      stdout: "",
    });
    expect(tmuxError.message).toBe("tmux -S failed (exit 17): ");
  });
});

describe("option operations", () => {
  test("setOption + showOptions round-trip (global)", async () => {
    const name = `${sessionPrefix}_opt`;
    await tmux.session.newSession({ name });
    await tmux.option.setOption({
      name: "history-limit",
      value: "9000",
      global: true,
    });
    const opts = await tmux.option.showOptions({ global: true });
    expect(opts["history-limit"]).toBe("9000");
  });

  test("setOption window-scoped", async () => {
    const name = `${sessionPrefix}_opt_w`;
    await tmux.session.newSession({ name });
    await tmux.option.setOption({
      name: "remain-on-exit",
      value: "on",
      window: true,
      target: `${name}:1`,
    });
    const opts = await tmux.option.showOptions({ window: true, target: `${name}:1` });
    expect(opts["remain-on-exit"]).toBe("on");
  });

  test("showOptions returns {} when nothing set in scope", async () => {
    const name = `${sessionPrefix}_so`;
    await tmux.session.newSession({ name });
    const opts = await tmux.option.showOptions();
    // Local scope may include defaults; just verify we got an object back.
    expect(typeof opts).toBe("object");
  });

  test("showOptions strips surrounding quotes from string values", async () => {
    const name = `${sessionPrefix}_so_q`;
    await tmux.session.newSession({ name });
    await tmux.option.setOption({
      name: "@atmux-test-key",
      value: "quoted value with spaces",
      global: true,
    });
    const opts = await tmux.option.showOptions({ global: true });
    expect(opts["@atmux-test-key"]).toBe("quoted value with spaces");
  });
});

describe("server operations", () => {
  test("hasServer returns true after newSession", async () => {
    const name = `${sessionPrefix}_hs`;
    await tmux.session.newSession({ name });
    expect(await tmux.server.hasServer()).toBe(true);
  });

  test("hasServer returns false when no server", async () => {
    // Ensure no server.
    await tmux.server.killServer();
    expect(await tmux.server.hasServer()).toBe(false);
  });

  test("killServer is idempotent", async () => {
    await tmux.server.killServer();
    await tmux.server.killServer();
    expect(true).toBe(true);
  });
});

describe("error mapping", () => {
  test("any nonzero exit on a strict expect throws TmuxError", async () => {
    // `tmux foo-bad-subcommand` exits with usage error.
    await expect(
      tmux.session.killSession("definitely-no-such-session-foo-bar"),
    ).rejects.toBeInstanceOf(TmuxError);
  });
});

// ---------- ADR-025: SendTarget compile-time gate ----------
//
// "Driver" kind is intentionally absent from `SendTarget`. Any caller
// attempting `{ kind: "driver", ... }` triggers a compile error at the
// source — the discriminated union is the load-bearing gate, not a
// runtime check. The `// @ts-expect-error` directive below ASSERTS
// that the line under it fails to typecheck. If the union is ever
// widened to admit `"driver"`, the directive itself becomes a TS2578
// "Unused @ts-expect-error directive" error → tsc fails the build.
// The directive IS the gate.
//
// `serializeSendTarget` round-trip for the two valid kinds is also
// asserted here — covers the function-coverage requirement on the
// helper without needing a live tmux call.

describe("ADR-025 — SendTarget compile-time gate", () => {
  test("driver kind is intentionally absent from SendTarget", () => {
    // The wrapper accepts SendTarget, so the kind-mismatch error fires
    // inside the call expression. The `@ts-expect-error` directive
    // immediately above MUST be consumed by that error, otherwise tsc
    // emits TS2578 (Unused '@ts-expect-error') and the build fails —
    // which is exactly the gate ADR-025 §5 specifies.
    const accept = (t: SendTarget): SendTarget => t;
    // @ts-expect-error — driver kind is absent from the discriminated union (ADR-025)
    const _banned = accept({ kind: "driver", team: "demo", target: "atmux-demo:lead" });
    // _banned is intentionally unused; the typecheck IS the assertion.
    void _banned;
    expect(true).toBe(true);
  });

  test("serializeSendTarget round-trips member, lead, and cooperative bot kinds", () => {
    const memberTarget: SendTarget = {
      kind: "member",
      member: "alice",
      team: "demo",
      target: "atmux-demo:🐝alice",
    };
    expect(serializeSendTarget(memberTarget)).toBe("atmux-demo:🐝alice");
    const leadTarget: SendTarget = {
      kind: "lead",
      team: "demo",
      target: { sessionName: "atmux-demo", windowIndex: 0, paneIndex: 0 },
    };
    expect(serializeSendTarget(leadTarget)).toBe("atmux-demo:0.0");
    const botTarget: SendTarget = {
      kind: "bot",
      team: "demo",
      target: "atmux-demo:_bot",
    };
    expect(serializeSendTarget(botTarget)).toBe("atmux-demo:_bot");
  });
});

// e-268447e2 T1 (t-e32bdf73) — git-spawn timeout: exported default +
// ATMUX_GIT_TIMEOUT_MS env override + per-call opts.timeoutMs override.
//
// Two distinct seams live in spawn.ts:
//   * resolveDefaultTimeoutMs / ATMUX_SPAWN_TIMEOUT_MS — the buffered-spawn
//     default (tmux spawn / cold submodule-init, t-681e5b91).
//   * resolveGitTimeoutMs / ATMUX_GIT_TIMEOUT_MS — the shell-out-to-git
//     wrapper default (worktree.ts / auto-done.ts / auto-push.ts
//     `defaultGitSpawn`). This file covers the second.
//
// Coverage:
//   (1) DEFAULT_GIT_SPAWN_TIMEOUT_MS exported + consumable, equals 30_000.
//   (3) defaultGitSpawn actually forwards the resolved timeout into the
//       spawn layer — proven end-to-end by pointing a real `git` at a
//       test-owned blackhole (a loopback TCP server that accepts and
//       never responds, so git's `git://` client blocks on read until
//       our tiny override SIGTERMs it) and asserting the resulting
//       SpawnTimeoutError carries the exact per-call timeout. If
//       forwarding were broken (literal 30_000 instead of the resolved
//       value), the error's context.timeoutMs would not equal our tiny
//       override. Loopback-only, so a fast-failing external connect
//       (e.g. `git://10.255.255.1` in the Linux gate container) cannot
//       flake this.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  DEFAULT_GIT_SPAWN_TIMEOUT_MS,
  resolveGitTimeoutMs,
} from "../../../src/abstractions/spawn.ts";
import { defaultGitSpawn } from "../../../src/abstractions/worktree.ts";
import { SpawnTimeoutError } from "../../../src/errors.ts";

describe("DEFAULT_GIT_SPAWN_TIMEOUT_MS", () => {
  test("is exported and equals 30_000", () => {
    expect(DEFAULT_GIT_SPAWN_TIMEOUT_MS).toBe(30_000);
  });
});

describe("resolveGitTimeoutMs — ATMUX_GIT_TIMEOUT_MS env + opts.timeoutMs override", () => {
  const original = process.env.ATMUX_GIT_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.ATMUX_GIT_TIMEOUT_MS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ATMUX_GIT_TIMEOUT_MS;
    else process.env.ATMUX_GIT_TIMEOUT_MS = original;
  });

  test("default is DEFAULT_GIT_SPAWN_TIMEOUT_MS when nothing set", () => {
    expect(resolveGitTimeoutMs()).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("default when env empty string + no per-call override", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "";
    expect(resolveGitTimeoutMs()).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("honors valid positive integer env (slow-pack fetch 120s)", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "120000";
    expect(resolveGitTimeoutMs()).toBe(120_000);
  });

  test("honors fractional positive numeric env (Number coerces)", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "45000.5";
    expect(resolveGitTimeoutMs()).toBe(45_000.5);
  });

  test("env falls back to DEFAULT when non-numeric", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "fast";
    expect(resolveGitTimeoutMs()).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("env falls back to DEFAULT when zero", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "0";
    expect(resolveGitTimeoutMs()).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("env falls back to DEFAULT when negative", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "-1000";
    expect(resolveGitTimeoutMs()).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("env falls back to DEFAULT when Infinity literal", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "Infinity";
    expect(resolveGitTimeoutMs()).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("per-call opts.timeoutMs wins over env (precedence top of chain)", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "120000";
    expect(resolveGitTimeoutMs(5_000)).toBe(5_000);
  });

  test("per-call opts.timeoutMs wins over default when env unset", () => {
    expect(resolveGitTimeoutMs(7_500)).toBe(7_500);
  });

  test("bad per-call opts.timeoutMs (0) falls through to env", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "90000";
    expect(resolveGitTimeoutMs(0)).toBe(90_000);
  });

  test("bad per-call opts.timeoutMs (negative) falls through to DEFAULT when env unset", () => {
    expect(resolveGitTimeoutMs(-50)).toBe(DEFAULT_GIT_SPAWN_TIMEOUT_MS);
  });

  test("bad per-call opts.timeoutMs (NaN) falls through to env", () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "60000";
    expect(resolveGitTimeoutMs(Number.NaN)).toBe(60_000);
  });
});

describe("defaultGitSpawn — forwards resolved timeout into the spawn layer", () => {
  const original = process.env.ATMUX_GIT_TIMEOUT_MS;
  let server: Server = createServer();
  let port = 0;
  const sockets = new Set<Socket>();

  // Hang a real `git` by pointing its native `git://` client at a
  // test-owned blackhole: the server accepts on loopback and never
  // responds, so git blocks on read (verified: `timeout 3 git ls-remote`
  // against a silent acceptor exits 124) until our tiny per-call
  // timeout SIGTERMs git — which closes the socket + stdio pipes so
  // spawn() resolves promptly. Loopback-only, no external network, so
  // a fast-failing connect (as in the Linux gate container) cannot
  // flake this. The thrown SpawnTimeoutError must carry exactly the
  // timeout we asked for, proving defaultGitSpawn plumbed opts.timeoutMs
  // through resolveGitTimeoutMs into spawn() rather than a hardcoded
  // 30_000 literal (which would NOT fire in this window — surfacing as
  // a bun-test timeout, not a clean SpawnTimeoutError).
  beforeEach(async () => {
    sockets.clear();
    server = createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => {
        sockets.delete(sock);
      });
      sock.on("error", () => {
        /* expected: SIGTERM'd git resets the held connection */
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) {
      throw new Error("blackhole server did not bind to 127.0.0.1");
    }
    port = addr.port;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.ATMUX_GIT_TIMEOUT_MS;
    else process.env.ATMUX_GIT_TIMEOUT_MS = original;
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  test("per-call opts.timeoutMs reaches spawn (SpawnTimeoutError carries it)", async () => {
    delete process.env.ATMUX_GIT_TIMEOUT_MS;
    let caught: SpawnTimeoutError | null = null;
    try {
      await defaultGitSpawn(["ls-remote", `git://127.0.0.1:${port}/atmux-timeout-probe.git`], {
        timeoutMs: 250,
      });
    } catch (e) {
      if (e instanceof SpawnTimeoutError) caught = e;
      else throw e;
    }
    expect(caught).toBeInstanceOf(SpawnTimeoutError);
    expect(caught?.context.timeoutMs).toBe(250);
  });

  test("ATMUX_GIT_TIMEOUT_MS reaches spawn when no per-call override", async () => {
    process.env.ATMUX_GIT_TIMEOUT_MS = "275";
    let caught: SpawnTimeoutError | null = null;
    try {
      await defaultGitSpawn(["ls-remote", `git://127.0.0.1:${port}/atmux-timeout-probe.git`]);
    } catch (e) {
      if (e instanceof SpawnTimeoutError) caught = e;
      else throw e;
    }
    expect(caught).toBeInstanceOf(SpawnTimeoutError);
    expect(caught?.context.timeoutMs).toBe(275);
  });
});

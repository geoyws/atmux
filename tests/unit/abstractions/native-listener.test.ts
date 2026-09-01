// Unit tests for src/abstractions/native-listener.ts (atmux-listener
// Rust subprocess spawner).
//
// Strategy: inject a fake spawn fn that returns canned stdout streams
// + observable kill counter. The real subprocess is exercised by the
// end-to-end smoke test in tests/integration/native-listener-e2e.test.ts
// (when the binary is present on disk).

import { describe, expect, test } from "bun:test";
import {
  defaultNativeSpawn,
  type NativeSpawnFn,
  resolveDefaultListenerBinary,
  spawnNativeListener,
} from "../../../src/abstractions/native-listener.ts";

// Synthesize a NativeSpawnFn whose stdout yields a fixed list of lines,
// with optional delay between them. `kill` flips an observable flag.
function fakeSpawn(
  lines: ReadonlyArray<string>,
  opts: { delayMs?: number; exitCode?: number; killThrows?: boolean } = {},
): { spawn: NativeSpawnFn; killed: { value: boolean }; killCalls: { value: number } } {
  const killed = { value: false };
  const killCalls = { value: 0 };
  const spawn: NativeSpawnFn = () => {
    const stdout = (async function* () {
      // `defaultNativeSpawn` returns an AsyncIterable<string> where each
      // yielded string is ONE line with the trailing `\n` stripped (per
      // lineStream's contract). Fakes mirror that — yield bare lines.
      for (const line of lines) {
        if (killed.value) return;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield line;
      }
    })();
    return {
      stdout,
      kill: () => {
        killed.value = true;
        killCalls.value += 1;
        if (opts.killThrows) throw new Error("kill failed");
      },
      onExit: new Promise((resolve) =>
        setTimeout(
          () => resolve({ code: opts.exitCode ?? 0, signal: null }),
          (lines.length + 1) * (opts.delayMs ?? 0) + 50,
        ),
      ),
    };
  };
  return { spawn, killed, killCalls };
}

type NativeChildProcessLike = {
  stdout: (AsyncIterable<string> & { setEncoding: (encoding: string) => void }) | null;
  stdin: { end: () => void } | null;
  killed: boolean;
  kill: (signal: NodeJS.Signals) => void;
  once: (
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ) => unknown;
};

function makeNativeChild(
  chunks: ReadonlyArray<string> | null,
  opts: {
    delayMs?: number;
    exitCode?: number;
    exitSignal?: NodeJS.Signals | null;
    killed?: boolean;
    returnRejects?: boolean;
    killThrows?: boolean;
  } = {},
): {
  child: NativeChildProcessLike;
  stats: { setEncoding: string[]; stdinEnds: number; killSignals: NodeJS.Signals[] };
  emitExit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  emitError: (error: Error) => void;
} {
  const stats = { setEncoding: [] as string[], stdinEnds: 0, killSignals: [] as NodeJS.Signals[] };
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  let errorListener: ((error: Error) => void) | null = null;
  let iteratorDone = false;

  const child: NativeChildProcessLike = {
    stdout:
      chunks === null
        ? null
        : {
            setEncoding: (encoding: string) => {
              stats.setEncoding.push(encoding);
            },
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                next: async () => {
                  if (iteratorDone) {
                    return { done: true, value: undefined };
                  }
                  if (index >= chunks.length) {
                    iteratorDone = true;
                    exitListener?.(opts.exitCode ?? 0, opts.exitSignal ?? null);
                    return { done: true, value: undefined };
                  }
                  const value = chunks[index++] as string;
                  if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
                  return { done: false, value };
                },
                return: async () => {
                  iteratorDone = true;
                  if (opts.returnRejects) {
                    throw new Error("cleanup return failed");
                  }
                  return { done: true, value: undefined };
                },
                [Symbol.asyncIterator]() {
                  return this;
                },
              };
            },
          },
    stdin: {
      end: () => {
        stats.stdinEnds += 1;
      },
    },
    killed: opts.killed ?? false,
    kill: (signal: NodeJS.Signals) => {
      stats.killSignals.push(signal);
      child.killed = true;
      if (opts.killThrows) {
        throw new Error("kill failed");
      }
    },
    once: (
      event: "exit" | "error",
      listener:
        | ((code: number | null, signal: NodeJS.Signals | null) => void)
        | ((error: Error) => void),
    ) => {
      if (event === "exit") {
        exitListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
      } else {
        errorListener = listener as (error: Error) => void;
      }
      return child;
    },
  };

  const emitExit = (
    code: number | null = opts.exitCode ?? 0,
    signal: NodeJS.Signals | null = opts.exitSignal ?? null,
  ) => {
    exitListener?.(code, signal);
  };
  const emitError = (error: Error) => {
    errorListener?.(error);
  };

  if (chunks === null) queueMicrotask(() => emitExit());

  return {
    child,
    stats,
    emitExit,
    emitError,
  };
}

describe("spawnNativeListener", () => {
  test("filters out the 'ready' handshake — only event lines yielded", async () => {
    const { spawn } = fakeSpawn([
      "ready",
      "honker:stream:task.done\tnew",
      "honker:stream:task.done\tnew",
    ]);
    const handle = spawnNativeListener({
      binaryPath: "/fake/atmux-listener",
      dbPath: "/fake/state.db",
      channel: "honker:stream:task.done",
      spawn,
    });
    const collected: string[] = [];
    for await (const line of handle.signals) {
      collected.push(line);
      if (collected.length >= 2) break;
    }
    expect(collected).toEqual(["honker:stream:task.done\tnew", "honker:stream:task.done\tnew"]);
    handle.stop();
  });

  test("throws immediately when spawn fails", () => {
    expect(() =>
      spawnNativeListener({
        binaryPath: "/fake/atmux-listener",
        dbPath: "/fake/state.db",
        channel: "honker:stream:task.done",
        spawn: () => {
          throw new Error("spawn failed");
        },
      }),
    ).toThrow("spawn failed");
  });

  test("onDiagnostic fires when 'ready' is observed", async () => {
    const { spawn } = fakeSpawn(["ready", "honker:stream:task.done\tnew"]);
    const diagnostics: string[] = [];
    const handle = spawnNativeListener({
      binaryPath: "/fake/atmux-listener",
      dbPath: "/fake/state.db",
      channel: "honker:stream:task.done",
      spawn,
      onDiagnostic: (msg) => diagnostics.push(msg),
    });
    for await (const line of handle.signals) {
      if (line.includes("task.done")) break;
    }
    expect(diagnostics.some((d) => d.includes("ready"))).toBe(true);
    handle.stop();
  });

  test("diagnostic sink failures are ignored", async () => {
    const { spawn } = fakeSpawn(["ready", "honker:stream:task.done\tnew"]);
    const handle = spawnNativeListener({
      binaryPath: "/fake/atmux-listener",
      dbPath: "/fake/state.db",
      channel: "honker:stream:task.done",
      spawn,
      onDiagnostic: () => {
        throw new Error("diag failed");
      },
    });
    const collected: string[] = [];
    for await (const line of handle.signals) {
      collected.push(line);
      break;
    }
    expect(collected).toEqual(["honker:stream:task.done\tnew"]);
    handle.stop();
  });

  test("stop() invokes kill, terminating the stream", async () => {
    const { spawn, killed, killCalls } = fakeSpawn(["ready", "a", "b", "c"], { delayMs: 100 });
    const handle = spawnNativeListener({
      binaryPath: "/fake",
      dbPath: "/db",
      channel: "ch",
      spawn,
    });
    // Drain one line then stop
    const iter = handle.signals[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    handle.stop();
    expect(killed.value).toBe(true);
    expect(killCalls.value).toBe(1);
  });

  test("returning from the signals iterator kills the subprocess once", async () => {
    const { spawn, killCalls } = fakeSpawn(["ready", "a", "b"], { delayMs: 25 });
    const handle = spawnNativeListener({
      binaryPath: "/fake",
      dbPath: "/db",
      channel: "ch",
      spawn,
    });
    const iter = handle.signals[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    await iter.return?.();
    expect(killCalls.value).toBe(1);
    handle.stop();
    expect(killCalls.value).toBe(1);
  });

  test("stop() swallows kill failures", async () => {
    const { spawn, killCalls } = fakeSpawn(["ready", "a"], { killThrows: true });
    const handle = spawnNativeListener({
      binaryPath: "/fake",
      dbPath: "/db",
      channel: "ch",
      spawn,
    });
    expect(() => handle.stop()).not.toThrow();
    expect(killCalls.value).toBe(1);
  });

  test("non-zero exit still resolves cleanly", async () => {
    const { spawn } = fakeSpawn(["ready", "honker:stream:task.done\tnew"], { exitCode: 17 });
    const handle = spawnNativeListener({
      binaryPath: "/fake",
      dbPath: "/db",
      channel: "ch",
      spawn,
    });
    const collected: string[] = [];
    for await (const line of handle.signals) {
      collected.push(line);
    }
    expect(collected).toEqual(["honker:stream:task.done\tnew"]);
    const exit = await handle.exited;
    expect(exit.code).toBe(17);
  });

  test("empty stream — generator ends cleanly", async () => {
    const { spawn } = fakeSpawn([]);
    const handle = spawnNativeListener({
      binaryPath: "/fake",
      dbPath: "/db",
      channel: "ch",
      spawn,
    });
    const collected: string[] = [];
    for await (const line of handle.signals) {
      collected.push(line);
    }
    expect(collected).toEqual([]);
  });
});

describe("defaultNativeSpawn", () => {
  test("passes the exact command, args, and stdio to the spawner", () => {
    const calls: Array<{
      binary: string;
      args: ReadonlyArray<string>;
      options: { stdio: ["pipe", "pipe", "pipe"] };
    }> = [];
    const child: NativeChildProcessLike = {
      stdout: null,
      stdin: null,
      killed: false,
      kill: () => {},
      once: (
        event: "exit" | "error",
        listener:
          | ((code: number | null, signal: NodeJS.Signals | null) => void)
          | ((error: Error) => void),
      ) => {
        void event;
        void listener;
        return child;
      },
    };
    const spawnImpl = (
      binary: string,
      args: ReadonlyArray<string>,
      options: { stdio: ["pipe", "pipe", "pipe"] },
    ) => {
      calls.push({ binary, args, options });
      return child;
    };
    defaultNativeSpawn("/fake/atmux-listener", ["/fake/state.db", "ch"], spawnImpl);
    expect(calls).toEqual([
      {
        binary: "/fake/atmux-listener",
        args: ["/fake/state.db", "ch"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
      },
    ]);
  });

  test("rejects the stdout iterator on child error while onExit still resolves", async () => {
    const { child, emitError } = makeNativeChild(["ready\n", "later"], {
      delayMs: 50,
      returnRejects: true,
      killThrows: true,
    });
    const handle = defaultNativeSpawn(
      "/fake/atmux-listener",
      ["/fake/state.db", "ch"],
      () => child,
    );
    const error = new Error("spawn ENOENT");
    const iter = handle.stdout[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({ done: false, value: "ready" });
    queueMicrotask(() => emitError(error));
    await expect(iter.next()).rejects.toThrow("spawn ENOENT");
    await expect(handle.onExit).resolves.toEqual({ code: null, signal: null });
    expect(() => handle.kill()).not.toThrow();
  });

  test("splits buffered stdout chunks and drops empty lines", async () => {
    const { child, stats } = makeNativeChild(["ready\nhe", "llo\n", "\n", "world"], {
      exitCode: 9,
    });
    const spawnImpl = () => child;
    const handle = defaultNativeSpawn("/fake/atmux-listener", ["/fake/state.db", "ch"], spawnImpl);
    const collected: string[] = [];
    for await (const line of handle.stdout) {
      collected.push(line);
    }
    expect(stats.setEncoding).toEqual(["utf8"]);
    expect(collected).toEqual(["ready", "hello", "world"]);
    const exit = await handle.onExit;
    expect(exit.code).toBe(9);
  });

  test("returns an empty stream when stdout is absent", async () => {
    const { child } = makeNativeChild(null, { exitCode: 0 });
    const handle = defaultNativeSpawn(
      "/fake/atmux-listener",
      ["/fake/state.db", "ch"],
      () => child,
    );
    const collected: string[] = [];
    for await (const line of handle.stdout) {
      collected.push(line);
    }
    expect(collected).toEqual([]);
    expect(await handle.onExit).toEqual({ code: 0, signal: null });
  });

  test("stop() closes stdin and sends SIGTERM when child is still live", () => {
    const { child, stats } = makeNativeChild(["line"], { killed: false });
    const handle = defaultNativeSpawn(
      "/fake/atmux-listener",
      ["/fake/state.db", "ch"],
      () => child,
    );
    handle.kill();
    expect(stats.stdinEnds).toBe(1);
    expect(stats.killSignals).toEqual(["SIGTERM"]);
  });

  test("stop() skips SIGTERM when child already marked killed", () => {
    const { child, stats } = makeNativeChild(["line"], { killed: true });
    const handle = defaultNativeSpawn(
      "/fake/atmux-listener",
      ["/fake/state.db", "ch"],
      () => child,
    );
    handle.kill();
    expect(stats.stdinEnds).toBe(1);
    expect(stats.killSignals).toEqual([]);
  });
});

describe("resolveDefaultListenerBinary", () => {
  test("default filesystem probe rejects a missing explicit binary", () => {
    const missing = `/tmp/atmux-listener-missing-${process.pid}`;
    expect(resolveDefaultListenerBinary({ ATMUX_LISTENER_BIN: missing })).toBeNull();
  });

  test("ATMUX_LISTENER_BIN explicit + existing → returns it", () => {
    const r = resolveDefaultListenerBinary(
      { ATMUX_LISTENER_BIN: "/explicit/path" },
      (p) => p === "/explicit/path",
    );
    expect(r).toBe("/explicit/path");
  });

  test("ATMUX_LISTENER_BIN explicit + missing → null", () => {
    const r = resolveDefaultListenerBinary(
      { ATMUX_LISTENER_BIN: "/explicit/missing" },
      () => false,
    );
    expect(r).toBeNull();
  });

  test("no env override + default path exists → returns default", () => {
    const r = resolveDefaultListenerBinary(
      {},
      (p) => p === "/opt/atmux/current/bin/atmux-listener",
    );
    expect(r).toBe("/opt/atmux/current/bin/atmux-listener");
  });

  test("no env override + default missing → null", () => {
    const r = resolveDefaultListenerBinary({}, () => false);
    expect(r).toBeNull();
  });

  test("empty env value falls back to default path probe", () => {
    const r = resolveDefaultListenerBinary(
      { ATMUX_LISTENER_BIN: "" },
      (p) => p === "/opt/atmux/current/bin/atmux-listener",
    );
    expect(r).toBe("/opt/atmux/current/bin/atmux-listener");
  });

  test("whitespace-only env value falls back to default path probe", () => {
    const r = resolveDefaultListenerBinary(
      { ATMUX_LISTENER_BIN: "   " },
      (p) => p === "/opt/atmux/current/bin/atmux-listener",
    );
    expect(r).toBe("/opt/atmux/current/bin/atmux-listener");
  });
});

// Unit tests for src/abstractions/native-listener.ts (atmux-listener
// Rust subprocess spawner).
//
// Strategy: inject a fake spawn fn that returns canned stdout streams
// + observable kill counter. The real subprocess is exercised by the
// end-to-end smoke test in tests/integration/native-listener-e2e.test.ts
// (when the binary is present on disk).

import { describe, expect, test } from "bun:test";
import {
  type NativeSpawnFn,
  resolveDefaultListenerBinary,
  spawnNativeListener,
} from "../../../src/abstractions/native-listener.ts";

// Synthesize a NativeSpawnFn whose stdout yields a fixed list of lines,
// with optional delay between them. `kill` flips an observable flag.
function fakeSpawn(
  lines: ReadonlyArray<string>,
  opts: { delayMs?: number; exitCode?: number } = {},
): { spawn: NativeSpawnFn; killed: { value: boolean } } {
  const killed = { value: false };
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
      },
      onExit: new Promise((resolve) =>
        setTimeout(
          () => resolve({ code: opts.exitCode ?? 0, signal: null }),
          (lines.length + 1) * (opts.delayMs ?? 0) + 50,
        ),
      ),
    };
  };
  return { spawn, killed };
}

describe("spawnNativeListener", () => {
  test("filters out the 'ready' handshake — only event lines yielded", async () => {
    const { spawn } = fakeSpawn(["ready", "honker:stream:task.done\tnew", "honker:stream:task.done\tnew"]);
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
    expect(collected).toEqual([
      "honker:stream:task.done\tnew",
      "honker:stream:task.done\tnew",
    ]);
    handle.stop();
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

  test("stop() invokes kill, terminating the stream", async () => {
    const { spawn, killed } = fakeSpawn(["ready", "a", "b", "c"], { delayMs: 100 });
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

  test("exited promise resolves with subprocess exit info", async () => {
    const { spawn } = fakeSpawn(["ready"], { exitCode: 0 });
    const handle = spawnNativeListener({
      binaryPath: "/fake",
      dbPath: "/db",
      channel: "ch",
      spawn,
    });
    // Drain the stream to let exit happen
    for await (const _ of handle.signals) {
      // empty (only ready handshake which gets filtered)
    }
    const exit = await handle.exited;
    expect(exit.code).toBe(0);
  });
});

describe("resolveDefaultListenerBinary", () => {
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

// Unit tests for src/abstractions/spawn.ts (ADR-007).

import { describe, expect, test } from "bun:test";
import { spawn, spawnStream } from "../../../src/abstractions/spawn.ts";
import { SpawnError, SpawnTimeoutError } from "../../../src/errors.ts";

describe("spawn (buffered)", () => {
  test("captures stdout from echo", async () => {
    const r = await spawn({ cmd: "echo", argv: ["hello"] });
    expect(r.stdout).toBe("hello\n");
    expect(r.exitCode).toBe(0);
    expect(r.cmd).toBe("echo");
    expect(r.argv).toEqual(["hello"]);
    expect(r.signalled).toBeNull();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("works with no argv (cmd-only)", async () => {
    const r = await spawn({ cmd: "true" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("captures stderr separately", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", "echo to-stderr 1>&2"],
    });
    expect(r.stderr).toBe("to-stderr\n");
    expect(r.stdout).toBe("");
  });

  test("pipes stdin string", async () => {
    const r = await spawn({ cmd: "cat", stdin: "piped-input" });
    expect(r.stdout).toBe("piped-input");
  });

  test("pipes stdin Uint8Array", async () => {
    const r = await spawn({
      cmd: "cat",
      stdin: new TextEncoder().encode("bytes-in"),
    });
    expect(r.stdout).toBe("bytes-in");
  });

  test("respects cwd", async () => {
    const r = await spawn({ cmd: "pwd", cwd: "/tmp" });
    // Linux pwd may resolve symlinks; just check it starts with /tmp or /private/tmp
    expect(r.stdout).toMatch(/^(\/private)?\/tmp\n/);
  });

  test("merges env vars on top of process.env", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", "echo $ATMUX_TEST_VAR"],
      env: { ATMUX_TEST_VAR: "set-from-test" },
    });
    expect(r.stdout).toBe("set-from-test\n");
  });

  test("default expectExitCode=0 throws SpawnError on nonzero", async () => {
    await expect(spawn({ cmd: "false" })).rejects.toBeInstanceOf(SpawnError);
  });

  test("expectExitCode array accepts listed codes", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", "exit 1"],
      expectExitCode: [0, 1],
    });
    expect(r.exitCode).toBe(1);
  });

  test("expectExitCode single number accepts only that", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", "exit 7"],
      expectExitCode: 7,
    });
    expect(r.exitCode).toBe(7);
  });

  test("expectExitCode 'any' disables validation", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", "exit 99"],
      expectExitCode: "any",
    });
    expect(r.exitCode).toBe(99);
  });

  test("nonzero exit captures stderr in thrown SpawnError", async () => {
    let caught: SpawnError | null = null;
    try {
      await spawn({
        cmd: "sh",
        argv: ["-c", "echo bang 1>&2; exit 2"],
      });
    } catch (e) {
      if (e instanceof SpawnError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.context.stderr).toBe("bang\n");
    expect(caught?.context.exitCode).toBe(2);
  });

  test("missing cmd throws SpawnError with exitCode -1", async () => {
    let caught: SpawnError | null = null;
    try {
      await spawn({ cmd: "definitely-not-installed-xyz123" });
    } catch (e) {
      if (e instanceof SpawnError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.context.exitCode).toBe(-1);
    expect(caught?.context.stderr).toContain("command not found");
  });

  test("absolute path bypasses Bun.which", async () => {
    const r = await spawn({ cmd: "/bin/echo", argv: ["abs"] });
    expect(r.stdout).toBe("abs\n");
  });

  test("timeout fires SpawnTimeoutError", async () => {
    let caught: SpawnTimeoutError | null = null;
    try {
      await spawn({ cmd: "sleep", argv: ["10"], timeoutMs: 100 });
    } catch (e) {
      if (e instanceof SpawnTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.context.timeoutMs).toBe(100);
  });

  test("AbortSignal cancels in-flight spawn", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("user-aborted")), 50);
    let caught: SpawnError | null = null;
    try {
      await spawn({ cmd: "sleep", argv: ["10"], signal: ctrl.signal });
    } catch (e) {
      if (e instanceof SpawnError) caught = e;
    }
    expect(caught).not.toBeNull();
  });

  test("pre-aborted signal cancels immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: SpawnError | null = null;
    try {
      await spawn({ cmd: "sleep", argv: ["10"], signal: ctrl.signal });
    } catch (e) {
      if (e instanceof SpawnError) caught = e;
    }
    expect(caught).not.toBeNull();
  });

  test("timeoutMs<=0 disables the timer", async () => {
    // Should run to completion regardless of timeoutMs being 0.
    const r = await spawn({ cmd: "echo", argv: ["x"], timeoutMs: 0 });
    expect(r.stdout).toBe("x\n");
  });
});

describe("spawnStream", () => {
  test("invokes onStdout per chunk + resolves with full buffer", async () => {
    const chunks: string[] = [];
    const handle = spawnStream({
      cmd: "sh",
      argv: ["-c", "printf 'a'; sleep 0.05; printf 'b'"],
      onStdout: (s) => chunks.push(s),
    });
    const r = await handle.exited;
    expect(r.stdout).toBe("ab");
    expect(chunks.join("")).toBe("ab");
    expect(r.exitCode).toBe(0);
  });

  test("invokes onStderr per chunk", async () => {
    const errChunks: string[] = [];
    const handle = spawnStream({
      cmd: "sh",
      argv: ["-c", "echo err 1>&2"],
      onStderr: (s) => errChunks.push(s),
    });
    const r = await handle.exited;
    expect(r.stderr).toBe("err\n");
    expect(errChunks.join("")).toBe("err\n");
  });

  test("kill() terminates the child", async () => {
    const handle = spawnStream({ cmd: "sleep", argv: ["10"] });
    setTimeout(() => handle.kill("SIGTERM"), 30);
    let caught: Error | null = null;
    try {
      await handle.exited;
    } catch (e) {
      caught = e as Error;
    }
    // Either SpawnError (nonzero exit due to signal) or SpawnTimeoutError
    expect(caught).not.toBeNull();
  });

  test("writeStdin / closeStdin pipes data", async () => {
    const handle = spawnStream({ cmd: "cat" });
    await handle.writeStdin("first\n");
    await handle.writeStdin("second\n");
    await handle.closeStdin();
    const r = await handle.exited;
    expect(r.stdout).toBe("first\nsecond\n");
  });

  test("nonzero exit throws SpawnError on exited promise", async () => {
    const handle = spawnStream({
      cmd: "sh",
      argv: ["-c", "exit 3"],
    });
    let caught: SpawnError | null = null;
    try {
      await handle.exited;
    } catch (e) {
      if (e instanceof SpawnError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.context.exitCode).toBe(3);
  });

  test("expectExitCode 'any' bypasses validation", async () => {
    const handle = spawnStream({
      cmd: "sh",
      argv: ["-c", "exit 5"],
      expectExitCode: "any",
    });
    const r = await handle.exited;
    expect(r.exitCode).toBe(5);
  });

  test("timeout throws SpawnTimeoutError on exited promise", async () => {
    const handle = spawnStream({ cmd: "sleep", argv: ["10"], timeoutMs: 80 });
    let caught: SpawnTimeoutError | null = null;
    try {
      await handle.exited;
    } catch (e) {
      if (e instanceof SpawnTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
  });

  test("AbortSignal cancellation throws SpawnError on exited promise", async () => {
    const ctrl = new AbortController();
    const handle = spawnStream({ cmd: "sleep", argv: ["10"], signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    let caught: SpawnError | null = null;
    try {
      await handle.exited;
    } catch (e) {
      if (e instanceof SpawnError) caught = e;
    }
    expect(caught).not.toBeNull();
  });

  test("kill swallow path — second kill on dead child does not throw", async () => {
    const handle = spawnStream({ cmd: "echo", argv: ["x"] });
    await handle.exited;
    // Already exited; kill should be a no-op.
    handle.kill();
    expect(true).toBe(true);
  });
});

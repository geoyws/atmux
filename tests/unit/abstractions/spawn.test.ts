// Unit tests for src/abstractions/spawn.ts (ADR-007).

import { describe, expect, test } from "bun:test";
import { spawn, spawnInheritStdio, spawnStream } from "../../../src/abstractions/spawn.ts";
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

// ---------- spawnInheritStdio (ADR-180) ----------
//
// The point of this primitive is fd inheritance, which is impossible to
// directly assert in bun:test (the test runner's stdio is what gets
// inherited, and we don't want to write to it). Tests cover the
// exit-code passthrough, command-resolution failure path, and the no-
// argv ergonomics; the actual tty-inherit behaviour is validated by
// running `atmux cockpit attach --human` from a real shell.

describe("spawnInheritStdio (ADR-180)", () => {
  test("returns 0 for `true`", async () => {
    const code = await spawnInheritStdio({ cmd: "true" });
    expect(code).toBe(0);
  });

  test("returns 1 for `false`", async () => {
    const code = await spawnInheritStdio({ cmd: "false" });
    expect(code).toBe(1);
  });

  test("throws SpawnError when cmd cannot be resolved", async () => {
    await expect(
      spawnInheritStdio({ cmd: "definitely-not-a-real-binary-xyz" }),
    ).rejects.toBeInstanceOf(SpawnError);
  });

  test("accepts argv", async () => {
    // `true` ignores argv; we just confirm the path doesn't blow up.
    const code = await spawnInheritStdio({ cmd: "true", argv: ["ignored"] });
    expect(code).toBe(0);
  });
});

// ---------- t-681e5b91 — ATMUX_SPAWN_TIMEOUT_MS env override ----------

import { afterEach, beforeEach } from "bun:test";
import { resolveDefaultTimeoutMs } from "../../../src/abstractions/spawn.ts";

describe("resolveDefaultTimeoutMs — ATMUX_SPAWN_TIMEOUT_MS env override", () => {
  const original = process.env.ATMUX_SPAWN_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.ATMUX_SPAWN_TIMEOUT_MS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ATMUX_SPAWN_TIMEOUT_MS;
    else process.env.ATMUX_SPAWN_TIMEOUT_MS = original;
  });

  test("default is 30_000ms when env unset", () => {
    expect(resolveDefaultTimeoutMs()).toBe(30_000);
  });

  test("default is 30_000ms when env empty string", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "";
    expect(resolveDefaultTimeoutMs()).toBe(30_000);
  });

  test("honors valid positive integer env (sopx submodule-init 120s)", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "120000";
    expect(resolveDefaultTimeoutMs()).toBe(120_000);
  });

  test("honors fractional positive numeric env (Number coerces)", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "45000.5";
    expect(resolveDefaultTimeoutMs()).toBe(45_000.5);
  });

  test("falls back to 30_000ms when env is non-numeric", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "fast";
    expect(resolveDefaultTimeoutMs()).toBe(30_000);
  });

  test("falls back to 30_000ms when env is zero", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "0";
    expect(resolveDefaultTimeoutMs()).toBe(30_000);
  });

  test("falls back to 30_000ms when env is negative", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "-1000";
    expect(resolveDefaultTimeoutMs()).toBe(30_000);
  });

  test("falls back to 30_000ms when env is Infinity literal", () => {
    process.env.ATMUX_SPAWN_TIMEOUT_MS = "Infinity";
    expect(resolveDefaultTimeoutMs()).toBe(30_000);
  });
});

// ---------- ADR-281 — unsetEnv, the env-DELETION seam ----------
//
// `env` can only add or override, and its value type is `string`, so
// "this variable must not exist in the child" was previously
// unrepresentable: `{ X: "" }` is a DIFFERENT observable state
// (defined-but-empty). These tests pin the three properties ADR-281
// depends on — deletion actually deletes, deletion beats a contradicting
// `env` key, and `process.env` is never mutated.

describe("unsetEnv (ADR-281)", () => {
  const PROBE = "ATMUX_UNSET_PROBE";
  let priorProbe: string | undefined;

  beforeEach(() => {
    priorProbe = process.env[PROBE];
    process.env[PROBE] = "inherited";
  });

  afterEach(() => {
    if (priorProbe === undefined) delete process.env[PROBE];
    else process.env[PROBE] = priorProbe;
  });

  // `sh` prints `SET:<value>` when the var EXISTS (even empty) and
  // `ABSENT` when it does not — the distinction the whole ADR turns on.
  // `${X+set}` expands to `set` iff X is DEFINED, empty or not.
  const probeScript = `if [ -n "\${${PROBE}+set}" ]; then echo "SET:$${PROBE}"; else echo ABSENT; fi`;

  test("control — an inherited var reaches the child without unsetEnv", async () => {
    // Without this leg, every assertion below could be green because the
    // var never made it into the child in the first place.
    const r = await spawn({ cmd: "sh", argv: ["-c", probeScript] });
    expect(r.stdout).toBe("SET:inherited\n");
  });

  test("deletes an inherited var — the child sees it ABSENT, not empty", async () => {
    const r = await spawn({ cmd: "sh", argv: ["-c", probeScript], unsetEnv: [PROBE] });
    expect(r.stdout).toBe("ABSENT\n");
  });

  test("empty-string env is NOT the same thing — it arrives DEFINED", async () => {
    // Pins why the seam had to exist at all (ADR-281 §D1 / ADR-277 §D1).
    const r = await spawn({ cmd: "sh", argv: ["-c", probeScript], env: { [PROBE]: "" } });
    expect(r.stdout).toBe("SET:\n");
  });

  test("deletion is the LAST word — unsetEnv beats a contradicting env key", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", probeScript],
      env: { [PROBE]: "resurrected" },
      unsetEnv: [PROBE],
    });
    expect(r.stdout).toBe("ABSENT\n");
  });

  test("unlisted vars are untouched", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", 'echo "$ATMUX_KEEP_ME"'],
      env: { ATMUX_KEEP_ME: "kept" },
      unsetEnv: [PROBE],
    });
    expect(r.stdout).toBe("kept\n");
  });

  test("never mutates the parent's own process.env", async () => {
    // Load-bearing for ADR-281 §D5: src/core/tui.ts reads
    // process.env.NO_COLOR at call time, so a delete here would silently
    // re-colour atmux's own stdout.
    await spawn({ cmd: "true", unsetEnv: [PROBE] });
    expect(process.env[PROBE]).toBe("inherited");
  });

  test("an unset var listed in unsetEnv is a harmless no-op", async () => {
    const r = await spawn({
      cmd: "sh",
      argv: ["-c", probeScript],
      unsetEnv: ["ATMUX_NEVER_SET_ANYWHERE", PROBE],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ABSENT\n");
  });

  test("spawnStream honours unsetEnv too", async () => {
    // spawnStream has no production caller today; it shares mergeEnv, so
    // leaving it unpatched would make the invariant false the moment the
    // streaming path is wired up.
    const h = spawnStream({ cmd: "sh", argv: ["-c", probeScript], unsetEnv: [PROBE] });
    const r = await h.exited;
    expect(r.stdout).toBe("ABSENT\n");
  });
});

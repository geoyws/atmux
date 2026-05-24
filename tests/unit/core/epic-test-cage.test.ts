// Unit tests for src/core/epic-test-cage.ts (ADR-144 §Cage mode T3 /
// t-8cba0705).
//
// Strategy:
//   - pure helpers (expandCagePath, tokenizeTestCommand) run direct
//   - I/O helpers (provisionCage / teardownCage / runCageTestOnce /
//     runCageTest / runCageTestGate) use an injected `spawn` stub
//     that records argv + returns canned {@link SpawnResult} fixtures
//     based on which command fired
//
// 100% coverage target — every branch in the run loop + the
// orchestrator's try/finally exercised.

import { describe, expect, test } from "bun:test";
import type { SpawnOpts, SpawnResult } from "../../../src/abstractions/spawn.ts";
import {
  expandCagePath,
  provisionCage,
  runCageTest,
  runCageTestGate,
  runCageTestOnce,
  teardownCage,
  tokenizeTestCommand,
} from "../../../src/core/epic-test-cage.ts";

// ---------- Helpers ----------

function ok(stdout = ""): SpawnResult {
  return {
    cmd: "stub",
    argv: [],
    exitCode: 0,
    signalled: null,
    stdout,
    stderr: "",
    durationMs: 50,
  };
}

function fail(code = 1, stderr = "test failed"): SpawnResult {
  return {
    cmd: "stub",
    argv: [],
    exitCode: code,
    signalled: null,
    stdout: "",
    stderr,
    durationMs: 50,
  };
}

interface RecordingSpawn {
  fn: (opts: SpawnOpts) => Promise<SpawnResult>;
  calls: SpawnOpts[];
}

/** Spawn stub that records every call's argv and returns SpawnResult
 *  fixtures based on the `cmd` field. The `behavior` parameter
 *  controls what `env` (i.e. the test runner) returns. */
function makeSpawnStub(
  behavior: { kind: "pass" } | { kind: "fail" } | { kind: "flake-then-pass"; failCount: number },
): RecordingSpawn {
  let testAttempts = 0;
  const calls: SpawnOpts[] = [];
  const fn = async (opts: SpawnOpts): Promise<SpawnResult> => {
    calls.push(opts);
    if (opts.cmd === "mkdir" || opts.cmd === "rm") {
      return ok("");
    }
    if (opts.cmd === "env") {
      testAttempts += 1;
      if (behavior.kind === "pass") return ok("test passed");
      if (behavior.kind === "fail") return fail(1, "test failed");
      // flake-then-pass: fail for the first `failCount` attempts, then pass
      if (testAttempts <= behavior.failCount) return fail(1, "flake");
      return ok("flake recovered");
    }
    throw new Error(`makeSpawnStub: unexpected cmd ${opts.cmd}`);
  };
  return { fn, calls };
}

// ---------- expandCagePath ----------

describe("expandCagePath", () => {
  test("expands ${team} placeholder", () => {
    expect(expandCagePath("/tmp/atmux_${team}_test", "atmux", "e-1")).toBe("/tmp/atmux_atmux_test");
  });
  test("expands ${epic} placeholder", () => {
    expect(expandCagePath("/tmp/${epic}_cage", "atmux", "e-aabb0001")).toBe("/tmp/e-aabb0001_cage");
  });
  test("expands both placeholders together — ADR-144 default", () => {
    expect(expandCagePath("/tmp/atmux_${team}_${epic}_test_cage", "atmux", "e-1")).toBe(
      "/tmp/atmux_atmux_e-1_test_cage",
    );
  });
  test("leaves unknown placeholders verbatim", () => {
    expect(expandCagePath("/tmp/${unknown}/${team}", "t", "e")).toBe("/tmp/${unknown}/t");
  });
  test("expands repeated placeholders globally", () => {
    expect(expandCagePath("/${team}/${team}/${team}", "t", "e")).toBe("/t/t/t");
  });
});

// ---------- tokenizeTestCommand ----------

describe("tokenizeTestCommand", () => {
  test("splits on whitespace", () => {
    expect(tokenizeTestCommand("bun test")).toEqual(["bun", "test"]);
  });
  test("handles multiple spaces + tabs", () => {
    expect(tokenizeTestCommand("bun   test\t--timeout\t30000")).toEqual([
      "bun",
      "test",
      "--timeout",
      "30000",
    ]);
  });
  test("preserves double-quoted spaces", () => {
    expect(tokenizeTestCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });
  test("preserves single-quoted spaces", () => {
    expect(tokenizeTestCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });
  test("default ADR-144 testCommand", () => {
    expect(tokenizeTestCommand("bun test --timeout 30000")).toEqual([
      "bun",
      "test",
      "--timeout",
      "30000",
    ]);
  });
  test("refuses unterminated quote", () => {
    expect(() => tokenizeTestCommand('bun test "missing')).toThrow(/unterminated/);
  });
  test("refuses empty command", () => {
    expect(() => tokenizeTestCommand("")).toThrow(/empty command/);
    expect(() => tokenizeTestCommand("   ")).toThrow(/empty command/);
  });
});

// ---------- provisionCage / teardownCage ----------

describe("provisionCage", () => {
  test("runs `mkdir -p <cagePath>`", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    await provisionCage("/tmp/cage-x", fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("mkdir");
    expect(calls[0]?.argv).toEqual(["-p", "/tmp/cage-x"]);
  });
});

describe("teardownCage", () => {
  test("runs `rm -rf <cagePath>`", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    await teardownCage("/tmp/cage-y", fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("rm");
    expect(calls[0]?.argv).toEqual(["-rf", "/tmp/cage-y"]);
  });
});

// ---------- runCageTestOnce ----------

describe("runCageTestOnce", () => {
  test("PASS — exit 0 → outcome=pass + records stdout", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    const r = await runCageTestOnce("/tmp/cage", "bun test", "/repo", 30000, fn);
    expect(r.outcome).toBe("pass");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("test passed");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    // Verify env -u TMUX TMUX_TMPDIR=<cage> bun test argv shape.
    expect(calls[0]?.cmd).toBe("env");
    expect(calls[0]?.argv).toEqual(["-u", "TMUX", "TMUX_TMPDIR=/tmp/cage", "bun", "test"]);
  });

  test("FAIL — non-zero exit → outcome=fail with stderr", async () => {
    const { fn } = makeSpawnStub({ kind: "fail" });
    const r = await runCageTestOnce("/tmp/cage", "bun test", "/repo", 30000, fn);
    expect(r.outcome).toBe("fail");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("test failed");
  });

  test("threads cwd + timeoutMs through spawn", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    await runCageTestOnce("/tmp/cage", "bun test", "/my/repo", 12345, fn);
    expect(calls[0]?.cwd).toBe("/my/repo");
    expect(calls[0]?.timeoutMs).toBe(12345);
    expect(calls[0]?.expectExitCode).toBe("any");
  });
});

// ---------- runCageTest (retry loop) ----------

describe("runCageTest — retryOnFlake", () => {
  test("PASS on first attempt — no retries", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    const r = await runCageTest({
      cagePath: "/tmp/cage",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 2,
      spawn: fn,
    });
    expect(r.outcome).toBe("pass");
    expect(r.attempts).toBe(1);
    // Single test invocation (only env-cmd calls count).
    const envCalls = calls.filter((c) => c.cmd === "env");
    expect(envCalls).toHaveLength(1);
  });

  test("FAIL → retry exhausted (retryOnFlake=1, 2 total attempts)", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "fail" });
    const r = await runCageTest({
      cagePath: "/tmp/cage",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 1,
      spawn: fn,
    });
    expect(r.outcome).toBe("fail");
    expect(r.attempts).toBe(2);
    expect(r.last.exitCode).toBe(1);
    const envCalls = calls.filter((c) => c.cmd === "env");
    expect(envCalls).toHaveLength(2);
  });

  test("flake-then-pass — first attempt fails, retry passes", async () => {
    const { fn } = makeSpawnStub({ kind: "flake-then-pass", failCount: 1 });
    const r = await runCageTest({
      cagePath: "/tmp/cage",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 1,
      spawn: fn,
    });
    expect(r.outcome).toBe("pass");
    expect(r.attempts).toBe(2);
    expect(r.last.outcome).toBe("pass");
  });

  test("retryOnFlake=0 disables retry — single attempt only", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "fail" });
    const r = await runCageTest({
      cagePath: "/tmp/cage",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 0,
      spawn: fn,
    });
    expect(r.outcome).toBe("fail");
    expect(r.attempts).toBe(1);
    const envCalls = calls.filter((c) => c.cmd === "env");
    expect(envCalls).toHaveLength(1);
  });

  test("totalDurationMs sums per-attempt durations", async () => {
    const { fn } = makeSpawnStub({ kind: "flake-then-pass", failCount: 2 });
    const r = await runCageTest({
      cagePath: "/tmp/cage",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 3,
      spawn: fn,
    });
    expect(r.attempts).toBe(3);
    // Each stub attempt reports durationMs=50; 3 attempts → 150 total.
    expect(r.totalDurationMs).toBe(150);
  });

  test("negative retryOnFlake floors to 0", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    const r = await runCageTest({
      cagePath: "/tmp/cage",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: -5,
      spawn: fn,
    });
    expect(r.attempts).toBe(1);
    const envCalls = calls.filter((c) => c.cmd === "env");
    expect(envCalls).toHaveLength(1);
  });
});

// ---------- runCageTestGate (lifecycle orchestrator) ----------

describe("runCageTestGate — full lifecycle", () => {
  test("provision → run → teardown for PASS", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "pass" });
    const r = await runCageTestGate({
      cagePath: "/tmp/cage-gate",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 1,
      spawn: fn,
    });
    expect(r.outcome).toBe("pass");
    expect(calls[0]?.cmd).toBe("mkdir");
    expect(calls[calls.length - 1]?.cmd).toBe("rm");
  });

  test("teardown runs even on FAIL", async () => {
    const { fn, calls } = makeSpawnStub({ kind: "fail" });
    const r = await runCageTestGate({
      cagePath: "/tmp/cage-fail",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 0,
      spawn: fn,
    });
    expect(r.outcome).toBe("fail");
    // teardown still fires
    expect(calls.filter((c) => c.cmd === "rm")).toHaveLength(1);
  });

  test("teardown runs even when test runner throws", async () => {
    let rmCalled = false;
    const fn = async (opts: SpawnOpts): Promise<SpawnResult> => {
      if (opts.cmd === "mkdir") return ok("");
      if (opts.cmd === "env") throw new Error("spawn boom");
      if (opts.cmd === "rm") {
        rmCalled = true;
        return ok("");
      }
      throw new Error(`unexpected cmd ${opts.cmd}`);
    };
    await expect(
      runCageTestGate({
        cagePath: "/tmp/cage-throw",
        testCommand: "bun test",
        cwd: "/repo",
        timeoutMs: 30000,
        retryOnFlake: 0,
        spawn: fn,
      }),
    ).rejects.toThrow(/spawn boom/);
    expect(rmCalled).toBe(true);
  });

  test("teardown failure is swallowed — doesn't mask successful outcome", async () => {
    const fn = async (opts: SpawnOpts): Promise<SpawnResult> => {
      if (opts.cmd === "mkdir") return ok("");
      if (opts.cmd === "env") return ok("pass");
      if (opts.cmd === "rm") throw new Error("rm failed");
      throw new Error(`unexpected cmd ${opts.cmd}`);
    };
    // Should not throw — teardown's .catch() swallows.
    const r = await runCageTestGate({
      cagePath: "/tmp/cage-rm-fail",
      testCommand: "bun test",
      cwd: "/repo",
      timeoutMs: 30000,
      retryOnFlake: 0,
      spawn: fn,
    });
    expect(r.outcome).toBe("pass");
  });
});

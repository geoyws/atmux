// Unit tests for src/abstractions/cursor.ts (ADR-055 §D3).
//
// All cursor invocations + git diff calls are stubbed via injected
// `spawnFn` + `computePatch`. No real cursor-agent or git in tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeCursor } from "../../../src/abstractions/cursor.ts";
import type { CursorJob } from "../../../src/core/cursor-recipes/types.ts";

let tmpRoot: string;
let logPath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atmux-cursor-"));
  logPath = join(tmpRoot, "logs", "cursor-self-heal-test.log");
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

const sampleJob = (overrides: Partial<CursorJob> = {}): CursorJob => ({
  prompt: "edit team.json: ...",
  fileAllowlist: ["team.json"],
  tokenCap: 5000,
  cwd: "/tmp/project",
  ...overrides,
});

describe("invokeCursor — happy path", () => {
  test("spawns with correct argv + stdin + cwd", async () => {
    let observed: { argv: ReadonlyArray<string>; stdin: string | undefined; cwd: string | undefined } | null = null;
    await invokeCursor(sampleJob(), {
      spawnFn: async (opts) => {
        observed = { argv: opts.argv, stdin: opts.stdin, cwd: opts.cwd };
        return { exitCode: 0, stdout: '{"tokensUsed":1234}', stderr: "" };
      },
      computePatch: async () => ({ diff: "diff body", files: ["team.json"] }),
    });
    expect(observed).not.toBeNull();
    expect(observed?.argv).toEqual([
      "--print",
      "--model",
      "composer-2",
      "--force",
      "--max-tokens",
      "5000",
      "--output-json",
      "--cwd",
      "/tmp/project",
    ]);
    expect(observed?.stdin).toBe("edit team.json: ...");
    expect(observed?.cwd).toBe("/tmp/project");
  });

  test("returns parsed tokens + computed patch on successful invocation", async () => {
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => ({
        exitCode: 0,
        stdout: '{"tokensUsed":1234}\n{"tokensUsed":1500}\n',
        stderr: "",
      }),
      computePatch: async () => ({ diff: "@@ -1 +1 @@", files: ["team.json"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.tokensUsed).toBe(1500); // last record wins
    expect(r.patch.diff).toBe("@@ -1 +1 @@");
    expect(r.patch.files).toEqual(["team.json"]);
  });

  test("parses tokens from usage.totalTokens schema variant", async () => {
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => ({
        exitCode: 0,
        stdout: '{"usage":{"totalTokens":2500}}',
        stderr: "",
      }),
      computePatch: async () => ({ diff: "", files: [] }),
    });
    expect(r.tokensUsed).toBe(2500);
  });

  test("returns -1 tokensUsed when --output-json stream has no usable record", async () => {
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => ({ exitCode: 0, stdout: "{not json}\nbare line", stderr: "" }),
      computePatch: async () => ({ diff: "", files: [] }),
    });
    expect(r.tokensUsed).toBe(-1);
  });

  test("uses custom cursorBinary + cursorModel + timeoutMs overrides", async () => {
    let observed: { cmd: string; argv: ReadonlyArray<string>; timeoutMs: number | undefined } | null = null;
    await invokeCursor(sampleJob(), {
      cursorBinary: "/path/to/stub",
      cursorModel: "composer-mini",
      timeoutMs: 60_000,
      spawnFn: async (opts) => {
        observed = { cmd: opts.cmd, argv: opts.argv, timeoutMs: opts.timeoutMs };
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
      computePatch: async () => ({ diff: "", files: [] }),
    });
    expect(observed?.cmd).toBe("/path/to/stub");
    expect(observed?.argv).toContain("composer-mini");
    expect(observed?.timeoutMs).toBe(60_000);
  });
});

describe("invokeCursor — failure paths (no throw)", () => {
  test("non-zero exitCode returns failure shape with empty patch (computePatch skipped)", async () => {
    let computePatchCalled = false;
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => ({ exitCode: 1, stdout: "{}", stderr: "cursor angry" }),
      computePatch: async () => {
        computePatchCalled = true;
        return { diff: "should not be returned", files: [] };
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.patch.diff).toBe(""); // skipped — exitCode != 0
    expect(r.stderr).toBe("cursor angry");
    expect(computePatchCalled).toBe(false);
  });

  test("spawnFn throws (binary missing) → returns exitCode=-1 + stderr=cause + empty patch", async () => {
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => {
        throw new Error("ENOENT: cursor-agent not found");
      },
      computePatch: async () => ({ diff: "", files: [] }),
    });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain("ENOENT: cursor-agent not found");
    expect(r.patch.diff).toBe("");
    expect(r.tokensUsed).toBe(-1);
  });

  test("computePatch throws → caught, returns empty patch (still exitCode=0)", async () => {
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      computePatch: async () => {
        throw new Error("git not found");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.patch.diff).toBe("");
    expect(r.patch.files).toEqual([]);
  });

  test("durationMs is non-negative and returned even on spawn failure", async () => {
    const r = await invokeCursor(sampleJob(), {
      spawnFn: async () => {
        throw new Error("boom");
      },
      computePatch: async () => ({ diff: "", files: [] }),
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("invokeCursor — session log persistence", () => {
  test("writes session log file when logPath provided", async () => {
    await invokeCursor(sampleJob({ prompt: "FIX FOO" }), {
      logPath,
      spawnFn: async () => ({
        exitCode: 0,
        stdout: '{"tokensUsed":900}',
        stderr: "warn1",
      }),
      computePatch: async () => ({ diff: "patch text", files: ["team.json"] }),
    });
    const txt = await readFile(logPath, "utf8");
    expect(txt).toContain("FIX FOO");
    expect(txt).toContain("exitCode: 0");
    expect(txt).toContain("tokensUsed: 900");
    expect(txt).toContain("patch text");
    expect(txt).toContain("warn1");
    expect(txt).toContain("team.json");
  });

  test("session log written even on spawn failure (postmortem)", async () => {
    await invokeCursor(sampleJob(), {
      logPath,
      spawnFn: async () => {
        throw new Error("missing binary");
      },
      computePatch: async () => ({ diff: "", files: [] }),
    });
    const txt = await readFile(logPath, "utf8");
    expect(txt).toContain("exitCode: -1");
    expect(txt).toContain("missing binary");
  });

  test("logPath omitted → no log file produced", async () => {
    // Pre-create the dir so we'd expect to see a file if logPath
    // were used.
    await mkdir(join(tmpRoot, "logs"), { recursive: true });
    await invokeCursor(sampleJob(), {
      // no logPath
      spawnFn: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      computePatch: async () => ({ diff: "", files: [] }),
    });
    // The default logPath we assigned in beforeEach was never used;
    // confirm the file doesn't exist.
    const exists = await readFile(logPath, "utf8").then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  test("log-write failure is swallowed (best-effort observability)", async () => {
    // Pin logPath into a non-writable dir; ensure invokeCursor still
    // returns the result without throwing.
    const r = await invokeCursor(sampleJob(), {
      logPath: "/proc/1/cannot-write-here",
      spawnFn: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      computePatch: async () => ({ diff: "", files: [] }),
    });
    expect(r.exitCode).toBe(0);
  });
});

// Unit tests for src/verbs/pause.ts (pause + resume).
// Bash spec: lib/pause.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPaused, listPaused } from "../../../src/core/pause.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { parsePauseResumeArgs, pause, resume } from "../../../src/verbs/pause.ts";

let teamDir: string;
let atmuxDir: string;
let priorReason: string | undefined;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-pause-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "team", members: [{ name: "alpha" }] }),
  );
  priorReason = process.env.ATMUX_PAUSE_REASON;
  delete process.env.ATMUX_PAUSE_REASON;
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
  if (priorReason !== undefined) process.env.ATMUX_PAUSE_REASON = priorReason;
  else delete process.env.ATMUX_PAUSE_REASON;
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- parsePauseResumeArgs ----------

describe("parsePauseResumeArgs", () => {
  test("plain member", () => {
    expect(parsePauseResumeArgs(["alpha"], "pause")).toEqual({ member: "alpha" });
  });

  test("--reason consumed", () => {
    expect(parsePauseResumeArgs(["alpha", "--reason", "budget"], "pause").reason).toBe("budget");
  });

  test("--team-dir consumed", () => {
    expect(parsePauseResumeArgs(["alpha", "--team-dir", "/x"], "pause").teamDir).toBe("/x");
  });

  test("missing member → UsageError", () => {
    expect(() => parsePauseResumeArgs([], "pause")).toThrow(UsageError);
  });

  test("--reason without value → UsageError", () => {
    expect(() => parsePauseResumeArgs(["alpha", "--reason"], "pause")).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parsePauseResumeArgs(["alpha", "--team-dir"], "resume")).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parsePauseResumeArgs(["alpha", "--bogus"], "pause")).toThrow(UsageError);
  });

  test("too many positionals → UsageError", () => {
    expect(() => parsePauseResumeArgs(["alpha", "extra"], "pause")).toThrow(UsageError);
  });
});

// ---------- pause + resume integration ----------

describe("pause verb", () => {
  test("happy path: marks member paused with default reason 'manual'", async () => {
    const { out } = await captureStdout(() => pause(["alpha", "--team-dir", teamDir]));
    expect(out).toContain("paused alpha");
    expect(await isPaused(atmuxDir, "alpha")).toBe(true);
    const map = await listPaused(atmuxDir);
    expect(map.alpha?.reason).toBe("manual");
  });

  test("--reason wins over default", async () => {
    await captureStdout(() => pause(["alpha", "--reason", "budget", "--team-dir", teamDir]));
    const map = await listPaused(atmuxDir);
    expect(map.alpha?.reason).toBe("budget");
  });

  test("$ATMUX_PAUSE_REASON env wins over default but loses to --reason", async () => {
    process.env.ATMUX_PAUSE_REASON = "envreason";
    await captureStdout(() => pause(["alpha", "--team-dir", teamDir]));
    expect((await listPaused(atmuxDir)).alpha?.reason).toBe("envreason");
    // Now flag wins:
    await captureStdout(() => pause(["alpha", "--reason", "flag-wins", "--team-dir", teamDir]));
    expect((await listPaused(atmuxDir)).alpha?.reason).toBe("flag-wins");
  });

  test("unknown member → ConfigError", async () => {
    await expect(pause(["bogus", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });
});

describe("resume verb", () => {
  test("happy path: clears paused flag", async () => {
    await captureStdout(() => pause(["alpha", "--team-dir", teamDir]));
    expect(await isPaused(atmuxDir, "alpha")).toBe(true);

    const { out } = await captureStdout(() => resume(["alpha", "--team-dir", teamDir]));
    expect(out).toContain("resumed alpha");
    expect(await isPaused(atmuxDir, "alpha")).toBe(false);
  });

  test("resume on never-paused member is a no-op (no error)", async () => {
    const { out } = await captureStdout(() => resume(["alpha", "--team-dir", teamDir]));
    expect(out).toContain("resumed alpha");
  });

  test("unknown member → ConfigError", async () => {
    await expect(resume(["bogus", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });
});

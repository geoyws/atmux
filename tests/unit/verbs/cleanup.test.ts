// Unit tests for src/verbs/cleanup.ts (ADR-068 cutover Tier 1, P0).
//
// ADR-263 (the great simplification): the verb is now a pure log-rotation
// harness primitive — the inbox/legacy-fleet sub-ops are retired with the
// fleet-coordination layer. Covers parseCleanupArgs (every branch) and the
// verb body — happy path, --dry-run, "all" alias routing through log rotation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import { cleanup, parseCleanupArgs } from "../../../src/verbs/cleanup.ts";

interface Env {
  atmuxDir: string;
  logsDir: string;
  logs: { kind: string; msg: string }[];
  logger: Logger;
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-cleanup-verb-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  const logs: Env["logs"] = [];
  const logger: Logger = {
    log: (m) => logs.push({ kind: "log", msg: m }),
    ok: (m) => logs.push({ kind: "ok", msg: m }),
    warn: (m) => logs.push({ kind: "warn", msg: m }),
    err: (m) => logs.push({ kind: "err", msg: m }),
  };
  env = {
    atmuxDir,
    logsDir: join(atmuxDir, "logs"),
    logs,
    logger,
  };
});

afterEach(async () => {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
});

// ---------- parseCleanupArgs ----------

describe("parseCleanupArgs", () => {
  test("requires a sub-verb", () => {
    expect(() => parseCleanupArgs([])).toThrow(UsageError);
  });

  test("rejects unknown sub-verb", () => {
    expect(() => parseCleanupArgs(["nonsense"])).toThrow(UsageError);
  });

  test("accepts logs / all", () => {
    expect(parseCleanupArgs(["logs"]).sub).toBe("logs");
    expect(parseCleanupArgs(["all"]).sub).toBe("all");
  });

  test("--dry-run sets the flag", () => {
    expect(parseCleanupArgs(["logs", "--dry-run"]).dryRun).toBe(true);
  });

  test("--max-size accepts non-negative ints; rejects rest", () => {
    expect(parseCleanupArgs(["logs", "--max-size", "0"]).maxBytes).toBe(0);
    expect(parseCleanupArgs(["logs", "--max-size", "1024"]).maxBytes).toBe(1024);
    expect(() => parseCleanupArgs(["logs", "--max-size"])).toThrow(UsageError);
    expect(() => parseCleanupArgs(["logs", "--max-size", "x"])).toThrow(UsageError);
    expect(() => parseCleanupArgs(["logs", "--max-size", "-1"])).toThrow(UsageError);
  });

  test("unknown flag throws", () => {
    expect(() => parseCleanupArgs(["logs", "--bogus"])).toThrow(UsageError);
  });
});

// ---------- cleanup body ----------

describe("cleanup verb", () => {
  test("logs subcommand rotates >cap files + emits ok line", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "report.log"), "x".repeat(2 * 1024 * 1024));
    const rc = await cleanup(["logs"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
    });
    expect(rc).toBe(0);
    const oks = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(oks.some((m) => m.includes("1 rotated"))).toBe(true);
  });

  test("logs --dry-run does not rotate", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "x.log"), "x".repeat(2 * 1024 * 1024));
    await cleanup(["logs", "--dry-run"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
    });
    const oks = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(oks.some((m) => m.includes("dry-run"))).toBe(true);
  });

  test("`all` aliases log rotation", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "x.log"), "x".repeat(2 * 1024 * 1024));
    const rc = await cleanup(["all"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
    });
    expect(rc).toBe(0);
    const oks = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(oks.some((m) => m.includes("rotated"))).toBe(true);
  });

  test("logs per-file log emits one line per rotated file (real run)", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "b.log"), "x".repeat(2 * 1024 * 1024));
    await cleanup(["logs"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
    });
    const logs = env.logs.filter((l) => l.kind === "log").map((l) => l.msg);
    expect(logs.some((m) => m.includes("b.log") && m.includes("rotated"))).toBe(true);
  });
});

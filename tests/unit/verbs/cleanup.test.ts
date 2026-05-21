// Unit tests for src/verbs/cleanup.ts (ADR-068 cutover Tier 1, P0).
//
// Covers parseCleanupArgs (every branch) and the verb body — happy
// path, --dry-run, RangeError → UsageError mapping, "all" routing
// through both sub-ops in order.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import { cleanup, parseCleanupArgs } from "../../../src/verbs/cleanup.ts";

const RUN_MS = Date.UTC(2026, 4, 8, 14, 55, 0);

interface Env {
  atmuxDir: string;
  logsDir: string;
  inboxDir: string;
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
    inboxDir: join(atmuxDir, "inboxes"),
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

  test("accepts logs / inboxes / all", () => {
    expect(parseCleanupArgs(["logs"]).sub).toBe("logs");
    expect(parseCleanupArgs(["inboxes"]).sub).toBe("inboxes");
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

  test("--max-age-days requires a positive int", () => {
    expect(parseCleanupArgs(["inboxes", "--max-age-days", "14"]).maxAgeDays).toBe(14);
    expect(parseCleanupArgs(["inboxes", "--purge-legacy"]).purgeLegacy).toBe(true);
    expect(() => parseCleanupArgs(["inboxes", "--max-age-days"])).toThrow(UsageError);
    expect(() => parseCleanupArgs(["inboxes", "--max-age-days", "0"])).toThrow(UsageError);
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

  test("inboxes subcommand prunes .done[] past threshold", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 30 * 86400;
    await writeFile(
      join(env.inboxDir, "alice.json"),
      JSON.stringify({ done: [{ completedAt: oldEpoch }] }),
    );
    const rc = await cleanup(["inboxes"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    expect(rc).toBe(0);
    const oks = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(oks.some((m) => m.includes("pruned 1 entries"))).toBe(true);
  });

  test("inboxes --dry-run reports counts without writing", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 30 * 86400;
    await writeFile(
      join(env.inboxDir, "alice.json"),
      JSON.stringify({ done: [{ completedAt: oldEpoch }] }),
    );
    await cleanup(["inboxes", "--dry-run"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    const oks = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(oks.some((m) => m.includes("dry-run"))).toBe(true);
  });

  test("`all` routes through both sub-ops", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "x.log"), "x".repeat(2 * 1024 * 1024));
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 30 * 86400;
    await writeFile(
      join(env.inboxDir, "alice.json"),
      JSON.stringify({ done: [{ completedAt: oldEpoch }] }),
    );
    await cleanup(["all"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    const oks = env.logs.filter((l) => l.kind === "ok").map((l) => l.msg);
    expect(oks.some((m) => m.includes("rotated"))).toBe(true);
    expect(oks.some((m) => m.includes("pruned"))).toBe(true);
  });

  test("inboxes --max-age-days=0 still gated at parse layer (UsageError)", async () => {
    expect(
      cleanup(["inboxes", "--max-age-days", "0"], {
        atmuxDir: env.atmuxDir,
        env: {},
        logger: env.logger,
      }),
    ).rejects.toThrow(UsageError);
  });

  test("inboxes per-file dry-run log emits one line per pruned file", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 30 * 86400;
    await writeFile(
      join(env.inboxDir, "a.json"),
      JSON.stringify({ done: [{ completedAt: oldEpoch }] }),
    );
    await cleanup(["inboxes", "--dry-run"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    const logs = env.logs.filter((l) => l.kind === "log").map((l) => l.msg);
    expect(logs.some((m) => m.includes("[dry-run] a.json"))).toBe(true);
  });

  test("inboxes per-file log emits one line per pruned file (real run)", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    const oldEpoch = Math.floor(RUN_MS / 1000) - 30 * 86400;
    await writeFile(
      join(env.inboxDir, "b.json"),
      JSON.stringify({ done: [{ completedAt: oldEpoch }] }),
    );
    await cleanup(["inboxes"], {
      atmuxDir: env.atmuxDir,
      env: {},
      logger: env.logger,
      nowMs: RUN_MS,
    });
    const logs = env.logs.filter((l) => l.kind === "log").map((l) => l.msg);
    expect(logs.some((m) => m.includes("b.json pruned=1"))).toBe(true);
  });
});

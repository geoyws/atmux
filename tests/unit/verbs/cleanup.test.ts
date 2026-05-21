// Unit tests for src/verbs/cleanup.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { UsageError } from "../../../src/errors.ts";
import { cleanup, parseCleanupArgs } from "../../../src/verbs/cleanup.ts";

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

describe("parseCleanupArgs", () => {
  test("requires a sub-verb", () => {
    expect(() => parseCleanupArgs([])).toThrow(UsageError);
  });

  test("accepts logs / inboxes / all", () => {
    expect(parseCleanupArgs(["logs"]).sub).toBe("logs");
    expect(parseCleanupArgs(["inboxes"]).sub).toBe("inboxes");
    expect(parseCleanupArgs(["all"]).sub).toBe("all");
  });

  test("rejects removed legacy flags", () => {
    expect(() => parseCleanupArgs(["inboxes", "--max-age-days", "14"])).toThrow(UsageError);
    expect(() => parseCleanupArgs(["inboxes", "--purge-legacy"])).toThrow(UsageError);
  });
});

describe("cleanup verb", () => {
  test("logs subcommand rotates >cap files", async () => {
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "report.log"), "x".repeat(2 * 1024 * 1024));
    const rc = await cleanup(["logs"], { atmuxDir: env.atmuxDir, env: {}, logger: env.logger });
    expect(rc).toBe(0);
    expect(env.logs.some((l) => l.kind === "ok" && l.msg.includes("1 rotated"))).toBe(true);
  });

  test("inboxes removes legacy json when state.db present", async () => {
    const db = openDatabase(join(env.atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "gitter.json"), "{}");
    await writeFile(join(env.inboxDir, "gitter.json.lock"), "");
    const rc = await cleanup(["inboxes"], { atmuxDir: env.atmuxDir, env: {}, logger: env.logger });
    expect(rc).toBe(0);
    expect(await readdir(env.inboxDir)).toEqual([]);
  });

  test("inboxes skipped when state.db absent", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "gitter.json"), "{}");
    await cleanup(["inboxes"], { atmuxDir: env.atmuxDir, env: {}, logger: env.logger });
    expect(await readdir(env.inboxDir)).toContain("gitter.json");
    expect(env.logs.some((l) => l.msg.includes("skipped (no state.db)"))).toBe(true);
  });

  test("`all` runs logs then inboxes", async () => {
    const db = openDatabase(join(env.atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await mkdir(env.logsDir, { recursive: true });
    await writeFile(join(env.logsDir, "x.log"), "x".repeat(2 * 1024 * 1024));
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "a.json"), "{}");
    await cleanup(["all"], { atmuxDir: env.atmuxDir, env: {}, logger: env.logger });
    expect(env.logs.some((l) => l.msg.includes("rotated"))).toBe(true);
    expect(env.logs.some((l) => l.msg.includes("removed 1 legacy file(s)"))).toBe(true);
  });
});

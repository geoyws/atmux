// Unit tests for src/core/cleanup.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { removeLegacyInboxFiles, rotateLogs } from "../../../src/core/cleanup.ts";

interface Env {
  root: string;
  atmuxDir: string;
  logsDir: string;
  inboxDir: string;
}

let env: Env;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "atmux-cleanup-core-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(join(atmuxDir, "logs"), { recursive: true });
  env = {
    root,
    atmuxDir,
    logsDir: join(atmuxDir, "logs"),
    inboxDir: join(atmuxDir, "inboxes"),
  };
});

afterEach(async () => {
  await rm(env.root, { recursive: true, force: true });
});

describe("rotateLogs", () => {
  test("returns empty when logs/ absent", async () => {
    await rm(env.logsDir, { recursive: true, force: true });
    const got = await rotateLogs(env.atmuxDir);
    expect(got.rotated).toEqual([]);
  });

  test("rotates files over cap", async () => {
    const path = join(env.logsDir, "big.log");
    await writeFile(path, "x".repeat(2 * 1024 * 1024));
    const got = await rotateLogs(env.atmuxDir, { maxBytes: 1024 });
    expect(got.rotated).toHaveLength(1);
    expect(await readFile(`${path}.1`, "utf8")).toHaveLength(2 * 1024 * 1024);
    expect(await readFile(path, "utf8")).toBe("");
  });
});

describe("removeLegacyInboxFiles", () => {
  test("skipped when state.db absent", async () => {
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "gitter.json"), "{}");
    const got = await removeLegacyInboxFiles(env.atmuxDir);
    expect(got.skipped).toBe(true);
    expect(got.removed).toEqual([]);
  });

  test("removes legacy json + sidecars when state.db present", async () => {
    const db = openDatabase(join(env.atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "gitter.json"), "{}");
    await writeFile(join(env.inboxDir, "gitter.json.lock"), "");
    const got = await removeLegacyInboxFiles(env.atmuxDir);
    expect(got.skipped).toBe(false);
    expect(got.removed.sort()).toEqual(["gitter.json", "gitter.json.lock"]);
  });

  test("dry-run lists without deleting", async () => {
    const db = openDatabase(join(env.atmuxDir, "state.db"), migrations);
    closeDatabase(db);
    await mkdir(env.inboxDir, { recursive: true });
    await writeFile(join(env.inboxDir, "alpha.json"), "{}");
    const got = await removeLegacyInboxFiles(env.atmuxDir, { dryRun: true });
    expect(got.removed).toEqual(["alpha.json"]);
    await readFile(join(env.inboxDir, "alpha.json"), "utf8");
  });
});

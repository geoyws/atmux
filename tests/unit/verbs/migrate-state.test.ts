// Unit tests for src/verbs/migrate-state.ts (ADR-060 dogfood-now scope).
//
// Strategy: per-test tmpdir as `.atmux/`, seed kanban.json + (later)
// inbox + state files, run the verb with explicit `--team-dir` +
// `--db-path` injection, assert observable side-effects (DB rows,
// archive moves, audit record). No mocks of bun:sqlite — we open
// the real DB and SELECT to verify.
//
// 100% narrowed coverage (ADR-009 §2): every branch of
// parseMigrateArgs + every branch of migrateState body. Property:
// re-running the verb on an already-migrated kanban is idempotent
// (row counts unchanged, archive dir unchanged).

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readText } from "../../../src/abstractions/fs.ts";
import type { Logger } from "../../../src/core/tui.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { migrateState, parseMigrateArgs } from "../../../src/verbs/migrate-state.ts";

// ---------- Fixture ----------

interface TestEnv {
  atmuxDir: string;
  dbPath: string;
  logger: Logger;
  logLines: string[];
  stdoutBuf: string[];
}

async function makeEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), "atmux-migrate-state-"));
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  const logLines: string[] = [];
  const logger: Logger = {
    log: (m) => logLines.push(`LOG ${m}`),
    ok: (m) => logLines.push(`OK ${m}`),
    warn: (m) => logLines.push(`WARN ${m}`),
    err: (m) => logLines.push(`ERR ${m}`),
  };
  return {
    atmuxDir,
    dbPath: join(atmuxDir, "state.db"),
    logger,
    logLines,
    stdoutBuf: [],
  };
}

async function teardown(env: TestEnv): Promise<void> {
  await rm(join(env.atmuxDir, ".."), { recursive: true, force: true });
}

const SAMPLE_KANBAN = {
  tasks: [
    {
      id: "t-aaaa1111",
      subject: "first task",
      body: "task body",
      status: "todo",
      owner: null,
      deps: [],
      priority: null,
      epic: "e-ep000001",
      story: null,
      lane: "fe",
      deliverable: null,
      staleMin: null,
      driverOnly: false,
      createdAt: 1730000000,
      claimedAt: null,
      completedAt: null,
      claimedFrom: null,
      createdFrom: "test",
      note: null,
    },
    {
      id: "t-bbbb2222",
      subject: "second task",
      status: "in-progress",
      owner: "fe0",
      lane: "fe",
      createdAt: 1730000100,
    },
  ],
  epics: [
    {
      id: "e-ep000001",
      title: "demo epic",
      status: "in-progress",
      createdAt: 1729999000,
      stories: ["s-st000001"],
    },
  ],
  stories: [
    {
      id: "s-st000001",
      epic: "e-ep000001",
      title: "demo story",
      status: "ready",
      createdAt: 1729999500,
      reviewSignoff: false,
    },
  ],
};

async function seedKanban(env: TestEnv, payload: unknown = SAMPLE_KANBAN): Promise<void> {
  await writeFile(join(env.atmuxDir, "kanban.json"), JSON.stringify(payload, null, 2), "utf8");
}

// ---------- parseMigrateArgs ----------

describe("parseMigrateArgs", () => {
  test("happy path: bare json-to-sqlite", () => {
    const p = parseMigrateArgs(["json-to-sqlite"]);
    expect(p.dryRun).toBe(false);
    expect(p.target).toBe("all");
    expect(p.teamDir).toBeUndefined();
    expect(p.dbPath).toBeUndefined();
  });

  test("--team-dir + --dry-run + --target=kanban + --db-path", () => {
    const p = parseMigrateArgs([
      "json-to-sqlite",
      "--team-dir",
      "/tmp/foo",
      "--dry-run",
      "--target=kanban",
      "--db-path",
      "/tmp/foo.db",
    ]);
    expect(p.teamDir).toBe("/tmp/foo");
    expect(p.dryRun).toBe(true);
    expect(p.target).toBe("kanban");
    expect(p.dbPath).toBe("/tmp/foo.db");
  });

  test("missing sub-verb throws UsageError", () => {
    expect(() => parseMigrateArgs([])).toThrow(UsageError);
  });

  test("unknown sub-verb throws UsageError", () => {
    expect(() => parseMigrateArgs(["sqlite-to-json"])).toThrow(UsageError);
  });

  test("--team-dir without value throws UsageError", () => {
    expect(() => parseMigrateArgs(["json-to-sqlite", "--team-dir"])).toThrow(UsageError);
  });

  test("--db-path without value throws UsageError", () => {
    expect(() => parseMigrateArgs(["json-to-sqlite", "--db-path"])).toThrow(UsageError);
  });

  test("--target=bogus throws UsageError", () => {
    expect(() => parseMigrateArgs(["json-to-sqlite", "--target=bogus"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseMigrateArgs(["json-to-sqlite", "--zzz"])).toThrow(UsageError);
  });
});

// ---------- migrateState — happy paths ----------

describe("migrateState", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  test("kanban target: rows populated + archive moved + audit record", async () => {
    await seedKanban(env);

    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban"],
      {
        logger: env.logger,
        stdout: (s) => env.stdoutBuf.push(s),
      },
    );

    expect(exit).toBe(0);

    // DB exists + has rows.
    expect(await exists(env.dbPath)).toBe(true);
    const db = new Database(env.dbPath, { readonly: true });
    try {
      const taskCount = (db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n;
      expect(taskCount).toBe(2);
      const epicCount = (db.query("SELECT COUNT(*) as n FROM epics").get() as { n: number }).n;
      expect(epicCount).toBe(1);
      const storyCount = (db.query("SELECT COUNT(*) as n FROM stories").get() as { n: number }).n;
      expect(storyCount).toBe(1);

      // Pickup-test on individual fields — schema bridge round-trip.
      const t = db.query("SELECT * FROM tasks WHERE id = $id").get({ $id: "t-aaaa1111" }) as {
        subject: string;
        status: string;
        lane: string;
      };
      expect(t.subject).toBe("first task");
      expect(t.status).toBe("todo");
      expect(t.lane).toBe("fe");
    } finally {
      db.close();
    }

    // Original kanban.json moved into archive/.
    expect(await exists(join(env.atmuxDir, "kanban.json"))).toBe(false);

    // Audit record present.
    const auditPath = join(env.atmuxDir, "migration-state-sqlite.json");
    expect(await exists(auditPath)).toBe(true);
    const audit = JSON.parse(await readText(auditPath));
    expect(audit.target).toBe("kanban");
    expect(audit.counts.kanban).toEqual({ tasks: 2, epics: 1, stories: 1 });
    expect(audit.schemaVersion).toBe(1);
  });

  test("--dry-run: no DB writes (DB created but empty), no archive move, no audit", async () => {
    await seedKanban(env);

    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban", "--dry-run"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );

    expect(exit).toBe(0);

    // kanban.json STAYS (not archived under --dry-run).
    expect(await exists(join(env.atmuxDir, "kanban.json"))).toBe(true);

    // Audit NOT written.
    expect(await exists(join(env.atmuxDir, "migration-state-sqlite.json"))).toBe(false);

    // DB file gets created (because openDatabase always opens), but empty.
    const db = new Database(env.dbPath, { readonly: true });
    try {
      const taskCount = (db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n;
      expect(taskCount).toBe(0);
    } finally {
      db.close();
    }

    // Logger reports dry-run.
    expect(env.logLines.some((l) => l.includes("dry-run OK"))).toBe(true);
  });

  test("idempotent: re-running on same kanban is a no-op count-wise", async () => {
    await seedKanban(env);

    // First run.
    await migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban"], {
      logger: env.logger,
      stdout: (s) => env.stdoutBuf.push(s),
    });

    // kanban.json is now in archive; re-seed for a 2nd-run scenario where
    // operator added new tasks and re-runs the migration.
    const updated = {
      ...SAMPLE_KANBAN,
      tasks: [
        ...SAMPLE_KANBAN.tasks,
        {
          id: "t-cccc3333",
          subject: "added later",
          status: "todo",
          createdAt: 1730000200,
        },
      ],
    };
    await seedKanban(env, updated);

    await migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban"], {
      logger: env.logger,
      stdout: (s) => env.stdoutBuf.push(s),
    });

    const db = new Database(env.dbPath, { readonly: true });
    try {
      const taskCount = (db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number }).n;
      expect(taskCount).toBe(3); // 2 original + 1 added; no dupes from re-upsert
    } finally {
      db.close();
    }
  });

  test("missing kanban.json throws ConfigError", async () => {
    await expect(
      migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban"], {
        logger: env.logger,
        stdout: (s) => env.stdoutBuf.push(s),
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("--target=inboxes succeeds with empty inboxes dir (ADR-076)", async () => {
    // No inboxes dir seeded — migrateInboxes returns zero-counts cleanly.
    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=inboxes"],
      {
        logger: env.logger,
        stdout: (s) => env.stdoutBuf.push(s),
      },
    );
    expect(exit).toBe(0);
    const auditPath = join(env.atmuxDir, "migration-state-sqlite.json");
    const audit = JSON.parse(await readText(auditPath));
    expect(audit.counts.inboxes).toEqual({
      files: 0,
      entriesSeen: 0,
      entriesBackfilled: 0,
      entriesPresent: 0,
      filesSkippedInvalid: 0,
    });
  });

  test("--target=state throws ConfigError (not implemented)", async () => {
    await expect(
      migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=state"], {
        logger: env.logger,
        stdout: (s) => env.stdoutBuf.push(s),
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("--target=all runs kanban + inboxes; warns about state-target only (ADR-076)", async () => {
    await seedKanban(env);

    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=all"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );

    expect(exit).toBe(0);

    const auditPath = join(env.atmuxDir, "migration-state-sqlite.json");
    const audit = JSON.parse(await readText(auditPath));
    // After ADR-076 inboxes target landed, only state target stays unimplemented;
    // the inboxes-skipped warning is gone.
    expect(audit.warnings.length).toBe(1);
    expect(audit.warnings[0]).toContain("state target skipped");
    expect(audit.counts.kanban).toEqual({ tasks: 2, epics: 1, stories: 1 });
    expect(audit.counts.inboxes).toEqual({
      files: 0,
      entriesSeen: 0,
      entriesBackfilled: 0,
      entriesPresent: 0,
      filesSkippedInvalid: 0,
    });
  });

  test("--db-path overrides default dbPath", async () => {
    await seedKanban(env);
    const customDb = join(env.atmuxDir, "custom-state.db");

    await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban", "--db-path", customDb],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );

    expect(await exists(customDb)).toBe(true);
    expect(await exists(env.dbPath)).toBe(false); // default path NOT used
  });
});

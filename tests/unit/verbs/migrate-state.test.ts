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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exists, readText } from "../../../src/abstractions/fs.ts";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { FlagsRepo } from "../../../src/core/flags-repo.ts";
import { RoleStateRepo } from "../../../src/core/role-state-repo.ts";
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

  test("--target=all runs kanban + inboxes + flags + role-state; warns state + empty cockpit (ADR-076)", async () => {
    await seedKanban(env);
    // Fake HOME keeps the cockpit-scope flags migration hermetic — the
    // verb must never touch the operator's real ~/.atmux in tests.
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-all-home-"));
    try {
      const exit = await migrateState(
        ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=all"],
        {
          logger: env.logger,
          stdout: (s) => env.stdoutBuf.push(s),
          env: { ...process.env, HOME: fakeHome },
        },
      );

      expect(exit).toBe(0);

      const auditPath = join(env.atmuxDir, "migration-state-sqlite.json");
      const audit = JSON.parse(await readText(auditPath));
      // After ADR-076 inboxes target landed, only state target stays unimplemented;
      // the inboxes-skipped warning is gone. Flags ran with zero sources.
      expect(audit.warnings.length).toBe(2);
      expect(audit.warnings[0]).toContain("no cockpit sources");
      expect(audit.warnings[1]).toContain("state target skipped");
      expect(audit.counts.kanban).toEqual({ tasks: 2, epics: 1, stories: 1 });
      expect(audit.counts.inboxes).toEqual({
        files: 0,
        entriesSeen: 0,
        entriesBackfilled: 0,
        entriesPresent: 0,
        filesSkippedInvalid: 0,
      });
      expect(audit.counts.flags).toEqual({
        filesSeen: 0,
        flagsWritten: 0,
        filesSkippedInvalid: 0,
        filesSkippedRowExists: 0,
      });
      expect(audit.counts.roleState).toEqual({
        filesSeen: 0,
        rowsWritten: 0,
        filesSkippedInvalid: 0,
        filesSkippedRowExists: 0,
      });
      // No cockpit DB is created when no cockpit sources exist.
      expect(await exists(join(fakeHome, ".atmux", "state.db"))).toBe(false);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
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

// ---------- --target=flags (ADR-169 P1, e-38) ----------

describe("migrateState --target=flags", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });
  async function seedFlag(env: TestEnv, key: string, text: string): Promise<string> {
    const p = join(env.atmuxDir, "state", `${key}.json`);
    await mkdir(join(env.atmuxDir, "state"), { recursive: true });
    await writeFile(p, text, "utf8");
    return p;
  }

  function flagValue(dbPath: string, key: string): string | null {
    const db = openDatabase(dbPath, migrations);
    try {
      return new FlagsRepo(db).get(key);
    } finally {
      closeDatabase(db);
    }
  }

  test("import + archive: valid sources become rows, files move to archive", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-flags-home-"));
    try {
      await seedFlag(env, "paused", JSON.stringify({ paused: true }));
      await seedFlag(env, "resume", JSON.stringify({ pending: [] }));
      const exit = await migrateState(
        ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags"],
        {
          logger: env.logger,
          stdout: (s) => env.stdoutBuf.push(s),
          env: { ...process.env, HOME: fakeHome },
        },
      );
      expect(exit).toBe(0);
      expect(flagValue(env.dbPath, "paused")).toBe(JSON.stringify({ paused: true }));
      expect(flagValue(env.dbPath, "resume")).toBe(JSON.stringify({ pending: [] }));
      expect(await exists(join(env.atmuxDir, "state", "paused.json"))).toBe(false);
      const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
      expect(audit.counts.flags).toEqual({
        filesSeen: 2,
        flagsWritten: 2,
        filesSkippedInvalid: 0,
        filesSkippedRowExists: 0,
      });
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("invalid JSON: skipped, warned, left in place", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-flags-bad-"));
    try {
      const p = await seedFlag(env, "paused", "{not-json");
      const exit = await migrateState(
        ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags"],
        {
          logger: env.logger,
          stdout: (s) => env.stdoutBuf.push(s),
          env: { ...process.env, HOME: fakeHome },
        },
      );
      expect(exit).toBe(0);
      expect(flagValue(env.dbPath, "paused")).toBe(null);
      expect(await exists(p)).toBe(true);
      expect(env.logLines.some((l) => l.includes("not valid JSON"))).toBe(true);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("row exists: redundant source archived, write skipped", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-flags-dup-"));
    try {
      await seedFlag(env, "paused", JSON.stringify({ paused: true }));
      const run = (extraEnv: NodeJS.ProcessEnv = {}) =>
        migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags"], {
          logger: env.logger,
          stdout: (s) => env.stdoutBuf.push(s),
          env: { ...process.env, HOME: fakeHome, ...extraEnv },
        });
      expect(await run()).toBe(0);
      // Re-seed the same key after archival, with different content.
      await seedFlag(env, "paused", JSON.stringify({ paused: false }));
      expect(await run()).toBe(0);
      // Original row wins; redundant source archived anyway.
      expect(flagValue(env.dbPath, "paused")).toBe(JSON.stringify({ paused: true }));
      expect(await exists(join(env.atmuxDir, "state", "paused.json"))).toBe(false);
      expect(env.logLines.some((l) => l.includes("row already present"))).toBe(true);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("dry-run: counts without writes or archive moves", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-flags-dry-"));
    try {
      const p = await seedFlag(env, "paused", JSON.stringify({ paused: true }));
      const exit = await migrateState(
        ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags", "--dry-run"],
        {
          logger: env.logger,
          stdout: (s) => env.stdoutBuf.push(s),
          env: { ...process.env, HOME: fakeHome },
        },
      );
      expect(exit).toBe(0);
      expect(flagValue(env.dbPath, "paused")).toBe(null);
      expect(await exists(p)).toBe(true);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  test("HOME unset: team scope migrates, cockpit skipped with warning", async () => {
    await seedFlag(env, "paused", JSON.stringify({ paused: true }));
    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s), env: {} },
    );
    expect(exit).toBe(0);
    expect(flagValue(env.dbPath, "paused")).toBe(JSON.stringify({ paused: true }));
    expect(env.logLines.some((l) => l.includes("HOME unset"))).toBe(true);
  });

  test("idempotent re-run: second pass sees zero files", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-flags-idem-"));
    const run = () =>
      migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags"], {
        logger: env.logger,
        stdout: (s) => env.stdoutBuf.push(s),
        env: { ...process.env, HOME: fakeHome },
      });
    try {
      await seedFlag(env, "paused", JSON.stringify({ paused: true }));
      expect(await run()).toBe(0);
      expect(await run()).toBe(0);
      const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
      expect(audit.counts.flags.filesSeen).toBe(0);
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
// ---------- --target=role-state (ADR-169 P2, e-38) ----------

describe("migrateState --target=role-state", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  async function seedState(env: TestEnv, filename: string, text: string): Promise<string> {
    const p = join(env.atmuxDir, "state", filename);
    await mkdir(join(env.atmuxDir, "state"), { recursive: true });
    await writeFile(p, text, "utf8");
    return p;
  }

  function roleValue(dbPath: string, role: string, namespace: string): string | null {
    const db = openDatabase(dbPath, migrations);
    try {
      return new RoleStateRepo(db).get(role, namespace);
    } finally {
      closeDatabase(db);
    }
  }

  const runRoleState = (extra: ReadonlyArray<string> = []) =>
    migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=role-state", ...extra], {
      logger: env.logger,
      stdout: (s) => env.stdoutBuf.push(s),
      env: { ...process.env },
    });

  test("import + archive: glob + team files become rows, sources move to archive", async () => {
    await seedState(env, "cost-alpha.json", JSON.stringify({ member: "alpha", usd: 1 }));
    await seedState(env, "cost-bravo.json", JSON.stringify({ member: "bravo", usd: 2 }));
    await seedState(
      env,
      "modal-history-alpha.json",
      JSON.stringify([{ member: "alpha", modalClass: "choice-prompt" }]),
    );
    await seedState(env, "heads-up-cursor.json", JSON.stringify({ "a:b": 5 }));
    await seedState(env, "brief-versions.json", JSON.stringify({ worker: { version: "v1" } }));
    await seedState(env, "ombudsman-pending.json", JSON.stringify({ pending: [] }));
    // Non-tracking files are not ours — budget stays JSON per OQ-3.
    await seedState(env, "budget-pause.json", JSON.stringify({ paused: true }));
    await seedState(env, "random.json", JSON.stringify({ whatever: 1 }));
    await seedState(env, "notes.txt", "not json at all");

    expect(await runRoleState()).toBe(0);
    expect(roleValue(env.dbPath, "alpha", "cost")).toBe(
      JSON.stringify({ member: "alpha", usd: 1 }),
    );
    expect(roleValue(env.dbPath, "bravo", "cost")).toBe(
      JSON.stringify({ member: "bravo", usd: 2 }),
    );
    expect(roleValue(env.dbPath, "alpha", "modal-history")).toBe(
      JSON.stringify([{ member: "alpha", modalClass: "choice-prompt" }]),
    );
    expect(roleValue(env.dbPath, "_", "heads-up-cursor")).toBe(JSON.stringify({ "a:b": 5 }));
    expect(roleValue(env.dbPath, "_", "brief-versions")).toBe(
      JSON.stringify({ worker: { version: "v1" } }),
    );
    expect(roleValue(env.dbPath, "_", "ombudsman-pending")).toBe(JSON.stringify({ pending: [] }));
    for (const f of [
      "cost-alpha.json",
      "cost-bravo.json",
      "modal-history-alpha.json",
      "heads-up-cursor.json",
      "brief-versions.json",
      "ombudsman-pending.json",
    ]) {
      expect(await exists(join(env.atmuxDir, "state", f))).toBe(false);
    }
    // Out-of-scope files stay put.
    expect(await exists(join(env.atmuxDir, "state", "budget-pause.json"))).toBe(true);
    expect(await exists(join(env.atmuxDir, "state", "random.json"))).toBe(true);
    const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
    expect(audit.counts.roleState).toEqual({
      filesSeen: 6,
      rowsWritten: 6,
      filesSkippedInvalid: 0,
      filesSkippedRowExists: 0,
    });
    expect(env.logLines.some((l) => l.includes("6 role_state rows"))).toBe(true);
  });

  test("invalid JSON: skipped, warned, left in place", async () => {
    const p = await seedState(env, "cost-alpha.json", "{not-json");
    expect(await runRoleState()).toBe(0);
    expect(roleValue(env.dbPath, "alpha", "cost")).toBe(null);
    expect(await exists(p)).toBe(true);
    expect(env.logLines.some((l) => l.includes("not valid JSON"))).toBe(true);
  });

  test("row exists: redundant source archived, write skipped", async () => {
    await seedState(env, "heads-up-cursor.json", JSON.stringify({ "a:b": 1 }));
    expect(await runRoleState()).toBe(0);
    // Re-seed the same namespace after archival, with different content.
    await seedState(env, "heads-up-cursor.json", JSON.stringify({ "a:b": 2 }));
    expect(await runRoleState()).toBe(0);
    // Original row wins; redundant source archived anyway.
    expect(roleValue(env.dbPath, "_", "heads-up-cursor")).toBe(JSON.stringify({ "a:b": 1 }));
    expect(await exists(join(env.atmuxDir, "state", "heads-up-cursor.json"))).toBe(false);
    expect(env.logLines.some((l) => l.includes("row already present"))).toBe(true);
  });

  test("dry-run: counts without writes or archive moves", async () => {
    const p = await seedState(env, "cost-alpha.json", JSON.stringify({ member: "alpha" }));
    expect(await runRoleState(["--dry-run"])).toBe(0);
    expect(roleValue(env.dbPath, "alpha", "cost")).toBe(null);
    expect(await exists(p)).toBe(true);
    expect(env.logLines.some((l) => l.includes("dry-run OK"))).toBe(true);
  });

  test("empty role stems + missing state dir: nothing seen, nothing written", async () => {
    await seedState(env, "cost-.json", JSON.stringify({ member: "" }));
    await seedState(env, "modal-history-.json", JSON.stringify([]));
    expect(await runRoleState()).toBe(0);
    const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
    expect(audit.counts.roleState.filesSeen).toBe(0);
    expect(await exists(join(env.atmuxDir, "state", "cost-.json"))).toBe(true);

    // Fresh team without a state/ dir at all.
    const fresh = await makeEnv();
    try {
      const exit = await migrateState(
        ["json-to-sqlite", "--team-dir", fresh.atmuxDir, "--target=role-state"],
        { logger: fresh.logger, stdout: (s) => fresh.stdoutBuf.push(s), env: { ...process.env } },
      );
      expect(exit).toBe(0);
      const freshAudit = JSON.parse(
        await readText(join(fresh.atmuxDir, "migration-state-sqlite.json")),
      );
      expect(freshAudit.counts.roleState.filesSeen).toBe(0);
    } finally {
      await teardown(fresh);
    }
  });

  test("idempotent re-run: second pass sees zero files", async () => {
    await seedState(env, "cost-alpha.json", JSON.stringify({ member: "alpha" }));
    expect(await runRoleState()).toBe(0);
    expect(await runRoleState()).toBe(0);
    const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
    expect(audit.counts.roleState.filesSeen).toBe(0);
  });

  test("parses --target=role-state", () => {
    expect(parseMigrateArgs(["json-to-sqlite", "--target=role-state"]).target).toBe("role-state");
  });
});
// ---------- Coverage backfill (t-981f2f3f slice 3: 100% lines on migrate-state.ts) ----------
//
// The suites above leave the inboxes backfill body (migrateInboxes with a
// populated inboxes/ dir, dry-run probe, invalid-file skips) and the
// cockpit-scope flags branch (present cockpit sources) uncovered. These
// tests exercise those paths with real temp dirs + real SQLite files.

describe("migrateState coverage backfill", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });

  afterEach(async () => {
    await teardown(env);
  });

  async function seedInbox(env: TestEnv, member: string, payload: unknown): Promise<string> {
    const dir = join(env.atmuxDir, "inboxes");
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${member}.json`);
    await writeFile(p, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
    return p;
  }

  function taskRows(
    dbPath: string,
  ): Array<{ id: string; subject: string | null; extra: string | null }> {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query("SELECT id, subject, extra FROM tasks ORDER BY id").all() as Array<{
        id: string;
        subject: string | null;
        extra: string | null;
      }>;
    } finally {
      db.close();
    }
  }

  test("inboxes happy path: buckets backfilled, dispatchedAt stripped, non-json ignored", async () => {
    await seedInbox(env, "alice", {
      pending: [
        {
          id: "t-aaa10001",
          subject: "inbox pending",
          status: "todo",
          lane: "fe",
          createdAt: 1730000000,
          dispatchedAt: 1730000050,
        },
      ],
      inProgress: [
        {
          id: "t-aaa10002",
          subject: "inbox claimed",
          status: "in-progress",
          owner: "alice",
          claimedAt: 1730000060,
          dispatchedAt: 1730000055,
        },
      ],
      done: [],
    });
    await seedInbox(env, "bob", {
      pending: [],
      inProgress: [],
      done: [{ id: "t-aaa10003", subject: "inbox done", status: "done", completedAt: 1730000070 }],
    });
    // Lockfiles + stray files never enter the migration.
    await writeFile(join(env.atmuxDir, "inboxes", "alice.json.lock"), "locked", "utf8");
    await writeFile(join(env.atmuxDir, "inboxes", "notes.txt"), "not an inbox", "utf8");

    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=inboxes"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );
    expect(exit).toBe(0);

    const rows = taskRows(env.dbPath);
    expect(rows.map((r) => r.id)).toEqual(["t-aaa10001", "t-aaa10002", "t-aaa10003"]);
    expect(rows[0]?.subject).toBe("inbox pending");
    // dispatchedAt is inbox-only: it must not leak into the tasks extra column.
    const extra =
      rows[0]?.extra === null
        ? {}
        : (JSON.parse(rows[0]?.extra ?? "{}") as Record<string, unknown>);
    expect("dispatchedAt" in extra).toBe(false);

    const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
    expect(audit.counts.inboxes).toEqual({
      files: 2,
      entriesSeen: 3,
      entriesBackfilled: 3,
      entriesPresent: 0,
      filesSkippedInvalid: 0,
    });
  });

  test("inboxes present-vs-backfilled: dry-run probes, real run upserts", async () => {
    await seedKanban(env, {
      ...SAMPLE_KANBAN,
      tasks: [
        {
          id: "t-keep0001",
          subject: "already in kanban",
          status: "todo",
          lane: "fe",
          createdAt: 1730000000,
        },
      ],
      epics: [],
      stories: [],
    });
    expect(
      await migrateState(["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=kanban"], {
        logger: env.logger,
        stdout: (s) => env.stdoutBuf.push(s),
      }),
    ).toBe(0);

    await seedInbox(env, "carol", {
      pending: [
        {
          id: "t-keep0001",
          subject: "already in kanban",
          status: "todo",
          dispatchedAt: 1730000050,
        },
        { id: "t-new00002", subject: "kanban never saw this", status: "todo" },
      ],
      inProgress: [],
      done: [],
    });

    const dryExit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=inboxes", "--dry-run"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );
    expect(dryExit).toBe(0);
    const drySummary = JSON.parse(env.stdoutBuf.at(-1) ?? "{}") as {
      counts: { inboxes: { entriesBackfilled: number; entriesPresent: number } };
    };
    expect(drySummary.counts.inboxes.entriesBackfilled).toBe(1);
    expect(drySummary.counts.inboxes.entriesPresent).toBe(1);
    // Dry-run writes nothing.
    expect(taskRows(env.dbPath).map((r) => r.id)).toEqual(["t-keep0001"]);

    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=inboxes"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );
    expect(exit).toBe(0);
    expect(taskRows(env.dbPath).map((r) => r.id)).toEqual(["t-keep0001", "t-new00002"]);
    const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
    expect(audit.counts.inboxes.entriesBackfilled).toBe(1);
    expect(audit.counts.inboxes.entriesPresent).toBe(1);
  });

  test("inboxes invalid files: skipped, counted, warned", async () => {
    await seedInbox(env, "good", {
      pending: [{ id: "t-good0001", subject: "survivor", status: "todo" }],
      inProgress: [],
      done: [],
    });
    await seedInbox(env, "bad-json", "{not-json");
    await seedInbox(env, "bad-schema", { pending: "nope", inProgress: [], done: [] });
    // Dangling symlink: listed by readdir, unreadable by readText.
    await mkdir(join(env.atmuxDir, "inboxes"), { recursive: true });
    await symlink(
      join(env.atmuxDir, "inboxes", "missing-target.json"),
      join(env.atmuxDir, "inboxes", "ghost.json"),
    );

    const exit = await migrateState(
      ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=inboxes"],
      { logger: env.logger, stdout: (s) => env.stdoutBuf.push(s) },
    );
    expect(exit).toBe(0);
    expect(taskRows(env.dbPath).map((r) => r.id)).toEqual(["t-good0001"]);
    const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
    expect(audit.counts.inboxes.files).toBe(1);
    expect(audit.counts.inboxes.filesSkippedInvalid).toBe(3);
    expect(env.logLines.some((l) => l.includes("failed Zod parse"))).toBe(true);
  });

  test("flags cockpit scope: present sources migrate to the cockpit DB + archive", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "atmux-migrate-flags-cockpit-"));
    try {
      const teamPath = join(env.atmuxDir, "state", "paused.json");
      await mkdir(join(env.atmuxDir, "state"), { recursive: true });
      await writeFile(teamPath, JSON.stringify({ paused: true }), "utf8");
      const cockpitStateDir = join(fakeHome, ".atmux", "state");
      await mkdir(cockpitStateDir, { recursive: true });
      const pulseText = JSON.stringify({ enabled: true });
      const sentinelText = JSON.stringify({ armed: false });
      await writeFile(join(cockpitStateDir, "pulse-state.json"), pulseText, "utf8");
      await writeFile(join(cockpitStateDir, "sentinel-state.json"), sentinelText, "utf8");

      const exit = await migrateState(
        ["json-to-sqlite", "--team-dir", env.atmuxDir, "--target=flags"],
        {
          logger: env.logger,
          stdout: (s) => env.stdoutBuf.push(s),
          env: { ...process.env, HOME: fakeHome },
        },
      );
      expect(exit).toBe(0);

      // Team row landed in the team DB.
      const teamDb = openDatabase(env.dbPath, migrations);
      try {
        expect(new FlagsRepo(teamDb).get("paused")).toBe(JSON.stringify({ paused: true }));
      } finally {
        closeDatabase(teamDb);
      }
      // Cockpit rows landed in ~/.atmux/state.db, sources archived away.
      const cockpitDbPath = join(fakeHome, ".atmux", "state.db");
      const cockpitDb = openDatabase(cockpitDbPath, migrations);
      try {
        expect(new FlagsRepo(cockpitDb).get("pulse-state")).toBe(pulseText);
        expect(new FlagsRepo(cockpitDb).get("sentinel-state")).toBe(sentinelText);
      } finally {
        closeDatabase(cockpitDb);
      }
      expect(await exists(join(cockpitStateDir, "pulse-state.json"))).toBe(false);
      expect(await exists(join(cockpitStateDir, "sentinel-state.json"))).toBe(false);
      expect(await exists(teamPath)).toBe(false);

      const audit = JSON.parse(await readText(join(env.atmuxDir, "migration-state-sqlite.json")));
      expect(audit.counts.flags).toEqual({
        filesSeen: 3,
        flagsWritten: 3,
        filesSkippedInvalid: 0,
        filesSkippedRowExists: 0,
      });
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});

// Unit tests for src/verbs/migrate-hex-ids.ts (T4.2 / ADR-202 §XIII).
//
// Six AC cases per t-57d26826:
//   1. Dry-run no-op
//   2. --apply happy path (kanban rewrite + sequences advanced + snapshot)
//   3. No-legacy-ids no-op
//   4. Partial scope (--scope epics)
//   5. Missing-branch graceful skip
//   6. Idempotent re-run
//
// Strategy: real bun:sqlite, real tmp filesystem, real `git init` so
// branch-rename spawns hit real git. ATMUX_DIR + cwd are pinned per
// test so getAtmuxDir() / loadTeam() resolve to our scratch dir
// without leaking into other tests or the operator's worktree.

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { migrateHexIds } from "../../../src/verbs/migrate-hex-ids.ts";

interface TestEnv {
  scratch: string;
  atmuxDir: string;
  db: Database;
  stdout: string[];
  stdoutWriter: (s: string) => void;
  logger: {
    log: (m: string) => void;
    ok: (m: string) => void;
    warn: (m: string) => void;
    err: (m: string) => void;
  };
  logs: { kind: string; msg: string }[];
}

let env: TestEnv;
let priorCwd: string;
let priorAtmuxDir: string | undefined;

function runGit(cwd: string, argv: ReadonlyArray<string>): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout, code: code ?? -1 });
    });
  });
}

function seedTeamJson(
  atmuxDir: string,
  opts: { parentEpicKanbanId?: string; parentBase?: string; includeEpicTeam?: boolean } = {},
): Promise<void> {
  const team: Record<string, unknown> = {
    name: "team-alpha",
    members: [],
  };
  if (opts.includeEpicTeam !== false) {
    team.epicTeam = {
      parent: "atmux",
      parentEpicKanbanId: opts.parentEpicKanbanId ?? "e-aaaaaaaa",
      parentBase: opts.parentBase ?? "atmux-test-base",
    };
  }
  return writeFile(join(atmuxDir, "team.json"), JSON.stringify(team, null, 2));
}

/** Insert a legacy hex-only kanban row of the given kind. */
function seedLegacy(
  db: Database,
  kind: "tasks" | "stories" | "epics",
  id: string,
  extra: { epic?: string; story?: string; deps?: string; stories?: string } = {},
): void {
  const now = Math.floor(Date.now() / 1000);
  if (kind === "tasks") {
    db.prepare(
      `INSERT INTO tasks (id, subject, body, status, priority, epic, story, deps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `subj-${id}`,
      `body for ${id}`,
      "todo",
      3,
      extra.epic ?? null,
      extra.story ?? null,
      extra.deps ?? null,
      now,
    );
  } else if (kind === "stories") {
    db.prepare(
      `INSERT INTO stories (id, epic, title, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, extra.epic ?? null, `story ${id}`, "todo", now);
  } else {
    db.prepare(
      `INSERT INTO epics (id, title, status, stories, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, `epic ${id}`, "todo", extra.stories ?? null, now);
  }
}

function findSnapshotFiles(atmuxDir: string): Promise<string[]> {
  return readdir(join(atmuxDir, "migrations"))
    .then((entries) => entries.filter((e) => e.startsWith("hex-ids-") && e.endsWith(".json")))
    .catch(() => []);
}

beforeEach(async () => {
  priorCwd = process.cwd();
  priorAtmuxDir = process.env.ATMUX_DIR;

  const scratch = await mkdtemp(join(tmpdir(), "atmux-migrate-hex-"));
  const atmuxDir = join(scratch, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await seedTeamJson(atmuxDir);

  // Init a fresh git repo so branch-rename spawns talk to real git.
  // Tests that expect "missing branch" simply don't create the branch
  // beforehand — `git branch -m` then errors + the verb logs skip.
  await runGit(scratch, ["init", "-q", "--initial-branch=main"]);
  await runGit(scratch, ["config", "user.email", "test@example.invalid"]);
  await runGit(scratch, ["config", "user.name", "test-user"]);
  await writeFile(join(scratch, "README"), "test\n");
  await runGit(scratch, ["add", "README"]);
  await runGit(scratch, ["commit", "-q", "-m", "init"]);

  const db = openDatabase(join(atmuxDir, "state.db"), migrations);

  const logs: { kind: string; msg: string }[] = [];
  const stdout: string[] = [];

  process.env.ATMUX_DIR = atmuxDir;
  process.chdir(scratch);

  env = {
    scratch,
    atmuxDir,
    db,
    stdout,
    stdoutWriter: (s: string) => {
      stdout.push(s);
    },
    logs,
    logger: {
      log: (m) => logs.push({ kind: "log", msg: m }),
      ok: (m) => logs.push({ kind: "ok", msg: m }),
      warn: (m) => logs.push({ kind: "warn", msg: m }),
      err: (m) => logs.push({ kind: "err", msg: m }),
    },
  };
});

afterEach(async () => {
  closeDatabase(env.db);
  process.chdir(priorCwd);
  if (priorAtmuxDir === undefined) delete process.env.ATMUX_DIR;
  else process.env.ATMUX_DIR = priorAtmuxDir;
  await rm(env.scratch, { recursive: true, force: true });
});

function stdoutText(): string {
  return env.stdout.join("");
}

describe("migrate-hex-ids — happy paths", () => {
  test("1. dry-run no-op: prints plan, writes nothing", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    seedLegacy(env.db, "stories", "s-deadbeef", { epic: "e-3b017960" });
    seedLegacy(env.db, "tasks", "t-cafebabe", { epic: "e-3b017960", story: "s-deadbeef" });

    const code = await migrateHexIds([], { stdout: env.stdoutWriter, logger: env.logger });
    expect(code).toBe(0);

    const out = stdoutText();
    expect(out).toContain("mappings=3");
    expect(out).toContain("e-3b017960");
    expect(out).toContain("DRY RUN");

    // Kanban PKs untouched.
    const epicRow = env.db.prepare("SELECT id FROM epics").get() as { id: string };
    expect(epicRow.id).toBe("e-3b017960");
    const seqs = env.db.prepare("SELECT scope, last_id FROM id_sequences ORDER BY scope").all();
    expect(seqs).toEqual([]); // dry-run rolled the allocation back

    // No snapshot file on dry run.
    const snaps = await findSnapshotFiles(env.atmuxDir);
    expect(snaps).toEqual([]);
  });

  test("2. --apply happy path: PKs rewritten, sequences advanced, snapshot written", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    seedLegacy(env.db, "stories", "s-deadbeef", { epic: "e-3b017960" });
    seedLegacy(env.db, "tasks", "t-cafebabe", {
      epic: "e-3b017960",
      story: "s-deadbeef",
      deps: '["t-feedface"]',
    });
    seedLegacy(env.db, "tasks", "t-feedface"); // dep target

    const code = await migrateHexIds(["--apply"], { stdout: env.stdoutWriter, logger: env.logger });
    expect(code).toBe(0);

    // Legacy ids gone, compound shape present.
    const epicId = (env.db.prepare("SELECT id FROM epics").get() as { id: string }).id;
    expect(epicId).toMatch(/^e-1-3b017960$/);
    const storyId = (env.db.prepare("SELECT id FROM stories").get() as { id: string }).id;
    expect(storyId).toMatch(/^s-1-deadbeef$/);
    const taskRows = env.db
      .prepare("SELECT id, epic, story, deps FROM tasks ORDER BY id")
      .all() as Array<{ id: string; epic: string; story: string; deps: string | null }>;
    for (const r of taskRows) {
      expect(r.id).toMatch(/^t-\d+-[0-9a-f]{8}$/);
    }
    // The task that had FKs got them re-pointed.
    const taskWithFks = taskRows.find((r) => r.id.endsWith("-cafebabe"));
    expect(taskWithFks?.epic).toMatch(/^e-1-3b017960$/);
    expect(taskWithFks?.story).toMatch(/^s-1-deadbeef$/);
    // deps JSON array carries the new id.
    expect(taskWithFks?.deps).toContain("t-");
    expect(taskWithFks?.deps).toContain("feedface");
    expect(taskWithFks?.deps).not.toContain('"t-feedface"');

    // Sequences advanced: 1 epic + 1 story + 2 tasks.
    const seqs = env.db
      .prepare("SELECT scope, last_id FROM id_sequences ORDER BY scope")
      .all() as Array<{ scope: string; last_id: number }>;
    expect(seqs).toEqual([
      { scope: "e", last_id: 1 },
      { scope: "s", last_id: 1 },
      { scope: "t", last_id: 2 },
    ]);

    // Snapshot file exists with the mapping table.
    const snaps = await findSnapshotFiles(env.atmuxDir);
    expect(snaps.length).toBe(1);
    const snap = JSON.parse(await readFile(join(env.atmuxDir, "migrations", snaps[0]!), "utf-8"));
    expect(snap.team).toBe("team-alpha");
    expect(snap.scope).toBe("all");
    expect(snap.mappings.length).toBe(4);
  });

  test("3. no-legacy-ids: early-exit + 'no legacy hex IDs' message", async () => {
    // Seed already-compound ids only.
    const now = Math.floor(Date.now() / 1000);
    env.db
      .prepare(
        `INSERT INTO epics (id, title, status, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run("e-1-3b017960", "e1", "todo", now);
    env.db
      .prepare(
        `INSERT INTO tasks (id, subject, status, priority, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("t-5-cafebabe", "t5", "todo", 3, now);

    const code = await migrateHexIds(["--apply"], { stdout: env.stdoutWriter, logger: env.logger });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("no legacy hex IDs");

    // Nothing rewritten, no snapshot.
    expect((env.db.prepare("SELECT id FROM epics").get() as { id: string }).id).toBe(
      "e-1-3b017960",
    );
    expect(await findSnapshotFiles(env.atmuxDir)).toEqual([]);
  });
});

describe("migrate-hex-ids — scope mechanics", () => {
  test("4. --scope=epics: only epics rewritten; legacy stories/tasks untouched", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    seedLegacy(env.db, "stories", "s-deadbeef");
    seedLegacy(env.db, "tasks", "t-cafebabe");

    const code = await migrateHexIds(["--scope=epics", "--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    // Epic rewritten, story + task left as-is.
    const epicId = (env.db.prepare("SELECT id FROM epics").get() as { id: string }).id;
    expect(epicId).toBe("e-1-3b017960");
    const storyId = (env.db.prepare("SELECT id FROM stories").get() as { id: string }).id;
    expect(storyId).toBe("s-deadbeef");
    const taskId = (env.db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
    expect(taskId).toBe("t-cafebabe");

    // Only `e` sequence advanced.
    const seqs = env.db
      .prepare("SELECT scope, last_id FROM id_sequences")
      .all() as Array<{ scope: string; last_id: number }>;
    expect(seqs).toEqual([{ scope: "e", last_id: 1 }]);
  });
});

describe("migrate-hex-ids — robustness", () => {
  test("5. missing-branch graceful skip: verb completes + logs warn", async () => {
    seedLegacy(env.db, "epics", "e-deadbeef");
    // No git branch `atmux-test-base-epic-e-deadbeef` exists.

    const code = await migrateHexIds(["--apply"], { stdout: env.stdoutWriter, logger: env.logger });
    expect(code).toBe(0);

    // Epic still renamed in kanban.
    const epicId = (env.db.prepare("SELECT id FROM epics").get() as { id: string }).id;
    expect(epicId).toBe("e-1-deadbeef");

    // Branch rename logged a skip warning.
    const warnMsgs = env.logs.filter((l) => l.kind === "warn").map((l) => l.msg);
    expect(warnMsgs.some((m) => m.includes("branch rename skip"))).toBe(true);

    // Stdout reports renamed=0 skipped=1.
    expect(stdoutText()).toContain("renamed=0 skipped=1");
  });

  test("6. idempotent re-run: second --apply is a no-op", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    seedLegacy(env.db, "tasks", "t-cafebabe", { epic: "e-3b017960" });

    const firstCode = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(firstCode).toBe(0);

    // Reset stdout buffer; re-run.
    env.stdout.length = 0;
    const secondCode = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(secondCode).toBe(0);
    expect(stdoutText()).toContain("no legacy hex IDs");

    // Sequences NOT bumped by the second run.
    const seqs = env.db
      .prepare("SELECT scope, last_id FROM id_sequences ORDER BY scope")
      .all() as Array<{ scope: string; last_id: number }>;
    expect(seqs).toEqual([
      { scope: "e", last_id: 1 },
      { scope: "t", last_id: 1 },
    ]);
  });
});

describe("migrate-hex-ids — flag parsing + side-channel mutations", () => {
  test("--scope flag value form (--scope X vs --scope=X) both work", async () => {
    seedLegacy(env.db, "epics", "e-aaaaaaaa");

    const codeA = await migrateHexIds(["--scope", "epics", "--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(codeA).toBe(0);
    expect((env.db.prepare("SELECT id FROM epics").get() as { id: string }).id).toBe(
      "e-1-aaaaaaaa",
    );

    // Re-seed a second legacy id; use --scope=epics form.
    seedLegacy(env.db, "epics", "e-bbbbbbbb");
    env.stdout.length = 0;
    const codeB = await migrateHexIds(["--scope=epics", "--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(codeB).toBe(0);
    const epicIds = (
      env.db.prepare("SELECT id FROM epics ORDER BY id").all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(epicIds).toEqual(["e-1-aaaaaaaa", "e-2-bbbbbbbb"]);
  });

  test("--team flag overrides team-name in snapshot + log lines", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");

    const code = await migrateHexIds(["--apply", "--team", "team-override"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("team=team-override");
    const snaps = await findSnapshotFiles(env.atmuxDir);
    const snap = JSON.parse(await readFile(join(env.atmuxDir, "migrations", snaps[0]!), "utf-8"));
    expect(snap.team).toBe("team-override");
  });

  test("--team=<v> equals form also parses", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    const code = await migrateHexIds(["--apply", "--team=team-eq"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("team=team-eq");
  });

  test("invalid --scope value throws UsageError", async () => {
    await expect(
      migrateHexIds(["--scope", "bogus"], { stdout: env.stdoutWriter, logger: env.logger }),
    ).rejects.toThrow(/scope/);
    await expect(
      migrateHexIds(["--scope=bogus"], { stdout: env.stdoutWriter, logger: env.logger }),
    ).rejects.toThrow(/scope/);
  });

  test("--scope without value throws UsageError", async () => {
    await expect(
      migrateHexIds(["--scope"], { stdout: env.stdoutWriter, logger: env.logger }),
    ).rejects.toThrow(/scope/);
  });

  test("--team without value throws UsageError", async () => {
    await expect(
      migrateHexIds(["--team"], { stdout: env.stdoutWriter, logger: env.logger }),
    ).rejects.toThrow(/team/);
  });

  test("unknown flag throws UsageError", async () => {
    await expect(
      migrateHexIds(["--bogus"], { stdout: env.stdoutWriter, logger: env.logger }),
    ).rejects.toThrow(/unknown arg/);
  });

  test("explicit --dry-run is still dry-run even with --apply absent", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    const code = await migrateHexIds(["--dry-run"], { stdout: env.stdoutWriter, logger: env.logger });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("DRY RUN");
  });

  test("--apply rewrites events.payload JSON containing legacy IDs", async () => {
    seedLegacy(env.db, "tasks", "t-3b017960");
    // Seed an event referencing the legacy task id.
    env.db
      .prepare(
        `INSERT INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "01890000-0000-7000-8000-000000000001",
        "task.claimed",
        JSON.stringify({ topic: "task.claimed", taskId: "t-3b017960", member: "be-1" }),
        1_700_000_000,
        1,
      );

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    const payload = JSON.parse(
      (env.db.prepare("SELECT payload FROM events").get() as { payload: string }).payload,
    );
    expect(payload.taskId).toMatch(/^t-1-3b017960$/);
    expect(stdoutText()).toContain("events payloads rewritten = 1");
  });

  test("--apply rewrites .atmux/team.json parentEpicKanbanId", async () => {
    // Re-seed team.json with parentEpicKanbanId pointing at a legacy epic.
    await seedTeamJson(env.atmuxDir, { parentEpicKanbanId: "e-3b017960" });
    seedLegacy(env.db, "epics", "e-3b017960");

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    const teamRaw = await readFile(join(env.atmuxDir, "team.json"), "utf-8");
    expect(teamRaw).toContain('"parentEpicKanbanId": "e-1-3b017960"');
    expect(stdoutText()).toContain("team.json parentEpicKanbanId updated");
  });

  test("--apply renames matching git branch when one exists", async () => {
    seedLegacy(env.db, "epics", "e-3b017960");
    // Create the legacy branch ahead of the verb call.
    await runGit(env.scratch, ["branch", "atmux-test-base-epic-e-3b017960"]);

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    const { stdout: branches } = await runGit(env.scratch, ["branch", "--list"]);
    // Post-2026-05-26 double-e fix (ADR-090 §Disk layout amendment):
    // the compound branch is emitted WITHOUT the redundant `e-` prefix,
    // so the rename target is `atmux-test-base-epic-1-3b017960`
    // (no `epic-e-` doubling). The pre-existing legacy branch
    // `atmux-test-base-epic-e-3b017960` was found via the back-compat
    // fallback path in renameGitBranches and still gets removed.
    expect(branches).toContain("atmux-test-base-epic-1-3b017960");
    expect(branches).not.toContain("atmux-test-base-epic-e-3b017960\n");
    expect(stdoutText()).toContain("renamed=1");
  });

  test("--apply rewrites ADR pointer references in docs/adr/*.md", async () => {
    const adrDir = join(env.scratch, "docs", "adr");
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, "100-test.md"),
      "# Test\nThis ADR references e-3b017960 in passing.\n",
    );
    seedLegacy(env.db, "epics", "e-3b017960");

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    const adrText = await readFile(join(adrDir, "100-test.md"), "utf-8");
    expect(adrText).toContain("e-1-3b017960");
    expect(adrText).not.toMatch(/(?<![\d-])e-3b017960/);
    expect(stdoutText()).toContain("ADR pointer files rewritten = 1");
  });

  test("--apply rewrites epics.stories JSON array containing legacy IDs", async () => {
    seedLegacy(env.db, "stories", "s-deadbeef");
    seedLegacy(env.db, "epics", "e-3b017960", { stories: '["s-deadbeef","s-other"]' });

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    const epicRow = env.db.prepare("SELECT id, stories FROM epics").get() as {
      id: string;
      stories: string;
    };
    expect(epicRow.id).toBe("e-1-3b017960");
    expect(epicRow.stories).toContain("s-1-deadbeef");
    expect(epicRow.stories).toContain("s-other"); // un-migrated id preserved
    expect(epicRow.stories).not.toContain('"s-deadbeef"');
  });

  test("--apply with no docs/adr dir logs a skip-warn but continues", async () => {
    // Default scratch has no docs/adr dir. Seed a legacy epic anyway.
    seedLegacy(env.db, "epics", "e-3b017960");

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);

    const warns = env.logs.filter((l) => l.kind === "warn").map((l) => l.msg);
    expect(warns.some((m) => m.includes("docs/adr/ absent"))).toBe(true);
  });

  test("--apply without epicTeam skips branch rename with a stdout note", async () => {
    // Re-seed team.json without epicTeam entirely (epicTeam.parentBase is
    // schema-required when epicTeam is set, so the only way to omit it
    // is to drop the whole epicTeam sub-block).
    await seedTeamJson(env.atmuxDir, { includeEpicTeam: false });
    seedLegacy(env.db, "epics", "e-3b017960");

    const code = await migrateHexIds(["--apply"], {
      stdout: env.stdoutWriter,
      logger: env.logger,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain("no epicTeam.parentBase");
  });
});

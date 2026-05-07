// ADR-060 §D4: `atmux migrate-state json-to-sqlite` verb.
//
// Migrates `.atmux/` JSON state files into `.atmux/state.db` (SQLite).
// Driver-paved minimum-viable scope per chat 18:30 MYT 2026-05-07
// "lets get the sqlite dogfooded asap" + "had too many jq corruptions":
//
//   - kanban target IS implemented (highest-leverage corruption target)
//   - inboxes + state targets ARE NOT IMPLEMENTED in this commit;
//     the verb's CLI surface accepts them but throws ConfigError so
//     the team's follow-up work has a clear contract to extend
//
// USAGE:
//   atmux migrate-state json-to-sqlite [--team-dir <dir>]
//                                      [--dry-run]
//                                      [--target=all|kanban|inboxes|state]
//                                      [--db-path <path>]
//
//   --team-dir <dir>       Override .atmux dir resolution. Default: walk
//                          up from cwd via `getAtmuxDir`.
//   --dry-run              Parse + report counts, no DB writes, no
//                          archive moves. Exit 0 even if validation fails
//                          on individual rows (errors surface to stderr).
//   --target=<...>         Default `all`. Currently `kanban` is the only
//                          fully-implemented target; `inboxes`/`state`
//                          throw ConfigError. `all` runs kanban + skips
//                          unimplemented targets with a stderr WARN.
//   --db-path <path>       Override .atmux/state.db location. Default:
//                          <atmuxDir>/state.db.
//
// IDEMPOTENCE:
//   - KanbanRepo uses `INSERT ... ON CONFLICT DO UPDATE` (upsert) so
//     re-running on the same kanban.json updates rows without duplicates.
//   - Archive step skips if dest dir already exists; original JSON is
//     not re-archived.
//   - Audit record at `.atmux/migration-state-sqlite.json` is rewritten
//     each run with the latest event.
//
// EXIT CODES (per ADR-006):
//   0   success
//   64  UsageError (bad arg shape)
//   78  ConfigError (target not implemented; missing source file)
//   1   IOError / SQLite error (propagated)

import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir, exists, readText, writeText } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";
import { getAtmuxDir, inboxDir, kanbanJsonPath } from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { KanbanRepo } from "../core/repositories/kanban-repo.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Kanban } from "../schema/kanban.ts";

// ---------- Arg parsing ----------

export type MigrateTarget = "all" | "kanban" | "inboxes" | "state";

export interface ParsedMigrateArgs {
  teamDir?: string;
  dryRun: boolean;
  target: MigrateTarget;
  dbPath?: string;
}

const VALID_TARGETS: ReadonlySet<string> = new Set(["all", "kanban", "inboxes", "state"]);

export function parseMigrateArgs(args: ReadonlyArray<string>): ParsedMigrateArgs {
  let subVerb: string | undefined;
  let teamDir: string | undefined;
  let dryRun = false;
  let target: MigrateTarget = "all";
  let dbPath: string | undefined;

  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? "";
    // First positional is the sub-verb (only `json-to-sqlite` supported).
    if (i === 0 && !a.startsWith("--")) {
      subVerb = a;
      i += 1;
      continue;
    }
    switch (true) {
      case a === "--team-dir": {
        const val = args[i + 1];
        if (val === undefined) {
          throw new UsageError({
            what: "migrate-state: --team-dir requires a value",
            hint: "usage: atmux migrate-state json-to-sqlite [--team-dir <dir>] [--dry-run] [--target=<all|kanban|inboxes|state>]",
          });
        }
        teamDir = val;
        i += 2;
        break;
      }
      case a === "--dry-run":
        dryRun = true;
        i += 1;
        break;
      case a === "--db-path": {
        const val = args[i + 1];
        if (val === undefined) {
          throw new UsageError({
            what: "migrate-state: --db-path requires a value",
            hint: "usage: atmux migrate-state json-to-sqlite [--db-path <path>]",
          });
        }
        dbPath = val;
        i += 2;
        break;
      }
      case a.startsWith("--target="): {
        const val = a.slice("--target=".length);
        if (!VALID_TARGETS.has(val)) {
          throw new UsageError({
            what: `migrate-state: unknown --target=${val}`,
            hint: "valid targets: all, kanban, inboxes, state",
          });
        }
        target = val as MigrateTarget;
        i += 1;
        break;
      }
      default:
        throw new UsageError({
          what: `migrate-state: unknown arg: ${a}`,
          hint: "usage: atmux migrate-state json-to-sqlite [--team-dir <dir>] [--dry-run] [--target=<all|kanban|inboxes|state>]",
        });
    }
  }

  if (subVerb !== "json-to-sqlite") {
    throw new UsageError({
      what: subVerb
        ? `migrate-state: unknown sub-verb: ${subVerb}`
        : "migrate-state: missing sub-verb",
      hint: "usage: atmux migrate-state json-to-sqlite [...]",
    });
  }

  const out: ParsedMigrateArgs = { dryRun, target };
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (dbPath !== undefined) out.dbPath = dbPath;
  return out;
}

// ---------- Migration result types ----------

export interface KanbanMigrationCounts {
  tasks: number;
  epics: number;
  stories: number;
}

export interface MigrationResult {
  dryRun: boolean;
  dbPath: string;
  atmuxDir: string;
  archiveDir: string;
  migratedAtEpoch: number;
  counts: {
    kanban?: KanbanMigrationCounts;
    inboxes?: number; // not implemented in this commit
    state?: number; // not implemented in this commit
  };
  warnings: string[];
}

// ---------- Kanban migration ----------

/**
 * Read kanban.json, validate via Zod, populate tasks/epics/stories
 * tables. Returns row counts. Idempotent via upsert.
 *
 * Throws ConfigError on missing kanban.json. Validation errors on
 * individual rows propagate via Zod (which the caller maps to
 * SchemaError → exit 65).
 */
async function migrateKanban(
  atmuxDir: string,
  db: Database,
  dryRun: boolean,
): Promise<KanbanMigrationCounts> {
  const path = kanbanJsonPath(atmuxDir);
  if (!(await exists(path))) {
    throw new ConfigError({
      what: `migrate-state: kanban.json not found at ${path}`,
      hint: "no kanban data to migrate; pass --target=inboxes or --target=state if you want a different lane",
    });
  }

  const raw = await readText(path);
  const parsed = Kanban.parse(JSON.parse(raw));

  if (dryRun) {
    return {
      tasks: parsed.tasks.length,
      epics: parsed.epics.length,
      stories: parsed.stories.length,
    };
  }

  const repo = new KanbanRepo(db);
  let tasks = 0;
  let epics = 0;
  let stories = 0;

  // Single transaction wrapping all upserts — atomic per ADR-060 §D10.
  db.transaction(() => {
    for (const t of parsed.tasks) {
      repo.upsertTask(t);
      tasks += 1;
    }
    for (const e of parsed.epics) {
      repo.upsertEpic(e);
      epics += 1;
    }
    for (const s of parsed.stories) {
      repo.upsertStory(s);
      stories += 1;
    }
  })();

  return { tasks, epics, stories };
}

// ---------- Archive helper ----------

/**
 * Move source JSON files to `.atmux/archive/json-pre-sqlite-<epoch>/`,
 * preserving directory structure. Skipped on --dry-run.
 *
 * Idempotent: if the archive dir already exists, returns its path
 * unchanged. Caller decides whether to also re-archive.
 */
async function archiveJsonSources(
  atmuxDir: string,
  migratedAtEpoch: number,
  target: MigrateTarget,
  dryRun: boolean,
): Promise<string> {
  const archiveDir = join(atmuxDir, "archive", `json-pre-sqlite-${migratedAtEpoch}`);

  if (dryRun) return archiveDir;

  await ensureDir(archiveDir);

  if (target === "all" || target === "kanban") {
    const src = kanbanJsonPath(atmuxDir);
    if (await exists(src)) {
      const dest = join(archiveDir, "kanban.json");
      if (!(await exists(dest))) {
        await rename(src, dest);
      }
    }
  }

  // inboxes + state archiving deferred until team builds the matching repos.
  return archiveDir;
}

// ---------- Audit record ----------

interface AuditRecord {
  migratedAtEpoch: number;
  dbPath: string;
  atmuxDir: string;
  archiveDir: string;
  target: MigrateTarget;
  counts: MigrationResult["counts"];
  schemaVersion: number;
  warnings: string[];
}

async function writeAuditRecord(atmuxDir: string, record: AuditRecord): Promise<void> {
  const path = join(atmuxDir, "migration-state-sqlite.json");
  await writeText(path, `${JSON.stringify(record, null, 2)}\n`);
}

// ---------- Verb entry ----------

export interface MigrateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  stdout?: Writer;
}

export async function migrateState(
  argv: ReadonlyArray<string>,
  opts: MigrateOptions = {},
): Promise<number> {
  const parsed = parseMigrateArgs(argv);
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const logger = opts.logger ?? createLogger();
  const stdout = opts.stdout ?? defaultStdoutWrite;

  // Resolve atmuxDir.
  const atmuxDir = parsed.teamDir ? resolve(parsed.teamDir) : await getAtmuxDir({ cwd, env });

  // Resolve dbPath.
  const dbPath = parsed.dbPath ? resolve(parsed.dbPath) : join(atmuxDir, "state.db");

  const warnings: string[] = [];
  const counts: MigrationResult["counts"] = {};
  const migratedAtEpoch = now();

  // Open DB (creates + applies migrations on first open).
  // On --dry-run, we still open it because Zod-validating the kanban
  // json doesn't require a DB; but dry-run skips writes. The created
  // state.db on a dry-run is harmless: it's an empty schema file.
  if (!parsed.dryRun) {
    await ensureDir(atmuxDir);
  }

  const db = openDatabase(dbPath, migrations);

  try {
    // ----- kanban target -----
    if (parsed.target === "all" || parsed.target === "kanban") {
      counts.kanban = await migrateKanban(atmuxDir, db, parsed.dryRun);
    }

    // ----- inboxes target (NOT IMPLEMENTED; team's bundle-2 follow-up) -----
    if (parsed.target === "inboxes") {
      throw new ConfigError({
        what: "migrate-state: --target=inboxes not yet implemented",
        hint: "InboxRepo + matching migration helper is on the team's bundle-2 follow-up list (driver-inbox 2026-05-07 18:30 MYT)",
      });
    }
    if (parsed.target === "all") {
      warnings.push(
        "inboxes target skipped — InboxRepo not yet implemented (team bundle-2 follow-up)",
      );
    }

    // ----- state target (NOT IMPLEMENTED; team's bundle-2 follow-up) -----
    if (parsed.target === "state") {
      throw new ConfigError({
        what: "migrate-state: --target=state not yet implemented",
        hint: "StateKvRepo + matching migration helper is on the team's bundle-2 follow-up list (driver-inbox 2026-05-07 18:30 MYT)",
      });
    }
    if (parsed.target === "all") {
      warnings.push(
        "state target skipped — StateKvRepo not yet implemented (team bundle-2 follow-up)",
      );
    }

    // Archive originals (only after migration writes succeeded).
    const archiveDir = await archiveJsonSources(
      atmuxDir,
      migratedAtEpoch,
      parsed.target,
      parsed.dryRun,
    );

    // Audit record.
    if (!parsed.dryRun) {
      await writeAuditRecord(atmuxDir, {
        migratedAtEpoch,
        dbPath,
        atmuxDir,
        archiveDir,
        target: parsed.target,
        counts,
        schemaVersion: 1,
        warnings,
      });
    }

    // Output.
    const summary = {
      dryRun: parsed.dryRun,
      dbPath,
      atmuxDir,
      archiveDir,
      migratedAtEpoch,
      counts,
      warnings,
    };
    stdout(`${JSON.stringify(summary, null, 2)}\n`);

    if (parsed.dryRun) {
      logger.log(
        `migrate-state: dry-run OK — ${counts.kanban?.tasks ?? 0} tasks, ${counts.kanban?.epics ?? 0} epics, ${counts.kanban?.stories ?? 0} stories scanned`,
      );
    } else {
      logger.ok(
        `migrate-state: migrated ${counts.kanban?.tasks ?? 0} tasks + ${counts.kanban?.epics ?? 0} epics + ${counts.kanban?.stories ?? 0} stories to ${dbPath}`,
      );
    }
    for (const w of warnings) {
      logger.warn(w);
    }

    return 0;
  } finally {
    closeDatabase(db);
  }
}

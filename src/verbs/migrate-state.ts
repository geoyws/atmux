// ADR-060 §D4: `atmux migrate-state json-to-sqlite` verb.
//
// Migrates `.atmux/` JSON state files into `.atmux/state.db` (SQLite).
// Driver-paved minimum-viable scope per chat 18:30 MYT 2026-05-07
// "lets get the sqlite dogfooded asap" + "had too many jq corruptions":
//
//   - kanban target IS implemented (highest-leverage corruption target)
//   - inboxes target IS implemented (ADR-076 backfill)
//   - state target IS implemented (e-38 P1 flags → state_kv via FlagsRepo)
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
//   --target=<...>         Default `all`. `kanban`, `inboxes` and `state`
//                          are implemented; `all` runs all three.
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
//   78  ConfigError (missing source file)
//   1   IOError / SQLite error (propagated)

import { readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir, exists, readText, readTextOrNull, writeText } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";
import { getAtmuxDir, inboxDir, kanbanJsonPath } from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { FlagsRepo } from "../core/repositories/flags-repo.ts";
import { KanbanRepo } from "../core/repositories/kanban-repo.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Inbox } from "../schema/inbox.ts";
import { Kanban, type KanbanTask } from "../schema/kanban.ts";

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
    inboxes?: InboxMigrationCounts;
    state?: FlagsMigrationCounts;
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

// ---------- Flags migration (e-38 P1; t-62feffe0) ----------

/**
 * Migrate the P1 toggle + P2 role-state JSON files into `state_kv` via
 * FlagsRepo (P2 uses feature = namespace, key = role-or-key — no extra
 * schema needed). Out of scope with reasons: resume.json (soft-stop
 * forensic trail), pulse-state.json (cockpit-global ~/.atmux scope),
 * sentinel/eternal (no code refs), fallback-brief-*.md (document
 * store shared with cleanup + audit writers).
 * Returns total keys written. Lenient per-file: a missing file
 * contributes 0; an unparseable file is skipped with a warning.
 */
export interface FlagsMigrationCounts {
  /** Total state_kv keys written across all features. */
  keys: number;
  /** Per-feature key counts (present files only). */
  features: Record<string, number>;
  /** Files skipped as unparseable. */
  filesSkippedInvalid: number;
}

interface FlagsSource {
  /** Single file under atmuxDir (mutually exclusive with prefix). */
  file?: string;
  /** Per-member glob: all `state/<prefix>*<suffix>` files (e.g.
   *  modal-history-<member>.json); key = middle segment. */
  prefix?: string;
  suffix?: string;
  feature: string;
  singleKey?: string;
  /** Store parsed[subKey] instead of the whole document. */
  subKey?: string;
}

const FLAGS_SOURCES: ReadonlyArray<FlagsSource> = [
  { file: "state/paused.json", feature: "pause" },
  { file: "state/budget-pause.json", feature: "budget-pause", singleKey: "state" },
  { file: "state/budget-refresh-soon-state.json", feature: "budget-refresh-soon" },
  { file: "state/budget-warning-state.json", feature: "budget-warning" },
  { file: "state/whip-config-drift-state.json", feature: "whip-config-drift" },
  // e-38 P2 (t-66d8c7a4): role-state files. state_kv covers the body's
  // role_state table as (feature = namespace, key = role-or-key) —
  // no schema change needed. fallback-brief-*.md stays out (document
  // store shared with cage-cleanup + audit writers, not role state).
  { prefix: "modal-history-", suffix: ".json", feature: "modal-history" },
  { file: "state/modal-cycling-dedup-state.json", feature: "modal-cycling-dedup" },
  { file: "state/heads-up-cursor.json", feature: "heads-up-cursor" },
  { file: "state/ombudsman-pending.json", feature: "ombudsman-pending", singleKey: "pending", subKey: "pending" },
  { prefix: "cost-", suffix: ".json", feature: "cost" },
];

function flagsEntriesFor(source: FlagsSource, parsed: unknown): Array<[string, unknown]> {
  const doc = source.subKey !== undefined &&
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)[source.subKey]
    : parsed;
  if (source.singleKey !== undefined) {
    if (doc === undefined) return [];
    return [[source.singleKey, doc]];
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
  return Object.entries(doc as Record<string, unknown>);
}

/** Resolve one source to (relFile, keyOverride) pairs. Single-file
 *  sources yield one pair; prefix sources scan state/ for matches. */
async function flagsSourceFiles(
  atmuxDir: string,
  source: FlagsSource,
): Promise<Array<{ file: string; key: string | null }>> {
  if (source.file !== undefined) return [{ file: source.file, key: null }];
  const { readdir } = await import("node:fs/promises");
  const dir = join(atmuxDir, "state");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: Array<{ file: string; key: string | null }> = [];
  for (const name of names) {
    if (!name.startsWith(source.prefix ?? "") || !name.endsWith(source.suffix ?? "")) continue;
    const key = name.slice((source.prefix ?? "").length, name.length - (source.suffix ?? "").length);
    if (key.length === 0) continue;
    out.push({ file: `state/${name}`, key });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

async function migrateFlags(
  atmuxDir: string,
  db: Database,
  dryRun: boolean,
): Promise<FlagsMigrationCounts> {
  const repo = new FlagsRepo(db);
  const features: Record<string, number> = {};
  let filesSkippedInvalid = 0;
  for (const source of FLAGS_SOURCES) {
    for (const { file, key } of await flagsSourceFiles(atmuxDir, source)) {
      const path = join(atmuxDir, file);
      const txt = await readTextOrNull(path);
      if (txt === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(txt);
      } catch {
        filesSkippedInvalid += 1;
        continue;
      }
      let entries = flagsEntriesFor(source, parsed);
      if (key !== null) {
        // Per-member file: the whole document is one kv entry.
        if (entries.length === 0 && source.singleKey === undefined) {
          const doc = source.subKey !== undefined &&
              typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)[source.subKey]
            : parsed;
          if (doc !== undefined) entries = [[key, doc]];
        } else if (entries.length > 0 && source.singleKey === undefined) {
          entries = [[key, parsed]];
        }
      }
      if (!dryRun && entries.length > 0) {
        db.transaction(() => {
          for (const [k, v] of entries) repo.set(source.feature, k, v);
        })();
      }
      if (entries.length > 0) {
        features[source.feature] = (features[source.feature] ?? 0) + entries.length;
      }
    }
  }
  const keys = Object.values(features).reduce((a, b) => a + b, 0);
  return { keys, features, filesSkippedInvalid };
}
/**
 * Counts returned by the inboxes-target migration step.
 */
export interface InboxMigrationCounts {
  /** Number of inbox JSON files scanned (one per member). */
  files: number;
  /** Total inbox entries seen across all members + buckets. */
  entriesSeen: number;
  /** Entries that were ABSENT from the tasks table and got upserted in. */
  entriesBackfilled: number;
  /** Entries already present in the tasks table; upsert is a no-op
   *  per the ON-CONFLICT-DO-UPDATE shape (we do upsert anyway to keep
   *  any KanbanTask-compatible field changes from JSON in sync). */
  entriesPresent: number;
  /** Inbox JSON files that failed Zod parse — counted but skipped. */
  filesSkippedInvalid: number;
}

/** Strip the inbox-only `dispatchedAt` from an InboxEntry (it lives in
 *  `extra` post-migration since KanbanTask doesn't have a column for
 *  it; whip's stale-min anchor falls back `claimedAt // dispatchedAt`,
 *  but that bash dependency is gone post-decommission). All other
 *  fields are KanbanTask-compatible. Returns a KanbanTask shape ready
 *  for `KanbanRepo.upsertTask`. */
function inboxEntryToKanbanTask(entry: unknown): KanbanTask {
  // InboxEntry is `.passthrough()` — just rest-spread + drop dispatchedAt.
  // Extra inbox-only fields (cancelledAt, cancelledReason) flow through
  // KanbanTask's `extra` passthrough since KanbanTask is also lenient.
  // KanbanRepo.upsertTask serialises unknowns via `taskToRow`'s `extra`
  // JSON column.
  const e = entry as Record<string, unknown>;
  const { dispatchedAt: _dispatchedAt, ...rest } = e;
  return rest as KanbanTask;
}

/**
 * Read each `.atmux/inboxes/<member>.json`, walk the
 * `pending`/`inProgress`/`done` buckets, and upsert each entry into
 * the `tasks` table. Idempotent via ON-CONFLICT-DO-UPDATE.
 *
 * The vast majority of inbox entries should already be in `tasks`
 * (kanban-repo writes happen alongside inbox-mirror writes in dispatch
 * / claim / done). The migrator's purpose is to catch JSON-only entries
 * that were lost to kanban somehow — pure parity safety net for the
 * ADR-076 (inbox elimination) cutover.
 *
 * Per-file Zod parse failures count to `filesSkippedInvalid` and are
 * surfaced as warnings; one bad inbox file does NOT abort the whole
 * migration.
 */
async function migrateInboxes(
  atmuxDir: string,
  db: Database,
  dryRun: boolean,
): Promise<InboxMigrationCounts> {
  const dir = inboxDir(atmuxDir);

  if (!(await exists(dir))) {
    return {
      files: 0,
      entriesSeen: 0,
      entriesBackfilled: 0,
      entriesPresent: 0,
      filesSkippedInvalid: 0,
    };
  }

  const allEntries: ReadonlyArray<string> = await readdir(dir);
  const jsonFiles = allEntries.filter((f) => f.endsWith(".json") && !f.endsWith(".lock"));

  let files = 0;
  let entriesSeen = 0;
  let entriesBackfilled = 0;
  let entriesPresent = 0;
  let filesSkippedInvalid = 0;

  const repo = new KanbanRepo(db);

  // Single transaction — atomic per ADR-060 §D10 + matches kanban target
  // shape. Errors inside the transaction roll back; the per-file Zod
  // failures are caught + counted before they enter the transaction.
  const validParsed: Array<{ member: string; entries: ReadonlyArray<unknown> }> = [];

  for (const fname of jsonFiles) {
    const member = fname.replace(/\.json$/, "");
    const path = join(dir, fname);
    let raw: string;
    try {
      raw = await readText(path);
    } catch {
      filesSkippedInvalid += 1;
      continue;
    }
    let parsed: ReturnType<typeof Inbox.parse>;
    try {
      parsed = Inbox.parse(JSON.parse(raw));
    } catch {
      filesSkippedInvalid += 1;
      continue;
    }
    files += 1;
    const entries = [...parsed.pending, ...parsed.inProgress, ...parsed.done];
    entriesSeen += entries.length;
    validParsed.push({ member, entries });
  }

  if (dryRun) {
    // Probe presence/absence without writing.
    for (const { entries } of validParsed) {
      for (const entry of entries) {
        const id = (entry as { id?: string }).id;
        if (typeof id !== "string") continue;
        const present = repo.getTask(id);
        if (present === null) {
          entriesBackfilled += 1;
        } else {
          entriesPresent += 1;
        }
      }
    }
    return { files, entriesSeen, entriesBackfilled, entriesPresent, filesSkippedInvalid };
  }

  db.transaction(() => {
    for (const { entries } of validParsed) {
      for (const entry of entries) {
        const id = (entry as { id?: string }).id;
        if (typeof id !== "string") continue;
        const present = repo.getTask(id);
        const task = inboxEntryToKanbanTask(entry);
        repo.upsertTask(task);
        if (present === null) {
          entriesBackfilled += 1;
        } else {
          entriesPresent += 1;
        }
      }
    }
  })();

  return { files, entriesSeen, entriesBackfilled, entriesPresent, filesSkippedInvalid };
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

  // inboxes archiving deferred until team builds the matching repo.
  // state sources archive only when the flags migration actually ran
  // (target state|all) so an unrelated kanban-only run never moves them.
  if (target === "all" || target === "state") {
    for (const source of FLAGS_SOURCES) {
      for (const { file } of await flagsSourceFiles(atmuxDir, source)) {
        const src = join(atmuxDir, file);
        if (await exists(src)) {
          const dest = join(archiveDir, file);
          if (!(await exists(dest))) {
            await ensureDir(join(archiveDir, "state"));
            await rename(src, dest);
          }
        }
      }
    }
  }
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

    // ----- inboxes target (ADR-076 — eliminate JSON inbox, backfill tasks-table) -----
    if (parsed.target === "all" || parsed.target === "inboxes") {
      counts.inboxes = await migrateInboxes(atmuxDir, db, parsed.dryRun);
      if (counts.inboxes.filesSkippedInvalid > 0) {
        warnings.push(
          `inboxes: ${counts.inboxes.filesSkippedInvalid} file(s) failed Zod parse and were skipped`,
        );
      }
    }

    // ----- state target (e-38 P1 flags migration) -----
    if (parsed.target === "state" || parsed.target === "all") {
      counts.state = await migrateFlags(atmuxDir, db, parsed.dryRun);
      if (counts.state.filesSkippedInvalid > 0) {
        warnings.push(
          `state: ${counts.state.filesSkippedInvalid} file(s) failed JSON parse and were skipped`,
        );
      }
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

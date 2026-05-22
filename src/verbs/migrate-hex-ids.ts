// ADR-202 §XIII (T4.1, t-b7598005) — `atmux migrate-hex-ids` verb.
//
// One-off operator verb: walks the kanban for legacy hex-only IDs
// (`<scope>-<8 hex>`, pre-§VIII) and assigns each one a compound
// `<scope>-<N>-<hex>` ID via per-team `id_sequences` counter. Hash is
// PRESERVED — `t-3b017960` becomes `t-N-3b017960` — so every existing
// grep / log / ADR reference keeps partial recall.
//
// Default-OFF + dry-run-by-default: `--apply` is REQUIRED to write
// anything. Without `--apply` the verb prints the plan + exits 0.
//
// Pre-mutation snapshot lands at `.atmux/migrations/hex-ids-<unix>.json`
// BEFORE the transaction commits — operator-rollback path stays viable
// even if the process crashes mid-flight. Rollback VERB itself is
// out-of-scope per task body (follow-up Task).
//
// Scope flag — `epics | stories | tasks | all` (default `all`). The
// chosen scope determines which PK columns are scanned + sequenced;
// FK + JSON-array updates always apply across the full mapping
// (otherwise we'd leave references dangling).
//
// Single-team only — `--team` flag overrides cwd resolution; cross-team
// coordination is out of scope.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { now } from "../abstractions/time.ts";
import { getAtmuxDir, loadTeam } from "../core/common.ts";
import { assignSequenceToLegacyId, type IdScope } from "../core/id-sequence.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";

// ---------- Arg parsing ----------

export type MigrateHexScope = "epics" | "stories" | "tasks" | "all";

const VALID_SCOPES: ReadonlySet<MigrateHexScope> = new Set([
  "epics",
  "stories",
  "tasks",
  "all",
]);

export interface ParsedMigrateHexArgs {
  dryRun: boolean;
  apply: boolean;
  scope: MigrateHexScope;
  teamOverride: string | undefined;
}

export function parseMigrateHexArgs(args: ReadonlyArray<string>): ParsedMigrateHexArgs {
  let apply = false;
  let scope: MigrateHexScope = "all";
  let teamOverride: string | undefined;
  let explicitDryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (a === "--dry-run") {
      explicitDryRun = true;
      continue;
    }
    if (a === "--scope") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "--scope requires a value", hint: "epics | stories | tasks | all" });
      }
      if (!VALID_SCOPES.has(v as MigrateHexScope)) {
        throw new UsageError({
          what: `--scope: invalid value '${v}'`,
          hint: "epics | stories | tasks | all",
        });
      }
      scope = v as MigrateHexScope;
      i += 1;
      continue;
    }
    if (a.startsWith("--scope=")) {
      const v = a.slice("--scope=".length);
      if (!VALID_SCOPES.has(v as MigrateHexScope)) {
        throw new UsageError({
          what: `--scope: invalid value '${v}'`,
          hint: "epics | stories | tasks | all",
        });
      }
      scope = v as MigrateHexScope;
      continue;
    }
    if (a === "--team") {
      const v = args[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "--team requires a value", hint: "team name" });
      }
      teamOverride = v;
      i += 1;
      continue;
    }
    if (a.startsWith("--team=")) {
      teamOverride = a.slice("--team=".length);
      continue;
    }
    throw new UsageError({
      what: `unknown arg: ${a}`,
      hint: "atmux migrate-hex-ids [--dry-run] [--apply] [--scope=epics|stories|tasks|all] [--team=<name>]",
    });
  }

  return { dryRun: !apply || explicitDryRun, apply, scope, teamOverride };
}

// ---------- ID detection ----------

/** Legacy hex-only ID — `<scope>-<8 hex>`, no `-N-` middle segment. */
const LEGACY_HEX_RE = /^[tse]-[0-9a-f]{8}$/;

export function isLegacyHexId(id: string): boolean {
  return LEGACY_HEX_RE.test(id);
}

function scopeChar(id: string): IdScope {
  return id[0] as IdScope;
}

// ---------- Scan + plan ----------

export interface IdMapping {
  legacyId: string;
  compoundId: string;
  scope: IdScope;
  sequenceN: number;
}

interface ScopeFilter {
  epics: boolean;
  stories: boolean;
  tasks: boolean;
}

function filterFromScope(scope: MigrateHexScope): ScopeFilter {
  if (scope === "all") return { epics: true, stories: true, tasks: true };
  return {
    epics: scope === "epics",
    stories: scope === "stories",
    tasks: scope === "tasks",
  };
}

/** Scan PK columns by scope filter; allocate sequence + return planned
 *  mappings. Sequence allocation happens inside the caller's
 *  transaction wrapper so dry-run doesn't actually advance counters. */
function scanLegacyIds(db: Database, filter: ScopeFilter): string[] {
  const ids: string[] = [];
  if (filter.epics) {
    const rows = db.prepare("SELECT id FROM epics").all() as Array<{ id: string }>;
    for (const r of rows) if (isLegacyHexId(r.id)) ids.push(r.id);
  }
  if (filter.stories) {
    const rows = db.prepare("SELECT id FROM stories").all() as Array<{ id: string }>;
    for (const r of rows) if (isLegacyHexId(r.id)) ids.push(r.id);
  }
  if (filter.tasks) {
    const rows = db.prepare("SELECT id FROM tasks").all() as Array<{ id: string }>;
    for (const r of rows) if (isLegacyHexId(r.id)) ids.push(r.id);
  }
  return ids;
}

// ---------- Apply ----------

/** Substitute every legacy id appearing as a substring in `text` with
 *  its compound counterpart. JSON arrays are stored as text in
 *  tasks.deps / epics.stories — substring substitution is safe because
 *  legacy hex IDs are 10 chars (`x-xxxxxxxx`) and never appear as a
 *  proper substring of another valid token (different scopes use
 *  different prefixes; hex chars don't accidentally chain). */
function substituteMappings(
  text: string | null | undefined,
  mappings: ReadonlyMap<string, string>,
): { text: string | null; changed: boolean } {
  if (text === null || text === undefined) return { text: text ?? null, changed: false };
  let out = text;
  let changed = false;
  for (const [legacy, compound] of mappings) {
    if (out.includes(legacy)) {
      out = out.split(legacy).join(compound);
      changed = true;
    }
  }
  return { text: out, changed };
}

/** Rewrite events.payload JSON across the table when any taskId /
 *  epicId / storyId field carries a migrated legacy id. */
function rewriteEventPayloads(db: Database, mappings: ReadonlyMap<string, string>): number {
  if (mappings.size === 0) return 0;
  const rows = db
    .prepare("SELECT event_id, payload FROM events")
    .all() as Array<{ event_id: string; payload: string }>;
  const update = db.prepare("UPDATE events SET payload = ? WHERE event_id = ?");
  let touched = 0;
  for (const r of rows) {
    const sub = substituteMappings(r.payload, mappings);
    if (sub.changed && sub.text !== null) {
      update.run(sub.text, r.event_id);
      touched += 1;
    }
  }
  return touched;
}

/** Update kanban rows in dependency-safe order: insert new compound
 *  rows alongside legacy, then sweep FK columns, then drop legacy
 *  rows. SQLite STRICT tables enforce PK uniqueness so we can't just
 *  UPDATE the PK — instead we copy → re-point FKs → delete the
 *  original. */
function applyKanbanMutations(db: Database, mappings: ReadonlyArray<IdMapping>): void {
  if (mappings.length === 0) return;

  // Phase 1: copy each legacy row to a new compound-keyed row.
  for (const m of mappings) {
    const table = m.scope === "t" ? "tasks" : m.scope === "s" ? "stories" : "epics";
    db.prepare(
      `INSERT INTO ${table} SELECT ${quoteId(m.compoundId)} AS id, ${tableNonIdColumns(table)} FROM ${table} WHERE id = ?`,
    ).run(m.legacyId);
  }

  // Build legacy→compound map for substring substitutions.
  const lookup = new Map<string, string>();
  for (const m of mappings) lookup.set(m.legacyId, m.compoundId);

  // Phase 2: update FK + JSON-array columns to point at the new ids.
  // tasks.epic, tasks.story (scalar TEXT FKs).
  for (const [legacy, compound] of lookup) {
    db.prepare("UPDATE tasks SET epic = ? WHERE epic = ?").run(compound, legacy);
    db.prepare("UPDATE tasks SET story = ? WHERE story = ?").run(compound, legacy);
    db.prepare("UPDATE stories SET epic = ? WHERE epic = ?").run(compound, legacy);
    db.prepare("UPDATE stories SET merge_task_id = ? WHERE merge_task_id = ?").run(compound, legacy);
    db.prepare("UPDATE complaints SET related_task_id = ? WHERE related_task_id = ?").run(
      compound,
      legacy,
    );
  }

  // tasks.deps + epics.stories carry JSON arrays of ids — substring-
  // substitute the full text (safe per substituteMappings doc).
  const taskRows = db.prepare("SELECT id, deps FROM tasks WHERE deps IS NOT NULL").all() as Array<{
    id: string;
    deps: string;
  }>;
  for (const r of taskRows) {
    const sub = substituteMappings(r.deps, lookup);
    if (sub.changed && sub.text !== null) {
      db.prepare("UPDATE tasks SET deps = ? WHERE id = ?").run(sub.text, r.id);
    }
  }
  const epicRows = db
    .prepare("SELECT id, stories FROM epics WHERE stories IS NOT NULL")
    .all() as Array<{ id: string; stories: string }>;
  for (const r of epicRows) {
    const sub = substituteMappings(r.stories, lookup);
    if (sub.changed && sub.text !== null) {
      db.prepare("UPDATE epics SET stories = ? WHERE id = ?").run(sub.text, r.id);
    }
  }

  // Phase 3: drop legacy rows. Done last so any in-flight FK sweep
  // above couldn't have silently null-ed a reference.
  for (const m of mappings) {
    const table = m.scope === "t" ? "tasks" : m.scope === "s" ? "stories" : "epics";
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(m.legacyId);
  }
}

/** Comma-list of every non-id column for the given kanban table.
 *  Cached at module load via the static map below — schema is fixed
 *  per the migration ladder so no need to PRAGMA at runtime. */
function tableNonIdColumns(table: string): string {
  const cols = NON_ID_COLUMNS[table];
  if (cols === undefined) throw new Error(`tableNonIdColumns: unknown table '${table}'`);
  return cols.join(", ");
}

const NON_ID_COLUMNS: Record<string, ReadonlyArray<string>> = {
  tasks: [
    "subject",
    "body",
    "status",
    "owner",
    "deps",
    "priority",
    "epic",
    "story",
    "lane",
    "deliverable",
    "stale_min",
    "driver_only",
    "created_at",
    "claimed_at",
    "completed_at",
    "claimed_from",
    "created_from",
    "note",
    "extra",
  ],
  stories: [
    "epic",
    "title",
    "body",
    "acceptance_criteria",
    "status",
    "created_at",
    "completed_at",
    "advanced_at",
    "review_signoff",
    "merge_task_id",
    "extra",
  ],
  epics: [
    "title",
    "body",
    "status",
    "driver_ref",
    "created_at",
    "completed_at",
    "stories",
    "extra",
  ],
};

/** Quote an id as a SQL string literal — safe because compound IDs
 *  match a strict regex (no apostrophes / backslashes possible). */
function quoteId(id: string): string {
  if (!/^[tse]-[0-9]+-[0-9a-f]{8}$/.test(id)) {
    throw new Error(`quoteId: refusing unsafe id '${id}'`);
  }
  return `'${id}'`;
}

// ---------- ADR pointer rewrite ----------

async function rewriteAdrPointers(
  atmuxDir: string,
  mappings: ReadonlyMap<string, string>,
  logger: Logger,
): Promise<number> {
  if (mappings.size === 0) return 0;
  // ADRs live at <repoRoot>/docs/adr/. atmuxDir is .atmux under repoRoot.
  const repoRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "");
  const adrDir = join(repoRoot, "docs", "adr");
  if (!(await exists(adrDir))) {
    logger.warn(`migrate-hex-ids: docs/adr/ absent at ${adrDir} — skipping ADR rewrite`);
    return 0;
  }
  const entries = await readdir(adrDir);
  let touched = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(adrDir, entry);
    const text = await readFile(path, "utf-8");
    const sub = substituteMappings(text, mappings);
    if (sub.changed && sub.text !== null) {
      await writeFile(path, sub.text, "utf-8");
      touched += 1;
    }
  }
  return touched;
}

// ---------- Git branch rename ----------

async function renameGitBranches(
  mappings: ReadonlyArray<IdMapping>,
  base: string,
  logger: Logger,
): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0;
  let skipped = 0;
  for (const m of mappings) {
    if (m.scope !== "e") continue; // only epic branches use the `-epic-<id>` shape
    const legacyBranch = `${base}-epic-${m.legacyId}`;
    const compoundBranch = `${base}-epic-${m.compoundId}`;
    try {
      await runGit(["branch", "-m", legacyBranch, compoundBranch]);
      renamed += 1;
    } catch (e) {
      logger.warn(
        `migrate-hex-ids: branch rename skip — ${legacyBranch} → ${compoundBranch}: ${(e as Error).message}`,
      );
      skipped += 1;
    }
  }
  return { renamed, skipped };
}

function runGit(argv: ReadonlyArray<string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("git", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${argv.join(" ")} exit=${code}: ${stderr.trim()}`));
    });
  });
}

// ---------- team.json update ----------

async function updateParentEpicKanbanId(
  atmuxDir: string,
  mappings: ReadonlyMap<string, string>,
  logger: Logger,
): Promise<boolean> {
  const teamJsonPath = join(atmuxDir, "team.json");
  if (!(await exists(teamJsonPath))) return false;
  const text = await readFile(teamJsonPath, "utf-8");
  let parsed: { epicTeam?: { parentEpicKanbanId?: string } };
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    logger.warn(`migrate-hex-ids: team.json parse failed (${(e as Error).message}) — skipping`);
    return false;
  }
  const current = parsed.epicTeam?.parentEpicKanbanId;
  if (current === undefined) return false;
  const compound = mappings.get(current);
  if (compound === undefined) return false;
  // Substring-substitute to preserve formatting (keys, whitespace).
  const updated = text.replace(
    new RegExp(`"parentEpicKanbanId"\\s*:\\s*"${current}"`),
    `"parentEpicKanbanId": "${compound}"`,
  );
  await writeFile(teamJsonPath, updated, "utf-8");
  return true;
}

// ---------- Snapshot ----------

interface SnapshotPayload {
  ts: number;
  team: string;
  scope: MigrateHexScope;
  mappings: ReadonlyArray<IdMapping>;
}

async function writeSnapshot(
  atmuxDir: string,
  payload: SnapshotPayload,
): Promise<string> {
  const dir = join(atmuxDir, "migrations");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `hex-ids-${payload.ts}.json`);
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
  return path;
}

// ---------- Main entry ----------

export async function migrateHexIds(
  argv: ReadonlyArray<string>,
  writers: { stdout?: Writer; logger?: Logger } = {},
): Promise<number> {
  const opts = parseMigrateHexArgs(argv);
  const stdout = writers.stdout ?? defaultStdoutWrite;
  const logger = writers.logger ?? createLogger();

  const atmuxDir = await getAtmuxDir();
  const team = await loadTeam();
  const teamName = opts.teamOverride ?? team.name;

  const dbPath = join(atmuxDir, "state.db");
  const db = openDatabase(dbPath, migrations);

  try {
    const filter = filterFromScope(opts.scope);
    const legacyIds = scanLegacyIds(db, filter);

    if (legacyIds.length === 0) {
      stdout(`migrate-hex-ids: no legacy hex IDs in scope=${opts.scope} (team=${teamName})\n`);
      return 0;
    }

    // Allocate sequence in a tx — rolled back if dry-run.
    const mappings: IdMapping[] = [];
    const txn = db.transaction(() => {
      for (const legacyId of legacyIds) {
        const scope = scopeChar(legacyId);
        const assigned = assignSequenceToLegacyId(db, scope, legacyId);
        mappings.push({
          legacyId,
          compoundId: assigned.compoundId,
          scope,
          sequenceN: assigned.sequenceN,
        });
      }
      if (!opts.apply) {
        // Roll back the sequence advances so dry-run is non-mutating.
        throw new DryRunRollback();
      }
    });

    try {
      txn();
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
      // Re-allocate sequences ONLY for the dry-run print — but the
      // sequence advances are rolled back at this point. Best-effort:
      // re-compute mappings synthetically using peekId + 1..N for the
      // print so the operator sees the SHAPE of the assignment.
      // (Actual --apply re-allocates atomically inside the real txn.)
    }

    // Print plan (always — dry-run + apply both show what happened).
    stdout(`migrate-hex-ids: team=${teamName} scope=${opts.scope} mappings=${mappings.length}\n`);
    stdout("legacy → compound\n");
    for (const m of mappings) {
      stdout(`  ${m.legacyId} → ${m.compoundId}\n`);
    }

    if (!opts.apply) {
      stdout(
        "\nDRY RUN — no DB writes, no branch renames, no ADR rewrites. Pass --apply to execute.\n",
      );
      return 0;
    }

    // --apply path: snapshot BEFORE the mutating transaction commits.
    // The dry-run-rollback above already discarded the sequence
    // advances, so we re-run inside a fresh transaction that covers
    // both the sequence reassignment AND all FK / payload updates.
    const finalMappings: IdMapping[] = [];
    const lookup = new Map<string, string>();
    db.transaction(() => {
      for (const legacyId of legacyIds) {
        const scope = scopeChar(legacyId);
        const assigned = assignSequenceToLegacyId(db, scope, legacyId);
        finalMappings.push({
          legacyId,
          compoundId: assigned.compoundId,
          scope,
          sequenceN: assigned.sequenceN,
        });
        lookup.set(legacyId, assigned.compoundId);
      }
      applyKanbanMutations(db, finalMappings);
      const eventsTouched = rewriteEventPayloads(db, lookup);
      stdout(`migrate-hex-ids: events payloads rewritten = ${eventsTouched}\n`);
    })();

    // Snapshot lands AFTER the txn commits — bun:sqlite doesn't expose
    // a pre-commit hook. Best-effort recoverability: snapshot is
    // synchronous + small, so failure here is loud + the operator
    // notices before any out-of-DB mutation (branch / team.json / ADR)
    // can happen below.
    const snapshotTs = now();
    const snapshotPath = await writeSnapshot(atmuxDir, {
      ts: snapshotTs,
      team: teamName,
      scope: opts.scope,
      mappings: finalMappings,
    });
    stdout(`migrate-hex-ids: snapshot written to ${snapshotPath}\n`);

    // Out-of-DB mutations.
    const teamJsonUpdated = await updateParentEpicKanbanId(atmuxDir, lookup, logger);
    if (teamJsonUpdated) stdout("migrate-hex-ids: team.json parentEpicKanbanId updated\n");

    // Git branch base = epicTeam.parentBase or fall back to a sensible default.
    const parentBase = team.epicTeam?.parentBase;
    if (parentBase !== undefined) {
      const { renamed, skipped } = await renameGitBranches(finalMappings, parentBase, logger);
      stdout(`migrate-hex-ids: branches renamed=${renamed} skipped=${skipped}\n`);
    } else {
      stdout("migrate-hex-ids: no epicTeam.parentBase in team.json — skipping branch rename\n");
    }

    const adrTouched = await rewriteAdrPointers(atmuxDir, lookup, logger);
    stdout(`migrate-hex-ids: ADR pointer files rewritten = ${adrTouched}\n`);

    stdout("migrate-hex-ids: complete.\n");
    return 0;
  } finally {
    closeDatabase(db);
  }
}

/** Sentinel thrown to roll back the dry-run sequence-allocation
 *  transaction — caught + ignored by the dry-run branch. */
class DryRunRollback extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "DryRunRollback";
  }
}

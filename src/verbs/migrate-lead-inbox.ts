// ADR-198 §Decision-anchor #3 — per-cage on-disk walker that retires
// the legacy `.atmux/driver-inbox.md` in favour of the canonical
// `.atmux/lead-inbox.md`.
//
// `atmux migrate-lead-inbox [--dry-run] [--team-dir <dir>] [--json]`
//
// Discovery (ADR-198 AC §2):
//   - default: walk every enabled team + nested epic-team from
//     `cockpit.json::sessions[]` via `loadCockpit` + `walkSessions`;
//     compute per-cage `.atmux/` paths (epic-teams live at
//     `<parentRoot>-epics/<epicId>/.atmux/` per ADR-090).
//   - `--team-dir <dir>`: single-cage mode (skip cockpit walk) — useful
//     when there's no cockpit on disk yet or for ad-hoc verb invocations
//     from inside a cage cwd.
//
// Idempotency branches per cage (ADR-198 AC §3):
//   1. both files absent       → noop  ("nothing to migrate")
//   2. only canonical present  → noop  ("already migrated")
//   3. only legacy present     → rename driver-inbox.md → lead-inbox.md
//   4. both present (race)     → append-merge by mtime: older file's
//                                content goes first, newer second;
//                                canonical header retained; legacy is
//                                unlinked after the merged write lands.
//
// Realpath resolution (ADR-198 OQ#1): symlinks are resolved before any
// stat / rename / unlink — operators who symlinked their state files
// don't get a corrupted state.
//
// Logging: every non-noop action appends a JSONL row to
// `<atmuxDir>/logs/migration.log` so the rollback path (per ADR-198
// §Rollback path) can replay the migration in reverse if needed.
//
// Sequential per-cage execution (ADR-198 AC §5) — no parallel mv. The
// caller is the only one writing to a given cage at a time during the
// migration window; the walker itself does NOT take a lock (the cage's
// pane processes already manage their own state-file coordination).

import { realpath as fsRealpath, rename as fsRename } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDir,
  exists,
  readTextOrNull,
  removeFile,
  statOrNull,
  writeText,
} from "../abstractions/fs.ts";
import { nowIso } from "../abstractions/time.ts";
import { type LoadedCockpit, loadCockpit, walkSessions } from "../core/cockpit.ts";
import {
  driverInboxLegacyPath,
  getAtmuxDir,
  leadInboxPath,
  logsDir,
  type ResolveDirOpts,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { LEAD_INBOX_HEADER } from "../core/lead-inbox.ts";
import { UsageError } from "../errors.ts";
import type { CockpitSessionT } from "../schema/cockpit.ts";

const USAGE = "atmux migrate-lead-inbox [--dry-run] [--team-dir <dir>] [--json]";

// ---------- Args ----------

export interface MigrateLeadInboxArgs {
  dryRun: boolean;
  json: boolean;
  teamDir?: string;
}

export function parseMigrateLeadInboxArgs(argv: ReadonlyArray<string>): MigrateLeadInboxArgs {
  let dryRun = false;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "migrate-lead-inbox: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `migrate-lead-inbox: unknown arg: ${a ?? ""}`,
      hint: USAGE,
    });
  }
  const out: MigrateLeadInboxArgs = { dryRun, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Per-cage migration ----------

/** Outcome of a per-cage migration step. `action` names the branch
 *  taken; `dryRun` indicates whether the action was applied (false) or
 *  just planned (true). `error` is set when the action threw mid-flight
 *  — the walker continues to the next cage but reports the failure. */
export type MigrationAction =
  | "noop-both-absent"
  | "noop-canonical-only"
  | "rename-legacy-to-canonical"
  | "merge-both-by-mtime"
  | "error";

export interface MigrationResult {
  cageLabel: string;
  atmuxDir: string;
  action: MigrationAction;
  dryRun: boolean;
  legacyPath?: string;
  canonicalPath?: string;
  /** Set when `action === "merge-both-by-mtime"` — informational. */
  mergeOrder?: "legacy-first" | "canonical-first";
  /** Set when `action === "error"`. */
  error?: string;
}

/** Realpath a path; on ENOENT or other failure, fall back to the
 *  literal path. Pure I/O. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fsRealpath(p);
  } catch {
    return p;
  }
}

/** ADR-198 §Decision-anchor #3 — migrate a single cage. Pure-IO; never
 *  throws (errors land in `result.action="error"` so the walker
 *  continues to the next cage). */
export async function migrateCageInbox(
  atmuxDir: string,
  cageLabel: string,
  dryRun: boolean,
): Promise<MigrationResult> {
  const legacy = await safeRealpath(driverInboxLegacyPath(atmuxDir));
  const canonical = await safeRealpath(leadInboxPath(atmuxDir));

  // If realpath collapsed legacy + canonical to the same inode (operator
  // already symlinked one to the other), treat as already-migrated.
  if (legacy === canonical) {
    return {
      cageLabel,
      atmuxDir,
      action: "noop-canonical-only",
      dryRun,
      legacyPath: legacy,
      canonicalPath: canonical,
    };
  }

  const [legacyStat, canonicalStat] = await Promise.all([
    statOrNull(legacy),
    statOrNull(canonical),
  ]);

  if (legacyStat === null && canonicalStat === null) {
    return { cageLabel, atmuxDir, action: "noop-both-absent", dryRun };
  }
  if (legacyStat === null && canonicalStat !== null) {
    return {
      cageLabel,
      atmuxDir,
      action: "noop-canonical-only",
      dryRun,
      canonicalPath: canonical,
    };
  }

  if (legacyStat !== null && canonicalStat === null) {
    // Branch 3: simple rename. Atomic when same filesystem (rename(2)).
    if (!dryRun) {
      try {
        await fsRename(legacy, canonical);
        await appendMigrationLog(atmuxDir, {
          ts: nowIso(),
          action: "rename",
          from: legacy,
          to: canonical,
        });
      } catch (e) {
        return {
          cageLabel,
          atmuxDir,
          action: "error",
          dryRun,
          legacyPath: legacy,
          canonicalPath: canonical,
          error: String(e),
        };
      }
    }
    return {
      cageLabel,
      atmuxDir,
      action: "rename-legacy-to-canonical",
      dryRun,
      legacyPath: legacy,
      canonicalPath: canonical,
    };
  }

  // Branch 4: both present — concat-merge by mtime + delete legacy.
  // Older file's content goes first so newer entries appear at the
  // tail (matches the `## Open` append-only convention). The
  // canonical header is retained from whichever block contained it;
  // if neither does (rare on hand-edited files), we prepend
  // LEAD_INBOX_HEADER before either block. `readLeadInbox` (T1's
  // read-shim) handles the merged view live; this step makes that
  // merge durable.
  if (legacyStat === null || canonicalStat === null) {
    // unreachable (TypeScript narrowing) — fall through to noop.
    return { cageLabel, atmuxDir, action: "noop-both-absent", dryRun };
  }
  const order: "legacy-first" | "canonical-first" =
    legacyStat.mtimeMs <= canonicalStat.mtimeMs ? "legacy-first" : "canonical-first";

  if (dryRun) {
    return {
      cageLabel,
      atmuxDir,
      action: "merge-both-by-mtime",
      dryRun: true,
      legacyPath: legacy,
      canonicalPath: canonical,
      mergeOrder: order,
    };
  }

  try {
    const legacyText = (await readTextOrNull(legacy)) ?? "";
    const canonicalText = (await readTextOrNull(canonical)) ?? "";
    const merged = composeMergedInbox(legacyText, canonicalText, order);
    await writeText(canonical, merged);
    await removeFile(legacy);
    await appendMigrationLog(atmuxDir, {
      ts: nowIso(),
      action: "merge-delete",
      legacy,
      canonical,
      mergedBytes: merged.length,
      mergeOrder: order,
    });
  } catch (e) {
    return {
      cageLabel,
      atmuxDir,
      action: "error",
      dryRun,
      legacyPath: legacy,
      canonicalPath: canonical,
      mergeOrder: order,
      error: String(e),
    };
  }

  return {
    cageLabel,
    atmuxDir,
    action: "merge-both-by-mtime",
    dryRun: false,
    legacyPath: legacy,
    canonicalPath: canonical,
    mergeOrder: order,
  };
}

/** Compose the merged-inbox text. Preserves whichever block carries the
 *  canonical/legacy `# Lead Inbox` / `# Driver Inbox` header (the
 *  `## Open` section anchor flows from there); if neither block has a
 *  header line at all (e.g. hand-edited body-only files), prepend
 *  `LEAD_INBOX_HEADER` to keep parsers happy.
 *
 *  Exported for direct unit testing of the merge logic without an
 *  on-disk fixture. */
export function composeMergedInbox(
  legacyText: string,
  canonicalText: string,
  order: "legacy-first" | "canonical-first",
): string {
  const blocks =
    order === "legacy-first" ? [legacyText, canonicalText] : [canonicalText, legacyText];
  const hasHeader = (s: string): boolean => /^#\s+(Lead|Driver)\s+Inbox\b/m.test(s);
  // Only strip the second block's header when the FIRST block carries
  // one — otherwise the second block IS the canonical header carrier
  // (e.g. one block is empty) and we want to keep its header intact.
  const firstHasHeader = blocks[0] !== undefined && blocks[0].length > 0 && hasHeader(blocks[0]);

  const trimmedBlocks = blocks.map((b, i) => {
    if (b.length === 0) return "";
    if (i === 0) return b.replace(/[\r\n]+$/, "");
    if (firstHasHeader && hasHeader(b)) {
      return (
        b
          // Drop everything from the start through the `## Open\n` line
          // (inclusive) on the second block — that header content is
          // already in the first block.
          .replace(/^[\s\S]*?##\s+Open\s*[\r\n]+/m, "")
          .replace(/[\r\n]+$/, "")
      );
    }
    return b.replace(/[\r\n]+$/, "");
  });

  const body = trimmedBlocks.filter((b) => b.length > 0).join("\n\n");
  const anyHeader = blocks.some((b) => b.length > 0 && hasHeader(b));
  if (anyHeader) {
    return `${body}\n`;
  }
  // No headers in either non-empty block — prepend the canonical header
  // so the resulting file passes the lead-inbox parser's pre-first-entry
  // header-line handling.
  return `${LEAD_INBOX_HEADER}\n${body}\n`;
}

/** Append a JSONL row to `<atmuxDir>/logs/migration.log`. The directory
 *  is created on demand so a fresh cage with no `logs/` dir still gets
 *  logged. Best-effort: a logging failure does not bubble back to the
 *  caller (the rename / merge has already landed; losing the log is
 *  cosmetic). */
async function appendMigrationLog(atmuxDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = logsDir(atmuxDir);
    await ensureDir(dir);
    const path = join(dir, "migration.log");
    const line = `${JSON.stringify(entry)}\n`;
    const prior = (await readTextOrNull(path)) ?? "";
    await writeText(path, `${prior}${line}`);
  } catch {
    // intentional swallow — migration durability matters; log fidelity does not.
  }
}

// ---------- Cockpit discovery ----------

/** A cage to consider for migration. `cageLabel` is operator-facing
 *  (renders in dry-run plan + JSON report); `atmuxDir` is the path
 *  the per-cage migrator operates on. */
export interface CageTarget {
  cageLabel: string;
  atmuxDir: string;
}

/** Enumerate every team + epic-team cage discoverable from a cockpit
 *  snapshot. Team cages live at `<team.root>/.atmux/`; epic-team cages
 *  live at `<parentRoot>-epics/<epicId>/.atmux/` per ADR-090. Disabled
 *  nodes are EXCLUDED — they're transient + likely don't have a live
 *  cage on disk; an operator can target them explicitly via
 *  `--team-dir` if needed.
 *
 *  Exported for direct unit testing of the discovery walk. */
export function discoverCageTargets(cockpit: LoadedCockpit): CageTarget[] {
  const out: CageTarget[] = [];
  walkSessions(
    cockpit.sessions ?? [],
    0,
    (node: CockpitSessionT, _level: number, parentRoot: string | undefined) => {
      if (node.type === "team" && node.enabled) {
        out.push({
          cageLabel: `team:${node.name}`,
          atmuxDir: join(node.root, ".atmux"),
        });
      } else if (node.type === "epic-team" && node.enabled && parentRoot !== undefined) {
        const epicCage = join(`${parentRoot}-epics`, node.name);
        out.push({
          cageLabel: `epic-team:${node.parent}::${node.name}`,
          atmuxDir: join(epicCage, ".atmux"),
        });
      }
    },
  );
  return out;
}

// ---------- Public entrypoint ----------

export interface MigrateLeadInboxOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Test seam: override the cockpit loader. Default: `loadCockpit()`. */
  loadCockpitFn?: () => Promise<LoadedCockpit>;
}

export interface MigrateLeadInboxReport {
  dryRun: boolean;
  results: MigrationResult[];
  summary: {
    total: number;
    renamed: number;
    merged: number;
    skipped: number;
    errors: number;
  };
}

/** `atmux migrate-lead-inbox`. Returns 0 on success (including all-noop
 *  + dry-run paths). Returns 1 if any cage hit an error during a non-
 *  dry-run pass (other cages still complete; the error rows surface in
 *  the report). */
export async function migrateLeadInbox(
  argv: ReadonlyArray<string>,
  opts: MigrateLeadInboxOpts = {},
): Promise<number> {
  const parsed = parseMigrateLeadInboxArgs(argv);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  let targets: CageTarget[];
  if (parsed.teamDir !== undefined) {
    const dirOpts: ResolveDirOpts = { teamDir: parsed.teamDir };
    const atmuxDir = await getAtmuxDir(dirOpts);
    targets = [{ cageLabel: `team-dir:${parsed.teamDir}`, atmuxDir }];
  } else {
    // No --team-dir → walk cockpit. If cockpit absent OR empty, walk
    // surfaces zero cages — operator sees "no cages found" in the
    // report; verb still exits 0 (nothing to do is not an error).
    const cockpit = await (opts.loadCockpitFn ?? loadCockpit)();
    targets = discoverCageTargets(cockpit);
  }

  // ADR-198 §Decision-anchor #3 — STRICT sequential per-cage. No
  // Promise.all; one cage at a time.
  const results: MigrationResult[] = [];
  for (const t of targets) {
    // Skip cages where `.atmux/` itself doesn't exist on disk (the
    // cockpit may list a team whose worktree was deleted out-of-band).
    if (!(await exists(t.atmuxDir))) {
      continue;
    }
    const r = await migrateCageInbox(t.atmuxDir, t.cageLabel, parsed.dryRun);
    results.push(r);
  }

  const summary = summarize(results);
  const report: MigrateLeadInboxReport = { dryRun: parsed.dryRun, results, summary };

  if (parsed.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stderr(renderHuman(report));
  }

  return summary.errors > 0 ? 1 : 0;
}

function summarize(results: ReadonlyArray<MigrationResult>): MigrateLeadInboxReport["summary"] {
  let renamed = 0;
  let merged = 0;
  let skipped = 0;
  let errors = 0;
  for (const r of results) {
    switch (r.action) {
      case "rename-legacy-to-canonical":
        renamed += 1;
        break;
      case "merge-both-by-mtime":
        merged += 1;
        break;
      case "noop-both-absent":
      case "noop-canonical-only":
        skipped += 1;
        break;
      case "error":
        errors += 1;
        break;
    }
  }
  return { total: results.length, renamed, merged, skipped, errors };
}

function renderHuman(report: MigrateLeadInboxReport): string {
  const lines: string[] = [
    "",
    `📬 atmux migrate-lead-inbox (ADR-198${report.dryRun ? " — DRY RUN" : ""})`,
    "",
  ];
  if (report.results.length === 0) {
    lines.push("  (no cages discovered — check cockpit.json or pass --team-dir)");
  }
  for (const r of report.results) {
    const glyph = ACTION_GLYPH[r.action];
    const verb = ACTION_VERB[r.action];
    const tag = r.dryRun ? "[plan]" : "[done]";
    lines.push(`  ${glyph} ${tag} ${r.cageLabel} — ${verb}`);
    if (r.action === "error" && r.error !== undefined) {
      lines.push(`     → ${r.error}`);
    }
  }
  const { total, renamed, merged, skipped, errors } = report.summary;
  lines.push("");
  lines.push(
    `  ${total} cage(s): ${renamed} renamed · ${merged} merged · ${skipped} skipped · ${errors} error(s)`,
  );
  lines.push("");
  return lines.join("\n");
}

const ACTION_GLYPH: Record<MigrationAction, string> = {
  "noop-both-absent": "  ",
  "noop-canonical-only": "✅",
  "rename-legacy-to-canonical": "↪️ ",
  "merge-both-by-mtime": "🔀",
  error: "❌",
};

const ACTION_VERB: Record<MigrationAction, string> = {
  "noop-both-absent": "nothing to migrate (both files absent)",
  "noop-canonical-only": "already migrated (canonical present, no legacy)",
  "rename-legacy-to-canonical": "rename driver-inbox.md → lead-inbox.md",
  "merge-both-by-mtime": "merge legacy + canonical by mtime, delete legacy",
  error: "error during migration",
};

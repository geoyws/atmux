// ADR-152 T1 — `atmux blockers list` CLI verb.
//
// Thin wrapper over `src/core/blockers.ts::queryAllBlockers`. Owns:
//   - argv parsing (flags: --json, --class, --source, --max-age)
//   - DB lifecycle (openDatabase + closeDatabase)
//   - filter application (class / source / max-age)
//   - rendering (JSON or human table)
//
// Complaint surface is c-1d28fc72 (driver-claude-sopx 2026-05-15);
// foundation for ADR-151 unblocker (t-fba73bf8) which consumes the
// JSON form on every tick.
//
// Sub-verbs:
//
//   atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]
//       — fan out across 7 surfaces; print rows.
//
//   `--max-age` accepts the suffix-form (`30m`, `2h`, `7d`); rows
//   strictly older than the duration are filtered out. Bare integers
//   are interpreted as seconds.
//
// Table render is operator-readable (powerline-ish): id-prefix · class
// · age · summary. JSON is the unblocker / dashboard contract — stable
// row shape per `BlockerRow`.

import { join } from "node:path";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import {
  type BlockerClass,
  type BlockerRow,
  type BlockerSource,
  isBlockerClass,
  isBlockerSource,
  queryAllBlockers,
} from "../core/blockers.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { UsageError } from "../errors.ts";

function stateDbPath(atmuxDir: string): string {
  return join(atmuxDir, "state.db");
}

const USAGE = "atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]";

export interface ParsedBlockersArgs {
  subverb: "list";
  json?: boolean;
  class?: BlockerClass;
  source?: BlockerSource;
  maxAgeSec?: number;
}

/** Parse `30s` / `2h` / `7d` / `1234` (bare = seconds). Returns null on
 *  parse failure so the caller can produce a clean UsageError. */
export function parseDurationToSec(raw: string): number | null {
  if (!raw) return null;
  const m = raw.match(/^(\d+)([smhd])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n) || n < 0) return null;
  switch (unit) {
    case undefined:
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
  }
  return null;
}

export function parseBlockersArgs(argv: ReadonlyArray<string>): ParsedBlockersArgs {
  const sub = argv[0];
  if (!sub) {
    throw new UsageError({ what: "blockers: missing sub-verb", hint: USAGE });
  }
  if (sub !== "list") {
    throw new UsageError({
      what: `blockers: unknown sub-verb: ${sub}`,
      hint: USAGE,
    });
  }
  const out: ParsedBlockersArgs = { subverb: "list" };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        out.json = true;
        break;
      case "--class": {
        const v = argv[++i];
        if (!v) {
          throw new UsageError({ what: "--class requires value", hint: USAGE });
        }
        if (!isBlockerClass(v)) {
          throw new UsageError({
            what: `--class: unknown value: ${v}`,
            hint: USAGE,
          });
        }
        out.class = v;
        break;
      }
      case "--source": {
        const v = argv[++i];
        if (!v) {
          throw new UsageError({ what: "--source requires value", hint: USAGE });
        }
        if (!isBlockerSource(v)) {
          throw new UsageError({
            what: `--source: unknown value: ${v}`,
            hint: USAGE,
          });
        }
        out.source = v;
        break;
      }
      case "--max-age": {
        const v = argv[++i];
        if (!v) {
          throw new UsageError({ what: "--max-age requires value", hint: USAGE });
        }
        const sec = parseDurationToSec(v);
        if (sec === null) {
          throw new UsageError({
            what: `--max-age: bad duration: ${v} (use 30m, 2h, 7d)`,
            hint: USAGE,
          });
        }
        out.maxAgeSec = sec;
        break;
      }
      default:
        throw new UsageError({
          what: `blockers list: unknown arg: ${arg}`,
          hint: USAGE,
        });
    }
  }
  return out;
}

/** Apply the `--class / --source / --max-age` filters. Pure; testable
 *  without DB. */
export function applyFilters(
  rows: ReadonlyArray<BlockerRow>,
  parsed: ParsedBlockersArgs,
): BlockerRow[] {
  return rows.filter((r) => {
    if (parsed.class !== undefined && r.blocker_class !== parsed.class) {
      return false;
    }
    if (parsed.source !== undefined && r.source !== parsed.source) return false;
    if (parsed.maxAgeSec !== undefined && r.age_sec > parsed.maxAgeSec) {
      return false;
    }
    return true;
  });
}

/** Format `age_sec` per CLAUDE.md duration-formatting rule — `<60m` →
 *  `Nmin`; `≥60m` → `HhMm` or `Hh`; never raw minutes. `0` → `now`. */
export function formatAge(sec: number): string {
  if (sec <= 0) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}min`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Render rows as a fixed-column table — id, class, age, summary. */
export function renderTable(rows: ReadonlyArray<BlockerRow>): string {
  if (rows.length === 0) return "(no blockers)\n";
  const lines: string[] = [];
  lines.push(`${"ID".padEnd(40)} ${"CLASS".padEnd(18)} ${"AGE".padEnd(8)} SUMMARY`);
  for (const r of rows) {
    lines.push(
      `${r.id.padEnd(40)} ${r.blocker_class.padEnd(18)} ${formatAge(r.age_sec).padEnd(8)} ${r.summary}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function blockers(
  argv: ReadonlyArray<string>,
  dirOpts: ResolveDirOpts = {},
): Promise<number> {
  const parsed = parseBlockersArgs(argv);
  if (parsed.subverb !== "list") return 64;
  await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const db = openDatabase(stateDbPath(atmuxDir), migrations);
  try {
    const all = await queryAllBlockers(atmuxDir, db);
    const filtered = applyFilters(all, parsed);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
    } else {
      process.stdout.write(renderTable(filtered));
    }
    return 0;
  } finally {
    closeDatabase(db);
  }
}

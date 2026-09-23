// ADR-197: inventory and remove orphaned atmux-managed cron blocks.

import { spawnSync } from "node:child_process";

import { UsageError } from "../errors.ts";

const USAGE = "atmux cron-reaper [--dry-run|--apply] [--json]";
const MANAGED_PREFIXES = ["team", "pulse", "groom", "lane-tick", "poke"] as const;

type ManagedPrefix = (typeof MANAGED_PREFIXES)[number];
export type CronReaperStatus = "orphan" | "unknown";

export interface CronReaperEntry {
  prefix: ManagedPrefix;
  team: string;
  atmux_dir: string | null;
  status: CronReaperStatus;
  removed: boolean;
}

export interface CronReaperResult {
  dryRun: boolean;
  entries: CronReaperEntry[];
  removed: number;
}

export interface CronReaperDeps {
  readCrontab?: () => string | Promise<string>;
  writeCrontab?: (content: string) => void | Promise<void>;
  loadCockpitRoster?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  loadEpicTeamRegistry?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  stdout?: (text: string) => void;
}

interface ParsedArgs {
  apply: boolean;
  json: boolean;
}

interface CronBlock {
  start: number;
  end: number;
  prefix: ManagedPrefix;
  team: string;
  atmuxDir: string | null;
}

export function parseCronReaperArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const parsed: ParsedArgs = { apply: false, json: false };
  let modeSeen = false;
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "--apply") {
      if (modeSeen) throw usage("choose exactly one of --dry-run or --apply");
      modeSeen = true;
      parsed.apply = arg === "--apply";
    } else if (arg === "--json") {
      parsed.json = true;
    } else {
      throw usage(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/**
 * CLI implementation. A team is positively orphaned only when both roster
 * reads succeed and neither contains it. If either registry is unreadable,
 * absent names are reported as unknown and are never removed.
 */
export async function cronReaper(
  argv: ReadonlyArray<string>,
  deps: CronReaperDeps = {},
): Promise<number> {
  const flags = parseCronReaperArgs(argv);
  const readCrontab = deps.readCrontab ?? defaultReadCrontab;
  const writeCrontab = deps.writeCrontab ?? defaultWriteCrontab;
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const crontab = await readCrontab();
  const blocks = parseCronBlocks(crontab);

  const cockpitLoader = deps.loadCockpitRoster ?? defaultCockpitRoster;
   const epicTeamLoader = deps.loadEpicTeamRegistry ?? defaultEpicTeamRegistry;
   const [cockpit, epicTeams] = await Promise.allSettled([
      Promise.resolve().then(() => cockpitLoader()),
      Promise.resolve().then(() => epicTeamLoader()),
    ]);
  const known = new Set<string>();
  if (cockpit.status === "fulfilled") cockpit.value.forEach((name) => known.add(name));
  if (epicTeams.status === "fulfilled") epicTeams.value.forEach((name) => known.add(name));
  const rosterResolved = cockpit.status === "fulfilled" && epicTeams.status === "fulfilled";

  const entries = blocks
    .filter((block) => !known.has(block.team))
    .map<CronReaperEntry>((block) => ({
      prefix: block.prefix,
      team: block.team,
      atmux_dir: block.atmuxDir,
      status: rosterResolved ? "orphan" : "unknown",
      removed: flags.apply && rosterResolved,
    }));

  const removable = flags.apply && rosterResolved
    ? blocks.filter((block) => !known.has(block.team))
    : [];
  if (removable.length > 0) await writeCrontab(withoutBlocks(crontab, removable));

  const result: CronReaperResult = {
    dryRun: !flags.apply,
    entries,
    removed: removable.length,
  };
  printResult(result, flags.json, stdout);
  return 0;
}

/**
 * Remove every atmux-managed cron block whose exact marker identity is
 * `team`. This is the narrow teardown seam: it does not consult global
 * rosters because the caller has already removed the team from them.
 */
export async function removeCronBlocks(
  opts: { team: string; dryRun?: boolean },
  deps: CronReaperDeps = {},
): Promise<CronReaperResult> {
  if (opts.team.length === 0) throw usage("team must be non-empty");
  const readCrontab = deps.readCrontab ?? defaultReadCrontab;
  const writeCrontab = deps.writeCrontab ?? defaultWriteCrontab;
  const crontab = await readCrontab();
  const matches = parseCronBlocks(crontab).filter((block) => block.team === opts.team);
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && matches.length > 0) await writeCrontab(withoutBlocks(crontab, matches));
  return {
    dryRun,
    entries: matches.map((block) => ({
      prefix: block.prefix,
      team: block.team,
      atmux_dir: block.atmuxDir,
      status: "orphan",
      removed: !dryRun,
    })),
    removed: dryRun ? 0 : matches.length,
  };
}

function parseCronBlocks(crontab: string): CronBlock[] {
  const prefixAlternation = MANAGED_PREFIXES.join("|");
  const blockPattern = new RegExp(
    `^# >>> atmux:(${prefixAlternation})=([^\\s—]+)[^\\n]*(?:\\n|$)[\\s\\S]*?^# <<< atmux:\\1=\\2[^\\n]*(?:\\n|$)`,
    "gm",
  );
  const blocks: CronBlock[] = [];
  for (const match of crontab.matchAll(blockPattern)) {
    const text = match[0];
    const prefix = match[1] as ManagedPrefix;
    const team = match[2];
    if (text === undefined || team === undefined || match.index === undefined) continue;
    const dirMatch = /(?:^|\s)ATMUX_DIR=(?:"([^"]+)"|'([^']+)'|([^\s]+))/m.exec(text);
    blocks.push({
      start: match.index,
      end: match.index + text.length,
      prefix,
      team,
      atmuxDir: dirMatch?.[1] ?? dirMatch?.[2] ?? dirMatch?.[3] ?? null,
    });
  }
  return blocks;
}

function withoutBlocks(crontab: string, blocks: ReadonlyArray<CronBlock>): string {
  let cursor = 0;
  let rewritten = "";
  for (const block of blocks) {
    rewritten += crontab.slice(cursor, block.start);
    cursor = block.end;
  }
  return rewritten + crontab.slice(cursor);
}

function printResult(
  result: CronReaperResult,
  json: boolean,
  stdout: (text: string) => void,
): void {
  if (json) {
    stdout(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.entries.length === 0) return;
  stdout("STATUS\tPREFIX\tTEAM\tATMUX_DIR\tREMOVED\n");
  for (const entry of result.entries) {
    stdout(
      `${entry.status}\t${entry.prefix}\t${entry.team}\t${entry.atmux_dir ?? "-"}\t${entry.removed ? "yes" : "no"}\n`,
    );
  }
}

async function defaultCockpitRoster(): Promise<ReadonlyArray<string>> {
  const { loadCockpit } = await import("../core/cockpit.ts");
  const cockpit = await loadCockpit();
  return cockpit.teams.filter((team) => team.enabled !== false).map((team) => team.name);
}

async function defaultEpicTeamRegistry(): Promise<ReadonlyArray<string>> {
  // ADR-280 retired the separate epic-team discriminator/registry. Active
  // nested teams are now ordinary cockpit teams and are included above.
  return [];
}

function defaultReadCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.status === 0 && result.error === undefined) return result.stdout;
  if (result.status === 1 && /no crontab for/i.test(result.stderr)) return "";
  throw new Error(`cron-reaper: crontab -l failed: ${result.error?.message ?? result.stderr.trim()}`);
}

function defaultWriteCrontab(content: string): void {
  const result = spawnSync("crontab", ["-"], { encoding: "utf8", input: content });
  if (result.status === 0 && result.error === undefined) return;
  throw new Error(`cron-reaper: crontab - failed: ${result.error?.message ?? result.stderr.trim()}`);
}

function usage(what: string): UsageError {
  return new UsageError({ what: `cron-reaper: ${what}`, hint: USAGE });
}

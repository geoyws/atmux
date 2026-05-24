// ADR-221 §v2 — `list-workers` verb.
//
// `atmux team list-workers [--parent <team>] [--json]`
//
// Enumerates worker-team children of every enabled parent team in the
// cockpit (or filtered to a single parent via --from). A worker-team
// is an epic-team whose name starts with the `w-` prefix per ADR-221
// §v1 §Decision.
//
// Composition only — reuses `loadCockpit` + `enabledTeams` to walk the
// cockpit; this verb just filters the output by the `w-` prefix +
// renders. For activity-based classification (idle, drainable,
// dissolve-safe) operators continue to use `atmux team sweep-epics`
// — list-workers is read-only enumeration, not housekeeping.

import { join } from "node:path";
import { exists } from "../../abstractions/fs.ts";
import { enabledTeams, type LoadedCockpit, loadCockpit } from "../../core/cockpit.ts";
import { UsageError } from "../../errors.ts";

const USAGE = "atmux team list-workers [--parent <team>] [--json]";

// ---------- Arg parsing ----------

export interface ParsedListWorkersArgs {
  parent?: string;
  json: boolean;
}

export function parseListWorkersArgs(argv: ReadonlyArray<string>): ParsedListWorkersArgs {
  let parent: string | undefined;
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--parent") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "list-workers: --parent requires a value",
          hint: USAGE,
        });
      }
      parent = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `list-workers: unexpected arg: ${a}`,
      hint: USAGE,
    });
  }
  const out: ParsedListWorkersArgs = { json };
  if (parent !== undefined) out.parent = parent;
  return out;
}

// ---------- Output shape ----------

export interface WorkerEntry {
  workerId: string;
  parent: string;
  parentRoot: string;
  worktreeRoot: string;
  worktreePresent: boolean;
}

// ---------- Verb dependencies ----------

export interface ListWorkersOpts {
  loadCockpitFn?: () => Promise<LoadedCockpit>;
  /** Test seam — defaults to fs.exists. */
  pathExists?: (p: string) => Promise<boolean>;
  logger?: { log: (m: string) => void };
}

// ---------- Top-level dispatch ----------

export async function listWorkers(
  argv: ReadonlyArray<string>,
  opts: ListWorkersOpts = {},
): Promise<number> {
  const parsed = parseListWorkersArgs(argv);
  const load = opts.loadCockpitFn ?? (() => loadCockpit());
  const pathExists = opts.pathExists ?? exists;
  const logger = opts.logger ?? { log: (m: string) => process.stdout.write(`${m}\n`) };

  const cockpit = await load();
  const epics = enabledTeams(cockpit).filter((e) => e.type === "epic-team");

  const workers: WorkerEntry[] = [];
  for (const entry of epics) {
    if (entry.type !== "epic-team") continue;
    if (entry.parent === undefined || entry.epicId === undefined) continue;
    // Worker-team gate — ADR-221 §v1 convention.
    if (!entry.name.startsWith("w-")) continue;
    if (parsed.parent !== undefined && entry.parent !== parsed.parent) continue;
    const worktreeRoot = `${entry.root}-epics/${entry.epicId}`;
    workers.push({
      workerId: entry.name,
      parent: entry.parent,
      parentRoot: entry.root,
      worktreeRoot,
      worktreePresent: await pathExists(join(worktreeRoot, ".atmux", "team.json")),
    });
  }

  if (parsed.json) {
    logger.log(JSON.stringify({ workers }, null, 2));
    return 0;
  }
  logger.log(renderTable(workers));
  return 0;
}

// ---------- Rendering ----------

function renderTable(workers: ReadonlyArray<WorkerEntry>): string {
  if (workers.length === 0) {
    return "# list-workers — no worker-teams in cockpit";
  }
  const lines: string[] = [];
  lines.push(`# list-workers — ${workers.length} worker-team(s)`);
  lines.push("");
  lines.push("| worker-id | parent | worktree | present |");
  lines.push("|---|---|---|---|");
  for (const w of workers) {
    lines.push(
      `| ${w.workerId} | ${w.parent} | ${w.worktreeRoot} | ${w.worktreePresent ? "y" : "n"} |`,
    );
  }
  return lines.join("\n");
}

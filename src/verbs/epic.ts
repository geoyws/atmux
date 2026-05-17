// ADR-010: CLI dispatcher — `epic` verb. Subverb dispatch + display only.
// Bash spec: lib/epic.sh @ worktree-frozen.
//
// Subverb routing (1:1 parity with bash):
//
//   atmux epic add     <title> [--body T] [--driver-ref R]
//   atmux epic list    [--status S] [--json]
//   atmux epic ls      ↔ list
//   atmux epic show    <id> [--json]
//   atmux epic get     ↔ show
//   atmux epic advance <id> [--to S]
//   atmux epic adv     ↔ advance

import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import { addEpic, advanceEpic, listEpics, showEpic } from "../core/epic.ts";
import { ConfigError, UsageError } from "../errors.ts";

const USAGE_HINT_ROOT = "atmux epic <add|list|show|advance> [args]";
const USAGE_ADD = "atmux epic add <title> [--body T] [--driver-ref R]";
const USAGE_LIST = "atmux epic list [--status S] [--json]";
const USAGE_SHOW = "atmux epic show <id> [--json]";
const USAGE_ADV = "atmux epic advance <id> [--to <state>]";

export async function epic(argv: ReadonlyArray<string>): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    throw new UsageError({
      what: "epic: missing verb (add|list|show|advance)",
      hint: USAGE_HINT_ROOT,
    });
  }
  const rest = argv.slice(1);
  switch (first) {
    case "add":
      return await epicAdd(rest);
    case "list":
    case "ls":
      return await epicList(rest);
    case "show":
    case "get":
      return await epicShow(rest);
    case "advance":
    case "adv":
      return await epicAdvance(rest);
    default:
      throw new UsageError({
        what: `epic: unknown verb: ${first} (use add|list|show|advance)`,
        hint: USAGE_HINT_ROOT,
      });
  }
}

// ---------- Subverbs ----------

async function epicAdd(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseAddArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const opts: Parameters<typeof addEpic>[1] = { title: parsed.title };
  if (parsed.body !== undefined) opts.body = parsed.body;
  if (parsed.driverRef !== undefined) opts.driverRef = parsed.driverRef;
  const id = await addEpic(atmuxDir, opts);
  process.stderr.write(`epic: added ${id} — ${parsed.title}\n`);
  process.stdout.write(`${id}\n`);
  return 0;
}

async function epicList(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseListArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const filter = parsed.status !== undefined ? { status: parsed.status } : {};
  const epics = await listEpics(atmuxDir, filter);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(epics, null, 2)}\n`);
    return 0;
  }
  if (epics.length === 0) {
    process.stdout.write("(no epics)\n");
    return 0;
  }
  process.stdout.write(`${"ID".padEnd(12)} ${"STATUS".padEnd(12)} ${"CREATED".padEnd(12)} TITLE\n`);
  for (const e of epics) {
    const id = (e.id ?? "").padEnd(12);
    const status = (e.status ?? "").padEnd(12);
    const created = String(e.createdAt ?? 0).padEnd(12);
    process.stdout.write(`${id} ${status} ${created} ${e.title ?? ""}\n`);
  }
  return 0;
}

async function epicShow(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "epic show: <id> required", hint: USAGE_SHOW });
  }
  const { json, teamDir } = parseShowFlags(rest);
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const epic = await showEpic(atmuxDir, id);
  if (epic === null) {
    throw new ConfigError({ what: `epic show: no such epic: ${id}` });
  }
  if (json) {
    // Bash --json shape: epic record + { stories: [...], tasks: [...] }.
    const out = {
      ...epic,
      stories: epic.storyRows,
      tasks: epic.tasks,
    };
    // Drop the internal storyRows alias on output (we keep .stories as
    // the joined-row array, matching bash's --json shape).
    const { storyRows: _, ...withoutAlias } = out;
    process.stdout.write(`${JSON.stringify(withoutAlias, null, 2)}\n`);
    return 0;
  }
  // Human tree view mirror.
  const lines: string[] = [];
  lines.push(`${epic.id} [${epic.status ?? ""}] — ${epic.title ?? ""}`);
  if (epic.body !== null && epic.body !== undefined && epic.body.length > 0) {
    lines.push(`  body: ${epic.body}`);
  }
  if (epic.driverRef !== null && epic.driverRef !== undefined) {
    lines.push(`  ref:  ${epic.driverRef}`);
  }
  if (epic.storyRows.length > 0) {
    lines.push("");
    lines.push("Stories:");
    for (const s of epic.storyRows) {
      lines.push(`  ${s.id} [${s.status ?? ""}] — ${s.title ?? ""}`);
      const childTasks = epic.tasks.filter((t) => t.story === s.id);
      for (const t of childTasks) {
        lines.push(`    task ${t.id} [${t.status ?? ""}] — ${t.subject ?? ""}`);
      }
    }
  }
  const directTasks = epic.tasks.filter(
    (t) => t.story === null || t.story === undefined || t.story.length === 0,
  );
  if (directTasks.length > 0) {
    lines.push("");
    lines.push("Direct tasks:");
    for (const t of directTasks) {
      lines.push(`  ${t.id} [${t.status ?? ""}] — ${t.subject ?? ""}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function epicAdvance(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "epic advance: <id> required", hint: USAGE_ADV });
  }
  const { to, teamDir } = parseAdvanceFlags(rest);
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const result = await advanceEpic(atmuxDir, id, to);
  if (result.noop) {
    process.stderr.write(`epic: ${id} already ${result.from} (no-op)\n`);
    return 0;
  }
  process.stderr.write(`epic: ${id} ${result.from} → ${result.to}\n`);
  if (result.summaryTaskId !== null) {
    process.stderr.write(
      `epic: dispatched summary task ${result.summaryTaskId} (role=team-lead, review entry)\n`,
    );
  }
  return 0;
}

// ---------- Pure parsers ----------

interface ParsedAddArgs {
  title: string;
  body?: string;
  driverRef?: string;
  teamDir?: string;
}

export function parseAddArgs(argv: ReadonlyArray<string>): ParsedAddArgs {
  let title = "";
  let body: string | undefined;
  let driverRef: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--body") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "epic add: --body requires a value", hint: USAGE_ADD });
      }
      body = v;
      i += 2;
      continue;
    }
    if (a === "--driver-ref") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "epic add: --driver-ref requires a value",
          hint: USAGE_ADD,
        });
      }
      driverRef = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "epic add: --team-dir requires a value", hint: USAGE_ADD });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--") {
      title = argv.slice(i + 1).join(" ");
      break;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `epic add: unknown flag: ${a}`, hint: USAGE_ADD });
    }
    title = title.length === 0 ? (a ?? "") : `${title} ${a ?? ""}`;
    i += 1;
  }
  if (title.length === 0) {
    throw new UsageError({ what: "epic add: <title> required", hint: USAGE_ADD });
  }
  const out: ParsedAddArgs = { title };
  if (body !== undefined) out.body = body;
  if (driverRef !== undefined) out.driverRef = driverRef;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

interface ParsedListArgs {
  status?: string;
  json: boolean;
  teamDir?: string;
}

export function parseListArgs(argv: ReadonlyArray<string>): ParsedListArgs {
  let status: string | undefined;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--status") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "epic list: --status requires a value", hint: USAGE_LIST });
      }
      status = v;
      i += 2;
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
          what: "epic list: --team-dir requires a value",
          hint: USAGE_LIST,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `epic list: unknown arg: ${a ?? ""}`, hint: USAGE_LIST });
  }
  const out: ParsedListArgs = { json };
  if (status !== undefined) out.status = status;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

function splitFlagsAndPositionals(argv: ReadonlyArray<string>): {
  positional: string[];
  rest: string[];
} {
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (a.startsWith("-")) break;
    positional.push(a);
    i += 1;
  }
  return { positional, rest: argv.slice(i) };
}

interface ShowFlags {
  json: boolean;
  teamDir?: string;
}

function parseShowFlags(argv: ReadonlyArray<string>): ShowFlags {
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "epic show: --team-dir requires a value",
          hint: USAGE_SHOW,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `epic show: unknown flag: ${a ?? ""}`, hint: USAGE_SHOW });
  }
  const out: ShowFlags = { json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

interface AdvanceFlags {
  to?: string;
  teamDir?: string;
}

function parseAdvanceFlags(argv: ReadonlyArray<string>): AdvanceFlags {
  let to: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--to") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "epic advance: --to requires a value", hint: USAGE_ADV });
      }
      to = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "epic advance: --team-dir requires a value",
          hint: USAGE_ADV,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `epic advance: unknown flag: ${a ?? ""}`, hint: USAGE_ADV });
  }
  const out: AdvanceFlags = {};
  if (to !== undefined) out.to = to;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

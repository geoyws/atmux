// ADR-010: CLI dispatcher — `task` verb (subverb dispatch).
// Bash spec: lib/kanban.sh::main @ worktree-frozen.
//
// Subverb routing (1:1 parity with bash):
//
//   atmux task add    <subject> [--body T] [--assignee M] [--deps a,b]
//                                [--priority N | --prio N]
//   atmux task list   [--status S] [--assignee M] [--json]
//   atmux task ls     ↔ list
//   atmux task show   <id>
//   atmux task get    ↔ show
//   atmux task move   <id> <todo|in-progress|done|blocked>
//   atmux task mv     ↔ move
//   atmux task assign <id> <member>
//   atmux task rm     <id>
//   atmux task remove ↔ rm
//
// Bash defaults to `list` when no subverb given (lib/kanban.sh:16).
// Mirror.
//
// All real mutations live in `core/kanban.ts`; this verb is pure
// CLI plumbing (flag parsing + subverb routing + tabular printing
// for the `list` output).

import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import { removeFromInProgress } from "../core/inbox.ts";
import {
  addTask,
  assignTask,
  type ListTasksFilter,
  listTasks,
  moveTask,
  removeTask,
  setTaskLane,
  showTask,
} from "../core/kanban.ts";
import { ConfigError, UsageError } from "../errors.ts";

/** Statuses where the task is no longer the assignee's responsibility,
 *  so its `inbox.inProgress` entry should be drained. `done` is handled
 *  by `atmux done` (which appends to `inbox.done` instead) — this set
 *  covers the parking statuses bash never drained: `blocked` (parked
 *  by lead) and `todo` (un-claim / bounce-back). t-e452296b. */
const STATUSES_THAT_DRAIN_INBOX = new Set(["blocked", "todo"]);

const USAGE_HINT_ROOT =
  "atmux task <add|list|show|move|assign|lane|rm> [args] " +
  "(see 'atmux task' for per-subverb help)";

const USAGE_ADD =
  "atmux task add <subject> [--body T] [--assignee M] [--deps a,b] [--priority N] [--lane L]";
const USAGE_LIST = "atmux task list [--status S] [--assignee M] [--lane L] [--json]";
const USAGE_MOVE = "atmux task move <id> <todo|in-progress|done|blocked>";
const USAGE_LANE = "atmux task lane <id> <fe|be|db|ops|test|review|misc|git|docs|->";

const VALID_STATUSES = new Set(["todo", "in-progress", "done", "blocked"]);
/** Lane enum (mirrors `KanbanLane` in src/schema/kanban.ts). `-` clears
 *  the lane (sets to null). `git` + `docs` added 2026-05-08 for role-
 *  specific lanes (gitter pulls commits/merges; docs pulls writing tasks). */
const VALID_LANES = new Set(["fe", "be", "db", "ops", "test", "review", "misc", "git", "docs", "-"]);

/**
 * `atmux task <subverb> [args]`. Returns 0 on success; throws
 * `UsageError` / `ConfigError` for the caller to map per ADR-006.
 */
export async function task(argv: ReadonlyArray<string>): Promise<number> {
  // Bash defaults to `list` when no subverb given (lib/kanban.sh:16).
  // We also default to `list` when argv[0] is a flag — `atmux task
  // --team-dir /x` is unambiguously "list with --team-dir".
  const first = argv[0];
  const isFlag = first !== undefined && first.startsWith("-");
  const verb = first === undefined || isFlag ? "list" : first;
  const rest = first === undefined || isFlag ? argv : argv.slice(1);
  switch (verb) {
    case "add":
      return await taskAdd(rest);
    case "list":
    case "ls":
      return await taskList(rest);
    case "show":
    case "get":
      return await taskShow(rest);
    case "move":
    case "mv":
      return await taskMove(rest);
    case "assign":
      return await taskAssign(rest);
    case "lane":
      return await taskLane(rest);
    case "rm":
    case "remove":
      return await taskRemove(rest);
    default:
      throw new UsageError({
        what: `task: unknown verb: ${verb} (use add|list|show|move|assign|rm)`,
        hint: USAGE_HINT_ROOT,
      });
  }
}

// ---------- Subverbs ----------

async function taskAdd(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseAddArgs(argv);
  const dirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const opts: Parameters<typeof addTask>[1] = { subject: parsed.subject };
  if (parsed.body !== undefined) opts.body = parsed.body;
  if (parsed.assignee !== undefined) opts.assignee = parsed.assignee;
  if (parsed.deps !== undefined) opts.deps = parsed.deps;
  if (parsed.priority !== undefined) opts.priority = parsed.priority;
  if (parsed.lane !== undefined) opts.lane = parsed.lane;
  const id = await addTask(atmuxDir, opts);
  process.stdout.write(`${id}\n`);
  return 0;
}

// `atmux task lane <id> <fe|be|db|ops|test|review|misc|->`
async function taskLane(argv: ReadonlyArray<string>): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const teamDir = (() => {
    const idx = argv.indexOf("--team-dir");
    return idx >= 0 ? argv[idx + 1] : undefined;
  })();
  if (positional.length !== 2) {
    throw new UsageError({
      what: "task lane: requires <id> and <lane>",
      hint: USAGE_LANE,
    });
  }
  const [id, laneArg] = positional as [string, string];
  if (!VALID_LANES.has(laneArg)) {
    throw new UsageError({
      what: `task lane: lane must be one of fe|be|db|ops|test|review|misc|git|docs|- (got: ${laneArg})`,
      hint: USAGE_LANE,
    });
  }
  const dirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  // `-` clears the lane (sets to null).
  const lane = laneArg === "-" ? null : laneArg;
  await setTaskLane(atmuxDir, id, lane);
  return 0;
}

async function taskList(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseListArgs(argv);
  const dirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const filter: ListTasksFilter = {};
  if (parsed.status !== undefined) filter.status = parsed.status;
  if (parsed.assignee !== undefined) filter.assignee = parsed.assignee;
  if (parsed.lane !== undefined) filter.lane = parsed.lane;
  const tasks = await listTasks(atmuxDir, filter);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return 0;
  }
  if (tasks.length === 0) {
    process.stdout.write("(no tasks)\n");
    return 0;
  }
  // Bash sort: priority ascending with `99` default for null/missing
  // (lib/kanban.sh:91 `sort_by(.priority // 99)`). Stable sort —
  // tasks with equal priority keep insertion order.
  const sorted = [...tasks].sort((a, b) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    return pa - pb;
  });
  // Bash header + columns: ID(10) STATUS(13) OWNER(14) PRIO(4) SUBJECT
  process.stdout.write(
    `${"ID".padEnd(10)} ${"STATUS".padEnd(13)} ${"OWNER".padEnd(14)} ${"PRIO".padEnd(4)} SUBJECT\n`,
  );
  for (const t of sorted) {
    const id = (t.id ?? "").padEnd(10);
    const status = (t.status ?? "").padEnd(13);
    const owner = (t.owner ?? "-").padEnd(14);
    const prio = (
      t.priority !== null && t.priority !== undefined ? String(t.priority) : "-"
    ).padEnd(4);
    process.stdout.write(`${id} ${status} ${owner} ${prio} ${t.subject ?? ""}\n`);
  }
  return 0;
}

async function taskShow(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "task show: <id> required" });
  }
  const dirOpts = parseTeamDirOnly(rest);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const t = await showTask(atmuxDir, id);
  if (t === null) {
    throw new ConfigError({ what: `task show: no such task: ${id}` });
  }
  process.stdout.write(`${JSON.stringify(t, null, 2)}\n`);
  return 0;
}

async function taskMove(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  const status = positional[1];
  if (id === undefined || status === undefined) {
    throw new UsageError({ what: "task move: <id> <status>", hint: USAGE_MOVE });
  }
  if (!VALID_STATUSES.has(status)) {
    throw new UsageError({
      what: "task move: status must be todo|in-progress|done|blocked",
      hint: USAGE_MOVE,
    });
  }
  const dirOpts = parseTeamDirOnly(rest);
  const atmuxDir = await getAtmuxDir(dirOpts);
  // Pre-read so we know the current owner before moveTask possibly
  // mutates schema fields. moveTask itself throws ConfigError on miss,
  // so a present pre-snapshot guarantees the post-move task exists.
  const pre = await showTask(atmuxDir, id);
  await moveTask(atmuxDir, id, status);
  // t-e452296b: bash mirror left `.inProgress` entries behind on
  // status transitions that don't go through `atmux done`. Whip then
  // fired false `in-progress > 90min` alerts on shelved tasks. Drain
  // the assignee's inbox.inProgress on parking transitions so kanban
  // truth and inbox truth stay aligned. Idempotent: if the entry
  // wasn't there, the filter is a no-op.
  if (
    pre !== null &&
    STATUSES_THAT_DRAIN_INBOX.has(status) &&
    typeof pre.owner === "string" &&
    pre.owner.length > 0
  ) {
    await removeFromInProgress(atmuxDir, pre.owner, id);
  }
  process.stdout.write(`task ${id} → ${status}\n`);
  return 0;
}

async function taskAssign(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  const who = positional[1];
  if (id === undefined || who === undefined) {
    throw new UsageError({ what: "task assign: <id> <member>" });
  }
  const dirOpts = parseTeamDirOnly(rest);
  const atmuxDir = await getAtmuxDir(dirOpts);
  await assignTask(atmuxDir, id, who);
  process.stdout.write(`task ${id} assigned → ${who}\n`);
  return 0;
}

async function taskRemove(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "task rm: <id> required" });
  }
  const dirOpts = parseTeamDirOnly(rest);
  const atmuxDir = await getAtmuxDir(dirOpts);
  await removeTask(atmuxDir, id);
  process.stdout.write(`task ${id} removed\n`);
  return 0;
}

// ---------- Pure parsers ----------

interface ParsedAddArgs {
  subject: string;
  body?: string;
  assignee?: string;
  deps?: ReadonlyArray<string>;
  priority?: number;
  lane?: string;
  teamDir?: string;
}

/**
 * Parse `task add` argv. Bash builds the subject from non-flag
 * positional args (lib/kanban.sh:38-41 `if [[ -z "$subject" ]]; then
 * subject="$1"; else subject="$subject $1"; fi`); we mirror.
 */
export function parseAddArgs(argv: ReadonlyArray<string>): ParsedAddArgs {
  let subject = "";
  let body: string | undefined;
  let assignee: string | undefined;
  let deps: string[] | undefined;
  let priority: number | undefined;
  let lane: string | undefined;
  let teamDir: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--body") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "task add: --body requires a value", hint: USAGE_ADD });
      }
      body = v;
      i += 2;
      continue;
    }
    if (a === "--assignee") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task add: --assignee requires a value",
          hint: USAGE_ADD,
        });
      }
      assignee = v;
      i += 2;
      continue;
    }
    if (a === "--deps") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "task add: --deps requires a value", hint: USAGE_ADD });
      }
      // Bash splits on comma + drops empties (lib/kanban.sh:47).
      deps = v.split(",").filter((s) => s.length > 0);
      i += 2;
      continue;
    }
    if (a === "--priority" || a === "--prio") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: `task add: ${a} requires a value`,
          hint: USAGE_ADD,
        });
      }
      const n = Number.parseInt(v, 10);
      // Bash: `$p | tonumber? // null` — non-numeric becomes null.
      // Mirror by leaving priority undefined (which addTask treats as null).
      if (Number.isFinite(n)) priority = n;
      i += 2;
      continue;
    }
    if (a === "--lane") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task add: --lane requires a value",
          hint: USAGE_ADD,
        });
      }
      if (!VALID_LANES.has(v) || v === "-") {
        throw new UsageError({
          what: `task add: --lane must be one of fe|be|db|ops|test|review|misc|git|docs (got: ${v})`,
          hint: USAGE_ADD,
        });
      }
      lane = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task add: --team-dir requires a value",
          hint: USAGE_ADD,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--") {
      // Bash: `--) shift; subject="$*"; break` — collect remaining as subject.
      subject = argv.slice(i + 1).join(" ");
      break;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({ what: `task add: unknown flag: ${a}`, hint: USAGE_ADD });
    }
    // Non-flag positional → accumulate into subject (bash join with space).
    subject = subject.length === 0 ? (a ?? "") : `${subject} ${a ?? ""}`;
    i += 1;
  }
  if (subject.length === 0) {
    throw new UsageError({ what: "task add: <subject> required", hint: USAGE_ADD });
  }
  const out: ParsedAddArgs = { subject };
  if (body !== undefined) out.body = body;
  if (assignee !== undefined) out.assignee = assignee;
  if (deps !== undefined) out.deps = deps;
  if (priority !== undefined) out.priority = priority;
  if (lane !== undefined) out.lane = lane;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

interface ParsedListArgs {
  status?: string;
  assignee?: string;
  lane?: string;
  json: boolean;
  teamDir?: string;
}

export function parseListArgs(argv: ReadonlyArray<string>): ParsedListArgs {
  let status: string | undefined;
  let assignee: string | undefined;
  let lane: string | undefined;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--status") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "task list: --status requires a value", hint: USAGE_LIST });
      }
      status = v;
      i += 2;
      continue;
    }
    if (a === "--assignee") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task list: --assignee requires a value",
          hint: USAGE_LIST,
        });
      }
      assignee = v;
      i += 2;
      continue;
    }
    if (a === "--lane") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task list: --lane requires a value",
          hint: USAGE_LIST,
        });
      }
      lane = v;
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
          what: "task list: --team-dir requires a value",
          hint: USAGE_LIST,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `task list: unknown arg: ${a ?? ""}`, hint: USAGE_LIST });
  }
  const out: ParsedListArgs = { json };
  if (status !== undefined) out.status = status;
  if (assignee !== undefined) out.assignee = assignee;
  if (lane !== undefined) out.lane = lane;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Split argv into leading non-flag positionals + everything from the
 * first flag onward. Used by show/move/assign/rm so the operator can
 * mix `<id> [args] --team-dir <dir>` in any order.
 */
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

/**
 * Parse only `--team-dir <dir>` from a subverb's trailing args.
 * Used by show/move/assign/rm where the only flag we accept is the
 * team-dir override (the rest of the surface is positional).
 */
function parseTeamDirOnly(argv: ReadonlyArray<string>): ResolveDirOpts {
  let i = 0;
  let teamDir: string | undefined;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "task: --team-dir requires a value" });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `task: unexpected arg: ${a ?? ""}` });
  }
  return teamDir !== undefined ? { teamDir } : {};
}

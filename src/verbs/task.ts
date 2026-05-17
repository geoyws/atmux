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

import { getAtmuxDir, type ResolveDirOpts, resolveCallerScope } from "../core/common.ts";
import { removeFromInProgress } from "../core/inbox.ts";
import {
  addTask,
  assignTask,
  type ListTasksFilter,
  listTasks,
  moveTask,
  removeTask,
  setTaskBody,
  setTaskDeps,
  setTaskLane,
  setTaskPriority,
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
  "atmux task <add|list|show|move|assign|lane|priority|update|rm> [args] " +
  "(see 'atmux task' for per-subverb help)";

const USAGE_ADD =
  "atmux task add <subject> [--body T] [--assignee M] [--deps a,b] [--priority N] [--lane L] [--driver-only]";
const USAGE_LIST = "atmux task list [--status S] [--assignee M] [--lane L] [--json]";
const USAGE_MOVE = "atmux task move <id> <todo|in-progress|done|blocked>";
const USAGE_LANE = "atmux task lane <id> <fe|be|db|ops|test|review|misc|git|docs|->";
const USAGE_PRIORITY = "atmux task priority <id> <N|->";
const USAGE_UPDATE = "atmux task update <id> [--body <text>] [--deps <a,b>]";

const VALID_STATUSES = new Set(["todo", "in-progress", "done", "blocked"]);

/** Levenshtein edit distance between two strings. Iterative DP, O(|a|·|b|)
 *  time and space. Cap-bounded — caller passes `maxDist`; we early-exit
 *  the row once the running min exceeds the cap. Used by `closestStatus`
 *  to surface a "did you mean ..." hint without firing for inputs that
 *  share zero structure with any valid status. */
function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const cellPrev = prev[j - 1] ?? 0;
      const cellUp = prev[j] ?? 0;
      const cellLeft = curr[j - 1] ?? 0;
      const v = Math.min(cellPrev + cost, cellUp + 1, cellLeft + 1);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? maxDist + 1;
}

/** Closest VALID_STATUSES entry to `s` within edit-distance 2. Returns
 *  null when no candidate is close enough (e.g. `s = "nonsense"`); the
 *  caller omits the did-you-mean hint cleanly per ADR-080 §D test
 *  contract. Tie-break: first-defined order in VALID_STATUSES (Set
 *  insertion order). */
export function closestStatus(s: string): string | null {
  const MAX = 2;
  let best: string | null = null;
  let bestDist = MAX + 1;
  for (const cand of VALID_STATUSES) {
    const d = levenshtein(s, cand, MAX);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return bestDist <= MAX ? best : null;
}
/** Lane enum (mirrors `KanbanLane` in src/schema/kanban.ts). `-` clears
 *  the lane (sets to null). `git` + `docs` added 2026-05-08 for role-
 *  specific lanes (gitter pulls commits/merges; docs pulls writing tasks). */
const VALID_LANES = new Set([
  "fe",
  "be",
  "db",
  "ops",
  "test",
  "review",
  "misc",
  "git",
  "docs",
  "-",
]);

// Member-name → canonical-lane aliases (t-cea78f99). Operators kept
// typing `--lane gitter` for the member-name; canonical lane is `git`.
// Resolved BEFORE the VALID_LANES check; input-side only by design
// (kanban stores canonical form; `task list --lane` filters against
// stored values, not aliases).
const LANE_ALIASES: Record<string, string> = {
  gitter: "git",
  planner: "docs",
  reviewer: "review",
  dba: "db",
  devops: "ops",
};

export function resolveLaneAlias(input: string): string {
  return LANE_ALIASES[input] ?? input;
}

/**
 * `atmux task <subverb> [args]`. Returns 0 on success; throws
 * `UsageError` / `ConfigError` for the caller to map per ADR-006.
 */
export async function task(argv: ReadonlyArray<string>): Promise<number> {
  // Bash defaults to `list` when no subverb given (lib/kanban.sh:16).
  // We also default to `list` when argv[0] is a flag — `atmux task
  // --team-dir /x` is unambiguously "list with --team-dir".
  const first = argv[0];
  const isFlag = first?.startsWith("-");
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
    case "priority":
    case "prio":
      return await taskPriority(rest);
    case "update":
      return await taskUpdate(rest);
    case "rm":
    case "remove":
      return await taskRemove(rest);
    default:
      throw new UsageError({
        what: `task: unknown verb: ${verb} (use add|list|show|move|assign|lane|priority|update|rm)`,
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
  if (parsed.driverOnly === true) opts.driverOnly = true;
  const id = await addTask(atmuxDir, opts);
  process.stdout.write(`${id}\n`);
  return 0;
}

// `atmux task lane <id> <fe|be|db|ops|test|review|misc|->`
async function taskLane(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const teamDir = (() => {
    const idx = rest.indexOf("--team-dir");
    return idx >= 0 ? rest[idx + 1] : undefined;
  })();
  if (positional.length !== 2) {
    throw new UsageError({
      what: "task lane: requires <id> and <lane>",
      hint: USAGE_LANE,
    });
  }
  const [id, laneArgRaw] = positional as [string, string];
  const laneArg = resolveLaneAlias(laneArgRaw);
  if (!VALID_LANES.has(laneArg)) {
    throw new UsageError({
      what: `task lane: lane must be one of fe|be|db|ops|test|review|misc|git|docs|- (got: ${laneArgRaw})`,
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

// `atmux task priority <id> <N|->` — `-` clears (treated as default 99
// in selection / list ordering per bash sort `// 99`). Aliased as
// `atmux task prio <id> <N|->`. Used by hygiene auto-fix to repair
// `prio-null` cases per ADR-131.
async function taskPriority(argv: ReadonlyArray<string>): Promise<number> {
  // t-584b5f37 cluster 6 fix: align with sibling subcmds (taskUpdate /
  // taskAssign / taskMove etc. — all at line 262/380/396/438/452) by
  // routing through `splitFlagsAndPositionals`. The prior homegrown
  // `argv.filter((a) => !a.startsWith("--"))` did NOT strip the value
  // following `--team-dir`, so calls like `task priority t-id 5
  // --team-dir /path` produced positional=["t-id","5","/path"]
  // (length 3) and false-tripped the "requires <id> and <N|->" gate.
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const teamDir = (() => {
    const idx = rest.indexOf("--team-dir");
    return idx >= 0 ? rest[idx + 1] : undefined;
  })();
  if (positional.length !== 2) {
    throw new UsageError({
      what: "task priority: requires <id> and <N|->",
      hint: USAGE_PRIORITY,
    });
  }
  const [id, prioArg] = positional as [string, string];
  let priority: number | null;
  if (prioArg === "-") {
    priority = null;
  } else {
    const n = Number.parseInt(prioArg, 10);
    if (!Number.isFinite(n) || String(n) !== prioArg) {
      throw new UsageError({
        what: `task priority: <N> must be an integer or '-' (got: ${prioArg})`,
        hint: USAGE_PRIORITY,
      });
    }
    priority = n;
  }
  const dirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  await setTaskPriority(atmuxDir, id, priority);
  return 0;
}

// `atmux task update <id> [--body <text>] [--deps <a,b>]`
//
// Mutate an existing Task's body and/or deps without touching status,
// owner, or other fields. Empty `--body ""` clears the body; empty
// `--deps ""` clears all upstream blockers. At least one of --body or
// --deps must be supplied (otherwise the call is a no-op and we surface
// it as a usage error so the operator notices the typo).
async function taskUpdate(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "task update: <id> required", hint: USAGE_UPDATE });
  }
  let body: string | undefined;
  let deps: string[] | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === "--body") {
      const v = rest[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task update: --body requires a value",
          hint: USAGE_UPDATE,
        });
      }
      body = v;
      i += 2;
      continue;
    }
    if (a === "--deps") {
      const v = rest[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task update: --deps requires a value",
          hint: USAGE_UPDATE,
        });
      }
      // Mirror `task add` parsing: comma-split + drop empties. Bare `""`
      // value clears deps entirely.
      deps = v.split(",").filter((s) => s.length > 0);
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = rest[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "task update: --team-dir requires a value",
          hint: USAGE_UPDATE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({
      what: `task update: unknown flag: ${a ?? ""}`,
      hint: USAGE_UPDATE,
    });
  }
  if (body === undefined && deps === undefined) {
    throw new UsageError({
      what: "task update: at least one of --body or --deps required",
      hint: USAGE_UPDATE,
    });
  }
  const dirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  if (body !== undefined) {
    await setTaskBody(atmuxDir, id, body.length === 0 ? null : body);
  }
  if (deps !== undefined) {
    await setTaskDeps(atmuxDir, id, deps);
  }
  process.stdout.write(`task ${id} updated\n`);
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
  // Header + columns: ID(10) STATUS(13) OWNER(14) PRIO(4) F(2) SUBJECT
  // F column carries ADR-033 driverOnly marker `D` (otherwise blank).
  // Defense-in-depth visual cue alongside the load-bearing refuse-gate
  // in `selectNextClaimable` — at-a-glance "this Task is driver-fires".
  process.stdout.write(
    `${"ID".padEnd(10)} ${"STATUS".padEnd(13)} ${"OWNER".padEnd(14)} ${"PRIO".padEnd(4)} ${"F".padEnd(2)} SUBJECT\n`,
  );
  for (const t of sorted) {
    const id = (t.id ?? "").padEnd(10);
    const status = (t.status ?? "").padEnd(13);
    const owner = (t.owner ?? "-").padEnd(14);
    const prio = (
      t.priority !== null && t.priority !== undefined ? String(t.priority) : "-"
    ).padEnd(4);
    const flag = (t.driverOnly === true ? "D" : "").padEnd(2);
    process.stdout.write(`${id} ${status} ${owner} ${prio} ${flag} ${t.subject ?? ""}\n`);
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
  // ADR-033: moveTask enforces the driver-only refuse-gate inside its
  // transaction for `in-progress` / `done` targets (`todo` / `blocked`
  // remain unrestricted per ADR-033 §Refuse-gate site #2 carve-out).
  const callerScope = resolveCallerScope();
  await moveTask(atmuxDir, id, status, { callerScope });
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
  /** ADR-033: when true, mark the Task driverOnly — auto-pickup
   *  (`claim --next` / lane-tick cron) skips it unless caller scope
   *  is `driver`. */
  driverOnly?: boolean;
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
  let driverOnly: boolean | undefined;
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
      const resolved = resolveLaneAlias(v);
      if (!VALID_LANES.has(resolved) || resolved === "-") {
        throw new UsageError({
          what: `task add: --lane must be one of fe|be|db|ops|test|review|misc|git|docs (got: ${v})`,
          hint: USAGE_ADD,
        });
      }
      lane = resolved;
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
    if (a === "--driver-only") {
      // ADR-033: load-bearing refuse-gate flag. Boolean, no value.
      driverOnly = true;
      i += 1;
      continue;
    }
    if (a === "--") {
      // Bash: `--) shift; subject="$*"; break` — collect remaining as subject.
      subject = argv.slice(i + 1).join(" ");
      break;
    }
    if (a?.startsWith("-")) {
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
  if (driverOnly !== undefined) out.driverOnly = driverOnly;
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
      // ADR-080 §D / OQ-1 (PATCH-mode soft normalize): underscore →
      // hyphen silently. Operators muscle-memory `--status in_progress`
      // (snake_case) when the canonical form is `in-progress`; we
      // accept both rather than failing on the typo. Unknown statuses
      // post-normalize throw with a did-you-mean hint.
      const normalized = v.replace(/_/g, "-");
      if (!VALID_STATUSES.has(normalized)) {
        const suggest = closestStatus(normalized);
        throw new UsageError({
          what: `task list: unknown status "${v}"${
            suggest !== null ? ` — did you mean "${suggest}"?` : ""
          } (valid: todo|in-progress|done|blocked)`,
          hint: USAGE_LIST,
        });
      }
      status = normalized;
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
    // Bare `-` is the priority-clear sentinel for `task priority` (and
    // by convention a positional in several CLI verbs); only multi-char
    // strings beginning with `-` count as flag boundaries here. Pre-
    // t-584b5f37 the helper short-circuited on bare `-`, leaving
    // `taskPriority` no way to receive the clear-sentinel through this
    // path — taskPriority used a homegrown filter that DID accept bare
    // `-` but failed to strip `--team-dir <val>` pairs. Aligning all
    // subcmds on this helper fixes both failure modes.
    if (a.length > 1 && a.startsWith("-")) break;
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

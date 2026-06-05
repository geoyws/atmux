// ADR-010: CLI dispatcher — `epic` verb. Subverb dispatch + display only.
// Bash spec: lib/epic.sh @ worktree-frozen.
//
// Subverb routing:
//
//   atmux epic add             <title> [--body T] [--driver-ref R] [--depends-on e-X,e-Y]
//   atmux epic list            [--status S] [--json]   (table + R/D columns)
//   atmux epic ls              ↔ list
//   atmux epic show            <id> [--json]           (is_ready + depends_on; children tree
//                                                        with owner/priority/deps inline — ADR-173)
//   atmux epic get             ↔ show
//   atmux epic advance         <id> [--to S]
//   atmux epic adv             ↔ advance
//   atmux epic ready           <id>                    (ADR-225)
//   atmux epic unready         <id>                    (ADR-225)
//   atmux epic set-depends-on  <id> <eid,…>            (ADR-225; empty clears)
//   atmux epic deps            <id> [--json]           (ADR-225)

import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import {
  addEpic,
  advanceEpic,
  listEpics,
  setEpicDependsOn,
  setEpicReady,
  showEpic,
} from "../core/epic.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { KanbanEpic, KanbanTask } from "../schema/kanban.ts";

const USAGE_HINT_ROOT =
  "atmux epic <add|list|show|advance|ready|unready|set-depends-on|deps> [args]";
const USAGE_ADD =
  "atmux epic add <title> [--body T] [--driver-ref R] [--depends-on e-X,e-Y] " +
  "[--auto-spawn | --no-auto-spawn] [--roster <name>] [--force-spawn]";
const USAGE_LIST = "atmux epic list [--status S] [--json]";
const USAGE_SHOW = "atmux epic show <id> [--json]";
const USAGE_ADV = "atmux epic advance <id> [--to <state>]";
// ADR-225 subverb usage hints.
const USAGE_READY = "atmux epic ready <id> [--team-dir D]";
const USAGE_UNREADY = "atmux epic unready <id> [--team-dir D]";
const USAGE_SET_DEPS = "atmux epic set-depends-on <id> <eid,…> [--team-dir D]";
const USAGE_DEPS = "atmux epic deps <id> [--json] [--team-dir D]";

export async function epic(argv: ReadonlyArray<string>): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    throw new UsageError({
      what: "epic: missing verb (add|list|show|advance|ready|unready|set-depends-on|deps)",
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
    case "ready":
      return await epicReadyVerb(rest, true);
    case "unready":
      return await epicReadyVerb(rest, false);
    case "set-depends-on":
      return await epicSetDependsOnVerb(rest);
    case "deps":
      return await epicDeps(rest);
    default:
      throw new UsageError({
        what:
          `epic: unknown verb: ${first} ` +
          `(use add|list|show|advance|ready|unready|set-depends-on|deps)`,
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
  // ADR-225: pass the comma-split dependsOn list through to the core
  // validator (self / non-existent / cycle refused before insert).
  if (parsed.dependsOn !== undefined) opts.dependsOn = parsed.dependsOn;
  // ADR-231 §D3: per-epic orchd auto-spawn config. core/epic.ts
  // writes this into the inserted row's `extra.autoSpawn` slot per
  // the schema shape landed in t-7-0ad1dfe3.
  if (parsed.autoSpawn !== undefined) opts.autoSpawn = parsed.autoSpawn;
  const id = await addEpic(atmuxDir, opts);
  process.stderr.write(`epic: added ${id} — ${parsed.title}\n`);
  process.stdout.write(`${id}\n`);
  return 0;
}

// ---------- ADR-225 subverbs ----------

async function epicReadyVerb(argv: ReadonlyArray<string>, makeReady: boolean): Promise<number> {
  const verbLabel = makeReady ? "ready" : "unready";
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({
      what: `epic ${verbLabel}: <id> required`,
      hint: makeReady ? USAGE_READY : USAGE_UNREADY,
    });
  }
  const { teamDir } = parseTeamDirOnly(rest, `epic ${verbLabel}`);
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const result = await setEpicReady(atmuxDir, id, makeReady);
  if (result.noop) {
    process.stderr.write(`epic: ${id} already is_ready=${result.from ? 1 : 0} (no-op)\n`);
    return 0;
  }
  process.stderr.write(`epic: ${id} is_ready: ${result.from ? 1 : 0} → ${result.to ? 1 : 0}\n`);
  return 0;
}

async function epicSetDependsOnVerb(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  // Second positional is the comma-separated dep list. Empty string is
  // legal — it clears the list.
  const depList = positional[1];
  if (id === undefined || id.length === 0) {
    throw new UsageError({
      what: "epic set-depends-on: <id> required",
      hint: USAGE_SET_DEPS,
    });
  }
  if (depList === undefined) {
    throw new UsageError({
      what: "epic set-depends-on: <eid,…> required (use empty string to clear)",
      hint: USAGE_SET_DEPS,
    });
  }
  const deps = splitDepsCsv(depList);
  const { teamDir } = parseTeamDirOnly(rest, "epic set-depends-on");
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  await setEpicDependsOn(atmuxDir, id, deps);
  process.stderr.write(`epic: ${id} depends_on: [${deps.join(", ")}]\n`);
  return 0;
}

async function epicDeps(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "epic deps: <id> required", hint: USAGE_DEPS });
  }
  const { json, teamDir } = parseDepsFlags(rest);
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const epic = await showEpic(atmuxDir, id);
  if (epic === null) {
    throw new ConfigError({ what: `epic deps: no such epic: ${id}` });
  }
  // Render the transitive tree depth-first. Pull a single transitive
  // closure once (epicTransitiveDeps walks BFS); the renderer below
  // walks via repeated showEpic calls to display per-node status.
  const tree = await _buildDepsTree(atmuxDir, id);
  if (json) {
    process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
    return 0;
  }
  const lines: string[] = [];
  _renderDepsTree(tree, 0, lines);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

interface DepsNode {
  id: string;
  status: string;
  /** True when the id had no epic row (dangling ref). */
  missing: boolean;
  children: DepsNode[];
}

/** Recursive walker for the deps tree. Uses a cycle-guard `seen` set so
 *  a pre-existing pathological cycle in storage doesn't infinite-loop
 *  the renderer. */
async function _buildDepsTree(
  atmuxDir: string,
  rootId: string,
  seen: Set<string> = new Set(),
): Promise<DepsNode> {
  if (seen.has(rootId)) {
    // Cycle — return a stub child without recursing further.
    return { id: rootId, status: "(cycle)", missing: false, children: [] };
  }
  seen.add(rootId);
  const epic = await showEpic(atmuxDir, rootId);
  if (epic === null) {
    return { id: rootId, status: "missing", missing: true, children: [] };
  }
  const children: DepsNode[] = [];
  for (const dep of epic.dependsOn ?? []) {
    children.push(await _buildDepsTree(atmuxDir, dep, new Set(seen)));
  }
  return {
    id: epic.id,
    status: epic.status ?? "planning",
    missing: false,
    children,
  };
}

function _renderDepsTree(node: DepsNode, indent: number, out: string[]): void {
  const pad = "  ".repeat(indent);
  const tag = node.missing ? "[missing]" : `[${node.status}]`;
  out.push(`${pad}${node.id} ${tag}`);
  for (const child of node.children) {
    _renderDepsTree(child, indent + 1, out);
  }
}

/** Comma-split + trim a `--depends-on` / set-depends-on token list.
 *  Empty input (e.g. operator typed `""` to clear) returns []. */
function splitDepsCsv(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Reusable `--team-dir` parser for the small subverbs (ready /
 *  unready / set-depends-on) that don't accept any other flags. */
function parseTeamDirOnly(argv: ReadonlyArray<string>, verbLabel: string): { teamDir?: string } {
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${verbLabel}: --team-dir requires a value` });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `${verbLabel}: unknown flag: ${a ?? ""}` });
  }
  const out: { teamDir?: string } = {};
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

interface DepsFlags {
  json: boolean;
  teamDir?: string;
}

function parseDepsFlags(argv: ReadonlyArray<string>): DepsFlags {
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
        throw new UsageError({ what: "epic deps: --team-dir requires a value", hint: USAGE_DEPS });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `epic deps: unknown flag: ${a ?? ""}`, hint: USAGE_DEPS });
  }
  const out: DepsFlags = { json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
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
  // ADR-225 §CLI: add R (is_ready bit) + D (k/n done-deps) columns.
  // R is a single char; D renders `k/n` or `-` when no deps.
  // depCounts is built up-front to avoid N round-trips on a long list.
  const depCounts = _buildDepCountMap(epics);
  process.stdout.write(
    `${"ID".padEnd(12)} ${"STATUS".padEnd(12)} ${"R".padEnd(2)} ${"D".padEnd(6)} ${"CREATED".padEnd(12)} TITLE\n`,
  );
  for (const e of epics) {
    const id = (e.id ?? "").padEnd(12);
    const status = (e.status ?? "").padEnd(12);
    const r = (e.isReady ? "1" : "0").padEnd(2);
    const d = (depCounts.get(e.id) ?? "-").padEnd(6);
    const created = String(e.createdAt ?? 0).padEnd(12);
    process.stdout.write(`${id} ${status} ${r} ${d} ${created} ${e.title ?? ""}\n`);
  }
  return 0;
}

/** Build a `k/n` string for every epic's `D` column, where n=len(deps)
 *  and k=deps with status=done. Returns `-` for epics with no deps.
 *  Builds an in-memory id→status map first so we don't re-query the
 *  repo per dep (would be O(N×D) round trips for a large list). */
function _buildDepCountMap(epics: ReadonlyArray<KanbanEpic>): Map<string, string> {
  const statusById = new Map<string, string>();
  for (const e of epics) statusById.set(e.id, e.status ?? "planning");
  const out = new Map<string, string>();
  for (const e of epics) {
    const deps = e.dependsOn ?? [];
    if (deps.length === 0) {
      out.set(e.id, "-");
      continue;
    }
    let done = 0;
    for (const d of deps) {
      if (statusById.get(d) === "done") done += 1;
    }
    out.set(e.id, `${done}/${deps.length}`);
  }
  return out;
}

// Per-task inline columns for the `epic show` text tree — owner / priority /
// deps surfaced after the `[status] — subject` head so operators see the
// routing inputs at a glance without a follow-up `atmux task show`. Format
// follows ADR-173 §Render rules: owner is the assignee or `-` when null;
// priority is `P<n>` or `P-` when null; deps render as `← deps: t-aaa,t-bbb`
// appended only when `deps[]` is non-empty, with up to 3 ids inline + a
// `(+N more)` overflow marker.
function taskRowSuffix(t: KanbanTask): string {
  const owner = t.owner !== null && t.owner !== undefined && t.owner.length > 0 ? t.owner : "-";
  const prio =
    t.priority !== null && t.priority !== undefined ? `P${String(t.priority)}` : "P-";
  const deps = t.deps ?? [];
  let depsCol = "";
  if (deps.length > 0) {
    const head = deps.slice(0, 3);
    const overflow = deps.length > 3 ? ` (+${deps.length - 3} more)` : "";
    depsCol = `  ← deps: ${head.join(",")}${overflow}`;
  }
  return `[${owner}, ${prio}]${depsCol}`;
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
  // ADR-225 §CLI: surface is_ready + depends_on on the text view so
  // operators can see the eligibility predicate inputs at a glance.
  lines.push(`  is_ready: ${epic.isReady ? 1 : 0}`);
  const deps = epic.dependsOn ?? [];
  if (deps.length > 0) {
    lines.push(`  depends_on: [${deps.join(", ")}]`);
  }
  if (epic.storyRows.length > 0) {
    lines.push("");
    lines.push("Stories:");
    for (const s of epic.storyRows) {
      lines.push(`  ${s.id} [${s.status ?? ""}] — ${s.title ?? ""}`);
      const childTasks = epic.tasks.filter((t) => t.story === s.id);
      for (const t of childTasks) {
        lines.push(
          `    task ${t.id} [${t.status ?? ""}] — ${t.subject ?? ""} ${taskRowSuffix(t)}`,
        );
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
      lines.push(`  ${t.id} [${t.status ?? ""}] — ${t.subject ?? ""} ${taskRowSuffix(t)}`);
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
  // ADR-225: comma-separated dep list, empty/absent → no deps.
  dependsOn?: string[];
  // ADR-231 §D3: per-epic orchd auto-spawn config (resolved at parse
  // time; mutex'd at parse-error so the caller gets the helpful
  // message before any DB work). Absent → no autoSpawn key written
  // (epic falls back to per-team defaults match OR off).
  autoSpawn?: {
    enabled: boolean;
    roster?: string;
    forceSpawn?: boolean;
  };
}

export function parseAddArgs(argv: ReadonlyArray<string>): ParsedAddArgs {
  let title = "";
  let body: string | undefined;
  let driverRef: string | undefined;
  let teamDir: string | undefined;
  let dependsOn: string[] | undefined;
  // ADR-231 §D3 flags — captured at parse time, mutex-checked after
  // the walk completes (an earlier --auto-spawn doesn't know whether
  // --no-auto-spawn will appear later).
  let autoSpawnFlag: "enable" | "disable" | undefined;
  let rosterFlag: string | undefined;
  let forceSpawnFlag = false;
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
    if (a === "--depends-on") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "epic add: --depends-on requires a value (e.g. e-aaa,e-bbb)",
          hint: USAGE_ADD,
        });
      }
      // ADR-225 §CLI: comma-split + trim. Empty string → empty list
      // (caller wrote `--depends-on ""` to explicitly assert no deps).
      dependsOn = splitDepsCsv(v);
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
    // ADR-231 §D3 — orchd auto-spawn per-epic config.
    if (a === "--auto-spawn") {
      autoSpawnFlag = "enable";
      i += 1;
      continue;
    }
    if (a === "--no-auto-spawn") {
      autoSpawnFlag = "disable";
      i += 1;
      continue;
    }
    if (a === "--roster") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "epic add: --roster requires a value (e.g. 'solo', 'backend-heavy')",
          hint: USAGE_ADD,
        });
      }
      rosterFlag = v;
      i += 2;
      continue;
    }
    if (a === "--force-spawn") {
      forceSpawnFlag = true;
      i += 1;
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

  // ADR-231 §D3 — flag mutex enforcement (parse-time so the caller
  // sees the error before any DB work).
  if (autoSpawnFlag === "disable" && forceSpawnFlag) {
    throw new UsageError({
      what: "epic add: --no-auto-spawn cannot combine with --force-spawn (mutually exclusive — --no-auto-spawn opts OUT of orchd spawn, --force-spawn opts IN bypassing the eligibility predicate)",
      hint: USAGE_ADD,
    });
  }
  if (autoSpawnFlag !== "enable" && rosterFlag !== undefined) {
    throw new UsageError({
      what: "epic add: --roster requires --auto-spawn (the roster picks which member set orchd spawns; with auto-spawn off it has no effect)",
      hint: USAGE_ADD,
    });
  }
  if (autoSpawnFlag !== "enable" && forceSpawnFlag) {
    throw new UsageError({
      what: "epic add: --force-spawn requires --auto-spawn (force only affects the orchd-driven spawn path; with auto-spawn off it has no effect)",
      hint: USAGE_ADD,
    });
  }

  const out: ParsedAddArgs = { title };
  if (body !== undefined) out.body = body;
  if (driverRef !== undefined) out.driverRef = driverRef;
  if (teamDir !== undefined) out.teamDir = teamDir;
  if (dependsOn !== undefined) out.dependsOn = dependsOn;
  // ADR-231 §D3 — assemble autoSpawn sub-shape only when the operator
  // explicitly flagged one of the auto-spawn semantics. No flag →
  // absent autoSpawn key → caller falls back to per-team defaults
  // match (T-S1.3) OR off.
  if (autoSpawnFlag === "enable") {
    const autoSpawn: NonNullable<ParsedAddArgs["autoSpawn"]> = { enabled: true };
    if (rosterFlag !== undefined) autoSpawn.roster = rosterFlag;
    if (forceSpawnFlag) autoSpawn.forceSpawn = true;
    out.autoSpawn = autoSpawn;
  } else if (autoSpawnFlag === "disable") {
    out.autoSpawn = { enabled: false };
  }
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

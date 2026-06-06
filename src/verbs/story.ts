// ADR-010: CLI dispatcher — `story` verb. Subverb dispatch + display only.
// Bash spec: lib/story.sh @ worktree-frozen.
//
// Subverb routing (1:1 parity with bash):
//
//   atmux story add     <title> --epic <eid> [--ac C] [--body T]
//   atmux story list    --epic <eid> [--status S] [--json]
//   atmux story ls      ↔ list
//   atmux story show    <id> [--json]
//   atmux story get     ↔ show
//   atmux story advance <id> [--to S]
//   atmux story adv     ↔ advance

import { getAtmuxDir, type ResolveDirOpts } from "../core/common.ts";
import {
  addStory,
  advanceStory,
  listStories,
  showStory,
  storySignoff,
  storyUnsignoff,
  updateStory,
} from "../core/story.ts";
import { ConfigError, UsageError } from "../errors.ts";

const USAGE_HINT_ROOT =
  "atmux story <add|list|show|advance|update|signoff|unsignoff> [args]";
const USAGE_ADD =
  "atmux story add <title> --epic <eid> [--ac C] [--body T] [--merge-mode feature-branch|trunk-direct]";
const USAGE_LIST = "atmux story list --epic <eid> [--status S] [--json]";
const USAGE_SHOW = "atmux story show <id> [--json]";
const USAGE_ADV = "atmux story advance <id> [--to <state>]";
const USAGE_UPDATE = "atmux story update <id> [--body <text>] [--ac <criteria>]";
const USAGE_SIGNOFF = "atmux story signoff <id> [--as <member>] [--note <text>]";
const USAGE_UNSIGNOFF = "atmux story unsignoff <id> [--as <member>] [--note <text>]";

export async function story(argv: ReadonlyArray<string>): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    throw new UsageError({
      what: "story: missing verb (add|list|show|advance|update)",
      hint: USAGE_HINT_ROOT,
    });
  }
  const rest = argv.slice(1);
  switch (first) {
    case "add":
      return await storyAdd(rest);
    case "list":
    case "ls":
      return await storyList(rest);
    case "show":
    case "get":
      return await storyShow(rest);
    case "advance":
    case "adv":
      return await storyAdvance(rest);
    case "update":
      return await storyUpdate(rest);
    case "signoff":
      return await storySignoffVerb(rest);
    case "unsignoff":
      return await storyUnsignoffVerb(rest);
    default:
      throw new UsageError({
        what: `story: unknown verb: ${first} (use add|list|show|advance|update|signoff|unsignoff)`,
        hint: USAGE_HINT_ROOT,
      });
  }
}

// ---------- Subverbs ----------

async function storyAdd(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseAddArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const opts: Parameters<typeof addStory>[1] = { title: parsed.title, epic: parsed.epic };
  if (parsed.body !== undefined) opts.body = parsed.body;
  if (parsed.ac !== undefined) opts.acceptanceCriteria = parsed.ac;
  if (parsed.mergeMode !== undefined) opts.mergeMode = parsed.mergeMode;
  const sid = await addStory(atmuxDir, opts);
  process.stderr.write(`story: added ${sid} → ${parsed.epic} — ${parsed.title}\n`);
  process.stdout.write(`${sid}\n`);
  return 0;
}

async function storyList(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseListArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const filter: Parameters<typeof listStories>[1] = { epic: parsed.epic };
  if (parsed.status !== undefined) filter.status = parsed.status;
  const stories = await listStories(atmuxDir, filter);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(stories, null, 2)}\n`);
    return 0;
  }
  if (stories.length === 0) {
    process.stdout.write(`(no stories for ${parsed.epic})\n`);
    return 0;
  }
  process.stdout.write(`${"ID".padEnd(12)} ${"STATUS".padEnd(12)} TITLE\n`);
  for (const s of stories) {
    const id = (s.id ?? "").padEnd(12);
    const status = (s.status ?? "").padEnd(12);
    process.stdout.write(`${id} ${status} ${s.title ?? ""}\n`);
  }
  return 0;
}

async function storyShow(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "story show: <id> required", hint: USAGE_SHOW });
  }
  const { json, teamDir } = parseShowFlags(rest);
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const s = await showStory(atmuxDir, id);
  if (s === null) {
    throw new ConfigError({ what: `story show: no such story: ${id}` });
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return 0;
  }
  const lines: string[] = [];
  lines.push(`${s.id} [${s.status ?? ""}] — ${s.title ?? ""}`);
  lines.push(`  epic: ${s.epic ?? ""}`);
  if (s.body !== null && s.body !== undefined && s.body.length > 0) {
    lines.push(`  body: ${s.body}`);
  }
  if (s.acceptanceCriteria === null || s.acceptanceCriteria === undefined) {
    lines.push("  AC:   (empty — reviewer must reject signoff per ADR-007 OQ2)");
  } else {
    lines.push(`  AC:   ${s.acceptanceCriteria}`);
  }
  if (s.reviewSignoff === true) {
    lines.push("  signoff: ✅");
  }
  if (s.tasks.length > 0) {
    lines.push("");
    lines.push("Tasks:");
    for (const t of s.tasks) {
      lines.push(`  ${t.id} [${t.status ?? ""}] (${t.lane ?? "-"}) — ${t.subject ?? ""}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function storyAdvance(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "story advance: <id> required", hint: USAGE_ADV });
  }
  const { to, teamDir } = parseAdvanceFlags(rest);
  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const result = await advanceStory(atmuxDir, id, to);
  if (result.noop) {
    process.stderr.write(`story: ${id} already ${result.from} (no-op)\n`);
    return 0;
  }
  process.stderr.write(`story: ${id} ${result.from} → ${result.to}\n`);
  if (result.dispatchedTaskId !== null) {
    const verb = result.to === "merging" ? "merge" : "review";
    process.stderr.write(`story: dispatched ${verb} task ${result.dispatchedTaskId}\n`);
  }
  return 0;
}

// ---------- e-407c6d53: story update ----------

async function storyUpdate(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "story update: <id> required", hint: USAGE_UPDATE });
  }
  const flags = parseUpdateFlags(rest);
  if (flags.body === undefined && flags.ac === undefined) {
    throw new UsageError({
      what: "story update: at least one of --body / --ac required",
      hint: USAGE_UPDATE,
    });
  }
  const dirOpts: ResolveDirOpts = flags.teamDir !== undefined ? { teamDir: flags.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  // Triple-state per `task update --body`: `undefined` = no change,
  // `''` = explicit clear (→ null), non-empty = set.
  const opts: Parameters<typeof updateStory>[2] = {};
  if (flags.body !== undefined) opts.body = flags.body.length === 0 ? null : flags.body;
  if (flags.ac !== undefined) opts.acceptanceCriteria = flags.ac.length === 0 ? null : flags.ac;
  await updateStory(atmuxDir, id, opts);
  process.stdout.write(`story ${id} updated\n`);
  return 0;
}

interface UpdateFlags {
  body?: string;
  ac?: string;
  teamDir?: string;
}

export function parseUpdateFlags(argv: ReadonlyArray<string>): UpdateFlags {
  let body: string | undefined;
  let ac: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--body") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "story update: --body requires a value", hint: USAGE_UPDATE });
      }
      body = v;
      i += 2;
      continue;
    }
    if (a === "--ac") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "story update: --ac requires a value", hint: USAGE_UPDATE });
      }
      ac = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "story update: --team-dir requires a value",
          hint: USAGE_UPDATE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `story update: unknown flag: ${a ?? ""}`, hint: USAGE_UPDATE });
  }
  const out: UpdateFlags = {};
  if (body !== undefined) out.body = body;
  if (ac !== undefined) out.ac = ac;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Pure parsers ----------

interface ParsedAddArgs {
  title: string;
  epic: string;
  body?: string;
  ac?: string;
  mergeMode?: "feature-branch" | "trunk-direct";
  teamDir?: string;
}

export function parseAddArgs(argv: ReadonlyArray<string>): ParsedAddArgs {
  let title = "";
  let epic = "";
  let body: string | undefined;
  let ac: string | undefined;
  let mergeMode: "feature-branch" | "trunk-direct" | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--epic") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "story add: --epic requires a value", hint: USAGE_ADD });
      }
      epic = v;
      i += 2;
      continue;
    }
    if (a === "--ac") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "story add: --ac requires a value", hint: USAGE_ADD });
      }
      ac = v;
      i += 2;
      continue;
    }
    if (a === "--body") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "story add: --body requires a value", hint: USAGE_ADD });
      }
      body = v;
      i += 2;
      continue;
    }
    if (a === "--merge-mode") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "story add: --merge-mode requires a value",
          hint: USAGE_ADD,
        });
      }
      if (v !== "feature-branch" && v !== "trunk-direct") {
        throw new UsageError({
          what: `story add: --merge-mode must be 'feature-branch' or 'trunk-direct' (got '${v}')`,
          hint: USAGE_ADD,
        });
      }
      mergeMode = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "story add: --team-dir requires a value",
          hint: USAGE_ADD,
        });
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
      throw new UsageError({ what: `story add: unknown flag: ${a}`, hint: USAGE_ADD });
    }
    title = title.length === 0 ? (a ?? "") : `${title} ${a ?? ""}`;
    i += 1;
  }
  if (title.length === 0) {
    throw new UsageError({ what: "story add: <title> required", hint: USAGE_ADD });
  }
  if (epic.length === 0) {
    throw new UsageError({ what: "story add: --epic <epic-id> required", hint: USAGE_ADD });
  }
  const out: ParsedAddArgs = { title, epic };
  if (body !== undefined) out.body = body;
  if (ac !== undefined) out.ac = ac;
  if (mergeMode !== undefined) out.mergeMode = mergeMode;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

interface ParsedListArgs {
  epic: string;
  status?: string;
  json: boolean;
  teamDir?: string;
}

export function parseListArgs(argv: ReadonlyArray<string>): ParsedListArgs {
  let epic = "";
  let status: string | undefined;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--epic") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "story list: --epic requires a value", hint: USAGE_LIST });
      }
      epic = v;
      i += 2;
      continue;
    }
    if (a === "--status") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "story list: --status requires a value",
          hint: USAGE_LIST,
        });
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
          what: "story list: --team-dir requires a value",
          hint: USAGE_LIST,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `story list: unknown arg: ${a ?? ""}`, hint: USAGE_LIST });
  }
  if (epic.length === 0) {
    throw new UsageError({ what: "story list: --epic <epic-id> required", hint: USAGE_LIST });
  }
  const out: ParsedListArgs = { epic, json };
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
          what: "story show: --team-dir requires a value",
          hint: USAGE_SHOW,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `story show: unknown flag: ${a ?? ""}`, hint: USAGE_SHOW });
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
        throw new UsageError({ what: "story advance: --to requires a value", hint: USAGE_ADV });
      }
      to = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "story advance: --team-dir requires a value",
          hint: USAGE_ADV,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `story advance: unknown flag: ${a ?? ""}`, hint: USAGE_ADV });
  }
  const out: AdvanceFlags = {};
  if (to !== undefined) out.to = to;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- ADR-175 GAP 1: signoff / unsignoff subverbs ----------

async function storySignoffVerb(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "story signoff: <id> required", hint: USAGE_SIGNOFF });
  }
  const flags = parseSignoffFlags(rest, "story signoff", USAGE_SIGNOFF);
  const dirOpts: ResolveDirOpts = flags.teamDir !== undefined ? { teamDir: flags.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const callerMember = process.env.ATMUX_MEMBER;
  const opts: Parameters<typeof storySignoff>[2] = {};
  if (flags.as !== undefined) opts.as = flags.as;
  if (flags.note !== undefined) opts.note = flags.note;
  if (callerMember !== undefined && callerMember.length > 0) opts.callerMember = callerMember;
  const r = await storySignoff(atmuxDir, id, opts);
  process.stderr.write(
    `story: ${r.storyId} signed off by ${r.signedOffBy} at ${r.signedOffAt}\n`,
  );
  return 0;
}

async function storyUnsignoffVerb(argv: ReadonlyArray<string>): Promise<number> {
  const { positional, rest } = splitFlagsAndPositionals(argv);
  const id = positional[0];
  if (id === undefined || id.length === 0) {
    throw new UsageError({ what: "story unsignoff: <id> required", hint: USAGE_UNSIGNOFF });
  }
  const flags = parseSignoffFlags(rest, "story unsignoff", USAGE_UNSIGNOFF);
  const dirOpts: ResolveDirOpts = flags.teamDir !== undefined ? { teamDir: flags.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const callerMember = process.env.ATMUX_MEMBER;
  const opts: Parameters<typeof storyUnsignoff>[2] = {};
  if (flags.as !== undefined) opts.as = flags.as;
  if (flags.note !== undefined) opts.note = flags.note;
  if (callerMember !== undefined && callerMember.length > 0) opts.callerMember = callerMember;
  const r = await storyUnsignoff(atmuxDir, id, opts);
  process.stderr.write(
    `story: ${r.storyId} signoff REVERSED by ${r.unsignedBy} at ${r.unsignedAt}\n`,
  );
  return 0;
}

interface SignoffFlags {
  as?: string;
  note?: string;
  teamDir?: string;
}

export function parseSignoffFlags(
  argv: ReadonlyArray<string>,
  label = "story signoff",
  usage = USAGE_SIGNOFF,
): SignoffFlags {
  let as: string | undefined;
  let note: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--as") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${label}: --as requires a value`, hint: usage });
      }
      as = v;
      i += 2;
      continue;
    }
    if (a === "--note") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${label}: --note requires a value`, hint: usage });
      }
      note = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `${label}: --team-dir requires a value`, hint: usage });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `${label}: unknown flag: ${a ?? ""}`, hint: usage });
  }
  const out: SignoffFlags = {};
  if (as !== undefined) out.as = as;
  if (note !== undefined) out.note = note;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

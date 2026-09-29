// ADR-292: `atmux msg` — pane-to-pane messenger (mailbox + print-address wake).
//
//   atmux msg send <peer> [--priority p0..p3 | --p0..--p3] [--as <sender>] [--team-dir <d>] <body...>
//   atmux msg check [--min <p>] [--since <epoch>] [--all] [--ack] [--json] [--as <m>] [--team-dir <d>]
//   atmux msg read [--min <p>] [--since <epoch>] [--all] [--ack] [--json] [--as <m>] [--team-dir <d>]
//
// `send` appends a `kind='msg'` row and prints the peer's
// `<session>:<window>` address plus a wake pointer the caller delivers
// via `/pane-agent send --queued`. It NEVER drives pane input — this
// module (and `src/core/msg/`) must not import the pane-input injection
// surface from `src/abstractions/tmux.ts` (ADR-292 §D5;
// import-boundary test pins it).
//
// Identity: `--as <member>` wins, then `$ATMUX_MEMBER`, mirroring
// `claim --as` / `pickMemberName`. `send` records the sender as-is;
// `check`/`read` resolve the READER (mailbox owner) and refuse unknown
// or missing names rather than showing the wrong mailbox.

import { now as nowMs } from "../abstractions/time.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import {
  ackMsgs,
  coercePriority,
  DEFAULT_MSG_MIN,
  DEFAULT_MSG_PRIORITY,
  filterSince,
  filterUnread,
  firstLine,
  formatMyt,
  isPriority,
  listMsg,
  type MsgPriority,
  type MsgView,
  meetsMin,
  msgTipTs,
  PRIORITIES,
  readMsgCursor,
  resolveEffectiveCursor,
  sendMsg,
  withAckState,
} from "../core/msg/index.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

export const MSG_USAGE =
  "atmux msg send <peer> [--priority p0..p3] [--as <sender>] [--team-dir <dir>] <body...>\n" +
  "       atmux msg check [--min <p>] [--since <epoch>] [--all] [--ack] [--json] [--as <member>] [--team-dir <dir>]\n" +
  "       atmux msg read [--min <p>] [--since <epoch>] [--all] [--ack] [--json] [--as <member>] [--team-dir <dir>]";

// ---------- Args ----------

export interface MsgSendArgs {
  peer: string;
  priority: MsgPriority;
  body: string;
  as?: string;
  teamDir?: string;
}

export interface MsgReadArgs {
  showAll: boolean;
  sinceEpoch?: number;
  ack: boolean;
  json: boolean;
  min: MsgPriority;
  as?: string;
  teamDir?: string;
}

/** Parse a priority option value (`--priority` / `--min`); throws on garbage. */
function parsePriorityFlag(flag: string, value: string | undefined, verb: string): MsgPriority {
  if (value === undefined) {
    throw new UsageError({
      what: `msg ${verb}: ${flag} requires a value (p0..p3)`,
      hint: MSG_USAGE,
    });
  }
  if (!isPriority(value)) {
    throw new UsageError({
      what: `msg ${verb}: ${flag} must be one of p0..p3 (got: ${value})`,
      hint: MSG_USAGE,
    });
  }
  return value;
}

/** Shared `--since/--all/--ack/--json/--min/--as/--team-dir` scan for check/read. */
export function parseMsgReadArgs(argv: ReadonlyArray<string>, verb: "check" | "read"): MsgReadArgs {
  let showAll = false;
  let sinceEpoch: number | undefined;
  let ack = false;
  let json = false;
  let min: MsgPriority = DEFAULT_MSG_MIN;
  let as: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--all") {
      showAll = true;
      i += 1;
    } else if (a === "--ack") {
      ack = true;
      i += 1;
    } else if (a === "--json") {
      json = true;
      i += 1;
    } else if (a === "--min") {
      min = parsePriorityFlag("--min", argv[i + 1], verb);
      i += 2;
    } else if (a === "--since") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `msg ${verb}: --since requires a value`, hint: MSG_USAGE });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new UsageError({
          what: `msg ${verb}: --since requires non-negative epoch seconds (got: ${v})`,
          hint: MSG_USAGE,
        });
      }
      sinceEpoch = n;
      i += 2;
    } else if (a === "--as") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `msg ${verb}: --as requires a member name`, hint: MSG_USAGE });
      }
      as = v;
      i += 2;
    } else if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: `msg ${verb}: --team-dir requires a value`,
          hint: MSG_USAGE,
        });
      }
      teamDir = v;
      i += 2;
    } else {
      throw new UsageError({ what: `msg ${verb}: unknown arg: ${a ?? ""}`, hint: MSG_USAGE });
    }
  }

  const out: MsgReadArgs = { showAll, ack, json, min };
  if (sinceEpoch !== undefined) out.sinceEpoch = sinceEpoch;
  if (as !== undefined) out.as = as;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

export function parseMsgSendArgs(argv: ReadonlyArray<string>): MsgSendArgs {
  let priority: MsgPriority = DEFAULT_MSG_PRIORITY;
  let as: string | undefined;
  let teamDir: string | undefined;
  let peer: string | undefined;
  const bodyParts: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] ?? "";
    if (a === "--priority") {
      priority = parsePriorityFlag("--priority", argv[i + 1], "send");
      i += 2;
    } else if (a === "--p0" || a === "--p1" || a === "--p2" || a === "--p3") {
      priority = a.slice(2) as MsgPriority;
      i += 1;
    } else if (a === "--as") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "msg send: --as requires a member name", hint: MSG_USAGE });
      }
      as = v;
      i += 2;
    } else if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "msg send: --team-dir requires a value", hint: MSG_USAGE });
      }
      teamDir = v;
      i += 2;
    } else if (a.startsWith("--")) {
      throw new UsageError({ what: `msg send: unknown arg: ${a}`, hint: MSG_USAGE });
    } else if (peer === undefined) {
      peer = a;
      i += 1;
    } else {
      bodyParts.push(a);
      i += 1;
    }
  }
  if (peer === undefined) {
    throw new UsageError({ what: "msg send: need a peer + body", hint: MSG_USAGE });
  }
  const body = bodyParts.join(" ");
  if (body.length === 0) {
    throw new UsageError({ what: "msg send: need a peer + body", hint: MSG_USAGE });
  }
  const out: MsgSendArgs = { peer, priority, body };
  if (as !== undefined) out.as = as;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Identity (env type mirrors claim.ts: `NodeJS.ProcessEnv`) ----------

/** One addressable mailbox: a team member or a driver seat. */
export interface MsgRosterEntry {
  readonly name: string;
  /** Window name inside the team session (the pointer's address). */
  readonly window: string;
}

/**
 * ADR-292 §D6 roster = `members[]` plus the `drivers[]` seats. Drivers
 * are the default roster since ADR-287 §D5 (drivers-only teams), and
 * their window is named after the driver (`driver`, `driver-2`, …).
 * A member wins over a same-named driver.
 */
export function msgRoster(team: Team): MsgRosterEntry[] {
  const out: MsgRosterEntry[] = team.members.map((m) => ({
    name: m.name,
    window: buildWindowName(m.name, m.emoji, m.label, m.role),
  }));
  // `drivers` is schema-defaulted to the canonical roster (ADR-239 §A1).
  for (const d of team.drivers) {
    if (!out.some((e) => e.name === d.name)) out.push({ name: d.name, window: d.name });
  }
  return out;
}

/**
 * Resolve the mailbox owner for check/read: `--as` wins, then
 * `$ATMUX_MEMBER`. Missing → UsageError; unknown roster name →
 * ConfigError (fail closed — never show the wrong mailbox).
 */
export function resolveMsgReader(
  as: string | undefined,
  env: NodeJS.ProcessEnv,
  members: ReadonlyArray<{ readonly name: string }>,
  verb: "check" | "read",
): string {
  const raw = as ?? env.ATMUX_MEMBER;
  if (raw === undefined || raw.length === 0) {
    throw new UsageError({
      what: `msg ${verb}: can't infer member — pass --as <member> or set ATMUX_MEMBER`,
      hint: MSG_USAGE,
    });
  }
  if (!members.some((m) => m.name === raw)) {
    throw new ConfigError({ what: `msg ${verb}: no such member in team.json: ${raw}` });
  }
  return raw;
}

// ---------- Entrypoint ----------

export interface MsgOpts {
  stdout?: Writer;
  /** Clock — defaults to `time.now()` (ms). */
  now?: () => number;
  /** Member-identity env — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** `atmux msg <send|check|read> …`. `check` exits 0/1 per ADR-292 §D4. */
export async function msg(argv: ReadonlyArray<string>, opts: MsgOpts = {}): Promise<number> {
  const sub = argv[0];
  if (sub === "send") return msgSend(argv.slice(1), opts);
  if (sub === "check") return msgCheck(argv.slice(1), opts);
  if (sub === "read") return msgRead(argv.slice(1), opts);
  throw new UsageError({
    what: `msg: unknown subverb: ${sub ?? "<none>"} (want: send|check|read)`,
    hint: MSG_USAGE,
  });
}

// ---------- send ----------

async function msgSend(argv: ReadonlyArray<string>, opts: MsgOpts): Promise<number> {
  const parsed = parseMsgSendArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const peer = msgRoster(team).find((e) => e.name === parsed.peer);
  if (peer === undefined) {
    throw new ConfigError({ what: `msg send: unknown peer \`${parsed.peer}\` (not in team.json)` });
  }
  const atmuxDir = await getAtmuxDir(dirOpts);
  const env = opts.env ?? process.env;
  const sender = parsed.as ?? env.ATMUX_MEMBER ?? "cli";
  const clock = opts.now ?? nowMs;
  const { msgId } = await sendMsg(atmuxDir, {
    to: peer.name,
    sender,
    body: parsed.body,
    priority: parsed.priority,
    ts: Math.floor(clock() / 1000),
  });
  // ADR-292 §D6 — roster addressing like tell-lead: print
  // `<session>:<window>` via the shared window-name builder.
  const sessionName = await getSessionName({ ...dirOpts, team });
  const window = peer.window;
  const stdout = opts.stdout ?? defaultStdoutWrite;
  stdout(`peer=${peer.name} window=${sessionName}:${window} priority=${parsed.priority}\n`);
  stdout(`pointer="msg ${msgId} from ${sender}: ${firstLine(parsed.body)} — atmux msg check"\n`);
  return 0;
}

// ---------- check / read (shared scan) ----------

interface MsgScan {
  reader: string;
  min: MsgPriority;
  unread: MsgView[];
  /** `read` view: everything after the cursor, ack state attached. */
  since: MsgView[];
  stored: number | null;
  tip: number | null;
}

async function scanMailbox(
  dirOpts: ResolveDirOpts,
  parsed: MsgReadArgs,
  verb: "check" | "read",
  env: NodeJS.ProcessEnv,
): Promise<MsgScan> {
  const team = await requireTeam(dirOpts);
  const reader = resolveMsgReader(parsed.as, env, msgRoster(team), verb);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const stored = await readMsgCursor(atmuxDir, reader);
  const cursor = resolveEffectiveCursor({
    showAll: parsed.showAll,
    sinceEpoch: parsed.sinceEpoch,
    stored,
  });
  const views = withAckState(await listMsg(atmuxDir, reader), reader);
  return {
    reader,
    min: parsed.min,
    unread: filterUnread(views, { cursor, min: parsed.min }),
    since: filterSince(views, { cursor, min: parsed.min }),
    stored,
    tip: msgTipTs(views),
  };
}

/** `--ack`: per-row ack on the shown rows + cursor advance to the mailbox tip. */
async function applyAck(
  atmuxDir: string,
  reader: string,
  shown: ReadonlyArray<MsgView>,
  tip: number | null,
  nowEpochSec: number,
): Promise<number | null> {
  if (shown.length === 0 || tip === null) return null;
  await ackMsgs({
    atmuxDir,
    reader,
    ids: shown.map((r) => r.id),
    tipTs: tip,
    nowEpochSec,
  });
  return tip;
}

function serializeView(r: MsgView): {
  id: number;
  msgId: string | null;
  priority: MsgPriority;
  sender: string;
  body: string;
  ts: number;
  acked: boolean;
  ackedAt: number | null;
} {
  return {
    id: r.id,
    msgId: r.msgId,
    priority: r.priority,
    sender: r.sender,
    body: r.body,
    ts: r.ts,
    acked: r.acked,
    ackedAt: r.ackedAt,
  };
}

function checkLine(r: MsgView): string {
  return `[${r.priority}] from ${r.sender} (${formatMyt(r.ts)}): ${firstLine(r.body)}`;
}

async function msgCheck(argv: ReadonlyArray<string>, opts: MsgOpts): Promise<number> {
  const parsed = parseMsgReadArgs(argv, "check");
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const env = opts.env ?? process.env;
  const clock = opts.now ?? nowMs;
  const scan = await scanMailbox(dirOpts, parsed, "check", env);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  if (parsed.json) {
    const cursorAfter = await maybeAck(dirOpts, parsed, scan, scan.unread, clock);
    stdout(
      `${JSON.stringify({
        reader: scan.reader,
        min: scan.min,
        entries: scan.unread.map(serializeView),
        cursorBefore: scan.stored,
        cursorAfter,
      })}\n`,
    );
  } else if (scan.unread.length === 0) {
    stdout(`nothing unread at or above ${scan.min}\n`);
    await maybeAck(dirOpts, parsed, scan, scan.unread, clock);
  } else if (scan.unread.length === 1 && scan.unread[0] !== undefined) {
    const only = scan.unread[0];
    stdout(`1 unread ${only.priority} from ${only.sender} (${formatMyt(only.ts)})\n`);
    await maybeAck(dirOpts, parsed, scan, scan.unread, clock);
  } else {
    stdout(`${scan.unread.length} unread at or above ${scan.min}:\n`);
    for (const r of scan.unread) stdout(`  ${checkLine(r)}\n`);
    await maybeAck(dirOpts, parsed, scan, scan.unread, clock);
  }
  // ADR-292 §D4: 1 = unread exists at or above --min, 0 = nothing.
  return scan.unread.length > 0 ? 1 : 0;
}

async function msgRead(argv: ReadonlyArray<string>, opts: MsgOpts): Promise<number> {
  const parsed = parseMsgReadArgs(argv, "read");
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const env = opts.env ?? process.env;
  const clock = opts.now ?? nowMs;
  const scan = await scanMailbox(dirOpts, parsed, "read", env);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  if (parsed.json) {
    const cursorAfter = await maybeAck(dirOpts, parsed, scan, scan.since, clock);
    stdout(
      `${JSON.stringify({
        reader: scan.reader,
        min: scan.min,
        entries: scan.since.map(serializeView),
        cursorBefore: scan.stored,
        cursorAfter,
      })}\n`,
    );
  } else if (scan.since.length === 0) {
    stdout("(no messages)\n");
    await maybeAck(dirOpts, parsed, scan, scan.since, clock);
  } else {
    for (const r of scan.since) {
      const flag = r.acked ? "acked" : "unread";
      stdout(
        `msg ${r.msgId ?? `m-${r.id}`} [${r.priority}] from ${r.sender} (${formatMyt(r.ts)}) [${flag}]:\n`,
      );
      stdout(`${r.body}\n`);
    }
    await maybeAck(dirOpts, parsed, scan, scan.since, clock);
  }
  return 0;
}

/** Shared `--ack` application; returns the JSON `cursorAfter` value. */
async function maybeAck(
  dirOpts: ResolveDirOpts,
  parsed: MsgReadArgs,
  scan: MsgScan,
  shown: ReadonlyArray<MsgView>,
  clock: () => number,
): Promise<number | null> {
  if (!parsed.ack) return scan.stored;
  const atmuxDir = await getAtmuxDir(dirOpts);
  const after = await applyAck(atmuxDir, scan.reader, shown, scan.tip, Math.floor(clock() / 1000));
  return after ?? scan.stored;
}

// Re-exported for unit tests: priority-flag validation shares the
// `p0..p3` vocabulary with `--min` filtering.
export { coercePriority, meetsMin, PRIORITIES };

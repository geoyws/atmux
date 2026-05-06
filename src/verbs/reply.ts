// ADR-010: CLI dispatcher — `reply` (member→driver) and `outbox`
// (driver-side reader) verbs (shared module).
// Bash spec: lib/reply.sh @ worktree-frozen.
//
// `atmux reply [--from <member>] <msg...>`  — append to lead-outbox.md
// `atmux outbox [--ack] [--json]`           — read open entries
//
// Bash routes `atmux reply <msg>` → `atmux reply --reply <msg>` and
// `atmux outbox` → `atmux reply --outbox` via bin/atmux argv rewrite
// (lib/reply.sh:5-6). The TS port keeps the shared module + exposes
// two verb entrypoints.
//
// Outbox file shape (markdown, bash:49-57):
//
//   # Lead Outbox — replies back to the driver
//
//   Any team member writes here via `atmux reply <msg>`. ...
//
//   ## Open
//   - [<ts>] **<from>**: <msg>
//
//   ## Archive
//   - [<ts>] **<from>**: <msg>  _(archived <ts>)_
//
// New entries land under `## Open` (newest-first via insertion right
// after the `## Open` line — bash awk:65-67). `--ack` moves all open
// entries to `## Archive` with a timestamp suffix.

import { writeText } from "../abstractions/fs.ts";
import { withLock } from "../abstractions/lock.ts";
import { formatMyt } from "../abstractions/time.ts";
import {
  getAtmuxDir,
  leadOutboxPath,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { ConfigError, UsageError } from "../errors.ts";

const USAGE_REPLY = "atmux reply [--from <member>] <msg...>";
const USAGE_OUTBOX = "atmux outbox [--ack] [--json]";

const OUTBOX_HEADER = `# Lead Outbox — replies back to the driver

Any team member writes here via \`atmux reply <msg>\`. The driver reads via
\`atmux outbox\`. Entries default to the \`## Open\` section; \`atmux outbox --ack\`
archives everything there to \`## Archive\`.

## Open
`;

// ---------- Reply ----------

/** Parsed `reply` argv. */
export interface ReplyArgs {
  msg: string;
  from?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseReplyArgs(argv: ReadonlyArray<string>): ReplyArgs {
  let from: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--from") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "reply: --from requires a member name", hint: USAGE_REPLY });
      }
      from = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "reply: --team-dir requires a value", hint: USAGE_REPLY });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--") {
      i += 1;
      break;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({ what: `reply: unknown flag: ${a}`, hint: USAGE_REPLY });
    }
    break;
  }
  const msg = argv.slice(i).join(" ");
  if (msg.length === 0) {
    throw new UsageError({ what: `usage: ${USAGE_REPLY}` });
  }
  const out: ReplyArgs = { msg };
  if (from !== undefined) out.from = from;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** `atmux reply [--from <member>] <msg...>`. Returns 0. */
export async function reply(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseReplyArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  // Bash: `from` defaults to $ATMUX_MEMBER, then "lead" (lib/reply.sh:38).
  const from = parsed.from ?? process.env.ATMUX_MEMBER ?? "lead";
  // If --from given, validate it exists in team.json (defensive); env
  // / "lead" defaults skip this — bash matches.
  if (parsed.from !== undefined && !team.members.some((m) => m.name === parsed.from)) {
    // "lead" is a valid synthetic name even when not in members[];
    // mirror bash by allowing it specifically.
    if (parsed.from !== "lead") {
      throw new ConfigError({
        what: `reply: no such member in team.json: ${parsed.from}`,
      });
    }
  }
  const path = leadOutboxPath(atmuxDir);
  await withLock(path, async () => {
    await appendOutboxEntry(path, from, parsed.msg);
  });
  process.stdout.write(`reply recorded (${from} → driver) in ${path}\n`);
  return 0;
}

/**
 * Pure: insert a new entry under `## Open` in the existing outbox
 * markdown body. Returns the modified body. Used directly by tests.
 */
export function insertOpenEntry(body: string, entry: string): string {
  // Ensure `## Open` exists; bash creates it if missing (lib/reply.sh:62).
  let work = body;
  if (!/^## Open\s*$/m.test(work)) {
    work = work.replace(/\n*$/, "");
    work += `\n\n## Open\n`;
  }
  // Insert new entry on the line right after `## Open` — bash awk inserts
  // BETWEEN `## Open` and the next line, which is newest-first.
  return work.replace(/^## Open\s*$/m, `## Open\n${entry}`);
}

/**
 * Pure: move all `- [` entries under `## Open` into `## Archive`,
 * with `_(archived <ts>)_` suffix. Returns the modified body.
 */
export function archiveOpenEntries(body: string, archiveTs: string): {
  body: string;
  archived: string[];
} {
  const lines = body.split("\n");
  let inOpen = false;
  const open: string[] = [];
  const out: string[] = [];
  let hasArchive = false;
  for (const line of lines) {
    if (/^## Archive\b/.test(line)) {
      hasArchive = true;
    }
    if (/^## Open\s*$/.test(line)) {
      inOpen = true;
      out.push(line);
      continue;
    }
    if (/^## /.test(line) && inOpen) {
      inOpen = false;
    }
    if (inOpen && /^- \[/.test(line)) {
      open.push(line);
      continue;
    }
    out.push(line);
  }
  if (open.length === 0) {
    // Nothing to archive — return unchanged.
    return { body, archived: [] };
  }
  if (!hasArchive) {
    out.push("");
    out.push("## Archive");
  }
  for (const e of open) {
    out.push(`${e}  _(archived ${archiveTs})_`);
  }
  return { body: out.join("\n"), archived: open };
}

// ---------- Outbox reader ----------

/** Parsed `outbox` argv. */
export interface OutboxArgs {
  ack: boolean;
  json: boolean;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseOutboxArgs(argv: ReadonlyArray<string>): OutboxArgs {
  let ack = false;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--ack") {
      ack = true;
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
        throw new UsageError({ what: "outbox: --team-dir requires a value", hint: USAGE_OUTBOX });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `outbox: unknown arg: ${a ?? ""}`, hint: USAGE_OUTBOX });
  }
  const out: OutboxArgs = { ack, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** `atmux outbox [--ack] [--json]`. Returns 0. */
export async function outbox(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseOutboxArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);
  const path = leadOutboxPath(atmuxDir);

  const file = Bun.file(path);
  const fileExists = await file.exists();
  if (!fileExists) {
    if (parsed.json) {
      process.stdout.write('{"open":[]}\n');
    } else {
      process.stdout.write("(outbox empty)\n");
    }
    return 0;
  }

  const body = await file.text();
  const entries = collectOpenEntries(body);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ open: entries })}\n`);
  } else if (entries.length === 0) {
    process.stdout.write("📭 outbox empty\n");
  } else {
    process.stdout.write("📬 lead-outbox — open messages:\n\n");
    for (const e of entries) {
      process.stdout.write(`${e}\n`);
    }
  }

  if (parsed.ack && entries.length > 0) {
    await withLock(path, async () => {
      const cur = await Bun.file(path).text();
      const ts = formatMyt();
      const result = archiveOpenEntries(cur, ts);
      await writeText(path, result.body);
    });
    process.stdout.write(`archived ${entries.length} entries\n`);
  }
  return 0;
}

/**
 * Pure: collect lines under `## Open` that look like `- [...]`. Bash
 * does this with `awk '/^## Open/{flag=1;next}/^## /{flag=0}flag && /^- \\[/'`.
 */
export function collectOpenEntries(body: string): string[] {
  const lines = body.split("\n");
  let inOpen = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^## Open\s*$/.test(line)) {
      inOpen = true;
      continue;
    }
    if (/^## /.test(line) && inOpen) {
      inOpen = false;
      continue;
    }
    if (inOpen && /^- \[/.test(line)) {
      out.push(line);
    }
  }
  return out;
}

// ---------- Internals ----------

async function appendOutboxEntry(path: string, from: string, msg: string): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : OUTBOX_HEADER;
  // Per ADR-029 §F4 — bash atmux::now_myt emits HH:MM MYT (lib/common.sh:225);
  // formatMyt mirrors. Earlier port used formatMytFull (YYYY-MM-DD HH:MM:SS
  // MYT) which violated CLAUDE.md global timezone rule + diverged from bash.
  const ts = formatMyt();
  const entry = `- [${ts}] **${from}**: ${msg}`;
  const next = insertOpenEntry(existing, entry);
  await writeText(path, next);
}

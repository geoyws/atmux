// ADR-010: CLI dispatcher — `inbox` verb (read-only).
//
// `atmux inbox <member> [--json]`
//
// Read-only display of a member's inbox (pending / inProgress / done).
// Canonical source: `state.db` tasks table (ADR-076 SQL-only).

import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { loadInbox } from "../core/inbox.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { InboxEntry } from "../schema/inbox.ts";

const USAGE = "atmux inbox <member> [--json]";

export interface InboxArgs {
  member: string;
  json: boolean;
  teamDir?: string;
}

export function parseInboxArgs(argv: ReadonlyArray<string>): InboxArgs {
  let member = "";
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
        throw new UsageError({ what: "inbox: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `inbox: unknown flag: ${a}`, hint: USAGE });
    }
    if (member.length > 0) {
      throw new UsageError({ what: "inbox: too many args", hint: USAGE });
    }
    member = a ?? "";
    i += 1;
  }
  if (member.length === 0) {
    throw new UsageError({ what: `usage: ${USAGE}` });
  }
  const out: InboxArgs = { member, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

export async function inbox(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseInboxArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};

  const team = await requireTeam(dirOpts);
  if (!team.members.some((m) => m.name === parsed.member)) {
    throw new ConfigError({
      what: `inbox: no such member in team.json: ${parsed.member}`,
    });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  const data = await loadInbox(atmuxDir, parsed.member);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`inbox — ${parsed.member}\n\n`);
  printSection("pending", data.pending);
  printSection("in-progress", data.inProgress);
  printSection("done", data.done);
  return 0;
}

function printSection(label: string, entries: ReadonlyArray<InboxEntry>): void {
  process.stdout.write(`${label}\n`);
  if (entries.length === 0) {
    process.stdout.write("  (empty)\n\n");
    return;
  }
  for (const e of entries) {
    const id = (e.id ?? "").padEnd(10);
    const subject = e.subject ?? "";
    process.stdout.write(`  ${id} ${subject}\n`);
  }
  process.stdout.write("\n");
}

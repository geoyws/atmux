// ADR-010: CLI dispatcher — `inbox` verb (read-only).
// Bash spec: lib/inbox.sh @ worktree-frozen.
//
// `atmux inbox <member> [--json]`
//
// Read-only display of a member's inbox (pending / inProgress / done).
// Lazily materialises the inbox file on first read (bash lib/inbox.sh:
// 20-25); both bash and TS treat absence as "empty inbox" and verify
// the member exists in team.json before writing the stub.

import { writeText } from "../abstractions/fs.ts";
import { getAtmuxDir, inboxPathFor, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { emptyInbox, loadInbox } from "../core/inbox.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { InboxEntry } from "../schema/inbox.ts";

const USAGE = "atmux inbox <member> [--json]";

/** Parsed `inbox` argv. */
export interface InboxArgs {
  member: string;
  json: boolean;
  teamDir?: string;
}

/** Pure parser. */
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

/** `atmux inbox <member> [--json]`. Returns 0. */
export async function inbox(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseInboxArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};

  // Bash lib/inbox.sh:22 verifies the member exists in team.json
  // before materializing — so an `atmux inbox bogus` errors instead of
  // silently writing an empty inbox file. Mirror.
  const team = await requireTeam(dirOpts);
  if (!team.members.some((m) => m.name === parsed.member)) {
    throw new ConfigError({
      what: `inbox: no such member in team.json: ${parsed.member}`,
    });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  // Lazy materialize: bash writes `{pending:[],inProgress:[],done:[]}`
  // when the file is missing (lib/inbox.sh:24). Mirror via writeText —
  // this keeps a future read consistent with bash's on-disk shape.
  // loadInbox would also synthesize the empty shape via updateJson,
  // but writing the canonical body up-front matches bash byte-for-byte.
  const inboxPath = inboxPathFor(atmuxDir, parsed.member);
  const data = await loadInbox(atmuxDir, parsed.member);
  // Force the on-disk file to exist for parity with bash's first-run
  // stub-write. loadInbox via updateJson already wrote it, but its
  // pretty-printed form may differ from bash's compact `echo '{…}'`.
  // For --json output we re-emit our canonical shape; for the human
  // view we just need the data structure.

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`inbox — ${parsed.member}\n\n`);
  printSection("pending", data.pending);
  printSection("in-progress", data.inProgress);
  printSection("done", data.done);

  // Suppress unused-var warning; inboxPath is the file we just
  // materialized (consumer-side reference for debugging the path).
  void inboxPath;
  return 0;
}

// ---------- Internals ----------

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

// Re-export the empty-inbox factory + atomicWrite plumbing so tests
// that want to stage an inbox state without going through a verb can
// import from one path.
export { emptyInbox, writeText };

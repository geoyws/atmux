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
import { findTeamByName, loadCockpit } from "../core/cockpit.ts";
import {
  driverInboxPath,
  getAtmuxDir,
  inboxPathFor,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { emptyInbox, loadInbox } from "../core/inbox.ts";
import { archiveFile, parseDuration } from "../core/inbox-outbox-archive.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { InboxEntry } from "../schema/inbox.ts";

const USAGE = "atmux inbox <member> [--json]";

const ARCHIVE_USAGE =
  "atmux inbox archive [--older-than <Nm|Nh|Nd>] [--team <name>] [--team-dir <path>] [--json]";

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
  // e-77 T2 OQ1 conflict gate: `archive` is the archive-subcommand
  // keyword, so it can never address a member — even one literally
  // named `archive`. Structurally unreachable via inbox() (the
  // precedence dispatch below routes first), this guards direct
  // parseInboxArgs callers with a hint instead of a confusing
  // "no such member" error.
  if (member === "archive") {
    throw new UsageError({
      what: "inbox: member `archive` is reserved — did you mean `atmux inbox archive`?",
      hint: ARCHIVE_USAGE,
    });
  }
  const out: InboxArgs = { member, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** `atmux inbox <member> [--json]`, or `atmux inbox archive [...]`. Returns 0. */
export async function inbox(argv: ReadonlyArray<string>): Promise<number> {
  // e-77 T2 OQ1 precedence: the `archive` subcommand keyword wins over
  // the member-name positional wherever it appears. Strip the first
  // positional occurrence and route the rest to the archive flow.
  const subIdx = argv.findIndex((a) => !a.startsWith("-"));
  if (subIdx >= 0 && argv[subIdx] === "archive") {
    return inboxArchive([...argv.slice(0, subIdx), ...argv.slice(subIdx + 1)]);
  }
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

// ---------- `inbox archive` (e-77 T2) ----------

/** Parsed `inbox archive` argv. `--older-than` defaults to 48h per OQ3. */
export interface InboxArchiveArgs {
  olderThan: string;
  team?: string;
  teamDir?: string;
  json: boolean;
}

/** Pure parser. Takes argv *without* the `archive` keyword. */
export function parseInboxArchiveArgs(argv: ReadonlyArray<string>): InboxArchiveArgs {
  let olderThan = "48h";
  let team: string | undefined;
  let teamDir: string | undefined;
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--older-than") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "inbox archive: --older-than requires a value", hint: ARCHIVE_USAGE });
      }
      olderThan = v;
      i += 2;
      continue;
    }
    if (a === "--team") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "inbox archive: --team requires a value", hint: ARCHIVE_USAGE });
      }
      team = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "inbox archive: --team-dir requires a value", hint: ARCHIVE_USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `inbox archive: unknown flag: ${a}`, hint: ARCHIVE_USAGE });
    }
    throw new UsageError({ what: `inbox archive: unexpected arg: ${a}`, hint: ARCHIVE_USAGE });
  }
  const out: InboxArchiveArgs = { olderThan, json };
  if (team !== undefined) out.team = team;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Test seam for `inboxArchive` output. Defaults to process.stdout. */
export interface InboxArchiveOut {
  stdout?: { write(chunk: string): unknown };
}

/**
 * `atmux inbox archive [--older-than <dur>] [--team <name>] [--json]`.
 * Archives driver-inbox.md entries older than the cutoff via the T1
 * helper. Missing file is a no-op exit 0 (epic Decision: read-side
 * disposal never fails a cron tick). Returns 0.
 */
export async function inboxArchive(
  argv: ReadonlyArray<string>,
  out?: InboxArchiveOut,
): Promise<number> {
  const parsed = parseInboxArchiveArgs(argv);
  const stdout = out?.stdout ?? process.stdout;
  let dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};

  // OQ2: --team resolves via the existing cockpit-walk team resolver,
  // same seam tell-lead --team uses (loadCockpit + findTeamByName),
  // re-anchored to the target root. No caller-scope gate: archive is
  // local maintenance on files the driver already owns, not a
  // cross-team send.
  if (parsed.team !== undefined) {
    const cockpit = await loadCockpit();
    const target = findTeamByName(cockpit, parsed.team);
    if (target === null) {
      throw new ConfigError({
        what: `inbox archive --team: no team \`${parsed.team}\` in cockpit tree`,
        hint: 'check ~/.atmux/cockpit.json (or ATMUX_COCKPIT_CONFIG); team name must match a `type: "team"` node',
      });
    }
    dirOpts = { teamDir: target.root };
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  const inboxPath = driverInboxPath(atmuxDir);
  const result = await archiveFile(inboxPath, parseDuration(parsed.olderThan));

  if (parsed.json) {
    stdout.write(
      `${JSON.stringify(
        {
          path: inboxPath,
          olderThan: parsed.olderThan,
          entriesArchived: result.entriesArchived,
          archivePath: result.archivePath,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (result.archivePath === null) {
    stdout.write(`inbox archive: nothing older than ${parsed.olderThan} in ${inboxPath}\n`);
    return 0;
  }
  stdout.write(
    `inbox archive: ${result.entriesArchived} entries older than ${parsed.olderThan} → ${result.archivePath}\n`,
  );
  return 0;
}

// Re-export the empty-inbox factory + atomicWrite plumbing so tests
// that want to stage an inbox state without going through a verb can
// import from one path.
export { emptyInbox, writeText };

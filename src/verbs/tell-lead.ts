// ADR-010: CLI dispatcher — `tell-lead` verb (driver convenience).
// Bash spec: lib/tell.sh @ worktree-frozen.
//
// `atmux tell-lead <msg...>`
//
// Driver appends an ask to .atmux/driver-inbox.md (durable, greppable,
// survives /clear) AND pings the lead's pane with a heads-up. Pattern
// mirrors the driver→lead routing rule in CLAUDE.md (file-based, not
// SendMessage).
//
// Lead resolution (bash lib/tell.sh::_atmux_find_lead):
//   1. First member with role="team-lead"
//   2. Else: first member named "lead"
//   3. Else: ConfigError ("no lead defined in team.json")

import { statOrNull, writeText } from "../abstractions/fs.ts";
import { formatMyt } from "../abstractions/time.ts";
import { createTmux } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { recordHeadsUp, shouldEmitHeadsUp } from "../core/heads-up-cursor.ts";
import { sendToMember } from "../core/send.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";

const USAGE = "atmux tell-lead <msg...>";

const DRIVER_INBOX_HEADER = `# Driver Inbox — driver asks for the lead

Lead reads this at the start of every whip turn. Mark each entry:
  ✅ done  ·  📤 delegated  ·  ⏳ in-progress  ·  ❌ rejected

Keep entries bulleted, terse, and timestamped. Move >24h entries to "## Archive".

## Open
`;

/** Parsed `tell-lead` argv. */
export interface TellLeadArgs {
  msg: string;
  socketPath?: string;
  teamDir?: string;
}

export function parseTellLeadArgs(argv: ReadonlyArray<string>): TellLeadArgs {
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "tell-lead: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "tell-lead: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--") {
      i += 1;
      break;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `tell-lead: unknown flag: ${a}`, hint: USAGE });
    }
    break;
  }
  const msg = argv.slice(i).join(" ");
  if (msg.length === 0) {
    throw new UsageError({ what: `usage: ${USAGE}` });
  }
  const out: TellLeadArgs = { msg };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Pure: find the lead member. First by role="team-lead", then by
 * literal name "lead". Returns the member or undefined.
 *
 * Exported for direct unit-testing without needing to stage a team.
 */
export function findLead(members: ReadonlyArray<TeamMember>): TeamMember | undefined {
  const byRole = members.find((m) => m.role === "team-lead");
  if (byRole !== undefined) return byRole;
  return members.find((m) => m.name === "lead");
}

/** `atmux tell-lead <msg...>`. Returns 0 on success. */
export async function tellLead(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseTellLeadArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team: Team = await requireTeam(dirOpts);

  const lead = findLead(team.members);
  if (lead === undefined) {
    throw new ConfigError({
      what: "no lead defined in team.json (need a member with role=team-lead)",
    });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  await appendDriverInbox(atmuxDir, parsed.msg);

  // t-bf09aec0: heads-up sender-side dedup. Stat driver-inbox.md
  // post-append to get the mtime of the revision we just produced;
  // shouldEmitHeadsUp consults the cursor file to decide whether to
  // ping. For tell-lead's single-shot path the gate almost always
  // green-lights (every call advances driver-inbox.md mtime), but
  // recording the cursor here claims the mtime so a polling emitter
  // (bash lib/supervisor.sh, future TS supervisor) won't re-fire on
  // the same revision and burn lead context with "Stale heads-up".
  const inboxPath = driverInboxPath(atmuxDir);
  const inboxStat = await statOrNull(inboxPath);
  const sourceMtimeMs = inboxStat?.mtimeMs ?? 0;
  const cursorOpts = {
    atmuxDir,
    source: inboxPath,
    target: lead.name,
    sourceMtimeMs,
  };
  const shouldEmit = await shouldEmitHeadsUp(cursorOpts);

  const sessionName = await getSessionName({ ...dirOpts, team });
  // t-f786031f: honour team.tmuxTmpdir for the cage socket (resolver
  // already used by every read site + whip/up/lane-tick/audit). Pre-fix
  // tell-lead pinned `/tmp/atmux-<team>/sock` unconditionally and broke
  // the heads-up ping whenever team.json declared a project-local
  // `.atmux/tmux` tmpdir. The inbox append still landed (it predates
  // the send), so the symptom was "driver-inbox.md got the entry but
  // the lead pane never woke" — exactly the 07:52 + 08:25 MYT
  // 2026-05-13 failures.
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = createTmux({ socketPath });
  const target = `${sessionName}:${buildWindowName(lead.name, lead.emoji)}`;
  // Bash heads-up (lib/tell.sh:43): "📬 driver-inbox has a new ask: <msg≤80>…"
  const headsUp = buildHeadsUp(parsed.msg);
  if (!shouldEmit) {
    // Cursor already at-or-past this mtime: another emitter (or a
    // prior tell-lead racing on the same fs-mtime granularity) has
    // already pinged the lead for this revision. Skip the send +
    // print a status line so the operator sees the dedup happened.
    process.stderr.write(
      `✅ atmux tell-lead → ${lead.name} (appended to ${inboxPath}; heads-up suppressed: cursor already at mtime)\n`,
    );
    return 0;
  }
  try {
    await sendToMember(tmux, atmuxDir, { target, member: lead.name, team: team.name }, headsUp, {
      verify: false,
    });
  } catch (e) {
    // Per ADR-029 §F6 + F7 — bash lib/tell.sh:44 calls send_to_member
    // unguarded; lib/send.sh:61-62 dies "no tmux window for <m> (is
    // the team running?)" / exit 1 when the window is missing. The
    // earlier TS port caught + warned + returned 0 (divergent — TS
    // exit 0 vs bash exit 1; TS stderr "atmux: warn: tell-lead: ping
    // failed: <reason>" vs bash "💥 atmux no tmux window for ..."
    // body). Mirror exactly: throw ConfigError with bash-byte-equal
    // body; the ADR-006 prefix divergence (`💥 atmux ` vs
    // `atmux: config: `) + exit-code divergence (1 vs 78) get masked
    // at parity-row level. The inbox write above is durable —
    // appendDriverInbox already landed before this throw.
    throw new ConfigError({
      what: `no tmux window for ${lead.name} (is the team running?)`,
      cause: e,
    });
  }

  // Send succeeded — advance the dedup cursor so polling emitters
  // (supervisor) won't re-fire the same revision. Best-effort:
  // failure to write the cursor file is non-fatal (worst case = one
  // redundant ping next supervisor tick).
  try {
    await recordHeadsUp(cursorOpts);
  } catch {
    // tolerate cursor-write failures; dedup is best-effort.
  }

  // Bash atmux::ok runs only AFTER successful send (lib/tell.sh:46);
  // the success line goes to stderr with `✅ atmux ` prefix per
  // lib/common.sh:21. F3 channel-asymmetry fix mirrors here too —
  // earlier TS port wrote to stdout without the prefix.
  process.stderr.write(`✅ atmux tell-lead → ${lead.name} (appended to ${inboxPath})\n`);
  return 0;
}

// ---------- Internals ----------

/**
 * Pure: build the heads-up payload bash sends. Truncates msg to 80
 * chars and appends `…` only when the original was longer. Exported
 * for direct unit-testing.
 */
export function buildHeadsUp(msg: string): string {
  const truncated = msg.slice(0, 80);
  const ellipsis = msg.length > 80 ? "…" : "";
  return `📬 driver-inbox has a new ask: ${truncated}${ellipsis}`;
}

async function appendDriverInbox(atmuxDir: string, msg: string): Promise<void> {
  const path = driverInboxPath(atmuxDir);
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : DRIVER_INBOX_HEADER;
  // Per ADR-029 §F8 — bash atmux::now_myt emits HH:MM MYT (lib/common.sh:225,
  // lib/tell.sh appends to driver-inbox.md); formatMyt mirrors. Earlier port
  // used formatMytFull (YYYY-MM-DD HH:MM:SS MYT) which violated CLAUDE.md
  // global timezone rule + diverged from bash.
  const ts = formatMyt();
  const entry = `- [${ts}] ${msg}\n`;
  // Per ADR-029 §F14 — bash `printf >> file` appends entry directly to
  // EOF; on a zero-byte file this produces just the entry, no leading
  // separator. Earlier port unconditionally prepended `\n` when existing
  // didn't end with `\n`, which falsely fired on empty existing (length
  // 0 doesn't end-with anything), producing an extra leading newline.
  // Treat empty existing as the no-separator-needed case.
  const next =
    existing.length === 0 || existing.endsWith("\n") ? existing + entry : `${existing}\n${entry}`;
  await writeText(path, next);
}

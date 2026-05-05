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

import { writeText } from "../abstractions/fs.ts";
import { formatMytFull } from "../abstractions/time.ts";
import { createTmux } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { sendToMember } from "../core/send.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { defaultSocketPath } from "./start.ts";

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
    if (a !== undefined && a.startsWith("-")) {
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

  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? defaultSocketPath(team.name);
  const tmux = createTmux({ socketPath });
  const target = `${sessionName}:${buildWindowName(lead.name, lead.emoji)}`;
  // Bash heads-up (lib/tell.sh:43): "📬 driver-inbox has a new ask: <msg≤80>…"
  const headsUp = buildHeadsUp(parsed.msg);
  try {
    await sendToMember(tmux, atmuxDir, { target, member: lead.name }, headsUp, {
      verify: false,
    });
  } catch (e) {
    // Bash atmux::send_to_member doesn't fail-loud here; the ask is
    // already durable in the inbox file. Surface as warn so the
    // operator sees the ping failed, but don't drop the inbox write.
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`atmux: warn: tell-lead: ping to ${lead.name} failed: ${reason}\n`);
  }

  process.stdout.write(`tell-lead → ${lead.name} (appended to ${driverInboxPath(atmuxDir)})\n`);
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
  const ts = formatMytFull();
  const entry = `- [${ts}] ${msg}\n`;
  // Bash appends to EOF (not newest-first under `## Open`); mirror.
  const next = existing.endsWith("\n") ? existing + entry : `${existing}\n${entry}`;
  await writeText(path, next);
}

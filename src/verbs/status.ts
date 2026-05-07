// ADR-010: CLI dispatcher — `status` verb (read-only).
// Bash spec: lib/status.sh @ worktree-frozen.
//
// `atmux status [--json]`
//
// Snapshot of:
//   - team name, session name, session up/down state
//   - per-member roster: role, tui, pane current-command, pending inbox count
//   - kanban counts (todo / in-progress / done / blocked)
//   - driver-inbox open-entry count (text mode only)
//
// All bash jq + tmux observations port to typed reads via core/* +
// abstractions/tmux. The verb is pure assembly + presentation.

import { exists } from "../abstractions/fs.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  inboxPathFor,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { loadInbox } from "../core/inbox.ts";
import { loadKanban } from "../core/kanban.ts";
import type { Team } from "../schema/team.ts";
import { UsageError } from "../errors.ts";
import { defaultSocketPath } from "./start.ts";
import { collectOpenEntries } from "./reply.ts";

const USAGE = "atmux status [--json]";

/** Parsed `status` argv. */
export interface StatusArgs {
  json: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. */
export function parseStatusArgs(argv: ReadonlyArray<string>): StatusArgs {
  let json = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "status: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "status: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `status: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: StatusArgs = { json };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Per-member status row built up by `gatherStatus`. */
export interface MemberStatus {
  name: string;
  role: string;
  tui: string;
  emoji?: string;
  paneCommand: string;
  pendingCount: number;
}

export interface KanbanCounts {
  todo: number;
  inProgress: number;
  done: number;
  blocked: number;
}

export interface StatusSnapshot {
  team: string;
  session: string;
  sessionState: "up" | "down";
  members: MemberStatus[];
  kanban: KanbanCounts;
  driverInboxOpen: number;
}

/**
 * Gather all status data into a structured snapshot. Pure (modulo
 * IO) — used by both text + json renderers + by tests asserting shape.
 */
export async function gatherStatus(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  atmuxDir: string,
): Promise<StatusSnapshot> {
  const sessionState: "up" | "down" = (await tmux.session.hasSession(`=${sessionName}`))
    ? "up"
    : "down";

  const members: MemberStatus[] = [];
  for (const m of team.members) {
    const paneCommand = await readPaneCommand(tmux, sessionName, m, sessionState === "up");
    const pendingCount = await readPendingCount(atmuxDir, m.name);
    const row: MemberStatus = {
      name: m.name,
      role: m.role ?? "member",
      tui: m.tui ?? "claude",
      paneCommand,
      pendingCount,
    };
    if (m.emoji !== undefined && m.emoji.length > 0) row.emoji = m.emoji;
    members.push(row);
  }

  const counts: KanbanCounts = { todo: 0, inProgress: 0, done: 0, blocked: 0 };
  if (await exists(kanbanJsonPath(atmuxDir))) {
    const k = await loadKanban(atmuxDir);
    for (const t of k.tasks) {
      if (t.status === "todo") counts.todo += 1;
      else if (t.status === "in-progress") counts.inProgress += 1;
      else if (t.status === "done") counts.done += 1;
      else if (t.status === "blocked") counts.blocked += 1;
    }
  }

  let driverInboxOpen = 0;
  const di = driverInboxPath(atmuxDir);
  if (await exists(di)) {
    const body = await Bun.file(di).text();
    driverInboxOpen = collectOpenEntries(body).length;
  }

  return {
    team: team.name,
    session: sessionName,
    sessionState,
    members,
    kanban: counts,
    driverInboxOpen,
  };
}

/** `atmux status [--json]`. Returns 0. */
export async function status(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseStatusArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const atmuxDir = await getAtmuxDir(dirOpts);
  const socketPath = parsed.socketPath ?? defaultSocketPath(team.name);
  const tmux = createTmux({ socketPath });
  const snap = await gatherStatus(tmux, team, sessionName, atmuxDir);

  if (parsed.json) {
    // Bash json shape (lib/status.sh:148-155): {team, session,
    // sessionState, members[], kanban}. We add `driverInboxOpen`
    // so the json caller can also see what the text view shows.
    const out = {
      team: snap.team,
      session: snap.session,
      sessionState: snap.sessionState,
      members: snap.members.map((m) => ({
        name: m.name,
        role: m.role,
        tui: m.tui,
        paneCommand: m.paneCommand,
        pendingCount: m.pendingCount,
      })),
      kanban: snap.kanban,
      driverInboxOpen: snap.driverInboxOpen,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  renderTextStatus(snap);
  return 0;
}

// ---------- Internals ----------

async function readPaneCommand(
  tmux: TmuxNamespace,
  sessionName: string,
  member: { name: string; emoji?: string | undefined },
  sessionUp: boolean,
): Promise<string> {
  if (!sessionUp) return "(down)";
  const winName =
    member.emoji !== undefined && member.emoji.length > 0
      ? `${member.emoji}${member.name}`
      : member.name;
  const target = `${sessionName}:${winName}`;
  try {
    // Bash lib/status.sh:55 reads `#{pane_current_command}` via
    // `tmux list-panes -F`; our listPanes wrapper doesn't surface
    // that field, so we go through displayMessage which renders
    // any tmux format string against a target.
    const cmd = await tmux.pane.displayMessage({
      target,
      format: "#{pane_current_command}",
      print: true,
    });
    const trimmed = cmd.replace(/\n+$/, "");
    return trimmed.length > 0 ? trimmed : "(down)";
  } catch {
    // expected: window may not exist (member declared in team.json
    // but never spawned). Bash falls back to "(down)" — mirror.
    return "(down)";
  }
}

async function readPendingCount(atmuxDir: string, member: string): Promise<number> {
  if (!(await exists(inboxPathFor(atmuxDir, member)))) return 0;
  const ib = await loadInbox(atmuxDir, member);
  return ib.pending.length;
}

function renderTextStatus(snap: StatusSnapshot): void {
  const sessEmoji = snap.sessionState === "up" ? "🟢" : "🔴";
  process.stdout.write(
    `${sessEmoji} 🧭 TEAM ${snap.team}  session=${snap.session} [${snap.sessionState}]\n\n`,
  );
  process.stdout.write(`member       role          tui        pane          inbox\n`);
  for (const m of snap.members) {
    const emoji = m.emoji ?? defaultRoleEmoji(m.role);
    const name = m.name.padEnd(12);
    const role = m.role.padEnd(14);
    const tui = m.tui.padEnd(10);
    const pane = m.paneCommand.padEnd(14);
    process.stdout.write(`  ${emoji} ${name} ${role} ${tui} ${pane} 📥 ${m.pendingCount} pending\n`);
  }
  const k = snap.kanban;
  process.stdout.write(
    `\n📋 kanban  📌 todo=${k.todo}  🟡 in-progress=${k.inProgress}  ✅ done=${k.done}  🛑 blocked=${k.blocked}\n`,
  );
  if (snap.driverInboxOpen > 0) {
    process.stdout.write(`📬 driver-inbox  open=${snap.driverInboxOpen}\n`);
  }
}

/** Default role emoji per bash lib/status.sh:69-77. */
export function defaultRoleEmoji(role: string): string {
  switch (role) {
    case "team-lead":
      return "🧭";
    case "planner":
      return "🗺️ ";
    case "reviewer":
      return "🔍";
    case "gitter":
      return "🌿";
    case "devops":
      return "⚙️ ";
    case "dba":
      return "🗄️ ";
    default:
      return "🐝";
  }
}

// ADR-010: CLI dispatcher — `status` verb (read-only).
//
// `atmux status [--json]`
//
// ADR-263 lean-harness scope: a basic pane/session overview only.
//   - team name, session name, session up/down state
//   - per-pane roster: tui + pane current-command
//   - kanban counts (todo / in-progress / done / blocked) — the optional
//     task feed; zero counts when no task store exists (ADR-263 §D6).
//
// The fleet-coordination columns (cadence / budget / self-status /
// refusal / merge / cockpit-medic / lead-uptime / driver-pane /
// heartbeat / needs-approval / driver-inbox) were removed per ADR-263
// §D1/§D4 — atmux is a tmux harness + an optional task feed, not a
// fleet brain.

import { join } from "node:path";

import { exists } from "../abstractions/fs.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  displayMemberName,
  getAtmuxDir,
  getSessionName,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { loadKanban } from "../core/kanban.ts";
import { UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

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

/** Per-pane status row built up by `gatherStatus`. */
export interface MemberStatus {
  name: string;
  role: string;
  tui: string;
  emoji?: string;
  /** ADR-136 TR4: mutable display label. When set + non-empty, the
   *  text rendering uses `label` in place of `name` for the operator-
   *  facing column. JSON consumers still get the immutable `name`
   *  field (the ID) as the primary key. */
  label?: string;
  /** `#{pane_current_command}` for the pane's window — or `(down)` when
   *  the session/window is absent. */
  paneCommand: string;
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
    const row: MemberStatus = {
      name: m.name,
      role: m.role ?? "member",
      tui: m.tui ?? "claude",
      paneCommand,
    };
    if (m.emoji !== undefined && m.emoji.length > 0) row.emoji = m.emoji;
    if (m.label !== undefined && m.label.length > 0) row.label = m.label;
    members.push(row);
  }

  // ADR-060 / ADR-263 §D6: the task feed is optional. Load counts when
  // EITHER the SQLite store or the legacy JSON file exists; otherwise
  // report zeros (a team with no task state is still a valid team).
  const counts: KanbanCounts = { todo: 0, inProgress: 0, done: 0, blocked: 0 };
  const hasSqlite = await exists(join(atmuxDir, "state.db"));
  const hasJson = await exists(kanbanJsonPath(atmuxDir));
  if (hasSqlite || hasJson) {
    const k = await loadKanban(atmuxDir);
    for (const t of k.tasks) {
      if (t.status === "todo") counts.todo += 1;
      else if (t.status === "in-progress") counts.inProgress += 1;
      else if (t.status === "done") counts.done += 1;
      else if (t.status === "blocked") counts.blocked += 1;
    }
  }

  return {
    team: team.name,
    session: sessionName,
    sessionState,
    members,
    kanban: counts,
  };
}

/** `atmux status [--json]`. Returns 0. */
export async function status(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseStatusArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const atmuxDir = await getAtmuxDir(dirOpts);
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = createTmux({ socketPath });
  const snap = await gatherStatus(tmux, team, sessionName, atmuxDir);

  if (parsed.json) {
    const out = {
      team: snap.team,
      session: snap.session,
      sessionState: snap.sessionState,
      members: snap.members.map((m) => {
        // ADR-136 TR4: surface `label` as an optional sibling key
        // alongside the canonical `name`. JSON consumers gating on
        // `name` (the immutable ID) keep working; renderers that want
        // the operator-facing display string read `label ?? name`.
        const row: {
          name: string;
          role: string;
          tui: string;
          paneCommand: string;
          label?: string;
        } = {
          name: m.name,
          role: m.role,
          tui: m.tui,
          paneCommand: m.paneCommand,
        };
        if (m.label !== undefined && m.label.length > 0) row.label = m.label;
        return row;
      }),
      kanban: snap.kanban,
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
  member: {
    name: string;
    emoji?: string | undefined;
    label?: string | undefined;
    role?: string | undefined;
  },
  sessionUp: boolean,
): Promise<string> {
  if (!sessionUp) return "(down)";
  // ADR-135 + ADR-136 TR4: canonical hyphen-separator window name with
  // label-fallback when the member has been hot-renamed.
  const winName = buildWindowName(member.name, member.emoji, member.label, member.role);
  const target = `${sessionName}:${winName}`;
  try {
    const cmd = await tmux.pane.displayMessage({
      target,
      format: "#{pane_current_command}",
      print: true,
    });
    const trimmed = cmd.replace(/\n+$/, "");
    return trimmed.length > 0 ? trimmed : "(down)";
  } catch {
    // expected: window may not exist (pane declared in team.json but
    // never spawned). Fall back to "(down)".
    return "(down)";
  }
}

function renderTextStatus(snap: StatusSnapshot): void {
  const sessEmoji = snap.sessionState === "up" ? "🟢" : "🔴";
  process.stdout.write(
    `${sessEmoji} 🧭 TEAM ${snap.team}  session=${snap.session} [${snap.sessionState}]\n\n`,
  );
  process.stdout.write(`pane         role          tui        pane-state\n`);
  for (const m of snap.members) {
    const emoji = m.emoji ?? defaultRoleEmoji(m.role);
    // ADR-136 TR4: operator-facing text column uses label-fallback.
    const name = displayMemberName(m).padEnd(12);
    const role = m.role.padEnd(14);
    const tui = m.tui.padEnd(10);
    const paneState = m.paneCommand.padEnd(14);
    process.stdout.write(`  ${emoji} ${name} ${role} ${tui} ${paneState}\n`);
  }
  const k = snap.kanban;
  process.stdout.write(
    `\n📋 kanban  📌 todo=${k.todo}  🟡 in-progress=${k.inProgress}  ✅ done=${k.done}  🛑 blocked=${k.blocked}\n`,
  );
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
    case "committer":
    case "gitter": // ADR-159 TR3 legacy alias (grace cycle)
      return "🌿";
    case "devops":
      return "⚙️ ";
    case "dba":
      return "🗄️ ";
    default:
      return "🐝";
  }
}

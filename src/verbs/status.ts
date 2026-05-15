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

import { join } from "node:path";

import { exists } from "../abstractions/fs.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import { type LoadCockpitOpts, loadCockpit } from "../core/cockpit.ts";
import {
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { type DriverPaneHealth, probeDriverPane } from "../core/driver-pane-health.ts";
import { loadInbox } from "../core/inbox.ts";
import { loadKanban } from "../core/kanban.ts";
import { UsageError } from "../errors.ts";
import { type NeedsApprovalReport, scanNeedsApproval } from "../lib/needs-approval.ts";
import type { Team } from "../schema/team.ts";
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
  /** Tasks owned by this member with status='todo'. Pre-ADR-076 this
   *  came from the JSON inbox `pending` bucket; post-cutover it's a
   *  direct query against the tasks table via `loadInbox`. Surfaced in
   *  text + JSON output. */
  pendingCount: number;
  /** Tasks owned by this member with status='in-progress'. Added 2026-
   *  05-08 alongside the pendingCount-from-SQL fix — the more
   *  operationally useful number ("what's this member currently
   *  working on?"). */
  inProgressCount: number;
}

export interface KanbanCounts {
  todo: number;
  inProgress: number;
  done: number;
  blocked: number;
}

/** ADR-077 §F5 / ADR-133: cockpit medic presence/health snapshot
 *  (formerly named `SuperdoctorState`; renamed per ADR-133, alias
 *  preserved below). Surfaced in `atmux status` so the operator can
 *  verify a `cockpit rebuild` actually took effect. */
export interface MedicState {
  /** True iff `~/.atmux/cockpit.json` exists AND has a `medic` block
   *  (or the deprecated `superdoctor` block, which the loader coerces
   *  to medic semantics per ADR-133 §D2). False when no cockpit is
   *  configured at all (silent — most per-team status calls won't
   *  have one). */
  configured: boolean;
  /** True iff `medic.enabled === true` (or legacy `superdoctor.enabled`)
   *  in cockpit.json. */
  enabled: boolean;
  /** True iff the cockpit tmux session exists on the operator's
   *  default socket. Probed only when `enabled === true`. */
  sessionAlive: boolean;
  /** True iff a window named `medic` (canonical) OR `superdoctor`
   *  (deprecated alias accepted during the rename window) exists in
   *  the cockpit session. Probed only when `sessionAlive === true`. */
  windowAlive: boolean;
}

/** @deprecated ADR-133 — use {@link MedicState}. Kept as a type alias
 *  for importers during the one-release-cycle deprecation window. */
export type SuperdoctorState = MedicState;

export interface StatusSnapshot {
  team: string;
  session: string;
  sessionState: "up" | "down";
  members: MemberStatus[];
  kanban: KanbanCounts;
  driverInboxOpen: number;
  /** ADR-064 §4: driver-pane health snapshot. Always populated;
   *  renderer skips display when `configured=false`. */
  driverPane: DriverPaneHealth;
  /** ADR-077 §F5 / ADR-133: cockpit medic snapshot. Always populated;
   *  renderer skips display when `configured=false`. The deprecated
   *  `superdoctor` field below mirrors this same data during the
   *  rename window — both keys appear in `--json` output. */
  medic: MedicState;
  /** @deprecated ADR-133 — mirror of {@link StatusSnapshot.medic}.
   *  Retained for one release cycle so JSON consumers reading
   *  `snap.superdoctor` (per ADR-077 §F5) continue working
   *  unchanged. Removed once the deprecation window closes. */
  superdoctor: MedicState;
  /** ADR-085 §Three surfaces #1: approval-debt scan across ADRs +
   *  driver-inbox + blocked kanban. Live per ADR-068 §HC#4 — no cache;
   *  re-run every `gatherStatus` invocation. */
  needsApproval: NeedsApprovalReport;
}

/** Test-injection seam for `gatherStatus` cockpit probe. */
export interface GatherStatusDeps {
  /** Override cockpit.json loader env. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Build the cockpit-side TmuxNamespace (operator's default socket).
   *  Default `createTmux({ socket: 'default' })`. */
  cockpitTmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
}

/**
 * ADR-077 §F5 / ADR-133: probe the cockpit for medic presence/health.
 * Silently returns the all-false default when no cockpit is configured
 * (most per-team status calls have no cockpit). Probe failures collapse
 * to `false` rather than throwing — the team's own status must stay
 * green even when the cockpit is misconfigured.
 *
 * Reads `cockpit.medic` first (canonical per ADR-133 — the loader
 * always populates this when either `medic` or legacy `superdoctor`
 * block is present). The window-alive probe accepts BOTH the
 * canonical `medic` window name AND the legacy `superdoctor` name so
 * a cockpit that hasn't yet been rebuilt after the rename still
 * surfaces as healthy.
 */
export async function probeMedic(deps: GatherStatusDeps = {}): Promise<MedicState> {
  const env = deps.env ?? process.env;
  const loadOpts: LoadCockpitOpts = { env };
  let cockpit: Awaited<ReturnType<typeof loadCockpit>>;
  try {
    cockpit = await loadCockpit(loadOpts);
  } catch {
    return { configured: false, enabled: false, sessionAlive: false, windowAlive: false };
  }
  const m = cockpit.medic ?? cockpit.superdoctor;
  if (m === undefined) {
    return { configured: false, enabled: false, sessionAlive: false, windowAlive: false };
  }
  if (!m.enabled) {
    return { configured: true, enabled: false, sessionAlive: false, windowAlive: false };
  }
  const factory = deps.cockpitTmuxFactory ?? createTmux;
  let sessionAlive = false;
  let windowAlive = false;
  try {
    const cockpitTmux = factory({ socket: "default" });
    sessionAlive = await cockpitTmux.session.hasSession(cockpit.cockpitSession);
    if (sessionAlive) {
      const wins = await cockpitTmux.window.listWindows(cockpit.cockpitSession);
      // ADR-135 canonical window name `_medic`; legacy `medic` and pre-ADR-133
      // `superdoctor` accepted during the deprecation window.
      windowAlive = wins.some(
        (w) => w.name === "_medic" || w.name === "medic" || w.name === "superdoctor",
      );
    }
  } catch {
    // tmux not running, socket unreachable, etc. — collapse to down.
  }
  return { configured: true, enabled: true, sessionAlive, windowAlive };
}

/** @deprecated ADR-133 — use {@link probeMedic}. Thin wrapper retained
 *  for the deprecation window so callers reaching for the legacy
 *  symbol keep working unchanged. */
export const probeSuperdoctor = probeMedic;

/**
 * Gather all status data into a structured snapshot. Pure (modulo
 * IO) — used by both text + json renderers + by tests asserting shape.
 */
export async function gatherStatus(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  atmuxDir: string,
  deps: GatherStatusDeps = {},
): Promise<StatusSnapshot> {
  const sessionState: "up" | "down" = (await tmux.session.hasSession(`=${sessionName}`))
    ? "up"
    : "down";

  const members: MemberStatus[] = [];
  for (const m of team.members) {
    const paneCommand = await readPaneCommand(tmux, sessionName, m, sessionState === "up");
    const { pending: pendingCount, inProgress: inProgressCount } = await readMemberCounts(
      atmuxDir,
      m.name,
    );
    const row: MemberStatus = {
      name: m.name,
      role: m.role ?? "member",
      tui: m.tui ?? "claude",
      paneCommand,
      pendingCount,
      inProgressCount,
    };
    if (m.emoji !== undefined && m.emoji.length > 0) row.emoji = m.emoji;
    members.push(row);
  }

  const counts: KanbanCounts = { todo: 0, inProgress: 0, done: 0, blocked: 0 };
  // ADR-060 dual-path: load if EITHER the SQLite store or the legacy
  // JSON file exists. Pre-fix this gate only checked kanban.json, so
  // post-migration teams (state.db only) reported counts=0.
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

  let driverInboxOpen = 0;
  const di = driverInboxPath(atmuxDir);
  if (await exists(di)) {
    const body = await Bun.file(di).text();
    driverInboxOpen = collectOpenEntries(body).length;
  }

  // ADR-064 §4: driver-pane health probe. Reuses the same tmux
  // namespace already in scope so we don't pay a second connection
  // setup; the helper itself stays I/O-bounded to one capture call.
  const driverPane = await probeDriverPane(team, atmuxDir, { tmux });

  // ADR-077 §F5 / ADR-133: cockpit medic probe. Independent of the
  // team's own cage tmux — uses the operator's default socket via a
  // separate factory. Silent when no cockpit is configured.
  const medic = await probeMedic(deps);

  // ADR-085 §Three surfaces #1: live approval-debt scan. Per-bucket
  // failure isolation lives inside `scanNeedsApproval` — a corrupt
  // ADR / missing inbox / kanban absence degrades to an empty bucket
  // rather than failing the whole status snapshot.
  const needsApproval = await scanNeedsApproval();

  return {
    team: team.name,
    session: sessionName,
    sessionState,
    members,
    kanban: counts,
    driverInboxOpen,
    driverPane,
    medic,
    // ADR-133 deprecation alias — same data, retained for one cycle
    // so JSON consumers reading `snap.superdoctor` keep working.
    superdoctor: medic,
    needsApproval,
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
        inProgressCount: m.inProgressCount,
      })),
      kanban: snap.kanban,
      driverInboxOpen: snap.driverInboxOpen,
      driverPane: snap.driverPane,
      // ADR-133: emit BOTH `medic` (canonical) AND `superdoctor`
      // (deprecated alias, same data) during the rename window so JSON
      // consumers continue working. `superdoctor` drops next release.
      medic: snap.medic,
      superdoctor: snap.superdoctor,
      needsApproval: snap.needsApproval,
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

/** ADR-076 cutover: counts come from `loadInbox` which is SQL-canonical
 *  when state.db exists (falls back to JSON for pre-migration teams).
 *  Drops the pre-cutover JSON-existence guard which incorrectly returned
 *  0 for SQL-canonical teams whose inbox JSON files were absent or
 *  frozen post-writer-no-op. Returns both pending (todo) and in-progress
 *  counts for the per-member status row. */
async function readMemberCounts(
  atmuxDir: string,
  member: string,
): Promise<{ pending: number; inProgress: number }> {
  const ib = await loadInbox(atmuxDir, member);
  return { pending: ib.pending.length, inProgress: ib.inProgress.length };
}

function renderTextStatus(snap: StatusSnapshot): void {
  const sessEmoji = snap.sessionState === "up" ? "🟢" : "🔴";
  process.stdout.write(
    `${sessEmoji} 🧭 TEAM ${snap.team}  session=${snap.session} [${snap.sessionState}]\n\n`,
  );
  // ADR-064 §4: driver-pane row above the per-member table — only when
  // the team opted into the ADR-044 driver-window topology. Mirrors the
  // existing `driver-inbox open=N` skip-when-empty pattern below.
  if (snap.driverPane.configured) {
    const dp = snap.driverPane;
    const stateLabel = dp.windowExists ? (dp.state ?? "UNKNOWN") : "no-window";
    const evidence = dp.evidence.length > 60 ? `${dp.evidence.slice(0, 60)}…` : dp.evidence;
    process.stdout.write(`🚗 driver  configured=y  state=${stateLabel}  evidence=${evidence}\n\n`);
  }
  process.stdout.write(`member       role          tui        pane          tasks\n`);
  for (const m of snap.members) {
    const emoji = m.emoji ?? defaultRoleEmoji(m.role);
    const name = m.name.padEnd(12);
    const role = m.role.padEnd(14);
    const tui = m.tui.padEnd(10);
    const pane = m.paneCommand.padEnd(14);
    process.stdout.write(
      `  ${emoji} ${name} ${role} ${tui} ${pane} 🟡 ${m.inProgressCount} active  📌 ${m.pendingCount} todo\n`,
    );
  }
  const k = snap.kanban;
  process.stdout.write(
    `\n📋 kanban  📌 todo=${k.todo}  🟡 in-progress=${k.inProgress}  ✅ done=${k.done}  🛑 blocked=${k.blocked}\n`,
  );
  // ADR-085 §Three surfaces #1: approval-debt row. Positive-state when
  // total=0 so the operator sees the green even on a clean run — same
  // grammar as the driver-pane / medic rows below.
  const na = snap.needsApproval;
  if (na.total === 0) {
    process.stdout.write(`📝 NEEDS APPROVAL: ✅ clear\n`);
  } else {
    process.stdout.write(
      `📝 NEEDS APPROVAL: ${na.adr.length} ADRs / ${na.inbox.length} inbox / ${na.kanban.length} kanban\n`,
    );
  }
  if (snap.driverInboxOpen > 0) {
    process.stdout.write(`📬 driver-inbox  open=${snap.driverInboxOpen}\n`);
  }
  // ADR-077 §F5 / ADR-133: medic row — skip when no cockpit at all.
  if (snap.medic.configured) {
    const md = snap.medic;
    const stateLabel = !md.enabled
      ? "disabled"
      : !md.sessionAlive
        ? "cockpit-down"
        : !md.windowAlive
          ? "window-missing"
          : "alive";
    const stateEmoji = stateLabel === "alive" ? "🟢" : stateLabel === "disabled" ? "⚪" : "🔴";
    process.stdout.write(`📋 medic  ${stateEmoji} ${stateLabel}\n`);
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

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

import { exists, readTextOrNull } from "../abstractions/fs.ts";
import { spawn as runSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  type CadenceObservation,
  type CadenceThresholds,
  classifyCadence,
  defaultGitLog,
} from "../core/cadence-classifier.ts";
import { type CageHealth, type CageState, probeCageState } from "../core/cage-state.ts";
import { type LoadCockpitOpts, loadCockpit } from "../core/cockpit.ts";
import {
  buildWindowName,
  displayMemberName,
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { type DriverPaneHealth, probeDriverPane } from "../core/driver-pane-health.ts";
import { DEFAULT_HEARTBEAT_STALE_SEC, readHeartbeatAges } from "../core/heartbeat.ts";
import { loadInbox } from "../core/inbox.ts";
import { readLeadSessionStart, readLeadWindowName } from "../core/lead-marker.ts";
import { loadKanban } from "../core/kanban.ts";
import { getAtmuxTmuxConfPath, getCockpitSocketName } from "../core/tmux-paths.ts";
import { UsageError } from "../errors.ts";
import { type NeedsApprovalReport, scanNeedsApproval } from "../lib/needs-approval.ts";
import {
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_CADENCE_THRESHOLDS,
  type Team,
} from "../schema/team.ts";
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
  /** ADR-136 TR4: mutable display label. When set + non-empty, the
   *  text rendering uses `label` in place of `name` for the operator-
   *  facing column. JSON consumers still get the immutable `name`
   *  field (the ID) as the primary key. */
  label?: string;
  paneCommand: string;
  /** t-74273200 / c-8ecd3a61: canonical 4-state cage taxonomy. Shared
   *  with `atmux doctor` (`MemberCageState` is an alias). When the
   *  member's `tui !== "claude"`, this is `null` — the cage-state
   *  probe is claude-specific (it checks for `claude` exec in the
   *  pane's child tree); non-claude TUIs are read via the legacy
   *  `paneCommand` field above. */
  cageState: CageState | null;
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
  /** Per-task t-d98b2bd6 (member context-pressure rotation): structured
   *  context-token usage signal written by the whip-side
   *  `measure-context.sh` script at every idle-hook fire to
   *  `${HOME}/.claude/teams/${TEAM}/member-context/${MEMBER}.json`.
   *
   *  When the JSON file exists + is fresh (`ts` within 2× whip cadence),
   *  fields are populated and the renderer surfaces the percentage in
   *  the `ctx %` column. Absent file → all three undefined; renderer
   *  shows `—` to indicate "no signal yet" (member's idle-hook hasn't
   *  fired, or the rollout hasn't reached this team yet). Stale file
   *  (ts older than 2× whip cadence) → `contextStale: true` so the
   *  renderer can flag it distinct from "fresh, ≥threshold" rotation
   *  candidates. */
  contextPct?: number;
  /** Epoch seconds when the member-context JSON was last written by
   *  measure-context.sh. */
  contextTs?: number;
  /** True iff the on-disk signal is older than 2× the whip cadence
   *  (default ~9 min on 270s cadence). Renderer distinguishes "stale
   *  signal — member idle-hook isn't firing" from "fresh-but-low" so
   *  the operator can spot crashed claude processes vs healthy
   *  low-context members. */
  contextStale?: boolean;
  /** ADR-148 §D2/§D3: commit-cadence verdict for this member's
   *  worktree. Computed from `git -C <worktreePath> log --since=
   *  <windowSec>s --author=<member>`. Surfaced in both text + JSON
   *  output. Null when the member has no resolvable worktree path
   *  (cwd missing in team.json AND no per-member worktree under
   *  team.worktreeRoot — defensive; the gather call skips silently). */
  cadence?: CadenceObservation;
  /** ADR-057 §D6c (folds P3 atmux-status-cache-lies): per-member
   *  heartbeat age in seconds, sourced from
   *  `<atmuxDir>/heartbeats/<member>.epoch` via readHeartbeatAges.
   *  null when the heartbeat file is absent or unparseable; integer
   *  seconds otherwise. Live-no-cache mirror per ADR-068 §HC#4 — every
   *  gatherStatus call re-reads. The producer (t-7e291a53) writes this
   *  from the cron-mediated poke tick per-member loop. */
  heartbeat_age_s: number | null;
}

/** ADR-148 §D2: cadence-classifier output for one member. T5
 *  (t-ac95b267) lifted the canonical declaration into
 *  `src/core/cadence-classifier.ts`; this re-export preserves every
 *  pre-T5 importer of `import { CadenceObservation } from
 *  ".../verbs/status"`. The shape is the durable contract — T5
 *  refactored location, not fields. */
export type { CadenceObservation } from "../core/cadence-classifier.ts";

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

/** ADR-077 §lead-uptime-measurement (t-6d950ffd / preventive for
 *  superdoctor complaint c-06dabd47): explicit-naming snapshot for
 *  the lead-window uptime question. Two distinct numbers, two
 *  distinct sources — observers conflating them have rotated leads
 *  prematurely (the original incident).
 *
 *  - `lead_session_uptime_s` reads `~/.claude/teams/<team>/lead-
 *    session-start.txt` (refreshed by `/clear` AND `atmux rotate-
 *    lead`). This is the canonical "how long since the lead's
 *    current context window started?" — the source of truth for
 *    the ADR-009 rotation gate.
 *  - `shell_pid_etime_s` reads `ps -o etime= -p <leadPanePid>` —
 *    the lead pane's SHELL process etime. The shell typically
 *    long-outlives any one Claude session; `/clear` resets the
 *    session-start marker without exiting the parent shell.
 *
 *  Rotation gate reads `lead_session_uptime_s`. The shell etime is
 *  exposed for diagnostic transparency ONLY — it must NEVER drive
 *  rotation decisions. */
export interface LeadUptimeSnapshot {
  /** True iff the team has a member with `role === "team-lead"`. */
  configured: boolean;
  /** Lead member's immutable id (the `name` field) — null when no
   *  team-lead role is set. Display callers should fall back to
   *  the rendering layer's label resolution. */
  leadMember: string | null;
  /** Epoch seconds when the lead's CURRENT session started (most
   *  recent `/clear` OR `atmux rotate-lead`). Null when the marker
   *  file is absent (lead never bootstrapped, or first tick of a
   *  fresh team). */
  leadSessionStartedAt: number | null;
  /** Seconds since `leadSessionStartedAt`. Null when marker is
   *  absent. This is the rotation-gate source per ADR-077 §lead-
   *  uptime-measurement. */
  lead_session_uptime_s: number | null;
  /** OS PID of the lead window's pane (`#{pane_pid}` via tmux
   *  list-panes). Null when session is down, lead window is
   *  missing, or the list-panes call failed. */
  leadPanePid: number | null;
  /** Seconds the lead pane's SHELL process has been running per
   *  `ps -o etime`. Typically much higher than
   *  `lead_session_uptime_s` because `/clear` resets the session-
   *  start marker but does NOT restart the shell. Surface this
   *  for diagnostic transparency; NEVER drive rotation decisions
   *  from this value (per ADR-077 §lead-uptime-measurement). */
  shell_pid_etime_s: number | null;
}

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
  /** ADR-077 §lead-uptime-measurement (t-6d950ffd): explicit-naming
   *  lead uptime snapshot — see {@link LeadUptimeSnapshot}. Always
   *  populated (`configured: false` for teams without a team-lead
   *  role); renderer skips display when `configured=false`. */
  lead: LeadUptimeSnapshot;
}

/** Test-injection seam for `gatherStatus` cockpit probe. */
export interface GatherStatusDeps {
  /** Override cockpit.json loader env. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Build the cockpit-side TmuxNamespace (operator's default socket).
   *  Default `createTmux({ socket: 'default' })`. */
  cockpitTmuxFactory?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Per-task t-d98b2bd6: override `$HOME` for resolving the member-
   *  context JSON path. Default reads `env.HOME`. */
  home?: string;
  /** Per-task t-d98b2bd6: clock override for the staleness check.
   *  Default `Date.now()` (epoch ms). */
  now?: () => number;
  /** Per-task t-d98b2bd6: whip cadence (seconds) used to compute the
   *  staleness window (2× this value). Default 270s — matches
   *  whip-prompt.md §1b. */
  whipCadenceSec?: number;
  /** ADR-148 T2: injection seam for the per-member git log probe.
   *  Default shells `git -C <worktreePath> log --since=<since>s
   *  --author=<author> --format=%H %ct`. Tests pin to deterministic
   *  output without touching disk. Returns the raw stdout lines
   *  (`"<sha> <epoch-sec>"` per line). */
  gitLog?: (
    worktreePath: string,
    sinceSec: number,
    author: string,
  ) => Promise<string[]>;
  /** ADR-077 §lead-uptime-measurement (t-6d950ffd) injection seam:
   *  given a process PID, return its elapsed-time-since-start in
   *  seconds. Default shells `ps -o etime= -p <pid>` and parses
   *  the `[[DD-]HH:]MM:SS` format. Returns null when the PID is
   *  not running OR the ps call fails. */
  psEtime?: (pid: number) => Promise<number | null>;
}

/** Per-task t-d98b2bd6 (whip-side signal shape). Mirrors the on-disk
 *  JSON written by `measure-context.sh`. Only the fields atmux status
 *  surfaces today; the script writes additional fields (`input_kt`,
 *  `output_kt`, `window_kt`, `in_flight_task`) that the lead reads
 *  directly but atmux status does not display in v1. */
interface MemberContextSignal {
  member: string;
  ts: number;
  context_pct: number;
}

/** Per-task t-d98b2bd6: read the member-context signal written by the
 *  whip-side `measure-context.sh` script. Returns `null` when the
 *  file is absent (rollout hasn't reached this team yet, or the
 *  member's idle-hook hasn't fired even once), undefined fields when
 *  JSON parse fails (corrupt write — silent recovery, not a hard
 *  error since the signal is best-effort). Pure read; no caching. */
export async function readMemberContextSignal(
  homeDir: string,
  team: string,
  member: string,
): Promise<MemberContextSignal | null> {
  const path = join(homeDir, ".claude", "teams", team, "member-context", `${member}.json`);
  const text = await readTextOrNull(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<MemberContextSignal>;
    if (typeof parsed.member !== "string") return null;
    if (typeof parsed.ts !== "number") return null;
    if (typeof parsed.context_pct !== "number") return null;
    return { member: parsed.member, ts: parsed.ts, context_pct: parsed.context_pct };
  } catch {
    // Corrupt write — best-effort; next idle-hook fire overwrites.
    return null;
  }
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
    // ADR-162 §Decision-anchor #1: cockpit lives on its dedicated
    // socket (`atmux-cockpit` by default; `ATMUX_COCKPIT_SOCKET` legacy
    // escape hatch). Probing the wrong socket reports a healthy cockpit
    // as `down` post-migration. §Decision-anchor #2: canonical
    // atmux.conf via `-f` keeps the probe consistent with the cockpit's
    // owning factory in cockpit.ts.
    const cockpitTmux = factory({
      socket: getCockpitSocketName(),
      configFile: getAtmuxTmuxConfPath(),
    });
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

/** ADR-077 §lead-uptime-measurement (t-6d950ffd): parse the
 *  `[[DD-]HH:]MM:SS` etime format that `ps -o etime=` emits into
 *  seconds. Examples:
 *
 *    "12:34"      → 12*60 + 34 = 754s
 *    "02:30:45"   → 2*3600 + 30*60 + 45 = 9045s
 *    "1-12:30:45" → 1*86400 + 9045 = 95445s
 *
 *  Returns null when the string doesn't match the expected shape
 *  (defensive — ps output drifts across BSD vs GNU; the canonical
 *  format above is consistent on Linux + macOS). */
export function parsePsEtime(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Match optional days, optional hours, mandatory mm:ss.
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(trimmed);
  if (m === null) return null;
  const days = m[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
  const hours = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
  const mins = Number.parseInt(m[3] ?? "0", 10);
  const secs = Number.parseInt(m[4] ?? "0", 10);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

/** Default `psEtime` impl — shells `ps -o etime= -p <pid>` and
 *  parses the output. Fail-soft: any non-zero exit / parse failure
 *  returns null so the LeadUptimeSnapshot degrades gracefully. */
async function defaultPsEtime(pid: number): Promise<number | null> {
  try {
    const r: SpawnResult = await runSpawn({
      cmd: "ps",
      argv: ["-o", "etime=", "-p", String(pid)],
      expectExitCode: "any",
      timeoutMs: 3000,
    });
    if (r.exitCode !== 0) return null;
    return parsePsEtime(r.stdout);
  } catch {
    return null;
  }
}

/** ADR-077 §lead-uptime-measurement (t-6d950ffd): build the lead
 *  uptime snapshot. Two source-fields with deliberately distinct
 *  names — `lead_session_uptime_s` (the rotation-gate source) and
 *  `shell_pid_etime_s` (diagnostic-only). Every failure mode
 *  degrades to null rather than throwing — partial snapshots are
 *  better than no status output. */
export async function probeLeadUptime(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  sessionUp: boolean,
  deps: {
    home?: string;
    now?: () => number;
    psEtime?: (pid: number) => Promise<number | null>;
  } = {},
): Promise<LeadUptimeSnapshot> {
  const leadMemberObj = team.members.find((m) => m.role === "team-lead");
  if (leadMemberObj === undefined) {
    return {
      configured: false,
      leadMember: null,
      leadSessionStartedAt: null,
      lead_session_uptime_s: null,
      leadPanePid: null,
      shell_pid_etime_s: null,
    };
  }

  // Resolve lead-window name with the same fallback whip uses (post-
  // ADR-082 buildWindowName, then legacy `__<team>__team-lead`).
  const memberWin = buildWindowName(
    leadMemberObj.name,
    leadMemberObj.emoji,
    leadMemberObj.label,
    leadMemberObj.role,
  );
  const homeOpts: { home?: string; fallback?: string } = { fallback: memberWin };
  if (deps.home !== undefined) homeOpts.home = deps.home;
  const leadWin = await readLeadWindowName(team.name, homeOpts);

  // I-1 marker read — the canonical rotation-gate source.
  const readOpts: { home?: string } = {};
  if (deps.home !== undefined) readOpts.home = deps.home;
  const startedAt = await readLeadSessionStart(team.name, readOpts);
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  const leadSessionUptime =
    startedAt === null ? null : Math.max(0, nowSec - startedAt);

  // Shell PID + etime — diagnostic-only.
  let leadPanePid: number | null = null;
  let shellEtime: number | null = null;
  if (sessionUp) {
    const target = `${sessionName}:${leadWin}`;
    try {
      const panes = await tmux.pane.listPanes(target);
      // listPanes returns [] when window missing; the first pane in
      // the window is the lead's pane (single-pane windows are the
      // norm).
      const firstPane = panes[0];
      if (firstPane !== undefined && firstPane.pid > 0) {
        leadPanePid = firstPane.pid;
        const psEtime = deps.psEtime ?? defaultPsEtime;
        shellEtime = await psEtime(firstPane.pid);
      }
    } catch {
      // Transient tmux error — leave the pane fields null.
    }
  }

  return {
    configured: true,
    leadMember: leadMemberObj.name,
    leadSessionStartedAt: startedAt,
    lead_session_uptime_s: leadSessionUptime,
    leadPanePid,
    shell_pid_etime_s: shellEtime,
  };
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
  deps: GatherStatusDeps = {},
): Promise<StatusSnapshot> {
  const sessionState: "up" | "down" = (await tmux.session.hasSession(`=${sessionName}`))
    ? "up"
    : "down";

  // Per-task t-d98b2bd6: resolve the home + clock + cadence used by the
  // member-context signal read. Test injection threads through `deps`.
  const env = deps.env ?? process.env;
  const homeDir = deps.home ?? env.HOME ?? "";
  const nowMs = (deps.now ?? Date.now)();
  const whipCadenceSec = deps.whipCadenceSec ?? 270;
  const staleAfterMs = whipCadenceSec * 2 * 1000;
  const nowSec = Math.floor(nowMs / 1000);
  // ADR-148 T2: resolve cadence config (defaults applied when team.json
  // block absent). Probe runs per-member below; `enabled === false`
  // skips the probe entirely + leaves `row.cadence` undefined so the
  // renderer falls back to "—".
  const cadenceCfg = resolveCadenceConfig(team);
  const gitLog = deps.gitLog ?? defaultGitLog;
  const exemptSet = new Set(cadenceCfg.exemptMembers);

  const members: MemberStatus[] = [];
  for (const m of team.members) {
    const paneCommand = await readPaneCommand(tmux, sessionName, m, sessionState === "up");
    // t-74273200 / c-8ecd3a61: cage-state probe for claude TUI members
    // — replaces the pane_current_command proxy which mis-reported
    // welcome-screen claude TUIs as `(down)`. Non-claude TUIs skip the
    // probe (cage taxonomy is claude-specific) and surface state=null.
    let cageState: CageState | null = null;
    if (sessionState === "up" && (m.tui ?? "claude") === "claude") {
      try {
        const health: CageHealth = await probeCageState(team, m, atmuxDir, { tmux });
        cageState = health.state;
      } catch {
        // Probe failure → leave cageState null; the legacy paneCommand
        // proxy still gives the operator something to look at.
        cageState = null;
      }
    } else if (sessionState === "down") {
      cageState = "down";
    }
    const { pending: pendingCount, inProgress: inProgressCount } = await readMemberCounts(
      atmuxDir,
      m.name,
    );
    const row: MemberStatus = {
      name: m.name,
      role: m.role ?? "member",
      tui: m.tui ?? "claude",
      paneCommand,
      cageState,
      pendingCount,
      inProgressCount,
      // ADR-057 §D6c: populated post-loop via a single readHeartbeatAges
      // batch — kept in the row's initializer (vs delete + reassign) so
      // the strict-mode TS contract on MemberStatus.heartbeat_age_s is
      // satisfied at construction.
      heartbeat_age_s: null,
    };
    if (m.emoji !== undefined && m.emoji.length > 0) row.emoji = m.emoji;
    if (m.label !== undefined && m.label.length > 0) row.label = m.label;
    // Per-task t-d98b2bd6: read the whip-side context signal when home
    // is resolvable. Skip silently when $HOME is unset (atmux running
    // under an unusual env — the row just shows no ctx data).
    if (homeDir.length > 0) {
      const signal = await readMemberContextSignal(homeDir, team.name, m.name);
      if (signal !== null) {
        row.contextPct = signal.context_pct;
        row.contextTs = signal.ts;
        const signalAgeMs = nowMs - signal.ts * 1000;
        row.contextStale = signalAgeMs > staleAfterMs;
      }
    }
    // ADR-148 T2: commit-cadence probe per member. Honors per-team
    // `cadence.enabled` (default true) + per-member exemptMembers. The
    // gitLog probe is fail-soft (returns [] on any error) so a missing
    // worktree degrades to "no commits ever" rather than aborting the
    // whole status snapshot.
    if (cadenceCfg.enabled) {
      if (exemptSet.has(m.name)) {
        row.cadence = {
          windowSec: cadenceCfg.windowSec,
          commitsInWindow: 0,
          lastCommitAt: null,
          lastCommitSha: null,
          ageOfLastCommitSec: null,
          verdict: "exempt",
        };
      } else {
        const wt = resolveMemberWorktree(team, m, atmuxDir);
        if (wt !== null) {
          // `--since=<sinceSec>` queries a wider window than the
          // verdict's `windowSec` so the classifier sees the actual
          // last commit too (used for `ageOfLastCommitSec`). Cap at
          // the dormant threshold — any commit older than that is
          // "dormant" regardless, so reading further back wastes
          // git log time without affecting the verdict.
          const sinceSec = Math.max(
            cadenceCfg.windowSec,
            cadenceCfg.thresholds.dormantMaxAgeSec,
          );
          const lines = await gitLog(wt, sinceSec, m.name);
          row.cadence = classifyCadence(
            lines,
            nowSec,
            cadenceCfg.windowSec,
            cadenceCfg.thresholds,
          );
        }
      }
    }
    members.push(row);
  }

  // ADR-057 §D6c (folds P3 atmux-status-cache-lies): batch-read per-
  // member heartbeat ages so `atmux status` is the single observability
  // surface for liveness. Read-through (no cache) per ADR-068 §HC#4.
  // ageSec === null when the heartbeat file is absent / unparseable —
  // mirror semantics of readHeartbeatAges into MemberStatus directly.
  const memberNames = members.map((r) => r.name);
  const ages = await readHeartbeatAges(atmuxDir, memberNames, nowSec);
  const ageByName = new Map(ages.map((a) => [a.member, a.ageSec]));
  for (const row of members) {
    row.heartbeat_age_s = ageByName.get(row.name) ?? null;
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

  // ADR-077 §lead-uptime-measurement (t-6d950ffd): two-source uptime
  // snapshot. configured=false when the team has no team-lead role;
  // renderer skips display in that case.
  const leadOpts: Parameters<typeof probeLeadUptime>[4] = {};
  if (deps.home !== undefined) leadOpts.home = deps.home;
  else if (homeDir.length > 0) leadOpts.home = homeDir;
  if (deps.now !== undefined) leadOpts.now = deps.now;
  if (deps.psEtime !== undefined) leadOpts.psEtime = deps.psEtime;
  const lead = await probeLeadUptime(
    tmux,
    team,
    sessionName,
    sessionState === "up",
    leadOpts,
  );

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
    lead,
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
  const heartbeatStaleSec = resolveHeartbeatStaleSec(team);

  if (parsed.json) {
    // Bash json shape (lib/status.sh:148-155): {team, session,
    // sessionState, members[], kanban}. We add `driverInboxOpen`
    // so the json caller can also see what the text view shows.
    const out = {
      team: snap.team,
      session: snap.session,
      sessionState: snap.sessionState,
      members: snap.members.map((m) => {
        // ADR-136 TR4: surface `label` as an optional sibling key
        // alongside the canonical `name`. JSON consumers gating on
        // `name` (the immutable ID) keep working; renderers that want
        // the operator-facing display string read `label ?? name`.
        // Per-task t-d98b2bd6: surface contextPct + contextTs +
        // contextStale when the whip-side signal exists. Omit fields
        // entirely when the signal is absent so JSON consumers can
        // gate on key-presence cleanly.
        const row: {
          name: string;
          role: string;
          tui: string;
          paneCommand: string;
          cageState: CageState | null;
          pendingCount: number;
          inProgressCount: number;
          heartbeat_age_s: number | null;
          label?: string;
          contextPct?: number;
          contextTs?: number;
          contextStale?: boolean;
          cadence?: CadenceObservation;
        } = {
          name: m.name,
          role: m.role,
          tui: m.tui,
          paneCommand: m.paneCommand,
          cageState: m.cageState,
          pendingCount: m.pendingCount,
          inProgressCount: m.inProgressCount,
          // ADR-057 §D6c: always emit the heartbeat field (even when
          // null) so JSON consumers can present the row uniformly
          // without per-team key-presence forks.
          heartbeat_age_s: m.heartbeat_age_s,
        };
        if (m.label !== undefined && m.label.length > 0) row.label = m.label;
        if (m.contextPct !== undefined) row.contextPct = m.contextPct;
        if (m.contextTs !== undefined) row.contextTs = m.contextTs;
        if (m.contextStale !== undefined) row.contextStale = m.contextStale;
        if (m.cadence !== undefined) row.cadence = m.cadence;
        return row;
      }),
      kanban: snap.kanban,
      driverInboxOpen: snap.driverInboxOpen,
      driverPane: snap.driverPane,
      // ADR-133: emit BOTH `medic` (canonical) AND `superdoctor`
      // (deprecated alias, same data) during the rename window so JSON
      // consumers continue working. `superdoctor` drops next release.
      medic: snap.medic,
      superdoctor: snap.superdoctor,
      needsApproval: snap.needsApproval,
      // ADR-077 §lead-uptime-measurement (t-6d950ffd): explicit-naming
      // uptime snapshot. Two distinct numbers, two distinct sources —
      // see LeadUptimeSnapshot JSDoc for why they must NOT be conflated.
      lead: snap.lead,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  renderTextStatus(snap, heartbeatStaleSec);
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
  // ADR-161 TR2: role-aware — default-role members render `_-prefix`.
  const winName = buildWindowName(member.name, member.emoji, member.label, member.role);
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

function renderTextStatus(snap: StatusSnapshot, staleSec: number): void {
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
  // t-74273200: text mode now leads with `cageState` (the unified 4-
  // state taxonomy: down/bootstrapping/active/wedged) in place of the
  // pane_current_command proxy that mis-reported welcome-screen claude
  // TUIs as `(down)`. ADR-148 §D3 renamed this column from `state` to
  // `pane-state` to make the proxy explicit — pane-state is a process
  // observable, NOT a verdict on whether the member is shipping.
  // Per-task t-d98b2bd6: `ctx` column added between state and tasks
  // — reads the whip-side `member-context/*.json` signal written by
  // measure-context.sh. Renders "—" / "(stale)" / "X.X%".
  // ADR-148 §D3: new `cadence` column — canonical truth signal for
  // "is this member shipping?". Sourced from per-member git log;
  // formatted as `🟢 shipping (5min)` / `🟡 idle (1h2m)` / `🔴 dormant (15h)`
  // / `🚨 ship-zero (3h)` per CLAUDE.md duration convention.
  process.stdout.write(
    `member       role          tui        pane-state    ctx      cadence              tasks\n`,
  );
  for (const m of snap.members) {
    const emoji = m.emoji ?? defaultRoleEmoji(m.role);
    // ADR-136 TR4: operator-facing text column uses label-fallback.
    // Internal data still keys by `m.name` (the ID) for the kanban /
    // inbox counts — `m.pendingCount` etc. were already resolved
    // against the ID upstream.
    const name = displayMemberName(m).padEnd(12);
    const role = m.role.padEnd(14);
    const tui = m.tui.padEnd(10);
    // For claude TUIs: surface the cage state. For non-claude TUIs:
    // fall back to the legacy pane_current_command (the cage taxonomy
    // doesn't apply — non-claude TUIs don't have claude in their child
    // process tree by definition).
    const paneState = (m.cageState ?? m.paneCommand).padEnd(14);
    // Per-task t-d98b2bd6: ctx % column rendered as "8.4%" /
    // "(stale)" / "—". Width pinned to 8 chars so the trailing
    // tasks block stays column-aligned across heterogeneous teams.
    const ctx = formatContextColumn(m).padEnd(8);
    // ADR-148 §D3: cadence column. Width pinned to 20 chars — fits
    // the longest expected verdict ("🚨 ship-zero (24h)" + change).
    const cadence = formatCadenceColumn(m.cadence).padEnd(20);
    // ADR-057 §D6c: heartbeat marker appended inline to the trailing
    // tasks segment — keeps existing column alignment intact while
    // surfacing the producer-side liveness signal next to the kanban
    // verdicts. Omitted entirely when no heartbeat exists ("—") to
    // avoid stamping every row with a dash on teams that haven't yet
    // ticked their first cron-mediated poke cycle.
    const hb = formatHeartbeatColumn(m, staleSec);
    const hbSuffix = hb === "—" ? "" : `  ${hb}`;
    process.stdout.write(
      `  ${emoji} ${name} ${role} ${tui} ${paneState} ${ctx} ${cadence} 🟡 ${m.inProgressCount} active  📌 ${m.pendingCount} todo${hbSuffix}\n`,
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
  // ADR-077 §lead-uptime-measurement (t-6d950ffd): lead-uptime row —
  // skip when the team has no team-lead role configured. Surfaces
  // BOTH numbers with explicit labels so the operator reading the
  // text view can't conflate them; the diagnostic-only shell etime
  // is parenthesized as "(shell <Hh>)" so the rotation-gate source
  // remains the unparenthesized primary value.
  if (snap.lead.configured) {
    const upStr =
      snap.lead.lead_session_uptime_s === null
        ? "—"
        : formatDurationShort(snap.lead.lead_session_uptime_s);
    const shellStr =
      snap.lead.shell_pid_etime_s === null
        ? "—"
        : formatDurationShort(snap.lead.shell_pid_etime_s);
    process.stdout.write(
      `🧭 lead ${snap.lead.leadMember ?? "?"}  session_uptime=${upStr}  (shell_etime=${shellStr})\n`,
    );
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

/** Per-task t-d98b2bd6: format the `ctx %` column for a member row.
 *  Three states:
 *    - No signal on disk (undefined contextPct)             → "—"
 *    - Stale signal (contextStale=true)                     → "(stale)"
 *    - Fresh signal — one decimal place + %                 → "8.4%"
 *
 *  Stale shape distinguishes "member idle-hook crashed / claude wedged"
 *  from "no signal yet" so the operator can act differently. ≥60%
 *  rotation decisions are made on the lead side (whip §1b) — atmux
 *  status is purely informational; it does not flag the threshold,
 *  only renders the percentage. */
export function formatContextColumn(m: MemberStatus): string {
  if (m.contextPct === undefined) return "—";
  if (m.contextStale === true) return "(stale)";
  return `${m.contextPct.toFixed(1)}%`;
}

/** ADR-057 §D6c: format the heartbeat column for one member row. Three
 *  states:
 *    - Heartbeat absent (heartbeat_age_s === null)         → "—"
 *    - Fresh heartbeat (age <= staleSec)                   → "❤️<Ns>"
 *    - Stale heartbeat (age >  staleSec)                   → "💔<Ns>"
 *
 *  Age unit follows the global CLAUDE.md duration convention: <60s →
 *  "Ns"; <3600s → "Nm"; otherwise "Nh". Stale shape uses a broken-heart
 *  emoji distinct from the fresh heart so the operator can spot a
 *  watchdog-relevant member without parsing the number. */
export function formatHeartbeatColumn(m: MemberStatus, staleSec: number): string {
  const age = m.heartbeat_age_s;
  if (age === null) return "—";
  const isStale = age > staleSec;
  const emoji = isStale ? "💔" : "❤️";
  return `${emoji}${formatHeartbeatAge(age)}`;
}

function formatHeartbeatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/** ADR-057 §D6c: read `team.json::whip.stallPrevention.heartbeatStaleSec`.
 *  Post-promotion (t-fbfb02f8) reads the typed Zod field directly — the
 *  schema's `z.number().int().positive()` rejects garbage at parse time,
 *  so the call-site simplifies to a direct read + null-coalescing to the
 *  shared default. Mirrors watchdog.ts's posture (same default, same
 *  precedence) so the two surfaces agree on what "stale" means for the
 *  same team. */
export function resolveHeartbeatStaleSec(team: Team): number {
  return team.whip?.stallPrevention?.heartbeatStaleSec ?? DEFAULT_HEARTBEAT_STALE_SEC;
}

// ---------- ADR-148 T2: cadence column helpers ----------

// ADR-148 §D2 / T5 (t-ac95b267): `classifyCadence` + the default
// `gitLog` probe live in `src/core/cadence-classifier.ts` post-T5 —
// sentinel observe() + medic + future doctor probes share one
// implementation. Re-export here so pre-T5 importers
// (`import { classifyCadence } from ".../verbs/status"`) keep
// resolving without churn.
export {
  classifyCadence,
  defaultGitLog,
  type CadenceThresholds,
} from "../core/cadence-classifier.ts";

/** Resolve the worktree path for a member. Honors ADR-082 §2
 *  `team.worktreeIsolation` — when isolation is on, per-member
 *  worktrees live under `<teamRoot>/<worktreeRoot>/<member>/`.
 *  Otherwise falls back to the member's declared `cwd`, then to the
 *  parent of `atmuxDir`. Returns null only when none of those
 *  resolve to a meaningful absolute-ish path — the caller skips the
 *  cadence probe in that case rather than running git against an
 *  empty string. */
function resolveMemberWorktree(
  team: Team,
  member: { name: string; cwd?: string | undefined },
  atmuxDir: string,
): string | null {
  if (team.worktreeIsolation === true) {
    const root = team.worktreeRoot ?? ".atmux/worktrees";
    // Project root = parent of .atmux dir.
    const projectRoot = atmuxDir.replace(/\/?\.atmux$/, "");
    const path = root.startsWith("/")
      ? join(root, member.name)
      : join(projectRoot, root, member.name);
    return path;
  }
  if (member.cwd !== undefined && member.cwd.length > 0) return member.cwd;
  const projectRoot = atmuxDir.replace(/\/?\.atmux$/, "");
  return projectRoot.length > 0 ? projectRoot : null;
}

/** Resolve the effective cadence config — fills missing keys from
 *  {@link DEFAULT_CADENCE_CONFIG} + {@link DEFAULT_CADENCE_THRESHOLDS}.
 *  Returned object has every threshold populated so callers don't
 *  re-coalesce. */
export function resolveCadenceConfig(team: Team): {
  enabled: boolean;
  windowSec: number;
  thresholds: CadenceThresholds;
  laneStallEnabled: boolean;
  laneStallMinAgeSec: number;
  exemptMembers: ReadonlyArray<string>;
} {
  const c = team.cadence;
  return {
    enabled: c?.enabled ?? DEFAULT_CADENCE_CONFIG.enabled,
    windowSec: c?.windowSec ?? DEFAULT_CADENCE_CONFIG.windowSec,
    thresholds: {
      shippingMaxAgeSec:
        c?.thresholds?.shippingMaxAgeSec ?? DEFAULT_CADENCE_THRESHOLDS.shippingMaxAgeSec,
      idleMaxAgeSec: c?.thresholds?.idleMaxAgeSec ?? DEFAULT_CADENCE_THRESHOLDS.idleMaxAgeSec,
      dormantMaxAgeSec:
        c?.thresholds?.dormantMaxAgeSec ?? DEFAULT_CADENCE_THRESHOLDS.dormantMaxAgeSec,
      shipZeroWindowSec:
        c?.thresholds?.shipZeroWindowSec ?? DEFAULT_CADENCE_THRESHOLDS.shipZeroWindowSec,
    },
    laneStallEnabled: c?.laneStallEnabled ?? DEFAULT_CADENCE_CONFIG.laneStallEnabled,
    laneStallMinAgeSec: c?.laneStallMinAgeSec ?? DEFAULT_CADENCE_CONFIG.laneStallMinAgeSec,
    exemptMembers: c?.exemptMembers ?? DEFAULT_CADENCE_CONFIG.exemptMembers,
  };
}

/** CLAUDE.md duration-formatting convention: compact human-readable,
 *  never raw minutes. `<60s` → "Ns"; `<60m` → "Nmin"; `≥60m` →
 *  "HhMm" or "Hh" when on the hour. Used by the cadence column to
 *  render `ageOfLastCommitSec` (and reusable in T3/T5 elsewhere). */
export function formatDurationShort(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Render one cadence cell — emoji + verdict + age. Stable width
 *  isn't enforced here (text mode pads via String.prototype.padEnd
 *  on the caller); this returns the unpadded display string. */
export function formatCadenceColumn(obs: CadenceObservation | undefined): string {
  if (obs === undefined) return "—";
  if (obs.verdict === "exempt") return "(exempt)";
  const age = formatDurationShort(obs.ageOfLastCommitSec);
  switch (obs.verdict) {
    case "shipping":
      return `🟢 shipping (${age})`;
    case "idle":
      return `🟡 idle (${age})`;
    case "dormant":
      return `🔴 dormant (${age})`;
    case "ship-zero-window":
      return `🚨 ship-zero (${age})`;
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

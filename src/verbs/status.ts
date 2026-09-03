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
import {
  createTmux,
  exactSessionTarget,
  type TmuxConfig,
  type TmuxNamespace,
} from "../abstractions/tmux.ts";
import {
  type CadenceObservation,
  type CadenceThresholds,
  classifyCadence,
  defaultGitLog,
} from "../core/cadence-classifier.ts";
import {
  type CageHealth,
  type CageState,
  cageWindowCandidates,
  type ProbeCageStateOpts,
  probeCageState,
  resolveCageWindowName,
} from "../core/cage-state.ts";
import { type LoadCockpitOpts, loadCockpit } from "../core/cockpit.ts";
import {
  buildWindowName,
  displayMemberName,
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { type DriverPaneHealth, probeDriverPane } from "../core/driver-pane-health.ts";
import { DEFAULT_HEARTBEAT_STALE_SEC, readHeartbeatAges } from "../core/heartbeat.ts";
import { loadInbox } from "../core/inbox.ts";
import { loadKanban } from "../core/kanban.ts";
import { kanbanWorkStateAvailable } from "../core/kanban-backend.ts";
import { readLeadSessionStart, readLeadWindowName } from "../core/lead-marker.ts";
import { type MemberSelfStatus, readAllMemberStatuses } from "../core/member-status.ts";
import { getAtmuxTmuxConfPath, getCockpitSocketName } from "../core/tmux-paths.ts";
import {
  classifyPaneObservation,
  type PaneVerdict,
  paneVerdictGlyph,
  paneVerdictPhrase,
  parseWindowProbe,
  WINDOW_PROBE_FORMAT,
  type WindowProbe,
} from "../core/vox/fleet.ts";
import { UsageError } from "../errors.ts";
import {
  type NeedsApprovalReport,
  projectRootFromAtmuxDir,
  scanNeedsApproval,
} from "../lib/needs-approval.ts";
import {
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_CADENCE_THRESHOLDS,
  type Team,
  type TeamMember,
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
   *  pane's direct children); non-claude TUIs are read via the legacy
   *  `paneCommand` field above. */
  cageState: CageState | null;
  /**
   * ADR-273 §Supplement-6: the BEHAVIOURAL verdict for this pane — what
   * the agent in it is actually doing — from `classifyPaneObservation`,
   * the classifier `fleet_attention` speaks.
   *
   * Alongside `cageState`, never instead of it. The two answer different
   * questions and both belong: `cageState` says whether the process is
   * there, `agentState` says whether it is stuck. `active` is true of a
   * pane blocked forever on a permission prompt, and on a SPOKEN surface
   * "active" means "working fine" to a listener — which is why this leads
   * the rendered row.
   *
   * Both come from ONE call to `probeCageState`, over ONE pane capture, so
   * `team_status` cannot contradict `fleet_attention` about the same pane
   * (the W6 defect). Absent when no probe ran: a non-claude TUI (the cage
   * probe is claude-specific) or a probe that threw. Absent means "no
   * reading" — never "the pane is fine".
   */
  agentState?: PaneVerdict;
  /** ADR-273 §Supplement-5: true when `cageState` was read off the pane's
   *  RENDER alone because no `claude` process could be identified in its
   *  tree. Absent when the state was not inferred (process identified,
   *  session down, non-claude TUI, injected test probe). Rendered as a
   *  trailing `?` on the pane-state column so a spoken answer can hedge
   *  instead of asserting — see {@link formatPaneStateColumn}. */
  cageInferredFromRender?: boolean;
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
  /** ADR-260 §D5: the member's self-reported status (manual
   *  orchestration mode's authoritative intent signal), sourced from
   *  `<atmuxDir>/state/member-status/<member>.json` via
   *  readAllMemberStatuses. Absent when the member has never
   *  self-reported (or the file is unreadable) — key-presence
   *  convention matches `contextPct`. Rendered alongside — not
   *  instead of — the derived signals so a stale/dishonest
   *  self-report is cross-checkable at a glance. */
  selfStatus?: {
    status: MemberSelfStatus;
    note?: string;
    taskId?: string;
    ageSec: number;
  };
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
 *  (formerly named `SuperdoctorState`; renamed per ADR-133 — the
 *  `SuperdoctorState` alias was removed per ADR-266 §D2). Surfaced in
 *  `atmux status` so the operator can
 *  verify a `cockpit reconcile` actually took effect. */
export interface MedicState {
  /** True iff `~/.atmux/cockpit.json` exists AND has a `medic` block.
   *  False when no cockpit is configured at all (silent — most per-team
   *  status calls won't have one). */
  configured: boolean;
  /** True iff `medic.enabled === true` in cockpit.json. */
  enabled: boolean;
  /** True iff the cockpit tmux session exists on the operator's
   *  default socket. Probed only when `enabled === true`. */
  sessionAlive: boolean;
  /** True iff a window named `_medic` (canonical) OR `medic` /
   *  `superdoctor` (legacy names, still live in unreconciled cockpits)
   *  exists in the cockpit session. Probed only when
   *  `sessionAlive === true`. */
  windowAlive: boolean;
}

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
   *  renderer skips display when `configured=false` (legacy fixture
   *  compatibility only). */
  driverPane: DriverPaneHealth;
  /** ADR-077 §F5 / ADR-133: cockpit medic snapshot. Always populated;
   *  renderer skips display when `configured=false`. */
  medic: MedicState;
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
  /** Returns `null` when no repository could be read at that path —
   *  distinct from `[]` ("a repo with no matching commits"). Only the
   *  latter supports a cadence verdict. */
  gitLog?: (worktreePath: string, sinceSec: number, author: string) => Promise<string[] | null>;
  /** ADR-077 §lead-uptime-measurement (t-6d950ffd) injection seam:
   *  given a process PID, return its elapsed-time-since-start in
   *  seconds. Default shells `ps -o etime= -p <pid>` and parses
   *  the `[[DD-]HH:]MM:SS` format. Returns null when the PID is
   *  not running OR the ps call fails. */
  psEtime?: (pid: number) => Promise<number | null>;
  /** ADR-273 D3 trap 1 injection seam: the per-member cage probe.
   *  Default {@link probeCageState}. Exists so a test can assert WHICH
   *  session name the probe is handed — the argument whose absence made
   *  every anchored team (`atmux_unum`, bare `atmux`) report as down. */
  probeCage?: typeof probeCageState;
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
  const m = cockpit.medic;
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
    sessionAlive = await cockpitTmux.session.hasSession(exactSessionTarget(cockpit.cockpitSession));
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
  const leadSessionUptime = startedAt === null ? null : Math.max(0, nowSec - startedAt);

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

  // The windows tmux ACTUALLY reports for this session — read ONCE and
  // shared by every member's cage probe (the probe would otherwise pay a
  // `list-windows` per member). This is the same discipline `fleet.ts`
  // uses, and the reason it classified panes correctly off this very
  // socket while `status` was calling them `down`: names get ENUMERATED,
  // never assumed. See `cageWindowCandidates`.
  const liveWindowNames =
    sessionState === "up" ? await listSessionWindowNames(tmux, sessionName) : null;
  // Handed to the cage probe only when it is real evidence. Omitted when
  // the list is unreadable so the probe falls back exactly as it did
  // before this seam existed.
  const cageWindowOpt: Pick<ProbeCageStateOpts, "listWindowNames"> =
    liveWindowNames === null ? {} : { listWindowNames: async () => liveWindowNames };

  const members: MemberStatus[] = [];
  for (const m of team.members) {
    // ONE `display-message` per member, rendering all three window signals
    // (`#{pane_current_command}` for the legacy column, plus the activity
    // clock and `#{pane_dead}` the behavioural classifier needs). Handed
    // down to the cage probe rather than re-read there — see
    // `ProbeCageStateOpts.windowProbe`.
    const paneRead = await readMemberPane(
      tmux,
      sessionName,
      m,
      sessionState === "up",
      liveWindowNames,
      nowSec,
    );
    const paneCommand = paneRead.paneCommand;
    // t-74273200 / c-8ecd3a61: cage-state probe for claude TUI members
    // — replaces the pane_current_command proxy which mis-reported
    // welcome-screen claude TUIs as `(down)`. Non-claude TUIs skip the
    // probe (cage taxonomy is claude-specific) and surface state=null.
    let cageState: CageState | null = null;
    let cageInferred: boolean | undefined;
    let agentState: PaneVerdict | undefined;
    if (sessionState === "up" && (m.tui ?? "claude") === "claude") {
      try {
        // ADR-273 D3 trap 1: pass the RESOLVED session name. `gatherStatus`
        // already has it (from `getSessionName`, anchor-aware); without it
        // the probe rebuilds `atmux-<team>` and reports every member of an
        // anchored team (`atmux_unum`, bare `atmux`) as `down`.
        const health: CageHealth = await (deps.probeCage ?? probeCageState)(team, m, atmuxDir, {
          tmux,
          sessionName,
          ...cageWindowOpt,
          windowProbe: async () => paneRead.probe,
        });
        cageState = health.state;
        cageInferred = health.inferredFromRender;
        agentState = health.agentState;
      } catch {
        // Probe failure → leave cageState null; the legacy paneCommand
        // proxy still gives the operator something to look at.
        cageState = null;
      }
    } else if (sessionState === "down") {
      cageState = "down";
      // ADR-273 §Supplement-6: routed through the SHARED classifier rather
      // than hand-written as `dead`, so the words match `fleet_attention`'s
      // for the same condition by construction rather than by discipline.
      agentState = classifyPaneObservation({
        team: team.name,
        member: m.name,
        windowName: paneRead.windowName,
        sessionUp: false,
        windowPresent: false,
        capture: null,
        paneDead: null,
        currentCommand: null,
        activityAgeSec: null,
      });
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
    if (cageInferred !== undefined) row.cageInferredFromRender = cageInferred;
    if (agentState !== undefined) row.agentState = agentState;
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
          const sinceSec = Math.max(cadenceCfg.windowSec, cadenceCfg.thresholds.dormantMaxAgeSec);
          const lines = await gitLog(wt, sinceSec, m.name);
          // `null` = the probe could not read a repository at `wt` at all
          // (missing path, not a git repo, spawn failure). Leaving
          // `row.cadence` undefined renders `—` ("no signal"), which is
          // the truth. Collapsing it to `[]` produced `🟡 idle (never)` —
          // a confident verdict about work that was never observable, and
          // one that `team_status` then SPOKE as "all idle".
          if (lines !== null) {
            row.cadence = classifyCadence(
              lines,
              nowSec,
              cadenceCfg.windowSec,
              cadenceCfg.thresholds,
            );
          }
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

  // ADR-260 §D5: batch-read the per-member self-reported status files.
  // Key-presence convention matches contextPct — rows without a signal
  // simply omit the field so JSON consumers gate cleanly.
  const selfStatuses = await readAllMemberStatuses(atmuxDir, memberNames);
  for (const row of members) {
    const rec = selfStatuses.get(row.name);
    if (rec !== undefined) {
      row.selfStatus = {
        status: rec.status,
        ...(rec.note !== undefined ? { note: rec.note } : {}),
        ...(rec.taskId !== undefined ? { taskId: rec.taskId } : {}),
        ageSec: Math.max(0, nowSec - rec.updatedAtSec),
      };
    }
  }

  const counts: KanbanCounts = { todo: 0, inProgress: 0, done: 0, blocked: 0 };
  // ADR-060 dual-path: load if EITHER the SQLite store or the legacy
  // JSON file exists. Pre-fix this gate only checked kanban.json, so
  // post-migration teams (state.db only) reported counts=0.
  if (await kanbanWorkStateAvailable(atmuxDir)) {
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
  //
  // `projectRoot` is passed EXPLICITLY. Left to its own default the scan
  // walks up from `process.cwd()`, which is whatever directory the caller
  // happens to be standing in — not the team being reported on. Under the
  // voice bridge (`team_status` → `atmux status --team-dir <root>`) that
  // meant a scratch team with an empty root was spoken as "19 ADRs / 1157
  // inbox / 2 kanban": the SERVER's repo, attributed to a team that has no
  // paperwork at all. `atmuxDir` is the one directory that is definitely
  // this team's, so the row is derived from it.
  const needsApproval = await scanNeedsApproval({
    projectRoot: projectRootFromAtmuxDir(atmuxDir),
  });

  // ADR-077 §lead-uptime-measurement (t-6d950ffd): two-source uptime
  // snapshot. configured=false when the team has no team-lead role;
  // renderer skips display in that case.
  const leadOpts: Parameters<typeof probeLeadUptime>[4] = {};
  if (deps.home !== undefined) leadOpts.home = deps.home;
  else if (homeDir.length > 0) leadOpts.home = homeDir;
  if (deps.now !== undefined) leadOpts.now = deps.now;
  if (deps.psEtime !== undefined) leadOpts.psEtime = deps.psEtime;
  const lead = await probeLeadUptime(tmux, team, sessionName, sessionState === "up", leadOpts);

  return {
    team: team.name,
    session: sessionName,
    sessionState,
    members,
    kanban: counts,
    driverInboxOpen,
    driverPane,
    medic,
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
          cageInferredFromRender?: boolean;
          agentState?: { bucket: string; kind: string; reason: string; marker?: string };
          pendingCount: number;
          inProgressCount: number;
          heartbeat_age_s: number | null;
          label?: string;
          contextPct?: number;
          contextTs?: number;
          contextStale?: boolean;
          cadence?: CadenceObservation;
          selfStatus?: MemberStatus["selfStatus"];
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
        // ADR-273 §Supplement-5: emitted only when the probe made a claim
        // (key-presence convention, same as contextPct below).
        if (m.cageInferredFromRender !== undefined) {
          row.cageInferredFromRender = m.cageInferredFromRender;
        }
        // ADR-273 §Supplement-6: the behavioural verdict, carrying the
        // SAME `reason` clause `fleet_attention` speaks for that class, and
        // the evidence marker that produced it. Key-presence convention:
        // absent means no probe ran, never "the pane is fine".
        if (m.agentState !== undefined) {
          row.agentState = {
            bucket: m.agentState.bucket,
            kind: m.agentState.kind,
            reason: paneVerdictPhrase(m.agentState),
            ...(m.agentState.bucket === "attention" ? { marker: m.agentState.marker } : {}),
          };
        }
        if (m.contextPct !== undefined) row.contextPct = m.contextPct;
        if (m.contextTs !== undefined) row.contextTs = m.contextTs;
        if (m.contextStale !== undefined) row.contextStale = m.contextStale;
        if (m.cadence !== undefined) row.cadence = m.cadence;
        // ADR-260 §D5: self-reported status — emitted only when the
        // member has a readable status file (key-presence convention).
        if (m.selfStatus !== undefined) row.selfStatus = m.selfStatus;
        return row;
      }),
      kanban: snap.kanban,
      driverInboxOpen: snap.driverInboxOpen,
      driverPane: snap.driverPane,
      medic: snap.medic,
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

/** The window names live on `sessionName`, or `null` when tmux could not
 *  be asked.
 *
 *  `null` is distinct from `[]` and the distinction is load-bearing: an
 *  empty list is evidence the member has no window (report it down), while
 *  an unreadable list is evidence of nothing at all (fall back to the name
 *  the old code synthesized, so a tmux hiccup can never make resolution
 *  WORSE than the guess it replaced). */
async function listSessionWindowNames(
  tmux: TmuxNamespace,
  sessionName: string,
): Promise<ReadonlyArray<string> | null> {
  try {
    return (await tmux.window.listWindows(sessionName)).map((w) => w.name);
  } catch {
    return null;
  }
}

/** One member's pane, read ONCE (ADR-273 §Supplement-6). */
interface MemberPaneRead {
  /** Window the member's pane resolved to. */
  windowName: string;
  /** Legacy `pane_current_command` column value, `(down)` when absent. */
  paneCommand: string;
  /** The three independent window signals, for the behavioural classifier. */
  probe: WindowProbe;
}

/** No signals at all — every field independently unknown. */
const NO_WINDOW_PROBE: WindowProbe = Object.freeze({
  activityAgeSec: null,
  paneDead: null,
  currentCommand: null,
});

/**
 * Read one member's window signals with a SINGLE `display-message`.
 *
 * Formerly `readPaneCommand`, which rendered `#{pane_current_command}`
 * alone. It now renders `WINDOW_PROBE_FORMAT` — the same format string
 * `atmux fleet` uses — so the activity clock and `#{pane_dead}` come back
 * on the same round trip and can be handed to the cage probe instead of
 * being read a second time there. One pane, one read, two verdicts: two
 * reads is how `team_status` and `fleet_attention` would start disagreeing
 * again (ADR-273 §Supplement-5 W6).
 */
async function readMemberPane(
  tmux: TmuxNamespace,
  sessionName: string,
  member: TeamMember,
  sessionUp: boolean,
  liveWindowNames: ReadonlyArray<string> | null,
  nowSec: number,
): Promise<MemberPaneRead> {
  const { canonical } = cageWindowCandidates(member);
  if (!sessionUp) {
    return { windowName: canonical, paneCommand: "(down)", probe: NO_WINDOW_PROBE };
  }
  // Resolved against the live window list, NOT synthesized — the same
  // resolution the cage probe uses, so the `pane-state` and `paneCommand`
  // columns of one status row cannot contradict each other about which
  // window a member is in. (They did: this function read the roster's
  // emoji verbatim while the cage probe substituted a role default, so on
  // an emoji-less roster one found the pane and the other did not.)
  const winName = await resolveCageWindowName(sessionName, member, async () => {
    if (liveWindowNames === null) throw new Error("window list unavailable");
    return liveWindowNames;
  });
  // A name tmux does not list means this member has no pane — and asking
  // anyway is NOT safe. `display-message -t <session>:<missing-window>`
  // does not fail: it silently answers about the session's CURRENT window
  // and exits 0. That is how this column came to report one member's
  // command as another member's, with no error to notice. `list-panes`
  // (which the cage probe uses) does error, so only this call site needs
  // the guard.
  if (liveWindowNames !== null && !liveWindowNames.includes(winName)) {
    return { windowName: winName, paneCommand: "(down)", probe: NO_WINDOW_PROBE };
  }
  const target = `${sessionName}:${winName}`;
  try {
    // Bash lib/status.sh:55 reads `#{pane_current_command}` via
    // `tmux list-panes -F`; our listPanes wrapper doesn't surface
    // that field, so we go through displayMessage which renders
    // any tmux format string against a target.
    const raw = await tmux.pane.displayMessage({
      target,
      format: WINDOW_PROBE_FORMAT,
      print: true,
    });
    const probe = parseWindowProbe(raw, nowSec);
    return {
      windowName: winName,
      // Bash falls back to "(down)" for an empty command — mirror.
      paneCommand: probe.currentCommand ?? "(down)",
      probe,
    };
  } catch {
    // expected: window may not exist (member declared in team.json
    // but never spawned). Bash falls back to "(down)" — mirror.
    return { windowName: winName, paneCommand: "(down)", probe: NO_WINDOW_PROBE };
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

export function renderTextStatus(snap: StatusSnapshot, staleSec: number): void {
  const sessEmoji = snap.sessionState === "up" ? "🟢" : "🔴";
  process.stdout.write(
    `${sessEmoji} 🧭 TEAM ${snap.team}  session=${snap.session} [${snap.sessionState}]\n\n`,
  );
  // ADR-064 §4: driver-pane row above the per-member table — the
  // canonical driver roster is the default, and pair failures render
  // distinctly from a successful no-window absence. Mirrors the
  // existing `driver-inbox open=N` skip-when-empty pattern below.
  if (snap.driverPane.configured) {
    const dp = snap.driverPane;
    const evidence = dp.evidence.length > 60 ? `${dp.evidence.slice(0, 60)}…` : dp.evidence;
    if (dp.pairDecision !== undefined && dp.pairDecision !== "noop") {
      const pairLabel = dp.pairDecision === "unavailable" ? "observer-failure" : dp.pairDecision;
      process.stdout.write(
        `🚗 driver  configured=y  pair=${pairLabel} reason=${dp.pairReason ?? "pair.observer.list_panes_failed"}  evidence=${evidence}\n\n`,
      );
    } else {
      const stateLabel = dp.windowExists ? (dp.state ?? "UNKNOWN") : "no-window";
      process.stdout.write(
        `🚗 driver  configured=y  state=${stateLabel}  evidence=${evidence}\n\n`,
      );
    }
  }
  // t-74273200: text mode replaced the pane_current_command proxy (which
  // mis-reported welcome-screen claude TUIs as `(down)`) with `cageState`
  // — the unified 4-state taxonomy down/bootstrapping/active/wedged.
  // ADR-148 §D3 named that column `pane-state` to make the proxy explicit:
  // it is a PROCESS observable, not a verdict on whether the member is
  // shipping.
  //
  // ADR-273 §Supplement-6 puts the BEHAVIOURAL verdict in front of it.
  // Two reasons, both about being read aloud: (a) "active" is true of a
  // pane blocked forever on a permission prompt, and a listener hears
  // "active" as "fine"; (b) the operator asked what the agent is DOING,
  // and that is the question `agent-state` answers. The process column
  // stays — `down` is exactly what you want when a cage has died.
  //
  // Every cell in the two ambiguous columns is SELF-LABELLED (`process:`,
  // `commits:`) rather than relying on the header. This surface is read by
  // a language model, and a model reading a column-aligned table by rows
  // has no header to consult: the drilldown transcript read the cadence
  // column's bare "idle" as a pane state, and every line it was given was
  // individually true (ADR-273 §Supplement-5 W6).
  //
  // Per-task t-d98b2bd6: `ctx` column reads the whip-side
  // `member-context/*.json` signal written by measure-context.sh.
  // ADR-148 §D3: the cadence column is the canonical truth signal for
  // "is this member shipping?", sourced from per-member git log.
  process.stdout.write(
    `member       role          tui        agent-state                                process-state      ctx      commit-cadence                 tasks\n`,
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
    // ADR-273 §Supplement-6: the behavioural verdict leads. Same words
    // `fleet_attention` uses for the same class — one classifier, one
    // vocabulary, so the two tools cannot describe one pane differently.
    const agent = formatAgentStateColumn(m).padEnd(42);
    // For claude TUIs: surface the cage state. For non-claude TUIs:
    // fall back to the legacy pane_current_command (the cage taxonomy
    // doesn't apply — non-claude TUIs don't have claude in their child
    // process tree by definition).
    const paneState = formatProcessStateColumn(m).padEnd(18);
    // Per-task t-d98b2bd6: ctx % column rendered as "8.4%" /
    // "(stale)" / "—". Width pinned to 8 chars so the trailing
    // tasks block stays column-aligned across heterogeneous teams.
    const ctx = formatContextColumn(m).padEnd(8);
    // ADR-148 §D3: cadence column. Width pinned to 30 chars — fits
    // the longest expected verdict ("commits: 🚨 ship-zero (24h30m)").
    const cadence = formatCadenceColumn(m.cadence).padEnd(30);
    // ADR-057 §D6c: heartbeat marker appended inline to the trailing
    // tasks segment — keeps existing column alignment intact while
    // surfacing the producer-side liveness signal next to the kanban
    // verdicts. Omitted entirely when no heartbeat exists ("—") to
    // avoid stamping every row with a dash on teams that haven't yet
    // ticked their first cron-mediated poke cycle.
    const hb = formatHeartbeatColumn(m, staleSec);
    const hbSuffix = hb === "—" ? "" : `  ${hb}`;
    // ADR-260 §D5: self-reported status segment — appended after the
    // heartbeat marker (same suffix pattern: omitted entirely when the
    // member has never self-reported, so pre-ADR-260 rows are
    // byte-identical).
    const ss = formatSelfStatusColumn(m);
    const ssSuffix = ss === "—" ? "" : `  ${ss}`;
    process.stdout.write(
      `  ${emoji} ${name} ${role} ${tui} ${agent} ${paneState} ${ctx} ${cadence} 🟡 ${m.inProgressCount} active  📌 ${m.pendingCount} todo${hbSuffix}${ssSuffix}\n`,
    );
    // ADR-273 D3: every attention verdict carries the evidence that
    // produced it. An operator (or a model relaying to one) who cannot see
    // WHY a pane was called blocked has a black box, and a black box that
    // cries wolf gets ignored. Quiet verdicts get no line — there is
    // nothing to act on and the budget belongs to the findings.
    const evidence = formatAgentEvidenceLine(m);
    if (evidence !== null) process.stdout.write(`${evidence}\n`);
  }
  // Both of the next two lines were individually TRUE and jointly
  // misleading: read aloud, `📋 kanban … ` followed by `📝 NEEDS APPROVAL:
  // ✅ clear` was relayed as "the kanban is clear and needs approval"
  // (ADR-273 §Supplement-5 W6). Each line now names its own subject in
  // full, so neither can be read as a predicate of the other.
  //
  // The EMPTY board gets its own sentence rather than four zeros. The
  // enumerated form spends the words "in-progress" and "blocked" — which
  // are ALSO pane vocabulary — and a model relaying "no tasks are in
  // progress or blocked" about a team with a blocked pane produced a
  // sentence the judge scored as contradicting the ground truth. When
  // there is nothing on the board, saying so is both shorter and
  // unmistakable; the per-count form keeps the noun attached to every
  // number for the case where the counts actually matter.
  const k = snap.kanban;
  const kanbanTotal = k.todo + k.inProgress + k.done + k.blocked;
  process.stdout.write(
    kanbanTotal === 0
      ? `\n📋 kanban board: no tasks on it at all\n`
      : `\n📋 kanban board: 📌 ${k.todo} tasks todo, 🟡 ${k.inProgress} tasks in-progress, ✅ ${k.done} tasks done, 🛑 ${k.blocked} tasks blocked\n`,
  );
  // ADR-085 §Three surfaces #1: approval-debt row. Positive-state when
  // total=0 so the operator sees the green even on a clean run — same
  // grammar as the driver-pane / medic rows below.
  const na = snap.needsApproval;
  if (na.total === 0) {
    process.stdout.write(`📝 awaiting your approval: ✅ nothing is waiting for sign-off\n`);
  } else {
    process.stdout.write(
      `📝 awaiting your approval: ${na.adr.length} proposed ADRs, ${na.inbox.length} driver-inbox asks, ${na.kanban.length} blocked kanban tasks\n`,
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
      snap.lead.shell_pid_etime_s === null ? "—" : formatDurationShort(snap.lead.shell_pid_etime_s);
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

/**
 * ADR-273 §Supplement-5: the `pane-state` cell, with the probe's own
 * confidence attached.
 *
 * A trailing `?` means the state was read off the pane's RENDER because no
 * `claude` process could be identified in its tree — the pane is
 * unmistakably an agent TUI, but nothing confirmed WHO. `team_status` is a
 * voice tool; without this the operator hears "docs is working" in exactly
 * the same words whether it was measured or inferred, and a tool that
 * cannot say "I could not tell" is one that eventually gets ignored.
 *
 * Bare state (no marker) is therefore a positive claim, not merely a
 * default: it means `ps` named the occupant.
 */
export function formatPaneStateColumn(m: MemberStatus): string {
  const base = m.cageState ?? m.paneCommand;
  return m.cageInferredFromRender === true ? `${base}?` : base;
}

/**
 * ADR-273 §Supplement-6: the `process-state` cell, self-labelled.
 *
 * The value is {@link formatPaneStateColumn} verbatim — the `?` marker and
 * all. The `process:` prefix is what makes the cell survive being read out
 * of its column: a bare `active` in a row of other bare cells is what a
 * model turns into "all panes are active", and the word means "the process
 * is up", not "the agent is fine".
 */
export function formatProcessStateColumn(m: MemberStatus): string {
  return `process: ${formatPaneStateColumn(m)}`;
}

/**
 * ADR-273 §Supplement-6: the `agent-state` cell — what the agent in this
 * pane is actually DOING.
 *
 * The clause comes from {@link paneVerdictPhrase}, which is the same
 * lookup `fleet_attention` renders from, so the two tools cannot describe
 * one pane in different words. The glyph is
 * {@link paneVerdictGlyph}: 🛑 acute, 🟡 chronic, 🟢 nothing needed.
 *
 * `no reading` is the honest cell when no probe ran — a non-claude TUI
 * (the cage probe is claude-specific) or a probe that threw. It must not
 * render as anything that could be heard as "fine".
 */
export function formatAgentStateColumn(m: MemberStatus): string {
  const v = m.agentState;
  if (v === undefined) return "agent: ❔ no reading";
  return `agent: ${paneVerdictGlyph(v)} ${paneVerdictPhrase(v)}`;
}

/** Longest evidence marker carried on the indented sub-line. */
const EVIDENCE_MAX_CHARS = 100;

/**
 * The indented evidence line under a member whose agent needs attention,
 * or `null` when there is nothing to justify.
 *
 * Mirrors `renderAttention`'s `> gist` shape deliberately: an operator who
 * hears the same claim from `fleet_attention` and from `team_status`
 * should also be shown the same evidence for it.
 */
export function formatAgentEvidenceLine(m: MemberStatus): string | null {
  const v = m.agentState;
  if (v === undefined || v.bucket !== "attention") return null;
  const marker = v.marker.trim();
  if (marker.length === 0) return null;
  const shown =
    marker.length > EVIDENCE_MAX_CHARS ? `${marker.slice(0, EVIDENCE_MAX_CHARS - 1)}…` : marker;
  return `       ↳ evidence for ${displayMemberName(m)}: ${shown}`;
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

/** ADR-260 §D5: format the self-reported status segment for one member
 *  row. Two states:
 *    - Never self-reported (selfStatus absent)  → "—" (renderer omits)
 *    - Self-reported                            → "📍working(t-xxx, 3m)"
 *      (taskId parenthetical omitted when the report carried none).
 *
 *  Age reuses the heartbeat-age unit convention so the two trailing
 *  markers read consistently. The note is NOT rendered in the row
 *  (would wreck column alignment) — `--json` carries it. */
export function formatSelfStatusColumn(m: MemberStatus): string {
  const ss = m.selfStatus;
  if (ss === undefined) return "—";
  const inner =
    ss.taskId !== undefined
      ? `${ss.taskId}, ${formatHeartbeatAge(ss.ageSec)}`
      : formatHeartbeatAge(ss.ageSec);
  return `📍${ss.status}(${inner})`;
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
// medic + future doctor probes + orchd event consumers (EPIC
// e-a946af69) share one implementation. Re-export here so pre-T5
// importers (`import { classifyCadence } from ".../verbs/status"`)
// keep resolving without churn.
export {
  type CadenceThresholds,
  classifyCadence,
  defaultGitLog,
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

/**
 * Render one cadence cell — subject + emoji + verdict + age. Stable width
 * isn't enforced here (text mode pads via String.prototype.padEnd on the
 * caller); this returns the unpadded display string.
 *
 * Every cell is prefixed `commits:` per ADR-273 §Supplement-6. The bare
 * forms this replaced (`🟡 idle (1h2m)`, `—`) were true and unreadable out
 * of column context: the vox drilldown transcript read this column's
 * "idle" as a PANE state and told the operator the team's panes were idle.
 * A cell that names its own subject cannot be misattributed to another
 * column, and this surface is read by a language model that has no header
 * row in front of it.
 *
 * `no signal` (not `—`) for the absent case, for the same reason: a dash
 * read aloud is nothing at all, and "no signal" is the actual claim — see
 * §Supplement-5 W4 for why `undefined` here is distinct from `idle`.
 */
export function formatCadenceColumn(obs: CadenceObservation | undefined): string {
  if (obs === undefined) return "commits: no signal";
  if (obs.verdict === "exempt") return "commits: exempt";
  const age = formatDurationShort(obs.ageOfLastCommitSec);
  switch (obs.verdict) {
    case "shipping":
      return `commits: 🟢 shipping (${age})`;
    case "idle":
      return `commits: 🟡 idle (${age})`;
    case "dormant":
      return `commits: 🔴 dormant (${age})`;
    case "ship-zero-window":
      return `commits: 🚨 ship-zero (${age})`;
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

// ADR-010 + ADR-019: CLI dispatcher — `doctor` verb (V-24).
// Bash spec: lib/doctor.sh @ worktree-frozen — IN-SCOPE SUBSET per ADR-019.
//
// Environment health check. Runs the in-scope checks and reports
// green/yellow/red. `atmux start` invokes this in --quiet mode as a
// preflight (planned — V-01 `up` follow-up).
//
// In-scope checks (ADR-019):
//   - deps: tmux/jq/git required + curl/bats/shellcheck optional
//   - team: team.json existence + valid JSON + .name + .members[] +
//     per-member name/role/tui
//   - tuis: each member's TUI binary on PATH (member.command override
//     wins → tuiCommands[tui] override → built-in name)
//   - state-dir: .atmux/ writable
//   - webhook: Discord URL resolvable via `discord.resolveWebhookUrl` +
//     reachable (HTTP 405 from Discord on GET counts as green)
//   - phantom-inboxes: inbox.inProgress entries pointing to a task no
//     longer in kanban.tasks[]
//   - orphan-sessions: singleSession=true team has a stale `atmux-<team>`
//     tmux session
//
// Render: human (stderr, color, glyph table) or JSON (--json, stdout).
// --quiet suppresses output; exit 0 on green, 1 on any red.
// --fix interactively re-runs `atmux init --wizard` when team.json is
//   the red row, and prunes phantom-inbox entries (other fix paths
//   deferred per ADR-019).

import { join } from "node:path";
import { type CrontabIO, defaultCrontabIO } from "../abstractions/crontab.ts";
import { resolveWebhookUrl } from "../abstractions/discord.ts";
import { readTextOrNull, removeFile, statOrNull, writeText } from "../abstractions/fs.ts";
import { probeStatus } from "../abstractions/http.ts";
import { tryReadJson } from "../abstractions/json.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { createTmux } from "../abstractions/tmux.ts";
import { resolveWorktreePath, sanitizeBranchSegment } from "../abstractions/worktree.ts";
import {
  buildWindowName,
  driverInboxPath,
  getAtmuxDir,
  inboxPathFor,
  kanbanJsonPath,
  type ResolveDirOpts,
  resolveTeamSocket,
  teamJsonPath,
  tryLoadTeam,
} from "../core/common.ts";
import { cageSessionName, cageSocketPath } from "../core/cockpit.ts";
import { type CronBlockTarget, findCronOrphans } from "../core/cron.ts";
import {
  findPhantomInProgressClaims,
  formatPruneIso,
  type PhantomClaim,
  prunePhantomInProgressClaims,
} from "../core/phantom-prune.ts";
import {
  type DriverInboxEntry,
  parseEntries as parseDriverInboxEntries,
} from "../core/driver-inbox.ts";
import {
  type DriverPaneHealth,
  type ProbeDriverPaneDeps,
  probeDriverPane,
} from "../core/driver-pane-health.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  type DriftReport,
} from "../core/whip-config-drift.ts";
import { UsageError } from "../errors.ts";
import { Inbox } from "../schema/inbox.ts";
import { Kanban } from "../schema/kanban.ts";
import { type Team, type TeamMember, Team as TeamSchema } from "../schema/team.ts";

const USAGE = "atmux doctor [--quiet|-q] [--fix] [--json]";

// ---------- Args ----------

export interface DoctorArgs {
  quiet: boolean;
  fix: boolean;
  json: boolean;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseDoctorArgs(argv: ReadonlyArray<string>): DoctorArgs {
  let quiet = false;
  let fix = false;
  let json = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--quiet" || a === "-q") {
      quiet = true;
      i += 1;
      continue;
    }
    if (a === "--fix") {
      fix = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "doctor: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `doctor: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  const out: DoctorArgs = { quiet, fix, json };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Row + report shape ----------

export type DoctorStatus = "green" | "yellow" | "red" | "info";

export interface DoctorRow {
  status: DoctorStatus;
  label: string;
  detail?: string;
  hint?: string;
}

export interface DoctorReport {
  rows: DoctorRow[];
  redCount: number;
  yellowCount: number;
}

/** Pure: aggregate rows into a DoctorReport with counts. */
export function buildReport(rows: ReadonlyArray<DoctorRow>): DoctorReport {
  let red = 0;
  let yellow = 0;
  for (const r of rows) {
    if (r.status === "red") red += 1;
    else if (r.status === "yellow") yellow += 1;
  }
  return { rows: [...rows], redCount: red, yellowCount: yellow };
}

// ---------- Check 1: deps ----------

export interface CheckDepsOpts {
  /** PATH lookup; defaults to `Bun.which`. Returns the resolved path or
   *  `null` when not found. Test injection point. */
  which?: (cmd: string) => string | null;
  /** OS family for install hints; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

const REQUIRED_DEPS = ["tmux", "jq", "git"] as const;
const OPTIONAL_DEPS = [
  ["curl", "needed for discord webhook + update check"],
  ["bats", "needed for bash test suite"],
  ["shellcheck", "needed for lint pass in CI"],
] as const;

export function installHint(name: string, platform: NodeJS.Platform = process.platform): string {
  switch (name) {
    case "claude":
      return "https://docs.anthropic.com/en/docs/claude-code";
    case "opencode":
      return "https://opencode.ai";
    case "kimi":
      return "https://platform.moonshot.ai";
    case "cursor-agent":
      return "https://cursor.com/cli";
  }
  if (platform === "darwin") return `brew install ${name}`;
  if (platform === "linux") return `apt install ${name}  (or your distro's equivalent)`;
  return "see the project's install docs";
}

function defaultWhich(cmd: string): string | null {
  return Bun.which(cmd);
}

export function checkDeps(opts: CheckDepsOpts = {}): DoctorRow[] {
  const which = opts.which ?? defaultWhich;
  const platform = opts.platform ?? process.platform;
  const rows: DoctorRow[] = [];
  for (const dep of REQUIRED_DEPS) {
    const path = which(dep);
    if (path !== null) {
      rows.push({ status: "green", label: `dep:${dep}`, detail: path });
    } else {
      rows.push({
        status: "red",
        label: `dep:${dep}`,
        detail: "NOT on PATH",
        hint: `install: ${installHint(dep, platform)}`,
      });
    }
  }
  for (const [dep, why] of OPTIONAL_DEPS) {
    const path = which(dep);
    if (path !== null) {
      rows.push({ status: "green", label: `dep:${dep}`, detail: `${path} (optional)` });
    } else {
      rows.push({
        status: "yellow",
        label: `dep:${dep}`,
        detail: "not installed (optional)",
        hint: `${why} — ${installHint(dep, platform)}`,
      });
    }
  }
  return rows;
}

// ---------- Check 2: team ----------

/** Load the team.json with `tryLoadTeam`-style absent-vs-malformed split.
 *  Returns `{ team }` on success, `{ rows }` carrying a red row otherwise. */
async function loadTeamForCheck(atmuxDir: string): Promise<{ team: Team } | { rows: DoctorRow[] }> {
  const tj = teamJsonPath(atmuxDir);
  try {
    const t = await tryLoadTeam({ dir: atmuxDir });
    if (t === null) {
      // ENOENT — team.json doesn't exist at the resolved path.
      return {
        rows: [
          {
            status: "red",
            label: "team.json",
            detail: `missing at ${tj}`,
            hint: "run: atmux init --wizard",
          },
        ],
      };
    }
    return { team: t };
  } catch {
    return {
      rows: [
        {
          status: "red",
          label: "team.json",
          detail: `invalid JSON at ${tj}`,
          hint: "fix by hand or re-run: atmux init --force --wizard",
        },
      ],
    };
  }
}

export async function checkTeam(atmuxDir: string): Promise<DoctorRow[]> {
  const got = await loadTeamForCheck(atmuxDir);
  if ("rows" in got) return got.rows;
  const team = got.team;
  const tj = teamJsonPath(atmuxDir);

  // Note: `team.name` is `z.string().min(1)` in the schema, so an empty
  // name surfaces as a SchemaError caught above ("invalid JSON" red row).
  // No separate empty-name branch needed.

  if (team.members.length === 0) {
    return [
      {
        status: "red",
        label: "team.json",
        detail: "no members defined",
        hint: "run: atmux add-member <name> --role member --tui claude",
      },
    ];
  }
  const bad = team.members.filter(
    (m) => m.name === undefined || m.role === undefined || m.tui === undefined,
  );
  if (bad.length > 0) {
    const names = bad.map((m) => m.name ?? "(unnamed)").join(" ");
    return [
      {
        status: "red",
        label: "team.json",
        detail: `members missing name/role/tui: ${names}`,
        hint: `edit ${tj}`,
      },
    ];
  }
  return [
    {
      status: "green",
      label: "team.json",
      detail: `valid — team "${team.name}", ${team.members.length} members`,
    },
  ];
}

// ---------- Check 3: tuis ----------

const TUI_BUILTIN_BIN: Readonly<Record<string, string | null>> = {
  claude: "claude",
  opencode: "opencode",
  kimi: "kimi",
  cursor: "cursor-agent",
  // shells are always present — `null` signals "skip"
  shell: null,
  bash: null,
  zsh: null,
};

const TUI_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  claude: "ATMUX_CLAUDE_BIN",
  opencode: "ATMUX_OPENCODE_BIN",
  kimi: "ATMUX_KIMI_BIN",
  cursor: "ATMUX_CURSOR_BIN",
};

/** Bash `_doctor_first_bin` — the first non-`KEY=VAL` token of a command. */
export function firstBin(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  for (const t of tokens) {
    if (!t.includes("=")) return t;
  }
  return "";
}

export interface CheckTuisOpts {
  which?: (cmd: string) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Resolve the bin name for a member (member.command → tuiCommands[tui] →
 *  ATMUX_*_BIN env → built-in) OR signal "skip" (shell/bash/zsh) OR
 *  "unknown tui" via the second tuple element. */
export function resolveMemberBin(
  member: TeamMember,
  team: Team,
  env: NodeJS.ProcessEnv,
): { bin: string } | { skip: true } | { unknown: string } {
  const override = member.command;
  if (override !== undefined && override !== "") {
    return { bin: firstBin(override) };
  }
  const tui = member.tui ?? "";
  const tuiCommands =
    team.tuiCommands !== undefined &&
    team.tuiCommands !== null &&
    typeof team.tuiCommands === "object"
      ? (team.tuiCommands as Record<string, unknown>)
      : {};
  const prefix = tuiCommands[tui];
  if (typeof prefix === "string" && prefix !== "") {
    return { bin: firstBin(prefix) };
  }
  if (tui in TUI_BUILTIN_BIN) {
    const builtin = TUI_BUILTIN_BIN[tui];
    if (builtin === null || builtin === undefined) return { skip: true };
    const envKey = TUI_ENV_OVERRIDES[tui];
    if (envKey !== undefined) {
      const overrideBin = env[envKey];
      if (overrideBin !== undefined && overrideBin !== "") return { bin: overrideBin };
    }
    return { bin: builtin };
  }
  return { unknown: tui };
}

export function checkTuis(team: Team, opts: CheckTuisOpts = {}): DoctorRow[] {
  const which = opts.which ?? defaultWhich;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const rows: DoctorRow[] = [];
  // Map bin → users[] for grouped one-row-per-bin output.
  const groups = new Map<string, string[]>();
  for (const m of team.members) {
    const r = resolveMemberBin(m, team, env);
    if ("skip" in r) continue;
    if ("unknown" in r) {
      rows.push({
        status: "red",
        label: `tui:${r.unknown}`,
        detail: `unknown tui type used by ${m.name}`,
        hint: "register it in team.tuiCommands or use claude/opencode/kimi/cursor/shell",
      });
      continue;
    }
    const list = groups.get(r.bin) ?? [];
    list.push(m.name);
    groups.set(r.bin, list);
  }
  // Sorted for deterministic output / testability.
  const bins = Array.from(groups.keys()).sort();
  for (const bin of bins) {
    const users = (groups.get(bin) ?? []).join(" ");
    const path = which(bin);
    if (path !== null) {
      rows.push({ status: "green", label: `tui:${bin}`, detail: `${path} (members: ${users})` });
    } else {
      rows.push({
        status: "red",
        label: `tui:${bin}`,
        detail: `NOT on PATH (members: ${users})`,
        hint: `install: ${installHint(bin, platform)}`,
      });
    }
  }
  return rows;
}

// ---------- Check 4: state-dir ----------

export async function checkStateDir(atmuxDir: string): Promise<DoctorRow[]> {
  const s = await statOrNull(atmuxDir);
  if (s === null) {
    // Not yet created — check parent writability.
    const parent = atmuxDir.endsWith("/.atmux") ? atmuxDir.slice(0, -7) : atmuxDir;
    const parentStat = await statOrNull(parent);
    if (parentStat !== null) {
      return [
        {
          status: "yellow",
          label: "state-dir",
          detail: `not yet created at ${atmuxDir}`,
          hint: "will be created on init/start",
        },
      ];
    }
    return [
      {
        status: "red",
        label: "state-dir",
        detail: `parent ${parent} does not exist`,
        hint: "chown or pick a different cwd",
      },
    ];
  }
  // Probe writability via a temp marker file write, then clean it up so the
  // final fs state matches bash's `[[ -w ]]` check (lib/doctor.sh:208) which
  // leaves no artefact. Without the cleanup the parity harness sees a
  // `.doctor-write-probe` file present in TS but absent in bash and flags an
  // fs-channel divergence (ADR-030 commit-B probe finding).
  const probe = join(atmuxDir, ".doctor-write-probe");
  try {
    await writeText(probe, "");
    return [{ status: "green", label: "state-dir", detail: `writable at ${atmuxDir}` }];
  } catch {
    return [
      {
        status: "red",
        label: "state-dir",
        detail: `${atmuxDir} exists but is not writable`,
        hint: `chown -R $USER ${atmuxDir}`,
      },
    ];
  } finally {
    await removeFile(probe).catch(() => {});
  }
}

// ---------- Check 5: webhook ----------

export interface CheckWebhookOpts {
  env?: NodeJS.ProcessEnv;
  /** Override probe (test injection). Returns the HTTP status code or 0
   *  on network/timeout failure. */
  probe?: (url: string) => Promise<number>;
}

export async function checkWebhook(
  team: Team | null,
  opts: CheckWebhookOpts = {},
): Promise<DoctorRow[]> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? ((u: string) => probeStatus(u, { timeoutMs: 5_000 }));
  const teamArg = team !== null ? team : undefined;
  const resolveOpts: { env: NodeJS.ProcessEnv; team?: Team } = { env };
  if (teamArg !== undefined) resolveOpts.team = teamArg;
  const url = await resolveWebhookUrl(resolveOpts);
  if (url === null) {
    // The hint embeds literal shell syntax (`${VAR:-default}`) so the
    // operator can copy-paste the resolution chain. biome-ignore the
    // template-string lint — these `$` are documentation, not interpolation.
    const hint = [
      "resolution chain (in order): $ATMUX_DISCORD_WEBHOOK env,",
      "team.json .discord.webhook,",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax in user-facing hint
      "${XDG_CONFIG_HOME:-$HOME/.config}/atmux/discord-webhook",
    ].join(" ");
    return [
      {
        status: "yellow",
        label: "discord",
        detail: "no webhook configured",
        hint,
      },
    ];
  }
  const code = await probe(url);
  if (code === 0) {
    return [
      {
        status: "red",
        label: "discord",
        detail: "webhook unreachable (DNS or connection failure)",
        hint: "check network + verify webhook URL",
      },
    ];
  }
  // Discord returns 405 on GET → that proves we reached it.
  if ((code >= 200 && code <= 299) || code === 405) {
    return [{ status: "green", label: "discord", detail: `reachable (HTTP ${code})` }];
  }
  if (code === 401 || code === 403 || code === 404) {
    return [
      {
        status: "red",
        label: "discord",
        detail: `webhook rejected (HTTP ${code}) — likely revoked or wrong URL`,
        hint: "regenerate the webhook in Discord and update the config",
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "discord",
      detail: `unexpected response HTTP ${code} — reachable but odd`,
    },
  ];
}

// ---------- Check 6: phantom-inboxes ----------

/** Per-member, find inbox.inProgress entries whose IDs aren't in
 *  kanban.tasks[]. These are "phantoms" — claim/done sequences that
 *  failed mid-write or kanban entries deleted out from under the
 *  inbox. Bash equivalent: atmux::find_phantom_inbox_ids. */
export interface PhantomEntry {
  member: string;
  id: string;
  subject: string;
}

export async function findPhantomInboxes(atmuxDir: string): Promise<PhantomEntry[]> {
  const kanban = await tryReadJson(kanbanJsonPath(atmuxDir), Kanban);
  if (kanban === null) return [];
  const liveIds = new Set(kanban.tasks.map((t) => t.id));
  const team = await tryLoadTeam({ dir: atmuxDir });
  if (team === null) return [];
  const phantoms: PhantomEntry[] = [];
  for (const m of team.members) {
    const inbox = await tryReadJson(inboxPathFor(atmuxDir, m.name), Inbox);
    if (inbox === null) continue;
    for (const e of inbox.inProgress) {
      if (!liveIds.has(e.id)) {
        phantoms.push({ member: m.name, id: e.id, subject: e.subject ?? "" });
      }
    }
  }
  return phantoms;
}

export async function checkPhantomInboxes(atmuxDir: string): Promise<DoctorRow[]> {
  const phantoms = await findPhantomInboxes(atmuxDir);
  return phantoms.map((p) => ({
    status: "yellow" as const,
    label: "phantom-inbox",
    detail: `${p.member} inbox.inProgress contains phantom ${p.id} ("${p.subject}")`,
    hint: "atmux doctor --fix prunes; whip auto-prune sweep also handles in-flight",
  }));
}

// ---------- Check 6b: phantom in-progress claims (t-af159454) ----------

/** Resolve the set of member names with a live tmux window in the
 *  team's cage. Returns an empty set on session-down / probe failure
 *  — caller treats that as "no live members", which means ALL
 *  in-progress claims get flagged as phantoms. Conservative bias
 *  matches the auto-prune use case (operator wants the stale rows
 *  surfaced loudly so the next session boot is clean).
 *
 *  Cage-only — singleSession teams short-circuit at the caller per
 *  ADR-026 (the deprecated mode isn't the prune target). */
async function probeLiveMembers(team: Team): Promise<ReadonlySet<string>> {
  try {
    const tmux = createTmux({ socketPath: cageSocketPath(team.name) });
    const session = cageSessionName(team.name);
    if (!(await tmux.session.hasSession(session))) return new Set();
    const windows = await tmux.window.listWindows(session);
    const liveNames = new Set(windows.map((w) => w.name));
    const live = new Set<string>();
    for (const m of team.members) {
      const expected = buildWindowName(m.name, m.emoji);
      if (liveNames.has(expected)) live.add(m.name);
    }
    return live;
  } catch {
    return new Set();
  }
}

/** Doctor check: surface kanban in-progress rows whose owner has no
 *  live tmux window in the cage. These are the rows `atmux doctor
 *  --fix` and `atmux stop` prune. */
export async function checkPhantomInProgressClaims(
  atmuxDir: string,
  team: Team | null,
): Promise<DoctorRow[]> {
  if (team === null) return [];
  if (team.singleSession === true) return [];
  const phantoms = await findPhantomInProgressClaims({
    atmuxDir,
    team,
    liveMembers: () => probeLiveMembers(team),
  });
  return phantoms.map((p) => ({
    status: "yellow" as const,
    label: "phantom-in-progress",
    detail: `${p.id} ("${p.subject}") owned by ${p.owner} but no live pane`,
    hint: "atmux doctor --fix flips it to blocked; atmux stop teardown does the same",
  }));
}

// ---------- ADR-054 §D4: whip-config-drift ----------

/**
 * Re-runs the same Zod safe-parse the whip tick performs and surfaces
 * any drift as a P3 (yellow) finding. Operator gets the drift signal
 * via `atmux doctor` immediately rather than waiting up to 5min for the
 * next whip tick.
 *
 * Returns no rows when team.json is absent — `checkTeam` already emits
 * the absent-file finding and we'd otherwise double-report.
 */
export async function checkWhipConfigDrift(atmuxDir: string): Promise<DoctorRow[]> {
  const path = teamJsonPath(atmuxDir);
  const raw = await readTextOrNull(path);
  if (raw === null) return [];

  let driftReport: DriftReport | null = null;
  try {
    const parsed = JSON.parse(raw);
    const result = TeamSchema.safeParse(parsed);
    if (!result.success) {
      driftReport = composeDriftReport(result.error, raw);
    }
  } catch (e) {
    driftReport = composeCatastrophicDrift(e, raw);
  }
  if (driftReport === null) return [];

  const issuesCount = driftReport.issues.length;
  const first = driftReport.issues[0];
  const firstSummary =
    first === undefined
      ? ""
      : ` first: ${first.path.length === 0 ? "<root>" : first.path.join(".")} (${first.code})`;
  return [
    {
      status: "yellow",
      label: "whip-config-drift",
      detail: driftReport.catastrophic
        ? `team.json malformed — whip will use full safe defaults${firstSummary}`
        : `team.json::whip validation failed — ${issuesCount} issue(s)${firstSummary}`,
      hint: "edit team.json + re-run atmux doctor (per ADR-054)",
    },
  ];
}

// ---------- ADR-079 §A: cron-interval-divisor ----------

/**
 * ADR-079 §A — surface non-divisor / out-of-range cron interval config
 * at config-load time as yellow rows, BEFORE `atmux start` trips
 * `cronEvery`'s render-time throw. Operator-friendly preview of what
 * would otherwise be a hard fail.
 *
 * Checked fields:
 *   - team.whip.intervalMins (divisor of 60, 1–60)
 *   - team.report.intervalMins (divisor of 60, 1–60)
 *   - team.report.heartbeatHours (divisor of 24, 1–24)
 *   - team.decisions.intervalHours (divisor of 24, 1–24)
 *   - team.groom.atHour (0–23)
 *   - team.unblocker.intervalMins (divisor of 60, 1–60)
 *
 * One row per offender. No rows when team is null or every value is
 * within range + a divisor.
 */
export function checkCronIntervalDivisors(team: Team | null): DoctorRow[] {
  if (team === null) return [];
  const rows: DoctorRow[] = [];

  const checkMinutes = (label: string, minutes: number | undefined): void => {
    if (minutes === undefined) return;
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 60) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${minutes} out of range (1–60)`,
        hint: "edit team.json — atmux start will fail at cron render time",
      });
      return;
    }
    if (minutes !== 60 && 60 % minutes !== 0) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${minutes} not a divisor of 60 — cron skew expected`,
        hint: "use one of: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60",
      });
    }
  };

  const checkHours = (label: string, hours: number | undefined): void => {
    if (hours === undefined) return;
    if (!Number.isInteger(hours) || hours <= 0 || hours > 24) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${hours} out of range (1–24)`,
        hint: "edit team.json — atmux start will fail at cron render time",
      });
      return;
    }
    if (hours !== 24 && hours !== 1 && 24 % hours !== 0) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${hours} not a divisor of 24 — cron skew expected`,
        hint: "use one of: 1, 2, 3, 4, 6, 8, 12, 24",
      });
    }
  };

  const checkHourOfDay = (label: string, hour: number | undefined): void => {
    if (hour === undefined) return;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      rows.push({
        status: "yellow",
        label: "cron-interval-divisor",
        detail: `${label}=${hour} out of range (0–23)`,
        hint: "edit team.json — atmux start will fail at cron render time",
      });
    }
  };

  checkMinutes("whip.intervalMins", team.whip?.intervalMins);
  checkMinutes("report.intervalMins", team.report?.intervalMins);
  checkHours("report.heartbeatHours", team.report?.heartbeatHours);
  checkHours("decisions.intervalHours", team.decisions?.intervalHours);
  checkHourOfDay("groom.atHour", team.groom?.atHour);
  checkMinutes("unblocker.intervalMins", team.unblocker?.intervalMins);

  return rows;
}

// ---------- ADR-083 follow-up §DEFERRED row 2: cron-orphans ----------

/**
 * DI surface — `findCronOrphans` already takes its IO seam + dirExists
 * predicate; we just thread defaults the same way as the verb does so
 * tests can pin both sides via the doctor entry point too.
 */
export interface CheckCronOrphansOpts {
  /** Defaults to `defaultCrontabIO()`. */
  crontab?: CrontabIO;
  /** Defaults to `statOrNull`-backed dir check. */
  dirExists?: (path: string) => Promise<boolean>;
}

/**
 * ADR-083 follow-up §DEFERRED row 2 (paired with `atmux cron-orphans`
 * verb in `src/verbs/cron-orphans.ts`): surface marker-fenced crontab
 * blocks whose `ATMUX_DIR=<path>` no longer exists on disk. Emits one
 * `cron-config` yellow row per orphan (label + team + path); empty
 * when host has no crontab, no crontab blocks, or every block's dir
 * is alive.
 *
 * Operator-facing fix: `crontab -e` to drop the orphan block, or
 * restore the missing dir if the project simply moved.
 */
export async function checkCronOrphans(opts: CheckCronOrphansOpts = {}): Promise<DoctorRow[]> {
  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) return [];
  const dirExists = opts.dirExists ?? defaultDirExistsForCron;
  const orphans = await findCronOrphans({ io: crontab, dirExists });
  return orphans.map((o: CronBlockTarget) => ({
    status: "yellow" as const,
    label: "cron-config",
    detail: `orphan cron block: team='${o.team}' atmux_dir='${o.atmuxDir}' (path does not exist)`,
    hint: `crontab -e to drop the block, or restore ${o.atmuxDir} if the project moved`,
  }));
}

async function defaultDirExistsForCron(p: string): Promise<boolean> {
  const s = await statOrNull(p);
  return s !== null && s.isDirectory;
}

// ---------- t-dcbff97c: cron-block:missing — team has no managed block in host crontab ----------

export interface CheckCronBlockOpts {
  /** Defaults to `defaultCrontabIO()`. Tests inject a fake. */
  crontab?: CrontabIO;
}

/**
 * t-dcbff97c §2 — RED finding when a team that opts into cron auto-install
 * has no marker-fenced block in the host crontab. The atmux team died
 * three consecutive overnights because `atmux start` reported success
 * but the cron block was absent; doctor missed it, so the only signal
 * was the silently-stalled lead the morning after.
 *
 * Returns:
 * - `[]` when team is null (the team-shape row already surfaced).
 * - `[]` when `team.kanban.cronAutoInstall === false` — explicit opt-out;
 *    the operator manages cron some other way and the absence is intent.
 * - `[]` when `crontab` is not on the host (no PATH match); ADR-083
 *    posture is "skip gracefully on cron-less hosts."
 * - `[]` when the team's marker header (`# >>> atmux:team=<name> …`) is
 *    present anywhere in the current crontab.
 * - one RED row otherwise, hinting `atmux cron-install`.
 *
 * RED (not YELLOW) because the failure mode is overnight team death — a
 * GREEN doctor that hides a missing cron block is a worse outcome than
 * a noisy one. Operators who legitimately don't want a block set
 * `kanban.cronAutoInstall: false` and the row stays silent.
 */
export async function checkCronBlock(
  team: Team | null,
  opts: CheckCronBlockOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  // Honor explicit opt-out — mirror `start.ts::shouldAutoInstallCron`
  // semantics so doctor + start stay in lockstep on the gating decision.
  const kanban = (team as { kanban?: { cronAutoInstall?: boolean } }).kanban;
  if (kanban?.cronAutoInstall === false) return [];

  const crontab = opts.crontab ?? defaultCrontabIO();
  if (!(await crontab.available())) return [];

  const current = (await crontab.read()) ?? "";
  // Match the exact marker header rendered by `renderCronBlock` so a
  // similarly-named team can't false-pass on a substring brush-by.
  const header = `# >>> atmux:team=${team.name} — managed by atmux start; do not edit by hand`;
  if (current.includes(header)) return [];

  return [
    {
      status: "red",
      label: "cron-block:missing",
      detail: `no managed atmux:team=${team.name} block in host crontab — whip / report / decisions / groom won't fire`,
      hint: "run `atmux cron-install` (or re-run `atmux start`) — block uses ATMUX_DIR + optional TMUX_TMPDIR so worktree-isolation is safe",
    },
  ];
}

// ---------- t-589145dc: tuiCommands.claude default-target override ----------

/**
 * t-589145dc (c-alias Ask C, ADR-094 §"Doctor row"): warn when
 * `team.json::tuiCommands.claude` embeds `CLAUDE_CONFIG_DIR=$HOME/.claude`
 * or `=/root/.claude` (the DEFAULT config dir). Pinning the default
 * inside the spawned shell BREAKS Claude's fresh-spawn auth flow:
 * downstream `claude` invocations in nested shells re-export the env
 * and end up re-running the OAuth dance instead of inheriting the
 * operator's already-authed credentials.
 *
 * Operators who want account isolation should use a NON-default suffix
 * (`$HOME/.claude-personal`, `$HOME/.claude-icloud`, etc.) via the
 * member's `claudeAccount` field, or `env -u CLAUDE_CONFIG_DIR` in the
 * tuiCommand prefix.
 *
 * Returns `[]` when:
 *   - team is null,
 *   - tuiCommands is absent / not an object,
 *   - tuiCommands.claude is absent / not a string,
 *   - the embedded path uses a non-default suffix.
 * Otherwise: one YELLOW row.
 */
export function checkTuiCommandsClaudeOverride(team: Team | null): DoctorRow[] {
  if (team === null) return [];
  const tc = (team as { tuiCommands?: unknown }).tuiCommands;
  if (tc === null || tc === undefined || typeof tc !== "object" || Array.isArray(tc)) {
    return [];
  }
  const claudeCmd = (tc as Record<string, unknown>).claude;
  if (typeof claudeCmd !== "string" || claudeCmd.length === 0) return [];
  // Negative lookahead `[\w-]` rejects suffixed forms (.claude-personal,
  // .claude_unum, etc.) — only the BARE default config dir triggers the
  // warning. The two literal absolute paths cover the two canonical
  // operator HOME layouts (Linux + Mac); the third regex catches
  // `$HOME/.claude` for shell-expansion-time paths.
  const TARGET_RES = [
    /CLAUDE_CONFIG_DIR=\$HOME\/\.claude(?![\w/-])/,
    /CLAUDE_CONFIG_DIR=\/root\/\.claude(?![\w/-])/,
    /CLAUDE_CONFIG_DIR=\$\{HOME\}\/\.claude(?![\w/-])/,
  ];
  for (const re of TARGET_RES) {
    if (re.test(claudeCmd)) {
      return [
        {
          status: "yellow",
          label: "config-claude-account-tcoverride",
          detail:
            "tuiCommands.claude embeds CLAUDE_CONFIG_DIR pointing to the default config dir — fresh-spawn TUI auth re-runs the OAuth flow in every nested shell.",
          hint: 'use `env -u CLAUDE_CONFIG_DIR` in the prefix OR pin per-member `claudeAccount: "personal"` (or another non-default suffix). See ADR-094 c-alias spawn convention.',
        },
      ];
    }
  }
  return [];
}

// ---------- Check 7a: cursor-plugin-cache ----------
//
// Cursor-agent ignores Claude's runtime `--plugin-dir` flag and only
// discovers plugins it finds in `~/.claude/plugins/cache/<marketplace>/
// <plugin>/<version>/`. For marketplace entries whose source.type is
// `directory` (e.g. a user's own plugin tree at /root/work/.../plugins),
// `claude plugin install` registers the install in
// `installed_plugins.json` WITHOUT materialising the cache path — the
// source dir stays canonical. claude-side this is fine (claude resolves
// from the marketplace install location). cursor-side it means every
// claude plugin is invisible.
//
// This check emits a yellow row per missing cache entry, with a hint
// that produces the symlink directly. Only runs when `cursor-agent` is
// on PATH — otherwise the check is irrelevant and we stay silent.

export interface CheckCursorPluginCacheOpts {
  /** PATH lookup for `cursor-agent`. Test injection. */
  which?: (cmd: string) => string | null;
  /** Override $HOME for tests. */
  home?: string;
}

interface MissingCacheEntry {
  marketplace: string;
  plugin: string;
  version: string;
  /** Absolute path of the cache-dir symlink we'd create. */
  cachePath: string;
  /** Absolute path of the canonical plugin source — symlink target. */
  sourcePath: string;
}

export async function checkCursorPluginCache(
  opts: CheckCursorPluginCacheOpts = {},
): Promise<DoctorRow[]> {
  const whichFn = opts.which ?? ((cmd: string) => Bun.which(cmd));
  if (whichFn("cursor-agent") === null) return [];

  const home = opts.home ?? process.env.HOME;
  if (home === undefined || home.length === 0) return [];

  // Read both JSONs without zod — they're claude-side files we don't own
  // the schema for. Manual parse with permissive shape; fail-soft to [].
  const installedRaw = await readTextOrNull(
    join(home, ".claude", "plugins", "installed_plugins.json"),
  );
  if (installedRaw === null) return [];
  let installedJson: {
    plugins?: Record<string, ReadonlyArray<{ installPath: string; version: string }>>;
  };
  try {
    installedJson = JSON.parse(installedRaw);
  } catch {
    return [];
  }
  if (installedJson.plugins === undefined) return [];

  const marketplacesRaw = await readTextOrNull(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
  );
  let marketplacesJson: Record<
    string,
    { source?: { source?: string }; installLocation?: string }
  > | null = null;
  if (marketplacesRaw !== null) {
    try {
      marketplacesJson = JSON.parse(marketplacesRaw);
    } catch {
      marketplacesJson = null;
    }
  }

  const missing: MissingCacheEntry[] = [];
  for (const [key, entries] of Object.entries(installedJson.plugins)) {
    // key format: `<plugin>@<marketplace>`
    const at = key.lastIndexOf("@");
    if (at === -1) continue;
    const plugin = key.slice(0, at);
    const marketplace = key.slice(at + 1);

    // Only auto-suggest for directory-source marketplaces — git/github
    // sources do materialise the cache themselves.
    const mInfo = marketplacesJson?.[marketplace];
    if (mInfo?.source?.source !== "directory") continue;
    const installLocation = mInfo.installLocation;
    if (installLocation === undefined || installLocation.length === 0) continue;
    // Marketplace convention: plugins live at <installLocation>/plugins/<plugin>.
    // Confirmed in marketplace.json `source: ./plugins/<plugin>`.
    const sourcePath = join(installLocation, "plugins", plugin);
    const srcStat = await statOrNull(sourcePath);
    if (srcStat === null) continue; // can't symlink to something missing

    for (const e of entries) {
      const expected = join(home, ".claude", "plugins", "cache", marketplace, plugin, e.version);
      const st = await statOrNull(expected);
      if (st !== null) continue;
      missing.push({
        marketplace,
        plugin,
        version: e.version,
        cachePath: expected,
        sourcePath,
      });
    }
  }

  return missing.map((m) => ({
    status: "yellow" as const,
    label: "cursor-plugin-cache",
    detail: `${m.plugin}@${m.marketplace} not materialised at ${m.cachePath} — cursor-agent can't discover it`,
    hint: `mkdir -p ${join(m.cachePath, "..")} && ln -sfn ${m.sourcePath} ${m.cachePath}`,
  }));
}

// ---------- Check 7: orphan-sessions ----------

export interface CheckOrphanSessionsOpts {
  /** hasSession override (test injection). */
  hasSession?: (name: string) => Promise<boolean>;
}

export async function checkOrphanSessions(
  team: Team | null,
  opts: CheckOrphanSessionsOpts = {},
): Promise<DoctorRow[]> {
  if (team === null || team.singleSession !== true) return [];
  const rows: DoctorRow[] = [];
  rows.push({
    status: "yellow",
    label: "single-session-discouraged",
    detail: "team has singleSession=true — cage isolation (Phase 5) is the recommended path",
    hint: "set team.json:.singleSession=false; migration helper lands with V-25 + Phase 5",
  });
  const hasSession =
    opts.hasSession ??
    (async (name: string) => {
      const tmux = createTmux({ socketPath: resolveTeamSocket(team) });
      return await tmux.session.hasSession(name);
    });
  const teamSession = `atmux-${team.name}`;
  if (await hasSession(teamSession)) {
    rows.push({
      status: "yellow",
      label: "orphan-session",
      detail: `team is single-session but legacy session '${teamSession}' still exists`,
      hint: `kill it: tmux kill-session -t ${teamSession}`,
    });
  }
  return rows;
}

// ---------- ADR-057 §D5a: submodule pointer integrity ----------

/** Spawn a single git command from cwd. Test injection point. */
export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

const defaultGitSpawn: GitSpawn = (argv) =>
  defaultSpawn({ cmd: "git", argv, expectExitCode: "any", timeoutMs: 15_000 });

/** Per-submodule status entry parsed from `git submodule status`. */
export interface SubmoduleStatus {
  /** Path relative to repo root (e.g. `vendor/x`). */
  path: string;
  /** SHA recorded in the parent commit. */
  recordedSha: string;
  /** ` ` (clean), `+` (HEAD mismatch), `-` (uninitialized), `U` (conflict). */
  state: " " | "+" | "-" | "U";
}

/**
 * Parse `git submodule status` output. Each line is either:
 *
 *   ` <40-hex> <path> [(<describe>)]`     — clean
 *   `+<40-hex> <path> [(<describe>)]`     — HEAD doesn't match recorded SHA
 *   `-<40-hex> <path>`                    — uninitialized
 *   `U<40-hex> <path>`                    — merge conflict
 *
 * Lines that don't fit the shape are skipped (defensive against future
 * git output changes; we'd rather emit no finding than a false positive).
 */
export function parseSubmoduleStatus(stdout: string): SubmoduleStatus[] {
  const out: SubmoduleStatus[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    const prefix = raw[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-" && prefix !== "U") continue;
    const rest = raw.slice(1);
    const m = rest.match(/^([0-9a-f]{40})\s+(\S+)/);
    if (m === null) continue;
    out.push({
      state: prefix,
      recordedSha: m[1] ?? "",
      path: m[2] ?? "",
    });
  }
  return out;
}

export interface CheckSubmoduleIntegrityOpts {
  /** git spawn override (test injection). */
  git?: GitSpawn;
}

/**
 * D5a: submodule pointer integrity. Runs `git submodule status` from the
 * cwd and emits one P2 (yellow) row per mismatched / uninitialized /
 * conflicted submodule. No submodules → no rows. Non-git cwd → no rows
 * (silent — `git submodule status` exits 0 with no stdout outside a repo
 * with submodules; outside a repo entirely it exits non-zero with stderr
 * which we treat as "skip").
 *
 * The check is on the OUTER repo (atmux's cwd). Submodules-of-submodules
 * are NOT recursed by default — the operator's cron-groom invokes
 * `atmux doctor --json` per tick, and recursion would amplify the noise.
 */
export async function checkSubmoduleIntegrity(
  opts: CheckSubmoduleIntegrityOpts = {},
): Promise<DoctorRow[]> {
  const git = opts.git ?? defaultGitSpawn;
  const r = await git(["submodule", "status"]);
  if (r.exitCode !== 0) return [];
  const statuses = parseSubmoduleStatus(r.stdout);
  const rows: DoctorRow[] = [];
  for (const s of statuses) {
    if (s.state === " ") continue;
    const detail =
      s.state === "+"
        ? `${s.path} HEAD doesn't match recorded ${s.recordedSha.slice(0, 7)}`
        : s.state === "-"
          ? `${s.path} not initialized (recorded ${s.recordedSha.slice(0, 7)})`
          : `${s.path} merge conflict (recorded ${s.recordedSha.slice(0, 7)})`;
    const hint =
      s.state === "+"
        ? `cd ${s.path} && git checkout ${s.recordedSha.slice(0, 7)}  (or commit the bump in the parent)`
        : s.state === "-"
          ? "git submodule update --init --recursive"
          : "resolve the merge conflict in the submodule, then commit the parent";
    rows.push({
      status: "yellow",
      label: "submodule-integrity",
      detail,
      hint,
    });
  }
  return rows;
}

// ---------- ADR-064 §4: driver-pane-state ----------

/** Test injection points for `checkDriverPaneState`. The probe layer
 *  itself is already injectable; this just lets the doctor caller
 *  forward those overrides cleanly. */
export interface CheckDriverPaneStateOpts {
  probeDeps?: ProbeDriverPaneDeps;
  /** Override the probe entirely (single-shot fixture for the check). */
  probe?: (team: Team, atmuxDir: string) => Promise<DriverPaneHealth>;
}

/**
 * ADR-064 §4 + §OQ3 — surface the driver pane's live state as a
 * doctor row. Severity mapping:
 *
 *   - configured=false                                  → no row
 *   - configured=true, windowExists=false               → yellow ("config drift")
 *   - configured=true, state ∈ {READY, TYPING}          → green
 *   - configured=true, state ∈ {RATE-LIMIT, MODAL, COMPACTING} → yellow ("driver pane stuck")
 *   - configured=true, state ∈ {SHELL, UNKNOWN, null}   → yellow ("unexpected state")
 *
 * Single label across all rows: `driver-pane-state`.
 */
export async function checkDriverPaneState(
  team: Team | null,
  atmuxDir: string,
  opts: CheckDriverPaneStateOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const probe = opts.probe ?? ((t, dir) => probeDriverPane(t, dir, opts.probeDeps));
  const health = await probe(team, atmuxDir);

  if (!health.configured) return [];

  if (!health.windowExists) {
    return [
      {
        status: "yellow",
        label: "driver-pane-state",
        detail: "team has driverSession set but no live driver window",
        hint: "run atmux start",
      },
    ];
  }

  if (health.state === "READY" || health.state === "TYPING" || health.state === "BUSY") {
    // BUSY is a healthy transient — the agent is mid-think; turn will
    // complete and pane returns to READY. Treated as green alongside
    // READY/TYPING per ADR-080 §C.
    return [
      {
        status: "green",
        label: "driver-pane-state",
        detail: `state=${health.state}`,
      },
    ];
  }

  if (health.state === null) {
    return [
      {
        status: "yellow",
        label: "driver-pane-state",
        detail: "driver pane capture returned no signal",
        hint: "check tmux server health",
      },
    ];
  }

  if (health.state === "RATE-LIMIT" || health.state === "MODAL" || health.state === "COMPACTING") {
    const evidence = truncateEvidence(health.evidence, 60);
    return [
      {
        status: "yellow",
        label: "driver-pane-state",
        detail: `driver pane stuck in ${health.state}${evidence === "" ? "" : ` (${evidence})`}`,
        hint:
          health.state === "RATE-LIMIT"
            ? "wait for budget refresh"
            : health.state === "MODAL"
              ? "answer the modal in the driver pane"
              : "wait for compaction to finish",
      },
    ];
  }

  // SHELL / UNKNOWN — pane fell back to a shell or pattern catalog
  // didn't match anything. Yellow so the operator investigates.
  const evidence = truncateEvidence(health.evidence, 60);
  return [
    {
      status: "yellow",
      label: "driver-pane-state",
      detail: `driver pane in unexpected state=${health.state}${evidence === "" ? "" : ` (${evidence})`}`,
      hint: "check the driver pane manually",
    },
  ];
}

function truncateEvidence(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- ADR-057 §D5c: inbox-mark verification ----------

/** Marker pattern emitted by lead in driver-inbox: `📤 task <id>`.
 *  ID is whatever the kanban issued (current shape `t-<8 hex>`); we
 *  match conservatively on `t-` + word-chars to tolerate id-shape
 *  evolution without rewriting the regex. */
const INBOX_TASK_MARKER_RE = /📤\s+task\s+(t-[A-Za-z0-9]+)/g;

/** One orphan finding — a task id mentioned in driver-inbox that the
 *  kanban no longer knows about. */
export interface InboxMarkOrphan {
  /** The mentioned task id. */
  id: string;
  /** Snippet of the entry head where the marker appeared. */
  entryHead: string;
}

/**
 * Scan a driver-inbox body for `📤 task <id>` markers and return the set
 * of (id, entry-head) pairs. Used by checkInboxMarks; pure for testability.
 */
export function findInboxTaskMarks(body: string, nowEpochSec: number): InboxMarkOrphan[] {
  const entries = parseDriverInboxEntries(body, nowEpochSec);
  const found: InboxMarkOrphan[] = [];
  for (const e of entries) {
    if (!isInOpenSection(e, body)) continue;
    for (const m of e.body.matchAll(INBOX_TASK_MARKER_RE)) {
      const id = m[1];
      if (id === undefined) continue;
      found.push({ id, entryHead: e.head });
    }
  }
  return found;
}

/** True when the entry head appears under `## Open` and BEFORE any
 *  `## Archive` section. The driver-inbox convention is a top-level
 *  Open / Archive split; archived entries are out of scope per the
 *  brief ("scans driver-inbox `## Open`"). */
function isInOpenSection(entry: DriverInboxEntry, body: string): boolean {
  const headIdx = body.indexOf(entry.head);
  if (headIdx === -1) return true; // defensive — surface rather than skip
  const openIdx = body.search(/^##\s+Open\b/m);
  const archiveIdx = body.search(/^##\s+Archive\b/m);
  // No section markers at all → treat the whole file as Open.
  if (openIdx === -1 && archiveIdx === -1) return true;
  // Archive starts before Open OR no Open marker → only entries before
  // archiveIdx count.
  if (openIdx === -1) return archiveIdx === -1 ? true : headIdx < archiveIdx;
  // Standard layout: Open then Archive. Entry must be after Open marker
  // AND (no Archive yet OR before Archive).
  if (headIdx < openIdx) return false;
  if (archiveIdx === -1) return true;
  return headIdx < archiveIdx;
}

export interface CheckInboxMarksOpts {
  /** epoch-seconds for resolving undated entry heads. Default `Date.now()`. */
  nowEpochSec?: number;
}

/**
 * D5c: scan `## Open` for `📤 task <id>` markers; emit one P3 (yellow)
 * row per id NOT present in kanban.tasks[] (orphan). Absent inbox /
 * absent kanban → no rows (the precondition for orphan detection isn't
 * met, not a finding).
 */
export async function checkInboxMarks(
  atmuxDir: string,
  opts: CheckInboxMarksOpts = {},
): Promise<DoctorRow[]> {
  const inboxBody = await readTextOrNull(driverInboxPath(atmuxDir));
  if (inboxBody === null || inboxBody.length === 0) return [];
  const kanban = await tryReadJson(kanbanJsonPath(atmuxDir), Kanban);
  if (kanban === null) return [];
  const knownIds = new Set(kanban.tasks.map((t) => t.id));
  const nowEpochSec = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const marks = findInboxTaskMarks(inboxBody, nowEpochSec);
  const rows: DoctorRow[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    if (knownIds.has(m.id)) continue;
    if (seen.has(m.id)) continue; // dedup multiple mentions of the same orphan id
    seen.add(m.id);
    rows.push({
      status: "yellow",
      label: "inbox-mark-orphan",
      detail: `driver-inbox marks ${m.id} done but it's not in kanban (entry: ${truncate(m.entryHead, 60)})`,
      hint: "remove the 📤 marker if the entry is no longer relevant, or restore the task",
    });
  }
  return rows;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------- Render ----------

const STATUS_GLYPH: Record<DoctorStatus, string> = {
  green: "✅",
  yellow: "⚠️ ",
  red: "❌",
  info: "ℹ️ ",
};

export function renderHuman(report: DoctorReport): string {
  const lines: string[] = ["", "🩺 atmux doctor — environment check", ""];
  for (const row of report.rows) {
    const label = row.label.padEnd(22);
    const detail = row.detail ?? "";
    lines.push(`  ${STATUS_GLYPH[row.status]} ${label} ${detail}`);
    if (row.status !== "green" && row.hint !== undefined && row.hint !== "") {
      lines.push(`     → ${row.hint}`);
    }
  }
  lines.push("");
  if (report.redCount === 0 && report.yellowCount === 0) {
    lines.push("  ✅ all green");
  } else if (report.redCount === 0) {
    lines.push(`  ⚠️  ${report.yellowCount} warning(s), no blockers`);
  } else {
    lines.push(`  ❌ ${report.redCount} issue(s) — run with --fix to remediate`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

export function renderJson(report: DoctorReport): string {
  return `${JSON.stringify(
    {
      red: report.redCount,
      yellow: report.yellowCount,
      checks: report.rows.map((r) => ({
        status: r.status,
        label: r.label,
        detail: r.detail ?? "",
        hint: r.hint ?? "",
      })),
    },
    null,
    2,
  )}\n`;
}

// ---------- ADR-082 W5: worktree-isolation check (4 anomaly classes) ----------

export interface CheckWorktreeOpts {
  /** Git spawn override (test injection). Default uses `defaultGitSpawn`
   *  from `abstractions/worktree.ts`. */
  gitSpawn?: GitSpawn;
  /** Readdir override (test injection). Default `node:fs/promises::readdir`
   *  with `withFileTypes: true`. Returning `null` simulates ENOENT — the
   *  worktrees directory not existing yet. */
  readWorktreeDir?: (
    path: string,
  ) => Promise<ReadonlyArray<{ name: string; isDirectory: boolean }> | null>;
}

interface PorcelainWorktree {
  /** Absolute path of the worktree, as reported by `git worktree list --porcelain`. */
  path: string;
  /** Checked-out branch (without `refs/heads/` prefix). Empty when detached HEAD. */
  branch: string;
}

/**
 * ADR-082 §5 — surface 4 anomaly classes for `worktreeIsolation: true`
 * teams + 1 cleanup-suggestion for legacy teams with leftover state.
 *
 * Classes:
 *   1. `worktree-missing`         — isolation on; member has no worktree dir.
 *                                    RED. Auto-fix hint: re-run `atmux start` (the
 *                                    W3 provisioning step is idempotent — reruns
 *                                    create the missing worktree only).
 *   2. `worktree-orphan`           — isolation on; dir under `<atmuxDir>/worktrees/`
 *                                    isn't matched by any `team.members[].name`.
 *                                    YELLOW. Hint: `git worktree remove` (or
 *                                    `atmux doctor --fix` once V-24 wires the
 *                                    auto-fix branch).
 *   3. `worktree-wrong-branch`     — worktree on a different branch than its
 *                                    per-member fork `${base}-${member}` (ADR-084).
 *                                    YELLOW. Surface only — no auto-checkout
 *                                    (operator-edited state may carry unstashed
 *                                    work; same rule as W1's `provisionWorktree`
 *                                    wrong-branch throw).
 *   4. `worktree-disabled-but-present` — isolation OFF (or unset) but
 *                                    `<atmuxDir>/worktrees/` has entries. Single
 *                                    YELLOW (not per-orphan — the cleanup is
 *                                    a batch operation). Hint: flip
 *                                    `worktreeIsolation: true` to resume
 *                                    management, OR `rm -rf` to discard.
 *   5. `worktree-branch-orphan`    — isolation on; a `${base}-*` branch exists
 *                                    whose suffix matches no current
 *                                    `team.members[].name` (sanitized). INFO
 *                                    (no count toward pass/fail). Hint: safe
 *                                    auto-delete via `--fix` when 0 commits
 *                                    ahead of base; surface-only with manual
 *                                    review when commits are unmerged. ADR-084
 *                                    §"Doctor probe update" — branches are left
 *                                    in place by `stop --force` per OQ-2
 *                                    default; over time they accumulate.
 *
 * Pure modulo IO — every IO call gated through `opts` for tests. When
 * `team === null` (team.json failed to load), returns empty: the
 * `checkTeam` row already surfaced the broken state.
 */
export async function checkWorktreeIsolation(
  team: Team | null,
  atmuxDir: string,
  opts: CheckWorktreeOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const readDir = opts.readWorktreeDir ?? defaultReadWorktreeDir;
  const worktreesDir = join(atmuxDir, "worktrees");
  const entries = await readDir(worktreesDir);

  const isolation = team.worktreeIsolation === true;
  const memberNames = new Set(team.members.map((m) => m.name));
  const subdirs = entries === null ? [] : entries.filter((e) => e.isDirectory).map((e) => e.name);

  // Class 4 — isolation off but entries present. Single row.
  if (!isolation) {
    if (subdirs.length === 0) return [];
    return [
      {
        status: "yellow",
        label: "worktree:disabled-but-present",
        detail: `${subdirs.length} dir(s) under ${worktreesDir} despite worktreeIsolation !== true`,
        hint: "flip team.json `worktreeIsolation: true` to resume management, or `rm -rf` to discard",
      },
    ];
  }

  // Classes 1 + 2 — present-set delta against the team roster.
  const presentSet = new Set(subdirs);
  const rows: DoctorRow[] = [];

  // Class 1 — missing per member.
  for (const member of team.members) {
    if (!presentSet.has(member.name)) {
      const expected = resolveWorktreePath(team, member.name, atmuxDir);
      rows.push({
        status: "red",
        label: `worktree:missing:${member.name}`,
        detail: `expected ${expected}`,
        hint: "re-run `atmux start` (W3 provisioning is idempotent — creates only the missing worktrees)",
      });
    }
  }

  // Class 2 — orphan per directory not in the roster.
  for (const name of subdirs) {
    if (!memberNames.has(name)) {
      rows.push({
        status: "yellow",
        label: `worktree:orphan:${name}`,
        detail: `${join(worktreesDir, name)} not in team.members[].name`,
        hint: "remove via `git worktree remove` (or wait on `atmux doctor --fix` per V-24)",
      });
    }
  }

  // Class 3 — wrong-branch per managed worktree. ONE shared `git worktree
  // list --porcelain` + `git branch --show-current` invocation pair
  // services every member; if either git call fails the entire wrong-
  // branch detection degrades to a yellow advisory rather than blocking
  // the rest of the doctor pass. Members whose worktrees we couldn't
  // resolve (missing — class 1) are skipped naturally.
  const present = team.members.filter((m) => presentSet.has(m.name));
  if (present.length > 0) {
    const git = opts.gitSpawn ?? defaultGitSpawn;
    // Match start.ts / stop.ts projectRoot resolution: regex-strip
    // a trailing `/.atmux/?`.
    const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
    const branchR = await git(["-C", projectRoot, "branch", "--show-current"]);
    const expectedBranch = branchR.exitCode === 0 ? branchR.stdout.trim() : "";
    const listR = await git(["-C", projectRoot, "worktree", "list", "--porcelain"]);
    if (branchR.exitCode !== 0 || listR.exitCode !== 0 || expectedBranch.length === 0) {
      rows.push({
        status: "yellow",
        label: "worktree:branch-probe-skipped",
        detail:
          branchR.exitCode !== 0 || listR.exitCode !== 0
            ? `git probe failed (rc=${branchR.exitCode}/${listR.exitCode})`
            : "operator on detached HEAD — no current branch to compare against",
        hint: "wrong-branch detection skipped; manually verify worktree branches if isolation is critical",
      });
    } else {
      const parsed = parsePorcelainWorktrees(listR.stdout);
      for (const member of present) {
        const wt = resolveWorktreePath(team, member.name, atmuxDir);
        const found = parsed.find((p) => p.path === wt);
        if (found === undefined) {
          // Directory exists on disk but isn't a managed git worktree.
          // Could be a stale dir from a prior abort. Surface as yellow.
          rows.push({
            status: "yellow",
            label: `worktree:not-managed:${member.name}`,
            detail: `${wt} exists on disk but isn't registered with git worktree list`,
            hint: "remove the directory or re-provision via `atmux start`",
          });
          continue;
        }
        // ADR-084: each member's worktree is provisioned on its own
        // per-member branch `${baseBranch}-${sanitize(memberName)}`.
        // Anything else (a different branch, detached HEAD, or operator-
        // attached state) is drift.
        const expectedWtBranch = `${expectedBranch}-${sanitizeBranchSegment(member.name)}`;
        if (found.branch !== expectedWtBranch) {
          const stateLabel = found.branch === "" ? "detached HEAD" : `branch '${found.branch}'`;
          rows.push({
            status: "yellow",
            label: `worktree:wrong-branch:${member.name}`,
            detail: `on ${stateLabel}, expected branch '${expectedWtBranch}' (per-member fork off '${expectedBranch}')`,
            hint: `reconcile via \`git -C <wt> checkout ${expectedWtBranch}\` — auto-checkout disabled per ADR-082 §3 (unstashed work at risk)`,
          });
        }
      }
    }
  }

  // Class 5 (ADR-084 W2 / branch-orphan) — surface stranded `${base}-*`
  // branches whose suffix isn't a current member. Independent from the
  // worktree state above: branches outlive worktrees (per ADR-084 OQ-2
  // default, `stop --force` prunes the worktree but keeps the branch).
  // Resolves baseBranch independently so the probe runs even when no
  // managed worktrees are present (the worktree might already be gone;
  // it's the leftover BRANCH we're surfacing).
  const git2 = opts.gitSpawn ?? defaultGitSpawn;
  const projectRoot2 = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
  const baseR = await git2(["-C", projectRoot2, "branch", "--show-current"]);
  const baseBranch = baseR.exitCode === 0 ? baseR.stdout.trim() : "";
  if (baseBranch.length > 0) {
    const listR = await git2(["-C", projectRoot2, "branch", "--list", `${baseBranch}-*`]);
    if (listR.exitCode === 0) {
      const sanitizedMembers = new Set(team.members.map((m) => sanitizeBranchSegment(m.name)));
      const prefix = `${baseBranch}-`;
      // `git branch --list <pat>` rows are 2-space indented; current
      // branch (impossible for an orphan but defensive) prefixes `* `.
      const branchNames = listR.stdout
        .split("\n")
        .map((line) => line.replace(/^[\s*+]+/, "").trim())
        .filter((line) => line.length > 0 && line.startsWith(prefix));
      for (const branchName of branchNames) {
        const suffix = branchName.slice(prefix.length);
        if (sanitizedMembers.has(suffix)) continue;
        // Orphan: count unmerged commits relative to base.
        const countR = await git2([
          "-C",
          projectRoot2,
          "rev-list",
          "--count",
          `${baseBranch}..${branchName}`,
        ]);
        const aheadRaw = countR.exitCode === 0 ? countR.stdout.trim() : "";
        const aheadCount = /^\d+$/.test(aheadRaw) ? parseInt(aheadRaw, 10) : null;
        if (aheadCount === null) {
          rows.push({
            status: "info",
            label: `worktree:branch-orphan:${suffix}`,
            detail: `${branchName} — unmerged-count probe failed (rc=${countR.exitCode})`,
            hint: `manually verify before deletion: \`git log ${baseBranch}..${branchName}\``,
          });
        } else if (aheadCount === 0) {
          rows.push({
            status: "info",
            label: `worktree:branch-orphan:${suffix}`,
            detail: `${branchName} — 0 commits ahead of ${baseBranch} (safe to delete)`,
            hint: `\`atmux doctor --fix\` would prune it (dry-run today); manual: \`git branch -d ${branchName}\``,
          });
        } else {
          rows.push({
            status: "info",
            label: `worktree:branch-orphan:${suffix}`,
            detail: `${branchName} — ${aheadCount} commit(s) ahead of ${baseBranch} (unmerged work)`,
            hint: `review before deletion: \`git log ${baseBranch}..${branchName}\``,
          });
        }
      }
    }
  }

  return rows;
}

async function defaultReadWorktreeDir(
  path: string,
): Promise<ReadonlyArray<{ name: string; isDirectory: boolean }> | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: String(e.name), isDirectory: e.isDirectory() }));
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function parsePorcelainWorktrees(stdout: string): PorcelainWorktree[] {
  // `git worktree list --porcelain` emits blocks separated by blank lines:
  //   worktree <path>
  //   HEAD <sha>
  //   branch refs/heads/<name>    (or `detached`)
  const out: PorcelainWorktree[] = [];
  for (const block of stdout.split("\n\n")) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    if (wtLine === undefined) continue;
    const path = wtLine.slice("worktree ".length);
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine === undefined ? "" : branchLine.slice("branch refs/heads/".length);
    out.push({ path, branch });
  }
  return out;
}

// ---------- Public verb entry ----------

export interface DoctorOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Inject the underlying check executors (test override). */
  runChecks?: (atmuxDir: string, team: Team | null) => Promise<DoctorRow[]>;
}

/** Default chain — all in-scope checks invoked in bash main() order. */
export async function runAllChecks(atmuxDir: string, team: Team | null): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  rows.push(...checkDeps());
  rows.push(...(await checkTeam(atmuxDir)));
  if (team !== null) {
    rows.push(...checkTuis(team));
  }
  rows.push(...(await checkStateDir(atmuxDir)));
  rows.push(...(await checkWebhook(team)));
  rows.push(...(await checkPhantomInboxes(atmuxDir)));
  // t-af159454: phantom in-progress claims (kanban rows with dead
  // owner panes). Distinct vulnerability class from phantom-inbox
  // above (that one scans JSON inbox files; this scans the live
  // kanban). Cage-only — singleSession teams short-circuit in the
  // check itself.
  rows.push(...(await checkPhantomInProgressClaims(atmuxDir, team)));
  // Cursor-plugin-cache parity — only fires when cursor-agent is
  // installed AND there's at least one directory-source marketplace
  // plugin missing its `~/.claude/plugins/cache/<m>/<p>/<v>` entry.
  rows.push(...(await checkCursorPluginCache()));
  rows.push(...(await checkOrphanSessions(team)));
  // ADR-054 §D4: surface whip-config drift so the operator doesn't
  // need to wait for the next whip tick to learn about it.
  rows.push(...(await checkWhipConfigDrift(atmuxDir)));
  // ADR-057 §D5a: submodule pointer integrity (P2 finding per mismatch).
  rows.push(...(await checkSubmoduleIntegrity()));
  // ADR-057 §D5c: inbox-mark verification (P3 finding per orphan id).
  rows.push(...(await checkInboxMarks(atmuxDir)));
  // ADR-064 §4: driver-pane health (no row when team unconfigured).
  rows.push(...(await checkDriverPaneState(team, atmuxDir)));
  // ADR-079 §A: cron interval values must be divisors of 60 (minutes)
  // or 24 (hours). Yellow per offender; surfaces before atmux start.
  rows.push(...checkCronIntervalDivisors(team));
  // ADR-083 follow-up §DEFERRED row 2: cron-orphans — yellow per
  // marker block whose `ATMUX_DIR=` path no longer exists on disk
  // (moved / deleted projects). Silent on hosts without crontab.
  rows.push(...(await checkCronOrphans()));
  // t-dcbff97c §2: RED when team opts into cron-auto-install but no
  // managed block is present. Catches the failure mode that killed the
  // atmux team three consecutive overnights (cron block silently absent
  // → no whip pulse → lead stalls). Silent on opt-out + cron-less hosts.
  rows.push(...(await checkCronBlock(team)));
  // t-589145dc (c-alias Ask C, ADR-094): YELLOW when tuiCommands.claude
  // pins the DEFAULT CLAUDE_CONFIG_DIR — breaks fresh-spawn TUI auth
  // (forces OAuth re-run in every nested shell). Silent when claude is
  // absent or uses a non-default suffix.
  rows.push(...checkTuiCommandsClaudeOverride(team));
  // ADR-082 §5 W5: per-member worktree-isolation anomalies. Returns
  // empty when team is null (checkTeam already surfaced the broken
  // state) or when isolation is off AND no leftover dirs exist.
  rows.push(...(await checkWorktreeIsolation(team, atmuxDir)));
  return rows;
}

/** `atmux doctor [--quiet|-q] [--fix] [--json]`. Returns 0 on green, 1 on red. */
export async function doctor(argv: ReadonlyArray<string>, opts: DoctorOpts = {}): Promise<number> {
  const parsed = parseDoctorArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  // Try to load the team — if it's missing/invalid, checkTeam will emit
  // the red row; downstream checks that need team handle null defensively.
  let team: Team | null = null;
  try {
    team = await tryLoadTeam(dirOpts);
  } catch {
    team = null;
  }

  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;
  const runChecks = opts.runChecks ?? runAllChecks;

  const rows = await runChecks(atmuxDir, team);
  const report = buildReport(rows);

  if (parsed.json) {
    stdout(renderJson(report));
  } else if (!parsed.quiet) {
    stderr(renderHuman(report));
  }

  // --fix surfaces dry-run branch-orphan summary (deferred per ADR-019)
  // AND runs the phantom in-progress prune (t-af159454 — operator can
  // collapse the 5 cited phantom IDs in one shot). Branch deletion +
  // team.json wizard re-run remain stubbed pending ADR-019 §"Fix"
  // resolution.
  if (parsed.fix && !parsed.quiet) {
    const safeOrphans = collectSafeOrphanBranches(report.rows);
    if (safeOrphans.length > 0) {
      stderr(
        `\natmux doctor --fix (dry-run): would delete ${safeOrphans.length} orphan branch(es):\n`,
      );
      for (const branch of safeOrphans) {
        stderr(`  - ${branch}\n`);
      }
    }
    if (team !== null && team.singleSession !== true) {
      const phantoms = await findPhantomInProgressClaims({
        atmuxDir,
        team,
        liveMembers: () => probeLiveMembers(team),
      });
      if (phantoms.length > 0) {
        const asOfIso = formatPruneIso(Date.now());
        const result = await prunePhantomInProgressClaims({
          atmuxDir,
          phantoms,
          asOfIso,
          source: "doctor-fix",
        });
        stderr(
          `\natmux doctor --fix: pruned ${result.prunedIds.length} phantom in-progress claim(s)` +
            (result.alreadyPrunedIds.length > 0
              ? ` (+${result.alreadyPrunedIds.length} already-pruned)`
              : "") +
            ":\n",
        );
        for (const id of result.prunedIds) stderr(`  - ${id} → blocked (${asOfIso})\n`);
      }
    }
    // Other --fix paths (branch-orphan deletion, team.json wizard
    // re-run) remain deferred per ADR-019 V-24. Phantom-prune above
    // ships in t-af159454; the residual hint covers the rest.
    stderr(
      "\natmux doctor --fix: V-24 ships read-only checks; --fix actions deferred per ADR-019.\n",
    );
  }

  return report.redCount === 0 ? 0 : 1;
}

/**
 * Extract orphan-branch names safe to auto-delete from the doctor row set.
 * "Safe" == 0 commits ahead of base (info row carries `(safe to delete)` in
 * its `detail`). Used by the `--fix` dry-run summary; deletion itself is
 * deferred per ADR-019 V-24.
 */
export function collectSafeOrphanBranches(rows: ReadonlyArray<DoctorRow>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.label.startsWith("worktree:branch-orphan:")) continue;
    if (r.status !== "info") continue;
    if (r.detail === undefined) continue;
    if (!r.detail.includes("safe to delete")) continue;
    // detail shape: "<branch> — 0 commits ahead of <base> (safe to delete)"
    const dash = r.detail.indexOf(" — ");
    const branch = dash >= 0 ? r.detail.slice(0, dash) : r.detail;
    out.push(branch);
  }
  return out;
}

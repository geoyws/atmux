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

import { existsSync as fsExistsSync } from "node:fs";
import { readlink as fsReadlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CrontabIO, defaultCrontabIO } from "../abstractions/crontab.ts";
import { resolveWebhookUrl } from "../abstractions/discord.ts";
import { announceHonkerState } from "../abstractions/events.ts";
import { exists, readTextOrNull, removeFile, statOrNull, writeText } from "../abstractions/fs.ts";
import { bootHonker, type HonkerHooks, type HonkerRuntimeState } from "../abstractions/honker.ts";
import { probeStatus } from "../abstractions/http.ts";
import { tryReadJson } from "../abstractions/json.ts";
import { isDefaultMemberRole } from "../abstractions/member-roles.ts";
import { resolveDayFilePath } from "../abstractions/release-notes.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { closeDatabase, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { mytDate, now } from "../abstractions/time.ts";
import { createTmux } from "../abstractions/tmux.ts";
import { resolveWorktreePath, sanitizeBranchSegment } from "../abstractions/worktree.ts";
import {
  type CageHealth,
  type CageState,
  probeCageState as defaultProbeCageState,
  STARVING_THRESHOLD_S as STARVING_THRESHOLD_S_LOCAL,
} from "../core/cage-state.ts";
import { type LoadedCockpit, loadCockpit, resolveCageSessionName } from "../core/cockpit.ts";
import {
  buildWindowName,
  buildWindowName,
  buildWindowNameLegacy,
  defaultEmojiForRole,
  driverInboxPath,
  getAtmuxDir,
  kanbanJsonPath,
  type ResolveDirOpts,
  resolveTeamSocket,
  teamJsonPath,
  tryLoadTeam,
} from "../core/common.ts";
import { type CronBlockTarget, findCronOrphans } from "../core/cron.ts";
import {
  type DriverInboxEntry,
  parseEntries as parseDriverInboxEntries,
} from "../core/driver-inbox.ts";
import {
  type DriverPaneHealth,
  type ProbeDriverPaneDeps,
  probeDriverPane,
} from "../core/driver-pane-health.ts";
import {
  type HostPressureVerdict,
  type ProbeHostPressureDeps,
  probeHostPressure,
} from "../core/host-pressure.ts";
import { loadInbox } from "../core/inbox.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { inspectClaudeReadiness } from "../core/pane-readiness.ts";
import { classifyText } from "../core/pane-state.ts";
import {
  findPhantomInProgressClaims,
  formatPruneIso,
  prunePhantomInProgressClaims,
} from "../core/phantom-prune.ts";
import { KanbanRepo } from "../core/repositories/kanban-repo.ts";
import { resolveTmuxBin } from "../core/resolve-tmux-bin.ts";
import { DEFAULT_SEND_KEYS_FAILURES_LOG_REL } from "../core/safe-send.ts";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  type DriftReport,
} from "../core/whip-config-drift.ts";
import { UsageError } from "../errors.ts";
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
  const stateDb = join(atmuxDir, "state.db");
  // Malformed team.json → SchemaError out of tryLoadTeam. checkTeam already
  // surfaces the red row; phantom-inbox scan has no team roster to walk, so
  // treat unparseable identically to absent (return []). Without this catch,
  // `atmux doctor` crashes on a malformed team.json instead of emitting red.
  let team: Awaited<ReturnType<typeof tryLoadTeam>>;
  try {
    team = await tryLoadTeam({ dir: atmuxDir });
  } catch {
    return [];
  }
  if (team === null) return [];

  const liveIds = new Set<string>();
  if (await exists(stateDb)) {
    const db = openDatabase(stateDb, migrations);
    try {
      for (const t of new KanbanRepo(db).listTasks()) liveIds.add(t.id);
    } finally {
      closeDatabase(db);
    }
  } else {
    const kanban = await tryReadJson(kanbanJsonPath(atmuxDir), Kanban);
    if (kanban === null) return [];
    for (const t of kanban.tasks) liveIds.add(t.id);
  }

  const phantoms: PhantomEntry[] = [];
  for (const m of team.members) {
    const inbox = await loadInbox(atmuxDir, m.name);
    for (const e of inbox.inProgress) {
      if (!liveIds.has(e.id)) {
        phantoms.push({ member: m.name, id: e.id, subject: e.subject ?? "" });
      }
    }
  }
  return phantoms;
}

/** Legacy ADR-076 JSON inbox files on SQL-canonical teams mislead tools
 *  that read the path directly. Surface for `atmux cleanup inboxes --purge-legacy`. */
export async function findLegacyInboxJson(atmuxDir: string): Promise<string[]> {
  const stateDb = join(atmuxDir, "state.db");
  if (!(await exists(stateDb))) return [];
  const ibDir = join(atmuxDir, "inboxes");
  if (!(await exists(ibDir))) return [];
  const { readdir } = await import("node:fs/promises");
  const names: string[] = [];
  for (const name of await readdir(ibDir).catch(() => [] as string[])) {
    if (name.endsWith(".json")) names.push(name);
  }
  return names.sort();
}

export async function checkLegacyInboxJson(atmuxDir: string): Promise<DoctorRow[]> {
  const files = await findLegacyInboxJson(atmuxDir);
  if (files.length === 0) return [];
  const sample = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` (+${files.length - 3} more)` : "";
  return [
    {
      status: "yellow",
      label: "legacy-inbox-json",
      detail: `${files.length} stale .atmux/inboxes/*.json file(s) on SQL-canonical team (e.g. ${sample}${more})`,
      hint: "atmux cleanup inboxes --purge-legacy  (canonical inbox is state.db tasks + `atmux inbox <member>`)",
    },
  ];
}

// ---------- Honker substrate probe (ADR-202 §D11) ----------

/** Pure: map a HonkerRuntimeState into a doctor row. Exported for unit
 *  tests; the verb-side wrapper `checkHonker(atmuxDir)` boots + delegates. */
export function honkerStateRows(state: HonkerRuntimeState | null): DoctorRow[] {
  if (state === null) {
    return [
      {
        status: "info",
        label: "honker",
        detail: "boot not invoked (no state.db opened on this run)",
      },
    ];
  }
  if (state.loaded) {
    return [
      {
        status: "green",
        label: "honker",
        detail: `substrate loaded — extension at ${state.extensionPath ?? "<unknown>"}`,
      },
    ];
  }
  // loaded === false branches: kill-switch off vs explicit fallback
  if (state.fallbackReason === null) {
    return [
      {
        status: "info",
        label: "honker",
        detail: "kill-switch off (ATMUX_HONKER unset or off); poll-mode in effect",
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "honker",
      detail: `fallback mode — ${state.fallbackReason}`,
      hint:
        "extension binary not yet provisioned (install wizard ADR-200 §D6 ships this); " +
        "consumers fall through to poll-mode + cron-backstop sweep",
    },
  ];
}

/** Boot the Honker substrate against the team's state.db, announce
 *  via the events bus, and surface the runtime state as a doctor row.
 *  Tolerant of missing state.db (returns info row) — first-run hosts
 *  don't fail this probe. */
export async function checkHonker(atmuxDir: string, hooks: HonkerHooks = {}): Promise<DoctorRow[]> {
  const stateDb = join(atmuxDir, "state.db");
  if (!(await exists(stateDb))) {
    return [
      {
        status: "info",
        label: "honker",
        detail: "state.db absent (first-run or atmux init not invoked)",
      },
    ];
  }
  const db = openDatabase(stateDb, migrations);
  try {
    const state = bootHonker(db, hooks, announceHonkerState());
    return honkerStateRows(state);
  } finally {
    closeDatabase(db);
  }
}

// ---------- host-pressure probe (ADR-184 §Amendment 2026-05-21) ----------

/** Pure mapping. State-snapshot → doctor row. Tests inject verdicts to
 *  hit every branch without /proc reads. */
export function hostPressureRows(verdict: HostPressureVerdict): DoctorRow[] {
  if (verdict.skipped) {
    return [
      {
        status: "info",
        label: "host-pressure",
        detail: "probe skipped — non-Linux platform (gate inactive)",
      },
    ];
  }
  if (verdict.probe === null || verdict.thresholds === null) {
    // Linux but probe failed somehow — surface as info, don't block.
    return [
      {
        status: "info",
        label: "host-pressure",
        detail: "probe data unavailable",
      },
    ];
  }
  const loadCeil = verdict.probe.cpuCores * verdict.thresholds.maxLoadRatio;
  const memMb = verdict.probe.memAvailableMb;
  const memMbThreshold = verdict.thresholds.minMemMb;
  const baseDetail = [
    `load 15min ${verdict.probe.loadAvg15min.toFixed(2)} / ${loadCeil.toFixed(2)} ceil`,
    `mem ${memMb}MB / ${memMbThreshold}MB floor`,
    `${verdict.probe.cpuCores} cores`,
  ].join(" · ");
  if (verdict.ok) {
    return [
      {
        status: "green",
        label: "host-pressure",
        detail: `under threshold — ${baseDetail}`,
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "host-pressure",
      detail: `OVER threshold — ${baseDetail}`,
      hint:
        `${verdict.reasons.join("; ")} — spawn-epic will REFUSE until pressure drops. ` +
        `override: --force-spawn (use sparingly); tune: ATMUX_SPAWN_MAX_LOAD_RATIO + ATMUX_SPAWN_MIN_FREE_MB env.`,
    },
  ];
}

/** Verb-side wrapper — runs the live probe + maps to rows. Production
 *  default; tests inject `probeFn` to drive specific verdicts. */
export async function checkHostPressure(
  probeFn: (deps: ProbeHostPressureDeps) => Promise<HostPressureVerdict> = probeHostPressure,
): Promise<DoctorRow[]> {
  const verdict = await probeFn({});
  return hostPressureRows(verdict);
}

// ---------- atmux-skills-plugin probe (ADR-217 §D5) ----------

/** Inputs the pure state-mapper resolves to a doctor row. Exported so
 *  tests exercise every branch without filesystem I/O. */
export type SkillsPluginState =
  | { kind: "opted-out" }
  | { kind: "symlink-missing" }
  | { kind: "plugin-json-missing"; installPath: string }
  | { kind: "plugin-json-malformed"; installPath: string; reason: string }
  | { kind: "plugin-json-schema-fail"; installPath: string; reason: string }
  | { kind: "green"; installPath: string; pluginName: string };

/** Pure mapping. Same shape as `honkerStateRows` — keep the wrapper +
 *  state mapper paired so unit tests can hit every branch. */
export function skillsPluginStateRows(state: SkillsPluginState): DoctorRow[] {
  switch (state.kind) {
    case "opted-out":
      return [
        {
          status: "info",
          label: "atmux-skills-plugin",
          detail:
            "user opted out via wizard (marker present at ~/.atmux/state/skills-plugin-opted-out)",
        },
      ];
    case "symlink-missing":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: "skills plugin not installed at ~/.claude/plugins/atmux/",
          hint: "atmux init --skills-only  (or rerun the install wizard)",
        },
      ];
    case "plugin-json-missing":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: `plugin.json missing at ${state.installPath}/.claude-plugin/plugin.json`,
          hint: "atmux init --skills-only --force  (re-installs the bundled plugin)",
        },
      ];
    case "plugin-json-malformed":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: `plugin.json malformed at ${state.installPath} — ${state.reason}`,
          hint: "atmux init --skills-only --force  (overwrites with bundled manifest)",
        },
      ];
    case "plugin-json-schema-fail":
      return [
        {
          status: "yellow",
          label: "atmux-skills-plugin",
          detail: `plugin.json schema validation failed at ${state.installPath} — ${state.reason}`,
          hint: "atmux init --skills-only --force  (re-installs the bundled plugin)",
        },
      ];
    case "green":
      return [
        {
          status: "green",
          label: "atmux-skills-plugin",
          detail: `skills plugin installed at ${state.installPath} (plugin=${state.pluginName})`,
        },
      ];
  }
}

export interface CheckSkillsPluginOpts {
  /** Override $HOME for tests. */
  home?: string;
}

/** I/O wrapper. Resolves the install path under $HOME, probes for the
 *  opt-out marker first, then verifies the symlink + plugin.json. Returns
 *  the empty array when $HOME is unset (defensive — caller probably has
 *  bigger issues, no point emitting a doctor row about it). */
export async function checkSkillsPlugin(opts: CheckSkillsPluginOpts = {}): Promise<DoctorRow[]> {
  const home = opts.home ?? process.env.HOME;
  if (home === undefined || home.length === 0) return [];

  const optOutMarker = join(home, ".atmux", "state", "skills-plugin-opted-out");
  if (await exists(optOutMarker)) {
    return skillsPluginStateRows({ kind: "opted-out" });
  }

  // Canonical install path: real dir (operator dotfiles override) or
  // symlink to <atmux-source>/plugins/atmux/. Both count as "installed"
  // for the probe; the wizard step distinguishes for UX purposes.
  const installPath = join(home, ".claude", "plugins", "atmux");
  const st = await statOrNull(installPath);
  if (st === null || !st.isDirectory) {
    return skillsPluginStateRows({ kind: "symlink-missing" });
  }

  const manifestPath = join(installPath, ".claude-plugin", "plugin.json");
  const raw = await readTextOrNull(manifestPath);
  if (raw === null) {
    return skillsPluginStateRows({ kind: "plugin-json-missing", installPath });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return skillsPluginStateRows({
      kind: "plugin-json-malformed",
      installPath,
      reason: e instanceof Error ? e.message : String(e),
    });
  }
  // Minimal shape check on the keys the probe's green path depends on.
  // The Claude Code plugin-schema pin lives in the sibling integration
  // test (t-e57fe51e) — this probe stays cheap + tolerant of additive
  // schema fields so a CC schema bump doesn't flip every operator's row
  // yellow.
  if (parsed === null || typeof parsed !== "object") {
    return skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath,
      reason: "manifest is not an object",
    });
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    return skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath,
      reason: "missing or empty 'name' field",
    });
  }
  if (!Array.isArray(m.skills)) {
    return skillsPluginStateRows({
      kind: "plugin-json-schema-fail",
      installPath,
      reason: "'skills' field is not an array",
    });
  }
  return skillsPluginStateRows({
    kind: "green",
    installPath,
    pluginName: m.name,
  });
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
async function probeLiveMembers(team: Team, atmuxDir: string): Promise<ReadonlySet<string>> {
  try {
    const tmux = createTmux({ socketPath: resolveTeamSocket(team) });
    const session = await resolveCageSessionName({ name: team.name, root: dirname(atmuxDir) });
    if (!(await tmux.session.hasSession(session))) return new Set();
    const windows = await tmux.window.listWindows(session);
    const liveNames = new Set(windows.map((w) => w.name));
    const live = new Set<string>();
    for (const m of team.members) {
      // ADR-161 TR2: thread member.role so the expected name picks up
      // `_-prefix` for default members (team-lead / planner / reviewer
      // / ombudsman).
      const expected = buildWindowName(m.name, m.emoji, m.label, m.role);
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
    liveMembers: () => probeLiveMembers(team, atmuxDir),
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
      label: "poke-config-drift",
      detail: driftReport.catastrophic
        ? `team.json malformed — poke will use full safe defaults${firstSummary}`
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
 * **2026-05-24 post-ADR-233**: cron auto-install retired (orchd is the
 * runtime via Honker substrate). The probe now expects ZERO cron blocks
 * by default — `team.kanban.cronAutoInstall === false` is the canonical
 * post-cutover state and this probe is silent. The check is retained
 * for the deprecation window so teams that explicitly opt back in (via
 * `atmux cron-install`) get the safety net.
 *
 * Returns:
 * - `[]` when team is null (the team-shape row already surfaced).
 * - `[]` when `team.kanban.cronAutoInstall === false` — explicit opt-out
 *    (canonical post-ADR-233 state) or operator manages cron some other way.
 * - `[]` when `crontab` is not on the host (no PATH match); ADR-083
 *    posture is "skip gracefully on cron-less hosts."
 * - `[]` when the team's marker header (`# >>> atmux:team=<name> …`) is
 *    present anywhere in the current crontab.
 * - one RED row otherwise, hinting `atmux cron-install` (legacy path).
 *
 * RED (not YELLOW) because pre-ADR-233 the failure mode was overnight
 * team death — a GREEN doctor that hid a missing cron block was worse
 * than a noisy one. Post-ADR-233 the trigger is opt-in, so the row is
 * actionable only for operators who explicitly armed cron.
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

// ---------- ADR-081 §D: member cage-state ----------

/** Default seconds a pane can sit at the welcome screen before doctor
 *  flags it `starving` (vs the silent `bootstrapping` transient). 60s
 *  matches the ADR-081 §D spec — long enough that a fresh claude TUI
 *  has rendered its banner + had time to consume a same-spawn brief
 *  paste, short enough that a real starvation surfaces before the
 *  operator gives up and ssh's in. */
export const STARVING_THRESHOLD_S = STARVING_THRESHOLD_S_LOCAL;

/** ADR-081 §D classifier output, unified with `atmux status` per
 *  t-74273200 / c-8ecd3a61. The taxonomy is now four states
 *  ({@link CageState}): `down`, `bootstrapping`, `active`, `wedged`.
 *
 *  Doctor's row-surfacing policy still distinguishes "transient
 *  bootstrap" (silent, uptime ≤ {@link STARVING_THRESHOLD_S}) from
 *  "starving" (yellow, uptime > threshold) — but BOTH use the shared
 *  `bootstrapping` state label so `atmux status` + `atmux doctor`
 *  never disagree on a pane's state vocabulary again.
 *
 *  Pre-unification this type included `starving` as a separate state;
 *  that value is removed. Audits searching for "starving" should grep
 *  for the row label `welcome banner persistent` (preserved in the
 *  detail text) or the new shared `wedged` state. */
export type MemberCageState = CageState;

export interface MemberCageHealth extends CageHealth {}

/** Test-side injection points for {@link checkMemberCageStates}. */
export interface CheckMemberCageStatesOpts {
  /** Override the per-member probe — single-shot fixture covers each
   *  member's classification without spinning up a real tmux server. */
  probe?: (
    team: Team,
    member: TeamMember,
    sessionName: string,
    socketPath: string,
  ) => Promise<MemberCageHealth | null>;
  /** Override `STARVING_THRESHOLD_S`. Tests use a tiny value (e.g. 0s)
   *  to exercise the starving branch without sleeping; operators can
   *  pin a custom threshold via this opt (not yet exposed on the CLI). */
  starvingThresholdSec?: number;
  /** `tmux.session.hasSession` override (test injection). */
  hasSession?: (name: string, socketPath: string) => Promise<boolean>;
}

/**
 * ADR-081 §D: per-member cage-state check. For each declared member,
 * classify into `down` / `starving` / `bootstrapping` / `active` and
 * surface a yellow row only for the operator-actionable states
 * (`down` + `starving`). Mirrors the {@link checkDriverPaneState}
 * cadence — single label across all rows: `member-cage-state:<member>`.
 *
 * Skips silently when:
 *   - `team === null` (other checks already flagged the broken state)
 *   - team session doesn't exist (the session-down state is surfaced
 *     by other checks; per-member rows would just duplicate the noise)
 */
export async function checkMemberCageStates(
  team: Team | null,
  atmuxDir: string,
  opts: CheckMemberCageStatesOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  if (team.members.length === 0) return [];

  const socketPath = resolveTeamSocket(team);
  const sessionName = `atmux-${team.name}`;
  const threshold = opts.starvingThresholdSec ?? STARVING_THRESHOLD_S;

  // Skip when the session is down — other checks already cover that.
  const hasSession =
    opts.hasSession ??
    (async (name: string, sock: string) => {
      const tmux = createTmux({ socketPath: sock });
      return await tmux.session.hasSession(name);
    });
  if (!(await hasSession(sessionName, socketPath))) return [];

  const probe = opts.probe ?? defaultProbeMemberCage;

  const rows: DoctorRow[] = [];
  for (const member of team.members) {
    const health = await probe(team, member, sessionName, socketPath);
    if (health === null) continue; // probe declined (e.g. window missing AND member.tui shell-only)

    // t-74273200: row-surfacing policy applied AFTER the unified probe
    // so `atmux status` + `atmux doctor` agree on the underlying state
    // label. Doctor still distinguishes "transient bootstrap" (silent)
    // from "starving" (yellow) via the {@link STARVING_THRESHOLD_S}
    // uptime gate — but that's a PRESENTATION decision; the state
    // taxonomy itself stays 4-way (down / bootstrapping / active /
    // wedged) per the c-8ecd3a61 root cause.
    //
    // Row colours:
    //   - active        → silent (no row)
    //   - bootstrapping → silent when uptime ≤ threshold, yellow above
    //   - down          → always yellow
    //   - wedged        → always yellow (rate-limit / heartbeat stale)
    if (health.state === "active") continue;
    if (
      health.state === "bootstrapping" &&
      health.paneUptimeSec !== null &&
      health.paneUptimeSec < threshold
    ) {
      continue;
    }

    const label = `member-cage-state:${member.name}`;
    const evidence = truncateEvidence(health.evidence, 60);
    if (health.state === "down") {
      rows.push({
        status: "yellow",
        label,
        detail: `pane down — no \`claude\` in window ${health.windowName}`,
        hint: `attach + check the pane manually, or restart via \`atmux start --force\``,
      });
      continue;
    }
    if (health.state === "wedged") {
      // Differentiate the two wedged sub-causes for the operator's
      // first-look triage: rate-limit lockout (pane classifier saw
      // "hit your limit") vs heartbeat staleness (supervisor stopped
      // writing). The detail text reads the heartbeatAgeSec field as
      // the disambiguator — present means heartbeat-stale, absent
      // means rate-limit (probe order in cage-state.ts §4 vs §6).
      const cause =
        health.heartbeatAgeSec !== null && health.heartbeatAgeSec > 0
          ? `no whip activity for ${Math.floor(health.heartbeatAgeSec / 60)}min (heartbeat stale)`
          : "rate-limit / TUI hang (pane shows rate-limit banner)";
      rows.push({
        status: "yellow",
        label,
        detail: `wedged — claude alive in ${health.windowName} but ${cause}${evidence === "" ? "" : ` (${evidence})`}`,
        hint: `attach to investigate; rate-limit waits for budget refresh, hung TUI needs \`atmux rotate ${member.name}\``,
      });
      continue;
    }
    // state === "bootstrapping" AND uptime above threshold (or unknown)
    const upMin =
      health.paneUptimeSec !== null ? `${Math.floor(health.paneUptimeSec / 60)}min` : "unknown";
    rows.push({
      status: "yellow",
      label,
      detail: `welcome banner persistent — claude alive in ${health.windowName} but brief never landed (uptime ${upMin})${evidence === "" ? "" : ` (${evidence})`}`,
      hint: `run \`atmux doctor --fix\` to re-paste the brief, or \`--force\` to override if the member is intentionally idle`,
    });
  }

  return rows;
}

/** Default per-member probe. Delegates to the unified
 *  {@link defaultProbeCageState} in `core/cage-state.ts` so `atmux
 *  status` and `atmux doctor` never disagree on the state label (per
 *  c-8ecd3a61 / t-74273200). The wrapper threads `atmuxDir` through
 *  from `checkMemberCageStates`'s outer scope (where it's already
 *  known — we don't re-derive it inside the per-member loop).
 *
 *  Exposed as a named const so tests can stub it via
 *  {@link CheckMemberCageStatesOpts.probe}. */
const defaultProbeMemberCage = async (
  team: Team,
  member: TeamMember,
  _sessionName: string,
  _socketPath: string,
): Promise<MemberCageHealth | null> => {
  // The shared probe re-derives sessionName + socketPath from the team
  // config, so we don't need to pass them through. Tests inject the
  // probe directly via opts.probe and bypass this default.
  void _sessionName;
  void _socketPath;
  // `atmuxDir` is needed for heartbeat reads in the wedged ladder.
  // checkMemberCageStates threads it in via the outer scope; the
  // default-probe shape doesn't carry it, so we resolve it inline
  // from common.ts. Best-effort: heartbeat absence collapses to the
  // pane-only signal path.
  const atmuxDir = await getAtmuxDir();
  return defaultProbeCageState(team, member, atmuxDir);
};

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

// ---------- ADR-179 W6: merger-fan-in probe class ----------

/** ADR-179 §Decision-2+3+6: `team.merger` block, mirrored locally because
 *  this branch (geoyws-up-impl-2) implements W6 in parallel with sibling
 *  branches that own W3 (`merge-cycle` verb) and W4 (the canonical Zod
 *  block on `team.ts`). When the trunk merge lands, the schema-level
 *  `team.merger` is the source of truth; `Team.passthrough()` carries
 *  the runtime payload either way. This local type is the
 *  literal-union sibling-branch pattern from
 *  `feedback_test_impl_session_pattern_2026_05_14.md`. */
interface MergerConfig {
  enabled?: boolean;
  baseBranch?: string;
  stalenessHours?: number;
}

/** ADR-179 §Decision-6 default. The W4 Zod default lives at the schema
 *  layer; this constant is the read-site fallback so the probe runs
 *  identically pre- and post-trunk-merge. */
const DEFAULT_MERGER_STALENESS_HOURS = 24;

/** Extract `team.merger` via runtime cast — schema definition lives on
 *  the W4 sibling branch and merges in via trunk. Until then, `Team`'s
 *  `.passthrough()` carries the field but the static type omits it. */
function readMergerConfig(team: Team): MergerConfig | undefined {
  const raw = (team as unknown as { merger?: unknown }).merger;
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return raw as MergerConfig;
}

export interface CheckMergerFanInOpts {
  /** Git spawn override (test injection). */
  gitSpawn?: GitSpawn;
  /** Wall-clock "now" in epoch seconds. Default: `Date.now() / 1000`.
   *  Injected by tests so the staleness probe runs deterministically. */
  nowEpochSec?: () => number;
}

/**
 * ADR-179 §Decision-6 — surface 2 anomaly classes for the merger fan-in
 * policy. Both are pre-emptive: they flag misconfiguration / drift before
 * unattended fan-in silently stops working.
 *
 * Classes:
 *   1. `merger-branch-stale` — `team.merger.enabled === true` AND a
 *                              `${base}-<m>` branch has commits older
 *                              than `merger.stalenessHours`
 *                              (default 24h). YELLOW. Hint: run
 *                              `atmux merge-member <m>` manually. The
 *                              ADR-179 §Decision-6 auto-fix path (clean
 *                              base worktree + clean fast-forward) is
 *                              wired into `--fix` once the W3
 *                              `merge-cycle` verb merges into trunk;
 *                              until then the probe surfaces only.
 *   2. `merger-disabled-but-member-present` — `team.members[]` contains
 *                              a member with `role: "merger"` but
 *                              `team.merger.enabled !== true`. YELLOW.
 *                              Surface only — operator intent ambiguous
 *                              (might be a forgotten flip, might be an
 *                              opt-out keeping the brief for later).
 *                              Never auto-fixable.
 *
 * Pure modulo IO — every IO call gated through `opts` for tests. When
 * `team === null` (team.json failed to load), returns empty: the
 * `checkTeam` row already surfaced the broken state.
 */
export async function checkMergerFanIn(
  team: Team | null,
  atmuxDir: string,
  opts: CheckMergerFanInOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  const merger = readMergerConfig(team);
  const enabled = merger?.enabled === true;

  // Class 2 always evaluates — independent of enabled flag (the whole
  // point is to flag the inconsistency between role-present and
  // feature-off).
  const rows: DoctorRow[] = [];
  for (const member of team.members) {
    if (member.role !== "merger") continue;
    if (enabled) continue;
    rows.push({
      status: "yellow",
      label: `merger:disabled-but-member-present:${member.name}`,
      detail: `member '${member.name}' declares role=merger but team.merger.enabled !== true`,
      hint: "either flip `team.merger.enabled: true` to activate fan-in, or drop the role from team.json",
    });
  }

  // Class 1 only evaluates when the feature is opted in — staleness is
  // meaningless when fan-in is disabled by design.
  if (!enabled) return rows;

  const stalenessHours =
    typeof merger?.stalenessHours === "number" && merger.stalenessHours > 0
      ? merger.stalenessHours
      : DEFAULT_MERGER_STALENESS_HOURS;
  const nowSec = (opts.nowEpochSec ?? (() => Math.floor(Date.now() / 1000)))();
  const staleCutoffSec = nowSec - stalenessHours * 3600;

  const git = opts.gitSpawn ?? defaultGitSpawn;
  const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";

  // Resolve base — `merger.baseBranch` wins if set; otherwise fall back
  // to current branch in the project root (matches ADR-179 §Decision-3
  // resolution order in `mergeMember`).
  let baseBranch = typeof merger?.baseBranch === "string" ? merger.baseBranch : "";
  if (baseBranch.length === 0) {
    const baseR = await git(["-C", projectRoot, "branch", "--show-current"]);
    baseBranch = baseR.exitCode === 0 ? baseR.stdout.trim() : "";
  }
  if (baseBranch.length === 0) return rows; // detached HEAD — can't probe.

  const listR = await git(["-C", projectRoot, "branch", "--list", `${baseBranch}-*`]);
  if (listR.exitCode !== 0) return rows; // degrade silently.

  const prefix = `${baseBranch}-`;
  const branchNames = listR.stdout
    .split("\n")
    .map((line) => line.replace(/^[\s*+]+/, "").trim())
    .filter((line) => line.length > 0 && line.startsWith(prefix));

  // For each member-suffixed branch, probe its tip-commit time and
  // commits-ahead count. We only surface branches that are:
  //   (a) suffixed to a current team member (not a leftover orphan —
  //       that's already handled by class 5 of checkWorktreeIsolation),
  //   (b) have ≥1 commit ahead of base (a no-op merge would be silent),
  //   (c) tip-commit older than the staleness cutoff.
  const sanitizedToMember = new Map<string, string>();
  for (const m of team.members) {
    sanitizedToMember.set(sanitizeBranchSegment(m.name), m.name);
  }

  for (const branchName of branchNames) {
    const suffix = branchName.slice(prefix.length);
    const memberName = sanitizedToMember.get(suffix);
    if (memberName === undefined) continue; // not a current member; class 5 surfaces this.

    // Commits-ahead count gate.
    const countR = await git([
      "-C",
      projectRoot,
      "rev-list",
      "--count",
      `${baseBranch}..${branchName}`,
    ]);
    if (countR.exitCode !== 0) continue;
    const aheadRaw = countR.stdout.trim();
    if (!/^\d+$/.test(aheadRaw)) continue;
    const ahead = parseInt(aheadRaw, 10);
    if (ahead === 0) continue;

    // Tip-commit author/commit time.
    const timeR = await git(["-C", projectRoot, "log", "-1", "--format=%ct", branchName]);
    if (timeR.exitCode !== 0) continue;
    const tipRaw = timeR.stdout.trim();
    if (!/^\d+$/.test(tipRaw)) continue;
    const tipSec = parseInt(tipRaw, 10);
    if (tipSec >= staleCutoffSec) continue; // fresh — not stale.

    const ageHours = Math.floor((nowSec - tipSec) / 3600);
    rows.push({
      status: "yellow",
      label: `merger:branch-stale:${memberName}`,
      detail: `${branchName} — ${ahead} commit(s) ahead of ${baseBranch}, tip is ~${ageHours}h old (threshold ${stalenessHours}h)`,
      hint: `run \`atmux merge-member ${memberName}\` to fan in — or wait for the merger loop / cron if installed`,
    });
  }

  return rows;
}

// ---------- Public verb entry ----------

export interface DoctorOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Inject the underlying check executors (test override). */
  runChecks?: (atmuxDir: string, team: Team | null) => Promise<DoctorRow[]>;
  /** ADR-081 §D: opts threaded into {@link fixStarvingMembers} when
   *  `--fix` finds starving rows. Test fixtures inject a no-op sleep +
   *  tiny verify deadline; production callers omit. */
  fixStarvingOpts?: FixStarvingOpts;
}

// ---------- ADR-147 §D5 T6: release-note-missing probe (warn, NOT block) ----------

/** Test-injection seam for {@link checkReleaseNoteMissing}. */
export interface CheckReleaseNoteMissingOpts {
  /** Git spawn override (test injection). Default uses `defaultGitSpawn`. */
  gitSpawn?: GitSpawn;
  /** Clock override (test injection). Defaults to `now()` from `time.ts`
   *  — which itself honours `setNow()` for clock-pinned tests. */
  now?: () => number;
  /** Repo root override (test injection). Default `process.cwd()` —
   *  matches the convention `defaultGitSpawn` uses (commands run from
   *  the caller's cwd) so the day-file path lookup sees the same tree
   *  the git probe interrogates. */
  repoRoot?: string;
}

/**
 * ADR-147 §D5 backstop probe — emit a yellow row when today (MYT) has
 * ≥1 commit on the current branch AND the day's release-notes file
 * does not exist yet. Warn class only; never blocks. The expected
 * pattern is that gitter / hygiene-tick / ombudsman creates the file
 * on the first event of the day; this probe surfaces missed days so
 * the ombudsman can backfill.
 *
 * Failure mode tolerance — every error path degrades silently:
 *   - `git log` exit != 0 (not in a repo, no `.git`, permission)  → []
 *   - `git log` stdout empty (no commits today)                   → []
 *   - day-file exists on disk                                     → []
 *   - day-file missing despite today's commit                     → [yellow]
 *
 * Why silent-on-error: `atmux doctor` runs in many environments
 * (deployed cages, CI agents, build hosts). A spurious red/yellow row
 * because git isn't available isn't actionable for the operator;
 * better to skip the probe and let other rows surface the real
 * config issue.
 *
 * The `--since` argument is anchored on MYT midnight via the ISO-8601
 * `+08:00` offset (`YYYY-MM-DDT00:00:00+08:00`). Git parses this
 * directly — no need for a TZ env variable override. Date boundary
 * tests exercise the 23:00 MYT / 15:00 UTC edge where the previous
 * day's commit is also today's commit until 00:00 MYT.
 */
export async function checkReleaseNoteMissing(
  opts: CheckReleaseNoteMissingOpts = {},
): Promise<DoctorRow[]> {
  const git = opts.gitSpawn ?? defaultGitSpawn;
  const nowFn = opts.now ?? now;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const epochMs = nowFn();

  // Compute today's MYT midnight as an ISO-8601 timestamp with explicit
  // +08:00 offset. Git's `--since` parser accepts this format directly.
  const { iso: todayIso } = mytDate(epochMs);
  const sinceArg = `${todayIso}T00:00:00+08:00`;

  // `git log --since=<X> --format=%H -1` — exit code 0 + empty stdout
  // means no commits since X; exit code 0 + one line means there's at
  // least one. `-C <repoRoot>` so the probe is decoupled from the
  // caller's actual cwd (test-injection clean).
  const r = await git(["-C", repoRoot, "log", `--since=${sinceArg}`, "--format=%H", "-1"]);
  if (r.exitCode !== 0) return []; // not a repo / no .git / permission
  if (r.stdout.trim() === "") return []; // no commits today (MYT)

  // Day-file path lookup. T5's `resolveDayFilePath` returns the absolute
  // path; we check `exists()` to gate the row.
  const dayPath = resolveDayFilePath(epochMs, { repoRoot });
  if (await exists(dayPath)) return []; // file present — silent

  // Today has commits but no day-file. Yellow row + actionable hint.
  // Strip the repoRoot prefix from the displayed path so the detail
  // line is short + grep-friendly.
  const relPath = dayPath.startsWith(`${repoRoot}/`) ? dayPath.slice(repoRoot.length + 1) : dayPath;
  return [
    {
      status: "yellow",
      label: "release-note-missing",
      detail: `${relPath} — today (${todayIso} MYT) has commits but day-file absent`,
      hint:
        "ombudsman / gitter / hygiene-tick should auto-create on the day's first event; " +
        "backfill manually via `ensureDayFile(...)` from src/abstractions/release-notes.ts",
    },
  ];
}

// ---------- ADR-162 §Decision-anchor #5: tmux infrastructure probes ----------

/** Lowest tmux version atmux is tested against. Below → yellow.
 *  Per ADR-162 §Part C. */
export const TMUX_MIN_VERSION = "3.2";

/** Highest tmux version atmux is tested against. Above → yellow.
 *  Per ADR-162 §Part C. ADR-138's send-keys verifier contract is
 *  validated against this version on hax. */
export const TMUX_TESTED_VERSION = "3.6a";

/** Parsed tmux version. `suffix` is the optional trailing alphabetic
 *  letter (e.g. `"a"` in `tmux 3.6a`); empty string when absent. */
export interface ParsedTmuxVersion {
  major: number;
  minor: number;
  suffix: string;
}

/**
 * Parse `tmux -V` stdout into a structured version. tmux prints lines
 * like `tmux 3.6a` (release) or `tmux next-3.7` (pre-release); also
 * `tmux master` for source builds. Returns `null` when the line can't
 * be parsed — caller treats that as a "warn-unknown" finding.
 */
export function parseTmuxVersion(stdout: string): ParsedTmuxVersion | null {
  const trimmed = stdout.trim();
  // Strict: `tmux <major>.<minor>[<suffix>]` on a single line. Skips
  // pre-release / source-build outputs so we surface them as
  // unparseable rather than guess.
  const m = trimmed.match(/^tmux (\d+)\.(\d+)([a-z]?)$/);
  if (m === null) return null;
  const major = Number.parseInt(m[1] ?? "", 10);
  const minor = Number.parseInt(m[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor, suffix: m[3] ?? "" };
}

/** Compare two `ParsedTmuxVersion`s. Returns -1 / 0 / +1 with
 *  major → minor → suffix precedence. Suffix is compared
 *  lexicographically (`"" < "a" < "b" < …`). */
export function compareTmuxVersion(a: ParsedTmuxVersion, b: ParsedTmuxVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.suffix === b.suffix) return 0;
  return a.suffix < b.suffix ? -1 : 1;
}

/** Spawn override for the tmux probes. Test-injection point. */
export type TmuxSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

const defaultTmuxSpawn: TmuxSpawn = (argv) =>
  defaultSpawn({ cmd: resolveTmuxBin(), argv, expectExitCode: "any", timeoutMs: 5_000 });

export interface CheckTmuxVersionOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
}

/**
 * ADR-162 §Decision-anchor #5 probe 1 — `tmux-version-mismatch`. Runs
 * `tmux -V`, parses output, and surfaces a yellow row when the host
 * tmux falls below {@link TMUX_MIN_VERSION} or above
 * {@link TMUX_TESTED_VERSION}. Both bounds are warn-class (non-
 * blocking); the canary surface motivates ADR-163's bundled-binary
 * v2 promotion.
 *
 * Unparseable output (`tmux next-3.7`, `tmux master`, missing tmux)
 * collapses to a yellow row with `actual: "unknown"` so the operator
 * still sees something instead of silent skip.
 */
export async function checkTmuxVersionMismatch(
  opts: CheckTmuxVersionOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const min = parseTmuxVersion(`tmux ${TMUX_MIN_VERSION}`);
  const tested = parseTmuxVersion(`tmux ${TMUX_TESTED_VERSION}`);
  if (min === null || tested === null) {
    // Defensive — the embedded constants must parse. If a maintainer
    // sets a malformed constant the probe surfaces it on every doctor
    // run rather than failing silently.
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: "internal — TMUX_MIN_VERSION / TMUX_TESTED_VERSION constant unparseable",
        hint: "report a bug; ADR-162 §Decision-anchor #5",
      },
    ];
  }
  let result: SpawnResult;
  try {
    result = await tmux(["-V"]);
  } catch {
    // Spawn miss / timeout — collapse to unknown. `checkDeps` already
    // covers the missing-binary case with a red row, so this branch is
    // largely defensive (PATH munged mid-run, etc.).
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: "tmux -V failed to run",
        hint:
          `host tmux not invokable; min ${TMUX_MIN_VERSION}, tested ${TMUX_TESTED_VERSION}. ` +
          "bundled tmux available via ADR-163.",
      },
    ];
  }
  if (result.exitCode !== 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `tmux -V exited ${result.exitCode}`,
        hint:
          `host tmux not responding; min ${TMUX_MIN_VERSION}, tested ${TMUX_TESTED_VERSION}. ` +
          "bundled tmux available via ADR-163.",
      },
    ];
  }
  const parsed = parseTmuxVersion(result.stdout);
  if (parsed === null) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `tmux -V output unparseable: ${result.stdout.trim().slice(0, 80)}`,
        hint:
          `ADR-138 verifier contract assumes 'tmux X.Y[a]' format; min ${TMUX_MIN_VERSION}, ` +
          `tested ${TMUX_TESTED_VERSION}. Report regressions to atmux issues.`,
      },
    ];
  }
  const actual = `${parsed.major}.${parsed.minor}${parsed.suffix}`;
  if (compareTmuxVersion(parsed, min) < 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `host tmux ${actual} below minimum ${TMUX_MIN_VERSION}`,
        hint: "ADR-138 send-keys verifier may break; bundled tmux available via ADR-163.",
      },
    ];
  }
  if (compareTmuxVersion(parsed, tested) > 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `host tmux ${actual} above tested ${TMUX_TESTED_VERSION}`,
        hint: "untested version; report regressions to atmux issues. Pin via ADR-163 bundled binary.",
      },
    ];
  }
  return [];
}

export interface CheckVendoredTmuxBinaryOpts {
  /** Filesystem probe override (test seam). */
  existsSync?: (path: string) => boolean;
  /** tmux spawn override — invoked with the resolved binary as `cmd`. */
  tmux?: TmuxSpawn;
  /** Override the path probed for the vendored binary. */
  vendoredPath?: string;
  /** Override the version we expect the vendored binary to report. */
  expectedVersion?: string;
}

/**
 * ADR-191 probe — `vendored-tmux-binary`. Two yellow rows possible:
 *
 *   1. `vendored-tmux-missing` — `/opt/atmux/current/bin/tmux` absent.
 *      Operators on dev builds (no `build:install` ever run) and
 *      pre-ADR-191 deploys both land here. Self-clearing after the
 *      build pipeline lands the binary.
 *   2. `vendored-tmux-version-drift` — vendored binary present but
 *      `tmux -V` against it doesn't match the ADR-191 pin (3.6a).
 *      Indicates an out-of-date install or a hand-staged binary.
 *
 * Both rows are warn-class; atmux falls through to system tmux via
 * `resolveTmuxBin()` so no behavior breaks. The probe gives the
 * operator a discoverable signal that the resolution chain is on the
 * fallback tier instead of the vendored tier.
 */
export async function checkVendoredTmuxBinary(
  opts: CheckVendoredTmuxBinaryOpts = {},
): Promise<DoctorRow[]> {
  const exists = opts.existsSync ?? fsExistsSync;
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const vendoredPath = opts.vendoredPath ?? "/opt/atmux/current/bin/tmux";
  const expected = opts.expectedVersion ?? TMUX_TESTED_VERSION;

  if (!exists(vendoredPath)) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-missing",
        detail: `${vendoredPath} not installed — resolveTmuxBin() falls through to system tmux`,
        hint:
          "ship the binary via `bun run build:install` (per ADR-191) or set " +
          "ATMUX_TMUX_BIN to silence the fallback warning.",
      },
    ];
  }

  // Vendored binary present. Run `tmux -V` against the resolved binary
  // (which is the vendored path when present) to confirm the pin.
  let result: SpawnResult;
  try {
    result = await tmux(["-V"]);
  } catch {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `${vendoredPath} present but \`tmux -V\` failed to run`,
        hint: `expected ${expected} per ADR-191; re-run build:install or check file mode.`,
      },
    ];
  }
  if (result.exitCode !== 0) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `${vendoredPath} present but \`tmux -V\` exited ${result.exitCode}`,
        hint: `expected ${expected} per ADR-191; re-run build:install or check file mode.`,
      },
    ];
  }
  const parsed = parseTmuxVersion(result.stdout);
  if (parsed === null) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `\`tmux -V\` output unparseable: ${result.stdout.trim().slice(0, 80)}`,
        hint: `expected ${expected} per ADR-191; report regressions to atmux issues.`,
      },
    ];
  }
  const actual = `${parsed.major}.${parsed.minor}${parsed.suffix}`;
  if (actual !== expected) {
    return [
      {
        status: "yellow",
        label: "vendored-tmux-version-drift",
        detail: `vendored tmux reports ${actual}, expected ${expected}`,
        hint:
          "re-run `bun run build:install` to retarget /opt/atmux/current at the pinned version " +
          "(ADR-191 §Decision).",
      },
    ];
  }
  return [];
}

export interface CheckCockpitOnDefaultSocketOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
  /** Cockpit session name to look for on the legacy default socket.
   *  Defaults to ADR-135's `"atmux_cockpit"`. */
  cockpitSession?: string;
}

/**
 * ADR-162 §Decision-anchor #5 probe 2 — `cockpit-on-default-socket`.
 * Lists sessions on the legacy `default` socket and emits a yellow row
 * when the `atmux_cockpit` session is found there. Self-clearing post-
 * migration (operator runs `atmux cockpit migrate-socket`; subsequent
 * doctor runs return no row).
 *
 * Silent when:
 * - the default socket has no server (tmux `-L default` exits non-zero
 *   with "no server running"),
 * - the default socket runs sessions but none match `atmux_cockpit`.
 */
export async function checkCockpitOnDefaultSocket(
  opts: CheckCockpitOnDefaultSocketOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const cockpitSession = opts.cockpitSession ?? "atmux_cockpit";
  let result: SpawnResult;
  try {
    result = await tmux(["-L", "default", "list-sessions", "-F", "#{session_name}"]);
  } catch {
    // Spawn miss → silent (deps check covers tmux-on-PATH).
    return [];
  }
  if (result.exitCode !== 0) return []; // no server / no permission — silent
  const sessions = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!sessions.includes(cockpitSession)) return [];
  return [
    {
      status: "yellow",
      label: "cockpit-on-default-socket",
      detail: `legacy '${cockpitSession}' session detected on default socket`,
      hint:
        "run 'atmux cockpit migrate-socket' to move it to the dedicated " +
        "atmux-cockpit socket (ADR-162 §Decision-anchor #4).",
    },
  ];
}

export interface CheckDeployedBinaryLagOpts {
  /** Git spawn override (test injection). Reads HEAD + the commit that
   *  last touched package.json. Defaults to `defaultGitSpawn`. */
  git?: GitSpawn;
  /** Reader for /opt/atmux/current symlink target. Returns the version
   *  string (e.g. `"0.8.7"`) or null when the symlink is absent /
   *  unreadable. Defaults to readlink on the canonical path. */
  readDeployedVersion?: () => Promise<string | null>;
  /** Reader for the source-tree package.json version. Defaults to
   *  reading `./package.json`. Test injection. */
  readSourceVersion?: () => Promise<string | null>;
}

/**
 * t-400a1cad — `deployed-binary-lag` warn-class probe.
 *
 * Compares the source tree (git HEAD + package.json version) against
 * the deployed binary at `/opt/atmux/current`. Emits yellow when the
 * source has commits past the deployed version — exactly the class
 * that hid t-186d5910 for ~30h (code-shipped-not-deployed).
 *
 * Signals checked, in order:
 *   1. Source package.json version vs deployed `/opt/atmux/current`
 *      symlink target. Mismatch → yellow with `atmux release` hint.
 *   2. When versions match: count commits between HEAD and the SHA
 *      that last bumped package.json. Any commits → yellow (source
 *      ahead of deploy; needs version bump + redeploy).
 *
 * Silent when:
 *   - /opt/atmux/current absent (non-system install — operator runs
 *     from source via `bun run` and doesn't deploy to /opt).
 *   - package.json absent (probe doesn't apply).
 *   - git not on PATH (deps probe covers this surface).
 *   - source ↔ deploy in sync (the green case).
 */
export async function checkDeployedBinaryLag(
  opts: CheckDeployedBinaryLagOpts = {},
): Promise<DoctorRow[]> {
  const git = opts.git ?? defaultGitSpawn;
  const readDeployedVersion =
    opts.readDeployedVersion ??
    (async (): Promise<string | null> => {
      try {
        const target = await fsReadlink("/opt/atmux/current");
        // /opt/atmux/0.8.7 → "0.8.7"
        const m = target.match(/\/([0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?)\/?$/);
        return m?.[1] ?? null;
      } catch {
        return null;
      }
    });
  const readSourceVersion =
    opts.readSourceVersion ??
    (async (): Promise<string | null> => {
      const buf = await readTextOrNull("package.json");
      if (buf === null) return null;
      try {
        const parsed = JSON.parse(buf);
        const v = parsed?.version;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    });

  const [deployed, source] = await Promise.all([readDeployedVersion(), readSourceVersion()]);
  if (deployed === null) return []; // no system install — silent
  if (source === null) return []; // no source-side version — silent

  // Signal 1: version mismatch.
  if (source !== deployed) {
    return [
      {
        status: "yellow",
        label: "deployed-binary-lag",
        detail: `source package.json=${source} but /opt/atmux/current=${deployed}`,
        hint: "run `bun run build:install` (or t-c3f4c418's `atmux release` once landed) to roll forward.",
      },
    ];
  }

  // Signal 2: versions match but commits after the last bump exist.
  let headRes: SpawnResult;
  let lastBumpRes: SpawnResult;
  try {
    headRes = await git(["rev-parse", "HEAD"]);
    lastBumpRes = await git(["log", "-1", "--pretty=%H", "--", "package.json"]);
  } catch {
    return []; // git spawn miss → silent
  }
  if (headRes.exitCode !== 0 || lastBumpRes.exitCode !== 0) return [];

  const headSha = headRes.stdout.trim();
  const lastBumpSha = lastBumpRes.stdout.trim();
  if (headSha === "" || lastBumpSha === "") return [];
  if (headSha === lastBumpSha) return []; // version-bump commit IS HEAD — green

  // Count commits between last-bump and HEAD (exclusive of last-bump,
  // inclusive of HEAD).
  let countRes: SpawnResult;
  try {
    countRes = await git(["rev-list", "--count", `${lastBumpSha}..HEAD`]);
  } catch {
    return [];
  }
  if (countRes.exitCode !== 0) return [];
  const n = Number.parseInt(countRes.stdout.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return [];

  return [
    {
      status: "yellow",
      label: "deployed-binary-lag",
      detail: `${n} commit(s) after v${source} bump — source ahead of /opt/atmux/current`,
      hint: "version bump + `bun run build:install` (or `atmux release patch` per t-c3f4c418) to ship the post-bump commits.",
    },
  ];
}

export interface CheckLegacyWindowNameFormatOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
  /** Cockpit reader override. Default loads `~/.atmux/cockpit.json` and
   *  returns `null` if absent / unreadable (single-cage fallback). */
  loadCockpitFn?: () => Promise<LoadedCockpit | null>;
  /** Load `team.json` from a cockpit team's root dir. Default uses
   *  `tryLoadTeam({ teamDir: <root> })`; returns `null` on absence so
   *  cockpit entries with missing team.json don't tank the whole probe. */
  loadTeamForRoot?: (root: string) => Promise<Team | null>;
  /** Socket-existence check — skips cages whose socket file isn't on
   *  disk (cage not running). Default uses `fs.exists`. */
  socketExists?: (path: string) => Promise<boolean>;
}

/**
 * EPIC e-a3077ca0 T8 — `legacy-window-name-format` warn-class probe.
 *
 * Lists tmux windows on every live cage (cockpit-walk; falls back to
 * `currentTeam` when cockpit is absent / unreadable) and flags any
 * default-member-role window that's still in a pre-ADR-161 form:
 *
 *   - `<emoji>-<member>` (ADR-135 hyphen — was default-member canonical
 *      pre-ADR-161 TR2)
 *   - `<emoji><member>`  (pre-ADR-135 no-separator)
 *
 * Default-member roles per {@link DEFAULT_MEMBER_ROLES} —
 * `team-lead` / `planner` / `reviewer` / `ombudsman`. The committer
 * role is exempt by definition (its canonical IS the hyphen form per
 * `project_adr_161_tr2_shipped` memory + ADR-159 pending). Members
 * with no role / `role: "member"` are also exempt: the hyphen IS their
 * canonical form so a hyphen-named window isn't a migration miss.
 *
 * Emits one yellow row per flagged window with a `tmux rename-window`
 * one-liner the operator can paste back. Idempotent: once renamed, the
 * canonical form lives in the window list and the probe stops firing.
 *
 * Out-of-scope (skipped silently):
 *   - Epic-viewer windows (`🌳-<eid>`) — hyphen is canonical there by
 *     spec; never default-member-role anyway.
 *   - User-added member names without a default-member role — hyphen
 *     is their canonical (per ADR-161 §D2).
 *   - Cages whose socket file isn't present (cage not running).
 *   - Cages whose `atmux-<team.name>` session isn't on the socket
 *     (non-canonical session name; out of scope for this warn).
 *
 * Driver-ref: 2026-05-18 atmux parent cage (4-day uptime, 6 windows
 * still hyphenated, `rotate-lead` refused with `no tmux window for
 * lead`). The shim wires (T2-T6) self-heal at every reachable call-
 * site, but operators wanting an at-a-glance verdict of "are any cages
 * still on the old format?" get it from this probe.
 */
export async function checkLegacyWindowNameFormat(
  currentTeam: Team | null,
  opts: CheckLegacyWindowNameFormatOpts = {},
): Promise<DoctorRow[]> {
  const tmux = opts.tmux ?? defaultTmuxSpawn;
  const loadCockpitFn =
    opts.loadCockpitFn ??
    (async (): Promise<LoadedCockpit | null> => {
      try {
        return await loadCockpit();
      } catch {
        // No cockpit / unreadable / schema error → single-cage fallback.
        return null;
      }
    });
  const loadTeamForRoot =
    opts.loadTeamForRoot ??
    (async (root: string): Promise<Team | null> => {
      try {
        return await tryLoadTeam({ teamDir: root });
      } catch {
        return null;
      }
    });
  const socketExistsFn = opts.socketExists ?? exists;

  // Build the probe target set: cockpit teams (when loadable) ∪ currentTeam.
  // Dedup by team name so a current-team that's also in cockpit isn't
  // probed twice (would emit duplicate yellow rows per flagged window).
  const targets: Array<{ team: Team }> = [];
  const seenNames = new Set<string>();
  const cockpit = await loadCockpitFn();
  if (cockpit !== null) {
    for (const ct of cockpit.teams) {
      const t = await loadTeamForRoot(ct.root);
      if (t === null) continue;
      if (seenNames.has(t.name)) continue;
      seenNames.add(t.name);
      targets.push({ team: t });
    }
  }
  if (currentTeam !== null && !seenNames.has(currentTeam.name)) {
    seenNames.add(currentTeam.name);
    targets.push({ team: currentTeam });
  }

  const rows: DoctorRow[] = [];
  for (const { team } of targets) {
    const socket = resolveTeamSocket(team);
    if (!(await socketExistsFn(socket))) continue; // cage not running
    const sessionName = `atmux-${team.name}`;
    let result: SpawnResult;
    try {
      result = await tmux([
        "-S",
        socket,
        "list-windows",
        "-t",
        sessionName,
        "-F",
        "#{window_name}",
      ]);
    } catch {
      continue; // tmux spawn failed; deps probe already covers
    }
    if (result.exitCode !== 0) continue; // session missing / non-canonical
    const windowNames = new Set(
      result.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    for (const m of team.members) {
      // Only default-member roles need the cross-format migration.
      // `role` may be undefined on older team.json — `isDefaultMemberRole`
      // already returns false for undefined.
      if (!isDefaultMemberRole(m.role)) continue;
      const canonical = buildWindowName(m.name, m.emoji, m.label, m.role);
      const hyphenForm = buildWindowName(m.name, m.emoji, m.label);
      const legacyForm = buildWindowNameLegacy(m.name, m.emoji);
      // Canonical present → no migration needed. (Defensive: if BOTH
      // canonical AND a legacy variant exist, we still flag the legacy
      // entry — it's an orphan window left behind by an interrupted
      // rename and clutters operator scroll.)
      const offenders: string[] = [];
      if (hyphenForm !== canonical && windowNames.has(hyphenForm)) {
        offenders.push(hyphenForm);
      }
      if (legacyForm !== canonical && legacyForm !== hyphenForm && windowNames.has(legacyForm)) {
        offenders.push(legacyForm);
      }
      for (const legacyName of offenders) {
        rows.push({
          status: "yellow",
          label: "legacy-window-name-format",
          detail: `${team.name} cage: window '${legacyName}' should be '${canonical}' (default-member role '${m.role}')`,
          hint: `tmux -S ${socket} rename-window -t ${sessionName}:${legacyName} ${canonical}`,
        });
      }
    }
  }
  return rows;
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
  rows.push(...(await checkLegacyInboxJson(atmuxDir)));
  // ADR-202 §D11: Honker substrate runtime probe. Surfaces extension-
  // load state + fallback reason so operators can see whether the
  // event-driven path is live or whether consumers are in cron-backstop
  // poll mode. Info-level when state.db absent or kill-switch off;
  // yellow on fallback (load failure / smoke fail); green on loaded.
  rows.push(...(await checkHonker(atmuxDir)));
  // ADR-184 §Amendment 2026-05-21: host-pressure probe. Surfaces the
  // /proc/loadavg + /proc/meminfo readings vs configured thresholds
  // (ATMUX_SPAWN_MAX_LOAD_RATIO + ATMUX_SPAWN_MIN_FREE_MB). Green
  // under threshold; yellow over (spawn-epic refuses); info on
  // non-Linux platforms.
  rows.push(...(await checkHostPressure()));
  // ADR-217 §D5: installed-state of the /atmux: skills plugin (12
  // cockpit-tier skills shipped via plugins/atmux/, installed by the
  // wizard step in `atmux init`). Green when symlink + plugin.json
  // valid; yellow on missing / malformed; info when user opted out
  // via wizard [n]. $HOME-unset → silent no-row.
  rows.push(...(await checkSkillsPlugin()));
  // t-af159454: phantom in-progress claims (kanban rows with dead
  // owner panes). Distinct vulnerability class from phantom-inbox
  // above (that one scans member inProgress via loadInbox; this scans
  // the live kanban). Cage-only — singleSession teams short-circuit in
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
  // ADR-081 §D: per-member cage-state — surface `starving` panes whose
  // brief never landed, and `down` panes where claude isn't running.
  // Silent on a healthy team (active members emit no row).
  rows.push(...(await checkMemberCageStates(team, atmuxDir)));
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
  // ADR-136 TR4: member-label-collision — warn when 2+ members share
  // the same `(emoji, label-or-name)` display tuple. Pure (no I/O);
  // returns [] when team is null OR no collisions exist.
  rows.push(...checkMemberLabelCollision(team));
  // ADR-179 §Decision-6 W6: merger-fan-in anomalies — stale per-member
  // branch + role/feature-flag mismatch. Silent when `team.merger` is
  // unset or `merger.enabled !== true` (the staleness branch); the
  // role-mismatch branch surfaces regardless when a `role: "merger"`
  // member exists with the feature off.
  rows.push(...(await checkMergerFanIn(team, atmuxDir)));
  // ADR-147 §D5 / T6: backstop probe for the release-notes daily
  // log. Warn class only — never blocks; surfaces missed days so
  // ombudsman can backfill. Silent in environments without git
  // (CI agents probing fresh trees, non-repo cages).
  rows.push(...(await checkReleaseNoteMissing()));
  // ADR-162 §Decision-anchor #5: warn-class tmux infrastructure
  // probes. Both surface only when the host tmux drifts (version) or
  // when a legacy cockpit lingers on the default socket. Self-clearing
  // post-migration. Never blocks.
  rows.push(...(await checkTmuxVersionMismatch()));
  // ADR-191: vendored tmux at /opt/atmux/current/bin/tmux. Warn when
  // absent (resolveTmuxBin() falls through to system tmux) or when
  // present-but-version-drift. Self-clearing post-build:install.
  rows.push(...(await checkVendoredTmuxBinary()));
  rows.push(...(await checkCockpitOnDefaultSocket()));
  // t-400a1cad: deployed-binary-lag — warn class.
  // t-400a1cad: deployed-binary-lag — warn class. Compares git HEAD +
  // package.json version against /opt/atmux/current symlink target.
  // Catches the "code-shipped-not-deployed" class that hid t-186d5910
  // for ~30h. Silent on non-system install (no /opt/atmux/current) or
  // missing package.json (probe doesn't apply).
  rows.push(...(await checkDeployedBinaryLag()));
  // EPIC e-a3077ca0 T8: legacy-window-name-format — warn class.
  // Walks every cockpit cage (falls back to currentTeam if cockpit
  // is absent / unreadable) and flags default-member-role windows
  // still on hyphen / no-separator forms. Self-clearing once the
  // operator runs the suggested `tmux rename-window` one-liner OR
  // the shim wires (T2-T6) heal them on the next addressing call.
  rows.push(...(await checkLegacyWindowNameFormat(team)));
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

  // --fix runs three actions, in order of operator value:
  //   1. ADR-081 §D — re-paste the role brief on every starving member
  //      so the operator doesn't have to ssh in + run the manual
  //      recovery sequence captured in the ADR's audit trail.
  //   2. ADR-084 W2 (branch-orphan) — dry-run summary of safe-to-delete
  //      orphan branches; actual deletion stays deferred per ADR-019.
  //   3. t-af159454 — phantom in-progress prune (operator can collapse
  //      cited phantom claim IDs in one shot).
  // Other --fix paths (branch-orphan deletion, team.json wizard re-run)
  // remain stubbed pending ADR-019 §"Fix" resolution; the trailing
  // hint below covers the residual.
  if (parsed.fix && !parsed.quiet) {
    // ADR-081 §D: real --fix action — re-paste the brief on starving
    // members so the operator doesn't have to ssh in + run the manual
    // recovery sequence captured in the ADR's audit trail. Runs BEFORE
    // the dry-run report so any successful re-pastes flip rows to active
    // in the user's mental model.
    if (team !== null) {
      const starving = collectStarvingMembers(report.rows);
      if (starving.length > 0) {
        await fixStarvingMembers(team, atmuxDir, starving, opts.fixStarvingOpts ?? {}, stderr);
      }
    }
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
        liveMembers: () => probeLiveMembers(team, atmuxDir),
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
 * ADR-081 §D: scan doctor rows for starving-member yellow rows.
 * Returns the member names extracted from the `member-cage-state:<name>`
 * label suffix. The "starving" branch of {@link checkMemberCageStates}
 * is identified by the row's `detail` text containing `welcome banner
 * persistent` — stable substring per the row composer.
 *
 * Exported for direct unit-testing without spinning the full doctor
 * pipeline. Pure scan; no IO.
 */
export function collectStarvingMembers(rows: ReadonlyArray<DoctorRow>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.status !== "yellow") continue;
    if (!r.label.startsWith("member-cage-state:")) continue;
    if (r.detail === undefined) continue;
    if (!r.detail.includes("welcome banner persistent")) continue;
    out.push(r.label.slice("member-cage-state:".length));
  }
  return out;
}

/**
 * ADR-081 §D: re-paste the role brief on each starving member via the
 * same path `atmux start` uses (`pasteBriefForMember` exported from
 * `verbs/start.ts`), with `spawnWaitMs=0` because the TUI is already
 * alive — no welcome-screen settle needed.
 *
 * After paste, probes each pane for up to 30s (ADR-081 §D acceptance)
 * to confirm ctx > 0 OR welcome banner cleared. Surfaces the result to
 * stderr; failures degrade gracefully (no throw) — best-effort matches
 * the rest of the doctor verb's behaviour.
 */
async function fixStarvingMembers(
  team: Team,
  atmuxDir: string,
  starving: ReadonlyArray<string>,
  opts: FixStarvingOpts,
  stderr: Writer,
): Promise<void> {
  // Lazy import — keeps the import surface of doctor.ts narrow and
  // avoids the verb-to-verb cycle risk if start.ts ever ends up
  // importing doctor symbols.
  const { pasteBriefForMember } = await import("./start.ts");
  const { defaultBriefsDir } = await import("./rotate.ts");

  const socketPath = resolveTeamSocket(team);
  const sessionName = `atmux-${team.name}`;
  const tmux = createTmux({ socketPath });
  const briefsDir = opts.briefsDir ?? defaultBriefsDir();
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const verifyDeadlineMs = opts.verifyDeadlineMs ?? 30_000;
  const verifyPollIntervalMs = opts.verifyPollIntervalMs ?? 1_000;

  stderr(`\natmux doctor --fix: re-pasting brief on ${starving.length} starving member(s)\n`);

  for (const memberName of starving) {
    const member = team.members.find((m) => m.name === memberName);
    if (member === undefined) {
      stderr(`  ✗ ${memberName}: not in roster — skipping\n`);
      continue;
    }
    const emoji = member.emoji ?? defaultEmojiForRole(member.role ?? "member");
    // Use the spawn-side window-name builder so re-paste targets the same
    // window names start.ts created — honours ADR-135 (hyphen) for
    // user-added members AND ADR-161 (`_`-prefix) for default-member roles
    // (team-lead/planner/reviewer/ombudsman). The legacy `${emoji}${name}`
    // shape predated both ADRs and silently no-ops on every modern team.
    const memberLabel = (member as { label?: string }).label;
    const windowName = buildWindowName(member.name, emoji, memberLabel, member.role);
    const target = `${sessionName}:${windowName}`;
    const role = typeof member.role === "string" ? member.role : "member";
    const sendTarget =
      role === "team-lead"
        ? ({ kind: "lead" as const, team: team.name, target } as const)
        : ({ kind: "member" as const, member: member.name, team: team.name, target } as const);

    // The fix call mirrors start.ts's spawn-time invocation but with
    // `spawnWaitMs=0` — the TUI is already up, no welcome-screen
    // settle is required.
    try {
      await pasteBriefForMember({
        tmux,
        target: sendTarget,
        member: member.name,
        role,
        team: team.name,
        atmuxDir,
        briefsDir,
        spawnWaitMs: 0,
        sleep,
        logger: {
          log: (s: string) => stderr(`    ${s}\n`),
          warn: (s: string) => stderr(`    ${s}\n`),
          ok: (s: string) => stderr(`    ${s}\n`),
          err: (s: string) => stderr(`    ${s}\n`),
        },
      });
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      stderr(`  ✗ ${memberName}: paste failed — ${cause}\n`);
      continue;
    }

    // Verify within deadline that the pane transitioned to active.
    const verified = await verifyStarvingResolved(
      tmux,
      target,
      verifyDeadlineMs,
      verifyPollIntervalMs,
      sleep,
    );
    if (verified) {
      stderr(`  ✅ ${memberName}: brief re-pasted + pane reached active state\n`);
    } else {
      stderr(
        `  ⚠ ${memberName}: brief re-pasted but pane did NOT reach active within ${verifyDeadlineMs}ms — inspect manually\n`,
      );
    }
  }
}

/** ADR-081 §D verification step — poll a pane up to `deadlineMs` for
 *  transition from starving → active (ctx > 0 OR banner cleared).
 *  Pure-ish: tmux IO + sleep, no other side effects. */
async function verifyStarvingResolved(
  tmux: ReturnType<typeof createTmux>,
  target: string,
  deadlineMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    let text = "";
    try {
      text = await tmux.pane.capturePane({ target, start: -30 });
    } catch {
      // Pane vanished mid-verify — caller treats as not-resolved.
      return false;
    }
    const classification = classifyText(text);
    const verdict = inspectClaudeReadiness(text, classification, true);
    if (verdict === "ready") return true;
    await sleep(pollIntervalMs);
  }
  return false;
}

/** Options for `fixStarvingMembers`. Tests inject sleep + verify deadline
 *  to keep unit suites fast; the `verbs/doctor` CLI path passes nothing
 *  (defaults: real setTimeout, 30s deadline, 1s poll). */
export interface FixStarvingOpts {
  /** Override the briefs dir resolution (test injection). */
  briefsDir?: string;
  /** Sleep override — defaults to `setTimeout`-backed promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget for the post-paste verify probe. Default 30_000ms
   *  per ADR-081 §D acceptance. */
  verifyDeadlineMs?: number;
  /** Poll interval inside the verify loop. Default 1_000ms — balances
   *  responsiveness with not hammering the tmux server. */
  verifyPollIntervalMs?: number;
}

// ---------- ADR-137: member-forcepush-recent probe ----------

export interface CheckMemberForcePushRecentOpts {
  /** Git spawn override (test injection). Default uses the local
   *  `defaultGitSpawn` shared with the other doctor probes. */
  gitSpawn?: GitSpawn;
  /** Epoch-seconds clock override. Default `Date.now() / 1000`. Tests
   *  pin this to make `reflog --date=unix` matching deterministic. */
  now?: () => number;
  /** Time window in seconds. Default 3600 (1h). Reflog entries older
   *  than `now - windowSec` are skipped — the probe only fires on
   *  recent force-pushes; ancient history doesn't ping.
   *
   *  Operators who want a wider window can override via the `--`
   *  command-line wiring (deferred — not in this Task's scope). */
  windowSec?: number;
}

/**
 * ADR-137 §D3 — surface force-push events on per-member branches within
 * the last hour as YELLOW (warn-class, not block-class). The probe is
 * advisory: the harness force-push deny rule remains the actual gate;
 * this probe is the post-hoc surface for cases where the operator
 * authorized the force-push and the team-lead wants to know it
 * happened so the team can be nudged toward the ADR-137 merge-over-
 * rebase convention.
 *
 * Mechanism — for each member with a worktree under `<atmuxDir>/worktrees/`:
 *
 *   1. Resolve the worktree path (skipped if `worktreeIsolation !== true`
 *      — single-trunk teams don't have per-member branches to probe).
 *   2. Resolve the worktree's current branch via `git -C <wt>
 *      branch --show-current`. Skip if unresolvable (detached HEAD,
 *      missing worktree, broken git state — `checkWorktreeIsolation`
 *      already surfaces those).
 *   3. Read the reflog for that branch with `git -C <wt> reflog show
 *      <branch> --date=unix --format='%gd %gs' -n 30`. Entries arrive
 *      newest-first.
 *   4. Parse each line for `@{<unix>}` timestamp + reflog message.
 *      Filter: timestamp must be within `windowSec` of `now`, AND
 *      message must match `/forced/i` (covers `update by push
 *      (forced)`, `forced-update`, and the older `non-fast forward`
 *      reflog wordings).
 *   5. One YELLOW row per member with at least one matching event.
 *      Multiple force-pushes in the window collapse to a single row
 *      (the hint is the same regardless of count).
 *
 * Returns `[]` when no force-push events found or when the team's
 * worktree-isolation isn't on. Probe failures (git missing, worktree
 * unreadable) collapse to `[]` rather than throw — the team's own
 * doctor surface must stay green even when this probe can't run.
 */
export async function checkMemberForcePushRecent(
  team: Team | null,
  atmuxDir: string,
  opts: CheckMemberForcePushRecentOpts = {},
): Promise<DoctorRow[]> {
  if (team === null) return [];
  if (team.worktreeIsolation !== true) return [];
  const git = opts.gitSpawn ?? defaultGitSpawn;
  const nowFn = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const windowSec = opts.windowSec ?? 3600;
  const now = nowFn();
  const cutoff = now - windowSec;

  const rows: DoctorRow[] = [];
  for (const member of team.members) {
    const wt = resolveWorktreePath(team, member.name, atmuxDir);
    let branch: string;
    try {
      const branchR = await git(["-C", wt, "branch", "--show-current"]);
      if (branchR.exitCode !== 0) continue;
      branch = branchR.stdout.trim();
      if (branch.length === 0) continue; // detached HEAD
    } catch {
      continue; // worktree gone, git missing, etc. — skip silently
    }

    let reflog: string;
    try {
      const reflogR = await git([
        "-C",
        wt,
        "reflog",
        "show",
        branch,
        "--date=unix",
        "-n",
        "30",
        "--format=%gd %gs",
      ]);
      if (reflogR.exitCode !== 0) continue;
      reflog = reflogR.stdout;
    } catch {
      continue;
    }

    let matchedMsg: string | null = null;
    for (const line of reflog.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const m = /@\{(\d+)\}:?\s*(.*)$/.exec(trimmed);
      if (m === null) continue;
      const ts = Number.parseInt(m[1] ?? "", 10);
      const msg = m[2] ?? "";
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (/forced/i.test(msg)) {
        matchedMsg = msg;
        break;
      }
    }
    if (matchedMsg !== null) {
      const short = matchedMsg.length > 60 ? `${matchedMsg.slice(0, 60)}…` : matchedMsg;
      rows.push({
        status: "yellow",
        label: `member-forcepush-recent:${member.name}`,
        detail: `${branch} reflog within ${windowSec}s: ${short}`,
        hint: "did you mean to merge instead of rebase? see ADR-137 §D1 — `git merge origin/<base>` keeps the branch in a consistent published state",
      });
    }
  }
  return rows;
}

// ---------- ADR-138 T3: send-keys-failure-recent probe ----------

export interface CheckSendKeysFailureRecentOpts {
  /** Override the `$HOME` used to resolve the escalation log path.
   *  Defaults to `process.env.HOME ?? ""`. Tests pin this so the probe
   *  reads from a sandbox directory. */
  home?: string;
  /** Direct override of the escalation log path. Wins over `home` when
   *  set. */
  logPath?: string;
  /** Epoch-seconds clock override (test injection). Defaults to
   *  `Date.now() / 1000`. */
  now?: () => number;
  /** Time window in seconds. Default 3600 (1h). Entries older than
   *  `now - windowSec` are not counted. */
  windowSec?: number;
}

/**
 * ADR-138 §"Doctor probe" — surfaces send-keys verification failures
 * (entries appended to `~/.atmux/state/send-keys-failures.log` by
 * `safeSendKeysWithVerify`'s escalation path) within the last hour
 * as a single YELLOW row.
 *
 * Warn-class because:
 *   - The escalation log is post-hoc evidence; the calling verb has
 *     already decided "this send-keys didn't verify" and returned its
 *     own non-zero or `success: false`.
 *   - The fix is operator-side (investigate stuck member, check budget,
 *     rotate-lead, etc.); the probe's role is surfacing, not blocking.
 *
 * Returns `[]` when the log is absent, empty, or has zero entries
 * within the window. Log-parse failures (corrupt file, permission
 * error, decode error) collapse to `[]` — the team's own doctor
 * surface must stay green even when this probe can't run. The log is
 * append-only + operator-managed; the probe doesn't truncate or
 * rewrite.
 *
 * Log entry shape (per `writeEscalationLog` in `src/core/safe-send.ts`):
 *
 *   [HH:MM MYT YYYY-MM-DD] target=<tgt> keys='<keys>' attempts=N timeout=Nms
 *   preCapture: <last 5 lines>
 *   postCapture: <last 5 lines>
 *   ---
 *
 * Parser anchors on the leading `[HH:MM MYT YYYY-MM-DD]` timestamp;
 * every other line is body and ignored. MYT is `+08:00` per global
 * CLAUDE.md §Timezone — the timestamp is parsed as a literal
 * `YYYY-MM-DDTHH:MM:00+08:00` ISO string.
 */
export async function checkSendKeysFailureRecent(
  opts: CheckSendKeysFailureRecentOpts = {},
): Promise<DoctorRow[]> {
  const nowFn = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const windowSec = opts.windowSec ?? 3600;
  const now = nowFn();
  const cutoff = now - windowSec;

  const logPath =
    opts.logPath ??
    (() => {
      const home = opts.home ?? process.env.HOME ?? "";
      return home === ""
        ? DEFAULT_SEND_KEYS_FAILURES_LOG_REL
        : `${home}/${DEFAULT_SEND_KEYS_FAILURES_LOG_REL}`;
    })();

  const text = await readTextOrNull(logPath).catch(() => null);
  if (text === null || text.length === 0) return [];

  // Anchor on `[HH:MM MYT YYYY-MM-DD]` at line start. The MYT marker
  // disambiguates the timestamp shape from any timestamps that might
  // appear inside the `preCapture` / `postCapture` body lines.
  const tsRe = /^\[(\d{2}):(\d{2}) MYT (\d{4}-\d{2}-\d{2})\]/gm;
  let recentCount = 0;
  let mostRecentTs = 0;
  let mostRecentTarget = "";
  let m: RegExpExecArray | null = tsRe.exec(text);
  while (m !== null) {
    const [, hh, mm, ymd] = m;
    const epoch = Math.floor(Date.parse(`${ymd}T${hh}:${mm}:00+08:00`) / 1000);
    if (Number.isFinite(epoch) && epoch >= cutoff && epoch <= now) {
      recentCount += 1;
      if (epoch > mostRecentTs) {
        mostRecentTs = epoch;
        // Pull the `target=<tgt>` from the rest of the matched line for
        // the hint. `target` field is always present on entries written
        // by `writeEscalationLog` — defensive null on a malformed line.
        const lineEnd = text.indexOf("\n", m.index);
        const rest = text.slice(m.index, lineEnd === -1 ? text.length : lineEnd);
        const tm = /target=(\S+)/.exec(rest);
        mostRecentTarget = tm?.[1] ?? "";
      }
    }
    m = tsRe.exec(text);
  }

  if (recentCount === 0) return [];

  const ageMin = Math.max(1, Math.floor((now - mostRecentTs) / 60));
  const targetHint = mostRecentTarget.length > 0 ? ` (last: ${mostRecentTarget})` : "";
  return [
    {
      status: "yellow",
      label: "send-keys-failure-recent",
      detail: `${recentCount} send-keys failure${recentCount === 1 ? "" : "s"} in last hour${targetHint} — most recent ${ageMin}min ago`,
      hint: "send-keys failed N times in last hour; check ADR-138 escalation log at ~/.atmux/state/send-keys-failures.log",
    },
  ];
}

// ---------- ADR-136 TR4: member-label-collision probe ----------

/**
 * ADR-136 TR4 §"Doctor probe" — surfaces members sharing the same
 * `(emoji, display-name)` tuple as a YELLOW row. Display-name is
 * `label ?? name`, so a fresh team without labels has zero collisions
 * by construction (each ID is unique); the probe only fires when
 * `atmux member rename` has produced a colliding display-name pair.
 *
 * Warn-class because:
 *   - It's an operator-misconfiguration nudge, not a state corruption.
 *     The underlying IDs (`member.name`) remain unique, so all
 *     persistent storage classes (worktree path, branch name, kanban
 *     owner, inbox file) still address each member unambiguously.
 *   - Two members showing as `🛠️ worker` in `atmux status` is a UX
 *     hazard — the operator can't tell them apart visually — but no
 *     execution path is wrong; the bullet recommends a rename rather
 *     than blocking.
 *
 * Skipped when `team === null`. Returns one row per colliding tuple
 * (NOT per colliding member), listing both `name` IDs in `detail` so
 * the operator can pick which one to rename. Members with no `emoji`
 * collide on display-name alone; that's still a valid trip.
 */
export function checkMemberLabelCollision(team: Team | null): DoctorRow[] {
  if (team === null) return [];
  // Group members by `(emoji, displayName)` tuple. Empty/undefined emoji
  // collapses to "" so name-only collisions still group correctly.
  const groups = new Map<string, { ids: string[]; emoji: string; display: string }>();
  for (const m of team.members) {
    const emoji = m.emoji ?? "";
    const display = m.label !== undefined && m.label.length > 0 ? m.label : m.name;
    const key = `${emoji} ${display}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { ids: [m.name], emoji, display });
    } else {
      existing.ids.push(m.name);
    }
  }
  const rows: DoctorRow[] = [];
  for (const g of groups.values()) {
    if (g.ids.length < 2) continue;
    const visual = g.emoji.length > 0 ? `${g.emoji}-${g.display}` : g.display;
    rows.push({
      status: "yellow",
      label: `member-label-collision:${g.display}`,
      detail: `${g.ids.length} members share display '${visual}': ${g.ids.join(", ")}`,
      hint: "rename one via `atmux member rename <id> --label <new>` so each member is visually distinct",
    });
  }
  return rows;
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

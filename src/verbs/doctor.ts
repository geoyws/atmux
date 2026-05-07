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
import { resolveWebhookUrl } from "../abstractions/discord.ts";
import { readTextOrNull, removeFile, statOrNull, writeText } from "../abstractions/fs.ts";
import { probeStatus } from "../abstractions/http.ts";
import { tryReadJson } from "../abstractions/json.ts";
import { createTmux } from "../abstractions/tmux.ts";
import {
  getAtmuxDir,
  getDefaultSocket,
  inboxPathFor,
  kanbanJsonPath,
  type ResolveDirOpts,
  teamJsonPath,
  tryLoadTeam,
} from "../core/common.ts";
import {
  composeCatastrophicDrift,
  composeDriftReport,
  type DriftReport,
} from "../core/whip-config-drift.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";
import { Inbox } from "../schema/inbox.ts";
import { Kanban } from "../schema/kanban.ts";
import { Team as TeamSchema, type Team, type TeamMember } from "../schema/team.ts";

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

export type DoctorStatus = "green" | "yellow" | "red";

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
  const firstSummary = first === undefined
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
      const tmux = createTmux({ socketPath: getDefaultSocket(team.name) });
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

// ---------- Render ----------

const STATUS_GLYPH: Record<DoctorStatus, string> = {
  green: "✅",
  yellow: "⚠️ ",
  red: "❌",
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
  rows.push(...(await checkOrphanSessions(team)));
  // ADR-054 §D4: surface whip-config drift so the operator doesn't
  // need to wait for the next whip tick to learn about it.
  rows.push(...(await checkWhipConfigDrift(atmuxDir)));
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

  // --fix is a stub for V-24 in-scope: surface a hint, don't run
  // anything destructive. Phantom-prune + team.json wizard re-run land
  // when V-01 (up) wires doctor as start preflight per ADR-019 §"Fix".
  if (parsed.fix && !parsed.quiet) {
    stderr(
      "\natmux doctor --fix: V-24 ships read-only checks; --fix actions deferred per ADR-019.\n",
    );
  }

  return report.redCount === 0 ? 0 : 1;
}

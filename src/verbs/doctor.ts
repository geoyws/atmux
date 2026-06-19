// ADR-010 + ADR-019 + ADR-263: CLI dispatcher — `doctor` verb.
//
// Lean harness preflight. Per ADR-263 §D2 the doctor is slimmed to the
// tmux-harness probes only: deps, team.json, TUI-on-PATH, state-dir
// writability, and tmux version. Every fleet-coordination probe (orchd /
// cockpit / cron / budget / skills-plugin / release-note / refusal /
// merger / honker / host-pressure / worktree / driver-pane / member-cage
// / inbox / discord) is removed — the fleet brain it surfaced is gone.
//
// In-scope checks:
//   - deps: tmux/jq/git required + curl/bats/shellcheck optional
//   - team: team.json existence + valid JSON + .name + .members[] +
//     per-member name/tui (flat pane list — no roles)
//   - tuis: each member's TUI binary on PATH (member.command override
//     wins → tuiCommands[tui] override → built-in name)
//   - state-dir: .atmux/ writable
//   - tmux-version: host tmux within the tested range (ADR-162 §Part C)
//
// Render: human (stderr, color, glyph table) or JSON (--json, stdout).
// --quiet suppresses output; exit 0 on green, 1 on any red.
// --fix is retained as a flag for CLI compatibility; all former fix
//   actions were fleet-coordination side-effects and are gone, so it now
//   only prints a deferred-actions notice.

import { join } from "node:path";
import { removeFile, statOrNull, writeText } from "../abstractions/fs.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import {
  getAtmuxDir,
  type ResolveDirOpts,
  teamJsonPath,
  tryLoadTeam,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { resolveTmuxBin } from "../core/resolve-tmux-bin.ts";
import { UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";

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
  ["curl", "needed for update check"],
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
        hint: "run: atmux add-member <name> --tui claude",
      },
    ];
  }
  // Flat pane list per ADR-263 §D1 — a pane needs only name + tui.
  const bad = team.members.filter((m) => m.name === undefined || m.tui === undefined);
  if (bad.length > 0) {
    const names = bad.map((m) => m.name ?? "(unnamed)").join(" ");
    return [
      {
        status: "red",
        label: "team.json",
        detail: `members missing name/tui: ${names}`,
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
  // final fs state matches a `[[ -w ]]` check which leaves no artefact.
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

// ---------- ADR-162 §Decision-anchor #5: tmux infrastructure probe ----------

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

/** Spawn override for the tmux probe. Test-injection point. */
export type TmuxSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

const defaultTmuxSpawn: TmuxSpawn = (argv) =>
  defaultSpawn({ cmd: resolveTmuxBin(), argv, expectExitCode: "any", timeoutMs: 5_000 });

export interface CheckTmuxVersionOpts {
  /** tmux spawn override. */
  tmux?: TmuxSpawn;
}

/**
 * ADR-162 §Decision-anchor #5 — `tmux-version-mismatch`. Runs
 * `tmux -V`, parses output, and surfaces a yellow row when the host
 * tmux falls below {@link TMUX_MIN_VERSION} or above
 * {@link TMUX_TESTED_VERSION}. Both bounds are warn-class (non-
 * blocking).
 *
 * Unparseable output (`tmux next-3.7`, `tmux master`, missing tmux)
 * collapses to a yellow row so the operator still sees something
 * instead of a silent skip.
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
        hint: `host tmux not invokable; min ${TMUX_MIN_VERSION}, tested ${TMUX_TESTED_VERSION}.`,
      },
    ];
  }
  if (result.exitCode !== 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `tmux -V exited ${result.exitCode}`,
        hint: `host tmux not responding; min ${TMUX_MIN_VERSION}, tested ${TMUX_TESTED_VERSION}.`,
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
        hint: "ADR-138 send-keys verifier may break; upgrade tmux.",
      },
    ];
  }
  if (compareTmuxVersion(parsed, tested) > 0) {
    return [
      {
        status: "yellow",
        label: "tmux-version-mismatch",
        detail: `host tmux ${actual} above tested ${TMUX_TESTED_VERSION}`,
        hint: "untested version; report regressions to atmux issues.",
      },
    ];
  }
  return [];
}

// ---------- Public verb entry ----------

export interface DoctorOpts {
  stdout?: Writer;
  stderr?: Writer;
  /** Inject the underlying check executors (test override). */
  runChecks?: (atmuxDir: string, team: Team | null) => Promise<DoctorRow[]>;
}

/** Default chain — the lean harness checks per ADR-263 §D2. */
export async function runAllChecks(atmuxDir: string, team: Team | null): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  rows.push(...checkDeps());
  rows.push(...(await checkTeam(atmuxDir)));
  if (team !== null) {
    rows.push(...checkTuis(team));
  }
  rows.push(...(await checkStateDir(atmuxDir)));
  // ADR-162 §Decision-anchor #5: warn-class tmux version probe. Surfaces
  // only when the host tmux drifts below the minimum or above the tested
  // bound. Never blocks.
  rows.push(...(await checkTmuxVersionMismatch()));
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

  // --fix is retained as a flag for CLI compatibility. Every former fix
  // action was a fleet-coordination side-effect (brief re-paste, phantom-
  // claim prune, orphan-branch deletion) and is removed per ADR-263 §D4;
  // the lean harness has no auto-remediation, so --fix only surfaces a
  // notice now.
  if (parsed.fix && !parsed.quiet) {
    stderr("\natmux doctor --fix: no auto-fix actions (lean harness; ADR-263 §D4).\n");
  }

  return report.redCount === 0 ? 0 : 1;
}

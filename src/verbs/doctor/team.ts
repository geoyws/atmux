import { teamJsonPath, tryLoadTeam } from "../../core/common.ts";
import type { Team, TeamMember } from "../../schema/team.ts";
import { installHint } from "./deps.ts";
import { type DoctorRow, defaultWhich } from "./types.ts";

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

/** ADR-285 §D2 — visibility for the distinct cooperative bot seat.
 *  Absent/disabled blocks are silent because transient teams deliberately
 *  do not inherit bots. A shell-only seat is usable by the operator but
 *  yellow/unroutable for `_superbot`; an explicit harness gets the same
 *  executable resolution as members without making `_bot` a member. */
export function checkBotConfig(team: Team, opts: CheckTuisOpts = {}): DoctorRow[] {
  const bot = team.bot;
  if (bot?.enabled !== true) return [];
  const tui = bot.tui;
  if (tui === undefined || tui === null || tui === "shell" || tui === "bash" || tui === "zsh") {
    return [
      {
        status: "yellow",
        label: "bot:config",
        detail: `_bot starts in ${tui ?? "zsh"} for direct operator use but is unroutable`,
        hint: "set bot.tui and bot.claudeAccount explicitly before enabling automated offers",
      },
    ];
  }
  const synth: TeamMember = {
    name: "_bot",
    role: "bot",
    tui,
    cwd: bot.cwd,
    ...(typeof bot.claudeAccount === "string" ? { claudeAccount: bot.claudeAccount } : {}),
  };
  const resolved = resolveMemberBin(synth, team, opts.env ?? process.env);
  if ("unknown" in resolved) {
    return [
      {
        status: "red",
        label: `bot:tui:${resolved.unknown}`,
        detail: "unknown bot tui type",
        hint: "register it in team.tuiCommands or use claude/opencode/kimi/cursor",
      },
    ];
  }
  if ("skip" in resolved) return [];
  const path = (opts.which ?? defaultWhich)(resolved.bin);
  if (path === null) {
    return [
      {
        status: "red",
        label: `bot:tui:${resolved.bin}`,
        detail: "NOT on PATH (_bot)",
        hint: `install: ${installHint(resolved.bin, opts.platform ?? process.platform)}`,
      },
    ];
  }
  return [
    {
      status: "green",
      label: `bot:tui:${resolved.bin}`,
      detail: `${path} (_bot, actor bot@${team.name})`,
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

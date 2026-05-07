// ADR-010: CLI dispatcher — `rotate` / `rotate-lead` verbs.
// Bash spec: lib/rotate.sh @ worktree-frozen.
//
// `atmux rotate <member>` sends `/clear` to a Claude member's pane and
// re-pastes the role brief. `atmux rotate-lead` is sugar — finds the
// team-lead in roster + dispatches the same flow.
//
// For non-claude TUIs (opencode/kimi/cursor) `/clear` has no equivalent
// — the verb warns and proceeds to brief-paste only (parity with bash
// rotate.sh:52-54).

import { resolve } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { createTmux, type SendTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getDefaultSocket,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { writeLeadHandoff } from "../core/lead-handoff.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";

const USAGE = "atmux rotate <member>  |  atmux rotate-lead";

// ---------- Args ----------

export interface RotateArgs {
  /** Set when invoked as `rotate-lead` (or `rotate --lead`) — tells the
   *  verb to look up the team-lead member from roster instead of
   *  expecting a positional. */
  forLead: boolean;
  /** Member name; empty when `forLead` (resolved at runtime). */
  member: string;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseRotateArgs(argv: ReadonlyArray<string>): RotateArgs {
  let forLead = false;
  let member = "";
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--lead") {
      forLead = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "rotate: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "rotate: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({ what: `rotate: unknown flag: ${a}`, hint: USAGE });
    }
    if (member.length === 0) {
      member = a ?? "";
    } else {
      throw new UsageError({ what: "rotate: too many args", hint: USAGE });
    }
    i += 1;
  }
  const out: RotateArgs = { forLead, member };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Roster + brief helpers ----------

/** Bash `_atmux_find_lead_member`: first roster entry whose role is
 *  `team-lead`. Returns null when none. */
export function findLeadMember(team: Team): TeamMember | null {
  for (const m of team.members) {
    if (m.role === "team-lead") return m;
  }
  return null;
}

/** Bash `atmux::brief_path <role>` — returns `<briefsDir>/<role>.md`
 *  if it exists, else the `member.md` fallback. */
export async function getBriefPath(role: string, briefsDir: string): Promise<string> {
  const candidate = resolve(briefsDir, `${role}.md`);
  if (await exists(candidate)) return candidate;
  return resolve(briefsDir, "member.md");
}

/** Bash sed-replace pass for the `{{KEY}}` placeholders in role brief
 *  templates. Plain string-replacement; no regex special-casing needed
 *  because the placeholders never collide with markdown syntax. */
export function renderBrief(
  content: string,
  vars: { team: string; member: string; role: string; atmuxDir: string },
): string {
  return content
    .replaceAll("{{TEAM}}", vars.team)
    .replaceAll("{{MEMBER}}", vars.member)
    .replaceAll("{{ROLE}}", vars.role)
    .replaceAll("{{ATMUX_DIR}}", vars.atmuxDir);
}

/** Default briefs directory: `<repo-root>/templates/briefs/`. Mirrors
 *  bash `$ATMUX_ROOT/templates/briefs/`. Tests inject via opts. */
export function defaultBriefsDir(): string {
  return resolve(import.meta.dir, "..", "..", "templates", "briefs");
}

// ---------- Tmux side-effect helpers ----------

/** `tmux list-windows -t <session>` returns `{name}[]` — true iff any
 *  matches `expected`. Mirrors bash `atmux::tmux_window_exists`. */
export async function windowExists(
  tmux: TmuxNamespace,
  session: string,
  expected: string,
): Promise<boolean> {
  const windows = await tmux.window.listWindows(session);
  return windows.some((w) => w.name === expected);
}

// ---------- Public verb entry ----------

export interface RotateOpts {
  /** Override the briefs directory (test injection). */
  briefsDir?: string;
  /** Override `process.stdout.write`-shaped sink (test injection). */
  stdout?: Writer;
  /** Override `process.stderr.write`-shaped sink (test injection). */
  stderr?: Writer;
  /** Sleep override — bash `sleep 2` after /clear, `sleep 1` after
   *  paste. Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Tmux factory override (test injection). Defaults to `createTmux({
   *  socketPath })` per the verb's resolved socket path. */
  buildTmux?: (socketPath: string) => TmuxNamespace;
  /** Clock override (epoch ms). Defaults to `time.now()`. Used for the
   *  pre-rotate handoff file path + header timestamp (D2c). */
  now?: () => number;
}

/** Default `setTimeout`-backed sleep. Exported so the same code path
 *  tests drive directly is the one prod uses. */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Default tmux factory — wraps `createTmux({ socketPath })`. Exported
 *  so tests can hit the closure body without going through the
 *  rotate() verb. */
export function defaultBuildTmux(socketPath: string): TmuxNamespace {
  return createTmux({ socketPath });
}

/** `atmux rotate <member>` / `atmux rotate-lead`. Returns 0 on success. */
export async function rotate(argv: ReadonlyArray<string>, opts: RotateOpts = {}): Promise<number> {
  const parsed = parseRotateArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team: Team = await requireTeam(dirOpts);

  // Resolve the target member — `--lead` looks up roster; bare form
  // requires positional.
  let target: TeamMember | undefined;
  if (parsed.forLead) {
    const lead = findLeadMember(team);
    if (lead === null) {
      throw new ConfigError({
        what: "rotate-lead: no team-lead defined in team.json",
      });
    }
    target = lead;
  } else if (parsed.member.length > 0) {
    target = team.members.find((m) => m.name === parsed.member);
    if (target === undefined) {
      throw new ConfigError({ what: `rotate: no such member in team.json: ${parsed.member}` });
    }
  } else {
    throw new UsageError({ what: USAGE });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? getDefaultSocket(team.name);
  const tmux = (opts.buildTmux ?? defaultBuildTmux)(socketPath);

  const windowName = buildWindowName(target.name, target.emoji);
  if (!(await windowExists(tmux, sessionName, windowName))) {
    throw new ConfigError({ what: `no tmux window for ${target.name}` });
  }
  const tmuxTarget = `${sessionName}:${windowName}`;
  const tui = typeof target.tui === "string" ? target.tui : "claude";
  const role = typeof target.role === "string" ? target.role : "member";
  const sleep = opts.sleep ?? defaultSleep;
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  // ADR-025 SendTarget: encode "this is a member or lead pane, NOT a
  // driver pane". `kind: "lead"` for the team-lead role (rotate-lead
  // path); `kind: "member"` otherwise. The compile-time gate is the
  // discriminated union; the audit metadata (member/team) makes the
  // intent reviewer-greppable.
  const sendTarget: SendTarget =
    role === "team-lead"
      ? { kind: "lead", team: team.name, target: tmuxTarget }
      : { kind: "member", member: target.name, team: team.name, target: tmuxTarget };

  // 0. Pre-rotate lead handoff (ADR-057 §D2c). Only fires for the
  //    team-lead role — regular member rotations have no equivalent
  //    coordination state to snapshot. Best-effort: a handoff write
  //    failure logs to stderr but doesn't abort the rotation (the
  //    /clear + brief-paste must still happen so the team isn't left
  //    with a half-cycled lead pane).
  if (role === "team-lead") {
    const clock = opts.now ?? nowMs;
    const epochSec = Math.floor(clock() / 1000);
    try {
      const path = await writeLeadHandoff({
        atmuxDir,
        team: team.name,
        outgoingLead: target.name,
        nowEpochSec: epochSec,
      });
      stdout(`rotate: lead handoff written to ${path}\n`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      stderr(`rotate: warn: lead handoff write failed (${reason}); continuing rotation\n`);
    }
  }

  // 1. /clear for claude — best-effort warn for other TUIs (parity
  //    with bash rotate.sh:47-55).
  if (tui === "claude") {
    await tmux.pane.sendKeys({ target: sendTarget, keys: "/clear", enter: true });
    await sleep(2_000);
  } else {
    stderr(`rotate: tui=${tui} has no /clear equivalent — will re-paste brief only\n`);
  }

  // 2. Render + paste the role brief if present (parity with bash
  //    rotate.sh:57-74). Bash silently skips when the brief file is
  //    missing — we mirror.
  const briefsDir = opts.briefsDir ?? defaultBriefsDir();
  const briefPath = await getBriefPath(role, briefsDir);
  if (await exists(briefPath)) {
    const tpl = await Bun.file(briefPath).text();
    const body = renderBrief(tpl, {
      team: team.name,
      member: target.name,
      role,
      atmuxDir,
    });
    const bufferName = `atmux_brief_rot_${target.name}`;
    await tmux.buffer.loadBuffer({ name: bufferName, data: body });
    await tmux.buffer.pasteBuffer({
      name: bufferName,
      target: sendTarget,
      deleteAfter: true,
    });
    await sleep(1_000);
    await tmux.pane.sendKeys({ target: sendTarget, keys: "Enter", enter: false });
  }

  stdout(`rotated ${target.name} (role=${role}, tui=${tui})\n`);
  return 0;
}

/** `atmux rotate-lead` shim — re-emits with `--lead` prepended. */
export async function rotateLead(
  argv: ReadonlyArray<string>,
  opts: RotateOpts = {},
): Promise<number> {
  return rotate(["--lead", ...argv], opts);
}

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
import { appendText, exists } from "../abstractions/fs.ts";
import { now as nowMs } from "../abstractions/time.ts";
import { createTmux, type SendTarget, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  type BootClaudeOpts,
  type BootResult,
  bootClaudeMember,
  renderBootFailureNotice,
} from "../core/boot-claude.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  leadOutboxPath,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { injectGoalIfActive } from "../core/goal-injection.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { writeLeadHandoff } from "../core/lead-handoff.ts";
import { writeLeadSessionStart } from "../core/lead-marker.ts";
import { submitAfterPaste } from "../core/paste-submit.ts";
import { safePreflight } from "../core/safe-send.ts";
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
    if (a?.startsWith("-")) {
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

/** Role → brief-filename aliases. The schema-canonical role name and the
 *  brief filename diverge in one place: role `team-lead` reads from
 *  `lead.md` (renamed per ADR-007 pull-model). Aliases resolve first so
 *  a stale `<role>.md` tombstone in the briefs dir can't shadow the
 *  canonical file. */
const BRIEF_ALIASES: Readonly<Record<string, string>> = {
  "team-lead": "lead",
};

/** Bash `atmux::brief_path <role>` — returns `<briefsDir>/<role>.md`
 *  if it exists, else the `member.md` fallback. Role aliases (see
 *  `BRIEF_ALIASES`) are resolved before the existence check. */
export async function getBriefPath(role: string, briefsDir: string): Promise<string> {
  const fileBase = BRIEF_ALIASES[role] ?? role;
  const candidate = resolve(briefsDir, `${fileBase}.md`);
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
   *  pre-rotate handoff file path + header timestamp (D2c) AND the
   *  post-rotate `lead-session-start.txt` marker write (t-afd3fe38). */
  now?: () => number;
  /** ADR-081 §C completion (t-94d7ad60): override the boot-claude
   *  knobs for the claude-TUI re-bootstrap path. `tmux`, `sendTarget`,
   *  `paneTargetString`, `team`, `member` are always overwritten by
   *  rotate.ts; the override carries the tunable subset (timeouts,
   *  sleep, etc.) for tests. */
  bootClaude?: Partial<BootClaudeOpts>;
  /** Override `$HOME` for the `~/.claude/teams/<team>/lead-session-start.txt`
   *  marker write (t-afd3fe38). Tests pass a scratch dir so the marker
   *  doesn't touch the operator's real `~/.claude`. */
  leadMarkerHome?: string;
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
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
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

  // safe-send adapter shared by the /clear preflight + brief preflight.
  // Wraps `tmux.pane.sendKeys` with the SendTarget already constructed
  // above (kind=lead/member per role); the adapter takes a string
  // target purely because safe-send.ts is generic over the ADR-025
  // discriminated union. Preflight only dispatches sendKeys for
  // known-modal dismissal keystrokes (e.g. "0" for the feedback
  // survey) — never for the rotation payload itself.
  const safeOpts = {
    capture: (t: string) => tmux.pane.capturePane({ target: t, start: -40 }),
    sendKeys: async (_t: string, text: string, sopts?: { enter?: boolean }) => {
      await tmux.pane.sendKeys({ target: sendTarget, keys: text, enter: sopts?.enter ?? false });
    },
    sleep,
  };

  // 1. /clear for claude — best-effort warn for other TUIs (parity
  //    with bash rotate.sh:47-55). Preflight first so a stuck modal
  //    (e.g. CC feedback survey) gets dismissed before /clear lands;
  //    then send /clear + Enter as a single tmux op (preserves
  //    pre-gate calling convention so test fixtures don't churn).
  //    Warn-and-proceed: a non-ready pane after preflight does NOT
  //    abort — rotation must still half-cycle the pane or we leave
  //    it stuck.
  if (tui === "claude") {
    await safePreflight(tmuxTarget, safeOpts);
    await tmux.pane.sendKeys({ target: sendTarget, keys: "/clear", enter: true });
    await sleep(2_000);
  } else {
    stderr(`rotate: tui=${tui} has no /clear equivalent — will re-paste brief only\n`);
  }

  // 2. Re-bootstrap the rotated pane.
  //
  // For claude TUIs (the rotation hot path — `/clear` only fires on
  // claude per step 1), use the readiness-poll + single-line
  // boot-prompt mechanism (ADR-081 §C completion / t-94d7ad60). Same
  // anti-undead-pane fix as start.ts — after `/clear` the compose
  // box is briefly absent while claude re-renders welcome, so the
  // boot prompt must wait for `❯` / `tokens` to re-appear before
  // sending. The bootClaudeMember sentinel ALSO short-circuits when
  // the rotation /clear didn't actually drain context (e.g. the
  // user's screen had `tokens` mid-burst when /clear was queued
  // and the prompt landed but never executed) — `already-booted`
  // path skips re-sending.
  //
  // For non-claude TUIs (rotate's step 1 already warned that
  // /clear has no equivalent), fall through to the legacy
  // paste-buffer flow — these TUIs don't carry the
  // bracketed-paste-newline trap that motivated the new path.
  if (tui === "claude") {
    const bootOpts: BootClaudeOpts = {
      tmux,
      sendTarget,
      paneTargetString: tmuxTarget,
      team: team.name,
      member: target.name,
    };
    if (opts.bootClaude !== undefined) {
      Object.assign(bootOpts, opts.bootClaude);
    }
    let bootResult: BootResult;
    try {
      bootResult = await bootClaudeMember(bootOpts);
    } catch (e) {
      const cause = e instanceof Error ? e.message : String(e);
      stderr(`rotate: ${target.name}: bootClaudeMember threw (${cause})\n`);
      bootResult = { status: "failed", attempts: 0, reason: "capture-error" };
    }
    if (bootResult.status === "booted") {
      stdout(`rotate: ${target.name}: bootstrapped (${bootResult.attempts} attempt(s))\n`);
    } else if (bootResult.status === "already-booted") {
      stdout(`rotate: ${target.name}: already booted — boot prompt skipped\n`);
    } else {
      stderr(
        `rotate: ${target.name}: bootstrap FAILED after ${bootResult.attempts} attempt(s) (${bootResult.reason ?? "?"})\n`,
      );
      // Best-effort: surface to lead-outbox.md per task body §4.
      try {
        const nowIso = new Date().toISOString();
        await appendText(
          leadOutboxPath(atmuxDir),
          renderBootFailureNotice({
            team: team.name,
            member: target.name,
            result: bootResult,
            nowIso,
          }),
        );
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        stderr(`rotate: ${target.name}: failed to write boot-failure notice (${cause})\n`);
      }
    }
  } else {
    // Non-claude TUI: render + paste the role brief if present (parity
    // with bash rotate.sh:57-74). Bash silently skips when the brief
    // file is missing — we mirror.
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
      // Preflight before paste so /clear's post-clear modal (or any
      // residual feedback survey) doesn't eat the brief body.
      // Warn-and-proceed: refusal does NOT abort the rotation (the
      // brief MUST land or the rotation half-cycles).
      await safePreflight(tmuxTarget, safeOpts);
      const bufferName = `atmux_brief_rot_${target.name}`;
      await tmux.buffer.loadBuffer({ name: bufferName, data: body });
      await tmux.buffer.pasteBuffer({
        name: bufferName,
        target: sendTarget,
        deleteAfter: true,
      });
      // ADR-081 §A: settle + C-m (not Enter) — bracketed-paste mode under
      // claude TUIs eats the trailing Enter as a multi-line continuation,
      // leaving the brief queued in the compose box. 1000ms here is the
      // pre-existing rotate-specific settle (rotation runs once per
      // teammate; the extra 500ms over the §A floor isn't latency-sensitive).
      await submitAfterPaste(tmux, sendTarget, { settleMs: 1_000, sleep });
    }
  }

  // 2c. ADR-157 T3: /goal injection (post-brief). Fires AFTER step 2's
  //     boot/brief-paste so the slash command lands in a clean compose
  //     box (reviewer pre-flag #2 — brief-paste-ordering). NO-OP cleanly
  //     when `member.runtime === "cursor"` (ADR-157 §D4) or when neither
  //     `member.goal` nor brief `## Standing Goal` resolves (T2
  //     resolution chain). Best-effort: a verify-failed injection is
  //     escalated to send-keys-failures.log per ADR-138 but does NOT
  //     abort rotation — the lane-tick backstop (T4) must still apply to
  //     goal-set-but-injection-failed members so the drain isn't
  //     deadlocked (reviewer pre-flag #3).
  if (tui === "claude") {
    const briefsDir = opts.briefsDir ?? defaultBriefsDir();
    const briefPath = await getBriefPath(role, briefsDir);
    const goalOpts: Parameters<typeof injectGoalIfActive>[0] = {
      tmux,
      sendTarget,
      paneTargetString: tmuxTarget,
      member: target,
      logger: {
        log: (s) => stdout(`rotate: ${s}\n`),
        warn: (s) => stderr(`rotate: ${s}\n`),
      },
    };
    if (briefPath.length > 0) goalOpts.briefPath = briefPath;
    if (opts.sleep !== undefined) goalOpts.sleep = opts.sleep;
    try {
      await injectGoalIfActive(goalOpts);
    } catch (e) {
      // injectGoalIfActive itself doesn't throw — but if a future
      // dep does, swallow + warn rather than aborting the rotation.
      const reason = e instanceof Error ? e.message : String(e);
      stderr(
        `rotate: ${target.name}: /goal injection threw (${reason}); rotation continues — lane-tick backstop applies\n`,
      );
    }
  }

  // 3. t-afd3fe38: on the team-lead path, refresh `lead-session-start.txt`
  //    with the new spawn epoch so ADR-143's cron-fired uptime gate
  //    reads the rotated lead's clock, not the stale pre-rotate one.
  //    Without this, the marker stays at the OLD value → uptime gate
  //    re-fires on every tick → rotation flap loop. Best-effort: a
  //    marker-write failure logs to stderr but doesn't abort (the
  //    rotation itself succeeded; only the cron-gate hint stays stale).
  if (role === "team-lead") {
    const clock = opts.now ?? nowMs;
    const epochSec = Math.floor(clock() / 1000);
    try {
      const markerOpts = opts.leadMarkerHome !== undefined ? { home: opts.leadMarkerHome } : {};
      await writeLeadSessionStart(team.name, epochSec, markerOpts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      stderr(
        `rotate: warn: lead-session-start.txt write failed (${reason}); ADR-143 cron-gate may flap\n`,
      );
    }
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

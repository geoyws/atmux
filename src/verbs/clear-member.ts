// e-cc3728bf T3 (ADR-212 §D2 lead-gated) — `clear-member` verb.
//
// Deeper reset than `rotate`: kills the member's tmux window and
// recreates it as a bare shell — no /clear, no brief paste, no boot
// prompt. For wedged panes where rotate's /clear cannot land. The
// operator (or lead) re-briefs by hand afterwards.
//
// Destructive by design: refuses without --force. No autonomous
// caller may invoke this (rotation consumer suggests `rotate`, never
// `clear-member`).

import {
  buildWindowName,
  buildWindowNameLegacy,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
  resolveWindowWithRenameShim,
  type WindowShimOps,
} from "../core/common.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";
import type { TmuxNamespace } from "../abstractions/tmux.ts";
import { defaultBuildTmux } from "./rotate.ts";

const USAGE = "atmux clear-member <member> --force [--socket <path>] [--team-dir <path>]";

/** Parsed `clear-member` argv. */
export interface ClearMemberArgs {
  member: string;
  force: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. */
export function parseClearMemberArgs(argv: ReadonlyArray<string>): ClearMemberArgs {
  let member = "";
  let force = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--force" || a === "-f") {
      force = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "clear-member: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "clear-member: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `clear-member: unknown flag: ${a}`, hint: USAGE });
    }
    if (member.length === 0) {
      member = a ?? "";
    } else {
      throw new UsageError({ what: "clear-member: too many args", hint: USAGE });
    }
    i += 1;
  }
  if (member.length === 0) {
    throw new UsageError({ what: `usage: ${USAGE}` });
  }
  const out: ClearMemberArgs = { member, force };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Test seams (mirrors rotate's RotateOpts subset). */
export interface ClearMemberOpts {
  buildTmux?: (socketPath: string) => TmuxNamespace;
  stdout?: Writer;
}

/**
 * `atmux clear-member <member> --force`. Kills the member window and
 * recreates it bare (zsh at the team root). Refuses without --force.
 * Returns 0.
 */
export async function clearMember(argv: ReadonlyArray<string>, opts: ClearMemberOpts = {}): Promise<number> {
  const parsed = parseClearMemberArgs(argv);
  if (!parsed.force) {
    throw new UsageError({
      what: `clear-member: refusing to wipe ${parsed.member} without --force (destructive: window killed, brief NOT re-pasted)`,
      hint: USAGE,
    });
  }
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team: Team = await requireTeam(dirOpts);
  const target: TeamMember | undefined = team.members.find((m) => m.name === parsed.member);
  if (target === undefined) {
    throw new ConfigError({ what: `clear-member: no such member in team.json: ${parsed.member}` });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = (opts.buildTmux ?? defaultBuildTmux)(socketPath);
  const stdout = opts.stdout ?? defaultStdoutWrite;

  const canonical = buildWindowName(target.name, target.emoji, target.label, target.role);
  const shimOps: WindowShimOps = {
    listWindowNames: async (s) => (await tmux.window.listWindows(s)).map((w) => w.name),
    renameWindow: (s, from, to) => tmux.window.renameWindow(`${s}:${from}`, to),
  };
  const windowName = await resolveWindowWithRenameShim(
    sessionName,
    canonical,
    [buildWindowName(target.name, target.emoji, target.label), buildWindowNameLegacy(target.name, target.emoji)],
    shimOps,
  );
  await tmux.window.killWindow(`${sessionName}:${windowName}`);
  const teamRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
  await tmux.window.newWindow({ sessionName, name: windowName, cwd: teamRoot });
  stdout(`cleared ${target.name} (window=${windowName}) — bare shell at ${teamRoot}; re-brief by hand\n`);
  return 0;
}

// ADR-010: CLI dispatcher — `dispatch` verb (lead-side task assignment).
// Bash spec: lib/dispatch.sh @ worktree-frozen.
//
// Lead-side workflow:
//
//   atmux dispatch <member> <task-id> [--no-ping]
//
// Pushes a task into a member's inbox, sets owner + status="in-progress"
// + claimedAt on the kanban side, and pings the member's pane with a
// "📨 NEW TASK from team-lead" notification.
//
// Refusal cases (all bash-die'd):
//
// - Unknown member name (not in team.json)        → ConfigError
// - Member is paused (per pause.ts isPaused)      → ConfigError
// - No such task id                                → ConfigError
// - Task has unresolved deps (some dep != "done")  → ConfigError
//
// All four mirror bash lib/dispatch.sh:21, 31-33, 41, 49-51.
//
// On success the verb stamps `dispatchedAt` on the inbox entry +
// pings the member's pane with the task body via core/send.ts unless
// --no-ping. Per CLAUDE.md "ping on start" rule, the ping body
// includes the claim/done command lines so the operator can copy-paste
// directly.

import { createTmux } from "../abstractions/tmux.ts";
import { appendDispatched } from "../core/inbox.ts";
import { claimTask } from "../core/kanban.ts";
import { isPaused } from "../core/pause.ts";
import { sendToMember } from "../core/send.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import type { Team } from "../schema/team.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { defaultSocketPath } from "./start.ts";

const USAGE = "atmux dispatch <member> <task-id> [--no-ping]";

/** Parsed `dispatch` argv. */
export interface DispatchArgs {
  member: string;
  id: string;
  noPing: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseDispatchArgs(argv: ReadonlyArray<string>): DispatchArgs {
  let member = "";
  let id = "";
  let noPing = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--no-ping") {
      noPing = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "dispatch: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "dispatch: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({ what: `dispatch: unknown flag: ${a}`, hint: USAGE });
    }
    if (member.length === 0) {
      member = a ?? "";
    } else if (id.length === 0) {
      id = a ?? "";
    } else {
      throw new UsageError({ what: "dispatch: too many args", hint: USAGE });
    }
    i += 1;
  }
  if (member.length === 0 || id.length === 0) {
    throw new UsageError({ what: USAGE });
  }
  const out: DispatchArgs = { member, id, noPing };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Compose the bash dispatch ping body (lib/dispatch.sh:73-86). The
 * heredoc shape is preserved for byte-parity with the bash version
 * the operator may have memorized.
 */
export function buildDispatchPing(opts: { id: string; subject: string; body: string }): string {
  const lines = [
    "📨 NEW TASK from team-lead",
    "",
    `id: ${opts.id}`,
    `subject: ${opts.subject}`,
    "",
  ];
  if (opts.body.length > 0) {
    lines.push("body:", opts.body, "");
  }
  lines.push(`Claim it with: atmux claim ${opts.id}`);
  lines.push(`Mark done with: atmux done ${opts.id}`);
  return lines.join("\n");
}

/** `atmux dispatch <member> <task-id> [--no-ping]`. Returns 0 on success. */
export async function dispatch(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseDispatchArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};

  const team: Team = await requireTeam(dirOpts);
  const memberEntry = team.members.find((m) => m.name === parsed.member);
  if (memberEntry === undefined) {
    throw new ConfigError({
      what: `dispatch: no such member in team.json: ${parsed.member}`,
    });
  }

  const atmuxDir = await getAtmuxDir(dirOpts);

  if (await isPaused(atmuxDir, parsed.member)) {
    throw new ConfigError({
      what: `dispatch: ${parsed.member} is paused — resume with \`atmux resume ${parsed.member}\``,
    });
  }

  // claimTask enforces the deps gate AND the missing-id check + sets
  // owner/status="in-progress"/claimedAt — same kanban side-effect as
  // bash lib/dispatch.sh:55-58. The ConfigError it throws on missing-id
  // / unresolved-deps surfaces with the exact bash text.
  const claimed = await claimTask(atmuxDir, parsed.id, parsed.member);

  // Bash inbox-push (lib/dispatch.sh:62-65) stamps `dispatchedAt`
  // (NOT `claimedAt`) on the inbox entry — the inbox tracks the
  // dispatch event independently from the kanban claim. Mirror.
  await appendDispatched(atmuxDir, parsed.member, claimed, claimed.claimedAt ?? 0);

  process.stdout.write(`dispatched ${parsed.id} → ${parsed.member}\n`);

  if (!parsed.noPing) {
    const sessionName = await getSessionName({ ...dirOpts, team });
    const socketPath = parsed.socketPath ?? defaultSocketPath(team.name);
    const tmux = createTmux({ socketPath });
    const target = `${sessionName}:${buildWindowName(memberEntry.name, memberEntry.emoji)}`;
    const body = typeof claimed.body === "string" ? claimed.body : "";
    const subject = typeof claimed.subject === "string" ? claimed.subject : "";
    const ping = buildDispatchPing({ id: parsed.id, subject, body });
    try {
      await sendToMember(
        tmux,
        atmuxDir,
        { target, member: parsed.member },
        ping,
        // Bash passes `0 0` (no-submit=0, verify=0) — submit + skip-verify.
        { verify: false },
      );
    } catch (e) {
      // Bash logs `atmux::warn "dispatch: ping to $member failed"` and
      // returns 0; mirror — the dispatch itself succeeded, ping is
      // best-effort.
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(`atmux: warn: dispatch: ping to ${parsed.member} failed: ${reason}\n`);
    }
  }

  return 0;
}

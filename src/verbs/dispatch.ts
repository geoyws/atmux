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
import { appendDispatched, removeFromInProgress } from "../core/inbox.ts";
import { claimTask, showTask } from "../core/kanban.ts";
import { isPaused } from "../core/pause.ts";
import { verifierForTui } from "../core/safe-send.ts";
import { type SendOpts, sendToMember } from "../core/send.ts";
import { resolveTarget } from "../core/window-id.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

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
    if (a?.startsWith("-")) {
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

  // t-e452296b §(b): a re-dispatch from owner A → member B left A's
  // inbox.inProgress entry orphaned (the "cross-claim drift" the lead
  // hit on docs.json holding t-706655ee while kanban owner was
  // whip-impl). Pre-read the current owner; if reassigning, drain the
  // old owner's inbox + emit a stderr warning so the operator sees
  // they're stepping on an existing assignment. Refusal would break
  // legitimate reassignments — warn-and-drain is the lighter touch.
  const preOwn = await showTask(atmuxDir, parsed.id);
  const oldOwner =
    preOwn !== null && typeof preOwn.owner === "string" && preOwn.owner.length > 0
      ? preOwn.owner
      : null;
  if (oldOwner !== null && oldOwner !== parsed.member) {
    process.stderr.write(
      `atmux: warn: dispatch: reassigning ${parsed.id} from ${oldOwner} to ${parsed.member} (draining old owner's inbox)\n`,
    );
    await removeFromInProgress(atmuxDir, oldOwner, parsed.id);
  }

  // claimTask enforces the deps gate AND the missing-id check + sets
  // owner/status="in-progress"/claimedAt — same kanban side-effect as
  // bash lib/dispatch.sh:55-58. The ConfigError it throws on missing-id
  // / unresolved-deps surfaces with the exact bash text. Returns BOTH
  // pre-mutation + post-mutation snapshots per ADR-029 §F1 — bash
  // lib/dispatch.sh:39 captures `task` BEFORE the jq_update at line 54,
  // so the inbox entry at line 63-65 carries the ORIGINAL task shape
  // plus only `dispatchedAt`, not the mutated owner/status/claimedAt.
  const { pre, post } = await claimTask(atmuxDir, parsed.id, parsed.member);

  // Bash inbox-push (lib/dispatch.sh:62-65) stamps `dispatchedAt`
  // (NOT `claimedAt`) on the inbox entry — the inbox tracks the
  // dispatch event independently from the kanban claim. Mirror.
  // Use `pre` (pre-mutation snapshot) per F1 fix — bash inbox entry
  // does NOT carry the post-mutation owner/status/claimedAt triple.
  await appendDispatched(atmuxDir, parsed.member, pre, post.claimedAt ?? 0);

  process.stdout.write(`dispatched ${parsed.id} → ${parsed.member}\n`);

  if (!parsed.noPing) {
    const sessionName = await getSessionName({ ...dirOpts, team });
    // t-f786031f: honour team.tmuxTmpdir for the cage socket. Pre-fix
    // pinned `/tmp/atmux-<team>/sock` unconditionally; with that path
    // empty under project-local-tmpdir teams the dispatch-ping keystroke
    // silently failed (or worse, landed on a stale legacy socket if one
    // happened to exist), leaving members with queued-but-never-Enter'd
    // text in their compose box — the original 2026-05-08 t-f786031f
    // symptom of "4 members stuck at compose for 4h20m".
    const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
    const tmux = createTmux({ socketPath });
    // EPIC e-a3077ca0 T4: self-heal cross-format windows before
    // resolveTarget tries to find them by name. A cage continuously
    // running across the ADR-161 hyphen→underscore deploy will have
    // `🦦-docs` while buildWindowName now produces `🦦_docs`;
    // resolveWindowId's listWindows + name-match misses and
    // resolveTarget falls back to `<session>:<canonical>` — which
    // tmux can't address either. The shim renames legacy → canonical
    // in-place so resolveTarget's downstream lookup hits cleanly.
    //
    // Best-effort: dispatch.ts intentionally tolerates missing windows
    // (sendToMember's TmuxError is caught + warn-logged below — see the
    // `ping to <m> failed` test). If the shim itself can't find any of
    // the three forms, fall back to canonical and let the downstream
    // sendToMember produce its usual warn; throwing here would regress
    // the kanban-still-updates-on-missing-pane behavior the tests gate
    // on.
    const canonical = buildWindowName(
      memberEntry.name,
      memberEntry.emoji,
      memberEntry.label,
      memberEntry.role,
    );
    const adr135Hyphen = buildWindowName(memberEntry.name, memberEntry.emoji, memberEntry.label);
    const pre135NoSep = buildWindowNameLegacy(memberEntry.name, memberEntry.emoji);
    const shimOps: WindowShimOps = {
      listWindowNames: async (s) => (await tmux.window.listWindows(s)).map((w) => w.name),
      renameWindow: (s, from, to) => tmux.window.renameWindow(`${s}:${from}`, to),
    };
    let windowName: string;
    try {
      windowName = await resolveWindowWithRenameShim(
        sessionName,
        canonical,
        [adr135Hyphen, pre135NoSep],
        shimOps,
      );
    } catch {
      // Window absent in all three forms — preserve best-effort behavior:
      // resolveTarget falls back to `<session>:<canonical>` and the
      // sendToMember try-catch below logs the warn.
      windowName = canonical;
    }
    // ADR-057 §D5b: address the member by immutable @N window ID when
    // possible; falls back to `<session>:<windowName>` on cache miss
    // OR when the window doesn't exist yet (first dispatch after spawn
    // race). Window-name renames (e.g. emoji-prefix flips) become
    // no-ops because the cached @N survives the rename.
    const target = await resolveTarget({
      atmuxDir,
      team: team.name,
      sessionName,
      member: memberEntry.name,
      windowName,
      tmux,
    });
    const body = typeof post.body === "string" ? post.body : "";
    const subject = typeof post.subject === "string" ? post.subject : "";
    const ping = buildDispatchPing({ id: parsed.id, subject, body });
    // ADR-138 T3b2: per-TUI verifier dispatch. claude → composerEmpty()
    // confirms the agent accepted the inbox-message ping; non-Claude
    // TUIs (shell/cursor/etc.) skip verify to avoid false-positive
    // escalation entries. Bash passes `0 0` (no-submit=0, verify=0).
    const verifier = verifierForTui(memberEntry.tui);
    const dispatchOpts: SendOpts = { verify: false };
    if (verifier !== null) dispatchOpts.expectVerifier = verifier;
    try {
      await sendToMember(
        tmux,
        atmuxDir,
        { target, member: parsed.member, team: team.name },
        ping,
        dispatchOpts,
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

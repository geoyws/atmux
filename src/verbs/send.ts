// ADR-010: CLI dispatcher — `send` verb (CLI wrapper around core/send).
// ADR-004 amend (2026-05-05): socket-pinned tmux factory.
// Bash spec: lib/send.sh::main @ worktree-frozen.
//
// Behaviour (1:1 parity with bash):
//
//   1. `--broadcast` MUST be the first argument when present (bash
//      lib/send.sh:18 `if [[ "${1:-}" == "--broadcast" ]]`). Any other
//      position is treated as a positional member name (bash falls
//      through the case `*) break`).
//   2. Flag loop: --include-driver / --no-submit / --no-verify / `--`
//      end-of-flags. Unknown `-*` flag → UsageError (bash `atmux::die`).
//   3. Single-member: <member> <msg...> — empty member or empty msg →
//      UsageError. msg is the remaining argv joined with single spaces
//      (bash `msg="$*"` IFS=" ").
//   4. Broadcast: msg is the entire remaining argv joined; iterate
//      `team.members[].name`, skipping the literal `driver` member
//      unless `--include-driver`. Per-member failure WARNS to stderr
//      and continues (bash lib/send.sh:50 `|| atmux::warn …`).
//
// Each delivery routes through `core/send.ts::sendToMember` with the
// CLI-flagged `noSubmit` / `verify` opts. The core lib owns the
// capture-classify-paste-Enter sequence + the verify heuristic + log
// append. The verb owns flag parsing, member iteration, target
// construction (`<sessionName>:<windowName>`), and per-member error
// containment in broadcast mode.
//
// Out of scope here (deferred to ADR-013 Phase 5):
// - sock_publish event-driven supervisor path (lib/send.sh:64-78,
//   `ATMUX_LEGACY_SEND=1` is bash's escape hatch — TS only ports the
//   legacy direct-send leg per Task #7's contract).
// - --to <list> multi-member targeting (not in bash @ worktree-frozen).

import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import type { Team } from "../schema/team.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { sendToMember } from "../core/send.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { defaultSocketPath } from "./start.ts";

/** Parsed `send` CLI args (post-flag-parsing). */
export interface SendArgs {
  /** True when invoked as `atmux send --broadcast <msg…>`. */
  broadcast: boolean;
  /** Single-member target. Mutually exclusive with `broadcast`. */
  member?: string;
  /** Joined message body (bash `msg="$*"` semantics). */
  msg: string;
  /** When set, broadcast does NOT skip the literal `driver` member. */
  includeDriver: boolean;
  /** Flip for `--no-submit` (default false; bash default is to submit). */
  noSubmit: boolean;
  /** Flip for `--no-verify` (default false; bash default verifies). */
  noVerify: boolean;
  /** `--socket <path>` override; otherwise defaultSocketPath(team). */
  socketPath?: string;
  /** `--team-dir <dir>` override; otherwise getAtmuxDir() walks cwd. */
  teamDir?: string;
}

const USAGE_HINT_SINGLE = "atmux send [--no-submit] [--no-verify] <member> <msg...>";
const USAGE_HINT_BROADCAST =
  "atmux send --broadcast [--include-driver] [--no-submit] [--no-verify] <msg...>";

/**
 * Parse the verb's argv (post-`send` slice). Pure — never touches
 * filesystem or env. Throws `UsageError` on bad invocation, matching
 * bash's exit-64 path per ADR-006.
 *
 * Exported so unit tests cover every branch without spinning tmux.
 */
export function parseSendArgs(argv: ReadonlyArray<string>): SendArgs {
  let broadcast = false;
  let i = 0;

  // Bash: `--broadcast` only recognised at position 1. After shift it
  // does not re-appear in the flag-loop's recognised set.
  if (argv[0] === "--broadcast") {
    broadcast = true;
    i = 1;
  }

  let includeDriver = false;
  let noSubmit = false;
  let noVerify = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;

  // Flag loop — mirrors lib/send.sh:24-33 with our two extra flags
  // (--socket / --team-dir) for parity with attach + start.
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--include-driver") {
      includeDriver = true;
      i += 1;
      continue;
    }
    if (a === "--no-submit") {
      noSubmit = true;
      i += 1;
      continue;
    }
    if (a === "--no-verify") {
      noVerify = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "send: --socket requires a path argument",
          hint: broadcast ? USAGE_HINT_BROADCAST : USAGE_HINT_SINGLE,
        });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "send: --team-dir requires a directory argument",
          hint: broadcast ? USAGE_HINT_BROADCAST : USAGE_HINT_SINGLE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a === "--") {
      i += 1;
      break;
    }
    if (a !== undefined && a.startsWith("-")) {
      throw new UsageError({
        what: `send: unknown flag: ${a}`,
        hint: broadcast ? USAGE_HINT_BROADCAST : USAGE_HINT_SINGLE,
      });
    }
    // Non-flag positional → break out, leave i pointing at the first
    // positional. Mirrors bash `*) break ;;`.
    break;
  }

  let member: string | undefined;
  if (!broadcast) {
    member = argv[i];
    if (member === undefined || member.length === 0) {
      throw new UsageError({
        what: "send: <member> argument is required",
        hint: USAGE_HINT_SINGLE,
      });
    }
    i += 1;
  }

  const msg = argv.slice(i).join(" ");
  if (msg.length === 0) {
    throw new UsageError({
      what: "send: empty message",
      hint: broadcast ? USAGE_HINT_BROADCAST : USAGE_HINT_SINGLE,
    });
  }

  const out: SendArgs = {
    broadcast,
    msg,
    includeDriver,
    noSubmit,
    noVerify,
  };
  if (member !== undefined) out.member = member;
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/** Build the single-member target string `<sessionName>:<windowName>`. */
export function buildMemberTarget(
  sessionName: string,
  memberName: string,
  emoji: string | undefined,
): string {
  return `${sessionName}:${buildWindowName(memberName, emoji)}`;
}

/**
 * `atmux send <member> <msg...>` /
 * `atmux send --broadcast <msg...>`.
 *
 * Returns 0 on full success. Returns 1 on broadcast where any member
 * delivery threw (bash also returns 0; we tighten to surface partial
 * failure — operator can opt-out via `2>&1` since warnings are on
 * stderr regardless). Throws `UsageError` / `ConfigError` for the
 * caller to map per ADR-006.
 */
export async function send(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parseSendArgs(argv);

  const dirOpts: ResolveDirOpts = {};
  if (parsed.teamDir !== undefined) dirOpts.teamDir = parsed.teamDir;

  const team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? defaultSocketPath(team.name);
  const tmux = createTmux({ socketPath });

  const sendOpts = {
    verify: !parsed.noVerify,
    noSubmit: parsed.noSubmit,
  };

  if (parsed.broadcast) {
    return await broadcastSend(tmux, team, sessionName, parsed, sendOpts);
  }

  // Single-member path. parseSendArgs guarantees `member` is set when
  // `broadcast === false`.
  const memberName = parsed.member;
  if (memberName === undefined) {
    // Defensive — parseSendArgs should make this unreachable.
    throw new UsageError({ what: "send: <member> argument is required" });
  }
  const memberEntry = team.members.find((m) => m.name === memberName);
  if (memberEntry === undefined) {
    throw new ConfigError({
      what: `send: no such member in team.json: ${memberName}`,
      hint: "run 'atmux status' to list members",
    });
  }
  const target = buildMemberTarget(sessionName, memberEntry.name, memberEntry.emoji);
  const atmuxDir = await getAtmuxDir(dirOpts);
  await sendToMember(
    tmux,
    atmuxDir,
    { target, member: memberEntry.name, team: team.name },
    parsed.msg,
    sendOpts,
  );
  return 0;
}

// ---------- Internals ----------

/**
 * Broadcast leg — iterate members, skip `driver` unless --include-driver,
 * absorb per-member failures with stderr warnings (bash lib/send.sh:50
 * `|| atmux::warn "send to $m failed"`). Returns 0 if every send
 * succeeded; 1 if any member's send threw.
 */
async function broadcastSend(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  parsed: SendArgs,
  sendOpts: { verify: boolean; noSubmit: boolean },
): Promise<number> {
  const dirOpts: ResolveDirOpts = {};
  if (parsed.teamDir !== undefined) dirOpts.teamDir = parsed.teamDir;
  const atmuxDir = await getAtmuxDir(dirOpts);
  let anyFailed = false;
  for (const m of team.members) {
    if (!parsed.includeDriver && m.name === "driver") continue;
    const target = buildMemberTarget(sessionName, m.name, m.emoji);
    try {
      await sendToMember(
        tmux,
        atmuxDir,
        { target, member: m.name, team: team.name },
        parsed.msg,
        sendOpts,
      );
    } catch (e) {
      anyFailed = true;
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(`atmux: warn: send to ${m.name} failed: ${reason}\n`);
    }
  }
  return anyFailed ? 1 : 0;
}

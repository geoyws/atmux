// ADR-062 §Decision (2): `atmux pane-state --member <m> [--json]`.
//
// Read-only diagnostic verb. Captures the named member's pane via the
// team-tmux abstraction (same mechanism whip uses for per-member health
// probes — `src/verbs/whip.ts::checkMember`), runs `classifyText` from
// `src/core/pane-state.ts`, and prints the discrete PaneState. Intended
// for the T3 orchestrator + driver-side observability — no state
// mutation, no `tmux send-keys`.
//
// Refusal cases:
//   - Missing --member         → UsageError ("usage: atmux …").
//   - Member not in team.json  → ConfigError listing valid member names.
//   - Session down / window absent / capture failure → falls through to
//     the classifier with empty text, which yields UNKNOWN. This matches
//     whip's posture: a missing pane is just an UNKNOWN observation, not
//     a verb-level failure. The caller sees the state and decides.
//
// Output shape:
//   - Default: `<STATE>\n` (one of READY|TYPING|MODAL|RATE-LIMIT|
//     COMPACTING|SHELL|UNKNOWN).
//   - `--json`: `{state, evidence, capturedAt}` — the existing
//     `PaneClassification` shape from src/core/pane-state.ts.

import { now as nowMs } from "../abstractions/time.ts";
import { createTmux, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  resolveTeamSocket,
  getSessionName,
  type ResolveDirOpts,
  requireTeam,
} from "../core/common.ts";
import { readLeadWindowName, type SkillsTeamPathsOpts } from "../core/lead-marker.ts";
import { classifyText, type PaneClassification } from "../core/pane-state.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { Team, TeamMember } from "../schema/team.ts";

const USAGE = "atmux pane-state --member <name> [--json]";

/** Parsed `pane-state` argv. */
export interface PaneStateArgs {
  member: string;
  json: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parsePaneStateArgs(argv: ReadonlyArray<string>): PaneStateArgs {
  let member = "";
  let json = false;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--member") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "pane-state: --member requires a value", hint: USAGE });
      }
      member = v;
      i += 2;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "pane-state: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "pane-state: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `pane-state: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  if (member.length === 0) {
    throw new UsageError({ what: "pane-state: --member is required", hint: USAGE });
  }
  const out: PaneStateArgs = { member, json };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Resolve a member's tmux window target the same way whip's
 * `checkMember` does — the lead role consults the I-2 marker first, with
 * the ADR-017 `<emoji><name>` form as fallback; regular members go
 * straight to that form.
 *
 * Exported so tests can drive the resolver directly without spinning a
 * real tmux server.
 */
export async function resolveMemberWindowTarget(
  team: Team,
  sessionName: string,
  member: TeamMember,
  homeOpts: SkillsTeamPathsOpts = {},
): Promise<string> {
  const role = (member.role ?? "member").toString();
  const memberWindowName = buildWindowName(member.name, member.emoji);
  let windowName: string;
  if (role === "team-lead") {
    const opts: SkillsTeamPathsOpts & { fallback?: string } = { fallback: memberWindowName };
    if (homeOpts.home !== undefined) opts.home = homeOpts.home;
    windowName = await readLeadWindowName(team.name, opts);
  } else {
    windowName = memberWindowName;
  }
  return `${sessionName}:${windowName}`;
}

/**
 * Inner driver — captures the pane + classifies. Exposed so unit tests
 * can stub the `TmuxNamespace` and assert each PaneState round-trip
 * without spinning a real tmux server.
 *
 * Window-existence + capture failures degrade to empty text → UNKNOWN
 * (whip's posture). The caller sees the state and decides.
 */
export async function paneStateWithTmux(
  tmux: TmuxNamespace,
  team: Team,
  sessionName: string,
  member: TeamMember,
  homeOpts: SkillsTeamPathsOpts = {},
  nowFn: () => number = nowMs,
): Promise<PaneClassification> {
  const target = await resolveMemberWindowTarget(team, sessionName, member, homeOpts);
  let text = "";
  try {
    text = await tmux.pane.capturePane({ target, start: -30 });
  } catch {
    // Transient tmux failure (server reload, pane resizing, missing
    // window) → empty text classifies as UNKNOWN. Matches whip's
    // checkMember posture (src/verbs/whip.ts:1281).
    text = "";
  }
  return classifyText(text, nowFn);
}

/**
 * `atmux pane-state --member <m> [--json]`.
 *
 * Returns 0 on a successful classification (any state, including
 * UNKNOWN — UNKNOWN is a valid observation, not an error).
 * Throws `UsageError` / `ConfigError` for the dispatcher to map per
 * ADR-006.
 */
export async function paneState(argv: ReadonlyArray<string>): Promise<number> {
  const parsed = parsePaneStateArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const memberEntry = team.members.find((m) => m.name === parsed.member);
  if (memberEntry === undefined) {
    const valid = team.members.map((m) => m.name).join(", ");
    throw new ConfigError({
      what: `pane-state: no such member in team.json: ${parsed.member}`,
      hint: `valid members: ${valid}`,
    });
  }
  const sessionName = await getSessionName({ ...dirOpts, team });
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = createTmux({ socketPath });
  const cls = await paneStateWithTmux(tmux, team, sessionName, memberEntry);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(cls)}\n`);
  } else {
    process.stdout.write(`${cls.state}\n`);
  }
  return 0;
}

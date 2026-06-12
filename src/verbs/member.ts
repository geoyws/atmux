// ADR-136 TR3: `atmux member rename <id> --label <new>` verb.
//
// Hot-renames a member's display `label` (mutable) without disturbing
// the immutable ASCII `name` (per ADR-136 — `name` keys worktrees,
// branches, inboxes, kanban owner, etc.; `label` is display-only and
// falls back to `name` when unset). This verb is the only mutation
// path for `members[].label`.
//
// Side effects (in order), per ADR-136 §"New verb":
//   1. Validate `<member-id>` exists in team.json.
//   2. Validate `<new-label>` via the same Zod refine TR2 (`t-69e8b05a`)
//      added to `TeamMember.label` — no `:` and no `.` (tmux window-name
//      separators). Schema parse on the team.json write would surface
//      this anyway, but pre-validation gives a cleaner error message
//      and lets the idempotent-no-op path short-circuit before the lock.
//   3. Atomic JSON rewrite of team.json under flock (via `updateJson`,
//      ADR-005 §"single writer per file" — `<path>.lock` sidecar; both
//      bash + bun-port writers serialize correctly).
//   4. When the team session is live: `tmux rename-window` on the
//      window matching the OLD display name. Skipped (with notice) when
//      no live session is found — the rename takes effect on next
//      `atmux start` via `buildWindowName(name, emoji)` (post-TR4 will
//      read `label ?? name`; pre-TR4 reads `name` unchanged).
//   5. When the renamed member is the current lead: rewrite
//      `~/.claude/teams/<team>/lead-window-name.txt` (per `core/lead-
//      marker.ts`'s leadWindowNamePath) atomically too. Detection is
//      content-based: if the existing marker file's content matches the
//      OLD display name we just rewrote, we patch it. Avoids needing a
//      separate "is this member the lead?" probe.
//
// Idempotent: when `members[id].label === new-label` already, the verb
// returns success no-op without touching disk. This guards both the
// re-run-on-error case AND the lane-tick injection's "same display
// name, just refreshed" race window (ADR-136 §"Hot-rename concurrency
// safety" — single-tick stale-target window is acceptable).
//
// Concurrency: team.json mutation is wrapped in `updateJson`'s default
// flock (5s budget, retries every 50ms). Two parallel `atmux member
// rename` calls on the SAME team.json serialize via the kernel-level
// flock — the second-arriver sees the post-write state and may short-
// circuit through the idempotent-no-op path. This matches the
// ADR-091 "BEGIN IMMEDIATE" pattern in spirit; JSON-flock substitutes
// for the SQLite single-writer semantics since team.json is JSON.
//
// Branch-name immutability note (OQ-3): the verb prints a one-liner
// surfacing the invariant — `geoyws-<sanitize(name)>` is permanently
// keyed to the immutable member ID, and the label rename is display-
// only. Per ADR-084 + ADR-082, branches NEVER mutate on a label change.
// Operators who reach for this verb often assume "rename" implies the
// branch + worktree rename too; the note pre-empts the misconception.

import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";
import { updateJson } from "../abstractions/json.ts";
import { DEFAULT_MEMBER_ROLES } from "../abstractions/member-roles.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  MemberWindowResolveError,
  type MemberShape,
  type MemberWindow,
  moveMemberWindow,
  resolveMemberToWindowIdx,
  sortMembersDefaultsFirst,
  swapMemberWindows,
} from "../abstractions/tmux-window-orchestrator.ts";
import {
  buildWindowName,
  buildWindowNameLegacy,
  getAtmuxDir,
  getSessionName,
  loadTeam,
  type ResolveDirOpts,
  requireTeam,
  resolveCallerScope,
  resolveTeamSocket,
  teamJsonPath,
} from "../core/common.ts";
import { writeHeartbeat } from "../core/heartbeat.ts";
import { loadInbox, movePendingToInProgress } from "../core/inbox.ts";
import {
  claimTaskForMember,
  markTaskBlockedWithNote,
  nowEpoch,
  showTask,
} from "../core/kanban.ts";
import {
  isMemberSelfStatus,
  MEMBER_SELF_STATUS_VALUES,
  writeMemberStatus,
} from "../core/member-status.ts";
import { pickMemberName } from "./claim.ts";
import type { Team as TeamShape } from "../schema/team.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { leadWindowNamePath } from "../core/lead-marker.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team, type TeamMember } from "../schema/team.ts";

const USAGE = "atmux member rename <member-id> --label <new-label>";
const MOVE_USAGE = "atmux member move <member-id> --to <position>";
const SWAP_USAGE = "atmux member swap <member-id-a> <member-id-b>";
const SORT_USAGE = "atmux member sort [--defaults-first]";

/** Cockpit session-name reserved literal (per ADR-135 D1 + cockpit.ts
 *  migration shim). ADR-161 Part C §item 5: `atmux member` operates at
 *  the team layer; refuse in cockpit context. */
const COCKPIT_RESERVED_NAMES: ReadonlyArray<string> = ["atmux_cockpit", "atmux_teams"];

function isCockpitContext(teamName: string): boolean {
  return COCKPIT_RESERVED_NAMES.includes(teamName);
}

// ---------- Args ----------

export interface MemberRenameArgs {
  memberId: string;
  label: string;
  /** Optional `--socket-path <abs>` for test injection. */
  socketPath?: string;
  /** Optional `--team-dir <path>` for test isolation. */
  teamDir?: string;
}

export function parseMemberRenameArgs(argv: ReadonlyArray<string>): MemberRenameArgs {
  let memberId = "";
  let label: string | null = null;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--label") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "member rename: --label requires a value", hint: USAGE });
      }
      label = v;
      i += 2;
      continue;
    }
    if (a === "--socket-path") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member rename: --socket-path requires a path",
          hint: USAGE,
        });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member rename: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `member rename: unknown flag: ${a}`, hint: USAGE });
    }
    if (memberId.length === 0) {
      memberId = a ?? "";
    } else {
      throw new UsageError({
        what: "member rename: too many positional args (expected one <member-id>)",
        hint: USAGE,
      });
    }
    i += 1;
  }
  if (memberId.length === 0) throw new UsageError({ what: USAGE });
  if (label === null) {
    throw new UsageError({ what: "member rename: --label is required", hint: USAGE });
  }
  const out: MemberRenameArgs = { memberId, label };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Pure helpers ----------

/** Label refine — mirrors `TeamMember.label`'s Zod refine in
 *  `src/schema/team.ts`. Pre-validated here so the verb can throw a
 *  UsageError (exit 64) with a stable message rather than a ZodError
 *  wrapped as SchemaError (exit 65) from the updateJson re-validate. */
export function isValidLabel(label: string): boolean {
  return !label.includes(":") && !label.includes(".");
}

/** Compute the tmux window name from a member's current display state.
 *  Post-TR4: `buildWindowName` handles the label-fallback natively, so
 *  this is now a thin pass-through that the verb keeps for callsite
 *  readability + same-commit test stability. */
export function memberDisplayWindowName(m: TeamMember): string {
  return buildWindowName(m.name, m.emoji, m.label, m.role);
}

// ---------- Verb entry ----------

export interface MemberRenameOpts {
  /** Injected tmux factory (test seam). Production defaults to
   *  `createTmux(cfg)`. */
  buildTmux?: (cfg: TmuxConfig) => TmuxNamespace;
  /** Override `process.env` (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Override cwd (test seam). */
  cwd?: string;
  /** Override `~` for the lead-window-name.txt path (test seam). */
  home?: string;
  stdout?: Writer;
  stderr?: Writer;
}

export interface MemberRenameResult {
  /** Exit code (0 on success). */
  exitCode: number;
  /** True when the verb wrote team.json. False on idempotent no-op. */
  wrote: boolean;
  /** True when tmux rename-window was invoked. False when team is
   *  stopped OR the live window couldn't be found. */
  renamedWindow: boolean;
  /** True when lead-window-name.txt was patched. */
  patchedLeadMarker: boolean;
}

export async function memberRename(
  argv: ReadonlyArray<string>,
  opts: MemberRenameOpts = {},
): Promise<number> {
  const result = await memberRenameInternal(argv, opts);
  return result.exitCode;
}

/** Internal entry returning the full {@link MemberRenameResult}. Tests
 *  use this to assert side-effect flags without re-grepping stdout. */
export async function memberRenameInternal(
  argv: ReadonlyArray<string>,
  opts: MemberRenameOpts = {},
): Promise<MemberRenameResult> {
  const parsed = parseMemberRenameArgs(argv);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  // Pre-validate label here so the user-facing error is a UsageError
  // ("invalid label: …") rather than a SchemaError from the updateJson
  // re-validate. Also lets the idempotent-no-op check below run before
  // we acquire the flock — quicker happy-path on a same-label re-run.
  if (!isValidLabel(parsed.label)) {
    throw new UsageError({
      what: `member rename: label '${parsed.label}' cannot contain ':' or '.' (tmux separator chars)`,
      hint: USAGE,
    });
  }

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  if (opts.env !== undefined) dirOpts.env = opts.env;
  if (opts.cwd !== undefined) dirOpts.cwd = opts.cwd;
  const atmuxDir = await getAtmuxDir(dirOpts);
  const tjPath = teamJsonPath(atmuxDir);

  // 1. Existence + idempotent-no-op probe BEFORE the flock — cheap read
  //    that short-circuits the same-label re-run.
  const teamPre = await loadTeam(dirOpts);
  const memberPre = teamPre.members.find((m) => m.name === parsed.memberId);
  if (memberPre === undefined) {
    throw new ConfigError({
      what: `member rename: member '${parsed.memberId}' not found in team.json`,
    });
  }
  const currentLabel = memberPre.label;
  if (currentLabel === parsed.label) {
    stdout(`member rename: '${parsed.memberId}' label already matches '${parsed.label}' — no-op\n`);
    return { exitCode: 0, wrote: false, renamedWindow: false, patchedLeadMarker: false };
  }

  // Capture the OLD display name BEFORE the JSON write so we can target
  // the correct tmux window AFTER. `memberDisplayWindowName` is pure on
  // a single TeamMember snapshot — safe to call pre-mutation.
  const oldWindow = memberDisplayWindowName(memberPre);
  // The new window name reflects the post-rename display state:
  // `<emoji><parsed.label>` (label-fallback handled by buildWindowName's
  // 3rd arg when set + non-empty).
  const newWindow = buildWindowName(memberPre.name, memberPre.emoji, parsed.label, memberPre.role);

  // 2. Atomic JSON rewrite under flock. `updateJson` re-validates via
  //    the Zod schema on output — a malformed mutation throws
  //    SchemaError (exit 65) and the disk file stays at the previous
  //    valid state (atomicWrite renames a tmp file, never partially-
  //    written).
  await updateJson(tjPath, Team, (current) => {
    const next = current.members.map((m) =>
      m.name === parsed.memberId ? { ...m, label: parsed.label } : m,
    );
    return { ...current, members: next };
  });

  let renamedWindow = false;
  let patchedLeadMarker = false;

  // 3. Live tmux rename-window. ConfigError from `getSessionName` (when
  //    single-session is set without an anchor) → treat as "team not
  //    started" and skip; matches add-member's posture.
  const buildTmux = opts.buildTmux ?? createTmux;
  const tmuxCfg: TmuxConfig =
    parsed.socketPath !== undefined
      ? { socketPath: parsed.socketPath }
      : { socketPath: resolveTeamSocket(teamPre) };
  const tmux = buildTmux(tmuxCfg);

  let sessionName: string | null = null;
  try {
    sessionName = await getSessionName({
      ...dirOpts,
      team: teamPre,
    });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    sessionName = null;
  }

  if (sessionName !== null) {
    const alive = await tmux.session.hasSession(sessionName).catch(() => false);
    if (alive) {
      try {
        await tmux.window.renameWindow(`${sessionName}:${oldWindow}`, newWindow);
        renamedWindow = true;
      } catch (e) {
        // Best-effort: stale window target (lane-tick race, manual kill,
        // etc.) is non-fatal — the team.json mutation already succeeded
        // and the rename takes effect on next `atmux start`.
        stderr(
          `member rename: tmux rename-window failed (window '${oldWindow}' may already be gone): ${errMsg(e)}\n`,
        );
      }
    } else {
      stderr(
        `member rename: team session '${sessionName}' not running — window rename applies on next 'atmux start'\n`,
      );
    }
  } else {
    stderr("member rename: no live team session — window rename applies on next 'atmux start'\n");
  }

  // 4. Lead-window-name.txt patch — content-based detection. The marker
  //    file (when present) carries the authoritative current lead-window
  //    name (per `core/lead-marker.ts`). If its content matches the OLD
  //    display name we just rewrote, the renamed member IS the current
  //    lead — patch the marker atomically. Avoids a second "is lead?"
  //    probe (whip-side rotation marker + status output) that would
  //    couple this verb to the rotation invariants.
  const markerPath = leadWindowNamePath(
    teamPre.name,
    opts.home !== undefined ? { home: opts.home } : {},
  );
  const existing = (await readTextOrNull(markerPath))?.trim() ?? null;
  if (existing !== null && existing === oldWindow) {
    // Same atomic-write convention as `writeLeadSessionStart` — `${name}\n`
    // trailing newline so existing readers (`readLeadWindowName` does
    // `.trim()`) stay round-trip-stable.
    await atomicWrite(markerPath, `${newWindow}\n`);
    patchedLeadMarker = true;
  }

  // 5. Confirmation + branch-name immutability note (OQ-3).
  const display = parsed.label;
  stdout(`✅ member rename: '${parsed.memberId}'.label = '${display}'\n`);
  if (renamedWindow) {
    stdout(`   tmux window: ${oldWindow} → ${newWindow}\n`);
  }
  if (patchedLeadMarker) {
    stdout(`   lead-window-name.txt updated → ${newWindow}\n`);
  }
  stdout(
    `   note: branch name \`geoyws-<sanitize(${parsed.memberId})>\` is permanently keyed to the immutable member ID; the label rename is display-only.\n`,
  );
  return { exitCode: 0, wrote: true, renamedWindow, patchedLeadMarker };
}

// ============================================================
// ADR-161 TR3: atmux member move | swap | sort
// ============================================================
//
// Three topographic-normalization verbs sharing the
// `tmux-window-orchestrator` primitives. Each preserves PIDs +
// attached clients + claude-process state (the primitives operate
// on tmux window-index, not pane content — same mechanism as
// ADR-135 D4 in-place rename + `atmux rotate-lead`).
//
// Persistence: every successful run rewrites `team.json::members[]`
// in the new ordering via `updateJson` under flock (mirrors the
// rename verb's concurrency posture). On a no-op (target equals
// current position / already sorted / a=b swap) we skip both the
// tmux call AND the JSON rewrite.
//
// Cockpit refusal (§Part C item 5): if the resolved team-name
// matches the cockpit reserved literals (`atmux_cockpit` /
// legacy `atmux_teams`), all three verbs refuse with a hint.
// In practice the cockpit lives on its own socket and has no
// team.json, so this is defense-in-depth.

// ---------- Args: move ----------

export interface MemberMoveArgs {
  memberId: string;
  /** 1-indexed tmux window position per ADR-162 base-index +
   *  ADR-161 §Open question #3. */
  position: number;
  socketPath?: string;
  teamDir?: string;
}

export function parseMemberMoveArgs(argv: ReadonlyArray<string>): MemberMoveArgs {
  let memberId = "";
  let position: number | null = null;
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--to") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: "member move: --to requires a value", hint: MOVE_USAGE });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || String(n) !== v) {
        throw new UsageError({
          what: `member move: --to '${v}' must be a positive integer (1-indexed)`,
          hint: MOVE_USAGE,
        });
      }
      position = n;
      i += 2;
      continue;
    }
    if (a === "--socket-path") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member move: --socket-path requires a path",
          hint: MOVE_USAGE,
        });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member move: --team-dir requires a value",
          hint: MOVE_USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `member move: unknown flag: ${a}`, hint: MOVE_USAGE });
    }
    if (memberId.length === 0) {
      memberId = a ?? "";
    } else {
      throw new UsageError({
        what: "member move: too many positional args (expected one <member-id>)",
        hint: MOVE_USAGE,
      });
    }
    i += 1;
  }
  if (memberId.length === 0) throw new UsageError({ what: MOVE_USAGE });
  if (position === null) {
    throw new UsageError({ what: "member move: --to is required", hint: MOVE_USAGE });
  }
  const out: MemberMoveArgs = { memberId, position };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Args: swap ----------

export interface MemberSwapArgs {
  idA: string;
  idB: string;
  socketPath?: string;
  teamDir?: string;
}

export function parseMemberSwapArgs(argv: ReadonlyArray<string>): MemberSwapArgs {
  const positionals: string[] = [];
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--socket-path") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member swap: --socket-path requires a path",
          hint: SWAP_USAGE,
        });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member swap: --team-dir requires a value",
          hint: SWAP_USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `member swap: unknown flag: ${a}`, hint: SWAP_USAGE });
    }
    positionals.push(a ?? "");
    i += 1;
  }
  if (positionals.length !== 2) {
    throw new UsageError({
      what: `member swap: expected exactly two <member-id> positional args, got ${positionals.length}`,
      hint: SWAP_USAGE,
    });
  }
  const [idA, idB] = positionals as [string, string];
  if (idA === idB) {
    throw new UsageError({
      what: `member swap: '${idA}' === '${idB}' — cannot swap a member with itself`,
      hint: SWAP_USAGE,
    });
  }
  const out: MemberSwapArgs = { idA, idB };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Args: sort ----------

export interface MemberSortArgs {
  /** v1 ships `--defaults-first` only. Flag is recorded for forward-
   *  compat with future sort modes (alphabetical, lane-grouped — see
   *  ADR-161 §"Out of scope"). */
  defaultsFirst: boolean;
  socketPath?: string;
  teamDir?: string;
}

export function parseMemberSortArgs(argv: ReadonlyArray<string>): MemberSortArgs {
  let defaultsFirst = true; // ADR-161 §Open question #2: default to true (recommended)
  let socketPath: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--defaults-first") {
      defaultsFirst = true;
      i += 1;
      continue;
    }
    if (a === "--socket-path") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member sort: --socket-path requires a path",
          hint: SORT_USAGE,
        });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({
          what: "member sort: --team-dir requires a value",
          hint: SORT_USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-")) {
      throw new UsageError({ what: `member sort: unknown flag: ${a}`, hint: SORT_USAGE });
    }
    throw new UsageError({
      what: `member sort: unexpected positional '${a}' (sort takes no positional args)`,
      hint: SORT_USAGE,
    });
  }
  const out: MemberSortArgs = { defaultsFirst };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Shared verb plumbing ----------

export interface MemberOrchestrationOpts extends MemberRenameOpts {}

export interface MemberMoveResult {
  exitCode: number;
  /** True when team.json was rewritten. False on idempotent no-op. */
  wrote: boolean;
  /** True when `tmux move-window` was invoked. False on no-op OR when
   *  the team session is not live (writes-only mode). */
  moved: boolean;
}

export interface MemberSwapResult {
  exitCode: number;
  wrote: boolean;
  swapped: boolean;
}

export interface MemberSortResult {
  exitCode: number;
  wrote: boolean;
  /** Number of `tmux move-window` calls issued (0 on already-sorted). */
  moveCount: number;
}

/** Persist a reordered `members[]` array to team.json under flock. Pure
 *  reorder — the input array carries the desired final order; we map it
 *  onto the existing schema-validated entries by name. */
async function persistMemberOrder(
  tjPath: string,
  orderedIds: ReadonlyArray<string>,
): Promise<void> {
  await updateJson(tjPath, Team, (current) => {
    const byName = new Map(current.members.map((m) => [m.name, m] as const));
    const next: TeamMember[] = [];
    for (const id of orderedIds) {
      const m = byName.get(id);
      if (m === undefined) {
        // Should never happen — the verbs resolve ids against the same
        // team.json snapshot they pass here. Defensive: skip rather than
        // corrupt the file (the updateJson re-validate would throw on a
        // missing required field anyway).
        continue;
      }
      next.push(m);
    }
    // Append any members not named in `orderedIds` at the end — defensive
    // against the sort verb's caller forgetting to include user-added
    // members. In practice the sort callsite always passes the FULL
    // roster; this branch guards stray reorders.
    for (const m of current.members) {
      if (!orderedIds.includes(m.name)) next.push(m);
    }
    return { ...current, members: next };
  });
}

/** Probe live tmux session — returns the session-name + a populated tmux
 *  namespace, OR `null` when the team is stopped. Mirrors the rename
 *  verb's posture: a stopped team is non-fatal; the tmux operation is
 *  skipped + a stderr notice printed. */
async function probeLiveSession(opts: {
  team: TeamShape;
  socketPath: string | undefined;
  dirOpts: ResolveDirOpts;
  buildTmux: (cfg: TmuxConfig) => TmuxNamespace;
}): Promise<{ tmux: TmuxNamespace; sessionName: string } | null> {
  const tmuxCfg: TmuxConfig =
    opts.socketPath !== undefined
      ? { socketPath: opts.socketPath }
      : { socketPath: resolveTeamSocket(opts.team) };
  const tmux = opts.buildTmux(tmuxCfg);
  let sessionName: string | null = null;
  try {
    sessionName = await getSessionName({
      ...opts.dirOpts,
      team: opts.team,
    });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return null;
  }
  if (sessionName === null) return null;
  const alive = await tmux.session.hasSession(sessionName).catch(() => false);
  if (!alive) return null;
  return { tmux, sessionName };
}

// ---------- Verb: move ----------

export async function memberMove(
  argv: ReadonlyArray<string>,
  opts: MemberOrchestrationOpts = {},
): Promise<number> {
  const r = await memberMoveInternal(argv, opts);
  return r.exitCode;
}

export async function memberMoveInternal(
  argv: ReadonlyArray<string>,
  opts: MemberOrchestrationOpts = {},
): Promise<MemberMoveResult> {
  const parsed = parseMemberMoveArgs(argv);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  if (opts.env !== undefined) dirOpts.env = opts.env;
  if (opts.cwd !== undefined) dirOpts.cwd = opts.cwd;
  const atmuxDir = await getAtmuxDir(dirOpts);
  const tjPath = teamJsonPath(atmuxDir);
  const team = await loadTeam(dirOpts);

  if (isCockpitContext(team.name)) {
    throw new UsageError({
      what: `member move: refused — team '${team.name}' is a cockpit context; 'atmux member' verbs operate at the team layer, not cockpit`,
      hint: "cockpit window ordering is managed by 'atmux cockpit' verbs (per ADR-135 D2)",
    });
  }

  const buildTmux = opts.buildTmux ?? createTmux;
  const probe = await probeLiveSession({
    team,
    socketPath: parsed.socketPath,
    dirOpts,
    buildTmux,
  });

  if (probe === null) {
    stderr(
      `member move: team session not running — start the team to relocate windows. team.json members[] order unchanged.\n`,
    );
    return { exitCode: 0, wrote: false, moved: false };
  }

  let source: MemberWindow;
  try {
    source = await resolveMemberToWindowIdx({
      sessionName: probe.sessionName,
      memberId: parsed.memberId,
      members: team.members as ReadonlyArray<MemberShape>,
      tmux: probe.tmux,
      buildWindowName,
      buildWindowNameLegacy,
    });
  } catch (e) {
    if (e instanceof MemberWindowResolveError) {
      throw new ConfigError({ what: `member move: ${e.message}` });
    }
    throw e;
  }

  const liveBeforeMove = await probe.tmux.window.listWindows(probe.sessionName);
  const occupiedIndices = new Set(liveBeforeMove.map((w) => w.index));
  let moved: boolean;
  try {
    moved = await moveMemberWindow({
      sessionName: probe.sessionName,
      source,
      target: parsed.position,
      tmux: probe.tmux,
      occupiedIndices,
    });
  } catch (e) {
    if (e instanceof MemberWindowResolveError) {
      throw new UsageError({ what: `member move: ${e.message}` });
    }
    throw e;
  }

  if (!moved) {
    stdout(
      `member move: '${parsed.memberId}' already at W${parsed.position} — no-op\n`,
    );
    return { exitCode: 0, wrote: false, moved: false };
  }

  // Persist new ordering by re-reading live tmux state. Each move-window
  // shifts the surrounding windows; the authoritative new order is what
  // tmux reports, not a hand-computed shuffle.
  const liveAfter = await probe.tmux.window.listWindows(probe.sessionName);
  const orderedIds = mapWindowsToMemberIds(liveAfter, team.members as ReadonlyArray<MemberShape>);
  await persistMemberOrder(tjPath, orderedIds);

  stdout(`✅ member move: '${parsed.memberId}' W${source.index} → W${parsed.position}\n`);
  return { exitCode: 0, wrote: true, moved: true };
}

// ---------- Verb: swap ----------

export async function memberSwap(
  argv: ReadonlyArray<string>,
  opts: MemberOrchestrationOpts = {},
): Promise<number> {
  const r = await memberSwapInternal(argv, opts);
  return r.exitCode;
}

export async function memberSwapInternal(
  argv: ReadonlyArray<string>,
  opts: MemberOrchestrationOpts = {},
): Promise<MemberSwapResult> {
  const parsed = parseMemberSwapArgs(argv);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  if (opts.env !== undefined) dirOpts.env = opts.env;
  if (opts.cwd !== undefined) dirOpts.cwd = opts.cwd;
  const atmuxDir = await getAtmuxDir(dirOpts);
  const tjPath = teamJsonPath(atmuxDir);
  const team = await loadTeam(dirOpts);

  if (isCockpitContext(team.name)) {
    throw new UsageError({
      what: `member swap: refused — team '${team.name}' is a cockpit context`,
      hint: "cockpit window ordering is managed by 'atmux cockpit' verbs (per ADR-135 D2)",
    });
  }

  const buildTmux = opts.buildTmux ?? createTmux;
  const probe = await probeLiveSession({
    team,
    socketPath: parsed.socketPath,
    dirOpts,
    buildTmux,
  });
  if (probe === null) {
    stderr(
      `member swap: team session not running — start the team to swap windows. team.json members[] order unchanged.\n`,
    );
    return { exitCode: 0, wrote: false, swapped: false };
  }

  let a: MemberWindow;
  let b: MemberWindow;
  try {
    a = await resolveMemberToWindowIdx({
      sessionName: probe.sessionName,
      memberId: parsed.idA,
      members: team.members as ReadonlyArray<MemberShape>,
      tmux: probe.tmux,
      buildWindowName,
      buildWindowNameLegacy,
    });
    b = await resolveMemberToWindowIdx({
      sessionName: probe.sessionName,
      memberId: parsed.idB,
      members: team.members as ReadonlyArray<MemberShape>,
      tmux: probe.tmux,
      buildWindowName,
      buildWindowNameLegacy,
    });
  } catch (e) {
    if (e instanceof MemberWindowResolveError) {
      throw new ConfigError({ what: `member swap: ${e.message}` });
    }
    throw e;
  }

  const liveBefore = await probe.tmux.window.listWindows(probe.sessionName);
  const highestIndex = liveBefore.reduce((max, w) => (w.index > max ? w.index : max), 0);

  const swapped = await swapMemberWindows({
    sessionName: probe.sessionName,
    a,
    b,
    tmux: probe.tmux,
    highestIndex,
  });

  if (!swapped) {
    stdout(`member swap: '${parsed.idA}' and '${parsed.idB}' share W${a.index} — no-op\n`);
    return { exitCode: 0, wrote: false, swapped: false };
  }

  const liveAfter = await probe.tmux.window.listWindows(probe.sessionName);
  const orderedIds = mapWindowsToMemberIds(liveAfter, team.members as ReadonlyArray<MemberShape>);
  await persistMemberOrder(tjPath, orderedIds);

  stdout(
    `✅ member swap: '${parsed.idA}' W${a.index} ↔ '${parsed.idB}' W${b.index}\n`,
  );
  return { exitCode: 0, wrote: true, swapped: true };
}

// ---------- Verb: sort ----------

export async function memberSort(
  argv: ReadonlyArray<string>,
  opts: MemberOrchestrationOpts = {},
): Promise<number> {
  const r = await memberSortInternal(argv, opts);
  return r.exitCode;
}

export async function memberSortInternal(
  argv: ReadonlyArray<string>,
  opts: MemberOrchestrationOpts = {},
): Promise<MemberSortResult> {
  const parsed = parseMemberSortArgs(argv);
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  if (opts.env !== undefined) dirOpts.env = opts.env;
  if (opts.cwd !== undefined) dirOpts.cwd = opts.cwd;
  const atmuxDir = await getAtmuxDir(dirOpts);
  const tjPath = teamJsonPath(atmuxDir);
  const team = await loadTeam(dirOpts);

  if (isCockpitContext(team.name)) {
    throw new UsageError({
      what: `member sort: refused — team '${team.name}' is a cockpit context`,
      hint: "cockpit window ordering is managed by 'atmux cockpit' verbs (per ADR-135 D2)",
    });
  }

  // §Decision-anchor #4 canonical order — keyed off the shared
  // `DEFAULT_MEMBER_ROLES` constant (extends naturally when ADR-159's
  // committer rename lands without a sort-side edit).
  const canonicalOrder = DEFAULT_MEMBER_ROLES;
  const sorted = sortMembersDefaultsFirst(
    team.members as ReadonlyArray<MemberShape>,
    canonicalOrder,
  );
  const targetOrder = sorted.map((m) => m.name);
  const currentOrder = (team.members as ReadonlyArray<MemberShape>).map((m) => m.name);
  const alreadySorted = currentOrder.every((id, i) => id === targetOrder[i]);

  if (alreadySorted) {
    stdout("member sort: team.json already in canonical order — no-op\n");
    return { exitCode: 0, wrote: false, moveCount: 0 };
  }

  const buildTmux = opts.buildTmux ?? createTmux;
  const probe = await probeLiveSession({
    team,
    socketPath: parsed.socketPath,
    dirOpts,
    buildTmux,
  });

  let moveCount = 0;
  if (probe === null) {
    stderr(
      `member sort: team session not running — persisting members[] order in team.json only; tmux windows will spawn in the new order on next 'atmux start'.\n`,
    );
  } else {
    // Iterate target order left-to-right. At each slot i (targetIdx =
    // baseIdx + i), find the member that *should* be there + the member
    // currently sitting there; if they differ, issue a primitive that
    // exchanges them. moveMemberWindow auto-picks `swap-window` (when
    // the slot is occupied) or `move-window` (when empty) — both
    // preserve PIDs + attached clients + claude-process state.
    //
    // Driver slot derivation: lowest live window index (tmux base-index
    // is 1 in production per ADR-162, but tests/legacy configs may use
    // 0; deriving from the live list keeps the verb robust either way).
    const liveInit = await probe.tmux.window.listWindows(probe.sessionName);
    const driverIdx = liveInit.reduce(
      (min, w) => (w.index < min ? w.index : min),
      Number.POSITIVE_INFINITY,
    );
    const baseIdx = Number.isFinite(driverIdx) ? driverIdx + 1 : 2;

    for (let i = 0; i < targetOrder.length; i++) {
      const memberId = targetOrder[i]!;
      const targetIdx = baseIdx + i;
      // Re-fetch live windows every iteration — swap-window shuffles
      // sibling indices, so a stale snapshot would mis-resolve sources.
      const liveNow = await probe.tmux.window.listWindows(probe.sessionName);
      const occupiedIndices = new Set(liveNow.map((w) => w.index));
      let source: MemberWindow;
      try {
        source = await resolveMemberToWindowIdx({
          sessionName: probe.sessionName,
          memberId,
          members: team.members as ReadonlyArray<MemberShape>,
          tmux: probe.tmux,
          buildWindowName,
          buildWindowNameLegacy,
          driverIndex: Number.isFinite(driverIdx) ? driverIdx : 1,
        });
      } catch (e) {
        if (e instanceof MemberWindowResolveError && e.kind === "unknown-id") {
          // Member rostered in team.json but has no live window —
          // expected for paused members or pre-spawn slots. Skip; the
          // persisted JSON still records the canonical order so the
          // next `atmux start` materializes them in place.
          continue;
        }
        throw e;
      }
      if (source.index === targetIdx) continue;
      await moveMemberWindow({
        sessionName: probe.sessionName,
        source,
        target: targetIdx,
        tmux: probe.tmux,
        occupiedIndices,
        driverIndex: Number.isFinite(driverIdx) ? driverIdx : 1,
      });
      moveCount++;
    }
  }

  await persistMemberOrder(tjPath, targetOrder);

  if (probe === null) {
    stdout(`✅ member sort: persisted ${targetOrder.length} members in canonical order\n`);
  } else {
    stdout(
      `✅ member sort: ${moveCount} tmux move-window call${moveCount === 1 ? "" : "s"}; team.json members[] persisted\n`,
    );
  }
  return { exitCode: 0, wrote: true, moveCount };
}

/** Map a live `listWindows` result onto the team's member roster — used
 *  after a tmux mutation to derive the authoritative new order without
 *  hand-computing shifts. Windows that don't match any member (driver
 *  pane, atmux-internal placeholder windows) are dropped. */
export function mapWindowsToMemberIds(
  live: ReadonlyArray<{ index: number; name: string }>,
  members: ReadonlyArray<MemberShape>,
): ReadonlyArray<string> {
  const sorted = [...live].sort((a, b) => a.index - b.index);
  const ids: string[] = [];
  for (const w of sorted) {
    const m = members.find((mem) => {
      const canonical = buildWindowName(mem.name, mem.emoji, mem.label, mem.role);
      const adr135Hyphen = buildWindowName(mem.name, mem.emoji, mem.label);
      const legacy = buildWindowNameLegacy(mem.name, mem.emoji);
      return w.name === canonical || w.name === adr135Hyphen || w.name === legacy;
    });
    if (m !== undefined) ids.push(m.name);
  }
  return ids;
}

// ---------- `member status` — ADR-260 §D3/§D4 self-reported status ----------

const STATUS_USAGE =
  `atmux member status <${MEMBER_SELF_STATUS_VALUES.join("|")}> ` +
  `[--as <member>] [--note <text>] [--task <task-id>] [--team-dir <dir>]`;

/**
 * `atmux member status <status>` — ADR-260 §D3: the member LLM
 * self-reports its status. The canonical status verb for manual
 * orchestration mode (the default — no orchd daemon), where the
 * agents ARE the orchestrator and this record is the authoritative
 * intent signal `atmux status` renders next to the derived ones.
 *
 * Kanban coupling per ADR-260 §D4:
 *   - `working --task <id>` claims the task when it isn't already
 *     this member's (full claim gates: deps, driver-only, race).
 *   - `blocked --task <id>` moves the task to `blocked` with the
 *     `--note` text.
 *   - `idle` never mutates the kanban but lists any in-progress
 *     tasks still owned by the member with an `atmux done` hint —
 *     going idle with a dangling in-progress row is usually a lie.
 *   - `rate-limited` records `--task` as a reference only.
 *
 * Every write also touches the member's heartbeat file (a
 * self-report is proof of liveness, ADR-260 §D3) so manual-mode
 * teams keep fresh ❤️ markers without the cron poke loop.
 */
export async function memberStatusSet(
  argv: ReadonlyArray<string>,
  opts: MemberRenameOpts = {},
): Promise<number> {
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  let status: string | undefined;
  let who: string | undefined;
  let note: string | undefined;
  let taskId: string | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--as" || a === "--note" || a === "--task" || a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: `member status: ${a} requires a value`, hint: STATUS_USAGE });
      }
      if (a === "--as") who = v;
      else if (a === "--note") note = v;
      else if (a === "--task") taskId = v;
      else teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("--")) {
      throw new UsageError({ what: `member status: unknown flag: ${a}`, hint: STATUS_USAGE });
    }
    if (status !== undefined) {
      throw new UsageError({
        what: `member status: unexpected extra argument: ${a}`,
        hint: STATUS_USAGE,
      });
    }
    status = a;
    i += 1;
  }
  if (status === undefined || status.length === 0) {
    throw new UsageError({ what: "member status: status value required", hint: STATUS_USAGE });
  }
  if (!isMemberSelfStatus(status)) {
    throw new UsageError({
      what: `member status: unknown status '${status}' (try: ${MEMBER_SELF_STATUS_VALUES.join(" | ")})`,
      hint: STATUS_USAGE,
    });
  }

  const dirOpts: ResolveDirOpts = teamDir !== undefined ? { teamDir } : {};
  const team = await requireTeam(dirOpts);
  const resolved = pickMemberName({ id: "", ...(who !== undefined ? { who } : {}) }, env, cwd, team.members);
  if (resolved === undefined) {
    throw new UsageError({
      what: "member status: can't infer member — set ATMUX_MEMBER or pass --as <member>",
      hint: STATUS_USAGE,
    });
  }
  // Roster guard — a typo'd `--as` would otherwise mint a status file
  // for a member that doesn't exist, which `atmux status` (keyed on
  // team.members[]) would never render.
  if (!team.members.some((m) => m.name === resolved)) {
    throw new ConfigError({
      what: `member status: no such member in team.json: ${resolved}`,
    });
  }
  const atmuxDir = await getAtmuxDir(dirOpts);

  // ADR-260 §D4 kanban coupling.
  if (taskId !== undefined) {
    const task = await showTask(atmuxDir, taskId);
    if (task === null) {
      throw new ConfigError({ what: `member status: no such task: ${taskId}` });
    }
    if (status === "working") {
      const alreadyMine = task.status === "in-progress" && task.owner === resolved;
      if (!alreadyMine) {
        // Full claim gates apply (deps / driver-only / in-progress-other
        // race refusal) — `member status working --task` is a claim,
        // not a side-channel around it.
        const callerScope = resolveCallerScope();
        const { pre } = await claimTaskForMember(atmuxDir, taskId, resolved, { callerScope });
        await movePendingToInProgress(atmuxDir, resolved, pre, nowEpoch());
        stdout(`${resolved} claimed ${taskId}\n`);
      }
    } else if (status === "blocked") {
      await markTaskBlockedWithNote(
        atmuxDir,
        taskId,
        note ?? `blocked by ${resolved} via member status`,
      );
      stdout(`${taskId} → blocked\n`);
    }
    // idle / rate-limited: taskId recorded as a reference, no transition.
  }

  await writeMemberStatus(atmuxDir, {
    member: resolved,
    status,
    ...(note !== undefined ? { note } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  });
  await writeHeartbeat(atmuxDir, resolved);

  stdout(`${resolved} status → ${status}${taskId !== undefined ? ` (${taskId})` : ""}\n`);

  if (status === "idle") {
    const ib = await loadInbox(atmuxDir, resolved);
    if (ib.inProgress.length > 0) {
      stdout(
        `note: ${resolved} still owns ${ib.inProgress.length} in-progress task(s) — going idle with dangling work is usually a lie:\n`,
      );
      for (const t of ib.inProgress) {
        stdout(`  ${t.id}  ${t.subject ?? ""}  → atmux done ${t.id}  (or atmux task move ${t.id} todo)\n`);
      }
    }
  }
  return 0;
}

// ---------- Sub-verb dispatcher (called from src/cli.ts) ----------

/**
 * `atmux member <sub> [args]` — V1 ports `rename` (ADR-136 TR3) +
 * `move | swap | sort` (ADR-161 TR3). Unknown sub-verbs throw
 * UsageError so the exit code (64) flows through `reportError` rather
 * than being a dispatcher-special case.
 */
export async function dispatchMemberSubverb(
  argv: ReadonlyArray<string>,
  opts: MemberRenameOpts = {},
): Promise<number> {
  const sub = argv[0];
  const knownSubs = "rename | move | swap | sort | status";
  if (sub === undefined || sub === "") {
    throw new UsageError({
      what: `member: subverb required (try: ${knownSubs})`,
      hint: "run 'atmux help' for the list of verbs",
    });
  }
  switch (sub) {
    case "rename":
      return memberRename(argv.slice(1), opts);
    case "move":
      return memberMove(argv.slice(1), opts);
    case "swap":
      return memberSwap(argv.slice(1), opts);
    case "sort":
      return memberSort(argv.slice(1), opts);
    case "status":
      // ADR-260 §D3: member self-reported status (manual-mode canonical).
      return memberStatusSet(argv.slice(1), opts);
    default:
      throw new UsageError({
        what: `member: unknown subverb '${sub}' (try: ${knownSubs})`,
        hint: "run 'atmux help' for the list of verbs",
      });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

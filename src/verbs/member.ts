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
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../abstractions/tmux.ts";
import {
  buildWindowName,
  getAtmuxDir,
  getSessionName,
  loadTeam,
  type ResolveDirOpts,
  resolveTeamSocket,
  teamJsonPath,
} from "../core/common.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { leadWindowNamePath } from "../core/lead-marker.ts";
import { ConfigError, UsageError } from "../errors.ts";
import { Team, type TeamMember } from "../schema/team.ts";

const USAGE = "atmux member rename <member-id> --label <new-label>";

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

// ---------- Sub-verb dispatcher (called from src/cli.ts) ----------

/**
 * `atmux member <sub> [args]` — V1 ports `rename` only. Unknown sub-
 * verbs throw UsageError so the exit code (64) flows through
 * `reportError` rather than being a dispatcher-special case.
 */
export async function dispatchMemberSubverb(
  argv: ReadonlyArray<string>,
  opts: MemberRenameOpts = {},
): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "") {
    throw new UsageError({
      what: "member: subverb required (try: rename)",
      hint: "run 'atmux help' for the list of verbs",
    });
  }
  switch (sub) {
    case "rename":
      return memberRename(argv.slice(1), opts);
    default:
      throw new UsageError({
        what: `member: unknown subverb '${sub}' (try: rename)`,
        hint: "run 'atmux help' for the list of verbs",
      });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

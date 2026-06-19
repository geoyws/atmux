// ADR-010: CLI dispatcher — `stop` verb.
// ADR-004 amend: socket-pinned tmux factory.
// ADR-017: member windows no longer carry the `__<team>__` prefix.
// Bash spec: lib/stop.sh @ worktree-frozen.
//
// Behaviour (1:1 parity with bash, with the ADR-017 drift fix):
//
//   1. Resolve session name via getSessionName.
//   2. If session does not exist → warn + return 0 (bash:19-22).
//   3. Unless --force: send C-c to each member's window, sleep 2s
//      (bash:25-33). Bash filters windows by `^__<team>__` prefix —
//      that prefix was dropped in ADR-017, so the bash filter would
//      match zero windows in the post-ADR-017 world. The TS port
//      iterates team.members[] explicitly + builds window names via
//      buildWindowName(name, emoji).
//   4. Unless --no-archive: archive `inboxes/`, `kanban.json`,
//      `driver-inbox.md` to `<atmuxDir>/archive/<UTC-ts>/` (bash:43-51).
//   5. Kill the session.
//
// Concurrency: no kanban/inbox writes here, just file copies + tmux
// kill. No locking needed beyond what `core/inbox.ts` already provides
// for the in-flight writes that may be racing. Archive is best-effort
// — if a writer is mid-flock the snapshot may be stale; bash's `cp`
// has the same race.

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../abstractions/fs.ts";
import { createTmux, type SendTarget } from "../abstractions/tmux.ts";
import {
  defaultGitSpawn,
  deleteWorktreeBranch,
  type GitSpawn,
  pruneWorktree,
  resolveWorktreePath,
  sanitizeBranchSegment,
} from "../abstractions/worktree.ts";
import {
  archiveDir,
  buildWindowName,
  driverInboxPath,
  getAtmuxDir,
  getSessionName,
  inboxDir,
  kanbanJsonPath,
  type ResolveDirOpts,
  requireTeam,
  resolveTeamSocket,
} from "../core/common.ts";
import { UsageError } from "../errors.ts";
import type { Team } from "../schema/team.ts";

const USAGE = "atmux stop [--force|-f] [--no-archive] [--prune-branch]";

/** Parsed `stop` argv. */
export interface StopArgs {
  force: boolean;
  archive: boolean;
  /** ADR-084 OQ2 opt-in: after `git worktree remove` succeeds for a
   *  member, also run `git branch -d <base>-<member>` to delete the
   *  orphan per-member branch. Requires `--force` (the layered opt-in
   *  posture from {@link pruneWorktree}'s `dirty: 'force'`). */
  pruneBranch: boolean;
  socketPath?: string;
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on unknown args. */
export function parseStopArgs(argv: ReadonlyArray<string>): StopArgs {
  let force = false;
  let archive = true;
  let pruneBranch = false;
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
    if (a === "--no-archive") {
      archive = false;
      i += 1;
      continue;
    }
    if (a === "--prune-branch") {
      pruneBranch = true;
      i += 1;
      continue;
    }
    if (a === "--socket") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "stop: --socket requires a path", hint: USAGE });
      }
      socketPath = v;
      i += 2;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "stop: --team-dir requires a value", hint: USAGE });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `stop: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  // Layered opt-in: --prune-branch requires --force, same posture as
  // pruneWorktree's `dirty: 'force'`. Without --force the prune step
  // doesn't run at all (worktrees survive normal stop+start cycles per
  // ADR-082 §4); pairing branch-delete with that no-op is meaningless.
  if (pruneBranch && !force) {
    throw new UsageError({
      what: "stop: --prune-branch requires --force",
      hint: USAGE,
    });
  }
  const out: StopArgs = { force, archive, pruneBranch };
  if (socketPath !== undefined) out.socketPath = socketPath;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

/**
 * Build a UTC timestamp matching bash `date -u +%Y%m%dT%H%M%SZ`.
 * Exported for direct unit-testing without freezing time globally.
 */
export function archiveTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

/** `atmux stop [--force] [--no-archive]`. Returns 0. */
export interface StopOpts {
  /** ADR-082 W4: inject the git spawner for the per-member worktree
   *  prune step. Default = the real `git` via `defaultGitSpawn` from
   *  `abstractions/worktree.ts`. Tests pass a mock so the prune path
   *  doesn't shell out to git against a live repo. */
  gitSpawn?: GitSpawn;
}

export async function stop(argv: ReadonlyArray<string>, opts: StopOpts = {}): Promise<number> {
  const parsed = parseStopArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team: Team = await requireTeam(dirOpts);
  const sessionName = await getSessionName({ ...dirOpts, team });
  const atmuxDir = await getAtmuxDir(dirOpts);
  // t-f786031f: honour team.tmuxTmpdir for the cage socket. Pre-fix
  // pinned `/tmp/atmux-<team>/sock` unconditionally; on project-local-
  // tmpdir teams `atmux stop` checked an empty path, hit
  // `hasSession === false`, and exited 0 without killing the live cage.
  // Same fix as tell-lead / send / dispatch in this commit.
  const socketPath = parsed.socketPath ?? resolveTeamSocket(team);
  const tmux = createTmux({ socketPath });

  if (!(await tmux.session.hasSession(`=${sessionName}`))) {
    process.stderr.write(`atmux: warn: session ${sessionName} does not exist — nothing to stop\n`);
    return 0;
  }

  // Bare stop: send C-c to each live pane + a short grace window so any
  // in-flight foreground work can wrap up before teardown. `--force`
  // skips the interrupt entirely and goes straight to archive + kill.
  if (!parsed.force) {
    await sendCancelToMembers(tmux, sessionName, team);
    await sleep(2000);
  }

  if (parsed.archive) {
    await archiveState(atmuxDir);
  }

  // ADR-082 W4: --force-only worktree teardown. Runs BEFORE killSession
  // so members are still alive to commit anything pending (the spec
  // hedges — --force isn't really for clean exits — but the
  // dirty-skip default protects them either way). Normal `atmux stop`
  // (no --force) intentionally does NOT prune: worktrees should
  // survive every stop+start cycle except the explicit teardown one.
  if (parsed.force && team.worktreeIsolation === true) {
    await pruneWorktrees(team, atmuxDir, opts.gitSpawn, parsed.pruneBranch);
  }

  // Bash uses `kill-session ... 2>/dev/null || true` — best-effort.
  try {
    await tmux.session.killSession(`=${sessionName}`);
  } catch {
    // expected: session may have died between has-session and kill
    // (race on a parallel `atmux stop`). Safe to swallow.
  }
  process.stdout.write(`session ${sessionName} stopped\n`);

  return 0;
}

// ---------- Internals ----------

/**
 * ADR-082 W4: per-member worktree prune. Resolves repo root via
 * `git rev-parse --show-toplevel` once, then calls W1's
 * `pruneWorktree` for each member. The helper handles three terminal
 * states:
 *
 *   - missing  — worktree path absent (idempotent — already pruned).
 *   - dirty    — `git status --porcelain` non-empty; default `skip`
 *                mode leaves the worktree intact + counts toward the
 *                operator-visible summary so the user sees what was
 *                preserved.
 *   - pruned   — clean worktree removed via `git worktree remove`.
 *
 * Failures (missing repo root, individual prune throws) degrade to
 * warnings rather than aborting — `atmux stop --force` must not wedge
 * because one worktree's git invocation tripped.
 */
async function pruneWorktrees(
  team: Team,
  atmuxDir: string,
  gitOverride?: GitSpawn,
  pruneBranch = false,
): Promise<void> {
  const git = gitOverride ?? defaultGitSpawn;
  // Match start.ts's projectRoot resolution: regex-strip the trailing
  // `/.atmux/?` from atmuxDir rather than bare `dirname()`, so test
  // fixtures (atmuxDir without `.atmux` suffix) and production paths
  // both yield the directory containing `.atmux/`.
  const projectRoot = atmuxDir.replace(/\/?\.atmux\/?$/, "") || "/";
  const rootR = await git(["-C", projectRoot, "rev-parse", "--show-toplevel"]);
  if (rootR.exitCode !== 0) {
    process.stderr.write(
      `atmux: warn: worktree-prune skipped — cannot detect repo root at ${projectRoot}\n`,
    );
    return;
  }
  const repoPath = rootR.stdout.trim();

  // ADR-084 OQ2 opt-in: if --prune-branch was passed, resolve the
  // team's current branch ONCE — used to derive each member's wtBranch
  // as `${baseBranch}-${sanitizeBranchSegment(member.name)}`. Same
  // convention as start.ts. If the lookup fails (detached HEAD, repo
  // edge case), --prune-branch degrades to no-op with a warn but
  // worktree-prune still runs.
  let baseBranch: string | null = null;
  if (pruneBranch) {
    const br = await git(["-C", repoPath, "branch", "--show-current"]);
    if (br.exitCode === 0 && br.stdout.trim() !== "") {
      baseBranch = br.stdout.trim();
    } else {
      process.stderr.write(
        "atmux: warn: --prune-branch skipped — cannot resolve base branch (detached HEAD?)\n",
      );
    }
  }

  let pruned = 0;
  let dirty = 0;
  let missing = 0;
  let branchDeleted = 0;
  let branchUnmerged = 0;
  let branchMissing = 0;
  for (const member of team.members) {
    const wtPath = resolveWorktreePath(team, member.name, atmuxDir);
    let workPruned = false;
    try {
      const r = await pruneWorktree(repoPath, wtPath, { git });
      if (r.pruned) {
        pruned += 1;
        workPruned = true;
      } else if (r.reason === "dirty") {
        dirty += 1;
        process.stderr.write(
          `atmux: warn: worktree ${member.name} dirty — left for operator (${wtPath})\n`,
        );
      } else if (r.reason === "missing") {
        missing += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`atmux: warn: worktree ${member.name} prune failed — ${msg}\n`);
    }
    // ADR-084 OQ2: branch-delete only fires on the worktree-pruned
    // success path. Dirty / missing / failed worktrees keep their
    // branches — operator handles. Mirrors the "never silently destroy
    // unpushed work" principle.
    if (workPruned && pruneBranch && baseBranch !== null) {
      const wtBranch = `${baseBranch}-${sanitizeBranchSegment(member.name)}`;
      try {
        const br = await deleteWorktreeBranch(repoPath, wtBranch, { git });
        if (br.deleted) {
          branchDeleted += 1;
        } else if (br.reason === "unmerged") {
          branchUnmerged += 1;
          process.stderr.write(
            `atmux: warn: branch ${wtBranch} not fully merged — left for operator\n`,
          );
        } else if (br.reason === "missing") {
          branchMissing += 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`atmux: warn: branch ${wtBranch} delete failed — ${msg}\n`);
      }
    }
  }
  const total = team.members.length;
  process.stdout.write(
    `worktree: pruned ${pruned}/${total}; ${dirty} dirty (left for operator), ${missing} already gone\n`,
  );
  if (pruneBranch && baseBranch !== null) {
    process.stdout.write(
      `worktree-branch: deleted ${branchDeleted}/${pruned}; ${branchUnmerged} unmerged (left for operator), ${branchMissing} already gone\n`,
    );
  }
}

async function sendCancelToMembers(
  tmux: ReturnType<typeof createTmux>,
  sessionName: string,
  team: Team,
): Promise<void> {
  // ADR-017: window names are bare member names (or emoji+name); no
  // `__<team>__` prefix. Iterate roster + build window names directly.
  // ADR-025: tag the lead member's pane with `kind: "lead"`; everyone
  // else `kind: "member"`. Driver pane is never targeted (it's not in
  // the roster), so the discriminated union's type-system gate is
  // automatic here.
  for (const m of team.members) {
    // ADR-161 TR2: role-aware window name (defaults → `_-prefix`).
    const win = buildWindowName(m.name, m.emoji, m.label, m.role);
    const tmuxTarget = `${sessionName}:${win}`;
    const role = typeof m.role === "string" ? m.role : "member";
    const sendTarget: SendTarget =
      role === "team-lead"
        ? { kind: "lead", team: team.name, target: tmuxTarget }
        : { kind: "member", member: m.name, team: team.name, target: tmuxTarget };
    try {
      // ADR-057 §D1: deliberately raw — NOT routed through safeSendKeys.
      // Reason: C-c is the interrupt itself, not a content keystroke.
      // It's a control character at the tmux level (not a UI input
      // typed into the compose box), so it works on modal-stuck panes
      // too. Routing through the safe-send gate would add classify +
      // retry latency (RETRY_POLICY.TYPING is 12 attempts × 250ms = 3s)
      // in the kill path right before killWindow — net effect would be
      // slower forced-kill with no safety win. The next step in `stop`
      // is killWindow regardless, so a missed C-c is recoverable.
      await tmux.pane.sendKeys({ target: sendTarget, keys: "C-c", enter: false });
    } catch {
      // expected: window may not exist (member never spawned, or
      // already-killed). Bash uses `2>/dev/null || true` here.
    }
  }
}

/**
 * Copy `.atmux/inboxes/`, `.atmux/kanban.json`, `.atmux/driver-inbox.md`
 * to `.atmux/archive/<ts>/` if present. Best-effort — bash mirrors
 * the same `2>/dev/null || true` pattern (lib/stop.sh:47-49).
 */
async function archiveState(atmuxDir: string): Promise<void> {
  const ts = archiveTimestamp(Date.now());
  const dest = join(archiveDir(atmuxDir), ts);
  await mkdir(dest, { recursive: true });

  // inboxes/ → archive/<ts>/inboxes/
  const srcInboxes = inboxDir(atmuxDir);
  if (await exists(srcInboxes)) {
    const destInboxes = join(dest, "inboxes");
    await mkdir(destInboxes, { recursive: true });
    for (const entry of await readdir(srcInboxes)) {
      try {
        await copyFile(join(srcInboxes, entry), join(destInboxes, entry));
      } catch {
        // expected: race or transient failure; archive is best-effort.
      }
    }
  }

  // kanban.json → archive/<ts>/kanban.json
  const srcKanban = kanbanJsonPath(atmuxDir);
  if (await exists(srcKanban)) {
    try {
      await copyFile(srcKanban, join(dest, "kanban.json"));
    } catch {
      // expected: best-effort.
    }
  }

  // driver-inbox.md → archive/<ts>/driver-inbox.md
  const srcDriver = driverInboxPath(atmuxDir);
  if (await exists(srcDriver)) {
    try {
      await copyFile(srcDriver, join(dest, "driver-inbox.md"));
    } catch {
      // expected: best-effort.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

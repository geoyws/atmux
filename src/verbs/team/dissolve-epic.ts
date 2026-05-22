// ADR-090 §`dissolve-epic` verb (t-b430b185).
//
// `atmux team dissolve-epic <epicId> [--skip-checks] [--force-prune]`
//
// Tears down an epic-team spawned by `atmux team spawn-epic`. Reuses
// softStop (`src/core/soft-stop.ts`, ADR-087) for the graceful-stop
// step + pruneWorktree (`src/abstractions/worktree.ts`, ADR-082) for
// the worktree cleanup; this verb is composition, not new
// infrastructure. Mirrors ADR-090 §dissolve-epic step-list.
//
// Pipeline (single-commit, single-verb):
//
//   1. Resolve caller-scope. Refuses if not driver.
//   2. Find epic-team in cockpit.json — walk sessions[] tree to
//      locate the epic-team entry by name. Refuses if absent.
//   3. Resolve epic root + parent root from cockpit topology.
//      epicRoot = `<parentRoot>-epics/<epicId>`; parentRoot from
//      the matched parent session entry.
//   4. Pre-flight gates (skipped under --skip-checks):
//        (a) epic-team's kanban must have all child Tasks in `done`
//            or `wontfix` (matches epic-merge.ts's gate-pass cond).
//        (b) epic-team's worktree must be clean (git status
//            --porcelain empty).
//      Failure surfaces the offending count + suggests --skip-checks
//      lead-override per Task pre-flag #2 + ADR-090 resolved-open
//      #5.
//   5. softStop the child cage. ADR-087's softStop writes a resume
//      manifest with reason='dissolve-epic'. No-op if the team.json
//      load fails (e.g. partially-spawned remnant — skip soft-stop,
//      proceed to worktree prune).
//   6. pruneWorktree. Defaults to `dirty: 'skip'`; --force-prune
//      OR --skip-checks switches to `dirty: 'force'`.
//   7. Remove epic-team entry from parent's cockpit sessions[].
//   8. Mark parent's kanban EPIC row done (parentEpicKanbanId from
//      child's team.json::epicTeam.parentEpicKanbanId).
//   9. Log "dissolved" + next-step hint.
//
// Out of scope: trunk-merge gate (handled by ADR-091 epic-merge
// cron BEFORE dissolve fires in the auto-path); cage tmpdir GC
// (cockpit rebuild handles tmpdir reconciliation); cross-team
// tell-lead surfacing (ADR-092).

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { exists, writeText } from "../../abstractions/fs.ts";
import { readJson } from "../../abstractions/json.ts";
import { closeDatabase, type Database, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import { createTmux, type TmuxConfig, type TmuxNamespace } from "../../abstractions/tmux.ts";
import {
  defaultGitSpawn,
  type GitSpawn,
  isWorktreeDirty,
  pruneWorktree,
} from "../../abstractions/worktree.ts";
import {
  cageSessionName,
  defaultCockpitConfigPath,
  removeEpicViewerFromParentCage,
  resolveCageSocket,
} from "../../core/cockpit.ts";
import { resolveCallerScope } from "../../core/common.ts";
import { softStop } from "../../core/soft-stop.ts";
import { ConfigError, UsageError } from "../../errors.ts";
import { Team, type Team as TeamShape } from "../../schema/team.ts";

const USAGE = "atmux team dissolve-epic <epicId> [--skip-checks] [--force-prune]";

// ---------- Arg parsing ----------

export interface ParsedDissolveEpicArgs {
  epicId: string;
  skipChecks: boolean;
  forcePrune: boolean;
}

export function parseDissolveEpicArgs(argv: ReadonlyArray<string>): ParsedDissolveEpicArgs {
  let epicId: string | undefined;
  let skipChecks = false;
  let forcePrune = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--skip-checks") {
      skipChecks = true;
      i += 1;
      continue;
    }
    if (a === "--force-prune") {
      forcePrune = true;
      i += 1;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `dissolve-epic: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    if (epicId === undefined) {
      epicId = a;
      i += 1;
      continue;
    }
    throw new UsageError({
      what: `dissolve-epic: unexpected positional: ${a}`,
      hint: USAGE,
    });
  }
  if (epicId === undefined || epicId.length === 0) {
    throw new UsageError({
      what: "dissolve-epic: <epicId> required",
      hint: USAGE,
    });
  }
  return { epicId, skipChecks, forcePrune };
}

// ---------- Verb dependencies ----------

export interface DissolveEpicOpts {
  git?: GitSpawn;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  openDb?: (path: string) => Database;
  closeDb?: (db: Database) => void;
  cockpitPath?: string;
  callerScope?: () => "driver" | "member";
  env?: NodeJS.ProcessEnv;
  /** Test injection — cage teardown hook. Default:
   *  {@link defaultCageTeardown}, which resolves the child cage's
   *  socket, runs ADR-087 `softStop` (manifest + grace + notify), then
   *  `tmux kill-session` so the cage tmux server actually exits.
   *
   *  Historical regression t-<this-fix> (2026-05-21): previously this
   *  was named `softStopHook` AND was opt-in (`if hook !== undefined`),
   *  so production dissolve-epic NEVER killed cage tmux servers. Result:
   *  every dissolve leaked an orphan tmux server + its ~10 claude
   *  workers (operator observed 20+ ghost sessions). The wiring now
   *  applies the default in production and tests still override via this
   *  hook to bypass the cage teardown when they don't want to mock a
   *  full tmux. */
  softStopHook?: (deps: {
    epicRoot: string;
    childTeam: TeamShape;
  }) => Promise<void>;
  /** Tmux factory. Defaults to {@link createTmux}. Tests injecting a
   *  custom `softStopHook` typically don't need this — it's only used
   *  by the default `softStopHook` path. */
  tmuxFactory?: (config: TmuxConfig) => TmuxNamespace;
}

// ---------- Raw cockpit shape ----------

const RawCockpitForMutation = z
  .object({
    sessions: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface SessionEntry {
  type?: string;
  name?: string;
  root?: string;
  sessions?: SessionEntry[];
  parent?: string;
  epicId?: string;
}

// ---------- Top-level dispatch ----------

export async function dissolveEpic(
  argv: ReadonlyArray<string>,
  opts: DissolveEpicOpts = {},
): Promise<number> {
  const parsed = parseDissolveEpicArgs(argv);
  const logger = opts.logger ?? {
    log: (m: string) => process.stderr.write(`${m}\n`),
    warn: (m: string) => process.stderr.write(`WARN: ${m}\n`),
  };
  const git = opts.git ?? defaultGitSpawn;
  const env = opts.env ?? process.env;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env }));
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const home = env.HOME ?? "/root";
  const cockpitPath = opts.cockpitPath ?? defaultCockpitConfigPath(home);

  // 1. Caller-scope gate.
  if (callerScope() !== "driver") {
    throw new ConfigError({
      what: "dissolve-epic: refused — caller scope is not 'driver'. Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux team dissolve-epic ...",
    });
  }

  // 2. Find epic-team in cockpit + resolve parent.
  const cockpitRaw = await readJson(cockpitPath, RawCockpitForMutation);
  const found = findEpicSession(
    (cockpitRaw.sessions as SessionEntry[] | undefined) ?? [],
    parsed.epicId,
  );
  if (found === null) {
    throw new ConfigError({
      what: `dissolve-epic: epic-team '${parsed.epicId}' not found in cockpit ${cockpitPath}`,
      hint: "verify the epicId — `atmux cockpit list` shows all registered teams",
    });
  }
  const { parentEntry, epicEntry } = found;
  if (parentEntry.root === undefined || parentEntry.root.length === 0) {
    throw new ConfigError({
      what: `dissolve-epic: parent team '${parentEntry.name}' has no 'root' in cockpit.json`,
      hint: "cockpit.json corruption — restore from backup before retrying",
    });
  }
  const parentRoot = parentEntry.root;
  const epicRoot = join(`${parentRoot}-epics`, parsed.epicId);

  // 3. Read child team.json (best-effort — may be missing on a
  //    partially-spawned remnant). When absent, skip the kanban
  //    gates + soft-stop and go straight to worktree + cockpit
  //    cleanup; this is the "rescue a broken spawn-epic" path.
  const childTeamPath = join(epicRoot, ".atmux", "team.json");
  let childTeam: TeamShape | null = null;
  if (await exists(childTeamPath)) {
    childTeam = await readJson(childTeamPath, Team);
  }

  // 4. Pre-flight gates (skipped under --skip-checks).
  if (!parsed.skipChecks && childTeam !== null) {
    await assertPreflightGates({
      epicRoot,
      childAtmuxDir: join(epicRoot, ".atmux"),
      git,
      openDb,
      closeDb,
    });
  } else if (parsed.skipChecks) {
    logger.warn(
      `dissolve-epic: --skip-checks bypassing all-tasks-done + clean-worktree gates for '${parsed.epicId}' (operator owns the consequences per ADR-090 resolved-open #5)`,
    );
  }

  // 5. Soft-stop + kill the child cage. Best-effort — log warn on
  //    failure but continue. The cage may already be down (operator
  //    killed it out-of-band, or it never spawned).
  //
  //    Default hook = {@link defaultCageTeardown} (softStop + killSession
  //    against the resolved cage socket). Pre-fix this step was gated
  //    on `opts.softStopHook !== undefined`, which meant production
  //    NEVER killed the cage tmux server (the operator-observed ghost-
  //    session pile-up). Now: hook always runs when childTeam exists;
  //    tests inject a no-op via opts.softStopHook to skip real teardown.
  if (childTeam !== null) {
    const hook =
      opts.softStopHook ??
      ((deps: { epicRoot: string; childTeam: TeamShape }) =>
        defaultCageTeardown({
          epicRoot: deps.epicRoot,
          childTeam: deps.childTeam,
          tmuxFactory: opts.tmuxFactory ?? createTmux,
          logger,
        }));
    try {
      await hook({ epicRoot, childTeam });
    } catch (e) {
      logger.warn(
        `dissolve-epic: cage teardown failed for '${parsed.epicId}' — continuing with prune (${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  // 5a. ADR-089 §Pillar 1 §Amendment (t-2ea3bdb9): remove the parent-cage
  //     viewer-window that bridges into this epic-team. Mirrors the
  //     symmetric add in `atmux start`. Soft-fails if the parent cage
  //     isn't running OR the window doesn't exist (idempotent).
  try {
    await removeEpicViewerFromParentCage({
      parentRoot,
      parentName: parentEntry.name ?? "",
      epicId: parsed.epicId,
      tmuxFactory: createTmux as Parameters<
        typeof removeEpicViewerFromParentCage
      >[0]["tmuxFactory"],
      log: (m) => logger.log(`  ${m.replace(/^\s+/, "")}`),
      warn: (m) => logger.warn(m),
    });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    logger.warn(`dissolve-epic: epic-viewer remove failed — continuing (${cause})`);
  }

  // 6. Prune the worktree.
  if (await exists(epicRoot)) {
    const dirtyMode: "skip" | "force" = parsed.forcePrune || parsed.skipChecks ? "force" : "skip";
    const result = await pruneWorktree(parentRoot, epicRoot, {
      git,
      dirty: dirtyMode,
    });
    if (!result.pruned) {
      if (result.reason === "dirty") {
        // Surface the operator-actionable refusal. The worktree
        // stays; cockpit entry stays; the operator commits OR
        // re-runs with --force-prune / --skip-checks.
        throw new ConfigError({
          what: `dissolve-epic: refused to prune ${epicRoot} — worktree has uncommitted changes`,
          hint: "commit + push the changes, OR re-run with --force-prune (destroys uncommitted work)",
        });
      }
      // 'missing' — worktree was already gone. Idempotent path.
      logger.warn(`dissolve-epic: worktree at ${epicRoot} already absent — continuing cleanup`);
    }
    // Best-effort: rm the epicsDir if it's now empty (cleanup the
    // sibling parent-dir artifact). Failure is non-fatal.
    try {
      await rm(`${parentRoot}-epics`, { recursive: false });
    } catch {
      // Directory had siblings or doesn't exist — both fine.
    }
  }

  // 6a. e-7a1014f9 §Fix #2 — delete the epic branch when merged into
  //     trunk. ADR-090 §Disk layout names the branch `<parentBase>-
  //     epic-<epicId>`; we resolve parentBase from childTeam's
  //     epicTeam block. Skip if childTeam is absent (partially-spawned
  //     remnant — no reliable branch name). Skip if --skip-checks AND
  //     branch unmerged (operator rescue path preserves the unmerged
  //     work even when forcing dissolve).
  if (childTeam !== null && childTeam.epicTeam !== undefined) {
    await deleteMergedEpicBranch({
      parentRoot,
      parentBase: childTeam.epicTeam.parentBase,
      epicId: parsed.epicId,
      skipChecks: parsed.skipChecks,
      git,
      logger,
    });
  }

  // 7. Remove epic-team entry from parent's cockpit sessions[].
  if (parentEntry.sessions !== undefined) {
    parentEntry.sessions = parentEntry.sessions.filter(
      (s) => !(s.type === "epic-team" && s.name === parsed.epicId),
    );
    if (parentEntry.sessions.length === 0) delete parentEntry.sessions;
  }
  await writeText(cockpitPath, `${JSON.stringify(cockpitRaw, null, 2)}\n`);

  // 8. Mark parent's kanban EPIC row done (best-effort — may already
  //    be done, may be missing, both fine).
  if (childTeam !== null && childTeam.epicTeam !== undefined) {
    await markParentEpicDone(
      parentRoot,
      childTeam.epicTeam.parentEpicKanbanId,
      openDb,
      closeDb,
      logger,
    );
  }

  // Suppress unused-var lint — epicEntry is the matched session we
  // already removed via the parent filter above; keeping the
  // destructure makes the find() shape readable.
  void epicEntry;

  logger.log(`epic-team dissolved: ${parsed.epicId} (parent=${parentEntry.name ?? "<unnamed>"})`);
  return 0;
}

// ---------- Helpers ----------

function findEpicSession(
  sessions: ReadonlyArray<SessionEntry>,
  epicId: string,
  parent: SessionEntry | null = null,
): { parentEntry: SessionEntry; epicEntry: SessionEntry } | null {
  for (const s of sessions) {
    if (s.type === "epic-team" && s.name === epicId && parent !== null) {
      return { parentEntry: parent, epicEntry: s };
    }
    if (Array.isArray(s.sessions)) {
      const inner = findEpicSession(s.sessions, epicId, s);
      if (inner !== null) return inner;
    }
  }
  return null;
}

async function assertPreflightGates(deps: {
  epicRoot: string;
  childAtmuxDir: string;
  git: GitSpawn;
  openDb: (path: string) => Database;
  closeDb: (db: Database) => void;
}): Promise<void> {
  // (a) all-tasks-done.
  const dbPath = join(deps.childAtmuxDir, "state.db");
  if (await exists(dbPath)) {
    const db = deps.openDb(dbPath);
    try {
      const row = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done', 'wontfix')`,
        )
        .get();
      const open = row?.n ?? 0;
      if (open > 0) {
        throw new ConfigError({
          what: `dissolve-epic: refused — epic-team has ${open} open task${open === 1 ? "" : "s"} (status not in done/wontfix)`,
          hint: "finish or wontfix the open tasks, OR re-run with --skip-checks (ADR-090 resolved-open #5)",
        });
      }
    } finally {
      deps.closeDb(db);
    }
  }
  // (b) clean worktree.
  if (await isWorktreeDirty(deps.epicRoot, { git: deps.git })) {
    throw new ConfigError({
      what: `dissolve-epic: refused — worktree at ${deps.epicRoot} has uncommitted changes`,
      hint: "commit + push, OR re-run with --skip-checks (destroys uncommitted work)",
    });
  }
}

async function markParentEpicDone(
  parentRoot: string,
  parentEpicKanbanId: string,
  openDb: (path: string) => Database,
  closeDb: (db: Database) => void,
  logger: { log: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  const parentDbPath = join(parentRoot, ".atmux", "state.db");
  if (!(await exists(parentDbPath))) {
    logger.warn(
      `dissolve-epic: parent state.db missing at ${parentDbPath} — skipping EPIC row update`,
    );
    return;
  }
  const db = openDb(parentDbPath);
  try {
    const now = Math.floor(Date.now() / 1000);
    const r = db
      .query(
        `UPDATE epics SET status = 'done', completed_at = $now
         WHERE id = $id AND status != 'done'`,
      )
      .run({ $now: now, $id: parentEpicKanbanId });
    if (r.changes === 0) {
      logger.warn(
        `dissolve-epic: parent EPIC row ${parentEpicKanbanId} not found or already done — no kanban update`,
      );
    } else {
      logger.log(`dissolve-epic: marked parent EPIC ${parentEpicKanbanId} done`);
    }
  } finally {
    closeDb(db);
  }
}

/**
 * Default cage teardown — runs ADR-087 `softStop` then `tmux kill-session`
 * against the child cage. No-op when the cage tmux server isn't running
 * (idempotent dissolve of an already-stopped epic-team).
 *
 * Best-effort: every step swallows failures so the outer dissolve pipeline
 * always reaches worktree-prune + cockpit-mutate. softStop failures are
 * intentionally non-fatal — the killSession that follows is the load-
 * bearing reap step; the manifest is forensic-only.
 */
export async function defaultCageTeardown(deps: {
  epicRoot: string;
  childTeam: TeamShape;
  tmuxFactory: (config: TmuxConfig) => TmuxNamespace;
  logger: { log: (m: string) => void; warn: (m: string) => void };
}): Promise<void> {
  const teamName = deps.childTeam.name;
  const socket = await resolveCageSocket(teamName, deps.epicRoot);
  const tmux = deps.tmuxFactory({ socketPath: socket });
  const sessionName = cageSessionName(teamName);

  // Probe — skip teardown when cage already down. Idempotent dissolve.
  let alive = false;
  try {
    alive = await tmux.session.hasSession(`=${sessionName}`);
  } catch {
    // Socket missing entirely — cage already gone.
    alive = false;
  }
  if (!alive) return;

  // softStop: notify + manifest + grace. Best-effort; killSession below
  // is the actual reap.
  try {
    await softStop({
      team: deps.childTeam,
      atmuxDir: join(deps.epicRoot, ".atmux"),
      sessionName,
      tmux,
      reason: "dissolve-epic",
    });
  } catch (e) {
    deps.logger.warn(
      `dissolve-epic: softStop step failed — proceeding to killSession (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  // killSession: graceful reap of the named session. May leave the
  // tmux *server* running if the cage somehow has sibling sessions
  // (rare). The killServer below is the load-bearing cleanup that
  // catches that residue too.
  try {
    await tmux.session.killSession(`=${sessionName}`);
  } catch {
    // Session may have died mid-softStop or socket may already be gone.
  }

  // killServer: cage tmux is single-purpose by ADR-018 design — one
  // cage = one server. Kill the whole server (not just the session)
  // so any stray sibling sessions + the socket file disappear in one
  // shot. This is what e-7a1014f9 §Fix #1 calls for: previously
  // dissolve-epic left 7+ panes alive even on the named session being
  // killed (the cage tmux server kept running). Net cost yesterday:
  // 18GB / 67 procs reaped manually by superdoctor across 8 orphans.
  try {
    await tmux.server.killServer();
  } catch {
    // Server may already be down (race vs killSession, or stale
    // socket). Target state (no tmux server on this cage socket)
    // achieved either way.
  }
}

/**
 * Delete the epic-team's branch from the parent repo when fully merged
 * into trunk. e-7a1014f9 §Fix #2 — closes the "merged-but-not-deleted"
 * residue class that accumulated 12+ branches in sopx before manual
 * cleanup.
 *
 * Behavior matrix:
 *   - Branch absent → no-op
 *   - Branch present + merged into parentBase → `git branch -D` it
 *   - Branch present + unmerged + skipChecks=true → skip + warn
 *     (operator rescue path: --skip-checks dissolves the cage but
 *     preserves the unmerged commits on the branch for forensics)
 *   - Branch present + unmerged + skipChecks=false → unreachable
 *     in normal flow (assertPreflightGates would have refused);
 *     still safe to skip with warn.
 *
 * Best-effort: every step swallows failures + logs warn so the outer
 * dissolve pipeline always completes.
 */
export async function deleteMergedEpicBranch(deps: {
  parentRoot: string;
  parentBase: string;
  epicId: string;
  skipChecks: boolean;
  git: GitSpawn;
  logger: { log: (m: string) => void; warn: (m: string) => void };
}): Promise<void> {
  const branch = `${deps.parentBase}-epic-${deps.epicId}`;

  // Probe — does the branch exist at all? Uses `git -C <root>` so the
  // command targets the parent repo regardless of the caller's cwd.
  let branchExists = false;
  try {
    const r = await deps.git([
      "-C",
      deps.parentRoot,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    branchExists = r.exitCode === 0;
  } catch {
    branchExists = false;
  }
  if (!branchExists) return;

  // Probe — is it fully merged into parentBase?
  let merged = false;
  try {
    const r = await deps.git([
      "-C",
      deps.parentRoot,
      "merge-base",
      "--is-ancestor",
      branch,
      deps.parentBase,
    ]);
    merged = r.exitCode === 0;
  } catch {
    merged = false;
  }

  if (!merged) {
    deps.logger.warn(
      `dissolve-epic: branch '${branch}' has unmerged commits — preserving for operator rescue (manual delete via: git -C ${deps.parentRoot} branch -D ${branch})`,
    );
    return;
  }

  // Merged — safe to delete.
  try {
    await deps.git(["-C", deps.parentRoot, "branch", "-D", branch]);
    deps.logger.log(`dissolve-epic: deleted merged branch '${branch}'`);
  } catch (e) {
    deps.logger.warn(
      `dissolve-epic: branch delete failed for '${branch}' (${e instanceof Error ? e.message : String(e)}) — manual: git -C ${deps.parentRoot} branch -D ${branch}`,
    );
  }
}

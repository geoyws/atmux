// ADR-091 §State machine: epic-merge tick CLI verb.
//
// `atmux epic-merge tick [--team-dir <path>]` — one-shot cron entry-
// point that runs a single state-machine tick for the current
// epic-team. Composes the epic-team's kanban + git probes into the
// `EpicMergeContext` shape and dispatches `performEpicMerge`
// (`src/core/epic-merge.ts`).
//
// Designed to be invoked from cron (per-epic-team cron block emitted
// by `cron.ts` when `team.epicTeam !== undefined`). Bare invocation
// outside cron also works — the verb is idempotent on an unchanged
// state.db row + clean git tree.
//
// Sister verb to `atmux gitter --sweep` (ADR-134 T4 intra-team
// sweep). Both consume the same MergerStateRepo + branch-merge-state
// shared module; the epic-merge tick is single-row-per-invocation
// (one row per epic-team, since the epic-team has one shared branch
// per ADR-090 §Decision-anchor #3) where the gitter sweep iterates
// the whole team's per-member-branch fanout.
//
// Out of scope (v1): cross-epic batch ticks (one verb run per epic-
// team is the cron contract); pr-mode runtime (deferred per ADR-090
// §Decision-anchor #6 — verb still validates pr-mode configs and
// short-circuits at `ready_to_merge`); auto-dispatch of `dissolve-
// epic --auto` lands as a stderr log until T9 (`t-b430b185`) ships
// the verb.

import { join } from "node:path";
import { closeDatabase, type Database, openDatabase } from "../abstractions/sqlite.ts";
import { migrations } from "../abstractions/sqlite-migrations.ts";
import { defaultGitSpawn, type GitSpawn } from "../abstractions/worktree.ts";
import type { PreMergeGateInput } from "../core/branch-merge-state.ts";
import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import {
  type EpicMergeContext,
  type PerformEpicMergeResult,
  performEpicMerge,
} from "../core/epic-merge.ts";
import { MergerStateRepo } from "../core/repositories/merger-state-repo.ts";
import { createLogger, type Logger } from "../core/tui.ts";
import { UsageError } from "../errors.ts";
import { dissolveEpic } from "./team/dissolve-epic.ts";

const USAGE = "atmux epic-merge tick [--team-dir <path>]";

// ---------- Arg parsing ----------

export interface ParsedEpicMergeArgs {
  /** Only `tick` ships in v1. Future sub-verbs (e.g. `status` for
   *  read-only state-row inspection, `force-conflict-reset` for
   *  operator manual recovery) would land here. */
  subverb: "tick";
  /** Override the team-dir for `requireTeam` (test injection +
   *  cross-team operator invocation). */
  teamDir?: string;
}

/** Pure parser. Throws `UsageError` on bad invocation. */
export function parseEpicMergeArgs(argv: ReadonlyArray<string>): ParsedEpicMergeArgs {
  let subverb: "tick" | undefined;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "tick" || a === "--tick") {
      subverb = "tick";
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined || v === "") {
        throw new UsageError({
          what: "epic-merge: --team-dir requires a value",
          hint: USAGE,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    if (a?.startsWith("-") === true) {
      throw new UsageError({
        what: `epic-merge: unknown flag: ${a}`,
        hint: USAGE,
      });
    }
    throw new UsageError({
      what: `epic-merge: unexpected arg: ${a}`,
      hint: USAGE,
    });
  }
  if (subverb === undefined) {
    throw new UsageError({
      what: "epic-merge: no sub-verb specified",
      hint: USAGE,
    });
  }
  const out: ParsedEpicMergeArgs = { subverb };
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

// ---------- Verb dependencies (test injection) ----------

export interface EpicMergeOpts {
  logger?: Logger;
  git?: GitSpawn;
  openDb?: (path: string) => Database;
  closeDb?: (db: Database) => void;
  /** Test injection — override the gate-fact resolver. Production
   *  default reads kanban + runs git probes. Tests pin a fixed
   *  {@link PreMergeGateInput} + signoff bool to drive deterministic
   *  state-machine ticks. */
  resolveGate?: (deps: {
    db: Database;
    epicRepoPath: string;
    parentRepoPath: string;
    parentBase: string;
    git: GitSpawn;
  }) => Promise<{
    gate: PreMergeGateInput;
    hasReviewerTrunkSignoff: boolean;
  }>;
  /** Test injection — override the parent-repo path resolver. */
  resolveParentRepo?: (epicRepoPath: string) => string;
}

// ---------- Top-level dispatch ----------

export async function epicMerge(
  argv: ReadonlyArray<string>,
  opts: EpicMergeOpts = {},
): Promise<number> {
  const parsed = parseEpicMergeArgs(argv);
  switch (parsed.subverb) {
    case "tick":
      return await epicMergeTickVerb(parsed, opts);
  }
}

// ---------- Tick sub-verb ----------

/** Run one state-machine tick for the current epic-team. Returns 0
 *  on success (including no-op ticks when the team isn't an epic-
 *  team or when the gate held). Non-zero only on hard errors
 *  (USAGE / config-load failures propagate via thrown errors per the
 *  standard verb contract). */
export async function epicMergeTickVerb(
  parsed: ParsedEpicMergeArgs,
  opts: EpicMergeOpts = {},
): Promise<number> {
  const logger = opts.logger ?? createLogger();
  const git = opts.git ?? defaultGitSpawn;
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const resolveGate = opts.resolveGate ?? defaultResolveGate;
  const resolveParentRepo = opts.resolveParentRepo ?? defaultResolveParentRepo;

  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const team = await requireTeam(dirOpts);
  const atmuxDir = await getAtmuxDir(dirOpts);

  // Honor the ADR-090 epic-team gate: bare invocation against a
  // normal team is a fast no-op + log + exit 0 (matches gitter
  // --sweep's `autoMerge.enabled !== true` posture).
  if (team.epicTeam === undefined) {
    logger.log(`epic-merge tick: team '${team.name}' has no epicTeam block — no-op`);
    return 0;
  }
  const epicTeam = team.epicTeam;

  // Derive the epic-team's root (cwd-of-team) + parent repo path.
  // ADR-090 §Decision-anchor #2 fixes the disk layout sibling
  // convention (`<projectRoot>-epics/<epicId>/`); resolveParentRepo
  // applies the inverse transform.
  const epicRepoPath = atmuxDir.endsWith("/.atmux")
    ? atmuxDir.slice(0, -"/.atmux".length)
    : join(atmuxDir, "..");
  const parentRepoPath = resolveParentRepo(epicRepoPath);

  // The epic-team's branch is `<parentBase>-epic-<epicId>` per
  // ADR-090 §Disk layout. We don't synthesize the name from
  // `<parentBase>-epic-<team.name>` because the spawn-epic verb
  // (T9 t-b430b185) is the canonical naming authority — it writes
  // the synthesized branch to the team's worktree at provision
  // time. For v1 (cron-tick BEFORE T9 lands), we read the worktree's
  // current branch via `git -C <epicRepoPath> rev-parse --abbrev-ref
  // HEAD`. Once T9 lands, an explicit `team.epicTeam.branch`
  // schema field would replace this probe — out of scope here.
  const epicBranch = await currentBranch(epicRepoPath, git);

  const db = openDb(join(atmuxDir, "state.db"));
  try {
    const repo = new MergerStateRepo(db);
    // Resolve gate facts from kanban + git.
    const { gate, hasReviewerTrunkSignoff } = await resolveGate({
      db,
      epicRepoPath,
      parentRepoPath,
      parentBase: epicTeam.parentBase,
      git,
    });
    const ctx: EpicMergeContext = {
      epicBranch,
      parentBase: epicTeam.parentBase,
      parentRepoPath,
      gate,
      hasReviewerTrunkSignoff,
      mergeMode: epicTeam.mergeMode,
      epicId: epicTeam.parentEpicKanbanId,
      repo,
      git,
      by: "epic-cron",
      // ADR-090↔ADR-091 wire-up (t-9a8b0e4e): on `merging → merged`
      // success, invoke the dissolve-epic verb directly. The cron-fired
      // auto-merger IS the legitimate dispatcher per ADR-091 state
      // machine, so `callerScope: "driver"` is injected at the call-
      // site rather than relying on the cron's ATMUX_CALLER_SCOPE env.
      // Production default per t-9a8b0e4e Task body — operator can
      // still dissolve manually if this fails (the merger_state.note
      // carries the merge SHA + epicId for traceability).
      dispatchDissolve: defaultDispatchDissolve,
    };
    const result = await performEpicMerge(ctx);
    logTickResult(result, logger, team.name, epicTeam.parentBase);
    return 0;
  } finally {
    closeDb(db);
  }
}

// ---------- Default gate resolver ----------

/** Production default — pulls gate facts from the epic-team's kanban
 *  (via the open Database handle) + per-branch git probes. The
 *  signature mirrors {@link EpicMergeOpts.resolveGate} so test
 *  injections drop in cleanly. */
async function defaultResolveGate(deps: {
  db: Database;
  epicRepoPath: string;
  parentRepoPath: string;
  parentBase: string;
  git: GitSpawn;
}): Promise<{
  gate: PreMergeGateInput;
  hasReviewerTrunkSignoff: boolean;
}> {
  // 1. ownerOpenTaskCount — count Tasks NOT in `done` state. The
  // epic-team's kanban lives at `<epicRepoPath>/.atmux/state.db` —
  // the same DB handle the verb opened above (caller passed it in).
  const openTasksRow = deps.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done', 'wontfix')`,
    )
    .get();
  const ownerOpenTaskCount = openTasksRow?.n ?? 0;

  // 2. hasReviewerTrunkSignoff — is there a done Task with
  // role='reviewer-trunk-signoff'? §Decision-anchor #1 + #5.
  // `role` lives in the `extra` JSON column (NOT a top-level column on
  // the tasks table) per kanban schema; use json_extract. Pre-fix this
  // query threw "no such column: role" on every epic-team signoff probe,
  // breaking ADR-091 auto-merge fan-in (t-b2d9c955, observed against
  // e-99280c63 dissolve 2026-05-17).
  const signoffRow = deps.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE status = 'done' AND json_extract(extra, '$.role') = 'reviewer-trunk-signoff'`,
    )
    .get();
  const hasReviewerTrunkSignoff = (signoffRow?.n ?? 0) > 0;

  // 3. worktreeIsClean — `git -C parentRepoPath status --porcelain`
  // empty? Run on PARENT's worktree because that's where the merge
  // lands; an unclean parent would refuse the merge regardless of
  // the epic-team's own cleanliness. GitSpawn is cwd-less; use
  // `-C <path>` argv form to scope.
  const cleanResult = await deps.git(["-C", deps.parentRepoPath, "status", "--porcelain"]);
  const worktreeIsClean = cleanResult.exitCode === 0 && cleanResult.stdout.trim() === "";

  // 4. isAheadOfBase — does the epic-team's worktree have commits
  // not yet on parentBase? Run on epic-team's worktree (where the
  // epic-team's branch HEAD lives).
  const aheadResult = await deps.git([
    "-C",
    deps.epicRepoPath,
    "rev-list",
    "--count",
    `${deps.parentBase}..HEAD`,
  ]);
  const aheadCount = parseInt(aheadResult.stdout.trim(), 10);
  const isAheadOfBase = aheadResult.exitCode === 0 && Number.isFinite(aheadCount) && aheadCount > 0;

  // 5. baseHasMoved — has parentBase advanced past the merge-base?
  // `git merge-base parentBase HEAD` returns the divergence point;
  // if that's NOT the same as parentBase's tip, parentBase moved.
  const mbResult = await deps.git(["-C", deps.epicRepoPath, "merge-base", deps.parentBase, "HEAD"]);
  const baseTipResult = await deps.git(["-C", deps.epicRepoPath, "rev-parse", deps.parentBase]);
  const mbSha = mbResult.stdout.trim();
  const baseTipSha = baseTipResult.stdout.trim();
  const baseHasMoved =
    mbResult.exitCode === 0 &&
    baseTipResult.exitCode === 0 &&
    mbSha.length > 0 &&
    baseTipSha.length > 0 &&
    mbSha !== baseTipSha;

  return {
    gate: {
      ownerOpenTaskCount,
      worktreeIsClean,
      isAheadOfBase,
      baseHasMoved,
    },
    hasReviewerTrunkSignoff,
  };
}

// ---------- Default parent-repo resolver ----------

/** Production default — derives parent's repo path from the epic-
 *  team's repo path via the ADR-090 §Decision-anchor #2 sibling
 *  layout convention: `<projectRoot>-epics/<epicId>/` ⇒ parent at
 *  `<projectRoot>`. Throws if the path doesn't match the layout
 *  (operator's `team.json` has gone non-canonical or the verb is
 *  invoked outside an epic-team's worktree).
 *
 *  Example: `/root/work/ifca/src/sopx-epics/checkout-flow` ⇒
 *           `/root/work/ifca/src/sopx`. */
function defaultResolveParentRepo(epicRepoPath: string): string {
  // Strip trailing slash for stable basename math.
  const trimmed = epicRepoPath.replace(/\/$/, "");
  // Two levels up: epicRepoPath → epicsDir → grandparent.
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    throw new Error(
      `epic-merge: cannot derive parent repo from epicRepoPath '${epicRepoPath}' — path too shallow`,
    );
  }
  const epicsDir = trimmed.slice(0, lastSlash);
  const epicsDirSlash = epicsDir.lastIndexOf("/");
  if (epicsDirSlash < 0) {
    throw new Error(
      `epic-merge: cannot derive parent repo from epicRepoPath '${epicRepoPath}' — epicsDir has no parent`,
    );
  }
  const epicsBasename = epicsDir.slice(epicsDirSlash + 1);
  if (!epicsBasename.endsWith("-epics")) {
    throw new Error(
      `epic-merge: epicRepoPath '${epicRepoPath}' parent dir '${epicsBasename}' does not end with '-epics' (ADR-090 §Decision-anchor #2 violation)`,
    );
  }
  const parentBasename = epicsBasename.slice(0, -"-epics".length);
  const grandparent = epicsDir.slice(0, epicsDirSlash);
  return `${grandparent}/${parentBasename}`;
}

// ---------- Default current-branch resolver ----------

async function currentBranch(repoPath: string, git: GitSpawn): Promise<string> {
  const r = await git(["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (r.exitCode !== 0) {
    throw new Error(
      `epic-merge: failed to read HEAD branch at ${repoPath} (exit ${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}

// ---------- ADR-090↔ADR-091 dispatch hook (t-9a8b0e4e) ----------

/** Production default for {@link EpicMergeContext.dispatchDissolve}.
 *  Invokes the dissolve-epic verb directly with `callerScope: "driver"`
 *  injected — the cron-fired auto-merger IS the legitimate dispatcher
 *  per ADR-091's state machine, so the ATMUX_CALLER_SCOPE env is
 *  bypassed at the call-site.
 *
 *  Wraps the call in try/catch so any throw from dissolveEpic (caller-
 *  scope refusal, missing cockpit entry, dirty-worktree refuse) returns
 *  `false` rather than propagating — the merge ALREADY succeeded; the
 *  dissolve gap is operator-recoverable. The error reason is surfaced
 *  via stderr (cron log capture) by {@link tryDispatchDissolve}'s
 *  catch block, so the failure stays visible without aborting the
 *  cron tick. */
async function defaultDispatchDissolve(epicId: string, by: string): Promise<boolean> {
  const rc = await dissolveEpic([epicId], {
    callerScope: () => "driver",
    // Default logger writes to process.stderr — fits the cron log
    // capture path. The verb's success log ("epic-team dissolved: …")
    // joins the same stream as the tick result line.
    logger: {
      log: (m: string) => process.stderr.write(`${m}\n`),
      warn: (m: string) => process.stderr.write(`epic-merge[${by}] dissolve-epic warn: ${m}\n`),
    },
  });
  return rc === 0;
}

// ---------- Result logging ----------

function logTickResult(
  result: PerformEpicMergeResult,
  logger: Logger,
  teamName: string,
  parentBase: string,
): void {
  const verdict = result.changed ? "advanced" : "no-op";
  const sha = result.mergedSha !== undefined ? ` sha=${result.mergedSha}` : "";
  const dispatched = result.dissolveDispatched ? " dissolve-dispatched" : "";
  logger.log(
    `epic-merge tick: team='${teamName}' parentBase='${parentBase}' state='${result.state}' ${verdict}${sha}${dispatched} reason='${result.reason}'`,
  );
}

// ADR-170 §`sweep-epics` verb.
//
// `atmux team sweep-epics [--apply] [--idle-hours N] [--parent <team>] [--json]`
//
// Walks every enabled epic-team in cockpit.json, classifies each by
// activity, and (with --apply) dissolves SAFE-DISSOLVE candidates via
// the existing ADR-090 `dissolveEpic` pipeline.
//
// Verdict ladder (ADR-170 §Verdict ladder):
//   - DRAIN          → open tasks > 0; keep
//   - SAFE-DISSOLVE  → 0 open tasks AND worktree clean AND branch
//                      pushed to origin; dissolved with --apply
//   - STALE-IDLE     → 0 open tasks AND last commit >= idle-hours AND
//                      branch NOT pushed; reported only — operator
//                      must push or investigate first
//   - RISKY          → worktree dirty OR unmerged commits not on
//                      origin; reported only
//   - MISSING        → cockpit entry but worktree directory absent;
//                      reported only
//
// Composition only. Reuses loadCockpit + enabledTeams (cockpit walk),
// defaultGitSpawn (push/dirty checks), openDatabase (task counts),
// dissolveEpic (the --apply path). No new infrastructure.

import { join } from "node:path";
import { exists } from "../../abstractions/fs.ts";
import type { SpawnResult } from "../../abstractions/spawn.ts";
import { closeDatabase, type Database, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import { defaultGitSpawn, type GitSpawn, isWorktreeDirty } from "../../abstractions/worktree.ts";
import { enabledTeams, type LoadedCockpit, loadCockpit } from "../../core/cockpit.ts";
import { UsageError } from "../../errors.ts";
import { type DissolveEpicOpts, dissolveEpic } from "./dissolve-epic.ts";

const USAGE = "atmux team sweep-epics [--apply] [--idle-hours N] [--parent <team>] [--json]";

// ---------- Arg parsing ----------

export interface ParsedSweepEpicsArgs {
  apply: boolean;
  idleHours: number;
  parent?: string;
  json: boolean;
}

export function parseSweepEpicsArgs(argv: ReadonlyArray<string>): ParsedSweepEpicsArgs {
  let apply = false;
  let idleHours = 24;
  let parent: string | undefined;
  let json = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--apply") {
      apply = true;
      i += 1;
      continue;
    }
    if (a === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (a === "--idle-hours") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "sweep-epics: --idle-hours requires a value", hint: USAGE });
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError({
          what: `sweep-epics: --idle-hours expects positive integer, got '${v}'`,
          hint: USAGE,
        });
      }
      idleHours = n;
      i += 2;
      continue;
    }
    if (a === "--parent") {
      const v = argv[i + 1];
      if (v === undefined || v.length === 0) {
        throw new UsageError({ what: "sweep-epics: --parent requires a value", hint: USAGE });
      }
      parent = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `sweep-epics: unexpected arg: ${a}`, hint: USAGE });
  }
  const out: ParsedSweepEpicsArgs = { apply, idleHours, json };
  if (parent !== undefined) out.parent = parent;
  return out;
}

// ---------- Verdict shape ----------

export type EpicVerdictKind = "DRAIN" | "SAFE-DISSOLVE" | "STALE-IDLE" | "RISKY" | "MISSING";

export interface EpicVerdict {
  epicId: string;
  parent: string;
  parentRoot: string;
  epicRoot: string;
  verdict: EpicVerdictKind;
  openTasks: number;
  lastCommitHoursAgo: number | null;
  worktreeClean: boolean;
  branchPushed: boolean;
  reason: string;
}

// ---------- Verb dependencies ----------

export interface SweepEpicsOpts {
  git?: GitSpawn;
  loadCockpitFn?: () => Promise<LoadedCockpit>;
  openDb?: (path: string) => Database;
  closeDb?: (db: Database) => void;
  /** Test seam — defaults to ADR-090 dissolveEpic. */
  dissolve?: (argv: ReadonlyArray<string>, opts: DissolveEpicOpts) => Promise<number>;
  /** Test seam — defaults to fs.exists. */
  pathExists?: (p: string) => Promise<boolean>;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
  /** Test seam — defaults to console.log. */
  logger?: { log: (m: string) => void };
}

// ---------- Top-level dispatch ----------

export async function sweepEpics(
  argv: ReadonlyArray<string>,
  opts: SweepEpicsOpts = {},
): Promise<number> {
  const parsed = parseSweepEpicsArgs(argv);
  const git = opts.git ?? defaultGitSpawn;
  const load = opts.loadCockpitFn ?? (() => loadCockpit());
  const openDb = opts.openDb ?? ((p: string) => openDatabase(p, migrations));
  const closeDb = opts.closeDb ?? closeDatabase;
  const dissolve = opts.dissolve ?? dissolveEpic;
  const pathExists = opts.pathExists ?? exists;
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? { log: (m: string) => process.stdout.write(`${m}\n`) };

  const cockpit = await load();
  const epicEntries = enabledTeams(cockpit).filter((e) => e.type === "epic-team");

  const verdicts: EpicVerdict[] = [];
  for (const entry of epicEntries) {
    if (entry.type !== "epic-team") continue;
    // FlattenedTeamEntry types parent + epicId as optional even on
    // epic-team rows; in practice loadCockpit guarantees both. Skip
    // any malformed row defensively.
    if (entry.parent === undefined || entry.epicId === undefined) continue;
    if (parsed.parent !== undefined && entry.parent !== parsed.parent) continue;
    verdicts.push(
      await classifyEpic(entry.epicId, entry.parent, entry.root, {
        git,
        openDb,
        closeDb,
        pathExists,
        now,
        idleHours: parsed.idleHours,
      }),
    );
  }

  if (parsed.json) {
    logger.log(JSON.stringify({ idleHours: parsed.idleHours, verdicts }, null, 2));
  } else {
    logger.log(renderTable(verdicts, parsed.idleHours));
  }

  if (!parsed.apply) return 0;

  const candidates = verdicts.filter((v) => v.verdict === "SAFE-DISSOLVE");
  if (candidates.length === 0) {
    logger.log("\n# sweep-epics: --apply found no SAFE-DISSOLVE candidates");
    return 0;
  }
  logger.log(`\n# sweep-epics: --apply dissolving ${candidates.length} epic-team(s)`);
  for (const c of candidates) {
    logger.log(`> dissolve-epic ${c.epicId} (parent=${c.parent})`);
    const rc = await dissolve([c.epicId], {});
    if (rc !== 0) {
      logger.log(`! dissolve-epic ${c.epicId} failed with exit ${rc} — aborting sweep`);
      return rc;
    }
  }
  return 0;
}

// ---------- Per-epic classification ----------

interface ClassifyDeps {
  git: GitSpawn;
  openDb: (path: string) => Database;
  closeDb: (db: Database) => void;
  pathExists: (p: string) => Promise<boolean>;
  now: () => number;
  idleHours: number;
}

async function classifyEpic(
  epicId: string,
  parent: string,
  parentRoot: string,
  deps: ClassifyDeps,
): Promise<EpicVerdict> {
  // Canonical epic-team worktree: <parentRoot>-epics/<epicId> per ADR-090.
  const canonicalEpicRoot = `${parentRoot}-epics/${epicId}`;

  const base: EpicVerdict = {
    epicId,
    parent,
    parentRoot,
    epicRoot: canonicalEpicRoot,
    verdict: "MISSING",
    openTasks: 0,
    lastCommitHoursAgo: null,
    worktreeClean: false,
    branchPushed: false,
    reason: "",
  };

  if (!(await deps.pathExists(canonicalEpicRoot))) {
    base.reason = `worktree absent at ${canonicalEpicRoot}`;
    return base;
  }

  // 1. Open-tasks count from the epic-team's own kanban.
  const dbPath = join(canonicalEpicRoot, ".atmux", "state.db");
  let openTasks = 0;
  if (await deps.pathExists(dbPath)) {
    const db = deps.openDb(dbPath);
    try {
      const row = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done', 'wontfix')`,
        )
        .get();
      openTasks = row?.n ?? 0;
    } catch {
      // tasks table may be absent on a partially-bootstrapped epic-team;
      // treat as 0 open tasks (errs toward DRAIN-via-empty-kanban →
      // STALE-IDLE classification downstream, which is read-only).
      openTasks = 0;
    } finally {
      deps.closeDb(db);
    }
  }
  base.openTasks = openTasks;

  // 2. Last commit + worktree-clean + branch-pushed via git.
  const lastCommitHoursAgo = await readLastCommitHoursAgo(canonicalEpicRoot, deps.git, deps.now);
  base.lastCommitHoursAgo = lastCommitHoursAgo;
  base.worktreeClean = !(await isWorktreeDirty(canonicalEpicRoot, { git: deps.git }));
  base.branchPushed = await isBranchPushed(canonicalEpicRoot, deps.git);

  // 3. Verdict ladder per ADR-170 §Verdict ladder.
  if (openTasks > 0) {
    base.verdict = "DRAIN";
    base.reason = `${openTasks} open task(s)`;
    return base;
  }
  if (!base.worktreeClean) {
    base.verdict = "RISKY";
    base.reason = "worktree dirty — manual review";
    return base;
  }
  if (base.branchPushed) {
    base.verdict = "SAFE-DISSOLVE";
    base.reason = "0 open tasks · clean · pushed";
    return base;
  }
  if (lastCommitHoursAgo !== null && lastCommitHoursAgo >= deps.idleHours) {
    base.verdict = "STALE-IDLE";
    // ADR-209 §1 — a 0-ahead branch surfaces the no-progress sentinel; report
    // it as "never progressed" rather than the misleading literal hour count.
    base.reason =
      lastCommitHoursAgo === NO_BRANCH_PROGRESS_SENTINEL_HOURS
        ? "0 open tasks · no branch-local commits since spawn · NOT pushed"
        : `0 open tasks · ${lastCommitHoursAgo}h since last commit · NOT pushed`;
    return base;
  }
  base.verdict = "RISKY";
  base.reason = "0 open tasks · NOT pushed · recently active";
  return base;
}

/**
 * Explicit "no branch-local progress" sentinel per ADR-209 §1. A branch
 * with 0 commits past its merge-base with trunk has shipped nothing since
 * spawn; reporting the trunk merge-base's recent date (Bug 1) mislabels it
 * as freshly active. The sentinel is large enough to always exceed any
 * `--idle-hours` value, so the verdict ladder classifies a 0-ahead branch
 * as STALE-IDLE (idle, never progressed) rather than "recently active".
 */
export const NO_BRANCH_PROGRESS_SENTINEL_HOURS = 99999;

/**
 * Last-commit age in hours, measured against the branch's own commits — not
 * the branch tip (ADR-209 §1, Bug 1). Counts commits the epic branch carries
 * past its merge-base with trunk via `git rev-list --count <trunk>..<branch>`;
 * 0 means no work since spawn and returns the no-progress sentinel.
 *
 * The trunk reference is derived from the epic branch name
 * (`<parentBase>-epic-<epicId>` per ADR-090): strip the `-epic-…` suffix to
 * recover `<parentBase>`, then prefer `origin/<parentBase>` (matches ADR-209
 * §Evidence) falling back to a local `<parentBase>` ref. When neither trunk
 * ref resolves (non-conventional branch / detached HEAD), fall back to the
 * branch-tip date so the metric still reports something.
 */
async function readLastCommitHoursAgo(
  repo: string,
  git: GitSpawn,
  now: () => number,
): Promise<number | null> {
  const branchR = await git(["-C", repo, "branch", "--show-current"]);
  const branch = branchR.exitCode === 0 ? branchR.stdout.trim() : "";

  const trunk = branch === "" ? null : await resolveTrunkRef(repo, branch, git);
  if (trunk !== null) {
    const countR = await git(["-C", repo, "rev-list", "--count", `${trunk}..${branch}`]);
    if (countR.exitCode === 0) {
      const commitsAhead = Number.parseInt(countR.stdout.trim(), 10);
      if (Number.isFinite(commitsAhead) && commitsAhead === 0) {
        return NO_BRANCH_PROGRESS_SENTINEL_HOURS;
      }
      // N-ahead → age of the most recent branch-local commit in range.
      const rangeR = await git(["-C", repo, "log", "-1", "--format=%ct", `${trunk}..${branch}`]);
      const hours = commitAgeHours(rangeR, now);
      if (hours !== null) return hours;
    }
  }

  // Fallback — no resolvable trunk; report branch-tip date as before.
  const tipR = await git(["-C", repo, "log", "-1", "--format=%ct"]);
  return commitAgeHours(tipR, now);
}

/** Parse a `git log -1 --format=%ct` result into whole hours since `now`. */
function commitAgeHours(r: SpawnResult, now: () => number): number | null {
  if (r.exitCode !== 0) return null;
  const trimmed = r.stdout.trim();
  if (trimmed === "") return null;
  const epochSec = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(epochSec)) return null;
  return Math.floor((now() / 1000 - epochSec) / 3600);
}

/**
 * Resolve the trunk ref an epic branch was forked from. Epic branches are
 * `<parentBase>-epic-<epicId>` (ADR-090); strip the `-epic-…` suffix to
 * recover `<parentBase>`, then probe `origin/<parentBase>` then the local
 * `<parentBase>`. Returns the first ref that `git rev-parse --verify`
 * accepts, or null when the branch is not epic-conventional / no trunk ref
 * exists.
 */
async function resolveTrunkRef(
  repo: string,
  branch: string,
  git: GitSpawn,
): Promise<string | null> {
  const marker = branch.lastIndexOf("-epic-");
  if (marker <= 0) return null;
  const parentBase = branch.slice(0, marker);
  if (parentBase === "") return null;
  for (const candidate of [`origin/${parentBase}`, parentBase]) {
    const verifyR = await git(["-C", repo, "rev-parse", "--verify", "--quiet", candidate]);
    if (verifyR.exitCode === 0 && verifyR.stdout.trim() !== "") return candidate;
  }
  return null;
}

async function isBranchPushed(repo: string, git: GitSpawn): Promise<boolean> {
  // Branch tip exists on origin = `origin/<branch>` resolves to the same
  // sha (or an ancestor — push-safety means our commits survive).
  const branchR = await git(["-C", repo, "branch", "--show-current"]);
  if (branchR.exitCode !== 0) return false;
  const branch = branchR.stdout.trim();
  if (branch === "") return false;
  const headR = await git(["-C", repo, "rev-parse", "HEAD"]);
  if (headR.exitCode !== 0) return false;
  const head = headR.stdout.trim();
  const ancestorR = await git(["-C", repo, "merge-base", "--is-ancestor", head, `origin/${branch}`]);
  return ancestorR.exitCode === 0;
}

// ---------- Rendering ----------

function renderTable(verdicts: ReadonlyArray<EpicVerdict>, idleHours: number): string {
  const lines: string[] = [];
  lines.push(`# sweep-epics — ${verdicts.length} epic-team(s) · idle-hours=${idleHours}`);
  lines.push("");
  lines.push("| verdict | parent | epicId | open | last-commit | clean | pushed | reason |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const v of verdicts) {
    const age =
      v.lastCommitHoursAgo === null
        ? "?"
        : v.lastCommitHoursAgo === NO_BRANCH_PROGRESS_SENTINEL_HOURS
          ? "none"
          : `${v.lastCommitHoursAgo}h`;
    lines.push(
      `| ${v.verdict} | ${v.parent} | ${v.epicId} | ${v.openTasks} | ${age} | ${v.worktreeClean ? "y" : "n"} | ${v.branchPushed ? "y" : "n"} | ${v.reason} |`,
    );
  }
  const safe = verdicts.filter((v) => v.verdict === "SAFE-DISSOLVE").length;
  const stale = verdicts.filter((v) => v.verdict === "STALE-IDLE").length;
  const risky = verdicts.filter((v) => v.verdict === "RISKY").length;
  const drain = verdicts.filter((v) => v.verdict === "DRAIN").length;
  const missing = verdicts.filter((v) => v.verdict === "MISSING").length;
  lines.push("");
  lines.push(
    `Summary: ${safe} SAFE-DISSOLVE · ${stale} STALE-IDLE · ${risky} RISKY · ${drain} DRAIN · ${missing} MISSING`,
  );
  if (safe > 0) {
    lines.push("Run with --apply to dissolve the SAFE-DISSOLVE candidates.");
  }
  return lines.join("\n");
}

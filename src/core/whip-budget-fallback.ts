// ADR-058 §D6: whip-tier-fallback integration helpers.
//
// Pause-entry: snapshot in-flight Tasks, pick highest-tier executor with
// available capacity, createFallbackCage + paste entry brief into the cage
// tmux, persist cage handles to `.atmux/state/fallback-cages-<epoch>.json`
// for resume-tick discovery.
//
// Resume-tick: load the handles file, compose a continuity brief per cage,
// destroy the cage (archives the workspace per OQ3), paste the brief to
// the original Claude member's pane, delete the handles file.
//
// This module is the orchestration layer between
// `src/core/whip-budget-check.ts::enterPause/exitPause` (which decide WHEN
// to fire) and `src/abstractions/fallback-cage.ts` (which knows HOW to
// build/teardown a per-tier cage). The verb layer
// (`src/verbs/whip.ts::runBudgetTickCheck`) wires the project cwd + send
// dependency + kanban-listing dependency into the BudgetCheckDeps; this
// module receives them via injection.
//
// Default-OFF safety: callers must check `team.fallback?.enabled` BEFORE
// invoking dispatch — this module is unconditional once entered. The
// `team.fallback` block is undefined for pre-ADR-058 teams, so the
// existing budget-pause path is unchanged for them.

import { join } from "node:path";
import { atomicWrite, readTextOrNull, removeFile } from "../abstractions/fs.ts";
import {
  type CageHandle,
  composeTier2Brief,
  composeTier3Brief,
  composeTier4Brief,
  createFallbackCage as defaultCreateFallbackCage,
  destroyFallbackCage as defaultDestroyFallbackCage,
  type FallbackTier,
  FallbackUserMissingError,
  Tier4NotAvailableError,
} from "../abstractions/fallback-cage.ts";
import type { KanbanTask } from "../schema/kanban.ts";

// ---------- Public types ----------

/** Persistent shape of `.atmux/state/fallback-cages-<epoch>.json`. */
export interface FallbackCagesFile {
  /** Epoch seconds at pause-entry; matches the filename suffix. */
  epoch: number;
  /** Owning team — symmetry / sanity-check on read. */
  team: string;
  /** One handle per cage created during this pause cycle. */
  cages: CageHandle[];
}

export interface DispatchFallbackOpts {
  readonly team: string;
  readonly atmuxDir: string;
  readonly projectCwd: string;
  /** Epoch seconds at pause-entry — keys the handles-file name. */
  readonly pausedAtSec: number;
  /** Tasks to delegate; one cage per task. Caller filters to status="in-progress". */
  readonly inFlightTasks: ReadonlyArray<KanbanTask>;
  /** Required: paste a brief into the cage's tmux pane. The handle carries
   *  socket + tmpdir + session + window + agent so the impl can build the
   *  right tmux invocation (operator-UID for Tier 2, sudo -u for Tier 3+). */
  readonly sendBrief: (handle: CageHandle, body: string) => Promise<void>;
  /** Tier-preference override. Defaults to [2, 3, 4] per ADR-058 §D2. */
  readonly tierPreference?: ReadonlyArray<FallbackTier>;
  /** Inject in tests. */
  readonly createCage?: typeof defaultCreateFallbackCage;
  readonly log?: (msg: string) => void;
}

export interface WalkFallbackOpts {
  readonly team: string;
  readonly atmuxDir: string;
  /** Epoch seconds at pause-entry — identifies which handles-file to walk. */
  readonly pausedAtSec: number;
  /** Required: paste continuity brief to original Claude member's pane. */
  readonly sendContinuity: (member: string, body: string) => Promise<void>;
  /** Inject in tests. */
  readonly destroyCage?: typeof defaultDestroyFallbackCage;
  readonly log?: (msg: string) => void;
}

// ---------- Constants ----------

/** Default tier-preference per ADR-058 §D2: try the most-capable tier
 *  first; cascade to lower tiers if unavailable. Tier 2 (Cursor) has the
 *  best ergonomics (full git in operator UID). Tier 3 (Kimi) is kernel-
 *  isolated. Tier 4 (MiniMax) is a stub until the CLI is GA per OQ6. */
const DEFAULT_TIER_PREFERENCE: ReadonlyArray<FallbackTier> = [2, 3, 4];

// ---------- Path helpers ----------

/** Resolve the cages-file path for a given pause-cycle epoch. */
export function fallbackCagesPath(atmuxDir: string, epochSec: number): string {
  return join(atmuxDir, "state", `fallback-cages-${epochSec}.json`);
}

// ---------- Pause-entry hook ----------

/**
 * Snapshot in-flight Tasks → cascade through tier preference → create
 * cage + paste entry brief → persist handles to `fallback-cages-<epoch>.json`.
 *
 * Per-task best-effort: a tier failure for one task doesn't abort siblings.
 * Returns the cages actually created + persisted.
 *
 * Empty inFlightTasks → no-op (no handles file written).
 */
export async function dispatchFallbackOnPause(
  opts: DispatchFallbackOpts,
): Promise<CageHandle[]> {
  const create = opts.createCage ?? defaultCreateFallbackCage;
  const log = opts.log ?? ((): void => {});
  const tiers = opts.tierPreference ?? DEFAULT_TIER_PREFERENCE;

  const cages: CageHandle[] = [];

  for (const task of opts.inFlightTasks) {
    // Lane resolution: prefer task.lane (planner-set), fall back to owner
    // (member name — matches the cage-tmux session naming convention),
    // last resort the task id (always non-empty).
    const lane = nonEmpty(task.lane) ?? nonEmpty(task.owner) ?? task.id;
    const taskBody = task.body ?? task.subject ?? "";

    const handle = await tryCreateCascade({
      tiers,
      team: opts.team,
      lane,
      taskId: task.id,
      atmuxDir: opts.atmuxDir,
      projectCwd: opts.projectCwd,
      create,
      log,
    });
    if (handle === null) {
      log(`whip: fallback: no tier available for ${task.id} — skipped`);
      continue;
    }

    const brief = composeBrief(handle.tier, {
      team: opts.team,
      lane,
      taskId: task.id,
      taskBody,
      agent: handle.agent,
      workDir: handle.workDir,
    });
    try {
      await opts.sendBrief(handle, brief);
    } catch (e) {
      log(`whip: fallback: brief send failed for ${task.id}: ${stringifyErr(e)}`);
    }

    cages.push(handle);
  }

  if (cages.length > 0) {
    const file: FallbackCagesFile = {
      epoch: opts.pausedAtSec,
      team: opts.team,
      cages,
    };
    await atomicWrite(
      fallbackCagesPath(opts.atmuxDir, opts.pausedAtSec),
      JSON.stringify(file),
    );
  }

  return cages;
}

// ---------- Resume-tick hook ----------

/**
 * Load `fallback-cages-<epoch>.json` → per cage compose continuity brief
 * → destroy cage (archives workspace per OQ3) → paste brief to original
 * Claude member → delete the handles file.
 *
 * Idempotent: handles-file absence is fine (no-op). Per-cage failures
 * don't abort siblings; the handles file is removed at the end so a
 * partial walk doesn't loop on next tick.
 */
export async function walkFallbackOnResume(opts: WalkFallbackOpts): Promise<void> {
  const destroy = opts.destroyCage ?? defaultDestroyFallbackCage;
  const log = opts.log ?? ((): void => {});

  const path = fallbackCagesPath(opts.atmuxDir, opts.pausedAtSec);
  const txt = await readTextOrNull(path);
  if (txt === null) return;

  let parsed: FallbackCagesFile;
  try {
    parsed = JSON.parse(txt) as FallbackCagesFile;
  } catch {
    log(`whip: fallback-resume: handles file corrupt at ${path} — removing`);
    await removeFile(path);
    return;
  }
  if (!Array.isArray(parsed.cages)) {
    log(`whip: fallback-resume: handles file malformed at ${path} — removing`);
    await removeFile(path);
    return;
  }

  for (const handle of parsed.cages) {
    const brief = composeContinuityBrief(handle);
    try {
      // Original Claude member is identified by the cage's lane (lane
      // string was either task.lane (planner-set) or task.owner (member
      // name) at dispatch time — both are valid `atmux send` targets).
      await opts.sendContinuity(handle.lane, brief);
    } catch (e) {
      log(
        `whip: fallback-resume: continuity send for ${handle.taskId} failed: ${stringifyErr(e)}`,
      );
    }
    try {
      await destroy(handle, { atmuxDir: opts.atmuxDir });
    } catch (e) {
      log(
        `whip: fallback-resume: destroy cage for ${handle.taskId} failed: ${stringifyErr(e)}`,
      );
    }
  }

  await removeFile(path);
}

// ---------- Internals ----------

interface CascadeOpts {
  tiers: ReadonlyArray<FallbackTier>;
  team: string;
  lane: string;
  taskId: string;
  atmuxDir: string;
  projectCwd: string;
  create: typeof defaultCreateFallbackCage;
  log: (msg: string) => void;
}

/** Walk tier preference; first successful create wins. Recoverable errors
 *  (Tier4NotAvailableError, FallbackUserMissingError) cascade to the
 *  next tier; non-recoverable errors stop the cascade for this task. */
async function tryCreateCascade(opts: CascadeOpts): Promise<CageHandle | null> {
  for (const tier of opts.tiers) {
    try {
      const handle = await opts.create({
        team: opts.team,
        lane: opts.lane,
        tier,
        taskId: opts.taskId,
        atmuxDir: opts.atmuxDir,
        projectCwd: opts.projectCwd,
      });
      return handle;
    } catch (e) {
      opts.log(
        `whip: fallback: tier ${tier} unavailable for ${opts.taskId}: ${stringifyErr(e)}`,
      );
      if (e instanceof Tier4NotAvailableError) continue;
      if (e instanceof FallbackUserMissingError) continue;
      // Unknown errors halt the cascade — surfaces operator misconfig
      // (e.g. rsync missing, sudo password prompt) instead of masking
      // by trying every tier.
      return null;
    }
  }
  return null;
}

/** Per-tier brief composer dispatch. */
function composeBrief(
  tier: FallbackTier,
  opts: {
    team: string;
    lane: string;
    taskId: string;
    taskBody: string;
    agent: CageHandle["agent"];
    workDir: string;
  },
): string {
  switch (tier) {
    case 2:
      return composeTier2Brief(opts);
    case 3:
      return composeTier3Brief(opts);
    case 4:
      return composeTier4Brief(opts);
  }
}

/**
 * Continuity brief composer — minimal v1 stub. Surfaces tier + workDir +
 * the appropriate reconcile path. Once the planner-tracked T3 helper
 * (`src/core/fallback-resume.ts::composeResumeBrief`) lands on this
 * branch, swap this for its richer composer.
 */
function composeContinuityBrief(handle: CageHandle): string {
  const reconcileLine =
    handle.tier === 2
      ? `Tier 2 (Cursor) ran in your worktree — its commits land directly. Check \`git log\` for new SHAs since pause.`
      : `Tier ${handle.tier} (${handle.agent}) wrote files into \`${handle.workDir}\`. Run \`scripts/fallback-reconcile.sh ${handle.team} ${handle.lane}\` to diff + bring them in.`;
  return [
    `# 🟢 budget-pause cleared — fallback continuity`,
    ``,
    `Task: \`${handle.taskId}\``,
    `Lane: \`${handle.lane}\``,
    `Cage: Tier ${handle.tier} (${handle.agent}) at \`${handle.workDir}\``,
    ``,
    reconcileLine,
    ``,
    `Pick up from where you paused. The cage tmux session has been torn down.`,
  ].join("\n");
}

function nonEmpty(v: string | null | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

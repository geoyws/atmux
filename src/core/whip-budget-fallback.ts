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
import { atomicWrite, readTextOrNull, removeFile } from "../abstractions/fs.ts";
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
export async function dispatchFallbackOnPause(opts: DispatchFallbackOpts): Promise<CageHandle[]> {
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
    await atomicWrite(fallbackCagesPath(opts.atmuxDir, opts.pausedAtSec), JSON.stringify(file));
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
      log(`whip: fallback-resume: continuity send for ${handle.taskId} failed: ${stringifyErr(e)}`);
    }
    try {
      await destroy(handle, { atmuxDir: opts.atmuxDir });
    } catch (e) {
      log(`whip: fallback-resume: destroy cage for ${handle.taskId} failed: ${stringifyErr(e)}`);
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
      opts.log(`whip: fallback: tier ${tier} unavailable for ${opts.taskId}: ${stringifyErr(e)}`);
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

// ============================================================
// ADR-050 §Decision — v1 narrow wrappers (Tier 2 Cursor only)
// ============================================================
//
// Layered on top of the ADR-058 multi-tier dispatch above. The v1
// wrappers provide:
//
//   - `spawnFallbackCage` / `teardownFallbackCage` — single-member
//     entry points (vs ADR-058's multi-task cascade dispatch).
//   - Defense-in-depth tier=2 refusal at the call-site (the schema
//     layer `team.whip.fallback.tier: z.literal(2)` is the first
//     fence; this is the second).
//   - `shouldDispatchFallback` — pure trigger evaluator returning the
//     3-condition ADR-050 §Trigger semantics result with a
//     suppress-reason tag for whip.ts logging.
//   - Per-member persistent handle file `fallback-cages-v1.json`
//     (distinct from the ADR-058 epoch-suffixed multi-cage file —
//     v1 callers persist long-lived single-cage-per-member handles
//     across whip ticks until budget resumes).
//
// ADR-058's `dispatchFallbackOnPause` / `walkFallbackOnResume`
// remain on the broader cascade path; the v1 wrappers don't deprecate
// them. Once ADR-050b folds Tier 3+ back in, the v1 wrappers' tier
// literal lifts; until then they're the narrow opt-in entry path.
//
// Reads `team.whip.fallback.*` per ADR-050 (NOT `team.fallback` —
// that's the ADR-058 multi-tier config at the top-level Team
// schema, distinct from the v1 nested location).

import { exists } from "../abstractions/fs.ts";
import type { Team } from "../schema/team.ts";

// ---------- Public types (ADR-050 v1) ----------

/** ADR-050 v1 Tier guard. Only Tier 2 is supported in v1; Tier 3+ is
 *  deferred to ADR-050b. The literal type pins the supported tier at
 *  compile time; the call-site refuses any other runtime value with
 *  `Tier3PlusNotSupportedError`. */
export type SupportedFallbackTier = 2;
export const SUPPORTED_FALLBACK_TIER: SupportedFallbackTier = 2;

/** Default schema values — match `TeamWhip.fallback.*` defaults. */
export const DEFAULT_FALLBACK_SUSTAIN_MIN = 30;
export const MIN_FALLBACK_SUSTAIN_MIN = 5;
export const DEFAULT_CURSOR_MODEL = "composer-2";

/** Thrown when `spawnFallbackCage` / `teardownFallbackCage` is called
 *  with a tier !== 2. Belt+suspenders with the schema's
 *  `z.literal(2)` — if a caller builds opts manually (bypassing
 *  schema validation) and tries to operate on a Tier 3+ cage, the
 *  runtime check still refuses. */
export class Tier3PlusNotSupportedError extends Error {
  readonly tier: number;
  constructor(tier: number) {
    super(
      `whip-budget-fallback v1: tier=${tier} not supported (ADR-050 v1 — ` +
        "only Tier 2 Cursor is in scope). Tier 3+ deferred to ADR-050b — " +
        "use ADR-058 `dispatchFallbackOnPause` cascade for broader tier " +
        "support, or edit team.whip.fallback.tier to 2.",
    );
    this.name = "Tier3PlusNotSupportedError";
    this.tier = tier;
  }
}

/** Pure-trigger evaluation result. Caller (whip.ts) logs the
 *  suppress reason on each tick when `dispatch === false`. */
export interface ShouldDispatchResult {
  /** True when ALL three ADR-050 §Trigger semantics conditions hold. */
  dispatch: boolean;
  /** When `dispatch === false`, the first failed condition (in
   *  evaluation order). Used for whip's log line. */
  reason?:
    | "tier-not-supported"
    | "fallback-disabled"
    | "sustain-not-reached"
    | "no-in-progress-tasks";
}

export interface ShouldDispatchOpts {
  /** Team config — reads `whip.fallback.{enabled,sustainMins,tier}`. */
  readonly team: Team;
  /** Minutes the budget-pause has been continuously active. Caller
   *  (whip.ts) tracks the pause-start epoch and computes this each
   *  tick. */
  readonly pauseSustainedMin: number;
  /** Count of in-progress Tasks claimed by the paused member. Zero
   *  → idle member → no cage. */
  readonly inProgressTaskCount: number;
}

export interface SpawnFallbackCageOpts {
  readonly team: Team;
  readonly atmuxDir: string;
  readonly projectCwd: string;
  /** Member name (matches team.members[].name). */
  readonly member: string;
  /** Task id (the in-progress Task being delegated to the fallback
   *  cage). Threaded through to the abstraction's `createFallbackCage`
   *  for brief context. */
  readonly taskId: string;
  /** Optional pre-composed brief. If provided, piped to the cage's
   *  tmux pane after spawn via `tmux send-keys`. If omitted, no
   *  brief is sent — caller wires brief delivery separately
   *  (out-of-scope T3 brief generator integration / T4 whip
   *  trigger wiring). */
  readonly brief?: string;
}

export interface SpawnFallbackCageDeps {
  readonly createCage?: typeof defaultCreateFallbackCage;
  /** Brief delivery hook — invoked iff `opts.brief` is supplied AND
   *  this dep is provided. V1 module defers the actual tmux env-
   *  threading to the caller (T3 brief generator + T4 whip trigger
   *  own the per-tier tmux invocation shape: operator-UID for Tier 2,
   *  sudo -u for Tier 3+ when ADR-050b folds in). Pattern mirrors
   *  ADR-058's `dispatchFallbackOnPause.sendBrief` required-callback —
   *  v1 just makes it optional since this single-member entry path
   *  may be invoked from a brief-less context (e.g. a unit test of
   *  the lifecycle alone). */
  readonly sendBrief?: (handle: CageHandle, body: string) => Promise<void>;
  readonly log?: (msg: string) => void;
  readonly nowSec?: () => number;
}

export interface TeardownFallbackCageOpts {
  readonly team: Team;
  readonly atmuxDir: string;
  readonly member: string;
}

export interface TeardownFallbackCageDeps {
  readonly destroyCage?: typeof defaultDestroyFallbackCage;
  readonly log?: (msg: string) => void;
  readonly nowSec?: () => number;
}

/** Persistent shape of `<atmuxDir>/state/fallback-cages-v1.json`.
 *  Keyed by `<team>:<member>` — one cage handle per paused member,
 *  long-lived across whip ticks until budget resumes. Distinct from
 *  ADR-058's epoch-suffixed multi-cage file. */
export interface FallbackCagesFileV1 {
  /** Schema version — bumps on incompatible shape changes. v1 is the
   *  shape this commit lands. */
  schemaVersion: 1;
  /** Active cages keyed by `<team>:<member>`. */
  cages: Record<string, CageHandle>;
}

// ---------- ADR-050 v1: config reader ----------

/** Read `team.whip.fallback.*` with v1 defaults. Centralised so the
 *  trigger evaluator + spawn + teardown share the same resolution
 *  logic. */
function readFallbackV1Config(team: Team): {
  enabled: boolean;
  sustainMins: number;
  tier: number;
  cursorModel: string;
} {
  const fb = (team.whip as { fallback?: unknown } | undefined)?.fallback as
    | {
        enabled?: boolean;
        sustainMins?: number;
        tier?: number;
        cursorModel?: string;
      }
    | undefined;
  return {
    enabled: fb?.enabled ?? false,
    sustainMins: fb?.sustainMins ?? DEFAULT_FALLBACK_SUSTAIN_MIN,
    tier: fb?.tier ?? SUPPORTED_FALLBACK_TIER,
    cursorModel: fb?.cursorModel ?? DEFAULT_CURSOR_MODEL,
  };
}

// ---------- ADR-050 v1: path helpers ----------

/** Resolve the v1 cages-file path (per-member key, long-lived). */
export function fallbackCagesPathV1(atmuxDir: string): string {
  return join(atmuxDir, "state", "fallback-cages-v1.json");
}

/** Stable cage handle key — `<team>:<member>`. Used by v1 persistence
 *  to dedupe across whip ticks + multi-team setups. */
export function cageKeyV1(team: string, member: string): string {
  return `${team}:${member}`;
}

function emptyCagesFileV1(): FallbackCagesFileV1 {
  return { schemaVersion: 1, cages: {} };
}

// ---------- ADR-050 v1: trigger semantics ----------

/**
 * Pure trigger evaluator per ADR-050 §Trigger semantics. Returns
 * `{ dispatch: true }` ONLY when all three conditions hold (in
 * evaluation order):
 *
 *   1. `team.whip.fallback.tier === 2`  (v1 supports Tier 2 only)
 *   2. `team.whip.fallback.enabled === true`
 *   3. `pauseSustainedMin >= sustainMins` (default 30)
 *   4. `inProgressTaskCount >= 1`
 *
 * Tier check is evaluated FIRST so a misconfigured tier value
 * surfaces with the most-actionable reason (vs. masking under
 * "disabled" / "sustain-not-reached").
 */
export function shouldDispatchFallback(opts: ShouldDispatchOpts): ShouldDispatchResult {
  const cfg = readFallbackV1Config(opts.team);

  if (cfg.tier !== SUPPORTED_FALLBACK_TIER) {
    return { dispatch: false, reason: "tier-not-supported" };
  }
  if (!cfg.enabled) {
    return { dispatch: false, reason: "fallback-disabled" };
  }
  if (opts.pauseSustainedMin < cfg.sustainMins) {
    return { dispatch: false, reason: "sustain-not-reached" };
  }
  if (opts.inProgressTaskCount === 0) {
    return { dispatch: false, reason: "no-in-progress-tasks" };
  }
  return { dispatch: true };
}

// ---------- ADR-050 v1: cages-file IO ----------

/** Read the v1 cages file. Graceful degrade on missing / malformed.
 *  Worst case re-spawn-on-already-running is benign (the
 *  abstraction's `createFallbackCage` is idempotent at the tmux
 *  level). */
export async function readCagesFileV1(atmuxDir: string): Promise<FallbackCagesFileV1> {
  const text = await readTextOrNull(fallbackCagesPathV1(atmuxDir));
  if (text === null || text === "") return emptyCagesFileV1();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "cages" in parsed &&
      typeof (parsed as { cages: unknown }).cages === "object" &&
      (parsed as { cages: unknown }).cages !== null &&
      !Array.isArray((parsed as { cages: unknown }).cages)
    ) {
      return {
        schemaVersion: 1,
        cages: (parsed as { cages: Record<string, CageHandle> }).cages,
      };
    }
  } catch {
    // Malformed — return empty.
  }
  return emptyCagesFileV1();
}

/** Atomic write of the v1 cages file. */
export async function writeCagesFileV1(
  atmuxDir: string,
  file: FallbackCagesFileV1,
): Promise<void> {
  await atomicWrite(fallbackCagesPathV1(atmuxDir), `${JSON.stringify(file, null, 2)}\n`);
}

// ---------- ADR-050 v1: spawn wrapper ----------

/**
 * Spawn a Tier 2 fallback cage for a member. Wraps the abstraction's
 * `createFallbackCage` with ADR-050 v1 narrowing:
 *
 *   - Refuses tier !== 2 at the call-site (defense-in-depth — the
 *     schema's `z.literal(2)` is the first fence).
 *   - Persists handle to `fallback-cages-v1.json` for resume-tick
 *     discovery (single-file, per-member keyed; distinct from
 *     ADR-058's epoch-suffixed multi-cage file).
 *   - If `brief` is supplied, pipes it via `tmux send-keys` to the
 *     cage's pane after spawn. Otherwise no brief is sent (caller
 *     wires it separately — out-of-scope T3 brief generator).
 *
 * Idempotent: if a handle for `<team>:<member>` already exists in
 * the v1 cages file, returns the existing handle without
 * re-spawning. The abstraction's `createFallbackCage` is itself
 * idempotent at the tmux level (the existing tmux server + session
 * are detected + reused), so a spawn-on-already-running is safe even
 * if the cages file is stale.
 */
export async function spawnFallbackCage(
  opts: SpawnFallbackCageOpts,
  deps: SpawnFallbackCageDeps = {},
): Promise<CageHandle> {
  const cfg = readFallbackV1Config(opts.team);
  if (cfg.tier !== SUPPORTED_FALLBACK_TIER) {
    throw new Tier3PlusNotSupportedError(cfg.tier);
  }

  const log = deps.log ?? ((): void => {});
  const create = deps.createCage ?? defaultCreateFallbackCage;
  const key = cageKeyV1(opts.team.name, opts.member);

  // Idempotence at the persistence layer.
  const file = await readCagesFileV1(opts.atmuxDir);
  const existing = file.cages[key];
  if (existing !== undefined) {
    log(`whip-budget-fallback v1: cage already active for ${key} — returning existing handle`);
    return existing;
  }

  // v1 lane resolution: member name as lane suffix. Keeps the cage
  // tmpdir name human-readable + makes the member↔cage mapping
  // obvious from `ls /tmp/atmux_fallback_*`.
  const lane = opts.member;

  const handle = await create({
    team: opts.team.name,
    lane,
    tier: SUPPORTED_FALLBACK_TIER as FallbackTier,
    taskId: opts.taskId,
    atmuxDir: opts.atmuxDir,
    projectCwd: opts.projectCwd,
  });

  // Optional brief delivery — delegated to the caller-supplied
  // `sendBrief` dep. V1 doesn't thread tmux env (TMUX_TMPDIR per
  // ADR-018) for the per-tier socket invocation; T3 brief generator +
  // T4 whip trigger wire that up around this module's spawn. If
  // `brief` is provided but `sendBrief` is not, log + continue —
  // caller can re-send via the returned handle.
  if (opts.brief !== undefined && opts.brief !== "") {
    if (deps.sendBrief !== undefined) {
      try {
        await deps.sendBrief(handle, opts.brief);
      } catch (e) {
        // Best-effort: brief failure doesn't kill the cage.
        log(`whip-budget-fallback v1: sendBrief failed for ${key}: ${stringifyErr(e)}`);
      }
    } else {
      log(
        `whip-budget-fallback v1: brief supplied for ${key} but no sendBrief dep — brief deferred to caller`,
      );
    }
  }

  // Persist handle.
  file.cages[key] = handle;
  await writeCagesFileV1(opts.atmuxDir, file);

  return handle;
}

// ---------- ADR-050 v1: teardown wrapper ----------

/**
 * Teardown a Tier 2 fallback cage for a member. Idempotent at every
 * layer:
 *
 *   - Missing handle in v1 cages file → no-op (return without error).
 *   - Missing cage tmux server → no-op via abstraction's idempotent
 *     `destroyFallbackCage`.
 *   - Handles file removed after the last cage is torn down (keeps
 *     `state/` clean).
 *
 * Refuses tier !== 2 even on teardown — defense-in-depth against a
 * stale Tier 3+ handle landing in the v1 file (e.g. a future
 * ADR-050b dual-mode rollout that's not yet ready).
 */
export async function teardownFallbackCage(
  opts: TeardownFallbackCageOpts,
  deps: TeardownFallbackCageDeps = {},
): Promise<void> {
  const log = deps.log ?? ((): void => {});
  const destroy = deps.destroyCage ?? defaultDestroyFallbackCage;
  const key = cageKeyV1(opts.team.name, opts.member);

  const file = await readCagesFileV1(opts.atmuxDir);
  const handle = file.cages[key];
  if (handle === undefined) {
    log(`whip-budget-fallback v1: no active cage for ${key} — teardown no-op`);
    return;
  }

  if (handle.tier !== SUPPORTED_FALLBACK_TIER) {
    throw new Tier3PlusNotSupportedError(handle.tier);
  }

  try {
    await destroy(handle, { atmuxDir: opts.atmuxDir });
  } catch (e) {
    log(`whip-budget-fallback v1: destroyCage failed for ${key}: ${stringifyErr(e)}`);
    // Continue — still remove the handle from the file so the next
    // teardown isn't blocked by a dead cage.
  }

  delete file.cages[key];
  if (Object.keys(file.cages).length === 0) {
    // Clean up the file when no cages remain.
    if (await exists(fallbackCagesPathV1(opts.atmuxDir))) {
      await removeFile(fallbackCagesPathV1(opts.atmuxDir));
    }
  } else {
    await writeCagesFileV1(opts.atmuxDir, file);
  }
}

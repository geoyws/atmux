// ADR-055 §D2 R1-T8 part 4: cursor self-heal whip-tick orchestration.
//
// Wires the recipe contract (`src/core/cursor-recipes/types.ts`) +
// invokeCursor abstraction (`src/abstractions/cursor.ts`) + Discord
// templates (`src/abstractions/discord.ts`) + 24h dedup state
// (`src/core/cursor-self-heal-state.ts`) into a single per-tick pass.
//
// Per ADR-055 §D2 the pass runs AFTER per-member checks AND AFTER the
// budget-pause check (never invoke cursor during budget-pause). The
// caller (src/verbs/whip.ts::runTick) gates the call; this module is
// budget-pause-agnostic and assumes the caller decided to fire.
//
// Per-recipe flow:
//   detect → recent? skip → propose → invokeCursor → verify
//     → ok ? stagePatchForReviewer + result-success ping
//          : flag P2 + result-failure ping
//
// stagePatchForReviewer writes the patch to `.atmux/state/cursor-
// self-heal-pending/<recipe>-<ts>.patch` AND creates a kanban Task
// addressed to the team's `reviewer` member with the patch path in
// the body. Reviewer applies (or rejects) via existing flow.
//
// Failure posture: the orchestrator NEVER throws. Every per-recipe
// failure is captured in the run summary; cursor-binary-missing
// degrades gracefully (cursor.ts returns exitCode != 0; verify
// rejects; flag raised). This matches CLAUDE.md's "degrade
// gracefully" rule for non-critical observability layers.

import { join } from "node:path";
import {
  type CursorInvokeResult,
  invokeCursor as defaultInvokeCursor,
} from "../abstractions/cursor.ts";
import {
  type DiscordSendOpts,
  renderWhipSelfHealAttempt,
  renderWhipSelfHealResult,
} from "../abstractions/discord.ts";
import { atomicWrite, ensureDir } from "../abstractions/fs.ts";
import type {
  CursorJob,
  CursorRecipe,
  GitPatch,
  WhipTickContextForRecipe,
} from "./cursor-recipes/types.ts";
import {
  isRecentSelfHeal,
  loadSelfHealState,
  recordSelfHealFire,
  writeSelfHealState,
} from "./cursor-self-heal-state.ts";
import { addTask } from "./kanban.ts";

// ---------- Path helpers ----------

/** Directory holding staged patches awaiting reviewer-gate. */
export function pendingPatchDir(atmuxDir: string): string {
  return join(atmuxDir, "state", "cursor-self-heal-pending");
}

/** Per-recipe-fire patch path: `<atmuxDir>/state/cursor-self-heal-
 *  pending/<recipeId-sanitized>-<epochSec>.patch`. The recipe id is
 *  sanitized (`fix:team-json-schema-drift` → `fix-team-json-schema-
 *  drift`) so the path is filesystem-safe across all platforms. */
export function pendingPatchPath(atmuxDir: string, recipeId: string, nowSec: number): string {
  return join(pendingPatchDir(atmuxDir), `${sanitizeRecipeId(recipeId)}-${nowSec}.patch`);
}

/** Per-recipe-fire log path: `<atmuxDir>/logs/cursor-self-heal-
 *  <recipeId-sanitized>-<epochSec>.log`. Mirrors `pendingPatchPath`
 *  shape; lives under `/logs/` so groom can age-out per ADR-055
 *  OQ-5 follow-up. */
export function selfHealLogPath(atmuxDir: string, recipeId: string, nowSec: number): string {
  return join(atmuxDir, "logs", `cursor-self-heal-${sanitizeRecipeId(recipeId)}-${nowSec}.log`);
}

function sanitizeRecipeId(id: string): string {
  return id.replace(/:/g, "-").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ---------- stagePatchForReviewer ----------

export interface StagePatchOpts {
  atmuxDir: string;
  recipeId: string;
  patch: GitPatch;
  patchSummary: string;
  nowSec: number;
  /** Reviewer member name (typically "reviewer"). The dispatched task
   *  is pre-assigned to this member. */
  reviewerName: string;
  /** Recipe context summary (the recipe's `detect` reason) — included
   *  in the dispatched task body for operator triage. */
  reason: string;
  /** Test injection — defaults to `kanban.addTask`. */
  addTaskFn?: (
    atmuxDir: string,
    opts: {
      subject: string;
      body?: string;
      assignee?: string;
      priority?: number;
    },
  ) => Promise<string>;
}

export interface StagePatchResult {
  /** Absolute filesystem path the patch was written to. */
  patchPath: string;
  /** Generated kanban Task id pointing the reviewer at the patch. */
  taskId: string;
}

/**
 * Write the patch to `.atmux/state/cursor-self-heal-pending/...` and
 * dispatch a kanban Task to the reviewer member. Returns `{patchPath,
 * taskId}` for inclusion in the success-ping bullet.
 *
 * Patch persistence is `atomicWrite`-backed (tmp + rename); kanban
 * mutation is `addTask`-backed (single-writer flock). Both operations
 * are idempotent in their own right but the COMBINED operation is not
 * — caller's 24h dedup (isRecentSelfHeal) must gate this so the same
 * recipe doesn't stage two patches per dedup window.
 *
 * The dispatched Task carries P2 priority (operator-triage urgency,
 * not blocking demo). `subject` mentions the recipe id; `body`
 * embeds the patch path + reason + a 1-line operator hint.
 */
export async function stagePatchForReviewer(opts: StagePatchOpts): Promise<StagePatchResult> {
  const addFn = opts.addTaskFn ?? addTask;

  // 1. Persist patch to disk.
  await ensureDir(pendingPatchDir(opts.atmuxDir));
  const patchPath = pendingPatchPath(opts.atmuxDir, opts.recipeId, opts.nowSec);
  await atomicWrite(patchPath, opts.patch.diff);

  // 2. Dispatch kanban Task pointing reviewer at the patch.
  const subject = `cursor self-heal review: ${opts.recipeId}`;
  const body = [
    `Cursor self-heal proposed a patch for recipe \`${opts.recipeId}\`.`,
    "",
    `Reason: ${opts.reason}`,
    `Patch: ${patchPath}`,
    `Summary: ${opts.patchSummary}`,
    "",
    "Apply via `git apply <patch>` (or reject if shape is wrong) + commit",
    "with a conventional message. The recipe's allowlist is enforced",
    "at verify-time, so the patch should only touch in-scope files.",
  ].join("\n");
  const taskId = await addFn(opts.atmuxDir, {
    subject,
    body,
    assignee: opts.reviewerName,
    priority: 2,
  });

  return { patchPath, taskId };
}

// ---------- Run pass orchestrator ----------

export interface SelfHealRunOpts {
  atmuxDir: string;
  /** Project root (passed to recipe `propose` + `cursor-agent --cwd`). */
  projectCwd: string;
  /** Epoch seconds — for log/patch filenames + dedup state stamping. */
  nowSec: number;
  /** Team name — for Discord header rendering. */
  teamName: string;
  /** Tmux session name — for `fix:supervisor-missing`-style recipes. */
  sessionName?: string;
  /** Reviewer member name (the dispatched stage-patch task's assignee). */
  reviewerName: string;
  /** All known recipes. The orchestrator filters by `enabledRecipeIds`
   *  before invoking; unknown ids in `enabledRecipeIds` are logged
   *  + skipped (no fail). */
  recipes: ReadonlyArray<CursorRecipe>;
  /** Operator's enabled-recipe whitelist from team.json::whip.
   *  selfHealRecipes. */
  enabledRecipeIds: ReadonlyArray<string>;
  /** Discord send sink (matches `WhipTickCtx.send`). */
  send: (opts: DiscordSendOpts) => Promise<void>;
  /** Per-recipe token-cap overrides from team.json::whip.
   *  selfHealTokenCaps. Optional; missing recipe id falls back to
   *  the recipe's default. */
  tokenCapOverrides?: Readonly<Record<string, number>>;
  /** Test injection — defaults to `cursor.invokeCursor`. */
  invokeCursorFn?: (
    job: CursorJob,
    invokeOpts?: { logPath?: string },
  ) => Promise<CursorInvokeResult>;
  /** Test injection — defaults to `kanban.addTask`. */
  addTaskFn?: StagePatchOpts["addTaskFn"];
  /** Test injection — defaults to a flag-write hook stub (the real
   *  flags subsystem isn't exposed here so failures are surfaced via
   *  the result-failure Discord ping; integrating with `flags add`
   *  is a later refinement once the flag surface stabilises). */
  raiseFlag?: (severity: "p2", body: string) => Promise<{ flagId: string }>;
  /** Operator log sink (defaults to no-op). */
  log?: (msg: string) => void;
}

/** Per-recipe outcome shape — useful for caller logging + tests. */
export type SelfHealOutcome =
  | "skipped-recent"
  | "skipped-no-detect"
  | "skipped-unknown-recipe"
  | "succeeded"
  | "failed-verify"
  | "failed-cursor"
  | "failed-stage";

export interface SelfHealRecipeResult {
  recipeId: string;
  outcome: SelfHealOutcome;
  /** Reasons (verify failures) or detail (skipped). */
  detail?: string;
}

export interface SelfHealRunSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: ReadonlyArray<SelfHealRecipeResult>;
}

/**
 * Run the self-heal pass for one whip-tick. Caller must have already
 * gated on `selfHealEnabled === true` AND budget-pause-not-active.
 *
 * Returns a structured summary; never throws. Per-recipe failures are
 * isolated — one recipe blowing up doesn't skip the rest.
 */
export async function runSelfHealPass(opts: SelfHealRunOpts): Promise<SelfHealRunSummary> {
  const log = opts.log ?? (() => {});
  const invokeCursor = opts.invokeCursorFn ?? defaultInvokeCursor;
  const tokenCapOverrides = opts.tokenCapOverrides ?? {};
  const results: SelfHealRecipeResult[] = [];

  // Build recipe-id → CursorRecipe map for O(1) lookup of enabled ids.
  const byId = new Map<string, CursorRecipe>();
  for (const r of opts.recipes) byId.set(r.id, r);

  // Load dedup state ONCE per pass; mutate in-memory; persist after
  // all recipes complete. This avoids N round-trips to disk.
  let state = await loadSelfHealState(opts.atmuxDir);
  let stateChanged = false;

  const whipCtx: WhipTickContextForRecipe = {
    atmuxDir: opts.atmuxDir,
    projectCwd: opts.projectCwd,
    nowSec: opts.nowSec,
    teamName: opts.teamName,
    ...(opts.sessionName !== undefined ? { sessionName: opts.sessionName } : {}),
  };

  for (const recipeId of opts.enabledRecipeIds) {
    const recipe = byId.get(recipeId);
    if (recipe === undefined) {
      log(`cursor-self-heal: unknown recipe '${recipeId}' — skipping`);
      results.push({
        recipeId,
        outcome: "skipped-unknown-recipe",
        detail: `recipe id '${recipeId}' not in registry`,
      });
      continue;
    }

    // ---- 24h dedup gate ----
    if (isRecentSelfHeal(state, recipeId, opts.nowSec)) {
      results.push({ recipeId, outcome: "skipped-recent" });
      continue;
    }

    // ---- detect ----
    let detectCtx: unknown;
    try {
      detectCtx = await recipe.detect(whipCtx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`cursor-self-heal: ${recipeId} detect threw: ${msg}`);
      results.push({
        recipeId,
        outcome: "skipped-no-detect",
        detail: `detect threw: ${msg}`,
      });
      continue;
    }
    if (detectCtx === null) {
      results.push({ recipeId, outcome: "skipped-no-detect" });
      continue;
    }

    // ---- propose ----
    let job: CursorJob;
    try {
      job = await recipe.propose(detectCtx, whipCtx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`cursor-self-heal: ${recipeId} propose threw: ${msg}`);
      results.push({
        recipeId,
        outcome: "failed-cursor",
        detail: `propose threw: ${msg}`,
      });
      continue;
    }

    // Apply per-recipe token-cap override.
    const overrideCap = tokenCapOverrides[recipeId];
    const resolvedCap =
      typeof overrideCap === "number" && overrideCap > 0 ? overrideCap : job.tokenCap;
    if (resolvedCap !== job.tokenCap) {
      job = { ...job, tokenCap: resolvedCap };
    }

    const reasonForPing = composeReason(detectCtx);

    // ---- attempt ping ----
    try {
      await opts.send(
        renderWhipSelfHealAttempt({
          team: opts.teamName,
          recipeId,
          reason: reasonForPing,
          tokenCap: resolvedCap,
        }),
      );
    } catch (e) {
      log(`cursor-self-heal: ${recipeId} attempt-ping failed: ${stringifyErr(e)}`);
      // Non-fatal — keep going.
    }

    // ---- invoke cursor ----
    const logPath = selfHealLogPath(opts.atmuxDir, recipeId, opts.nowSec);
    let cursorResult: CursorInvokeResult;
    try {
      cursorResult = await invokeCursor(job, { logPath });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`cursor-self-heal: ${recipeId} invokeCursor threw: ${msg}`);
      // Defensive — invokeCursor's contract says it never throws, but
      // a runtime bug shouldn't break the pass. Treat as cursor-fail.
      cursorResult = {
        exitCode: -1,
        stdout: "",
        stderr: msg,
        patch: { diff: "", files: [] },
        tokensUsed: -1,
        durationMs: 0,
      };
    }

    // ---- verify ----
    let verify: { ok: boolean; reasons: ReadonlyArray<string>; patchSummary: string };
    try {
      verify = await recipe.verify(job, cursorResult.patch, whipCtx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`cursor-self-heal: ${recipeId} verify threw: ${msg}`);
      verify = {
        ok: false,
        reasons: [`verify threw: ${msg}`],
        patchSummary: "verify threw exception",
      };
    }

    if (!verify.ok) {
      // Failure path: flag + result-failure ping.
      let flagId: string | null = null;
      if (opts.raiseFlag !== undefined) {
        try {
          const r = await opts.raiseFlag(
            "p2",
            `cursor self-heal verify failed: ${recipeId} (${verify.reasons[0] ?? "no reasons"})`,
          );
          flagId = r.flagId;
        } catch (e) {
          log(`cursor-self-heal: ${recipeId} raiseFlag failed: ${stringifyErr(e)}`);
        }
      }
      try {
        await opts.send(
          renderWhipSelfHealResult({
            team: opts.teamName,
            recipeId,
            ok: false,
            tokensUsed: cursorResult.tokensUsed,
            tokenCap: resolvedCap,
            patchSummary: verify.patchSummary,
            logPath,
            reasons: verify.reasons,
            flagSeverity: "p2",
          }),
        );
      } catch (e) {
        log(`cursor-self-heal: ${recipeId} fail-ping send failed: ${stringifyErr(e)}`);
      }
      // Record fire even on failure — keeps dedup honest (don't re-fire
      // a known-failing recipe every tick; operator must resolve before
      // 24h).
      state = recordSelfHealFire(state, recipeId, opts.nowSec);
      stateChanged = true;
      results.push({
        recipeId,
        outcome: "failed-verify",
        detail: verify.reasons[0] ?? verify.patchSummary,
      });
      void flagId;
      continue;
    }

    // ---- stage patch for reviewer ----
    let staged: StagePatchResult;
    try {
      const stageOpts: StagePatchOpts = {
        atmuxDir: opts.atmuxDir,
        recipeId,
        patch: cursorResult.patch,
        patchSummary: verify.patchSummary,
        nowSec: opts.nowSec,
        reviewerName: opts.reviewerName,
        reason: reasonForPing,
      };
      if (opts.addTaskFn !== undefined) stageOpts.addTaskFn = opts.addTaskFn;
      staged = await stagePatchForReviewer(stageOpts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`cursor-self-heal: ${recipeId} stagePatchForReviewer failed: ${msg}`);
      // Stage failure is rare (disk full / kanban locked); record fire
      // anyway to prevent thrash, surface via failure ping.
      try {
        await opts.send(
          renderWhipSelfHealResult({
            team: opts.teamName,
            recipeId,
            ok: false,
            tokensUsed: cursorResult.tokensUsed,
            tokenCap: resolvedCap,
            patchSummary: `stage failed: ${msg}`,
            logPath,
            reasons: [`stagePatchForReviewer failed: ${msg}`],
            flagSeverity: "p2",
          }),
        );
      } catch (sendErr) {
        log(`cursor-self-heal: ${recipeId} stage-fail-ping failed: ${stringifyErr(sendErr)}`);
      }
      state = recordSelfHealFire(state, recipeId, opts.nowSec);
      stateChanged = true;
      results.push({ recipeId, outcome: "failed-stage", detail: msg });
      continue;
    }

    // ---- success ping ----
    try {
      await opts.send(
        renderWhipSelfHealResult({
          team: opts.teamName,
          recipeId,
          ok: true,
          tokensUsed: cursorResult.tokensUsed,
          tokenCap: resolvedCap,
          patchSummary: verify.patchSummary,
          logPath,
        }),
      );
    } catch (e) {
      log(`cursor-self-heal: ${recipeId} success-ping failed: ${stringifyErr(e)}`);
    }

    state = recordSelfHealFire(state, recipeId, opts.nowSec);
    stateChanged = true;
    results.push({ recipeId, outcome: "succeeded", detail: staged.taskId });
  }

  if (stateChanged) {
    try {
      await writeSelfHealState(opts.atmuxDir, state);
    } catch (e) {
      log(`cursor-self-heal: persisting state failed: ${stringifyErr(e)}`);
      // Tradeoff: state-write failure means dedup memory is lost for
      // subsequent ticks within the next 24h, but the run-cycle
      // already completed — don't unwind.
    }
  }

  return summarize(results);
}

// ---------- Internals ----------

function summarize(results: ReadonlyArray<SelfHealRecipeResult>): SelfHealRunSummary {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let attempted = 0;
  for (const r of results) {
    if (r.outcome === "succeeded") {
      succeeded += 1;
      attempted += 1;
    } else if (
      r.outcome === "failed-verify" ||
      r.outcome === "failed-cursor" ||
      r.outcome === "failed-stage"
    ) {
      failed += 1;
      attempted += 1;
    } else {
      skipped += 1;
    }
  }
  return { attempted, succeeded, failed, skipped, results };
}

/** Compose a 1-line operator-readable reason for the attempt-ping
 *  bullet. Recipe contexts are heterogeneous (`unknown` per the
 *  type system); we extract a `reason` / `issues` count when present
 *  and otherwise stringify defensively. */
function composeReason(detectCtx: unknown): string {
  if (detectCtx === null || detectCtx === undefined) return "context unavailable";
  if (typeof detectCtx === "object") {
    const o = detectCtx as Record<string, unknown>;
    if (typeof o.reason === "string" && o.reason.length > 0) return o.reason;
    if (Array.isArray(o.issues)) return `${o.issues.length} issue(s) detected`;
  }
  return "recipe condition matched";
}

function stringifyErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

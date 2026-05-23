// ADR-229 + ADR-202 + ADR-203 + ADR-227 §Amendment 2026-05-23:
// orchd auto-push subscriber (Phase 6).
//
// Listens for `epic.merged` events (ADR-226 emit), runs 7 load-bearing
// safety gates IN CHEAPEST-FIRST ORDER, then invokes `git push origin
// <parentBase>` via an injected dispatcher. Emits `epic.pushed` on
// success, `epic.push-blocked` on Gate-{2,3a,3b,4,5,7} refusal, or
// `epic.push-conflict` on Gate-1 upstream-advanced refusal.
//
// **§Amendment 2026-05-23-rev2 fire order (FLAG-A swap)** per
// §DA9-rev1: 5 → 4 → 2 → 7 → 3a → 1 → 3b → push dispatcher.
// Cheapest gate first; cooldown-hit avoids paying subprocess cost.
//
// Module surface MIRRORS `src/core/gitter-consumer.ts` + `src/core/
// orchd-merge.ts` + `src/core/orchd-dissolve.ts` per ADR-229 §D4.
// Same `withIdempotency` wrapper, same `ATMUX_HONKER` kill-switch,
// same stubbed-default-with-injected-resolver pattern.
//
// **§D2.1 GREP DoD (reviewer-enforced)**:
//   - rg -nP '(--mirror|--all|--tags|--delete|--prune|--force|
//     --force-with-lease|--no-verify|forcePush)' src/core/orchd-push.ts
//     → MUST return ZERO hits (§DA-Gate-1 + FLAG-B `--no-verify`
//     extension).
//   - rg -nP '/-staging\$|\^main\$|\^master\$|\^production\$'
//     src/core/orchd-push.ts → MUST return ZERO hits (§DA-Gate-2
//     mandates `isPushAllowed` reuse from `src/core/auto-push.ts:47`;
//     no inline regex per §DA8).
//
// Reuses `isPushAllowed` from `src/core/auto-push.ts` (READ-ONLY
// import — DO NOT touch the file or extend STAGING_PATTERNS here per
// §DA8 single-source-of-truth invariant).
//
// Cross-refs: ADR-194 sibling auto-push (per-member-branch on
// `task.done`); ADR-028 main/master/production PR-only fleet
// invariant; CLAUDE.md global push policy (staging George-manual +
// `geoy.ws` allowlist carve-out).

import type { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { emit as defaultEmit, withIdempotency } from "../abstractions/events.ts";
import { isHonkerEnabled } from "../abstractions/honker.ts";
import type { EpicMergedPayload } from "../schema/events.ts";
import { isPushAllowed } from "./auto-push.ts";

// ---------- Outcomes + payloads ----------

/**
 * Outcome of a single orchd-push handler invocation. Per ADR-229 §D4.
 * The `escalated` total in {@link orchdPushConsume} counts only Gate-1
 * conflicts (i.e. outcome === "escalated"); the other `skipped-*`
 * outcomes advance offset without escalating.
 */
export type AutoPushOutcome =
  | "pushed"
  | "escalated"
  | "skipped-staging-base"
  | "skipped-not-opted-in"
  | "skipped-kill-switch"
  | "skipped-cooldown"
  | "skipped-preflight"
  | "skipped-honker-off"
  | "skipped-not-mine";

/** Gate IDs (semantic — stable cross-ADR refs per §DA9). */
export type GateId = "1" | "2" | "3a" | "3b" | "4" | "5" | "7";

/**
 * Result the injected git-push dispatcher returns. Distinguishes
 * push-conflict (Gate-1 upstream-advanced semantics) from other
 * dispatcher failures.
 */
export type DispatchGitPushResult =
  | { state: "pushed"; headSha: string; beforeSha?: string }
  | { state: "upstream-advanced"; ahead: number; behind: number; divergenceSha?: string }
  | { state: "skipped-not-mine"; reason?: string };

/** Minimal logger surface. */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const noopLog: Logger["info"] = () => {};
const NOOP_LOGGER: Logger = { info: noopLog, warn: noopLog, error: noopLog };

// ---------- Audit log (§DA-Gate-6) ----------

/**
 * One JSONL row appended per push attempt (success or any blocked
 * outcome). Stored at `.atmux/logs/orchd-push.jsonl` — `.jsonl`
 * extension aligns with sibling `auto-push.jsonl` per §Amendment
 * 2026-05-23 NIT-2.
 *
 * `gatesPassed` is the ordered list of gate IDs that fired (in fire
 * order); empty on a kill-switch / opt-in refusal because the run
 * never made it past Gate-5 or Gate-4. On `pushed`, the full sequence
 * `["5","4","2","7","3a","1","3b"]` lands (per §DA9-rev1 cheapest-
 * first fire order).
 */
export interface OrchdPushAuditRow {
  at: string;
  epicId: string;
  base: string;
  outcome: "pushed" | "blocked" | "conflict";
  /** Gate ID that blocked (when outcome ∈ {"blocked", "conflict"}). */
  gateBlocked?: GateId;
  /** Free-form refusal reason; null on `pushed`. */
  reason: string | null;
  /** Tip SHA after the push (success) OR null on blocked / conflict. */
  headSha: string | null;
  /** Pre-push tip SHA (informational; available on success). */
  beforeSha: string | null;
  /** Conflict metadata (Gate-1 only). */
  ahead?: number;
  behind?: number;
  divergenceSha?: string;
  /** Ordered list of gate IDs that PASSED in this run (fire order). */
  gatesPassed: ReadonlyArray<GateId>;
  /** Total handler-fire duration (ms). */
  durationMs?: number;
}

/**
 * Append one JSONL row to the audit log. Synchronous fs.appendFileSync
 * — audit-log append must complete before the consumer advances the
 * offset (async write could lose the row on crash).
 */
export function appendOrchdPushAuditRow(logPath: string, row: OrchdPushAuditRow): void {
  appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf8");
}

// ---------- Handler factory ----------

/** Default stubs — sibling EPIC `e-60e16169` injects real probes. */
const DEFAULT_GIT_STATUS_CLEAN = async (): Promise<boolean> => true;
const DEFAULT_TSC_CLEAN = async (): Promise<{
  ok: boolean;
  stderrTail: string;
}> => ({ ok: true, stderrTail: "" });
const DEFAULT_DISPATCH_STUB = async (): Promise<DispatchGitPushResult> => ({
  state: "skipped-not-mine",
});

/** Test-injection seam for {@link createAutoPushHandler}. */
export interface AutoPushHandlerDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Resolve effective `team.json::autoPush` for the event's epicId.
   *  Default returns the loud-opt-in refuse-by-default shape; sibling-
   *  injected resolver reads the epic-team's team.json. */
  resolveAutoPushConfig?: (epicId: string) => Promise<{
    enabled: boolean;
    typecheckCmd: string;
    cooldownSec: number;
  }>;
  /** Resolve effective `cockpit.json::pushPolicy` for the event.
   *  Default returns empty refusedBases + allowedBases. */
  resolvePushPolicy?: () => Promise<{
    refusedBases: ReadonlyArray<string>;
    allowedBases: ReadonlyArray<string>;
  }>;
  /** §DA-Gate-3a probe: working-tree clean check. Default returns
   *  true (test stub); production hook runs `git status --porcelain`. */
  runGitStatusClean?: (parentBase: string) => Promise<boolean>;
  /** §DA-Gate-3b probe: typecheck subprocess. Default returns ok.
   *  Production hook runs `team.autoPush.typecheckCmd` (empty string
   *  → caller skips the probe entirely). */
  runTscClean?: (cmd: string) => Promise<{ ok: boolean; stderrTail: string }>;
  /** Real push dispatcher (§D1 step 3 + §DA-Gate-1 contract).
   *  Default returns `skipped-not-mine`; sibling EPIC `e-60e16169`
   *  injects a closure that calls `git push origin <parentBase>` via
   *  GitSpawn + computes head/before/divergence SHA. */
  dispatchGitPush?: (parentBase: string) => Promise<DispatchGitPushResult>;
  /** Audit log path. Default `.atmux/logs/orchd-push.jsonl`. */
  auditLogPath?: string;
  /** §DA-Gate-7 cooldown state — in-memory Map<base, lastSuccessSec>.
   *  Default starts empty; sibling supplies a per-daemon Map so
   *  cooldown survives across ticks. */
  cooldownState?: Map<string, number>;
  /** Emit fn (test seam). */
  emit?: typeof defaultEmit;
  /** Append fn (test seam). */
  appendAuditRow?: typeof appendOrchdPushAuditRow;
  /** Logger (info/warn/error). */
  logger?: Logger;
  /** Clock — unix epoch seconds. */
  nowSec?: () => number;
  /** Env injection for §DA-Gate-5 kill-switch read. Defaults to
   *  `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the orchd-push handler bound to `deps`. Per `epic.merged`
 * event, runs 7 safety gates in cheapest-first fire order
 * (5 → 4 → 2 → 7 → 3a → 1 → 3b), then invokes the injected push
 * dispatcher. Emits + audits on every terminal outcome.
 */
export function createAutoPushHandler(
  deps: AutoPushHandlerDeps,
): (event: EpicMergedPayload) => Promise<AutoPushOutcome> {
  const resolveAutoPushConfig =
    deps.resolveAutoPushConfig ??
    (async () => ({
      enabled: false,
      typecheckCmd: "bun run typecheck",
      cooldownSec: 30,
    }));
  const resolvePushPolicy =
    deps.resolvePushPolicy ?? (async () => ({ refusedBases: [], allowedBases: [] }));
  const runGitStatusClean = deps.runGitStatusClean ?? DEFAULT_GIT_STATUS_CLEAN;
  const runTscClean = deps.runTscClean ?? DEFAULT_TSC_CLEAN;
  const dispatchGitPush = deps.dispatchGitPush ?? DEFAULT_DISPATCH_STUB;
  const auditLogPath = deps.auditLogPath ?? ".atmux/logs/orchd-push.jsonl";
  const cooldownState = deps.cooldownState ?? new Map<string, number>();
  const emit = deps.emit ?? defaultEmit;
  const appendAudit = deps.appendAuditRow ?? appendOrchdPushAuditRow;
  const logger = deps.logger ?? NOOP_LOGGER;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const env = deps.env ?? process.env;

  return async (event) => {
    const { epicId, parentBase: base } = event;
    const startMs = Date.now();
    const auditAt = new Date(nowSec() * 1000).toISOString();
    const gatesPassed: GateId[] = [];

    const block = (gate: GateId, reason: string, outcome: AutoPushOutcome): AutoPushOutcome => {
      emit(deps.db, {
        topic: "epic.push-blocked",
        epicId,
        base,
        gateBlocked: gate,
        reason,
        blockedAtSec: nowSec(),
      });
      appendAudit(auditLogPath, {
        at: auditAt,
        epicId,
        base,
        outcome: "blocked",
        gateBlocked: gate,
        reason,
        headSha: null,
        beforeSha: null,
        gatesPassed,
        durationMs: Date.now() - startMs,
      });
      logger.warn(`orchd-push: epic=${epicId} base=${base} blocked gate=${gate} reason=${reason}`);
      return outcome;
    };

    // Gate-5 (env read, microseconds) — §DA-Gate-5 cockpit kill-switch
    const killSwitch = env.ATMUX_AUTOPUSH_OFF;
    if (killSwitch !== undefined && killSwitch !== "" && killSwitch !== "0") {
      return block("5", "ATMUX_AUTOPUSH_OFF=1 set in env", "skipped-kill-switch");
    }
    gatesPassed.push("5");

    // Gate-4 (file read ~ms) — §DA-Gate-4 per-team opt-in
    const cfg = await resolveAutoPushConfig(epicId);
    if (cfg.enabled !== true) {
      return block(
        "4",
        "team.json::autoPush.enabled not set (opt-in only)",
        "skipped-not-opted-in",
      );
    }
    gatesPassed.push("4");

    // Gate-2 (string match microseconds) — §DA-Gate-2 staging-refuse
    const policy = await resolvePushPolicy();
    if (!isPushAllowed(base, policy.allowedBases)) {
      return block(
        "2",
        "refused-by-isPushAllowed — see CLAUDE.md push policy + scripts/push-staging.sh authorization gate",
        "skipped-staging-base",
      );
    }
    if (policy.refusedBases.includes(base)) {
      return block(
        "2",
        `cockpit.json::pushPolicy.refusedBases contains base=${base}`,
        "skipped-staging-base",
      );
    }
    gatesPassed.push("2");

    // Gate-7 (in-memory map lookup microseconds) — §DA-Gate-7 cooldown
    // Fired BEFORE Gate-3a per §DA9-rev1 cheapest-first FLAG-A swap.
    const lastSuccessSec = cooldownState.get(base);
    if (lastSuccessSec !== undefined) {
      const remaining = lastSuccessSec + cfg.cooldownSec - nowSec();
      if (remaining > 0) {
        return block("7", `cooldown ${remaining}s remaining`, "skipped-cooldown");
      }
    }
    gatesPassed.push("7");

    // Gate-3a (subprocess git status ~50-500ms) — §DA-Gate-3a pre-flight working-tree
    const wtClean = await runGitStatusClean(base);
    if (!wtClean) {
      return block("3a", "git status --porcelain reports uncommitted changes", "skipped-preflight");
    }
    gatesPassed.push("3a");

    // Gate-1 (network fetch + rev-list ~500ms-3s) — §DA-Gate-1 force-push refusal
    // Dispatcher's `upstream-advanced` returns map to push-conflict.
    // No --force / --force-with-lease / --mirror / --all / --tags /
    // --delete / --prune / --no-verify per §DA-Gate-1 + §D2.1 grep DoD.
    const dispatchResult = await dispatchGitPush(base);
    if (dispatchResult.state === "upstream-advanced") {
      const conflictPayload: {
        topic: "epic.push-conflict";
        epicId: string;
        base: string;
        ahead: number;
        behind: number;
        divergenceSha?: string;
        blockedAtSec: number;
      } = {
        topic: "epic.push-conflict",
        epicId,
        base,
        ahead: dispatchResult.ahead,
        behind: dispatchResult.behind,
        blockedAtSec: nowSec(),
      };
      if (dispatchResult.divergenceSha !== undefined) {
        conflictPayload.divergenceSha = dispatchResult.divergenceSha;
      }
      emit(deps.db, conflictPayload);
      const auditRow: OrchdPushAuditRow = {
        at: auditAt,
        epicId,
        base,
        outcome: "conflict",
        gateBlocked: "1",
        reason: `upstream-advanced ${dispatchResult.ahead} commits`,
        headSha: null,
        beforeSha: null,
        ahead: dispatchResult.ahead,
        behind: dispatchResult.behind,
        gatesPassed,
        durationMs: Date.now() - startMs,
      };
      if (dispatchResult.divergenceSha !== undefined) {
        auditRow.divergenceSha = dispatchResult.divergenceSha;
      }
      appendAudit(auditLogPath, auditRow);
      logger.warn(
        `orchd-push: epic=${epicId} base=${base} push-conflict ahead=${dispatchResult.ahead} behind=${dispatchResult.behind}`,
      );
      return "escalated";
    }
    if (dispatchResult.state === "skipped-not-mine") {
      logger.info(
        `orchd-push: epic=${epicId} base=${base} dispatcher returned skipped-not-mine${
          dispatchResult.reason ? ` (${dispatchResult.reason})` : ""
        }`,
      );
      return "skipped-not-mine";
    }
    gatesPassed.push("1");

    // Gate-3b (subprocess tsc ~3-15s) — §DA-Gate-3b typecheck
    // Empty string in typecheckCmd → skip Gate-3b entirely (per
    // §DA-Gate-4 schema describe — projects whose typecheck runs in
    // CI as the gate use "" here).
    if (cfg.typecheckCmd !== "") {
      const tscResult = await runTscClean(cfg.typecheckCmd);
      if (!tscResult.ok) {
        return block(
          "3b",
          `tsc errors via '${cfg.typecheckCmd}': ${tscResult.stderrTail.slice(0, 200)}`,
          "skipped-preflight",
        );
      }
    }
    gatesPassed.push("3b");

    // All 7 gates passed + dispatcher succeeded. Record success.
    const pushedAt = nowSec();
    cooldownState.set(base, pushedAt);
    const pushedPayload: {
      topic: "epic.pushed";
      epicId: string;
      base: string;
      headSha: string;
      beforeSha?: string;
      pushedAtSec: number;
      durationMs: number;
    } = {
      topic: "epic.pushed",
      epicId,
      base,
      headSha: dispatchResult.headSha,
      pushedAtSec: pushedAt,
      durationMs: Date.now() - startMs,
    };
    if (dispatchResult.beforeSha !== undefined) {
      pushedPayload.beforeSha = dispatchResult.beforeSha;
    }
    emit(deps.db, pushedPayload);
    appendAudit(auditLogPath, {
      at: auditAt,
      epicId,
      base,
      outcome: "pushed",
      reason: null,
      headSha: dispatchResult.headSha,
      beforeSha: dispatchResult.beforeSha ?? null,
      gatesPassed,
      durationMs: Date.now() - startMs,
    });
    logger.info(
      `orchd-push: epic=${epicId} base=${base} pushed head=${dispatchResult.headSha.slice(0, 7)}`,
    );
    return "pushed";
  };
}

// ---------- Consumer surface ----------

/** Test-injection seam — production callers pass `{db}` and accept defaults. */
export interface OrchdPushConsumeDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Consumer name for offset tracking. Defaults to `'atmux:orchd-push'`. */
  consumerName?: string;
  /** Topics to subscribe to. Defaults to `['epic.merged']`. */
  topics?: ReadonlyArray<string>;
  /** Real push handler; default no-op returns 'skipped-not-mine'. */
  handler?: (event: EpicMergedPayload) => Promise<AutoPushOutcome>;
  /** Clock injection — propagated to `withIdempotency` for offset writes. */
  nowSec?: () => number;
  /** Optional logger; falls back to a no-op when absent. */
  logger?: Logger;
  /** Env injection for `isHonkerEnabled`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Default stub handler — returns skipped-not-mine. */
async function defaultHandler(_event: EpicMergedPayload): Promise<AutoPushOutcome> {
  return "skipped-not-mine";
}

/**
 * Drain pending `epic.merged` events for the orchd-push consumer.
 * Mirrors `orchdMergeConsume` + `orchdDissolveConsume` shape exactly
 * per ADR-229 §D4.
 *
 * Honker kill-switch (`ATMUX_HONKER=off`) short-circuits to zero
 * totals + log fallback path.
 *
 * `escalated` counter increments only on `escalated` outcome
 * (push-conflict Gate-1 refusal). Other `skipped-*` outcomes advance
 * offset without escalating.
 */
export async function orchdPushConsume(
  deps: OrchdPushConsumeDeps,
): Promise<{ processed: number; escalated: number }> {
  const consumerName = deps.consumerName ?? "atmux:orchd-push";
  const topics = deps.topics ?? (["epic.merged"] as const);
  const handler = deps.handler ?? defaultHandler;
  const logger = deps.logger ?? NOOP_LOGGER;

  if (!isHonkerEnabled(deps.env)) {
    logger.info("orchd-push: ATMUX_HONKER=off — fallback to manual-push path");
    return { processed: 0, escalated: 0 };
  }

  let processed = 0;
  let escalated = 0;

  await withIdempotency(
    deps.db,
    consumerName,
    deps.nowSec ? { topics, nowSec: deps.nowSec } : { topics },
    async (event) => {
      const outcome = await handler(event as EpicMergedPayload);
      processed += 1;
      if (outcome === "escalated") escalated += 1;
    },
  );

  return { processed, escalated };
}

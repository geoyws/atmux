// ADR-228 §D3 + §D4 + §D7: orchd spawn-queue admission + drain.
//
// Phase 5b (driver P0 step 4/5, 2026-05-23): the refuse→enqueue
// transition + pressure-monitor drain loop. Builds on Phase 5a's
// {@link SpawnQueueRepo} (CRUD + transactional dequeueHead) and
// the existing {@link probeHostPressure} substrate (ADR-184).
//
// Three exported entry points:
//
//   - {@link admit}: cheap test that a fresh enqueue is allowed
//     (queue depth below cap + no epic-already-queued duplicate).
//   - {@link enqueueIfPressured}: verb-layer integration — called
//     by `spawn-epic` when the host-pressure verdict is `!ok`. On
//     admission, inserts a row + emits `epic.spawn-queued`. On
//     refusal, returns the reason for the verb to surface via
//     ConfigError.
//   - {@link pressureMonitorTick}: orchd daemon loop body — one
//     drain attempt per tick. Probes pressure; under-threshold +
//     non-empty queue → dequeue head, dispatch spawnEpic, delete on
//     success / increment attempts on failure / abandon at the cap.
//
// Idempotency contract: handlers are wrapped in withIdempotency at
// the orchd dispatch layer (per ADR-228 §D4 step 4 throw branch);
// failed dispatches leave the row in `spawning` until the next
// tick's BEGIN IMMEDIATE re-acquires. Successful dispatch deletes
// the row; the spawned epic-team is the audit trail.
//
// Cross-team contract: the `spawnEpic` callable is INJECTED so this
// module stays free of verb-layer imports (no circular dep with
// `src/verbs/team/spawn-epic.ts`). Production wiring lives at the
// `src/verbs/orchd.ts::orchd()` daemon entry-point and at the spawn-
// epic verb's pressure-refused branch.

import type { Database } from "bun:sqlite";
import { emit as defaultEmit } from "../abstractions/events.ts";
import { uuidv7 } from "../abstractions/uuidv7.ts";
import type { SpawnQueueRow } from "../schema/spawn-queue.ts";
import type { HostPressureVerdict } from "./host-pressure.ts";
import { SpawnQueueRepo } from "./repositories/spawn-queue-repo.ts";

// ---------- Constants ----------

/** Bounded queue cap per ADR-228 §D6. Override via env
 *  `ATMUX_SPAWN_QUEUE_MAX_DEPTH`. Story AC bumps the doc-default 20 to
 *  32 in s-4 §AC#2; we follow Story-AC per Task-body deference. */
export const SPAWN_QUEUE_DEFAULT_MAX_DEPTH = 32;
/** Max drain attempts before flipping a row to `abandoned`. Per
 *  ADR-228 §D6 default 5. Override via env
 *  `ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS`. */
export const SPAWN_QUEUE_DEFAULT_MAX_ATTEMPTS = 5;
/** Default tick interval for the pressure-monitor drain loop. Per
 *  ADR-228 §D6 (60s). Override via `team.json::spawnQueue.checkIntervalSec`
 *  resolved at the daemon wiring site. */
export const SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC = 60;

// ---------- Types ----------

/** Resolved limits (env-or-default). */
export interface SpawnQueueLimits {
  maxDepth: number;
  maxAttempts: number;
  /** Used by the daemon wiring (`src/verbs/orchd.ts`) to pace the
   *  drain loop. Exposed here so a single resolveSpawnQueueLimits
   *  call returns every tunable the daemon needs. */
  pressureCheckIntervalSec: number;
}

/** Result of {@link admit} — admitted true on green-light, or false with
 *  a refusal reason. Reason is a one-line operator-readable string. */
export interface AdmissionVerdict {
  admitted: boolean;
  reason: string | null;
}

/** Test-injection seam for {@link pressureMonitorTick}. */
export interface PressureMonitorTickDeps {
  db: Database;
  /** Production hook returns the real host probe; test injects a fixed
   *  verdict. Mirrors the signature of `probeHostPressure(deps)` so
   *  callers can pass a curried closure. */
  probeHostPressure: () => Promise<HostPressureVerdict>;
  /** Dispatcher closure — invoked with the queued row's
   *  {@link SpawnQueueRow.spawnArgs} parsed back to a string array.
   *  Returns `{success, reason?}` so the tick can map to delete /
   *  increment / abandon. The verb wiring constructs this closure
   *  around the spawn-epic verb's main path. */
  spawnEpic: (argv: ReadonlyArray<string>) => Promise<{ success: boolean; reason?: string }>;
  /** Resolved limits — caller computes via {@link resolveSpawnQueueLimits}
   *  once at daemon startup; the tick passes them in per-invocation. */
  limits: SpawnQueueLimits;
  /** Clock — unix epoch seconds. Defaults to wall-clock. */
  nowSec?: () => number;
  /** Emit fn (test seam). Defaults to the production `emit` helper. */
  emit?: typeof defaultEmit;
  /** Optional logger; falls back to a no-op when absent. */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/** Return shape of {@link pressureMonitorTick}. `drained` ∈ {0,1}
 *  per §DA4 one-per-tick throttle; `remaining` reflects post-tick
 *  queue depth (helpful for cockpit observability). */
export interface PressureMonitorTickResult {
  drained: number;
  remaining: number;
  verdict: HostPressureVerdict;
  /** When `drained=1`, populated with the queueId that was
   *  consumed. Useful for logs + tests. */
  drainedQueueId?: string;
  /** When `drained=0` AND `verdict.ok=true` AND queue had a head,
   *  populated with the failure-or-abandon reason. */
  failureReason?: string;
  /** When the head row hit `attempts >= maxAttempts`, set to its
   *  queueId. Lets caller correlate the `epic.spawn-abandoned` emit. */
  abandonedQueueId?: string;
}

/** Test-injection seam for {@link enqueueIfPressured}. */
export interface EnqueueIfPressuredDeps {
  db: Database;
  /** Limits — caller computes via {@link resolveSpawnQueueLimits}. */
  limits: SpawnQueueLimits;
  /** Identity to record as `queued_by`. Verb-layer passes
   *  `process.env.ATMUX_CALLER_SCOPE === "driver" ? "driver" : "operator"`
   *  or similar; tests pass fixed values. */
  queuedBy: string;
  /** Clock — unix epoch seconds. Defaults to wall-clock. */
  nowSec?: () => number;
  /** ID generator (test seam) — defaults to {@link generateSpawnQueueId}. */
  generateQueueId?: () => string;
  /** Emit fn (test seam). Defaults to the production `emit` helper. */
  emit?: typeof defaultEmit;
}

/** Return shape of {@link enqueueIfPressured}. */
export interface EnqueueIfPressuredResult {
  /** `true` when a row was inserted; `false` on refusal (queue full or
   *  duplicate). */
  enqueued: boolean;
  /** Populated on success — the operator-visible queue depth INCLUDING
   *  the just-inserted row. Surfaces in the verb's exit-hint. */
  depth: number;
  /** Populated on success — the new queueId. */
  queueId?: string;
  /** Populated on refusal — the reason {@link admit} returned. */
  reason?: string;
}

// ---------- Helpers ----------

/**
 * Resolve {@link SpawnQueueLimits} from env vars + defaults. Mirrors
 * `resolveThresholds` in `host-pressure.ts` for symmetry.
 *
 * Env overrides:
 *   - `ATMUX_SPAWN_QUEUE_MAX_DEPTH` (int ≥ 0; 0 disables queueing —
 *     {@link admit} refuses every call when `maxDepth === 0`, falling
 *     back to today's throw-on-pressure behavior per ADR-228 §D6).
 *   - `ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS` (int ≥ 1; invalid → default).
 *   - `ATMUX_SPAWN_QUEUE_TICK_SEC` (int ≥ 1; invalid → default).
 */
export function resolveSpawnQueueLimits(env: NodeJS.ProcessEnv): SpawnQueueLimits {
  const rawDepth = env.ATMUX_SPAWN_QUEUE_MAX_DEPTH?.trim();
  const rawAttempts = env.ATMUX_SPAWN_QUEUE_MAX_ATTEMPTS?.trim();
  const rawTick = env.ATMUX_SPAWN_QUEUE_TICK_SEC?.trim();

  let maxDepth = SPAWN_QUEUE_DEFAULT_MAX_DEPTH;
  if (rawDepth !== undefined && rawDepth.length > 0) {
    const n = Number.parseInt(rawDepth, 10);
    if (Number.isInteger(n) && n >= 0) maxDepth = n;
  }

  let maxAttempts = SPAWN_QUEUE_DEFAULT_MAX_ATTEMPTS;
  if (rawAttempts !== undefined && rawAttempts.length > 0) {
    const n = Number.parseInt(rawAttempts, 10);
    if (Number.isInteger(n) && n >= 1) maxAttempts = n;
  }

  let pressureCheckIntervalSec = SPAWN_QUEUE_DEFAULT_TICK_INTERVAL_SEC;
  if (rawTick !== undefined && rawTick.length > 0) {
    const n = Number.parseInt(rawTick, 10);
    if (Number.isInteger(n) && n >= 1) pressureCheckIntervalSec = n;
  }

  return { maxDepth, maxAttempts, pressureCheckIntervalSec };
}

/**
 * Generate a fresh `q-<8 hex>` ID matching `SPAWN_QUEUE_ID_PATTERN`.
 * Derived from `uuidv7()` so the timestamp ordering is preserved
 * within the prefix-stripped form; takes the first 8 hex characters
 * of the time-low segment.
 */
export function generateSpawnQueueId(): string {
  const u = uuidv7();
  // uuidv7 shape: XXXXXXXX-XXXX-7XXX-YXXX-XXXXXXXXXXXX. The last
  // segment (12 hex chars) is fully random per RFC 9562; take 8 of
  // those for collision resistance under sub-millisecond bursts.
  // Lowercase hex per `SPAWN_QUEUE_ID_PATTERN`.
  return `q-${u.slice(24, 32)}`;
}

// ---------- admit ----------

/**
 * Cheap admission test. Refuses when:
 *   - `limits.maxDepth === 0` → queueing disabled (env-controlled
 *     escape hatch per §D6 "Set to 0 to disable queueing").
 *   - depth ≥ `limits.maxDepth` → bounded queue full.
 *   - an existing row already has `epic_id = eid` AND state ∈
 *     `('queued','spawning')` → idempotent surface (caller asked
 *     for the same epic twice).
 *
 * `eid` is required so the duplicate check can name the conflict.
 * Returns null `reason` only when admitted.
 */
export function admit(db: Database, limits: SpawnQueueLimits, eid: string): AdmissionVerdict {
  if (limits.maxDepth === 0) {
    return {
      admitted: false,
      reason: "queueing disabled (ATMUX_SPAWN_QUEUE_MAX_DEPTH=0)",
    };
  }
  const depthRow = db
    .prepare("SELECT COUNT(*) AS n FROM spawn_queue WHERE state IN ('queued','spawning')")
    .get() as { n: number } | null | undefined;
  const depth = depthRow?.n ?? 0;
  if (depth >= limits.maxDepth) {
    return {
      admitted: false,
      reason: `queue full: depth ${depth} ≥ maxDepth ${limits.maxDepth}`,
    };
  }
  const dupRow = db
    .prepare(
      "SELECT queue_id FROM spawn_queue WHERE epic_id = ? AND state IN ('queued','spawning') LIMIT 1",
    )
    .get(eid) as { queue_id: string } | null | undefined;
  if (dupRow !== null && dupRow !== undefined) {
    return {
      admitted: false,
      reason: `epic already queued: ${dupRow.queue_id}`,
    };
  }
  return { admitted: true, reason: null };
}

// ---------- enqueueIfPressured ----------

/**
 * Verb-layer integration helper: called when `spawn-epic` sees
 * `!verdict.ok` on the host-pressure probe. Tests admission, inserts
 * the row on green-light, and emits `epic.spawn-queued`. Returns the
 * outcome so the verb can either exit 0 with the operator-hint
 * (success) or throw ConfigError with the refusal reason (failure).
 *
 * `eid` + `argv` come straight from the verb's parsed args; `argv` is
 * JSON-stringified into `spawn_args` so the drain tick can replay it
 * verbatim.
 */
export function enqueueIfPressured(
  eid: string,
  argv: ReadonlyArray<string>,
  deps: EnqueueIfPressuredDeps,
): EnqueueIfPressuredResult {
  const verdict = admit(deps.db, deps.limits, eid);
  if (!verdict.admitted) {
    return { enqueued: false, depth: 0, reason: verdict.reason ?? "refused" };
  }

  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const generateQueueId = deps.generateQueueId ?? generateSpawnQueueId;
  const emit = deps.emit ?? defaultEmit;
  const repo = new SpawnQueueRepo(deps.db);
  const queueId = generateQueueId();
  const queuedAtSec = nowSec();

  const row: SpawnQueueRow = {
    queueId: queueId as SpawnQueueRow["queueId"],
    epicId: eid,
    spawnArgs: JSON.stringify(argv),
    queuedAtSec,
    queuedBy: deps.queuedBy,
    priority: 5,
    attempts: 0,
    lastAttemptAtSec: null,
    lastFailureReason: null,
    state: "queued",
  };
  repo.insertQueued(row);

  const depthRow = deps.db
    .prepare("SELECT COUNT(*) AS n FROM spawn_queue WHERE state IN ('queued','spawning')")
    .get() as { n: number } | null | undefined;
  const depth = depthRow?.n ?? 0;

  emit(deps.db, {
    topic: "epic.spawn-queued",
    queueId,
    epicId: eid,
    queuedBy: deps.queuedBy,
    queuedAtSec,
    depth,
  });

  return { enqueued: true, depth, queueId };
}

// ---------- pressureMonitorTick ----------

/**
 * One drain attempt. Probes pressure; under-threshold + non-empty
 * queue → atomically dequeue head + dispatch spawnEpic. On success,
 * delete row. On failure, increment attempts (or abandon when
 * attempts hit cap). Returns counters for caller's log + observability.
 *
 * Drain-one-per-tick (§DA4): even if the queue holds 50 rows, we
 * only pop one and exit. The next tick re-probes pressure between
 * dequeues — spreading the spawn load across time so a flag-day
 * dump doesn't re-trip the gate within 1-2 ticks.
 */
export async function pressureMonitorTick(
  deps: PressureMonitorTickDeps,
): Promise<PressureMonitorTickResult> {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const emit = deps.emit ?? defaultEmit;
  const repo = new SpawnQueueRepo(deps.db);

  const verdict = await deps.probeHostPressure();

  const remainingPre =
    (
      deps.db.prepare("SELECT COUNT(*) AS n FROM spawn_queue WHERE state = 'queued'").get() as
        | { n: number }
        | undefined
    )?.n ?? 0;

  // §D4 step 1: pressure still high → no-op
  if (!verdict.ok && !verdict.skipped) {
    deps.logger?.info(
      `spawn-queue tick: host still pressured (${verdict.reasons.join("; ")}) — queue=${remainingPre}, skip`,
    );
    return { drained: 0, remaining: remainingPre, verdict };
  }

  // queue empty → fast path
  if (remainingPre === 0) {
    return { drained: 0, remaining: 0, verdict };
  }

  // §D4 step 2: atomic dequeueHead under BEGIN IMMEDIATE
  const head = repo.dequeueHead();
  if (head === null) {
    return { drained: 0, remaining: remainingPre, verdict };
  }

  // §D4 step 3 + 4: replay spawn-epic
  let result: { success: boolean; reason?: string };
  try {
    const argv = JSON.parse(head.spawnArgs) as string[];
    result = await deps.spawnEpic(argv);
  } catch (e) {
    result = {
      success: false,
      reason: `dispatcher threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const remainingPost =
    (
      deps.db.prepare("SELECT COUNT(*) AS n FROM spawn_queue WHERE state = 'queued'").get() as
        | { n: number }
        | undefined
    )?.n ?? 0;

  if (result.success) {
    repo.deleteByQueueId(head.queueId);
    // §D5 epic.added emit — Phase 2 auto-spawn consumer picks this
    // up. (Phase 2 sibling EPIC e-60e16169 — handler may not be on
    // this branch yet; the emit lands the durable event regardless.)
    emit(deps.db, {
      topic: "epic.added",
      epicId: head.epicId,
      addedAtSec: nowSec(),
    });
    // remainingPost was queried AFTER dequeueHead flipped the head
    // row to 'spawning' — so the 'queued' count already excludes it.
    // The delete just removes the row entirely; the count stays.
    deps.logger?.info(
      `spawn-queue tick: drained ${head.queueId} (epic=${head.epicId}) — queue=${remainingPost}`,
    );
    return {
      drained: 1,
      remaining: remainingPost,
      verdict,
      drainedQueueId: head.queueId,
    };
  }

  // failure path
  const reason = result.reason ?? "spawn-epic failed (no reason)";
  const nextAttempts = head.attempts + 1;
  if (nextAttempts >= deps.limits.maxAttempts) {
    repo.markAbandoned(head.queueId, reason);
    emit(deps.db, {
      topic: "epic.spawn-abandoned",
      queueId: head.queueId,
      epicId: head.epicId,
      attempts: nextAttempts,
      lastFailureReason: reason,
    });
    deps.logger?.warn(
      `spawn-queue tick: abandoned ${head.queueId} (epic=${head.epicId}) after ${nextAttempts} attempts — ${reason}`,
    );
    return {
      drained: 0,
      remaining: remainingPost,
      verdict,
      failureReason: reason,
      abandonedQueueId: head.queueId,
    };
  }

  // bounce back to queued, increment attempts
  repo.incrementAttempts(head.queueId, reason, nowSec());
  deps.logger?.warn(
    `spawn-queue tick: ${head.queueId} (epic=${head.epicId}) failed attempt ${nextAttempts}/${deps.limits.maxAttempts} — ${reason}`,
  );
  return {
    drained: 0,
    remaining: remainingPost,
    verdict,
    failureReason: reason,
  };
}

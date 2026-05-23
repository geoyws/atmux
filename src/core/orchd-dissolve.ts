// ADR-227 + ADR-202 + ADR-203: orchd auto-dissolve subscriber (Phase 4).
//
// Listens for `epic.pushed` events (per ADR-227 §Amendment 2026-05-23
// trigger flip — pre-amendment was `epic.merged`; the flip exists so
// Phase 4 doesn't dissolve the cage BEFORE Phase 6 has pushed the merge
// commit to origin), invokes `atmux team dissolve-epic <eid>` via an
// injected `performDissolveEpic` dispatcher, and emits `epic.dissolved`
// on success or `epic.dissolve-blocked` on pre-flight gate refusal.
//
// Module surface MIRRORS `src/core/gitter-consumer.ts` + `src/core/
// orchd-merge.ts` (ADR-226) exactly per ADR-227 §DA5 — same
// withIdempotency wrapper, same ATMUX_HONKER kill-switch, same stubbed-
// default-with-injected-resolver pattern. Operators learn one shape.
//
// Phase 4 closes ADR-221 §v2 auto-dissolve completely. Solo workers
// (`w-<task-id>` epic-id prefix per ADR-221 §v1) are structurally
// identical to regular epic-teams from orchd's perspective; they get
// the same handler treatment with no special-casing.
//
// **Phase 4 does NOT fire on push-terminal-failure events** per ADR-227
// §D1.1 (committer NIT-1 absorption): subscribe ONLY to `epic.pushed`,
// never `epic.push-blocked` / `epic.push-conflict`. Cage-persists-on-
// push-failure is the canonical forensic recovery surface — dissolving
// on a failed push would wipe `.atmux/logs/orchd-push.jsonl` + the
// local merge SHA + the branch ref needed to push manually after
// operator resolution.
//
// Operator opt-out (per ADR-227 §D3): `team.json::epicTeam.autoDissolve
// === false` (set at spawn time via `atmux team spawn-epic --no-auto-
// dissolve <eid>`) → handler emits `skipped-operator-opt-out` outcome
// + writes the opt-out row to the audit log + skips dispatch.

import type { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { emit as defaultEmit, withIdempotency } from "../abstractions/events.ts";
import { isHonkerEnabled } from "../abstractions/honker.ts";
import type { EpicMergedPayload } from "../schema/events.ts";

/**
 * Trigger event shape for the dissolve handler. Today `epic.pushed`
 * isn't in the v1 closed topic set in `src/schema/events.ts` yet —
 * Phase 6 (ADR-229 + t-1-fc0368cb) adds its schema. Until then this
 * handler subscribes to a topic name that yields zero events
 * (consumer stays dormant); when Phase 6 lands, events flow in. The
 * structural type covers both `EpicMergedPayload` (today's shape) and
 * the future `EpicPushedPayload` — both carry `epicId` + `topic` +
 * the `BasePayloadFields` discriminator, which is all this handler
 * needs.
 *
 * Per ADR-227 §Amendment trigger flip: `epic.pushed` is the canonical
 * trigger; `epic.merged` only used by Phase 6 (auto-push) consumer.
 */
export type DissolveTriggerPayload = Pick<
  EpicMergedPayload,
  "topic" | "epicId" | "emittedAtSec" | "eventId" | "schemaVersion"
> & { topic: string };

/**
 * Result the injected dispatcher returns from one dissolve attempt.
 * Translated to {@link AutoDissolveOutcome} + the corresponding
 * `epic.dissolved` / `epic.dissolve-blocked` event emit + audit-log
 * row by {@link createAutoDissolveHandler}.
 *
 * Default-stub returns `{state: "skipped-not-mine"}` per ADR-227 §D6
 * — sibling EPIC `e-60e16169` injects a real dispatcher that calls
 * `performDissolveEpic` factored out of `src/verbs/team-dissolve-epic.ts`.
 */
export type DispatchDissolveEpicResult =
  | { state: "dissolved"; dissolvedSha?: string }
  | { state: "gate-held"; reason: string }
  | { state: "skipped-not-mine"; reason?: string };

/**
 * Outcome of a single orchd-dissolve handler invocation. Per ADR-227 §D6.
 */
export type AutoDissolveOutcome =
  | "dissolved"
  | "escalated"
  | "skipped-operator-opt-out"
  | "skipped-not-mine"
  | "skipped-honker-off";

/** Minimal logger surface — mirrors gitter-consumer.ts + orchd-merge.ts. */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

const noopLog: Logger["info"] = () => {};
const NOOP_LOGGER: Logger = { info: noopLog, warn: noopLog, error: noopLog };

// ---------- Audit log (ADR-227 §D4 + §DA4) ----------

/**
 * One row appended per dissolve attempt (success / blocked / opt-out)
 * to `.atmux/logs/orchd-dissolve.log`. JSONL format matches sibling
 * ADR-090 audit pattern + ADR-229 push audit log shape.
 */
export interface OrchdDissolveAuditRow {
  /** ISO-8601 timestamp at handler-fire moment. */
  at: string;
  /** Epic id from the trigger event payload. */
  epicId: string;
  /** Outcome category — orthogonal classification of the row. */
  outcome: "dissolved" | "blocked" | "opt-out";
  /** Free-form reason; null on `dissolved` (no reason needed). */
  reason: string | null;
  /** Merge SHA from the trigger payload (when available). */
  mergedSha: string | null;
  /** Dissolve dispatcher's returned SHA (e.g. tip after the cage was
   *  reaped). null on blocked / opt-out / unsupplied. */
  dissolvedSha: string | null;
}

/**
 * Append one JSONL row to the audit log. File is created if missing;
 * parent directory is the caller's concern (must already exist —
 * `.atmux/logs/` is created by `atmux init` / team-spawn flow).
 *
 * Exported so the factory + tests share one append implementation.
 * Synchronous fs.appendFileSync is intentional — audit-log appends
 * must complete before the consumer advances the offset; an async
 * write that races the offset commit could lose the row on crash.
 */
export function appendOrchdDissolveAuditRow(logPath: string, row: OrchdDissolveAuditRow): void {
  appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf8");
}

// ---------- Handler factory ----------

const DEFAULT_DISPATCH_STUB = async (_epicId: string): Promise<DispatchDissolveEpicResult> => ({
  state: "skipped-not-mine",
});

const DEFAULT_AUTO_DISSOLVE_RESOLVER = async (_epicId: string): Promise<boolean> => true;

/** Test-injection seam for {@link createAutoDissolveHandler}. */
export interface AutoDissolveHandlerDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Real dissolve dispatcher. Default returns `skipped-not-mine`;
   *  sibling EPIC `e-60e16169` injects a closure that calls
   *  `performDissolveEpic` from a module-level handler factored out
   *  of `src/verbs/team-dissolve-epic.ts`. */
  dispatchDissolveEpic?: (epicId: string) => Promise<DispatchDissolveEpicResult>;
  /** Resolver for `team.json::epicTeam.autoDissolve` per epicId.
   *  Default returns `true` (auto-dissolve on); sibling-injected
   *  resolver reads the epic-team's `.atmux/team.json` or the parent's
   *  cockpit registry to determine the opt-out state. Returning
   *  `false` → handler emits `skipped-operator-opt-out` + audit row,
   *  skips dispatch. */
  resolveAutoDissolveSetting?: (epicId: string) => Promise<boolean>;
  /** Audit log path. Default `.atmux/logs/orchd-dissolve.log`. Tests
   *  pin to a scratch path. Caller responsible for parent directory
   *  existence. */
  auditLogPath?: string;
  /** Emit fn (test seam). Defaults to the production `emit` helper. */
  emit?: typeof defaultEmit;
  /** Append fn (test seam). Defaults to {@link appendOrchdDissolveAuditRow}. */
  appendAuditRow?: typeof appendOrchdDissolveAuditRow;
  /** Logger (info/warn/error). Falls back to a no-op shim. */
  logger?: Logger;
  /** Clock — unix epoch seconds for emit; ISO for audit log. */
  nowSec?: () => number;
}

/**
 * Build the orchd-dissolve handler bound to `deps`. Mirrors the shape
 * of `createAutoMergeHandler` (ADR-226 §D5).
 *
 * Per `epic.pushed` event (or `epic.merged` pre-Phase-6):
 *   1. Resolve `epicId` from payload.
 *   2. Pre-flight check via {@link resolveAutoDissolveSetting} —
 *      `false` → emit `skipped-operator-opt-out` outcome + audit
 *      row, skip dispatch.
 *   3. Invoke `dispatchDissolveEpic(epicId)`.
 *   4. Map dispatch state → outcome + emit downstream event + audit row:
 *      - `dissolved` → emit `epic.dissolved` + outcome `dissolved`.
 *      - `gate-held` → emit `epic.dissolve-blocked` + outcome
 *        `escalated`.
 *      - `skipped-not-mine` → outcome `skipped-not-mine` (no emit,
 *        no audit).
 *
 * Throws are caught by `withIdempotency` in
 * {@link orchdDissolveConsume} — offset is NOT advanced; next sweep
 * retries.
 *
 * Worker (`w-` prefix) handling: structurally identical to regular
 * epics per ADR-227 §D5 + §DA3. No prefix sniffing.
 */
export function createAutoDissolveHandler(
  deps: AutoDissolveHandlerDeps,
): (event: DissolveTriggerPayload) => Promise<AutoDissolveOutcome> {
  const dispatch = deps.dispatchDissolveEpic ?? DEFAULT_DISPATCH_STUB;
  const resolveAutoDissolve = deps.resolveAutoDissolveSetting ?? DEFAULT_AUTO_DISSOLVE_RESOLVER;
  const auditLogPath = deps.auditLogPath ?? ".atmux/logs/orchd-dissolve.log";
  const emit = deps.emit ?? defaultEmit;
  const appendAudit = deps.appendAuditRow ?? appendOrchdDissolveAuditRow;
  const logger = deps.logger ?? NOOP_LOGGER;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  return async (event) => {
    const epicId = event.epicId;
    // Surface the merge SHA when the payload carries one (EpicMergedPayload
    // has mergeSha; the future EpicPushedPayload carries headSha) — the
    // audit row records it as `mergedSha` for cross-attempt forensics.
    // Use a forward-compatible structural access; both shapes are
    // unknown-extensible per `.passthrough()`.
    const evWithSha = event as unknown as {
      mergeSha?: string;
      headSha?: string;
    };
    const mergedSha = evWithSha.mergeSha ?? evWithSha.headSha ?? null;
    const auditAt = new Date(nowSec() * 1000).toISOString();

    // Step 2: operator opt-out (autoDissolve: false)
    const autoDissolveOn = await resolveAutoDissolve(epicId);
    if (!autoDissolveOn) {
      appendAudit(auditLogPath, {
        at: auditAt,
        epicId,
        outcome: "opt-out",
        reason: "team.json::epicTeam.autoDissolve=false",
        mergedSha,
        dissolvedSha: null,
      });
      logger.info(`orchd-dissolve: epic=${epicId} autoDissolve=false — operator opt-out, skipping`);
      return "skipped-operator-opt-out";
    }

    // Step 3: dispatch
    const result = await dispatch(epicId);

    // Step 4: outcome mapping + emit + audit
    switch (result.state) {
      case "dissolved": {
        const dissolvedSha = result.dissolvedSha ?? null;
        emit(deps.db, {
          topic: "epic.dissolved",
          epicId,
          dissolvedAtSec: nowSec(),
          ...(dissolvedSha !== null ? { dissolvedSha } : {}),
        });
        appendAudit(auditLogPath, {
          at: auditAt,
          epicId,
          outcome: "dissolved",
          reason: null,
          mergedSha,
          dissolvedSha,
        });
        logger.info(
          `orchd-dissolve: epic=${epicId} dissolved${
            dissolvedSha ? ` sha=${dissolvedSha.slice(0, 7)}` : ""
          }`,
        );
        return "dissolved";
      }
      case "gate-held": {
        emit(deps.db, {
          topic: "epic.dissolve-blocked",
          epicId,
          reason: result.reason,
          blockedAtSec: nowSec(),
        });
        appendAudit(auditLogPath, {
          at: auditAt,
          epicId,
          outcome: "blocked",
          reason: result.reason,
          mergedSha,
          dissolvedSha: null,
        });
        logger.warn(`orchd-dissolve: epic=${epicId} blocked — ${result.reason}`);
        return "escalated";
      }
      case "skipped-not-mine": {
        logger.info(
          `orchd-dissolve: epic=${epicId} dispatcher returned skipped-not-mine${
            result.reason ? ` (${result.reason})` : ""
          }`,
        );
        return "skipped-not-mine";
      }
    }
  };
}

// ---------- Consumer surface (mirrors orchd-merge.ts + gitter-consumer.ts) ----------

/** Test-injection seam — production callers pass `{db}` and accept defaults. */
export interface OrchdDissolveConsumeDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Consumer name for offset tracking. Defaults to `'atmux:orchd-dissolve'`. */
  consumerName?: string;
  /** Topics to subscribe to. Defaults to `['epic.pushed']` per ADR-227
   *  §Amendment 2026-05-23 (pre-amendment was `['epic.merged']`; the
   *  flip prevents Phase 4 dissolving before Phase 6 pushes). When
   *  Phase 6 has not yet shipped, this topic yields zero events
   *  (consumer stays dormant); when Phase 6 lands, events flow in. */
  topics?: ReadonlyArray<string>;
  /** Real dissolve handler; default no-op returns 'skipped-not-mine'. */
  handler?: (event: DissolveTriggerPayload) => Promise<AutoDissolveOutcome>;
  /** Clock injection — propagated to `withIdempotency` for offset writes. */
  nowSec?: () => number;
  /** Optional logger; falls back to no-op when absent. */
  logger?: Logger;
  /** Env injection for `isHonkerEnabled`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Default stub handler — emits skipped-not-mine regardless. */
async function defaultHandler(_event: DissolveTriggerPayload): Promise<AutoDissolveOutcome> {
  return "skipped-not-mine";
}

/**
 * Drain pending `epic.pushed` events for the orchd-dissolve consumer,
 * invoking `deps.handler` (or the stubbed default) per event under
 * at-least-once idempotency. Returns the totals so callers can
 * surface "N processed, M escalated" without re-walking the offset
 * table.
 *
 * Honker kill-switch short-circuit: when `ATMUX_HONKER` is off, the
 * consumer logs once and returns zero totals so the operator-manual
 * `dissolve-epic <eid>` path stays untouched until the substrate
 * flips on.
 *
 * Failure mode: a thrown handler is caught inside `withIdempotency`
 * and stops the drain at the failing event. The offset is NOT
 * advanced past it — the next sweep re-attempts. This function
 * itself NEVER throws on handler failure.
 */
export async function orchdDissolveConsume(
  deps: OrchdDissolveConsumeDeps,
): Promise<{ processed: number; escalated: number }> {
  const consumerName = deps.consumerName ?? "atmux:orchd-dissolve";
  const topics = deps.topics ?? (["epic.pushed"] as const);
  const handler = deps.handler ?? defaultHandler;
  const logger = deps.logger ?? NOOP_LOGGER;

  if (!isHonkerEnabled(deps.env)) {
    logger.info(
      "orchd-dissolve: ATMUX_HONKER=off — fallback to operator-manual dissolve-epic path",
    );
    return { processed: 0, escalated: 0 };
  }

  let processed = 0;
  let escalated = 0;

  await withIdempotency(
    deps.db,
    consumerName,
    deps.nowSec ? { topics, nowSec: deps.nowSec } : { topics },
    async (event) => {
      const outcome = await handler(event as DissolveTriggerPayload);
      processed += 1;
      if (outcome === "escalated") escalated += 1;
    },
  );

  return { processed, escalated };
}

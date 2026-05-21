// ADR-145 + ADR-202 + ADR-212: Honker gitter consumer.
//
// gitter listens for `task.done` events and (T4) dispatches the merge
// of the worker's `<base>-<member>` branch into the team's trunk. When
// the merge cannot be auto-resolved, gitter emits `gitter.escalated`
// per ADR-212 §D2 (canonical lead-gated destructive-action pattern) +
// ADR-145 §"escalate via flag/reply on conflict" — the lead's Claude
// reads the escalation payload and decides between rebase / squash /
// revert / handoff-to-author.
//
// Phase-1 scope (this Task — T2 of EPIC e-4acc3562):
//   - Consumer surface + withIdempotency wiring + injection seam.
//   - Stubbed default handler returns 'skipped-not-mine' — the merge
//     dispatch lives in T4 (stubbed-default-with-injected-resolver per
//     memory feedback_stubbed_default_with_injected_resolver).
//   - isHonkerEnabled() short-circuits when ATMUX_HONKER=off so
//     pre-rollout teams keep their cron-only path.
//   - NEVER throws on handler failure — withIdempotency owns the
//     offset-advance/halt contract per ADR-203 §D7.

import type { Database } from "bun:sqlite";
import { withIdempotency } from "../abstractions/events.ts";
import { isHonkerEnabled } from "../abstractions/honker.ts";
import type { TaskDonePayload } from "../schema/events.ts";

// Re-export the T4 merge-handler factory so consumers wire the real
// dispatcher via a single import (`{gitterConsume, createGitterMergeHandler}
// from './gitter-consumer.ts'`).
export {
  createGitterMergeHandler,
  type GitterMergeHandlerDeps,
} from "./gitter-merge-handler.ts";

/**
 * Outcome of a single gitter handler invocation. Drives the
 * {processed, escalated} totals + (in T4) the trunk-merge state
 * machine wiring.
 */
export type HandlerOutcome =
  | "merged"
  | "escalated"
  | "skipped-not-mine"
  | "skipped-honker-off"
  | "gate-held";

/** Minimal logger surface — matches what other consumers accept. */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Test-injection seam — production callers pass `{db}` and accept defaults. */
export interface GitterConsumeDeps {
  /** Open Database (per-team `state.db`). */
  db: Database;
  /** Consumer name for offset tracking. Defaults to `'atmux:gitter'`. */
  consumerName?: string;
  /** Topics to subscribe to. Defaults to `['task.done']`. */
  topics?: ReadonlyArray<string>;
  /** Real merge dispatcher; default no-op returns 'skipped-not-mine'. */
  handler?: (event: TaskDonePayload) => Promise<HandlerOutcome>;
  /** Clock injection — propagated to `withIdempotency` for offset writes. */
  nowSec?: () => number;
  /** Optional logger; falls back to a console-shaped no-op when absent. */
  logger?: Logger;
  /** Env injection for `isHonkerEnabled`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const noopLog: Logger["info"] = () => {};
const NOOP_LOGGER: Logger = { info: noopLog, warn: noopLog, error: noopLog };

/** Default stub — T4 replaces with the real merge dispatch resolver. */
async function defaultHandler(_event: TaskDonePayload): Promise<HandlerOutcome> {
  return "skipped-not-mine";
}

/**
 * Drain pending `task.done` events for the gitter consumer, invoking
 * `deps.handler` (or the stubbed default) per event under at-least-once
 * idempotency. Returns the totals so callers can surface "N processed,
 * M escalated" without re-walking the offset table.
 *
 * Honker kill-switch short-circuit: when `ATMUX_HONKER` is off (the
 * default), the consumer logs once and returns zero totals so the
 * cron-only path stays untouched until the substrate flips on.
 *
 * Failure mode: a thrown handler is caught inside `withIdempotency` and
 * stops the drain at the failing event. The offset is NOT advanced
 * past it — the next sweep re-attempts. This function itself NEVER
 * throws on handler failure.
 */
export async function gitterConsume(
  deps: GitterConsumeDeps,
): Promise<{ processed: number; escalated: number }> {
  const consumerName = deps.consumerName ?? "atmux:gitter";
  const topics = deps.topics ?? (["task.done"] as const);
  const handler = deps.handler ?? defaultHandler;
  const logger = deps.logger ?? NOOP_LOGGER;

  if (!isHonkerEnabled(deps.env)) {
    logger.info("gitter-consumer: ATMUX_HONKER=off — fallback to cron-only path");
    return { processed: 0, escalated: 0 };
  }

  let processed = 0;
  let escalated = 0;

  await withIdempotency(
    deps.db,
    consumerName,
    deps.nowSec ? { topics, nowSec: deps.nowSec } : { topics },
    async (event) => {
      // task.done is the only topic we subscribe to by default; the
      // cast is safe under the discriminated-union narrow in T1.
      const outcome = await handler(event as TaskDonePayload);
      processed += 1;
      if (outcome === "escalated") escalated += 1;
    },
  );

  return { processed, escalated };
}

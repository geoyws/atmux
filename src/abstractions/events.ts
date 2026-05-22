// ADR-202 + ADR-203: Event emit + subscribe helpers for the Honker
// in-DB messaging substrate.
//
// Phase-1 substrate scope:
//
//   emit(db, payload, opts?)
//     - Validates payload via the Zod discriminated union (ADR-203 §D3).
//     - INSERTs into the events table — durability layer per ADR-202
//       §D6 (defense-in-depth cron-backstop sweep target). Writers
//       always durably persist regardless of Honker load state.
//     - When Honker is loaded, the future commit will also invoke the
//       native NOTIFY primitive here. Phase-1 stub: no-op (binary not
//       shipped). Stub is observable via the `opts.honkerLoaded` flag
//       so callers can pass the runtime state without reading globals.
//
//   drainSince(db, opts)
//     - Returns events with `event_id > lastEventId` for the given
//       topics, in lexicographic (i.e. creation-time) order per the
//       UUIDv7 ordering property (ADR-203 §D6).
//     - This is the cron-backstop sweep primitive — consumers invoke
//       it from their existing cron tick to drain any events they
//       haven't processed yet. Works in both Honker-loaded mode (as
//       a defense-in-depth catch-net) and fallback mode (as the
//       primary consumer path until live-stream subscription wires
//       up in Phase-2).
//
//   loadOffset(db, consumerName) / saveOffset(db, consumerName, eventId)
//     - At-least-once idempotency per ADR-203 §D7.
//     - consumerName is scope-qualified: `<team>:<consumer>` or
//       `cockpit:<consumer>`.
//
//   withIdempotency(db, consumerName, handler)
//     - Wrapper that loads the consumer's last offset, calls
//       `drainSince()` for the topics the handler cares about, and
//       updates the offset after each successful handle. Per ADR-203
//       §D7's "skipping the helper is a reviewer-class flag" — every
//       consumer subscribe path goes through this wrapper.
//
// Live-stream subscription (Honker NOTIFY/LISTEN registration) is
// deferred to Phase-2 when the extension binary lands. Until then,
// the events table is the source of truth + consumers poll via
// drainSince().

import type { Database } from "bun:sqlite";
import { EventPayload } from "../schema/events.ts";
import type { HonkerRuntimeState } from "./honker.ts";
import { uuidv7 } from "./uuidv7.ts";

/** Runtime state-flag passed by callers — wraps `HonkerRuntimeState.loaded`. */
export interface EmitOpts {
  /** True when `loadHonkerOrFallback()` reported `{loaded: true}`. */
  honkerLoaded?: boolean;
  /** Test-injection seam — override the UUIDv7 generator. */
  generateId?: () => string;
  /** Test-injection seam — override the now-second clock. */
  nowSec?: () => number;
}

/**
 * Validate, persist, and (when applicable) notify a typed event payload.
 *
 * Phase-1 contract: every call INSERTs into the events table. Honker
 * native NOTIFY is a future-stub controlled by `opts.honkerLoaded`.
 *
 * @param db      Open Database (per-team `state.db` or cockpit-events.db).
 * @param payload Event payload — must validate against the discriminated
 *                union in `src/schema/events.ts`. eventId + emittedAtSec
 *                may be omitted; helper fills them via UUIDv7 + Date.now.
 * @param opts    Runtime + test-injection knobs.
 *
 * @returns The fully-populated payload as INSERTed (including any
 *          generated eventId / emittedAtSec).
 */
export function emit(
  db: Database,
  payload: Omit<EventPayload, "eventId" | "emittedAtSec" | "schemaVersion"> & {
    eventId?: string;
    emittedAtSec?: number;
    schemaVersion?: 1;
  },
  opts: EmitOpts = {},
): EventPayload {
  const generateId = opts.generateId ?? uuidv7;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  // Materialize defaulted fields before Zod parse so the union's
  // discriminator + required-field checks see a complete shape.
  const filled = {
    ...payload,
    eventId: payload.eventId ?? generateId(),
    emittedAtSec: payload.emittedAtSec ?? nowSec(),
    schemaVersion: payload.schemaVersion ?? 1,
  };

  const validated = EventPayload.parse(filled);

  db.prepare(
    `INSERT INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    validated.eventId,
    validated.topic,
    JSON.stringify(validated),
    validated.emittedAtSec,
    validated.schemaVersion,
  );

  // Honker NOTIFY path: publish to the Honker stream so the substrate
  // emits a `_honker_notifications` row (channel `honker:stream:<topic>`)
  // — that's the wake-up signal `watchEvents()` listens for.
  //
  // The honker stream is a mirror, not the source of truth — the
  // `events` table INSERT above is durable + Zod-validated and remains
  // authoritative. The stream-publish is best-effort: a thrown error
  // here (substrate-internal hiccup) must not lose the event. Caller
  // already has the durable row.
  if (opts.honkerLoaded) {
    try {
      db.prepare("SELECT honker_stream_publish(?, ?, ?) AS r").get(
        validated.topic,
        validated.eventId,
        JSON.stringify(validated),
      );
    } catch {
      // Substrate degradation — durable INSERT already succeeded; the
      // cron-backstop drain (per ADR-202 §D6) catches consumers up.
    }
  }

  return validated;
}

/** Options for `drainSince()` — topic filter + offset cursor. */
export interface DrainOpts {
  /** Topics to drain. Empty array → drain every topic (fleet-wide). */
  topics: ReadonlyArray<string>;
  /** Lower-bound exclusive — drain rows with `event_id > lastEventId`. */
  lastEventId: string;
  /** Optional max-row cap to bound a single drain call. Default 1000. */
  limit?: number;
}

/**
 * Drain events newer than `lastEventId` matching `topics`, ordered by
 * `event_id` ASC (which is creation-time-ASC per UUIDv7's lexicographic
 * property — see ADR-203 §D6).
 *
 * @returns Parsed + validated event payloads. Rows with malformed
 *          payload JSON or Zod-validation failure are filtered out
 *          with the failure logged on the row (caller can opt to
 *          treat them as poison and skip past). Phase-1 simply skips
 *          bad rows; a stronger error mode lands when consumers need
 *          it.
 */
export function drainSince(db: Database, opts: DrainOpts): EventPayload[] {
  const limit = opts.limit ?? 1000;

  let query: string;
  let params: ReadonlyArray<string | number>;
  if (opts.topics.length === 0) {
    query = `SELECT event_id, payload FROM events
             WHERE event_id > ?
             ORDER BY event_id ASC
             LIMIT ?`;
    params = [opts.lastEventId, limit];
  } else {
    // SQLite doesn't bind arrays — interpolate via placeholders.
    const placeholders = opts.topics.map(() => "?").join(",");
    query = `SELECT event_id, payload FROM events
             WHERE event_id > ?
               AND topic IN (${placeholders})
             ORDER BY event_id ASC
             LIMIT ?`;
    params = [opts.lastEventId, ...opts.topics, limit];
  }

  const rows = db.prepare(query).all(...params) as Array<{
    event_id: string;
    payload: string;
  }>;

  const out: EventPayload[] = [];
  for (const row of rows) {
    try {
      const parsed = EventPayload.parse(JSON.parse(row.payload));
      out.push(parsed);
    } catch {
      // Poison row — skip past. Future cleanup-EPIC may add an
      // `events.poison_at` column for explicit dead-letter routing.
    }
  }
  return out;
}

/**
 * Load the last-processed eventId for a scope-qualified consumer per
 * ADR-203 §D7. Returns the lower-bound sentinel `""` when the consumer
 * has never run before (every UUIDv7 sorts higher than the empty string).
 *
 * @param db           Database whose `subscriber_offsets` table holds the row.
 * @param consumerName Scope-qualified consumer per ADR-203 §D7.
 */
export function loadOffset(db: Database, consumerName: string): string {
  const row = db
    .prepare("SELECT last_event_id FROM subscriber_offsets WHERE consumer_name = ?")
    .get(consumerName) as { last_event_id: string } | undefined;
  return row?.last_event_id ?? "";
}

/** Persist a consumer's last-processed eventId. Upsert semantics. */
export function saveOffset(
  db: Database,
  consumerName: string,
  eventId: string,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): void {
  db.prepare(
    `INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
     VALUES (?, ?, ?)
     ON CONFLICT(consumer_name) DO UPDATE SET
       last_event_id = excluded.last_event_id,
       last_processed_at_sec = excluded.last_processed_at_sec`,
  ).run(consumerName, eventId, nowSec());
}

/** Options for `withIdempotency()`. */
export interface IdempotencyOpts {
  /** Topics the handler subscribes to. */
  topics: ReadonlyArray<string>;
  /** Test-injection: override the now-second clock for offset saves. */
  nowSec?: () => number;
}

/**
 * Drain events for `consumerName` since its last offset, invoke
 * `handler` for each event in lexicographic ID order, and advance
 * the offset after every successful handle. At-least-once semantics
 * per ADR-203 §D7 — handler MUST be idempotent.
 *
 * If `handler` throws on an event, the offset is NOT advanced past
 * the failing event. The next call re-attempts the same event. After
 * three consecutive throws on the same event, the wrapper logs and
 * skips past (poison-skipping) to avoid infinite re-attempt loops;
 * a future cleanup-EPIC may add dead-letter routing.
 *
 * @returns The number of events successfully handled in this call.
 */
export async function withIdempotency(
  db: Database,
  consumerName: string,
  opts: IdempotencyOpts,
  handler: (event: EventPayload) => Promise<void> | void,
): Promise<number> {
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const last = loadOffset(db, consumerName);
  const batch = drainSince(db, { topics: opts.topics, lastEventId: last });

  let processed = 0;
  for (const event of batch) {
    try {
      await handler(event);
      saveOffset(db, consumerName, event.eventId, nowSec);
      processed += 1;
    } catch {
      // Stop the drain on first failure — caller's next sweep
      // re-attempts. Phase-1: no poison-skip counter yet.
      break;
    }
  }

  return processed;
}

// ---------- watchEvents (NOTIFY/LISTEN wake-up loop) ----------

/** Options for `watchEvents()` — topic filter + cancellation + cadence. */
export interface WatchEventsOpts {
  /** Topics to subscribe to. Empty array → all topics. */
  topics: ReadonlyArray<string>;
  /** Cancellation handle. Generator returns cleanly when aborted. */
  signal?: AbortSignal;
  /** Initial offset cursor (event_id). Default `""` (drain everything). */
  initialOffset?: string;
  /** Wake-cadence when Honker is loaded — checking `_honker_notifications`
   *  MAX(id) for new wake-ups. Default 100ms (~realtime feel, O(1) query). */
  honkerPollIntervalMs?: number;
  /** Wake-cadence when Honker is NOT loaded — direct events-table scan.
   *  Default 1500ms (cron-backstop-class latency). */
  fallbackPollIntervalMs?: number;
  /** True when `bootHonker()` reported `loaded: true` for this DB. */
  honkerLoaded?: boolean;
  /** Test seam — sleeper. Default uses `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam — max-drain batch size per wake. Default 1000. */
  drainBatchSize?: number;
  /** Async iterator of wake-up signals from an external listener (e.g.
   *  the `atmux-listener` Rust subprocess wrapping Honker's blocking
   *  `Database::listen`). When provided, the loop awaits this iterator
   *  instead of polling — true kernel-blocked wake (~1ms latency,
   *  ~0% idle CPU). Yields one item per notification; we ignore the
   *  value and drain the events table on each yield. The iterator's
   *  early return ends the watcher cleanly. */
  externalSignals?: AsyncIterable<string>;
  /** When `externalSignals` ends (parent listener died), wait this many
   *  ms before yielding control — gives the supervisor a window to
   *  respawn the listener. Default 0 (return immediately, caller decides). */
  externalSignalGapMs?: number;
}

/** Default sleep — honors AbortSignal so cancellation returns immediately. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Read the current MAX(id) from `_honker_notifications`. Returns 0 when
 *  the table doesn't exist (substrate booted but bootstrap skipped) or
 *  is empty. Used as a cheap wake-up cursor by `watchEvents()`. */
function readHonkerNotificationMaxId(db: Database): number {
  try {
    const row = db
      .prepare(
        "SELECT COALESCE(MAX(id), 0) AS m FROM _honker_notifications",
      )
      .get() as { m: number | null } | undefined;
    return row?.m ?? 0;
  } catch {
    // Table not present (e.g. honker not bootstrapped on this db) — fall
    // back to event-table polling cadence.
    return -1;
  }
}

/**
 * Async-iterator subscription to durable events. Yields one
 * {@link EventPayload} per new event in lexicographic ID order, then
 * sleeps until the next wake-up.
 *
 * **Wake-up strategy:**
 * - When `honkerLoaded` and the substrate's `_honker_notifications`
 *   table is queryable, the loop polls `MAX(id)` at `honkerPollIntervalMs`
 *   (default 100ms). This is an O(1) indexed lookup — effectively NOTIFY/
 *   LISTEN for our throughput (~100 events/day at peak per team).
 * - Otherwise the loop polls the events table directly at
 *   `fallbackPollIntervalMs` (default 1500ms). Same behavior consumers
 *   get under `ATMUX_HONKER=off`.
 *
 * **Cancellation:** pass an `AbortSignal`; the generator returns the
 * next time the inner sleep wakes (so within `pollIntervalMs` of the
 * abort, worst case). No outstanding DB handles are leaked — every
 * read is a single prepared statement on the caller's open Database.
 *
 * **Backlog drain:** on first iteration, drains every event with
 * `event_id > initialOffset`. So a consumer that crashed mid-batch can
 * reload its offset from `subscriber_offsets` and resume without
 * missing events. At-least-once semantics — handler MUST be idempotent.
 *
 * **No throws:** poison rows in `events.payload` are skipped (same
 * contract as `drainSince()`). DB errors propagate to the caller via
 * the generator's next() call.
 *
 * Usage:
 *
 *     const watcher = watchEvents(db, {
 *       topics: ["task.done"],
 *       signal: ac.signal,
 *       honkerLoaded: getHonkerState(db)?.loaded ?? false,
 *     });
 *     for await (const event of watcher) {
 *       await handler(event);
 *       saveOffset(db, consumerName, event.eventId);
 *     }
 */
export async function* watchEvents(
  db: Database,
  opts: WatchEventsOpts,
): AsyncGenerator<EventPayload, void, void> {
  const sleep = opts.sleep ?? defaultSleep;
  const honkerInterval = opts.honkerPollIntervalMs ?? 100;
  const fallbackInterval = opts.fallbackPollIntervalMs ?? 1500;
  const drainLimit = opts.drainBatchSize ?? 1000;
  let lastEventId = opts.initialOffset ?? "";
  let lastNotificationId = opts.honkerLoaded ? readHonkerNotificationMaxId(db) : -1;
  // useNotificationsTable: only relevant when honker is loaded AND the
  // table query succeeded on first probe. -1 means table absent → degrade
  // to events-table polling at the fallback cadence.
  let useNotificationsTable = opts.honkerLoaded === true && lastNotificationId >= 0;

  // First-pass: drain any backlog before entering the wait loop. Lets
  // callers cleanly resume from a saved offset.
  {
    const batch = drainSince(db, {
      topics: opts.topics,
      lastEventId,
      limit: drainLimit,
    });
    for (const event of batch) {
      if (opts.signal?.aborted) return;
      yield event;
      lastEventId = event.eventId;
    }
  }

  // External signal path (atmux-listener subprocess via Honker's
  // blocking Database::listen). When the caller provides a signal
  // iterator, we await it instead of polling — true kernel-blocked
  // wake, zero in-process polling.
  if (opts.externalSignals !== undefined) {
    try {
      for await (const _signal of opts.externalSignals) {
        if (opts.signal?.aborted) return;
        const batch = drainSince(db, {
          topics: opts.topics,
          lastEventId,
          limit: drainLimit,
        });
        for (const event of batch) {
          if (opts.signal?.aborted) return;
          yield event;
          lastEventId = event.eventId;
        }
      }
    } catch {
      // Iterator throw (subprocess died, broken pipe) — fall through to
      // poll mode below as graceful degradation. The caller's supervisor
      // can respawn the listener; meanwhile we keep events flowing.
    }
    if (opts.externalSignalGapMs && opts.externalSignalGapMs > 0) {
      await sleep(opts.externalSignalGapMs, opts.signal);
    }
    // Listener-stream ended — degrade to poll-mode for the rest of the
    // generator's life. Reset notification-baseline so we don't re-drain.
    lastNotificationId = opts.honkerLoaded ? readHonkerNotificationMaxId(db) : -1;
    useNotificationsTable = opts.honkerLoaded === true && lastNotificationId >= 0;
  }

  while (!opts.signal?.aborted) {
    if (useNotificationsTable) {
      // Cheap wake-up probe — MAX(id) on tiny indexed table.
      const currentMax = readHonkerNotificationMaxId(db);
      if (currentMax < 0) {
        // Table disappeared (substrate killed mid-run) — degrade.
        useNotificationsTable = false;
        continue;
      }
      if (currentMax === lastNotificationId) {
        await sleep(honkerInterval, opts.signal);
        continue;
      }
      lastNotificationId = currentMax;
    } else {
      await sleep(fallbackInterval, opts.signal);
      if (opts.signal?.aborted) return;
    }

    const batch = drainSince(db, {
      topics: opts.topics,
      lastEventId,
      limit: drainLimit,
    });
    for (const event of batch) {
      if (opts.signal?.aborted) return;
      yield event;
      lastEventId = event.eventId;
    }
  }
}

// ---------- bootHonker announce binding ----------

/**
 * Build an `AnnounceFn` (per src/abstractions/honker.ts) that emits an
 * `internal.honker.loaded` or `internal.honker.fallback` event when
 * `bootHonker()` reports its state. Pass to bootHonker as the third
 * argument:
 *
 *     const announce = announceHonkerState();
 *     bootHonker(db, {}, announce);
 *
 * The announce is best-effort: if the events table doesn't exist yet
 * (migrations haven't run), if Zod parsing fails, etc., the failure is
 * swallowed by bootHonker's announce try/catch — boot itself never
 * blocks on observability.
 *
 * Wired this way (rather than as a direct import of emit() inside
 * honker.ts) to keep honker.ts free of the schema/events.ts coupling
 * — same one-direction dependency rule as the rest of the abstractions
 * tier (honker → bun:sqlite; events → schema/events.ts + honker).
 */
export function announceHonkerState(emitOverride?: typeof emit): (
  db: Database,
  state: HonkerRuntimeState,
) => void {
  const emitFn = emitOverride ?? emit;
  return (db, state) => {
    if (state.loaded) {
      emitFn(db, {
        topic: "internal.honker.loaded",
        extensionPath: state.extensionPath ?? "",
      });
    } else {
      emitFn(db, {
        topic: "internal.honker.fallback",
        fallbackReason: state.fallbackReason ?? "kill-switch off",
        extensionPath: state.extensionPath,
      });
    }
  };
}

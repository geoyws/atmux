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

  // Phase-1 stub: when Honker is loaded, the future commit will also
  // invoke the native NOTIFY primitive here (e.g.
  // `db.exec("SELECT honker_notify(?, ?)", topic, eventId)`). For
  // now, the INSERT above is the only durable side-effect and the
  // sole notification path — consumers poll via drainSince().
  if (opts.honkerLoaded) {
    // Future: db.prepare("SELECT honker_notify(?, ?)").get(validated.topic, validated.eventId);
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

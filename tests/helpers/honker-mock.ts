// ADR-231 / ADR-202 — Honker subscription mock for Phase 2 handler unit
// tests (S3.1, t-16-27fdc08b). Pinned by the ADR-224 §D6 registry
// contract (`src/core/event-subscriptions.ts`, formerly
// `orchd-registry.ts` — slimmed by ADR-276) `EventSubscription`:
//
//   - At-least-once delivery semantics. Per-`consumerId` offsets advance
//     ONLY after the handler returns successfully — handler throw leaves
//     the offset put + the same event is redelivered on the next drain.
//   - Multi-handler-per-topic supported (distinct `consumerId`s). Each
//     handler tracks its own dispatch cursor.
//   - Cross-topic ordering is NOT guaranteed (mirrors the real
//     contract — `src/core/event-subscriptions.ts` module comment).
//
// The mock is in-memory + synchronous. Real `_honker_notifications`
// table reads / NOTIFY/LISTEN polling are out of scope — this stands in
// for the dispatch layer so handlers can be unit-tested in isolation
// from the substrate.

import type { EventPayload } from "../../src/schema/events.ts";
import type { EventSubscription } from "../../src/core/event-subscriptions.ts";

/** A single published event held in the mock's in-memory log.
 *  `sequence` is monotonic + assigned at publish time; it stands in for
 *  the lexicographic event_id ordering UUIDv7 gives in production. */
export interface PublishedEvent {
  readonly sequence: number;
  readonly topic: string;
  readonly payload: EventPayload;
}

/** Per-consumer drain outcome — what handlers were called, what threw. */
export interface DrainResult {
  readonly consumerId: string;
  readonly topic: string;
  readonly delivered: number;
  readonly failed: number;
  /** Each entry: the event the handler refused, plus the thrown error
   *  (re-raised on next drain since the offset stayed put). */
  readonly errors: ReadonlyArray<{ readonly event: PublishedEvent; readonly error: unknown }>;
}

/**
 * Helper to construct a fully-valid EventPayload from a partial input —
 * fills `eventId` (synthetic monotonic), `emittedAtSec` (now), and
 * `schemaVersion: 1` so tests can write `mock.publish({ topic: "...", ... })`
 * without ceremonially populating every base field on every call.
 *
 * The output is NOT Zod-parsed here — `publish()` accepts unvalidated
 * payloads because the mock is the dispatch layer, not the validator
 * (production validates at `emit()` in src/abstractions/events.ts). Tests
 * that want to exercise validation should parse via `EventPayload.parse`
 * before passing in.
 */
export function buildPayload<T extends { topic: string }>(input: T): T & {
  eventId: string;
  emittedAtSec: number;
  schemaVersion: 1;
} {
  return {
    eventId: input["eventId" as keyof T] as string | undefined ??
      `evt-${Math.random().toString(36).slice(2, 10)}`,
    emittedAtSec: input["emittedAtSec" as keyof T] as number | undefined ??
      Math.floor(Date.now() / 1000),
    schemaVersion: 1,
    ...input,
  } as T & { eventId: string; emittedAtSec: number; schemaVersion: 1 };
}

/** The mock dispatch layer. One per test (tests should construct a
 *  fresh instance per `beforeEach` to avoid cross-test leakage). */
export class HonkerMock {
  private events: PublishedEvent[] = [];
  private subscribers = new Map<string, EventSubscription>();
  /** Per-consumer offset — sequence of the last successfully-handled
   *  event. Drains skip events with `sequence <= offset`. */
  private offsets = new Map<string, number>();
  private nextSequence = 1;

  /** Register a subscriber. Idempotent: re-registering the same
   *  `consumerId` is a no-op (returns `false`). Mirrors
   *  `registerEventSubscription` in src/core/event-subscriptions.ts. */
  register(sub: EventSubscription): boolean {
    if (this.subscribers.has(sub.consumerId)) return false;
    this.subscribers.set(sub.consumerId, sub);
    if (!this.offsets.has(sub.consumerId)) this.offsets.set(sub.consumerId, 0);
    return true;
  }

  /** Publish an event. Assigns the next monotonic sequence. */
  publish(payload: EventPayload): PublishedEvent {
    const event: PublishedEvent = {
      sequence: this.nextSequence++,
      topic: payload.topic,
      payload,
    };
    this.events.push(event);
    return event;
  }

  /**
   * Drain pending events to one (or all) subscribers. Returns one
   * {@link DrainResult} per consumer drained.
   *
   * Per-consumer drain loop:
   *   1. Find pending events: `sequence > offset[consumerId]` AND
   *      `topic === subscription.topic`.
   *   2. Invoke handler in sequence order.
   *   3. On handler resolve: advance offset to that event's sequence.
   *   4. On handler throw: stop drain for this consumer (offset stays
   *      put → redelivery on next drain). Mirrors `withIdempotency`
   *      stop-on-first-failure semantics from src/abstractions/events.ts.
   */
  async drain(consumerId?: string): Promise<DrainResult[]> {
    const targets = consumerId !== undefined
      ? (this.subscribers.has(consumerId) ? [consumerId] : [])
      : Array.from(this.subscribers.keys());

    const results: DrainResult[] = [];
    for (const cid of targets) {
      const sub = this.subscribers.get(cid)!;
      const offset = this.offsets.get(cid) ?? 0;
      const pending = this.events.filter(
        (e) => e.sequence > offset && e.topic === sub.topic,
      );

      let delivered = 0;
      let failed = 0;
      const errors: Array<{ event: PublishedEvent; error: unknown }> = [];

      for (const event of pending) {
        try {
          await sub.handler(event.payload);
          this.offsets.set(cid, event.sequence);
          delivered += 1;
        } catch (error) {
          failed += 1;
          errors.push({ event, error });
          // Stop drain — offset stays at last successful sequence so
          // re-delivery on next drain picks up at this same event.
          break;
        }
      }

      results.push({ consumerId: cid, topic: sub.topic, delivered, failed, errors });
    }
    return results;
  }

  /** Current advanced offset for a consumer. Pending events have
   *  `sequence > getOffset(consumerId)`. */
  getOffset(consumerId: string): number {
    return this.offsets.get(consumerId) ?? 0;
  }

  /** All published events, in publish order. Tests can assert on the
   *  log shape (count, ordering, payload contents). */
  getEvents(): readonly PublishedEvent[] {
    return this.events;
  }

  /** Registered subscribers — read-only view. */
  getSubscribers(): readonly EventSubscription[] {
    return Array.from(this.subscribers.values());
  }

  /** Hard reset — drop every event, subscriber, and offset. Use between
   *  test cases when not constructing a fresh instance in `beforeEach`. */
  reset(): void {
    this.events = [];
    this.subscribers.clear();
    this.offsets.clear();
    this.nextSequence = 1;
  }
}

/** Sugar for `new HonkerMock()` — mirrors test conventions elsewhere
 *  (e.g. `createFlagSpy()` in atmux-flag-spy.ts). */
export function createHonkerMock(): HonkerMock {
  return new HonkerMock();
}

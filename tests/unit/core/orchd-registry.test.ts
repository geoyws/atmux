// Unit tests for src/core/orchd-registry.ts — ADR-224 §D6 Phase 1 seam.

import { afterEach, describe, expect, test } from "bun:test";
import {
  type OrchdSubscription,
  ORCHD_SUBSCRIPTIONS,
  findOrchdSubscriptionsByTopic,
  registerOrchdSubscription,
  visitOrchdSubscriptions,
} from "../../../src/core/orchd-registry.ts";

function snapshot(): OrchdSubscription[] {
  return [...ORCHD_SUBSCRIPTIONS];
}

function restore(prev: OrchdSubscription[]): void {
  ORCHD_SUBSCRIPTIONS.length = 0;
  ORCHD_SUBSCRIPTIONS.push(...prev);
}

const NOOP_HANDLER: OrchdSubscription["handler"] = async () => {
  // intentionally empty — Phase 1 has no real handlers
};

describe("ORCHD_SUBSCRIPTIONS", () => {
  test("Phase 1 ships an empty array (zero handlers, no behavior change)", () => {
    expect(ORCHD_SUBSCRIPTIONS).toEqual([]);
  });

  test("array is the runtime registration surface (mutable)", () => {
    // Plain mutable array per ADR-224 §D6 — Phase 2 modules push at
    // load time. This test guards against accidental Object.freeze.
    const prev = snapshot();
    try {
      ORCHD_SUBSCRIPTIONS.push({
        topic: "test.topic",
        consumerId: "atmux:orchd:test",
        handler: NOOP_HANDLER,
      });
      expect(ORCHD_SUBSCRIPTIONS).toHaveLength(1);
    } finally {
      restore(prev);
    }
    expect(ORCHD_SUBSCRIPTIONS).toEqual([]);
  });
});

describe("registerOrchdSubscription", () => {
  afterEach(() => {
    ORCHD_SUBSCRIPTIONS.length = 0;
  });

  test("pushes a new subscription and returns true", () => {
    const sub: OrchdSubscription = {
      topic: "epic.added",
      consumerId: "atmux:orchd:spawn",
      handler: NOOP_HANDLER,
    };
    expect(registerOrchdSubscription(sub)).toBe(true);
    expect(ORCHD_SUBSCRIPTIONS).toContain(sub);
  });

  test("idempotent on duplicate consumerId — returns false, no second push", () => {
    const a: OrchdSubscription = {
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker",
      handler: NOOP_HANDLER,
    };
    const b: OrchdSubscription = {
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker", // same consumerId
      handler: NOOP_HANDLER,
    };
    expect(registerOrchdSubscription(a)).toBe(true);
    expect(registerOrchdSubscription(b)).toBe(false);
    expect(ORCHD_SUBSCRIPTIONS).toHaveLength(1);
  });

  test("multiple handlers on the same topic with distinct consumerIds both register", () => {
    // Per ADR-224 §D6: multi-handler-per-topic is supported (e.g. solo-
    // worker dissolve + auto-merge both subscribe to `task.done`).
    const dissolve: OrchdSubscription = {
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker",
      handler: NOOP_HANDLER,
    };
    const automerge: OrchdSubscription = {
      topic: "task.done",
      consumerId: "atmux:orchd:auto-merge",
      handler: NOOP_HANDLER,
    };
    expect(registerOrchdSubscription(dissolve)).toBe(true);
    expect(registerOrchdSubscription(automerge)).toBe(true);
    expect(ORCHD_SUBSCRIPTIONS).toHaveLength(2);
  });
});

describe("findOrchdSubscriptionsByTopic", () => {
  afterEach(() => {
    ORCHD_SUBSCRIPTIONS.length = 0;
  });

  test("empty registry → empty array", () => {
    expect(findOrchdSubscriptionsByTopic("anything")).toEqual([]);
  });

  test("returns every subscription whose topic matches (multi-handler safe)", () => {
    registerOrchdSubscription({
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker",
      handler: NOOP_HANDLER,
    });
    registerOrchdSubscription({
      topic: "task.done",
      consumerId: "atmux:orchd:auto-merge",
      handler: NOOP_HANDLER,
    });
    registerOrchdSubscription({
      topic: "epic.added",
      consumerId: "atmux:orchd:spawn",
      handler: NOOP_HANDLER,
    });
    const matches = findOrchdSubscriptionsByTopic("task.done");
    expect(matches).toHaveLength(2);
    expect(matches.map((s) => s.consumerId).sort()).toEqual([
      "atmux:orchd:auto-merge",
      "atmux:orchd:dissolve-worker",
    ]);
  });

  test("non-matching topic returns empty array, never undefined", () => {
    registerOrchdSubscription({
      topic: "epic.added",
      consumerId: "atmux:orchd:spawn",
      handler: NOOP_HANDLER,
    });
    const out = findOrchdSubscriptionsByTopic("nonexistent.topic");
    expect(out).toEqual([]);
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("visitOrchdSubscriptions", () => {
  afterEach(() => {
    ORCHD_SUBSCRIPTIONS.length = 0;
  });

  test("Phase 1 empty array → visitor fires zero times, returns 0", () => {
    let calls = 0;
    const count = visitOrchdSubscriptions(() => {
      calls += 1;
    });
    expect(count).toBe(0);
    expect(calls).toBe(0);
  });

  test("visits every registered subscription exactly once", () => {
    registerOrchdSubscription({
      topic: "epic.added",
      consumerId: "atmux:orchd:spawn",
      handler: NOOP_HANDLER,
    });
    registerOrchdSubscription({
      topic: "task.done",
      consumerId: "atmux:orchd:dissolve-worker",
      handler: NOOP_HANDLER,
    });
    const seen: string[] = [];
    const count = visitOrchdSubscriptions((sub) => {
      seen.push(sub.consumerId);
    });
    expect(count).toBe(2);
    expect(seen.sort()).toEqual([
      "atmux:orchd:dissolve-worker",
      "atmux:orchd:spawn",
    ]);
  });
});

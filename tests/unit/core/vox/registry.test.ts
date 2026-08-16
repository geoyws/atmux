// Unit tests for src/core/vox/registry.ts — ADR-272 single-session
// registry (latest-wins + park/resume).
//
// Pins:
//   - At most one current session; claim replaces the slot and invokes
//     the old session's onTakeover (live OR parked).
//   - park → tryResume within graceMs succeeds (boundary inclusive);
//     past graceMs reads "expired" and drops the slot.
//   - Expiry is lazy — current() observes it as null; no timers.
//   - release is a no-op unless the id is current.

import { describe, expect, test } from "bun:test";
import { createSessionRegistry } from "../../../../src/core/vox/registry.ts";

function makeRegistry(startMs = 1_000, graceMs = 5_000) {
  let now = startMs;
  const registry = createSessionRegistry({ clock: () => now, graceMs });
  return { registry, setNow: (ms: number) => (now = ms) };
}

function takeoverSpy() {
  const calls = { count: 0 };
  return { calls, onTakeover: () => (calls.count += 1) };
}

describe("claim", () => {
  test("claim makes the session current + live", () => {
    const { registry } = makeRegistry();
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    expect(registry.current()).toEqual({ sessionId: "s1", state: "live" });
  });

  test("latest-wins: claiming over a live session invokes its onTakeover", () => {
    const { registry } = makeRegistry();
    const old = takeoverSpy();
    const fresh = takeoverSpy();
    registry.claim({ sessionId: "s1", onTakeover: old.onTakeover });
    registry.claim({ sessionId: "s2", onTakeover: fresh.onTakeover });
    expect(old.calls.count).toBe(1);
    expect(fresh.calls.count).toBe(0);
    expect(registry.current()).toEqual({ sessionId: "s2", state: "live" });
  });

  test("claiming over a PARKED session also invokes its onTakeover", () => {
    const { registry } = makeRegistry();
    const old = takeoverSpy();
    registry.claim({ sessionId: "s1", onTakeover: old.onTakeover });
    registry.park("s1");
    registry.claim({ sessionId: "s2", onTakeover: () => {} });
    expect(old.calls.count).toBe(1);
    expect(registry.current()).toEqual({ sessionId: "s2", state: "live" });
  });

  test("re-claiming the same id notifies the previous holder (stale socket)", () => {
    const { registry } = makeRegistry();
    const old = takeoverSpy();
    registry.claim({ sessionId: "s1", onTakeover: old.onTakeover });
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    expect(old.calls.count).toBe(1);
    expect(registry.current()).toEqual({ sessionId: "s1", state: "live" });
  });
});

describe("park + tryResume", () => {
  test("park marks the current session parked at clock()", () => {
    const { registry, setNow } = makeRegistry();
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    setNow(2_500);
    registry.park("s1");
    expect(registry.current()).toEqual({ sessionId: "s1", state: "parked", parkedAtMs: 2_500 });
  });

  test("park is a no-op for a non-current id", () => {
    const { registry } = makeRegistry();
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("other");
    expect(registry.current()).toEqual({ sessionId: "s1", state: "live" });
  });

  test("re-parking an already-parked session does not refresh the park time", () => {
    const { registry, setNow } = makeRegistry();
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    setNow(2_000);
    registry.park("s1");
    setNow(4_000);
    registry.park("s1");
    expect(registry.current()).toEqual({ sessionId: "s1", state: "parked", parkedAtMs: 2_000 });
  });

  test("tryResume within grace succeeds and revives the session", () => {
    const { registry, setNow } = makeRegistry(1_000, 5_000);
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("s1");
    setNow(5_999);
    expect(registry.tryResume("s1")).toEqual({ ok: true });
    expect(registry.current()).toEqual({ sessionId: "s1", state: "live" });
  });

  test("grace boundary is inclusive: resume at exactly parkedAt + graceMs", () => {
    const { registry, setNow } = makeRegistry(1_000, 5_000);
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("s1"); // parked at 1_000
    setNow(6_000);
    expect(registry.tryResume("s1")).toEqual({ ok: true });
  });

  test("past grace → expired, slot dropped, id not resurrectable", () => {
    const { registry, setNow } = makeRegistry(1_000, 5_000);
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("s1"); // parked at 1_000
    setNow(6_001);
    expect(registry.tryResume("s1")).toEqual({ ok: false, reason: "expired" });
    expect(registry.current()).toBeNull();
    expect(registry.tryResume("s1")).toEqual({ ok: false, reason: "unknown" });
  });

  test("unknown id → unknown (empty registry and wrong id)", () => {
    const { registry } = makeRegistry();
    expect(registry.tryResume("nope")).toEqual({ ok: false, reason: "unknown" });
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("s1");
    expect(registry.tryResume("other")).toEqual({ ok: false, reason: "unknown" });
  });

  test("live session → not-parked", () => {
    const { registry } = makeRegistry();
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    expect(registry.tryResume("s1")).toEqual({ ok: false, reason: "not-parked" });
  });
});

describe("current — lazy expiry", () => {
  test("empty registry → null", () => {
    const { registry } = makeRegistry();
    expect(registry.current()).toBeNull();
  });

  test("parked past grace reads null without any timer", () => {
    const { registry, setNow } = makeRegistry(1_000, 5_000);
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("s1");
    setNow(6_001);
    expect(registry.current()).toBeNull();
    expect(registry.current()).toBeNull(); // stays dropped
  });

  test("parked within grace reports parkedAtMs", () => {
    const { registry, setNow } = makeRegistry(1_000, 5_000);
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.park("s1");
    setNow(6_000);
    expect(registry.current()).toEqual({ sessionId: "s1", state: "parked", parkedAtMs: 1_000 });
  });
});

describe("release", () => {
  test("release of the current session clears the slot without onTakeover", () => {
    const { registry } = makeRegistry();
    const spy = takeoverSpy();
    registry.claim({ sessionId: "s1", onTakeover: spy.onTakeover });
    registry.release("s1");
    expect(registry.current()).toBeNull();
    expect(spy.calls.count).toBe(0);
  });

  test("release of a non-current id is a no-op", () => {
    const { registry } = makeRegistry();
    registry.claim({ sessionId: "s1", onTakeover: () => {} });
    registry.release("other");
    expect(registry.current()).toEqual({ sessionId: "s1", state: "live" });
  });

  test("release on an empty registry is a no-op", () => {
    const { registry } = makeRegistry();
    registry.release("s1");
    expect(registry.current()).toBeNull();
  });
});

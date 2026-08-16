// Unit tests for src/core/vox/confirm.ts — ADR-272 server-enforced
// mutation confirmation.
//
// Pins:
//   - Token binds tool + canonicalJson(args) + sessionId; any other
//     binding at redeem is a mismatch.
//   - Single-use: ANY found redeem burns the token (success, expiry,
//     mismatch) — replay reads "unknown".
//   - Expiry is lazy at redeem (reason "expired") and pruned on every
//     issue (pruned tokens read "unknown", not "expired").
//   - canonicalJson sorts object keys recursively; arrays keep order.

import { describe, expect, test } from "bun:test";
import { canonicalJson, createConfirmStore } from "../../../../src/core/vox/confirm.ts";

const BINDING = {
  tool: "kanban.move",
  argsJson: '{"taskId":"t-1","to":"done"}',
  sessionId: "sess-a",
};

function makeStore(startMs = 1_000, ttlMs = 5_000) {
  let now = startMs;
  const store = createConfirmStore({ clock: () => now, ttlMs });
  return { store, setNow: (ms: number) => (now = ms) };
}

describe("canonicalJson", () => {
  test.each([
    ["number", 42, "42"],
    ["string", "x", '"x"'],
    ["null", null, "null"],
    ["true", true, "true"],
    ["undefined (top level)", undefined, "null"],
    ["empty object", {}, "{}"],
    ["empty array", [], "[]"],
  ])("%s", (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  test("object keys sort recursively; arrays keep order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });

  test("key order in the input does not change the output", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  test("undefined array slots render as null; undefined object values drop", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("issue → redeem", () => {
  test("issue returns a 32-hex token + expiresAtMs = now + ttlMs; redeem ok", () => {
    const { store } = makeStore(1_000, 5_000);
    const issued = store.issue(BINDING);
    expect(issued.token).toMatch(/^[0-9a-f]{32}$/);
    expect(issued.expiresAtMs).toBe(6_000);
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: true });
  });

  test("distinct issues get distinct tokens", () => {
    const { store } = makeStore();
    expect(store.issue(BINDING).token).not.toBe(store.issue(BINDING).token);
  });

  test("args key order does not matter (canonical binding)", () => {
    const { store } = makeStore();
    const issued = store.issue({ ...BINDING, argsJson: '{"to":"done","taskId":"t-1"}' });
    expect(
      store.redeem(issued.token, { ...BINDING, argsJson: '{"taskId":"t-1","to":"done"}' }),
    ).toEqual({ ok: true });
  });

  test("unparseable argsJson falls back to raw-string binding, still deterministic", () => {
    const { store } = makeStore();
    const raw = "not-json{{{";
    const issued = store.issue({ ...BINDING, argsJson: raw });
    const issued2 = store.issue({ ...BINDING, argsJson: "other-garbage" });
    expect(store.redeem(issued.token, { ...BINDING, argsJson: raw })).toEqual({ ok: true });
    expect(store.redeem(issued2.token, { ...BINDING, argsJson: raw })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("unknown token → unknown", () => {
    const { store } = makeStore();
    expect(store.redeem("deadbeefdeadbeefdeadbeefdeadbeef", BINDING)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });
});

describe("single-use", () => {
  test("replay after successful redeem → unknown", () => {
    const { store } = makeStore();
    const issued = store.issue(BINDING);
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: true });
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: false, reason: "unknown" });
  });

  test("a mismatch burns the token — later correct redeem reads unknown", () => {
    const { store } = makeStore();
    const issued = store.issue(BINDING);
    expect(store.redeem(issued.token, { ...BINDING, tool: "kanban.delete" })).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("binding mismatches", () => {
  test.each([
    ["tool", { ...BINDING, tool: "kanban.delete" }],
    ["args", { ...BINDING, argsJson: '{"taskId":"t-2","to":"done"}' }],
    ["session", { ...BINDING, sessionId: "sess-b" }],
  ])("different %s → mismatch", (_name, other) => {
    const { store } = makeStore();
    const issued = store.issue(BINDING);
    expect(store.redeem(issued.token, other)).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("expiry (fake clock, no timers)", () => {
  test("redeem just under the TTL boundary succeeds", () => {
    const { store, setNow } = makeStore(1_000, 5_000);
    const issued = store.issue(BINDING);
    setNow(5_999);
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: true });
  });

  test("redeem at expiresAtMs → expired; replay → unknown (burned)", () => {
    const { store, setNow } = makeStore(1_000, 5_000);
    const issued = store.issue(BINDING);
    setNow(issued.expiresAtMs);
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: false, reason: "expired" });
    expect(store.redeem(issued.token, BINDING)).toEqual({ ok: false, reason: "unknown" });
  });

  test("issue prunes expired entries — pruned token reads unknown, not expired", () => {
    const { store, setNow } = makeStore(1_000, 5_000);
    const stale = store.issue(BINDING);
    setNow(7_000); // stale expired at 6_000
    store.issue({ ...BINDING, sessionId: "sess-b" }); // prune sweep runs here
    expect(store.redeem(stale.token, BINDING)).toEqual({ ok: false, reason: "unknown" });
  });

  test("issue does not prune live entries", () => {
    const { store, setNow } = makeStore(1_000, 5_000);
    const a = store.issue(BINDING);
    setNow(3_000);
    store.issue({ ...BINDING, sessionId: "sess-b" });
    expect(store.redeem(a.token, BINDING)).toEqual({ ok: true });
  });
});

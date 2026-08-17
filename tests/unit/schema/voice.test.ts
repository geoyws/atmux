// Unit tests for src/schema/voice.ts — ADR-272 JSON control-frame schemas.
//
// Pins:
//   - Discriminated union on `type` for both directions; unknown types
//     and wrong-shape payloads fail parse.
//   - `.passthrough()` round-trips unknown fields (events.ts precedent).
//   - parseClientFrame NEVER throws — garbage in, Result out.
//   - VOICE_CLOSE codes are the client contract — exact values asserted.

import { describe, expect, test } from "bun:test";
import {
  ClientFrame,
  parseClientFrame,
  ServerFrame,
  VOICE_CLOSE,
} from "../../../src/schema/voice.ts";

describe("VOICE_CLOSE", () => {
  test("exact pinned close codes (client contract)", () => {
    expect(VOICE_CLOSE.PROTOCOL).toBe(4400);
    expect(VOICE_CLOSE.AUTH).toBe(4401);
    expect(VOICE_CLOSE.ORIGIN).toBe(4403);
    expect(VOICE_CLOSE.HELLO_TIMEOUT).toBe(4408);
    expect(VOICE_CLOSE.RATE_LIMITED).toBe(4429);
    expect(VOICE_CLOSE.TAKEOVER).toBe(4001);
    expect(VOICE_CLOSE.PROVIDER).toBe(4500);
    expect(VOICE_CLOSE.NORMAL).toBe(1000);
    expect(Object.keys(VOICE_CLOSE).length).toBe(8);
  });

  test("frozen", () => {
    expect(Object.isFrozen(VOICE_CLOSE)).toBe(true);
  });
});

describe("ClientFrame — every type parses", () => {
  test.each([
    ["hello (minimal)", { type: "hello", v: 1, token: "tok", mode: "ptt" }],
    [
      "hello (full)",
      {
        type: "hello",
        v: 1,
        token: "tok",
        mode: "vad",
        resume: "sess-1",
        team: "atmux",
        ua: "pwa/1.0",
      },
    ],
    ["ptt down", { type: "ptt", down: true }],
    ["ptt up", { type: "ptt", down: false }],
    ["mode ptt", { type: "mode", mode: "ptt" }],
    ["mode vad", { type: "mode", mode: "vad" }],
    ["cancel", { type: "cancel" }],
    ["team", { type: "team", team: "atmux" }],
    ["text", { type: "text", text: "deploy the thing" }],
    ["text at max length", { type: "text", text: "x".repeat(2000) }],
    ["suspend", { type: "suspend" }],
    ["ping bare", { type: "ping" }],
    ["ping with t", { type: "ping", t: 1234 }],
  ])("%s", (_name, frame) => {
    const parsed = ClientFrame.parse(frame);
    expect(parsed.type).toBe((frame as { type: string }).type as typeof parsed.type);
  });

  test.each([
    ["unknown type", { type: "nope" }],
    ["hello wrong protocol version", { type: "hello", v: 2, token: "t", mode: "ptt" }],
    ["hello missing token", { type: "hello", v: 1, mode: "ptt" }],
    ["hello bad mode", { type: "hello", v: 1, token: "t", mode: "walkie" }],
    ["ptt missing down", { type: "ptt" }],
    ["ptt non-boolean down", { type: "ptt", down: "yes" }],
    ["mode missing mode", { type: "mode" }],
    ["team missing team", { type: "team" }],
    ["text empty", { type: "text", text: "" }],
    ["text over 2000 chars", { type: "text", text: "x".repeat(2001) }],
    ["ping non-number t", { type: "ping", t: "now" }],
    ["missing type entirely", { down: true }],
  ])("rejects %s", (_name, frame) => {
    expect(() => ClientFrame.parse(frame)).toThrow();
  });

  test("passthrough: unknown fields survive parse", () => {
    const parsed = ClientFrame.parse({ type: "ptt", down: true, futureField: "kept" });
    expect((parsed as Record<string, unknown>).futureField).toBe("kept");
  });
});

const READY = {
  type: "ready",
  sessionId: "sess-1",
  resumed: false,
  provider: "openai",
  model: "gpt-realtime",
  team: "atmux",
  teams: ["atmux", "sopx"],
  rates: { in: 24000, out: 24000 },
  frameMs: 40,
  vad: false,
  readonly: false,
};

describe("ServerFrame — every type parses", () => {
  test.each([
    ["ready", READY],
    ["ready with null team", { ...READY, team: null }],
    ["status", { type: "status", state: "listening" }],
    ["transcript.user", { type: "transcript.user", id: "u1", text: "hi", final: false }],
    ["transcript.assistant", { type: "transcript.assistant", id: "a1", text: "yo", final: true }],
    ["tool.start", { type: "tool.start", id: "c1", name: "kanban.list", args: '{"team":"x"}' }],
    ["tool.done", { type: "tool.done", id: "c1", ok: true, summary: "3 tasks", ms: 120 }],
    [
      "tool.done needing confirmation",
      {
        type: "tool.done",
        id: "c2",
        ok: true,
        summary: "will move t-1",
        ms: 5,
        needs_confirmation: true,
      },
    ],
    ["audio.clear", { type: "audio.clear", reason: "barge-in" }],
    ["takeover", { type: "takeover" }],
    ["error minimal", { type: "error", code: "provider-down", fatal: true }],
    ["error with message", { type: "error", code: "rate", fatal: false, message: "slow down" }],
    ["pong bare", { type: "pong" }],
    ["pong with t", { type: "pong", t: 99 }],
  ])("%s", (_name, frame) => {
    const parsed = ServerFrame.parse(frame);
    expect(parsed.type).toBe((frame as { type: string }).type as typeof parsed.type);
  });

  test.each([
    ["unknown type", { type: "shout" }],
    ["ready missing sessionId", { ...READY, sessionId: undefined }],
    ["ready missing rates", { ...READY, rates: undefined }],
    ["ready non-array teams", { ...READY, teams: "atmux" }],
    ["status bad state", { type: "status", state: "sleeping" }],
    ["transcript.user missing final", { type: "transcript.user", id: "u1", text: "hi" }],
    [
      "tool.start args over 200 chars",
      { type: "tool.start", id: "c1", name: "n", args: "x".repeat(201) },
    ],
    ["tool.done missing ms", { type: "tool.done", id: "c1", ok: true, summary: "s" }],
    ["audio.clear missing reason", { type: "audio.clear" }],
    ["error missing fatal", { type: "error", code: "x" }],
  ])("rejects %s", (_name, frame) => {
    expect(() => ServerFrame.parse(frame)).toThrow();
  });

  test("passthrough: unknown fields survive parse", () => {
    const parsed = ServerFrame.parse({ ...READY, extra: 42 });
    expect((parsed as Record<string, unknown>).extra).toBe(42);
  });
});

describe("parseClientFrame", () => {
  test("valid frame → ok with narrowed type", () => {
    const r = parseClientFrame('{"type":"hello","v":1,"token":"tok","mode":"ptt"}');
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    expect(r.frame.type).toBe("hello");
    if (r.frame.type === "hello") expect(r.frame.token).toBe("tok");
  });

  test("passthrough survives parseClientFrame", () => {
    const r = parseClientFrame('{"type":"ping","t":1,"future":"kept"}');
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    expect((r.frame as Record<string, unknown>).future).toBe("kept");
  });

  const GARBAGE = [
    "",
    "not json",
    "{",
    '{"type":}',
    "null",
    "[]",
    "42",
    '"a string"',
    "{}",
    '{"type":"nope"}',
    '{"type":"text","text":""}',
  ];

  test.each(GARBAGE.map((g) => [g]))("never throws, returns error: %j", (text) => {
    expect(() => parseClientFrame(text)).not.toThrow();
    const r = parseClientFrame(text);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  test("malformed JSON reports malformed JSON, schema miss reports the issue path", () => {
    const malformed = parseClientFrame("{oops");
    if (malformed.ok) throw new Error("expected failure");
    expect(malformed.error).toBe("malformed JSON");
    const miss = parseClientFrame('{"type":"text","text":""}');
    if (miss.ok) throw new Error("expected failure");
    expect(miss.error).toContain("text");
  });
});

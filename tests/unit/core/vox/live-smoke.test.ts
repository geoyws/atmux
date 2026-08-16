// Unit tests for src/core/vox/live-smoke.ts — ADR-272 §Supplement.
//
// **The smoke itself is opt-in and dials a real provider. These tests do
// not.** The provider is an injected fake, so what is covered here is the
// ORCHESTRATION — which is the half that can be wrong in a way that makes
// the live run lie:
//
//   - A green verdict requires BOTH `session-ready` AND downlink bytes.
//     `session-ready` alone is exactly the shape of the fault the
//     `no session-ready within 12000ms` log line was added for, one step
//     later: a provider that accepts the socket, negotiates, and then
//     says nothing. A smoke that passed on the event alone would be
//     green for a broken adapter.
//   - The prompt is sent only AFTER `session-ready`. Asking a session
//     that never negotiated proves nothing about the negotiation.
//   - Nothing throws: a connect failure, a provider error and a timeout
//     are all reported as `ok: false` with a readable `failure`.

import { describe, expect, test } from "bun:test";
import type {
  VoiceEvent,
  VoiceProvider,
  VoiceSession,
  VoiceSessionOpts,
} from "../../../../src/abstractions/voice-provider.ts";
import {
  formatLiveSmoke,
  type LiveSmokeResult,
  runLiveSmoke,
  SMOKE_INSTRUCTIONS,
  SMOKE_PROMPT,
  SMOKE_TIMEOUT_MS_DEFAULT,
  smokeSessionOpts,
} from "../../../../src/core/vox/live-smoke.ts";

interface FakeOpts {
  events: VoiceEvent[];
  connectThrows?: Error;
}

interface Fake {
  provider: VoiceProvider;
  sentText: string[];
  connectOpts: VoiceSessionOpts[];
  closed: number;
  /** Order of significant calls — proves the prompt follows ready. */
  calls: string[];
}

function fakeProvider(opts: FakeOpts): Fake {
  const fake: Fake = {
    sentText: [],
    connectOpts: [],
    closed: 0,
    calls: [],
    provider: {
      kind: "openai-realtime",
      connect: async (_cfg, sessionOpts) => {
        if (opts.connectThrows !== undefined) throw opts.connectThrows;
        fake.connectOpts.push(sessionOpts);
        fake.calls.push("connect");
        return session;
      },
    },
  };
  const queued = [...opts.events];
  const session: VoiceSession = {
    sendAudio: () => {},
    endTurn: () => {},
    sendText: (t: string) => {
      fake.sentText.push(t);
      fake.calls.push("sendText");
    },
    sendToolResult: () => {},
    interrupt: () => {},
    events: async function* () {
      for (const ev of queued) {
        fake.calls.push(`event:${ev.type}`);
        yield ev;
      }
    },
    close: async () => {
      fake.closed += 1;
      fake.calls.push("close");
    },
  };
  return fake;
}

const CFG = { apiKey: "sk-secret-value", model: "gpt-realtime" };

/** A clock that advances a little on every read, so the verdict loop
 *  always terminates even when the fake never satisfies it. */
function tickingClock(stepMs = 1_000): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

const NO_SLEEP = async (): Promise<void> => {};

describe("smokeSessionOpts", () => {
  test("push-to-talk, no tools — this exercises the transport, not the bridge", () => {
    const o = smokeSessionOpts();
    expect(o.turnDetection).toEqual({ mode: "ptt" });
    expect(o.tools).toEqual([]);
    expect(o.instructions).toBe(SMOKE_INSTRUCTIONS);
  });

  test("the instructions demand SPOKEN output, because the assertion is on audio bytes", () => {
    expect(SMOKE_INSTRUCTIONS.toLowerCase()).toContain("out loud");
    expect(SMOKE_PROMPT.length).toBeGreaterThan(0);
  });
});

describe("runLiveSmoke — the green path", () => {
  test("ready + downlink audio → ok, with the byte count as evidence", async () => {
    const fake = fakeProvider({
      events: [
        { type: "session-ready" },
        { type: "audio-out", pcm: new Uint8Array(1920) },
        { type: "audio-out", pcm: new Uint8Array(960) },
        { type: "transcript", role: "assistant", id: "a", text: "ready", final: true },
        { type: "closed", code: 1000, reason: "done" },
      ],
    });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
    });
    expect(r.ok).toBe(true);
    expect(r.sessionReady).toBe(true);
    expect(r.downlinkFrames).toBe(2);
    expect(r.downlinkBytes).toBe(2880);
    expect(r.transcript).toBe("ready");
    expect(r.failure).toBeNull();
    expect(fake.closed).toBe(1);
  });

  test("the prompt is sent AFTER session-ready, never before", async () => {
    const fake = fakeProvider({
      events: [
        { type: "session-ready" },
        { type: "audio-out", pcm: new Uint8Array(4) },
        { type: "closed", code: 1000, reason: "done" },
      ],
    });
    await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
    });
    expect(fake.sentText).toEqual([SMOKE_PROMPT]);
    expect(fake.calls.indexOf("event:session-ready")).toBeLessThan(fake.calls.indexOf("sendText"));
  });

  test("it dials with the smoke session opts", async () => {
    const fake = fakeProvider({
      events: [
        { type: "session-ready" },
        { type: "audio-out", pcm: new Uint8Array(4) },
        { type: "closed", code: 1000, reason: "" },
      ],
    });
    await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
    });
    expect(fake.connectOpts[0]).toEqual(smokeSessionOpts());
  });
});

describe("runLiveSmoke — every red path is a verdict, never a throw", () => {
  test("session-ready but ZERO downlink bytes is a FAILURE, not a pass", async () => {
    // The single most important assertion in this file. A provider that
    // negotiates and then says nothing is a real, observed fault class;
    // a smoke that accepted `session-ready` alone would be green for it.
    const fake = fakeProvider({
      events: [{ type: "session-ready" }, { type: "closed", code: 1000, reason: "" }],
    });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.sessionReady).toBe(true);
    expect(r.failure).toContain("NO downlink audio");
  });

  test("no session-ready at all → a failure that names the negotiation", async () => {
    const fake = fakeProvider({ events: [{ type: "closed", code: 4000, reason: "nope" }] });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.sessionReady).toBe(false);
    expect(r.failure).toContain("never negotiated");
  });

  test("a provider error is recorded and becomes the reported failure", async () => {
    const fake = fakeProvider({
      events: [
        {
          type: "provider-error",
          message: "beta shape disabled",
          fatal: true,
          code: "beta_api_shape_disabled",
        },
        { type: "closed", code: 4000, reason: "" },
      ],
    });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    // The provider's own error CODE survives — it is the one token that
    // names the fault class (the 2026-08-15 dial failure).
    expect(r.failure).toContain("beta_api_shape_disabled");
  });

  test("a provider error with no code still reads", async () => {
    const fake = fakeProvider({
      events: [
        { type: "provider-error", message: "unspecified", fatal: false },
        { type: "closed", code: 1000, reason: "" },
      ],
    });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
      timeoutMs: 5_000,
    });
    expect(r.failure).toBe("provider error: unspecified");
  });

  test("a connect failure is a verdict, not an exception", async () => {
    const fake = fakeProvider({ events: [], connectThrows: new Error("ECONNREFUSED") });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("connect failed: ECONNREFUSED");
    expect(r.elapsedMs).toBeGreaterThan(0);
  });

  test("a non-Error connect throw still yields a readable failure", async () => {
    const fake = fakeProvider({ events: [] });
    fake.provider = {
      kind: "gemini-live",
      connect: async () => {
        throw "just a string";
      },
    };
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
    });
    expect(r.failure).toContain("just a string");
  });

  test("unrecognised event types are ignored rather than fatal", async () => {
    const fake = fakeProvider({
      events: [
        { type: "speech-started" },
        { type: "turn-complete" },
        { type: "transcript", role: "user", id: "u", text: "hello", final: true },
        { type: "session-ready" },
        { type: "audio-out", pcm: new Uint8Array(8) },
        { type: "closed", code: 1000, reason: "" },
      ],
    });
    const r = await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
    });
    expect(r.ok).toBe(true);
    // A USER transcript is not the assistant's — it must not be counted.
    expect(r.transcript).toBe("");
  });

  test("the log sink receives the story and never the key", async () => {
    const lines: string[] = [];
    const fake = fakeProvider({
      events: [
        { type: "session-ready" },
        { type: "audio-out", pcm: new Uint8Array(4) },
        { type: "closed", code: 1000, reason: "bye" },
      ],
    });
    await runLiveSmoke({
      provider: fake.provider,
      cfg: CFG,
      clock: tickingClock(),
      sleep: NO_SLEEP,
      log: (l) => lines.push(l),
    });
    expect(lines).toContain("session-ready");
    for (const l of lines) expect(l).not.toContain(CFG.apiKey);
  });

  test("the default timeout is bounded, so an unattended run cannot hang", () => {
    expect(SMOKE_TIMEOUT_MS_DEFAULT).toBeGreaterThan(0);
    expect(SMOKE_TIMEOUT_MS_DEFAULT).toBeLessThanOrEqual(120_000);
  });
});

describe("production defaults (real clock, real sleeper, no log sink)", () => {
  test("runs to a green verdict with nothing injected but the provider", async () => {
    // Drives the default `clock`, the default `sleep` (a real 40ms
    // timer) and the default no-op `log`. Bounded so a regression that
    // stopped satisfying the verdict fails fast instead of hanging for
    // the full default budget.
    const fake = fakeProvider({
      events: [
        { type: "session-ready" },
        { type: "audio-out", pcm: new Uint8Array(64) },
        { type: "closed", code: 1000, reason: "" },
      ],
    });
    const r = await runLiveSmoke({ provider: fake.provider, cfg: CFG, timeoutMs: 3_000 });
    expect(r.ok).toBe(true);
    expect(r.downlinkBytes).toBe(64);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("formatLiveSmoke", () => {
  const base: LiveSmokeResult = {
    ok: true,
    kind: "openai-realtime",
    model: "gpt-realtime",
    sessionReady: true,
    downlinkBytes: 2880,
    downlinkFrames: 2,
    transcript: "ready",
    elapsedMs: 1234,
    failure: null,
  };

  test("carries the two assertions the smoke actually makes", () => {
    const line = formatLiveSmoke(base);
    expect(line).toContain("ok=true");
    expect(line).toContain("sessionReady=true");
    expect(line).toContain("downlinkBytes=2880");
  });

  test("a failure is spelled out rather than implied by ok=false", () => {
    expect(formatLiveSmoke({ ...base, ok: false, failure: "no downlink" })).toContain(
      "failure=no downlink",
    );
  });

  test("an empty transcript is omitted rather than printed as blank", () => {
    expect(formatLiveSmoke({ ...base, transcript: "" })).not.toContain("transcript=");
  });

  test("a long transcript is truncated so one line stays one line", () => {
    const line = formatLiveSmoke({ ...base, transcript: "x".repeat(500) });
    expect(line.length).toBeLessThan(300);
  });
});

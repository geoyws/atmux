// Unit tests for src/abstractions/voice/gemini-live.ts (ADR-272).
//
// Everything runs against the local scripted Bun.serve fixture
// (tests/helpers/ws-fixture.ts) with a fake API key — no real network, no
// real credentials. Wire shapes are asserted deeply (byte shape of the setup
// frame in both turn-detection modes, and every outbound verb); uplink audio
// is asserted equal to `createDecimator24to16` output including
// chunk-continuity across arbitrary (odd-byte) splits; the connect error
// path is asserted key-redacted.

import { describe, expect, test } from "bun:test";
import {
  GEMINI_LIVE_BASE_URL,
  geminiLiveProvider,
  geminiLiveUrl,
  sanitizeForGemini,
  setupPayload,
} from "../../../../src/abstractions/voice/gemini-live.ts";
import type {
  VoiceEvent,
  VoiceJsonSchema,
  VoiceProviderConfig,
  VoiceSessionOpts,
} from "../../../../src/abstractions/voice-provider.ts";
import { DEFAULT_OPEN_TIMEOUT_MS } from "../../../../src/abstractions/websocket.ts";
import { createDecimator24to16 } from "../../../../src/core/vox/audio.ts";
import { VoiceProviderError } from "../../../../src/errors.ts";
import { FakeWebSocket, startWsFixture, type WsFixture } from "../../../helpers/ws-fixture.ts";

const FAKE_KEY = "AIza-test-fake-key";
const MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";

/** Tool whose parameters carry the two keys Gemini rejects — the setup frame
 *  must arrive with both stripped and everything else intact. */
const DIRTY_TOOL = {
  name: "run_verb",
  description: "Run an atmux verb",
  parameters: {
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      verb: { type: "string", description: "verb name" },
      lane: { type: "integer" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["verb"],
  },
} as const;

/** The DIRTY_TOOL functionDeclaration as it must appear on the wire. */
const CLEAN_DECLARATION = {
  name: "run_verb",
  description: "Run an atmux verb",
  parameters: {
    type: "object",
    properties: {
      verb: { type: "string", description: "verb name" },
      lane: { type: "integer" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["verb"],
  },
};

const PTT_OPTS: VoiceSessionOpts = {
  instructions: "You are the atmux vox operator.",
  tools: [DIRTY_TOOL],
  turnDetection: { mode: "ptt" },
};

const VAD_OPTS: VoiceSessionOpts = {
  instructions: "vad session",
  tools: [],
  turnDetection: {
    mode: "server-vad",
    threshold: 0.7,
    prefixPaddingMs: 220,
    silenceDurationMs: 400,
  },
  voice: "Puck",
};

function cfgFor(fx: WsFixture, extra?: Partial<VoiceProviderConfig>): VoiceProviderConfig {
  return { apiKey: FAKE_KEY, model: MODEL, baseUrl: fx.url, ...extra };
}

function int16Bytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Deterministic 480-sample (20ms @ 24kHz) PCM16 test pattern. */
function makePattern(): Int16Array {
  const pattern = new Int16Array(480);
  for (let i = 0; i < pattern.length; i++) {
    pattern[i] = Math.round(12000 * Math.sin(i / 7)) + (i % 13);
  }
  return pattern;
}

/** Concatenate the decoded payload of every `realtimeInput.audio` frame. */
function concatAudioFrames(fx: WsFixture): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const frame of fx.received) {
    const parsed = JSON.parse(frame as string) as {
      realtimeInput?: { audio?: { mimeType?: string; data?: string } };
    };
    const data = parsed.realtimeInput?.audio?.data;
    if (data !== undefined) parts.push(new Uint8Array(Buffer.from(data, "base64")));
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Connect, feed `frames` to the client, close, and collect every event. */
async function collectSessionEvents(
  fx: WsFixture,
  frames: ReadonlyArray<string | Uint8Array>,
): Promise<VoiceEvent[]> {
  const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
  await fx.waitForReceived(1); // setup landed → socket is fully up
  for (const frame of frames) {
    fx.sendToLast(frame);
  }
  fx.closeAll(1000, "test done");
  const out: VoiceEvent[] = [];
  for await (const event of session.events()) {
    out.push(event);
  }
  return out;
}

/** Drop the trailing `closed` event (asserted separately where relevant). */
function withoutClosed(events: VoiceEvent[]): VoiceEvent[] {
  return events.filter((e) => e.type !== "closed");
}

describe("geminiLiveUrl", () => {
  test("defaults to the production BidiGenerateContent endpoint with ?key=", () => {
    expect(geminiLiveUrl({ apiKey: "k1" })).toBe(`${GEMINI_LIVE_BASE_URL}?key=k1`);
  });

  test("uses baseUrl override and URI-encodes the key", () => {
    expect(geminiLiveUrl({ baseUrl: "ws://localhost:9", apiKey: "a b/c" })).toBe(
      "ws://localhost:9?key=a%20b%2Fc",
    );
  });
});

describe("sanitizeForGemini", () => {
  test("strips $schema + additionalProperties; keeps properties/required/enum intact", () => {
    expect(sanitizeForGemini(DIRTY_TOOL.parameters)).toEqual(CLEAN_DECLARATION.parameters);
  });

  test("recursively defensive: strips nested keys, inside arrays too, passthrough scalars", () => {
    const weird = {
      type: "object",
      properties: {
        x: {
          type: "string",
          enum: ["a"],
          nested: { additionalProperties: true, $schema: "x", keep: null },
          list: [{ additionalProperties: false, keep: 1 }, "scalar", 2],
        },
      },
    } as unknown as VoiceJsonSchema;
    expect(sanitizeForGemini(weird)).toEqual({
      type: "object",
      properties: {
        x: {
          type: "string",
          enum: ["a"],
          nested: { keep: null },
          list: [{ keep: 1 }, "scalar", 2],
        },
      },
    });
  });
});

describe("handshake", () => {
  test("key rides the URL (not headers); model rides the setup frame (not the URL)", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      const conn = fx.connections[0];
      expect(conn?.url).toContain(`?key=${FAKE_KEY}`);
      expect(conn?.url).not.toContain(MODEL);
      expect(conn?.headers.authorization).toBeUndefined();
      expect(conn?.protocols).toEqual([]);
      const setup = JSON.parse(fx.received[0] as string) as { setup: { model: string } };
      expect(setup.setup.model).toBe(`models/${MODEL}`);
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("setup wire shape — ptt: activity detection disabled, tools sanitized, no speechConfig", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      expect(JSON.parse(fx.received[0] as string)).toEqual({
        setup: {
          model: `models/${MODEL}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: { parts: [{ text: "You are the atmux vox operator." }] },
          tools: [{ functionDeclarations: [CLEAN_DECLARATION] }],
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  // NOTE (F5): this asserts a KNOWN LIMITATION, not desired behavior.
  // VAD_OPTS carries `threshold: 0.7`, and the wire shape below has NO
  // threshold in it — Gemini exposes coarse sensitivity enums instead, so a
  // caller's numeric tuning is silently dropped on this provider. The
  // hardcoded enums are the documented stand-in (see the `ponytail:` marker
  // in setupPayload for the ceiling + upgrade path). If threshold plumbing
  // ever lands in P7, this expectation SHOULD fail and must be rewritten.
  test("setup wire shape — server-vad: hardcoded sensitivity enums (threshold DROPPED), padding passthrough + voice", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), VAD_OPTS);
      await fx.waitForReceived(1);
      expect(JSON.parse(fx.received[0] as string)).toEqual({
        setup: {
          model: `models/${MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } } },
          },
          systemInstruction: { parts: [{ text: "vad session" }] },
          // S3: no `tools` key at all — VAD_OPTS has an empty tool list, and
          // an empty functionDeclarations array risks INVALID_ARGUMENT.
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
              endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
              prefixPaddingMs: 220,
              silenceDurationMs: 400,
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      });
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("setupPayload is a pure function of model + opts (unit shape check)", () => {
    const payload = setupPayload("m", PTT_OPTS) as { setup: { model: string } };
    expect(payload.setup.model).toBe("models/m");
  });

  test("wsFactory seam is honored (no real socket constructed)", async () => {
    const fake = new FakeWebSocket();
    let seenUrl = "";
    const pending = geminiLiveProvider.connect(
      {
        apiKey: FAKE_KEY,
        model: MODEL,
        baseUrl: "ws://unreachable.invalid",
        wsFactory: (url) => {
          seenUrl = url;
          return fake;
        },
      },
      PTT_OPTS,
    );
    fake.fireOpen();
    const session = await pending;
    expect(seenUrl).toBe(`ws://unreachable.invalid?key=${FAKE_KEY}`);
    expect(fake.sent.length).toBe(1); // setup went through the fake
    const closing = session.close();
    fake.fireClose(1000, "bye");
    await closing;
  });
});

describe("uplink audio — 24k→16k decimation", () => {
  test("one-shot sendAudio equals createDecimator24to16 applied to the pattern", async () => {
    const fx = startWsFixture();
    try {
      const pattern = makePattern();
      const expected = int16Bytes(createDecimator24to16().process(pattern));
      const session = await geminiLiveProvider.connect(cfgFor(fx), VAD_OPTS);
      await fx.waitForReceived(1);
      session.sendAudio(int16Bytes(pattern));
      await fx.waitForReceived(2);
      const frame = JSON.parse(fx.received[1] as string) as {
        realtimeInput: { audio: { mimeType: string; data: string } };
      };
      expect(frame.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
      expect(frame.realtimeInput.audio.data).toBe(Buffer.from(expected).toString("base64"));
      expect(expected.byteLength).toBe(640); // 480 samples in → 320 out (2:3)
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("chunk-split (odd-byte boundaries included) concatenates to identical wire bytes", async () => {
    const fx = startWsFixture();
    try {
      const pattern = makePattern();
      const bytes = int16Bytes(pattern);
      const expected = int16Bytes(createDecimator24to16().process(pattern));
      const session = await geminiLiveProvider.connect(cfgFor(fx), VAD_OPTS);
      await fx.waitForReceived(1);
      // Splits chosen to hit: sample-aligned chunks, a chunk yielding ZERO
      // output samples (3rd), and odd-byte splits exercising the byte-carry.
      const cuts = [0, 2, 4, 6, 9, 13, bytes.byteLength];
      for (let i = 0; i < cuts.length - 1; i++) {
        session.sendAudio(bytes.subarray(cuts[i] as number, cuts[i + 1] as number));
      }
      await fx.waitForReceived(6);
      // 6 sendAudio calls but only 5 audio frames: the 3rd chunk adds a
      // sample without completing a new output sample, so it emits nothing
      // rather than a zero-length frame. setup + 5 = 6 frames total.
      expect(fx.received.length).toBe(6);
      expect(concatAudioFrames(fx)).toEqual(expected);
      await session.close();
    } finally {
      await fx.stop();
    }
  });
});

describe("ptt activity markers", () => {
  test("activityStart precedes first audio; endTurn sends activityEnd; re-arms across two turns", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      const samples = new Int16Array([100, 200, 300]);
      const chunk = int16Bytes(samples);
      // The decimator is stateful ACROSS turns (activity markers are a
      // control-plane concern, not an audio reset), so turn 2's expected
      // bytes come from the same decimator fed the same sequence.
      const reference = createDecimator24to16();
      const expected1 = int16Bytes(reference.process(samples));
      const expected2 = int16Bytes(reference.process(samples));
      session.sendAudio(chunk); // → activityStart + audio
      session.endTurn(); // → activityEnd
      session.sendAudio(chunk); // → activityStart + audio (re-armed)
      session.endTurn(); // → activityEnd
      await fx.waitForReceived(7);
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        realtimeInput: { activityStart: {} },
      });
      expect(JSON.parse(fx.received[2] as string)).toEqual({
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: Buffer.from(expected1).toString("base64"),
          },
        },
      });
      expect(JSON.parse(fx.received[3] as string)).toEqual({ realtimeInput: { activityEnd: {} } });
      expect(JSON.parse(fx.received[4] as string)).toEqual({
        realtimeInput: { activityStart: {} },
      });
      expect(JSON.parse(fx.received[5] as string)).toEqual({
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: Buffer.from(expected2).toString("base64"),
          },
        },
      });
      expect(JSON.parse(fx.received[6] as string)).toEqual({ realtimeInput: { activityEnd: {} } });
      expect(fx.received.length).toBe(7);
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("endTurn with no audio sent is a no-op (no unmatched activityEnd)", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      session.endTurn();
      session.endTurn();
      session.sendText("probe"); // sentinel proving no frame preceded it
      await fx.waitForReceived(2);
      expect(fx.received.length).toBe(2);
      expect(JSON.parse(fx.received[1] as string)).toHaveProperty("clientContent");
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("F2: an empty/tiny chunk does NOT arm the turn (no stray interrupting activityStart)", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      // Gemini's default activityHandling is START_OF_ACTIVITY_INTERRUPTS, so
      // an activityStart with no audio behind it interrupts a live response
      // for nothing. P4 may hand us an empty buffer — it must be inert.
      session.sendAudio(new Uint8Array(0));
      session.sendAudio(new Uint8Array(1)); // one byte: no whole sample yet
      session.sendText("probe"); // sentinel proving nothing preceded it
      await fx.waitForReceived(2);
      expect(fx.received.length).toBe(2); // setup + probe ONLY
      expect(JSON.parse(fx.received[1] as string)).toHaveProperty("clientContent");
      // And endTurn stays a no-op, since no turn was ever armed.
      session.endTurn();
      session.sendText("probe2");
      await fx.waitForReceived(3);
      expect(fx.received.length).toBe(3);
      expect(JSON.parse(fx.received[2] as string)).toHaveProperty("clientContent");
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("server-vad mode: no activity markers on sendAudio; endTurn is a no-op", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), VAD_OPTS);
      await fx.waitForReceived(1);
      session.sendAudio(int16Bytes(new Int16Array([1, 2, 3])));
      session.endTurn();
      session.sendText("probe");
      await fx.waitForReceived(3);
      expect(fx.received.length).toBe(3); // setup + audio + probe: no markers
      expect(JSON.parse(fx.received[1] as string)).toHaveProperty("realtimeInput");
      expect(JSON.parse(fx.received[2] as string)).toHaveProperty("clientContent");
      await session.close();
    } finally {
      await fx.stop();
    }
  });
});

describe("outbound verbs — wire shapes", () => {
  test("sendText serializes to a turnComplete clientContent frame", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      session.sendText("status of driver-2?");
      await fx.waitForReceived(2);
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "status of driver-2?" }] }],
          turnComplete: true,
        },
      });
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("sendToolResult — unannounced callId omits name (nothing truthful to send)", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      session.sendToolResult("fc_1", '{"ok":true,"lanes":3}');
      session.sendToolResult("fc_2", "not json at all");
      session.sendToolResult("fc_3", "[1,2]");
      session.sendToolResult("fc_4", "null");
      await fx.waitForReceived(5);
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        toolResponse: {
          functionResponses: [{ id: "fc_1", response: { ok: true, lanes: 3 } }],
        },
      });
      expect(JSON.parse(fx.received[2] as string)).toEqual({
        toolResponse: {
          functionResponses: [{ id: "fc_2", response: { output: "not json at all" } }],
        },
      });
      expect(JSON.parse(fx.received[3] as string)).toEqual({
        toolResponse: { functionResponses: [{ id: "fc_3", response: { output: "[1,2]" } }] },
      });
      expect(JSON.parse(fx.received[4] as string)).toEqual({
        toolResponse: { functionResponses: [{ id: "fc_4", response: { output: "null" } }] },
      });
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("interrupt() is a documented no-op — nothing hits the wire", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      session.interrupt();
      session.sendText("probe");
      await fx.waitForReceived(2);
      expect(fx.received.length).toBe(2); // setup + probe only
      await session.close();
    } finally {
      await fx.stop();
    }
  });
});

describe("inbound mapping", () => {
  test("setupComplete → session-ready, emitted once", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ setupComplete: {} }),
          JSON.stringify({ setupComplete: {} }),
        ]),
      );
      expect(events).toEqual([{ type: "session-ready" }]);
    } finally {
      await fx.stop();
    }
  });

  test("modelTurn inlineData: audio mime decodes (24k passthrough); non-audio/absent ignored; missing data → empty pcm", async () => {
    const fx = startWsFixture();
    try {
      const b64 = Buffer.from([9, 8, 7]).toString("base64");
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            serverContent: {
              modelTurn: {
                parts: [
                  { inlineData: { mimeType: "audio/pcm;rate=24000", data: b64 } },
                  { inlineData: { mimeType: "image/png", data: "AAAA" } },
                  {},
                  { inlineData: { mimeType: "audio/pcm" } },
                ],
              },
            },
          }),
        ]),
      );
      expect(events).toEqual([
        { type: "audio-out", pcm: new Uint8Array([9, 8, 7]) },
        { type: "audio-out", pcm: new Uint8Array(0) },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("transcripts accumulate per turn with stable ids and flush final on turnComplete", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ serverContent: { inputTranscription: { text: "sta" } } }),
          JSON.stringify({ serverContent: { inputTranscription: { text: "tus" } } }),
          JSON.stringify({ serverContent: { outputTranscription: { text: "three " } } }),
          JSON.stringify({ serverContent: { outputTranscription: { text: "lanes" } } }),
          JSON.stringify({ serverContent: { turnComplete: true } }),
          JSON.stringify({ serverContent: { inputTranscription: {} } }), // no text → no event
          JSON.stringify({ serverContent: { inputTranscription: { text: "next" } } }),
          JSON.stringify({ serverContent: { turnComplete: true } }),
        ]),
      );
      expect(events).toEqual([
        { type: "transcript", role: "user", id: "user-1", text: "sta", final: false },
        { type: "transcript", role: "user", id: "user-1", text: "tus", final: false },
        { type: "transcript", role: "assistant", id: "assistant-1", text: "three ", final: false },
        { type: "transcript", role: "assistant", id: "assistant-1", text: "lanes", final: false },
        { type: "transcript", role: "user", id: "user-1", text: "status", final: true },
        {
          type: "transcript",
          role: "assistant",
          id: "assistant-1",
          text: "three lanes",
          final: true,
        },
        { type: "turn-complete" },
        { type: "transcript", role: "user", id: "user-2", text: "next", final: false },
        { type: "transcript", role: "user", id: "user-2", text: "next", final: true },
        { type: "turn-complete" },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("turnComplete with empty accumulators emits only turn-complete", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [JSON.stringify({ serverContent: { turnComplete: true } })]),
      );
      expect(events).toEqual([{ type: "turn-complete" }]);
    } finally {
      await fx.stop();
    }
  });

  test("interrupted flushes the partial as final and closes the turn (second reset trigger)", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ serverContent: { outputTranscription: { text: "half a sent" } } }),
          JSON.stringify({ serverContent: { interrupted: true } }),
          JSON.stringify({ serverContent: { turnComplete: true } }),
        ]),
      );
      expect(events).toEqual([
        {
          type: "transcript",
          role: "assistant",
          id: "assistant-1",
          text: "half a sent",
          final: false,
        },
        // Flushed at the interrupt — the half-spoken turn is not lost, and
        // the turn closes here so it cannot bleed into the next one.
        {
          type: "transcript",
          role: "assistant",
          id: "assistant-1",
          text: "half a sent",
          final: true,
        },
        { type: "speech-started" },
        // turnComplete still arrives; accumulators are already empty.
        { type: "turn-complete" },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("interrupt WITHOUT a following turnComplete cannot bleed into the next turn", async () => {
    const fx = startWsFixture();
    try {
      // The anomaly case: native-audio models are reported to drop the
      // turnComplete after an interrupt. Turn 2 must start clean regardless.
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ serverContent: { outputTranscription: { text: "turn one" } } }),
          JSON.stringify({ serverContent: { interrupted: true } }),
          JSON.stringify({ serverContent: { outputTranscription: { text: "turn two" } } }),
          JSON.stringify({ serverContent: { turnComplete: true } }),
        ]),
      );
      expect(events).toEqual([
        {
          type: "transcript",
          role: "assistant",
          id: "assistant-1",
          text: "turn one",
          final: false,
        },
        { type: "transcript", role: "assistant", id: "assistant-1", text: "turn one", final: true },
        { type: "speech-started" },
        // New id, and "turn one" is absent from turn 2's final.
        {
          type: "transcript",
          role: "assistant",
          id: "assistant-2",
          text: "turn two",
          final: false,
        },
        { type: "transcript", role: "assistant", id: "assistant-2", text: "turn two", final: true },
        { type: "turn-complete" },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("combined serverContent frame maps in order: partial, audio, finals, turn-complete", async () => {
    const fx = startWsFixture();
    try {
      const b64 = Buffer.from([1, 2]).toString("base64");
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: b64 } }] },
              outputTranscription: { text: "hi" },
              turnComplete: true,
            },
          }),
        ]),
      );
      expect(events).toEqual([
        { type: "transcript", role: "assistant", id: "assistant-1", text: "hi", final: false },
        { type: "audio-out", pcm: new Uint8Array([1, 2]) },
        { type: "transcript", role: "assistant", id: "assistant-1", text: "hi", final: true },
        { type: "turn-complete" },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("toolCall.functionCalls → one tool-call event per entry; sparse entries map to empty strings", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            toolCall: {
              functionCalls: [
                { id: "fc1", name: "run_verb", args: { verb: "status", lane: 2 } },
                { id: "fc2", name: "noop" },
                {},
              ],
            },
          }),
        ]),
      );
      expect(events).toEqual([
        { type: "tool-call", id: "fc1", name: "run_verb", argsJson: '{"verb":"status","lane":2}' },
        { type: "tool-call", id: "fc2", name: "noop", argsJson: "" },
        { type: "tool-call", id: "", name: "", argsJson: "" },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("tool round-trip: inbound toolCall answered via sendToolResult lands on the wire", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      fx.sendToLast(
        JSON.stringify({
          toolCall: { functionCalls: [{ id: "fc_42", name: "run_verb", args: { verb: "pulse" } }] },
        }),
      );
      const iterator = session.events()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toEqual({
        type: "tool-call",
        id: "fc_42",
        name: "run_verb",
        argsJson: '{"verb":"pulse"}',
      });
      session.sendToolResult("fc_42", '{"lanes":3}');
      await fx.waitForReceived(2);
      // `name` is re-attached from the announcing toolCall — Gemini's
      // FunctionResponse requires it and the neutral seam does not carry it.
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        toolResponse: {
          functionResponses: [{ id: "fc_42", name: "run_verb", response: { lanes: 3 } }],
        },
      });
      await session.close();
      const rest: VoiceEvent[] = [];
      let step = await iterator.next();
      while (step.done !== true) {
        rest.push(step.value);
        step = await iterator.next();
      }
      expect(rest.at(-1)?.type).toBe("closed");
    } finally {
      await fx.stop();
    }
  });

  test("a nameless toolCall announcement attaches no name to its reply", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      fx.sendToLast(JSON.stringify({ toolCall: { functionCalls: [{ id: "fc_nameless" }] } }));
      const iterator = session.events()[Symbol.asyncIterator]();
      await iterator.next(); // drain the tool-call event so the pairing is recorded
      session.sendToolResult("fc_nameless", '{"ok":true}');
      await fx.waitForReceived(2);
      // An empty name is not a name — omitted rather than sent as "".
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        toolResponse: { functionResponses: [{ id: "fc_nameless", response: { ok: true } }] },
      });
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("F1 case A: a bad-TYPE turnComplete does NOT suppress audio in the same frame", async () => {
    const fx = startWsFixture();
    try {
      const b64 = Buffer.from([4, 5, 6]).toString("base64");
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: b64 } }] },
              turnComplete: "true", // string, not boolean — the drift case
            },
          }),
        ]),
      );
      // The audio survives; only the malformed branch is skipped.
      expect(events).toEqual([{ type: "audio-out", pcm: new Uint8Array([4, 5, 6]) }]);
    } finally {
      await fx.stop();
    }
  });

  test("F1 case B: a bad-TYPE goAway does NOT suppress session-ready (hang guard)", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ setupComplete: {}, goAway: "closing" }), // goAway is a string
        ]),
      );
      // session-ready MUST still arrive — without it the session layer waits
      // forever. goAway still warns, just without a timeLeft.
      expect(events).toEqual([
        { type: "session-ready" },
        {
          type: "provider-error",
          code: "go_away",
          message: "provider goAway — connection closing soon",
          fatal: false,
        },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("F1: bad-TYPE sub-branches are skipped individually, good siblings still map", async () => {
    const fx = startWsFixture();
    try {
      const b64 = Buffer.from([7]).toString("base64");
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            serverContent: {
              inputTranscription: "nope", // wrong type
              outputTranscription: { text: "kept" }, // fine
              modelTurn: { parts: "nope" }, // wrong type
              interrupted: 1, // wrong type — not `true`
            },
          }),
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: "audio/x", data: b64 } }] },
            },
          }),
          JSON.stringify({ toolCall: { functionCalls: ["nope", { id: "ok", name: "n" }] } }),
          JSON.stringify({ serverContent: "nope" }), // whole branch bad → skipped
        ]),
      );
      expect(events).toEqual([
        { type: "transcript", role: "assistant", id: "assistant-1", text: "kept", final: false },
        { type: "audio-out", pcm: new Uint8Array([7]) },
        { type: "tool-call", id: "ok", name: "n", argsJson: "" },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("toolCallCancellation, usageMetadata, and unknown messages are ignored", async () => {
    const fx = startWsFixture();
    try {
      const events = await collectSessionEvents(fx, [
        JSON.stringify({ toolCallCancellation: { ids: ["fc1"] } }),
        JSON.stringify({ usageMetadata: { totalTokenCount: 42 } }),
        JSON.stringify({ someFutureMessage: { anything: true } }),
      ]);
      expect(events).toEqual([{ type: "closed", code: 1000, reason: "test done" }]);
    } finally {
      await fx.stop();
    }
  });

  test("goAway → non-fatal provider-error, message carries timeLeft when present", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ goAway: { timeLeft: "10s" } }),
          JSON.stringify({ goAway: {} }),
        ]),
      );
      expect(events).toEqual([
        {
          type: "provider-error",
          code: "go_away",
          message: "provider goAway — connection closing soon (timeLeft 10s)",
          fatal: false,
        },
        {
          type: "provider-error",
          code: "go_away",
          message: "provider goAway — connection closing soon",
          fatal: false,
        },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("malformed frames survive: non-JSON text, JSON-in-binary, garbage binary, invalid UTF-8", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          "{{definitely not json",
          // Gemini delivers JSON in BINARY frames — decoded + mapped normally.
          new TextEncoder().encode(JSON.stringify({ setupComplete: {} })),
          new Uint8Array([0xde, 0xad]), // valid UTF-8 ("ޭ") but not JSON
          new Uint8Array([0xff, 0xfe, 0xfd]), // invalid UTF-8
          JSON.stringify({ serverContent: { turnComplete: true } }), // still mapped after junk
        ]),
      );
      expect(events[0]?.type).toBe("provider-error");
      expect((events[0] as { message: string }).message).toContain("unparseable provider frame");
      expect((events[0] as { code?: string }).code).toBe("adapter_unparseable_frame");
      expect(events[1]).toEqual({ type: "session-ready" });
      expect(events[2]?.type).toBe("provider-error");
      expect((events[2] as { message: string }).message).toContain("unparseable provider frame");
      expect((events[2] as { code?: string }).code).toBe("adapter_unparseable_frame");
      expect(events[3]).toEqual({
        type: "provider-error",
        code: "adapter_undecodable_binary_frame",
        message: "unparseable binary provider frame (invalid UTF-8)",
        fatal: false,
      });
      expect(events[4]).toEqual({ type: "turn-complete" });
    } finally {
      await fx.stop();
    }
  });

  test("abrupt server destroy → closed event (1006) and events() ends", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      fx.destroyAll();
      const events: VoiceEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
      }
      // "Connection ended" is Bun 1.3.14's abnormal-closure reason string.
      expect(events).toEqual([{ type: "closed", code: 1006, reason: "Connection ended" }]);
    } finally {
      await fx.stop();
    }
  });

  test("close() drains and is idempotent", async () => {
    const fx = startWsFixture();
    try {
      const session = await geminiLiveProvider.connect(cfgFor(fx), PTT_OPTS);
      await session.close();
      await session.close(); // second close is a settled no-op
      const events: VoiceEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
      }
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("closed");
    } finally {
      await fx.stop();
    }
  });
});

describe("key redaction — the key never leaves the URL", () => {
  test("forced open-timeout: error message + detail carry ?key=<redacted>, never the key", async () => {
    // connectWebSocket's open-timeout rejection carries the URL verbatim in
    // its detail — the exact leak the adapter must redact. Fire the timer
    // immediately (only the open-timeout delay is rewritten) so the real
    // timeout path runs without a 10s wait.
    const realSetTimeout = globalThis.setTimeout;
    const patched = (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
      if (args[1] === DEFAULT_OPEN_TIMEOUT_MS) args[1] = 0;
      return realSetTimeout(...args);
    };
    globalThis.setTimeout = patched as typeof setTimeout;
    try {
      const fake = new FakeWebSocket(); // never opens → open-timeout fires
      const err = await geminiLiveProvider
        .connect(
          {
            apiKey: FAKE_KEY,
            model: MODEL,
            baseUrl: "ws://fixture.invalid",
            wsFactory: () => fake,
          },
          PTT_OPTS,
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(VoiceProviderError);
      const message = (err as VoiceProviderError).message;
      expect(message).toContain("connect failed");
      expect(message).toContain("timed out");
      expect(message).toContain("?key=<redacted>");
      expect(message).not.toContain(FAKE_KEY);
      const detail = (err as VoiceProviderError).context.detail as string;
      expect(detail).toContain("?key=<redacted>");
      expect(detail).not.toContain(FAKE_KEY);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("F3: a socket dying between open and setup fails provider-scoped + redacted", async () => {
    const fake = new FakeWebSocket();
    const pending = geminiLiveProvider.connect(
      { apiKey: FAKE_KEY, model: MODEL, baseUrl: "ws://fixture.invalid", wsFactory: () => fake },
      PTT_OPTS,
    );
    fake.fireOpen(); // connect resolves…
    fake.readyState = 3; // …but the socket is gone before the setup send
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VoiceProviderError);
    const message = (err as VoiceProviderError).message;
    // Same scope + shape as every other connect-path failure, not a bare
    // unscoped "readyState 3".
    expect(message).toContain("voice provider (gemini-live)");
    expect(message).toContain("connect failed");
    expect(message).toContain("readyState 3");
    expect(message).not.toContain(FAKE_KEY);
  });

  test("factory failure whose message carries the full URL is redacted (default base URL)", async () => {
    const err = await geminiLiveProvider
      .connect(
        {
          apiKey: FAKE_KEY,
          model: MODEL,
          wsFactory: (url) => {
            throw new Error(`dial refused: ${url}`);
          },
        },
        PTT_OPTS,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(VoiceProviderError);
    const message = (err as VoiceProviderError).message;
    expect(message).toContain("dial refused");
    expect(message).toContain(`${GEMINI_LIVE_BASE_URL}?key=<redacted>`);
    expect(message).not.toContain(FAKE_KEY);
  });

  test("empty apiKey: redaction guard leaves the error text unmangled", async () => {
    const err = await geminiLiveProvider
      .connect(
        {
          apiKey: "",
          model: MODEL,
          baseUrl: "ws://x.invalid",
          wsFactory: () => {
            throw new Error("boom ws://x.invalid?key=");
          },
        },
        PTT_OPTS,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as VoiceProviderError).message).toContain("boom ws://x.invalid?key=");
  });
});

// Unit tests for src/abstractions/voice/openai-realtime.ts (ADR-272).
//
// Everything runs against the local scripted Bun.serve fixture
// (tests/helpers/ws-fixture.ts) with a fake API key — no real network, no
// real credentials. Wire shapes are asserted deeply (byte shape of
// session.update and every outbound verb); inbound mapping is driven with
// both legacy and GA event names.
//
// GA PROVENANCE — every outbound shape asserted below was replayed against the
// live endpoint (wss://api.openai.com/v1/realtime?model=gpt-realtime) on
// 2026-08-15 and accepted; the beta-era shapes were replayed and REJECTED:
//   - `OpenAI-Beta: realtime=v1` header  → error beta_api_shape_disabled, close 4000
//   - `openai-beta.realtime-v1` protocol → error beta_api_shape_disabled, close 4000
//   - `session.modalities`               → error unknown_parameter
//   - `output_modalities: ["text","audio"]` → error invalid_value
// The beta-shape assertions here are therefore REGRESSION PINS (asserting the
// absence of a shape that provably kills a real session), not style choices.
// If you are tempted to "restore" any of them, re-read this block first.

import { describe, expect, test } from "bun:test";
import {
  OPENAI_REALTIME_BASE_URL,
  openaiRealtimeProvider,
  realtimeUrl,
  sessionUpdatePayload,
} from "../../../../src/abstractions/voice/openai-realtime.ts";
import type {
  VoiceEvent,
  VoiceProviderConfig,
  VoiceSessionOpts,
} from "../../../../src/abstractions/voice-provider.ts";
import { FakeWebSocket, startWsFixture, type WsFixture } from "../../../helpers/ws-fixture.ts";

const FAKE_KEY = "sk-test-fake-key";

const RUN_VERB_TOOL = {
  name: "run_verb",
  description: "Run an atmux verb",
  parameters: {
    type: "object",
    properties: {
      verb: { type: "string", description: "verb name" },
      lane: { type: "integer" },
    },
    required: ["verb"],
  },
} as const;

const PTT_OPTS: VoiceSessionOpts = {
  instructions: "You are the atmux voice operator.",
  tools: [RUN_VERB_TOOL],
  turnDetection: { mode: "ptt" },
};

function cfgFor(fx: WsFixture, extra?: Partial<VoiceProviderConfig>): VoiceProviderConfig {
  return { apiKey: FAKE_KEY, model: "gpt-realtime", baseUrl: fx.url, ...extra };
}

/** Connect, feed `frames` to the client, close, and collect every event. */
async function collectSessionEvents(
  fx: WsFixture,
  frames: ReadonlyArray<string | Uint8Array>,
): Promise<VoiceEvent[]> {
  const provider = openaiRealtimeProvider;
  const session = await provider.connect(cfgFor(fx), PTT_OPTS);
  await fx.waitForReceived(1); // session.update landed → socket is fully up
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

describe("realtimeUrl", () => {
  test("defaults to the production endpoint", () => {
    expect(realtimeUrl({ model: "gpt-realtime" })).toBe(
      `${OPENAI_REALTIME_BASE_URL}?model=gpt-realtime`,
    );
  });

  test("uses baseUrl override and URI-encodes the model", () => {
    expect(realtimeUrl({ baseUrl: "ws://localhost:9", model: "a b" })).toBe(
      "ws://localhost:9?model=a%20b",
    );
  });
});

describe("handshake", () => {
  test("URL query carries the model; auth rides headers by default", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), PTT_OPTS);
      const conn = fx.connections[0];
      expect(conn?.url).toContain("?model=gpt-realtime");
      expect(conn?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      // Regression pin: the beta opt-in header is FATAL under GA (the live
      // server answers beta_api_shape_disabled and closes 4000).
      expect(conn?.headers["openai-beta"]).toBeUndefined();
      expect(conn?.protocols).toEqual([]);
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("authStyle subprotocol sends the two-element protocol list instead of headers", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx, { authStyle: "subprotocol" }), PTT_OPTS);
      const conn = fx.connections[0];
      // Two elements, NOT three: `openai-beta.realtime-v1` is a second,
      // independent beta opt-in and is just as fatal as the header (verified
      // live — same beta_api_shape_disabled error, same 4000 close).
      expect(conn?.protocols).toEqual(["realtime", `openai-insecure-api-key.${FAKE_KEY}`]);
      expect(conn?.protocols).not.toContain("openai-beta.realtime-v1");
      expect(conn?.headers.authorization).toBeUndefined();
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("session.update wire shape — ptt: turn_detection null, default voice, tools mapped", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      // This exact object was accepted by the live GA endpoint and echoed back
      // in `session.updated` (2026-08-15).
      expect(JSON.parse(fx.received[0] as string)).toEqual({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions: "You are the atmux voice operator.",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "whisper-1" },
              turn_detection: null,
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice: "alloy",
            },
          },
          tools: [
            {
              type: "function",
              name: "run_verb",
              description: "Run an atmux verb",
              parameters: {
                type: "object",
                properties: {
                  verb: { type: "string", description: "verb name" },
                  lane: { type: "integer" },
                },
                required: ["verb"],
              },
            },
          ],
          tool_choice: "auto",
        },
      });
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("session.update wire shape — server-vad tunings (0.7 / 220ms / 400ms) + explicit voice", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), {
        instructions: "vad session",
        tools: [],
        turnDetection: {
          mode: "server-vad",
          threshold: 0.7,
          prefixPaddingMs: 220,
          silenceDurationMs: 400,
        },
        voice: "verse",
      });
      await fx.waitForReceived(1);
      const sent = JSON.parse(fx.received[0] as string) as {
        session: {
          audio: { input: { turn_detection: unknown }; output: { voice: string } };
          tools: unknown[];
        };
      };
      // GA nests turn_detection under session.audio.input. These exact
      // tunings were echoed back verbatim by the live endpoint.
      expect(sent.session.audio.input.turn_detection).toEqual({
        type: "server_vad",
        threshold: 0.7,
        prefix_padding_ms: 220,
        silence_duration_ms: 400,
      });
      // …and voice under session.audio.output.
      expect(sent.session.audio.output.voice).toBe("verse");
      expect(sent.session.tools).toEqual([]);
      await session.close();
    } finally {
      await fx.stop();
    }
  });

  test("sessionUpdatePayload is a pure function of opts (unit shape check)", () => {
    const payload = sessionUpdatePayload(PTT_OPTS) as {
      type: string;
      session: { type: string; audio: { output: { voice: string } } };
    };
    expect(payload.type).toBe("session.update");
    expect(payload.session.type).toBe("realtime");
    expect(payload.session.audio.output.voice).toBe("alloy");
  });

  test("no beta-era key survives anywhere in session.update (regression pin)", () => {
    // Each key below was live-rejected by the GA endpoint; `session.type` is
    // live-REQUIRED (its absence is `missing_required_parameter`). This test
    // is the guard against silently regressing to the retired beta shape.
    const payload = sessionUpdatePayload({
      instructions: "i",
      tools: [RUN_VERB_TOOL],
      turnDetection: {
        mode: "server-vad",
        threshold: 0.7,
        prefixPaddingMs: 220,
        silenceDurationMs: 400,
      },
      voice: "verse",
    });
    const wire = JSON.stringify(payload);
    for (const deadKey of [
      '"modalities"',
      '"input_audio_format"',
      '"output_audio_format"',
      '"input_audio_transcription"',
    ]) {
      expect(wire).not.toContain(deadKey);
    }
    // `output_modalities` must be audio-only — GA rejects ["text","audio"].
    const session = (payload as { session: { output_modalities: string[]; type: string } }).session;
    expect(session.output_modalities).toEqual(["audio"]);
    expect(session.type).toBe("realtime");
  });

  test("wsFactory seam is honored (no real socket constructed)", async () => {
    const fake = new FakeWebSocket();
    let seenUrl = "";
    const provider = openaiRealtimeProvider;
    const pending = provider.connect(
      {
        apiKey: FAKE_KEY,
        model: "gpt-realtime",
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
    expect(seenUrl).toBe("ws://unreachable.invalid?model=gpt-realtime");
    expect(fake.sent.length).toBe(1); // session.update went through the fake
    const closing = session.close();
    fake.fireClose(1000, "bye");
    await closing;
  });
});

// Every frame asserted in this block was replayed against the live GA
// endpoint and accepted (2026-08-15): `input_audio_buffer.append` + `.commit`
// produced `input_audio_buffer.committed`; `conversation.item.create`
// (input_text) and (function_call_output) were both echoed back in
// `conversation.item.added`; `response.create` produced `response.created`;
// `response.cancel` cancelled an in-flight response
// (`response.done` status="cancelled", reason="client_cancelled").
// These shapes are UNCHANGED from beta — only session.update moved.
describe("outbound verbs — wire shapes", () => {
  test("every verb serializes to its exact Realtime frame", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1); // [0] session.update

      session.sendAudio(new Uint8Array([1, 2, 3]));
      await fx.waitForReceived(2);
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        type: "input_audio_buffer.append",
        audio: "AQID", // base64 of 0x01 0x02 0x03
      });

      session.endTurn();
      await fx.waitForReceived(4);
      expect(JSON.parse(fx.received[2] as string)).toEqual({ type: "input_audio_buffer.commit" });
      expect(JSON.parse(fx.received[3] as string)).toEqual({ type: "response.create" });

      session.sendText("status of driver-2?");
      await fx.waitForReceived(6);
      expect(JSON.parse(fx.received[4] as string)).toEqual({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "status of driver-2?" }],
        },
      });
      expect(JSON.parse(fx.received[5] as string)).toEqual({ type: "response.create" });

      session.sendToolResult("call_7", '{"ok":true}');
      await fx.waitForReceived(8);
      expect(JSON.parse(fx.received[6] as string)).toEqual({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_7", output: '{"ok":true}' },
      });
      expect(JSON.parse(fx.received[7] as string)).toEqual({ type: "response.create" });

      session.interrupt();
      await fx.waitForReceived(9);
      expect(JSON.parse(fx.received[8] as string)).toEqual({ type: "response.cancel" });

      await session.close();
    } finally {
      await fx.stop();
    }
  });
});

describe("inbound mapping", () => {
  test("session.created → session-ready, emitted once", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "session.created", session: { id: "sess_1" } }),
          JSON.stringify({ type: "session.created", session: { id: "sess_1" } }),
        ]),
      );
      expect(events).toEqual([{ type: "session-ready" }]);
    } finally {
      await fx.stop();
    }
  });

  // Live GA emits ONLY the `output_audio*` spellings (observed 2026-08-15:
  // response.output_audio.delta / response.output_audio_transcript.delta /
  // .done). The legacy `response.audio*` aliases are kept as inbound
  // tolerance and are asserted here to pin that tolerance, not because GA
  // sends them.
  test("legacy AND GA audio delta names decode to identical audio-out bytes", async () => {
    const fx = startWsFixture();
    try {
      const b64 = Buffer.from([9, 8, 7]).toString("base64");
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "response.audio.delta", delta: b64 }),
          JSON.stringify({ type: "response.output_audio.delta", delta: b64 }),
        ]),
      );
      expect(events).toEqual([
        { type: "audio-out", pcm: new Uint8Array([9, 8, 7]) },
        { type: "audio-out", pcm: new Uint8Array([9, 8, 7]) },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("audio delta without a delta field yields an empty pcm chunk", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [JSON.stringify({ type: "response.audio.delta" })]),
      );
      expect(events).toEqual([{ type: "audio-out", pcm: new Uint8Array(0) }]);
    } finally {
      await fx.stop();
    }
  });

  test("assistant transcript partial/final — legacy and GA names, stable id", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "response.audio_transcript.delta", item_id: "it1", delta: "hel" }),
          JSON.stringify({
            type: "response.output_audio_transcript.delta",
            item_id: "it1",
            delta: "lo",
          }),
          JSON.stringify({
            type: "response.audio_transcript.done",
            item_id: "it1",
            transcript: "hello",
          }),
          JSON.stringify({
            type: "response.output_audio_transcript.done",
            item_id: "it2",
            transcript: "again",
          }),
        ]),
      );
      expect(events).toEqual([
        { type: "transcript", role: "assistant", id: "it1", text: "hel", final: false },
        { type: "transcript", role: "assistant", id: "it1", text: "lo", final: false },
        { type: "transcript", role: "assistant", id: "it1", text: "hello", final: true },
        { type: "transcript", role: "assistant", id: "it2", text: "again", final: true },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("user transcript partial/final; id falls back item_id → response_id → empty", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            response_id: "r9",
            delta: "hi ",
          }),
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "u1",
            transcript: "hi there",
          }),
          JSON.stringify({ type: "conversation.item.input_audio_transcription.delta" }),
        ]),
      );
      expect(events).toEqual([
        { type: "transcript", role: "user", id: "r9", text: "hi ", final: false },
        { type: "transcript", role: "user", id: "u1", text: "hi there", final: true },
        { type: "transcript", role: "user", id: "", text: "", final: false },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("function_call_arguments.done → tool-call; sendToolResult answers on the wire", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), PTT_OPTS);
      await fx.waitForReceived(1);
      fx.sendToLast(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call_42",
          name: "run_verb",
          arguments: '{"verb":"status"}',
        }),
      );
      const iterator = session.events()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value).toEqual({
        type: "tool-call",
        id: "call_42",
        name: "run_verb",
        argsJson: '{"verb":"status"}',
      });
      // Round trip: answer the call and assert the exact frames.
      session.sendToolResult("call_42", '{"lanes":3}');
      await fx.waitForReceived(3);
      expect(JSON.parse(fx.received[1] as string)).toEqual({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_42", output: '{"lanes":3}' },
      });
      expect(JSON.parse(fx.received[2] as string)).toEqual({ type: "response.create" });
      await session.close();
      // Drain: iterator ends with the closed event after close().
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

  test("sparse tool-call frame maps to empty-string fields (no crash)", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "response.function_call_arguments.done" }),
        ]),
      );
      expect(events).toEqual([{ type: "tool-call", id: "", name: "", argsJson: "" }]);
    } finally {
      await fx.stop();
    }
  });

  test("speech_started + response.done map to speech-started + turn-complete", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "input_audio_buffer.speech_started" }),
          JSON.stringify({ type: "response.done" }),
        ]),
      );
      expect(events).toEqual([{ type: "speech-started" }, { type: "turn-complete" }]);
    } finally {
      await fx.stop();
    }
  });

  test("provider error frames map to non-fatal provider-error (with and without message)", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "error", error: { message: "rate limited" } }),
          JSON.stringify({ type: "error" }),
        ]),
      );
      expect(events).toEqual([
        { type: "provider-error", message: "rate limited", fatal: false },
        { type: "provider-error", message: "provider error (no message)", fatal: false },
      ]);
    } finally {
      await fx.stop();
    }
  });

  // The 2026-08-15 first-dial failure regression pin. The provider named
  // the fault class in `error.code`; the adapter used to drop it, and the
  // server's log was left with nothing that identified the cause. This
  // asserts the code REACHES the neutral event — with the real frame
  // OpenAI actually sent, verbatim.
  test("error.code is forwarded onto the neutral event (beta_api_shape_disabled)", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({
            type: "error",
            error: {
              code: "beta_api_shape_disabled",
              message:
                "The Realtime Beta API is no longer supported. Please use /v1/realtime for the GA API.",
            },
          }),
        ]),
      );
      expect(events).toEqual([
        {
          type: "provider-error",
          code: "beta_api_shape_disabled",
          message:
            "The Realtime Beta API is no longer supported. Please use /v1/realtime for the GA API.",
          fatal: false,
        },
      ]);
    } finally {
      await fx.stop();
    }
  });

  test("a codeless provider error omits `code` rather than inventing one", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          JSON.stringify({ type: "error", error: { message: "rate limited" } }),
        ]),
      );
      // A defaulted code (e.g. "unknown") would read in the log as a real
      // fault class the provider never reported.
      expect(Object.hasOwn(events[0] as object, "code")).toBe(false);
    } finally {
      await fx.stop();
    }
  });

  test("unknown event types are ignored", async () => {
    const fx = startWsFixture();
    try {
      const events = await collectSessionEvents(fx, [
        JSON.stringify({ type: "rate_limits.updated", rate_limits: [] }),
        JSON.stringify({ type: "some.future.event" }),
      ]);
      expect(events).toEqual([{ type: "closed", code: 1000, reason: "test done" }]);
    } finally {
      await fx.stop();
    }
  });

  test("malformed frames survive: non-JSON text and binary → non-fatal provider-error, stream continues", async () => {
    const fx = startWsFixture();
    try {
      const events = withoutClosed(
        await collectSessionEvents(fx, [
          "{{definitely not json",
          new Uint8Array([0xde, 0xad]),
          JSON.stringify({ type: "response.done" }), // still mapped after the junk
        ]),
      );
      expect(events[0]?.type).toBe("provider-error");
      expect((events[0] as { message: string }).message).toContain("unparseable provider frame");
      // Adapter-detected faults carry an ADAPTER-assigned code, so a log
      // reader can tell "the provider complained" from "our parser choked".
      expect((events[0] as { code?: string }).code).toBe("adapter_unparseable_frame");
      expect(events[1]).toEqual({
        type: "provider-error",
        code: "adapter_unexpected_binary_frame",
        message: "unexpected binary frame from provider",
        fatal: false,
      });
      expect(events[2]).toEqual({ type: "turn-complete" });
    } finally {
      await fx.stop();
    }
  });

  test("abrupt server destroy → closed event (1006) and events() ends", async () => {
    const fx = startWsFixture();
    try {
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), PTT_OPTS);
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
      const provider = openaiRealtimeProvider;
      const session = await provider.connect(cfgFor(fx), PTT_OPTS);
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

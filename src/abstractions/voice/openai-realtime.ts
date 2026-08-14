// ADR-272: voice operator interface — OpenAI Realtime adapter.
//
// Implements `VoiceProvider` over the OpenAI Realtime WebSocket API. We pin
// the BETA interface via the `OpenAI-Beta: realtime=v1` header (so the
// session.update payload uses the beta/legacy shape), but the inbound mapper
// accepts BOTH legacy and GA event names — OpenAI renamed the audio/transcript
// deltas between revisions and a pinned header is not a guarantee the server
// won't speak the newer vocabulary. Unknown inbound event types are IGNORED
// by design (the provider adds types freely; an unknown frame is not an
// error). All wire transport goes through `connectWebSocket`
// (src/abstractions/websocket.ts) — no raw `new WebSocket()` here — and all
// frame parsing goes through `json.ts::tryParseJsonString` (R3: json.ts is
// the only module allowed to call `JSON.parse`).

import { z } from "zod";
import { tryParseJsonString } from "../json.ts";
import type {
  VoiceEvent,
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSession,
  VoiceSessionOpts,
} from "../voice-provider.ts";
import { type ConnectWebSocketOpts, connectWebSocket, type WsHandle } from "../websocket.ts";

/** Production endpoint; tests override via `VoiceProviderConfig.baseUrl`. */
export const OPENAI_REALTIME_BASE_URL = "wss://api.openai.com/v1/realtime";

/** Beta voice default — used when `VoiceSessionOpts.voice` is omitted. */
const DEFAULT_VOICE = "alloy";

// ---------- Wire helpers ----------

/** Realtime WS endpoint for a config: `<base>?model=<model>`. */
export function realtimeUrl(cfg: Pick<VoiceProviderConfig, "baseUrl" | "model">): string {
  return `${cfg.baseUrl ?? OPENAI_REALTIME_BASE_URL}?model=${encodeURIComponent(cfg.model)}`;
}

/** The `session.update` frame sent on open (beta/legacy shape — see header). */
export function sessionUpdatePayload(opts: VoiceSessionOpts): Record<string, unknown> {
  const td = opts.turnDetection;
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: opts.instructions,
      voice: opts.voice ?? DEFAULT_VOICE,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection:
        td.mode === "server-vad"
          ? {
              type: "server_vad",
              threshold: td.threshold,
              prefix_padding_ms: td.prefixPaddingMs,
              silence_duration_ms: td.silenceDurationMs,
            }
          : null,
      tools: opts.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      tool_choice: "auto",
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ---------- Inbound frame schema ----------

// Loose by design: `type` routes; every payload field the mapper reads is
// optional (frames carry many more fields — zod strips them). A text frame
// that fails this parse (non-JSON, or a malformed shape) surfaces as a
// non-fatal provider-error event rather than killing the stream.
const inboundFrameSchema = z.object({
  type: z.string(),
  delta: z.string().optional(),
  transcript: z.string().optional(),
  item_id: z.string().optional(),
  response_id: z.string().optional(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});
type InboundFrame = z.infer<typeof inboundFrameSchema>;

/** Stable per-utterance transcript id: item_id, else response_id, else "". */
function transcriptId(msg: InboundFrame): string {
  return msg.item_id || msg.response_id || "";
}

function transcriptEvent(
  msg: InboundFrame,
  role: "user" | "assistant",
  final: boolean,
): VoiceEvent {
  return {
    type: "transcript",
    role,
    id: transcriptId(msg),
    text: (final ? msg.transcript : msg.delta) ?? "",
    final,
  };
}

// ---------- Session ----------

class OpenAiRealtimeSession implements VoiceSession {
  private readonly ws: WsHandle;
  private sessionReadySeen = false;

  constructor(ws: WsHandle) {
    this.ws = ws;
  }

  sendAudio(pcm16: Uint8Array): void {
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm16) }));
  }

  endTurn(): void {
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  sendText(text: string): void {
    this.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      }),
    );
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  sendToolResult(callId: string, resultJson: string): void {
    this.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: resultJson },
      }),
    );
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  interrupt(): void {
    this.ws.send(JSON.stringify({ type: "response.cancel" }));
  }

  async *events(): AsyncIterable<VoiceEvent> {
    for await (const frame of this.ws.frames()) {
      yield* this.mapFrame(frame);
    }
    const info = await this.ws.closed;
    yield { type: "closed", code: info.code, reason: info.reason };
  }

  async close(): Promise<void> {
    this.ws.close();
    await this.ws.closed;
  }

  /** Map one wire frame to zero-or-more normalized events (see file header
   *  for the legacy/GA dual-name policy). */
  private mapFrame(frame: string | Uint8Array): VoiceEvent[] {
    if (typeof frame !== "string") {
      // The Realtime protocol is JSON-text; a binary frame is a protocol
      // breach worth surfacing, but not worth killing the session over.
      return [
        { type: "provider-error", message: "unexpected binary frame from provider", fatal: false },
      ];
    }
    const msg = tryParseJsonString(frame, inboundFrameSchema);
    if (msg === null) {
      return [
        {
          type: "provider-error",
          message: `unparseable provider frame: ${frame.slice(0, 120)}`,
          fatal: false,
        },
      ];
    }
    switch (msg.type) {
      case "session.created": {
        if (this.sessionReadySeen) return [];
        this.sessionReadySeen = true;
        return [{ type: "session-ready" }];
      }
      case "response.audio.delta": // legacy
      case "response.output_audio.delta": // GA
        return [{ type: "audio-out", pcm: fromBase64(msg.delta ?? "") }];
      case "response.audio_transcript.delta": // legacy
      case "response.output_audio_transcript.delta": // GA
        return [transcriptEvent(msg, "assistant", false)];
      case "response.audio_transcript.done": // legacy
      case "response.output_audio_transcript.done": // GA
        return [transcriptEvent(msg, "assistant", true)];
      case "conversation.item.input_audio_transcription.delta":
        return [transcriptEvent(msg, "user", false)];
      case "conversation.item.input_audio_transcription.completed":
        return [transcriptEvent(msg, "user", true)];
      case "response.function_call_arguments.done":
        return [
          {
            type: "tool-call",
            id: msg.call_id ?? "",
            name: msg.name ?? "",
            argsJson: msg.arguments ?? "",
          },
        ];
      case "input_audio_buffer.speech_started":
        return [{ type: "speech-started" }];
      case "response.done":
        return [{ type: "turn-complete" }];
      case "error":
        return [
          {
            type: "provider-error",
            message: msg.error?.message ?? "provider error (no message)",
            fatal: false,
          },
        ];
      default:
        return []; // unknown event type → deliberately ignored (see header)
    }
  }
}

// ---------- Provider ----------

/**
 * OpenAI Realtime adapter — a stateless singleton (all session state lives in
 * the object `connect` returns). An object literal rather than a class: a
 * ctor-less class registers a phantom, never-hittable implicit-constructor
 * function entry under Bun 1.3.14's coverage instrumentation (verified
 * empirically), which would break the ADR-009 100%-function gate.
 */
export const openaiRealtimeProvider: VoiceProvider = {
  kind: "openai-realtime",

  async connect(cfg: VoiceProviderConfig, opts: VoiceSessionOpts): Promise<VoiceSession> {
    const authStyle = cfg.authStyle ?? "headers";
    const wsOpts: ConnectWebSocketOpts =
      authStyle === "headers"
        ? {
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              "OpenAI-Beta": "realtime=v1",
            },
          }
        : {
            // Browser-style fallback: credentials ride the subprotocol list.
            protocols: [
              "realtime",
              `openai-insecure-api-key.${cfg.apiKey}`,
              "openai-beta.realtime-v1",
            ],
          };
    if (cfg.wsFactory !== undefined) wsOpts.factory = cfg.wsFactory;
    const ws = await connectWebSocket(realtimeUrl(cfg), wsOpts);
    ws.send(JSON.stringify(sessionUpdatePayload(opts)));
    return new OpenAiRealtimeSession(ws);
  },
};

// ADR-272: voice operator interface — the realtime voice-provider seam.
//
// Types only — the vendor-agnostic contract between atmux's voice operator
// loop and a realtime speech-to-speech provider, mirroring the AgentBackend
// types-only seam precedent (ADR-258). Adapters implement `VoiceProvider`:
//   - `openai-realtime` (src/abstractions/voice/openai-realtime.ts, P2)
//   - `gemini-live` (P6)
// Consumers see only the normalized `VoiceEvent` union — provider-native
// frames never leak past an adapter. Wire transport goes through
// `connectWebSocket` (src/abstractions/websocket.ts), never raw sockets.

import type { WebSocketFactory } from "./websocket.ts";

/** Adapter discriminator. Parse operator input via `factory.ts::parseProviderKind`. */
export type VoiceProviderKind = "openai-realtime" | "gemini-live";

/**
 * Tool-parameter schema — deliberately FLAT: a single object level whose
 * properties are primitive-typed. This is the intersection both provider tool
 * dialects accept (OpenAI Realtime function-tools and Gemini Live
 * function-declarations); no unions, no `$ref`, no nesting. Richer shapes are
 * a provider-portability bug, not a missing feature.
 */
export interface VoiceJsonSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean";
      description?: string;
      enum?: readonly string[];
    }
  >;
  required?: readonly string[];
}

/** One tool the voice agent may call. */
export interface VoiceToolDef {
  /** Wire name the model calls (mirrors back in `tool-call.name`). */
  name: string;
  /** What the tool does — the model routes on this. */
  description: string;
  /** Flat parameter schema (see VoiceJsonSchema). */
  parameters: VoiceJsonSchema;
}

/**
 * How user turns end: `ptt` = push-to-talk (the operator explicitly calls
 * `endTurn()`); `server-vad` = the provider's server-side voice-activity
 * detection ends turns from silence. VAD tunings are REQUIRED in server-vad
 * mode — silent provider defaults drift between vendors.
 */
export type VoiceTurnDetection =
  | { mode: "ptt" }
  | {
      mode: "server-vad";
      /** Activation threshold 0..1 — higher = less sensitive. */
      threshold: number;
      /** Audio to retain before detected speech start (ms). */
      prefixPaddingMs: number;
      /** Silence that ends the turn (ms). */
      silenceDurationMs: number;
    };

/** Per-session behavior — prompt, tools, turn taking, voice. */
export interface VoiceSessionOpts {
  /** System instructions for the session. */
  instructions: string;
  /** Tools exposed to the model (flat-schema — see VoiceJsonSchema). */
  tools: readonly VoiceToolDef[];
  /** Turn-taking mode (see VoiceTurnDetection). */
  turnDetection: VoiceTurnDetection;
  /** Provider voice id; adapters supply a provider default when omitted. */
  voice?: string;
}

/** Provider connection config — credentials + endpoint + transport seam. */
export interface VoiceProviderConfig {
  /** Provider API key. Never logged; never committed (see global CLAUDE.md). */
  apiKey: string;
  /** Model id (see `factory.ts::defaultModelFor` for per-kind defaults). */
  model: string;
  /** Endpoint override (tests point this at a local fixture). Adapters own
   *  the production default. */
  baseUrl?: string;
  /** How credentials ride the upgrade: `headers` (default — Bun client WS
   *  delivers them) or `subprotocol` (browser-style fallback). */
  authStyle?: "headers" | "subprotocol";
  /** Socket constructor seam, threaded to `connectWebSocket`. */
  wsFactory?: WebSocketFactory;
}

/**
 * Normalized session event — adapters map provider-native frames onto this
 * union (the AgentBackend `AgentEvent` pattern, ADR-258).
 *
 * `audio-out.pcm` is ALWAYS PCM16LE mono 24kHz — the canonical wire format;
 * adapters convert when their provider speaks anything else.
 */
export type VoiceEvent =
  /** Session is configured and ready for audio (emitted once). */
  | { type: "session-ready" }
  /** Assistant speech chunk — PCM16LE mono 24kHz (canonical; see above). */
  | { type: "audio-out"; pcm: Uint8Array }
  /** Incremental or final transcript. `id` is stable per utterance so
   *  consumers can coalesce partials; `final: true` closes that id. */
  | { type: "transcript"; role: "user" | "assistant"; id: string; text: string; final: boolean }
  /** The model requests a tool call; reply via `sendToolResult(id, ...)`.
   *  `argsJson` is the raw JSON-string argument payload. */
  | { type: "tool-call"; id: string; name: string; argsJson: string }
  /** Provider detected the user started speaking (barge-in signal). */
  | { type: "speech-started" }
  /** The assistant's turn finished (response fully generated). */
  | { type: "turn-complete" }
  /**
   * Provider-reported error. `fatal: true` means the session is dead and a
   * `closed` event follows; `fatal: false` is advisory — keep streaming.
   *
   * `code` is the provider's own machine-readable error code when it sends
   * one (OpenAI Realtime's `error.code`), else an ADAPTER-assigned code for
   * a fault the adapter itself detected. It is the single most diagnostic
   * field on this union: the 2026-08-15 first-dial failure was
   * `beta_api_shape_disabled`, and carrying only `message` would have left
   * the server's log without the one token that names the fault class.
   * Absent only when neither the provider nor the adapter has a code.
   */
  | { type: "provider-error"; message: string; fatal: boolean; code?: string }
  /** The transport closed; terminal — `events()` ends after this. `code` is
   *  the WS close code, or null when the provider has no such concept. */
  | { type: "closed"; code: number | null; reason: string };

/**
 * A live realtime voice session. Outbound verbs are fire-and-forget writes to
 * the socket (they throw `VoiceProviderError` on a dead/backed-up transport —
 * see WsHandle.send); inbound flows through `events()`.
 */
export interface VoiceSession {
  /** Stream one chunk of caller audio — PCM16LE mono 24kHz (canonical). */
  sendAudio(pcm16: Uint8Array): void;
  /** End the user's turn and ask for a response (ptt mode; server-vad mode
   *  ends turns automatically). */
  endTurn(): void;
  /** Inject a user text message and ask for a response. */
  sendText(text: string): void;
  /** Answer a `tool-call` event. `resultJson` is the raw JSON-string result. */
  sendToolResult(callId: string, resultJson: string): void;
  /** Cancel the in-flight assistant response (barge-in). */
  interrupt(): void;
  /** Normalized event stream. Single consumer; ends after the `closed` event. */
  events(): AsyncIterable<VoiceEvent>;
  /** Close the session and drain the transport. Idempotent. */
  close(): Promise<void>;
}

/** A realtime voice provider adapter. Stateless — `connect` returns the
 *  stateful session. */
export interface VoiceProvider {
  readonly kind: VoiceProviderKind;
  /** Open a session: connect the transport, apply `opts`, resolve when the
   *  socket is up (session-ready arrives via `events()`). */
  connect(cfg: VoiceProviderConfig, opts: VoiceSessionOpts): Promise<VoiceSession>;
}

// ADR-272: voice operator interface — Gemini Live (BidiGenerateContent) adapter.
//
// Implements `VoiceProvider` over Google's Gemini Live WebSocket API
// (v1beta `BidiGenerateContent`). Differences from the OpenAI adapter that
// are provider facts, not style:
//   - Auth rides the URL (`?key=<apiKey>`) — Gemini's WS endpoint takes no
//     Authorization header, so `VoiceProviderConfig.authStyle` is N/A here.
//     SECURITY: because the key is in the URL, every error surfaced from the
//     connect path is re-thrown with the key redacted (`…?key=<redacted>`) —
//     no log line, error message, or VoiceProviderError detail may carry it.
//   - Uplink audio is 16 kHz: canonical 24 kHz PCM16 is decimated 24→16
//     through ONE stateful `createDecimator24to16` per session (chunk
//     continuity — splitting the input at any byte boundary produces
//     bit-identical wire audio). Downlink is 24 kHz — bytes relay verbatim.
//   - The service delivers its JSON messages in BINARY WebSocket frames
//     (the official GenAI JS SDK decodes Blobs); binary frames are therefore
//     UTF-8-decoded and JSON-parsed like text, and only an undecodable /
//     unparseable frame surfaces as a non-fatal provider-error.
//   - There is no client-side response-cancel: `interrupt()` is a documented
//     no-op (the client stops downlink playback locally on barge-in without
//     a server round trip — RUNBOOK-voice.md V-11).
//   - A tool reply's `FunctionResponse` carries a REQUIRED `name` beside the
//     call id, while the neutral `sendToolResult(callId, …)` seam carries only
//     the id — so each inbound `toolCall` records its id→name pairing and the
//     reply re-attaches the name. Widening the seam would leak a Gemini-only
//     requirement into the provider-neutral contract (ADR-272 D4).
// Inbound tolerance is per-BRANCH, not per-frame: unknown messages and
// unknown fields are ignored, AND a known branch carrying an unexpected TYPE
// is skipped without suppressing its siblings — see the schema section for
// the two concrete losses (dropped audio, and a missing session-ready that
// hangs the session layer) that shape prevents. All wire transport goes
// through `connectWebSocket` (src/abstractions/websocket.ts) and all frame
// parsing through `json.ts::tryParseJsonString` (R3).

import { z } from "zod";
import { b64decodeToBytes, b64encodeBytes, createDecimator24to16 } from "../../core/voice/audio.ts";
import { VoiceProviderError } from "../../errors.ts";
import { tryParseJsonString } from "../json.ts";
import type {
  VoiceEvent,
  VoiceJsonSchema,
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSession,
  VoiceSessionOpts,
} from "../voice-provider.ts";
import { type ConnectWebSocketOpts, connectWebSocket, type WsHandle } from "../websocket.ts";

/** Production endpoint; tests override via `VoiceProviderConfig.baseUrl`. */
export const GEMINI_LIVE_BASE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ---------- Wire helpers ----------

/** Live WS endpoint for a config: `<base>?key=<apiKey>`. Contains the API
 *  key — never log or embed this URL in an error (see file header). */
export function geminiLiveUrl(cfg: Pick<VoiceProviderConfig, "baseUrl" | "apiKey">): string {
  return `${cfg.baseUrl ?? GEMINI_LIVE_BASE_URL}?key=${encodeURIComponent(cfg.apiKey)}`;
}

/** Replace every occurrence of the key (raw + URI-encoded) with `<redacted>`,
 *  so a URL like `…?key=abc` reads `…?key=<redacted>`. */
function redactSecret(text: string, apiKey: string): string {
  if (apiKey.length === 0) return text; // "".split("") would shred the text
  return text.split(encodeURIComponent(apiKey)).join("<redacted>").split(apiKey).join("<redacted>");
}

/** Keys Gemini's functionDeclarations reject in a parameter schema. */
const GEMINI_FORBIDDEN_SCHEMA_KEYS = new Set(["$schema", "additionalProperties"]);

function stripForbiddenSchemaKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripForbiddenSchemaKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (GEMINI_FORBIDDEN_SCHEMA_KEYS.has(key)) continue;
    out[key] = stripForbiddenSchemaKeys(child);
  }
  return out;
}

/**
 * Strip `$schema` + `additionalProperties` from a tool-parameter schema —
 * Gemini's functionDeclarations reject both. Recursively defensive: the
 * VoiceJsonSchema contract is flat, but any nesting that sneaks in is
 * sanitized too. Everything else (properties / required / enum / description)
 * passes through untouched.
 */
export function sanitizeForGemini(schema: VoiceJsonSchema): Record<string, unknown> {
  return stripForbiddenSchemaKeys(schema) as Record<string, unknown>;
}

/** The `setup` frame sent on open. Note: server-vad's numeric `threshold` has
 *  no Gemini equivalent — the pinned sensitivity enums stand in for it. */
export function setupPayload(model: string, opts: VoiceSessionOpts): Record<string, unknown> {
  const td = opts.turnDetection;
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        // No adapter-side default voice: omitting speechConfig selects the
        // provider default, per the VoiceSessionOpts.voice contract.
        ...(opts.voice !== undefined
          ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } } }
          : {}),
      },
      systemInstruction: { parts: [{ text: opts.instructions }] },
      // Omitted entirely when empty: v1beta may reject an empty
      // `functionDeclarations` list with INVALID_ARGUMENT at setup, which
      // would be a hard connect failure rather than a toolless session.
      ...(opts.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: opts.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: sanitizeForGemini(t.parameters),
                })),
              },
            ],
          }
        : {}),
      realtimeInputConfig: {
        // ponytail: `VoiceTurnDetection.threshold` is DROPPED here — Gemini
        // exposes coarse sensitivity enums, not a 0..1 activation threshold,
        // so the pinned enums stand in for it and a caller's tuning is
        // silently ignored on this provider. Ceiling: server-vad tuning is
        // not portable between adapters. Upgrade path (P7, once OQ-3 lifts
        // the PTT-only pin): map threshold onto the enum bands — roughly
        // >=0.7 → START_SENSITIVITY_LOW, <0.7 → START_SENSITIVITY_HIGH — or
        // widen VoiceTurnDetection with a provider-neutral sensitivity band.
        automaticActivityDetection:
          td.mode === "server-vad"
            ? {
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                prefixPaddingMs: td.prefixPaddingMs,
                silenceDurationMs: td.silenceDurationMs,
              }
            : { disabled: true },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

/** Decode UTF-8 strictly; null on invalid bytes (drives the binary-frame
 *  tolerance described in the file header). */
function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null; // expected: genuinely-binary garbage, not JSON-in-binary
  }
}

// ---------- Inbound frame schemas ----------

// Parsed BRANCH BY BRANCH — never as one whole-frame schema. Zod strips
// unknown SIBLINGS, but an unexpected TYPE on a KNOWN branch fails the whole
// parse, which would collapse an otherwise-usable frame into a single
// provider-error. Two concrete losses that shape drove:
//   - `{ serverContent: { modelTurn: {…audio…}, turnComplete: "true" } }`
//     would drop the audio in that frame entirely.
//   - `{ setupComplete: {}, goAway: "closing" }` would emit NO session-ready,
//     leaving the session layer waiting forever — a hang, not a degraded frame.
// Gemini Live is v1beta and Google has already reshaped this surface once
// (`mediaChunks` → `audio`), so a type drift on one branch is a live risk.
// Every branch and sub-field is therefore picked in isolation via `pick()`;
// a malformed one is skipped and its siblings still map.

/** Any plain JSON object. Doubles as (a) the top-level frame shape, (b) each
 *  nested branch container, and (c) `sendToolResult`'s object-arm acceptance
 *  (arrays / scalars / null fail it and fall through to `{ output: … }`). */
const jsonObjectSchema = z.looseObject({});

const transcriptionSchema = z.object({ text: z.string().optional() });
const partSchema = z.object({
  inlineData: z.object({ mimeType: z.string().optional(), data: z.string().optional() }).optional(),
});
const functionCallSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  args: z.unknown().optional(),
});
const goAwaySchema = z.object({ timeLeft: z.string().optional() });
const unknownArraySchema = z.array(z.unknown());
const booleanSchema = z.boolean();

/**
 * Parse ONE branch in isolation. Returns `undefined` when the branch is
 * absent OR malformed, so a bad branch can never suppress a good sibling
 * (see the note above — this is the whole point).
 */
function pick<T>(value: unknown, schema: z.ZodType<T>): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined; // malformed → skip, not fatal
}

// ---------- Session ----------

class GeminiLiveSession implements VoiceSession {
  private readonly ws: WsHandle;
  private readonly ptt: boolean;
  /** ONE stateful 24→16 decimator per session — chunk continuity matters. */
  private readonly decimator = createDecimator24to16();
  /** Trailing odd byte of a chunk, carried so any byte-level split of the
   *  canonical stream decimates identically to one-shot processing. */
  private pendingByte: Uint8Array = new Uint8Array(0);
  private sessionReadySeen = false;
  /** ptt only: an activityStart has been sent for the current turn. */
  private turnActive = false;
  private userAcc = "";
  private assistantAcc = "";
  private turnSeq = 1;
  /** callId → function name, learned from inbound `toolCall.functionCalls[]`.
   *  Gemini's `FunctionResponse` carries a REQUIRED `name` alongside the id,
   *  but the neutral `sendToolResult(callId, …)` seam only carries the id —
   *  so the name is remembered here rather than widened into the seam. */
  private readonly toolNames = new Map<string, string>();

  constructor(ws: WsHandle, ptt: boolean) {
    this.ws = ws;
    this.ptt = ptt;
  }

  sendAudio(pcm16: Uint8Array): void {
    const out = this.decimator.process(this.takeSamples(pcm16));
    if (out.length === 0) return; // tiny/empty chunk — no new output sample yet
    if (this.ptt && !this.turnActive) {
      // First audio of a ptt turn: explicit activity marker (automatic
      // activity detection is disabled in the setup for ptt sessions).
      // Deliberately AFTER the early return: Gemini's default
      // activityHandling is START_OF_ACTIVITY_INTERRUPTS, so arming a turn
      // on an empty chunk would interrupt an in-flight response for no audio.
      this.ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
      this.turnActive = true;
    }
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: b64encodeBytes(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
          },
        },
      }),
    );
  }

  endTurn(): void {
    // server-vad: the provider ends turns from silence — nothing to send.
    // ptt with no audio sent: no activityStart to match — sending an
    // unmatched activityEnd would be a protocol anomaly, so no-op.
    if (!this.ptt || !this.turnActive) return;
    this.ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    this.turnActive = false; // re-arm the next turn's activityStart
  }

  sendText(text: string): void {
    this.ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      }),
    );
  }

  sendToolResult(callId: string, resultJson: string): void {
    const parsed = tryParseJsonString(resultJson, jsonObjectSchema);
    // `name` is omitted only for a callId this session never saw announced —
    // an id the provider never issued has no name to send, and inventing one
    // would be worse than the omission.
    const name = this.toolNames.get(callId);
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              ...(name !== undefined ? { name } : {}),
              response: parsed ?? { output: resultJson },
            },
          ],
        },
      }),
    );
  }

  /** NO-OP by design: Gemini Live has no client-side response-cancel frame —
   *  barge-in arrives as `serverContent.interrupted`, and the client stops
   *  downlink playback locally without a server round trip
   *  (docs/RUNBOOK-voice.md V-11, "Local barge-in"). */
  interrupt(): void {
    // deliberately empty (see doc comment)
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

  /**
   * Emit whatever each accumulator holds as a `final: true` transcript, then
   * CLOSE the turn — both accumulators clear and `turnSeq` advances, so the
   * next turn's partials can never carry a previous turn's text or reuse its
   * id. Called from BOTH reset triggers (`turnComplete` and `interrupted`).
   */
  private flushTranscripts(events: VoiceEvent[]): void {
    if (this.userAcc.length > 0) {
      events.push({
        type: "transcript",
        role: "user",
        id: `user-${this.turnSeq}`,
        text: this.userAcc,
        final: true,
      });
    }
    if (this.assistantAcc.length > 0) {
      events.push({
        type: "transcript",
        role: "assistant",
        id: `assistant-${this.turnSeq}`,
        text: this.assistantAcc,
        final: true,
      });
    }
    this.userAcc = "";
    this.assistantAcc = "";
    this.turnSeq += 1;
  }

  /** Prepend any carried odd byte, keep the new trailing odd byte (if any),
   *  and view the even remainder as int16 samples. */
  private takeSamples(pcm16: Uint8Array): Int16Array {
    const merged = new Uint8Array(this.pendingByte.byteLength + pcm16.byteLength);
    merged.set(this.pendingByte, 0);
    merged.set(pcm16, this.pendingByte.byteLength);
    const evenLen = merged.byteLength & ~1;
    this.pendingByte = merged.subarray(evenLen);
    return new Int16Array(merged.buffer, 0, evenLen >> 1);
  }

  /** Map one wire frame to zero-or-more normalized events. Tolerant: a frame
   *  may carry several branches at once; unknown messages map to nothing. */
  private mapFrame(frame: string | Uint8Array): VoiceEvent[] {
    const text = typeof frame === "string" ? frame : tryDecodeUtf8(frame);
    if (text === null) {
      return [
        {
          type: "provider-error",
          code: "adapter_undecodable_binary_frame",
          message: "unparseable binary provider frame (invalid UTF-8)",
          fatal: false,
        },
      ];
    }
    const msg = tryParseJsonString(text, jsonObjectSchema);
    if (msg === null) {
      return [
        {
          type: "provider-error",
          code: "adapter_unparseable_frame",
          message: `unparseable provider frame: ${text.slice(0, 120)}`,
          fatal: false,
        },
      ];
    }
    const events: VoiceEvent[] = [];
    if (msg.setupComplete !== undefined && !this.sessionReadySeen) {
      this.sessionReadySeen = true;
      events.push({ type: "session-ready" });
    }
    const sc = pick(msg.serverContent, jsonObjectSchema);
    if (sc !== undefined) {
      const userText = pick(sc.inputTranscription, transcriptionSchema)?.text;
      if (userText !== undefined) {
        this.userAcc += userText;
        events.push({
          type: "transcript",
          role: "user",
          id: `user-${this.turnSeq}`,
          text: userText,
          final: false,
        });
      }
      const assistantText = pick(sc.outputTranscription, transcriptionSchema)?.text;
      if (assistantText !== undefined) {
        this.assistantAcc += assistantText;
        events.push({
          type: "transcript",
          role: "assistant",
          id: `assistant-${this.turnSeq}`,
          text: assistantText,
          final: false,
        });
      }
      const parts = pick(pick(sc.modelTurn, jsonObjectSchema)?.parts, unknownArraySchema) ?? [];
      for (const part of parts) {
        const inline = pick(part, partSchema)?.inlineData;
        if (inline?.mimeType?.startsWith("audio/") === true) {
          // Downlink is 24 kHz canonical already — bytes forwarded verbatim.
          events.push({ type: "audio-out", pcm: b64decodeToBytes(inline.data ?? "") });
        }
      }
      if (pick(sc.interrupted, booleanSchema) === true) {
        // Barge-in. Flush first so a half-spoken turn is not silently lost,
        // then close the turn: `turnComplete` is documented to follow an
        // interrupt, but native-audio Live models are widely reported to
        // drop it, and without a second reset trigger turn N's text would
        // reappear inside turn N+1's final under a colliding id.
        this.flushTranscripts(events);
        events.push({ type: "speech-started" });
      }
      if (pick(sc.turnComplete, booleanSchema) === true) {
        this.flushTranscripts(events);
        events.push({ type: "turn-complete" });
      }
    }
    const calls =
      pick(pick(msg.toolCall, jsonObjectSchema)?.functionCalls, unknownArraySchema) ?? [];
    for (const entry of calls) {
      const fc = pick(entry, functionCallSchema);
      if (fc === undefined) continue; // malformed entry — its siblings still map
      const id = fc.id ?? "";
      const name = fc.name ?? "";
      // Remember the pairing for sendToolResult (see `toolNames`).
      if (id.length > 0 && name.length > 0) this.toolNames.set(id, name);
      events.push({
        type: "tool-call",
        id,
        name,
        argsJson: fc.args === undefined ? "" : JSON.stringify(fc.args),
      });
    }
    if (msg.goAway !== undefined) {
      // Presence is the signal; a malformed body still warns, minus timeLeft.
      const timeLeft = pick(msg.goAway, goAwaySchema)?.timeLeft;
      events.push({
        type: "provider-error",
        code: "go_away",
        message:
          timeLeft !== undefined
            ? `provider goAway — connection closing soon (timeLeft ${timeLeft})`
            : "provider goAway — connection closing soon",
        fatal: false,
      });
    }
    // toolCallCancellation + usageMetadata: deliberately ignored (the session
    // layer has no cancellable in-flight work; usage is a P-later concern).
    return events;
  }
}

// ---------- Provider ----------

/**
 * Gemini Live adapter — a stateless singleton (all session state lives in the
 * object `connect` returns). Object literal rather than a ctor-less class for
 * the same Bun-coverage reason as `openaiRealtimeProvider`.
 */
export const geminiLiveProvider: VoiceProvider = {
  kind: "gemini-live",

  async connect(cfg: VoiceProviderConfig, opts: VoiceSessionOpts): Promise<VoiceSession> {
    const wsOpts: ConnectWebSocketOpts = {};
    if (cfg.wsFactory !== undefined) wsOpts.factory = cfg.wsFactory;
    let ws: WsHandle;
    try {
      ws = await connectWebSocket(geminiLiveUrl(cfg), wsOpts);
      // Inside the try on purpose: a socket that dies between open and setup
      // must fail with the same redacted, provider-scoped error as any other
      // connect-path failure, not a bare `readyState 3`.
      ws.send(JSON.stringify(setupPayload(cfg.model, opts)));
    } catch (e) {
      // The connect-path error detail carries the URL (open-timeout does so
      // verbatim) and the URL carries the key — rethrow redacted, and do NOT
      // chain the original error (its message/context hold the raw URL).
      const original = e instanceof Error ? e.message : String(e);
      throw new VoiceProviderError({
        what: "connect failed",
        provider: "gemini-live",
        detail: redactSecret(original, cfg.apiKey),
      });
    }
    return new GeminiLiveSession(ws, opts.turnDetection.mode === "ptt");
  },
};

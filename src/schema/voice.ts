// ADR-272: voice operator interface — Zod schemas for the JSON control
// frames exchanged as WebSocket TEXT frames between the phone PWA and the
// voice server (binary audio frames are handled by
// `src/core/vox/frame.ts`, not here).
//
// Conventions per the events.ts precedent (ADR-203 §D1/§D3):
//   - Discriminated union on the `type` field; wrong type + valid fields
//     fails parse.
//   - `.passthrough()` on every frame for forward-compat with unknown
//     fields (kanban precedent
//     [[reference_kanbantask_passthrough_extra_json]]).
//   - Wire fields camelCase — with ONE pinned exception: `tool.done`
//     carries `needs_confirmation` (snake_case) per the ADR-272 wire
//     contract; the PWA client is written against that exact name.
//   - `parseClientFrame` NEVER throws — the WS message handler is a hot
//     path fed by untrusted clients; malformed JSON or a schema miss
//     returns `{ ok: false, error }`. JSON parsing goes through
//     `tryParseJsonString` to honour R3 (only `src/abstractions/json.ts`
//     may call `JSON.parse`; see its file header + ADR-006).

import { z } from "zod";
import { tryParseJsonString } from "../abstractions/json.ts";

// ---------- WebSocket close codes ----------

/**
 * Application close codes for the voice WS (4xxx = private-use range per
 * RFC 6455 §7.4.2; 1000 = normal closure). The PWA client switches on
 * these verbatim — a later client-drift test regex-extracts them.
 */
export const VOICE_CLOSE = Object.freeze({
  PROTOCOL: 4400,
  AUTH: 4401,
  ORIGIN: 4403,
  HELLO_TIMEOUT: 4408,
  RATE_LIMITED: 4429,
  TAKEOVER: 4001,
  PROVIDER: 4500,
  NORMAL: 1000,
} as const);

// ---------- Client → server frames ----------

/** First frame after connect — authenticates + declares capture mode. */
export const HelloFrame = z
  .object({
    type: z.literal("hello"),
    v: z.literal(1),
    token: z.string(),
    mode: z.enum(["ptt", "vad"]),
    resume: z.string().optional(),
    team: z.string().optional(),
    ua: z.string().optional(),
  })
  .passthrough();

/** Push-to-talk button transition (down=true press, down=false release). */
export const PttFrame = z
  .object({
    type: z.literal("ptt"),
    down: z.boolean(),
  })
  .passthrough();

/** Switch capture mode mid-session. */
export const ModeFrame = z
  .object({
    type: z.literal("mode"),
    mode: z.enum(["ptt", "vad"]),
  })
  .passthrough();

/** Abort the in-flight assistant turn (barge-in / stop button). */
export const CancelFrame = z
  .object({
    type: z.literal("cancel"),
  })
  .passthrough();

/** Retarget the session at another atmux team. */
export const TeamFrame = z
  .object({
    type: z.literal("team"),
    team: z.string(),
  })
  .passthrough();

/** Typed (non-voice) operator input. */
export const TextFrame = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1).max(2000),
  })
  .passthrough();

/** Phone going to background — park the session for later resume. */
export const SuspendFrame = z
  .object({
    type: z.literal("suspend"),
  })
  .passthrough();

/** Client keepalive; `t` echoes back in `pong` for RTT measurement. */
export const PingFrame = z
  .object({
    type: z.literal("ping"),
    t: z.number().optional(),
  })
  .passthrough();

export const ClientFrame = z.discriminatedUnion("type", [
  HelloFrame,
  PttFrame,
  ModeFrame,
  CancelFrame,
  TeamFrame,
  TextFrame,
  SuspendFrame,
  PingFrame,
]);

// ---------- Server → client frames ----------

/** Session accepted — capabilities + negotiated audio parameters. */
export const ReadyFrame = z
  .object({
    type: z.literal("ready"),
    sessionId: z.string(),
    resumed: z.boolean(),
    provider: z.string(),
    model: z.string(),
    team: z.string().nullable(),
    teams: z.array(z.string()),
    rates: z.object({ in: z.number(), out: z.number() }),
    frameMs: z.number(),
    vad: z.boolean(),
    readonly: z.boolean(),
  })
  .passthrough();

/** Coarse session state for the UI orb. */
export const StatusFrame = z
  .object({
    type: z.literal("status"),
    state: z.enum(["idle", "listening", "thinking", "speaking", "working"]),
  })
  .passthrough();

/** Incremental user-speech transcript (final=false while streaming). */
export const TranscriptUserFrame = z
  .object({
    type: z.literal("transcript.user"),
    id: z.string(),
    text: z.string(),
    final: z.boolean(),
  })
  .passthrough();

/** Incremental assistant transcript (final=false while streaming). */
export const TranscriptAssistantFrame = z
  .object({
    type: z.literal("transcript.assistant"),
    id: z.string(),
    text: z.string(),
    final: z.boolean(),
  })
  .passthrough();

/** Tool call started; `args` is a display-truncated preview, not the call. */
export const ToolStartFrame = z
  .object({
    type: z.literal("tool.start"),
    id: z.string(),
    name: z.string(),
    args: z.string().max(200),
  })
  .passthrough();

/**
 * Tool call finished. `needs_confirmation` (pinned snake_case — see file
 * header) flags a mutation held for server-enforced confirmation
 * (`src/core/vox/confirm.ts`).
 */
export const ToolDoneFrame = z
  .object({
    type: z.literal("tool.done"),
    id: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    ms: z.number(),
    needs_confirmation: z.boolean().optional(),
  })
  .passthrough();

/** Drop any queued playback audio client-side (barge-in / cancel). */
export const AudioClearFrame = z
  .object({
    type: z.literal("audio.clear"),
    reason: z.string(),
  })
  .passthrough();

/** Another device claimed the session (latest-wins registry). */
export const TakeoverFrame = z
  .object({
    type: z.literal("takeover"),
  })
  .passthrough();

/** Server-side error; fatal=true means the socket closes next. */
export const ErrorFrame = z
  .object({
    type: z.literal("error"),
    code: z.string(),
    fatal: z.boolean(),
    message: z.string().optional(),
  })
  .passthrough();

/** Keepalive reply; echoes `ping.t` when present. */
export const PongFrame = z
  .object({
    type: z.literal("pong"),
    t: z.number().optional(),
  })
  .passthrough();

export const ServerFrame = z.discriminatedUnion("type", [
  ReadyFrame,
  StatusFrame,
  TranscriptUserFrame,
  TranscriptAssistantFrame,
  ToolStartFrame,
  ToolDoneFrame,
  AudioClearFrame,
  TakeoverFrame,
  ErrorFrame,
  PongFrame,
]);

// ---------- Inferred types ----------

export type ClientFrame = z.infer<typeof ClientFrame>;
export type ServerFrame = z.infer<typeof ServerFrame>;
export type HelloFrame = z.infer<typeof HelloFrame>;
export type PttFrame = z.infer<typeof PttFrame>;
export type ModeFrame = z.infer<typeof ModeFrame>;
export type CancelFrame = z.infer<typeof CancelFrame>;
export type TeamFrame = z.infer<typeof TeamFrame>;
export type TextFrame = z.infer<typeof TextFrame>;
export type SuspendFrame = z.infer<typeof SuspendFrame>;
export type PingFrame = z.infer<typeof PingFrame>;
export type ReadyFrame = z.infer<typeof ReadyFrame>;
export type StatusFrame = z.infer<typeof StatusFrame>;
export type TranscriptUserFrame = z.infer<typeof TranscriptUserFrame>;
export type TranscriptAssistantFrame = z.infer<typeof TranscriptAssistantFrame>;
export type ToolStartFrame = z.infer<typeof ToolStartFrame>;
export type ToolDoneFrame = z.infer<typeof ToolDoneFrame>;
export type AudioClearFrame = z.infer<typeof AudioClearFrame>;
export type TakeoverFrame = z.infer<typeof TakeoverFrame>;
export type ErrorFrame = z.infer<typeof ErrorFrame>;
export type PongFrame = z.infer<typeof PongFrame>;

// ---------- Parser ----------

export type ParseClientFrameResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; error: string };

/**
 * Parse an inbound WS text frame into a validated `ClientFrame`. Never
 * throws: malformed JSON (or a bare JSON `null`) and schema misses both
 * return `{ ok: false, error }` with a human-readable reason.
 */
export function parseClientFrame(text: string): ParseClientFrameResult {
  const raw = tryParseJsonString(text, z.unknown());
  if (raw === null) return { ok: false, error: "malformed JSON" };
  const parsed = ClientFrame.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, frame: parsed.data };
}

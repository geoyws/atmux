// ADR-272: voice operator interface — binary frame codec for the
// phone↔server WebSocket audio channel.
//
// One binary WS message = one frame: a 4-byte header + a PCM16LE mono
// 24 kHz payload. Layout:
//   byte 0    magic    0xa1 (VOICE_MAGIC_PCM16_V1 — PCM16 wire v1)
//   byte 1    flags    bit0 TURN_END (PTT release / VAD end-of-turn),
//                      bit1 SYNTHETIC (server-generated audio)
//   bytes 2-3 seq      uint16 LITTLE-ENDIAN, wraps 65535→0 via nextSeq
//   bytes 4-  payload  PCM16LE samples. May be EMPTY (a bare TURN_END on
//                      PTT release) but must be even-length. The 4-byte
//                      header keeps the payload 2-byte aligned so decode
//                      hands back zero-copy Int16Array-viewable subarrays.
//
// Result-shaped API — this is the per-40ms hot path; decodeFrame NEVER
// throws on malformed input, it returns `{ ok: false, reason }`.
//
// The exported constants are the wire contract; a later client-drift test
// regex-extracts them to diff against the PWA's `js/protocol.js` copy.

/** Frame magic byte: PCM16 wire format, version 1. */
export const VOICE_MAGIC_PCM16_V1 = 0xa1;
/** Flags bit0 — this frame ends the speaker's turn. */
export const VOICE_FLAG_TURN_END = 0x01;
/** Flags bit1 — server-generated (synthetic) audio, not mic capture. */
export const VOICE_FLAG_SYNTHETIC = 0x02;
/** Header size in bytes (magic + flags + uint16 seq). */
export const VOICE_HEADER_BYTES = 4;
/** PCM sample rate on the wire (Hz). */
export const VOICE_SAMPLE_RATE = 24000;
/** Nominal frame duration (ms). */
export const VOICE_FRAME_MS = 40;
/** Samples per nominal frame: 24000 Hz × 40 ms. */
export const VOICE_SAMPLES_PER_FRAME = 960;
/** Payload bytes per nominal frame: 960 samples × 2 bytes. */
export const VOICE_BYTES_PER_FRAME = 1920;

export interface VoiceFrameInput {
  flags: number;
  seq: number;
  payload: Uint8Array;
}

export type DecodedVoiceFrame =
  | {
      ok: true;
      flags: number;
      seq: number;
      turnEnd: boolean;
      synthetic: boolean;
      payload: Uint8Array;
    }
  | { ok: false; reason: "short" | "bad-magic" | "odd-payload" };

/** Encode a frame. `flags` masked to a byte, `seq` to uint16. */
export function encodeFrame({ flags, seq, payload }: VoiceFrameInput): Uint8Array {
  const out = new Uint8Array(VOICE_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, VOICE_MAGIC_PCM16_V1);
  view.setUint8(1, flags & 0xff);
  view.setUint16(2, seq & 0xffff, true);
  out.set(payload, VOICE_HEADER_BYTES);
  return out;
}

/**
 * Decode a frame. Never throws. On success `payload` is a zero-copy
 * subarray view into `buf` starting at byte 4 (2-byte aligned relative to
 * the frame start, so `new Int16Array(payload.buffer, payload.byteOffset,
 * payload.byteLength / 2)` works when the frame itself sits at an even
 * buffer offset).
 */
export function decodeFrame(buf: Uint8Array): DecodedVoiceFrame {
  if (buf.length < VOICE_HEADER_BYTES) return { ok: false, reason: "short" };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== VOICE_MAGIC_PCM16_V1) return { ok: false, reason: "bad-magic" };
  if ((buf.length - VOICE_HEADER_BYTES) % 2 !== 0) return { ok: false, reason: "odd-payload" };
  const flags = view.getUint8(1);
  return {
    ok: true,
    flags,
    seq: view.getUint16(2, true),
    turnEnd: (flags & VOICE_FLAG_TURN_END) !== 0,
    synthetic: (flags & VOICE_FLAG_SYNTHETIC) !== 0,
    payload: buf.subarray(VOICE_HEADER_BYTES),
  };
}

/** Next sequence number with uint16 wrap (65535 → 0). */
export function nextSeq(seq: number): number {
  return (seq + 1) & 0xffff;
}

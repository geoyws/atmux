// atmux voice — browser mirror of the wire codec (ADR-272 D5).
//
// This file mirrors src/core/voice/frame.ts (binary frame codec) and the
// VOICE_CLOSE table of src/schema/voice.ts. The two numeric tables below
// are REGEX-EXTRACTED by tests/unit/core/voice/asset-protocol-drift.test.ts
// and asserted strictly equal to the server-side exports — change either
// side alone and the drift guard goes red. Keep the literal `NAME: value`
// shape; do not compute values.

export const VOICE_PROTOCOL = {
  MAGIC_PCM16_V1: 0xa1,
  FLAG_TURN_END: 0x01,
  FLAG_SYNTHETIC: 0x02,
  HEADER_BYTES: 4,
  SAMPLE_RATE: 24000,
  FRAME_MS: 40,
  SAMPLES_PER_FRAME: 960,
  BYTES_PER_FRAME: 1920,
};

// WebSocket close codes (4xxx private-use per RFC 6455 §7.4.2).
export const VOICE_CLOSE = {
  PROTOCOL: 4400,
  AUTH: 4401,
  ORIGIN: 4403,
  HELLO_TIMEOUT: 4408,
  RATE_LIMITED: 4429,
  TAKEOVER: 4001,
  PROVIDER: 4500,
  NORMAL: 1000,
};

/**
 * Encode one binary voice frame: 4-byte header + PCM16LE payload.
 * Header: byte0 magic 0xa1, byte1 flags, bytes2-3 seq uint16 LITTLE-ENDIAN.
 * Empty payload is legal (a bare TURN_END on PTT release).
 * @param {{flags: number, seq: number, payload: Uint8Array}} frame
 * @returns {Uint8Array}
 */
export function encodeFrame({ flags, seq, payload }) {
  const out = new Uint8Array(VOICE_PROTOCOL.HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, VOICE_PROTOCOL.MAGIC_PCM16_V1);
  view.setUint8(1, flags & 0xff);
  view.setUint16(2, seq & 0xffff, true); // uint16 seq, LITTLE-endian, offset 2
  out.set(payload, VOICE_PROTOCOL.HEADER_BYTES);
  return out;
}

/**
 * Decode one binary voice frame. Never throws; malformed input returns
 * `{ ok: false, reason }`. On success `payload` is a zero-copy subarray
 * view starting at byte 4 (2-byte aligned relative to the frame start).
 * @param {Uint8Array} buf
 */
export function decodeFrame(buf) {
  if (buf.length < VOICE_PROTOCOL.HEADER_BYTES) return { ok: false, reason: "short" };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== VOICE_PROTOCOL.MAGIC_PCM16_V1) return { ok: false, reason: "bad-magic" };
  if ((buf.length - VOICE_PROTOCOL.HEADER_BYTES) % 2 !== 0)
    return { ok: false, reason: "odd-payload" };
  const flags = view.getUint8(1);
  return {
    ok: true,
    flags,
    seq: view.getUint16(2, true),
    turnEnd: (flags & VOICE_PROTOCOL.FLAG_TURN_END) !== 0,
    synthetic: (flags & VOICE_PROTOCOL.FLAG_SYNTHETIC) !== 0,
    payload: buf.subarray(VOICE_PROTOCOL.HEADER_BYTES),
  };
}

/**
 * Next sequence number with uint16 wrap (65535 → 0).
 * @param {number} seq
 * @returns {number}
 */
export function nextSeq(seq) {
  return (seq + 1) & 0xffff;
}

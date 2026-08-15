// Unit tests for src/core/voice/frame.ts — ADR-272 binary frame codec.
//
// Pins:
//   - Wire constants are the contract (a client-drift test regex-extracts
//     them) — exact values asserted.
//   - seq is uint16 LITTLE-ENDIAN at bytes 2-3 — asserted against a
//     hand-built buffer, not just via roundtrip.
//   - decodeFrame never throws; rejects are Result-shaped with reasons
//     "short" | "bad-magic" | "odd-payload".
//   - payload is a zero-copy subarray view (buffer identity + byteOffset).

import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  nextSeq,
  VOICE_BYTES_PER_FRAME,
  VOICE_FLAG_SYNTHETIC,
  VOICE_FLAG_TURN_END,
  VOICE_FRAME_MS,
  VOICE_HEADER_BYTES,
  VOICE_MAGIC_PCM16_V1,
  VOICE_SAMPLE_RATE,
  VOICE_SAMPLES_PER_FRAME,
} from "../../../../src/core/voice/frame.ts";

function decodeOk(buf: Uint8Array) {
  const d = decodeFrame(buf);
  if (!d.ok) throw new Error(`expected ok decode, got ${d.reason}`);
  return d;
}

describe("wire constants", () => {
  test("exact pinned values (client-drift contract)", () => {
    expect(VOICE_MAGIC_PCM16_V1).toBe(0xa1);
    expect(VOICE_FLAG_TURN_END).toBe(0x01);
    expect(VOICE_FLAG_SYNTHETIC).toBe(0x02);
    expect(VOICE_HEADER_BYTES).toBe(4);
    expect(VOICE_SAMPLE_RATE).toBe(24000);
    expect(VOICE_FRAME_MS).toBe(40);
    expect(VOICE_SAMPLES_PER_FRAME).toBe(960);
    expect(VOICE_BYTES_PER_FRAME).toBe(1920);
    // Internal consistency
    expect((VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000).toBe(VOICE_SAMPLES_PER_FRAME);
    expect(VOICE_SAMPLES_PER_FRAME * 2).toBe(VOICE_BYTES_PER_FRAME);
  });
});

describe("encodeFrame / decodeFrame roundtrip", () => {
  test("payload + flags + seq survive the roundtrip", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 250, 251]);
    const buf = encodeFrame({ flags: VOICE_FLAG_TURN_END, seq: 5, payload });
    expect(buf.length).toBe(VOICE_HEADER_BYTES + 6);
    const d = decodeOk(buf);
    expect(d.flags).toBe(VOICE_FLAG_TURN_END);
    expect(d.seq).toBe(5);
    expect(d.turnEnd).toBe(true);
    expect(d.synthetic).toBe(false);
    expect(Array.from(d.payload)).toEqual([1, 2, 3, 4, 250, 251]);
  });

  test("empty payload (bare TURN_END on PTT release) is legal", () => {
    const buf = encodeFrame({
      flags: VOICE_FLAG_TURN_END,
      seq: 65535,
      payload: new Uint8Array(0),
    });
    expect(buf.length).toBe(VOICE_HEADER_BYTES);
    const d = decodeOk(buf);
    expect(d.payload.length).toBe(0);
    expect(d.seq).toBe(65535);
    expect(d.turnEnd).toBe(true);
  });

  test.each([
    [0, false, false],
    [VOICE_FLAG_TURN_END, true, false],
    [VOICE_FLAG_SYNTHETIC, false, true],
    [VOICE_FLAG_TURN_END | VOICE_FLAG_SYNTHETIC, true, true],
  ])("flags=%d → turnEnd=%p synthetic=%p", (flags, turnEnd, synthetic) => {
    const d = decodeOk(encodeFrame({ flags, seq: 1, payload: new Uint8Array([0, 0]) }));
    expect(d.flags).toBe(flags);
    expect(d.turnEnd).toBe(turnEnd);
    expect(d.synthetic).toBe(synthetic);
  });

  test("flags and seq are masked to byte / uint16", () => {
    const d = decodeOk(encodeFrame({ flags: 0x101, seq: 65536 + 7, payload: new Uint8Array(0) }));
    expect(d.flags).toBe(0x01);
    expect(d.seq).toBe(7);
  });
});

describe("little-endian byte order", () => {
  test("decode against a hand-built buffer: seq bytes are [lo, hi]", () => {
    // seq 0x1234 → byte2 = 0x34 (lo), byte3 = 0x12 (hi)
    const buf = new Uint8Array([0xa1, 0x00, 0x34, 0x12]);
    const d = decodeOk(buf);
    expect(d.seq).toBe(0x1234);
  });

  test("encode writes seq little-endian", () => {
    const buf = encodeFrame({ flags: 0, seq: 0x1234, payload: new Uint8Array(0) });
    expect(buf[2]).toBe(0x34);
    expect(buf[3]).toBe(0x12);
  });
});

describe("nextSeq uint16 wrap", () => {
  test.each([
    [0, 1],
    [1234, 1235],
    [65534, 65535],
    [65535, 0],
  ])("nextSeq(%d) → %d", (seq, expected) => {
    expect(nextSeq(seq)).toBe(expected);
  });
});

describe("decode rejects (never throws)", () => {
  test.each([
    [new Uint8Array(0)],
    [new Uint8Array([0xa1])],
    [new Uint8Array([0xa1, 0x00])],
    [new Uint8Array([0xa1, 0x00, 0x00])],
  ])("shorter than the header → short (len %#)", (buf) => {
    expect(decodeFrame(buf)).toEqual({ ok: false, reason: "short" });
  });

  test("wrong magic → bad-magic", () => {
    const buf = encodeFrame({ flags: 0, seq: 1, payload: new Uint8Array([0, 0]) });
    buf[0] = 0xa2;
    expect(decodeFrame(buf)).toEqual({ ok: false, reason: "bad-magic" });
  });

  test("odd payload length → odd-payload", () => {
    const buf = new Uint8Array([0xa1, 0x00, 0x00, 0x00, 0x42]);
    expect(decodeFrame(buf)).toEqual({ ok: false, reason: "odd-payload" });
  });
});

describe("zero-copy payload view", () => {
  test("payload shares the input buffer at offset 4", () => {
    const buf = encodeFrame({ flags: 0, seq: 9, payload: new Uint8Array([10, 0, 20, 0]) });
    const d = decodeOk(buf);
    expect(d.payload.buffer).toBe(buf.buffer);
    expect(d.payload.byteOffset).toBe(VOICE_HEADER_BYTES);
    // Mutating the frame is visible through the view (no copy was made).
    buf[VOICE_HEADER_BYTES] = 99;
    expect(d.payload[0]).toBe(99);
  });

  test("payload is 2-byte aligned → Int16Array view without copying", () => {
    const samples = new Int16Array([-32768, -1, 0, 1, 32767]);
    const payload = new Uint8Array(samples.buffer, 0, samples.byteLength);
    const buf = encodeFrame({ flags: 0, seq: 3, payload });
    const d = decodeOk(buf);
    const view = new Int16Array(d.payload.buffer, d.payload.byteOffset, d.payload.byteLength / 2);
    expect(Array.from(view)).toEqual([-32768, -1, 0, 1, 32767]);
  });

  test("frame embedded at an even offset of a larger buffer decodes zero-copy", () => {
    const frame = encodeFrame({ flags: 0, seq: 7, payload: new Uint8Array([1, 2]) });
    const big = new Uint8Array(64);
    big.set(frame, 8);
    const slice = big.subarray(8, 8 + frame.length);
    const d = decodeOk(slice);
    expect(d.seq).toBe(7);
    expect(d.payload.buffer).toBe(big.buffer);
    expect(d.payload.byteOffset).toBe(8 + VOICE_HEADER_BYTES);
    expect(Array.from(d.payload)).toEqual([1, 2]);
  });
});

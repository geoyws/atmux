// Unit tests for src/core/voice/audio.ts — ADR-272 PCM conversion +
// 24 kHz → 16 kHz decimation.
//
// Pins:
//   - float32ToPcm16 clamps to [-1, 1]; pcm16→float32→pcm16 round-trips
//     EVERY int16 exactly.
//   - Decimator cumulative length math: floor((2N - 1) / 3) + 1 (3:2).
//   - DC preservation (per-phase normalized taps): constant in →
//     same constant out within ±1 LSB after warmup.
//   - Sine survives with amplitude + frequency intact (coarse RMS +
//     zero-crossing checks).
//   - THE property: splitting the input at ANY chunk boundary and
//     concatenating outputs equals the one-shot output EXACTLY.

import { describe, expect, test } from "bun:test";
import {
  b64decodeToBytes,
  b64encodeBytes,
  createDecimator24to16,
  float32ToPcm16,
  pcm16ToFloat32,
} from "../../../../src/core/voice/audio.ts";

/** Deterministic pseudorandom int16 signal (LCG — no Math.random). */
function lcgSignal(n: number, seed = 12345): Int16Array {
  const out = new Int16Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s % 65536) - 32768;
  }
  return out;
}

/** Feed `input` through a fresh decimator in chunks; concatenate outputs. */
function runChunked(input: Int16Array, chunkSizes: readonly number[]): Int16Array {
  const dec = createDecimator24to16();
  const parts: Int16Array[] = [];
  let off = 0;
  let c = 0;
  while (off < input.length) {
    const size = Math.min(chunkSizes[c % chunkSizes.length] ?? 1, input.length - off);
    parts.push(dec.process(input.subarray(off, off + size)));
    off += size;
    c += 1;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let w = 0;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  return out;
}

describe("pcm16ToFloat32 / float32ToPcm16", () => {
  test("float32ToPcm16 clamps to [-1, 1]", () => {
    const out = float32ToPcm16(new Float32Array([1.5, -1.5, 0.5, 1.0, -1.0, 0]));
    expect(Array.from(out)).toEqual([32767, -32768, 16384, 32767, -32768, 0]);
  });

  test("pcm16ToFloat32 maps full scale to [-1, 1)", () => {
    const f = pcm16ToFloat32(new Int16Array([-32768, 0, 16384, 32767]));
    expect(f[0]).toBe(-1);
    expect(f[1]).toBe(0);
    expect(f[2]).toBe(0.5);
    expect(f[3]).toBeCloseTo(32767 / 32768, 7);
  });

  test("roundtrip is exact for EVERY int16 value", () => {
    const all = new Int16Array(65536);
    for (let i = 0; i < 65536; i++) all[i] = i - 32768;
    const back = float32ToPcm16(pcm16ToFloat32(all));
    expect(back.length).toBe(65536);
    for (let i = 0; i < 65536; i++) {
      if (back[i] !== all[i]) {
        throw new Error(`roundtrip mismatch at int16 ${all[i]}: got ${back[i]}`);
      }
    }
  });
});

describe("createDecimator24to16 — length math", () => {
  test.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [6, 4],
    [7, 5],
    [960, 640],
    [4800, 3200],
  ])("one-shot %d input samples → %d output samples", (n, expected) => {
    const dec = createDecimator24to16();
    expect(dec.process(lcgSignal(n)).length).toBe(expected);
    // Cumulative formula: floor((2N - 1) / 3) + 1
    expect(expected).toBe(Math.floor((2 * n - 1) / 3) + 1);
  });

  test("empty chunk produces empty output and keeps state intact", () => {
    const dec = createDecimator24to16();
    const a = dec.process(lcgSignal(100));
    expect(dec.process(new Int16Array(0)).length).toBe(0);
    const b = dec.process(new Int16Array(0));
    expect(b.length).toBe(0);
    expect(a.length).toBe(Math.floor((2 * 100 - 1) / 3) + 1);
  });

  test("cumulative 3:2 ratio across sequential chunks", () => {
    const dec = createDecimator24to16();
    let total = 0;
    for (let i = 0; i < 5; i++) total += dec.process(lcgSignal(960, i + 1)).length;
    expect(total).toBe(Math.floor((2 * 4800 - 1) / 3) + 1);
    expect(total).toBe(3200);
  });
});

describe("createDecimator24to16 — signal fidelity", () => {
  test("DC is preserved within ±1 LSB after filter warmup", () => {
    for (const dc of [1000, -20000]) {
      const input = new Int16Array(2000).fill(dc);
      const out = createDecimator24to16().process(input);
      for (let k = 25; k < out.length; k++) {
        const v = out[k] ?? 0;
        if (Math.abs(v - dc) > 1) {
          throw new Error(`DC ${dc} drifted to ${v} at output ${k}`);
        }
      }
    }
  });

  test("1 kHz sine keeps amplitude (RMS within 3%) and frequency (zero crossings)", () => {
    const n = 4800; // 0.2 s at 24 kHz
    const amp = 16000;
    const input = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.round(amp * Math.sin((2 * Math.PI * 1000 * i) / 24000));
    }
    const out = createDecimator24to16().process(input);
    expect(out.length).toBe(3200);
    // Steady-state window clear of warmup + tail.
    const mid = Array.from(out.subarray(200, 3000));
    const rms = Math.sqrt(mid.reduce((s, v) => s + v * v, 0) / mid.length);
    const expectedRms = amp / Math.SQRT2;
    expect(Math.abs(rms - expectedRms) / expectedRms).toBeLessThan(0.03);
    // 1 kHz over 2800 samples at 16 kHz = 175 cycles = 350 crossings.
    let crossings = 0;
    for (let i = 1; i < mid.length; i++) {
      const prev = mid[i - 1] ?? 0;
      const curr = mid[i] ?? 0;
      if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) crossings += 1;
    }
    expect(crossings).toBeGreaterThanOrEqual(340);
    expect(crossings).toBeLessThanOrEqual(360);
  });
});

describe("createDecimator24to16 — chunk-split determinism (THE property)", () => {
  const signal = lcgSignal(3001);
  const oneShot = createDecimator24to16().process(signal);

  test.each([
    [[1]],
    [[2, 3, 5, 7]],
    [[480]],
    [[960]],
    [[1000, 1, 999]],
    [[3001]],
  ])("chunk pattern %j equals one-shot exactly", (chunkSizes) => {
    const chunked = runChunked(signal, chunkSizes);
    expect(chunked.length).toBe(oneShot.length);
    for (let i = 0; i < oneShot.length; i++) {
      if (chunked[i] !== oneShot[i]) {
        throw new Error(
          `chunked[${i}]=${chunked[i]} != oneShot[${i}]=${oneShot[i]} for pattern ${JSON.stringify(chunkSizes)}`,
        );
      }
    }
  });
});

describe("base64", () => {
  test("roundtrip preserves bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    expect(Array.from(b64decodeToBytes(b64encodeBytes(bytes)))).toEqual([0, 1, 2, 127, 128, 255]);
  });

  test("known vector: 'hi' → aGk=", () => {
    expect(b64encodeBytes(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(Array.from(b64decodeToBytes("aGk="))).toEqual([104, 105]);
  });

  test("empty input roundtrips", () => {
    expect(b64encodeBytes(new Uint8Array(0))).toBe("");
    expect(b64decodeToBytes("").length).toBe(0);
  });

  test("subarray views encode their view, not the whole buffer", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    expect(Array.from(b64decodeToBytes(b64encodeBytes(view)))).toEqual([1, 2, 3]);
  });
});

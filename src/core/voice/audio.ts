// ADR-272: voice operator interface — PCM conversion + 24 kHz → 16 kHz
// resampling for the provider leg.
//
// The wire carries PCM16LE mono 24 kHz (`frame.ts`); the STT provider
// wants 16 kHz. 24000 → 16000 is the rational ratio 2/3: upsample ×2
// (zero-stuffing to a 48 kHz virtual stream), FIR anti-alias lowpass,
// take every 3rd virtual sample.
//
// FIR design (documented per ADR-272): 63-tap windowed-sinc, Blackman
// window, cutoff 7.0 kHz at the 48 kHz virtual rate — under both the
// 8 kHz output Nyquist and the spec bound of ≤ 7.5 kHz. After windowing,
// the taps are normalized PER POLYPHASE PARITY (even-index and odd-index
// tap sums each scaled to exactly 1) so every output phase has unity DC
// gain — a constant input decimates to the same constant to within
// rounding, and the ×2 zero-stuffing gain compensation is folded in.
//
// Chunk-boundary continuity: the decimator carries filter history +
// absolute stream positions across `process()` calls, so splitting an
// input stream at ANY chunk boundary and concatenating the outputs is
// bit-identical to one-shot processing (property-tested).

// ---------- PCM16 ↔ Float32 ----------

/** Clamp to the int16 range. Shared by float32ToPcm16 + the decimator. */
function clampInt16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

/** int16 → float32 in [-1, 1). Divides by 32768 (exact in float32). */
export function pcm16ToFloat32(int16: Int16Array): Float32Array {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = (int16[i] ?? 0) / 32768;
  return out;
}

/**
 * float32 → int16 with clamping to [-1, 1]. Scales by 32768 then clamps,
 * so `pcm16ToFloat32 → float32ToPcm16` round-trips every int16 exactly
 * (int16 values and x/32768 are both exact in float32).
 */
export function float32ToPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    out[i] = clampInt16(Math.round((f[i] ?? 0) * 32768));
  }
  return out;
}

// ---------- 24 kHz → 16 kHz decimator ----------

const DECIMATOR_TAP_COUNT = 63;
const DECIMATOR_CUTOFF_HZ = 7000;
const VIRTUAL_RATE_HZ = 48000;

/** Windowed-sinc lowpass, Blackman window, per-phase DC-normalized. */
function designDecimatorTaps(): Float64Array {
  const taps = new Float64Array(DECIMATOR_TAP_COUNT);
  const center = (DECIMATOR_TAP_COUNT - 1) / 2;
  const fc = DECIMATOR_CUTOFF_HZ / VIRTUAL_RATE_HZ; // normalized cycles/sample
  for (let n = 0; n < DECIMATOR_TAP_COUNT; n++) {
    const k = n - center;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const win =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (DECIMATOR_TAP_COUNT - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (DECIMATOR_TAP_COUNT - 1));
    taps[n] = sinc * win;
  }
  // Per-phase DC normalization: an output at virtual position p only sees
  // taps whose index shares p's parity (the other parity lands on the
  // zero-stuffed samples). Scaling each parity's sum to 1 gives exactly
  // unity DC gain on both output phases + folds in the ×2 upsampling gain.
  let evenSum = 0;
  let oddSum = 0;
  for (let n = 0; n < DECIMATOR_TAP_COUNT; n++) {
    if (n % 2 === 0) evenSum += taps[n] ?? 0;
    else oddSum += taps[n] ?? 0;
  }
  for (let n = 0; n < DECIMATOR_TAP_COUNT; n++) {
    taps[n] = (taps[n] ?? 0) / (n % 2 === 0 ? evenSum : oddSum);
  }
  return taps;
}

const DECIMATOR_TAPS = designDecimatorTaps();

export interface Decimator24to16 {
  /** Feed a chunk; returns every output sample now computable. */
  process(input: Int16Array): Int16Array;
}

/**
 * Stateful 24 kHz → 16 kHz decimator (ratio 2/3). After N total input
 * samples, total output length is `floor((2N - 1) / 3) + 1` (for N > 0) —
 * cumulative 3:2. State carries absolute stream positions, making output
 * independent of chunk boundaries.
 */
export function createDecimator24to16(): Decimator24to16 {
  let hist: number[] = []; // input samples still needed by future outputs
  let base = 0; // absolute input index of hist[0]
  let emitted = 0; // output samples produced so far
  return {
    process(input: Int16Array): Int16Array {
      for (const s of input) hist.push(s);
      const totalIn = base + hist.length;
      const virtualLen = 2 * totalIn; // zero-stuffed 48 kHz stream length
      // Output k sits at virtual position 3k; computable once 3k < virtualLen.
      const maxOut = Math.floor((virtualLen - 1) / 3) + 1;
      const out = new Int16Array(maxOut - emitted);
      for (let k = emitted; k < maxOut; k++) {
        const p = 3 * k;
        let acc = 0;
        // Only taps sharing p's parity see real samples (j = p - m even);
        // start at p&1 and step 2 to skip the zero-stuffed positions.
        for (let m = p & 1; m < DECIMATOR_TAPS.length; m += 2) {
          const j = p - m;
          if (j < 0) break; // before stream start — zero initial condition
          acc += (DECIMATOR_TAPS[m] ?? 0) * (hist[(j >> 1) - base] ?? 0);
        }
        out[k - emitted] = clampInt16(Math.round(acc));
      }
      emitted = maxOut;
      // Prune history no future output can reference: output maxOut needs
      // virtual j >= 3*maxOut - (tapCount - 1) → input i >= that j >> 1.
      const minVirtual = Math.max(0, 3 * maxOut - (DECIMATOR_TAP_COUNT - 1));
      const minInput = minVirtual >> 1;
      if (minInput > base) {
        hist = hist.slice(minInput - base);
        base = minInput;
      }
      return out;
    },
  };
}

// ---------- base64 ----------

/** Bytes → base64 (Buffer-based; correct for subarray views). */
export function b64encodeBytes(u8: Uint8Array): string {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
}

/** base64 → bytes (fresh copy, not a Buffer-pool view). */
export function b64decodeToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

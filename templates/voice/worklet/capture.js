// atmux voice — mic capture AudioWorkletProcessor (ADR-272 D5).
//
// SELF-CONTAINED by necessity: AudioWorkletGlobalScope has no module
// graph we can rely on, so nothing is imported — the 24000/960 constants
// are restated here and pinned against protocol.js by the asset drift
// test's route check plus code review, not by an import.
//
// convoke guard #1 (ScriptProcessor): this is an AudioWorkletProcessor.
// ScriptProcessorNode is deprecated, runs on the main thread, and drops
// blocks under UI jank — never reintroduce it here.
//
// convoke guard #2 (unresampled 48 k): `sampleRate` (worklet global) is
// whatever the UA actually granted — iOS commonly refuses 24000 and gives
// 48000. This processor decimates ctx-rate → 24000 itself:
//   48000 → exact 2:1 decimation through a small half-band FIR
//            [0.25, 0.5, 0.25] (anti-aliased, integer ratio — D5);
//   24000 → passthrough;
//   other → same FIR smoothing, then linear-interp fractional resample.
// The server always receives true 24 kHz regardless of what the UA gave.

const OUT_RATE = 24000;
const FRAME_SAMPLES = 960; // 40 ms at 24 kHz
const RMS_INTERVAL_S = 0.04; // post a level reading ~every 40 ms

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this.inRate = sampleRate; // AudioWorkletGlobalScope global
    this.step = this.inRate / OUT_RATE;
    this.mode =
      this.inRate === OUT_RATE ? "pass" : this.inRate === OUT_RATE * 2 ? "half" : "frac";
    // Streaming filter/resampler state carried across 128-frame blocks.
    this.hist = 0; // last raw input sample of the previous block
    this.last = 0; // last smoothed sample of the previous block (frac mode)
    this.pos = 0; // fractional read position relative to current block start
    // Preallocated buffers — no allocation churn per process() block. The
    // only per-frame allocation is the transferred Int16Array (mandatory:
    // its buffer is moved to the main thread).
    this.smooth = new Float32Array(4096);
    this.acc = new Float32Array(FRAME_SAMPLES);
    this.accLen = 0;
    this.rmsSum = 0;
    this.rmsCount = 0;
    this.rmsEvery = Math.max(1, Math.round(this.inRate * RMS_INTERVAL_S));
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg === "start") {
        this.capturing = true;
        this.accLen = 0;
        this.hist = 0;
        this.last = 0;
        this.pos = 0;
      } else if (msg === "stop") {
        // Flush the trailing partial frame zero-padded (so a word ending
        // is not clipped), THEN ack — the app sends its empty TURN_END
        // frame only after this ack, preserving frame order.
        this.flushPartial();
        this.capturing = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  push(v) {
    this.acc[this.accLen++] = v;
    if (this.accLen === FRAME_SAMPLES) this.emitFrame();
  }

  emitFrame() {
    const out = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = this.acc[i];
      const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    this.accLen = 0;
    this.port.postMessage({ type: "frame", pcm: out.buffer }, [out.buffer]);
  }

  flushPartial() {
    if (this.accLen === 0) return;
    this.acc.fill(0, this.accLen);
    this.accLen = FRAME_SAMPLES; // pad with silence to a fixed 960 frame
    this.emitFrame();
  }

  // Exact 2:1 decimation, half-band FIR [0.25, 0.5, 0.25] centered on
  // even input samples. `hist` supplies x[-1] across block boundaries.
  processHalf(x) {
    const n = x.length;
    let prev = this.hist;
    for (let i = 0; i + 1 < n; i += 2) {
      this.push(0.25 * prev + 0.5 * x[i] + 0.25 * x[i + 1]);
      prev = x[i + 1];
    }
    this.hist = x[n - 1];
  }

  // Arbitrary-rate path: FIR smoothing then linear-interp fractional
  // resample. Continuity across blocks via `last` (previous smoothed
  // sample) and `pos` (fractional index, may start at -1 < pos < 0).
  processFrac(x) {
    const n = x.length;
    const sm = this.smooth.length >= n ? this.smooth : (this.smooth = new Float32Array(n));
    let prev = this.hist;
    for (let i = 0; i < n; i++) {
      const next = i + 1 < n ? x[i + 1] : x[i];
      sm[i] = 0.25 * prev + 0.5 * x[i] + 0.25 * next;
      prev = x[i];
    }
    this.hist = x[n - 1];
    let pos = this.pos;
    while (pos < n - 1) {
      const i = Math.floor(pos);
      const t = pos - i;
      const a = i < 0 ? this.last : sm[i];
      const b = sm[i + 1];
      this.push(a + (b - a) * t);
      pos += this.step;
    }
    this.pos = pos - n;
    this.last = sm[n - 1];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    // Level meter: always measured (cheap), posted ~every 40 ms.
    for (let i = 0; i < channel.length; i++) this.rmsSum += channel[i] * channel[i];
    this.rmsCount += channel.length;
    if (this.rmsCount >= this.rmsEvery) {
      this.port.postMessage({ type: "rms", value: Math.sqrt(this.rmsSum / this.rmsCount) });
      this.rmsSum = 0;
      this.rmsCount = 0;
    }
    if (!this.capturing) return true;
    if (this.mode === "pass") {
      for (let i = 0; i < channel.length; i++) this.push(channel[i]);
    } else if (this.mode === "half") {
      this.processHalf(channel);
    } else {
      this.processFrac(channel);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);

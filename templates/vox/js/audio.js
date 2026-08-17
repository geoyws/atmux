// atmux vox — WebAudio capture + playback engine (ADR-272 D5).
//
// Owns the AudioContext, the capture worklet, and the downlink PCM
// scheduler. app.js consumes the small API returned by createVoiceAudio().

import { VOX_PROTOCOL } from "./protocol.js";

const PREBUFFER_S = 0.15; // downlink prebuffer before first start
const RESYNC_PAD_S = 0.05; // clock pad applied on start + after underrun

/**
 * @param {{ onFrame: (pcm: Int16Array) => void, onRms: (v: number) => void }} handlers
 */
export function createVoiceAudio({ onFrame, onRms }) {
  let ctx = null;
  let workletNode = null;
  let mediaStream = null;
  let sourceNode = null;
  let stopAck = null;

  // Downlink scheduler state: chained AudioBufferSourceNodes on a running
  // clock (`playhead`). `buffering` gates the 150 ms prebuffer.
  let playhead = 0;
  let buffering = true;
  let pending = [];
  let pendingS = 0;
  const live = new Set();

  // All AudioContext work happens here, INSIDE the first user gesture
  // (the mic press). convoke guard #4: an AudioContext created outside a
  // user gesture starts (and silently stays) "suspended" on iOS — desktop
  // Chrome hides the bug. Never hoist this to page load.
  async function init() {
    if (ctx) return;
    ctx = new AudioContext({ sampleRate: VOX_PROTOCOL.SAMPLE_RATE });
    // convoke guard #2: the sampleRate option is ADVISORY. iOS commonly
    // refuses 24000 and grants 48000. KEEP the granted context — the
    // capture worklet decimates ctx-rate → 24000 itself, and playback
    // buffers carry their own 24 kHz rate (the source node resamples).
    if (ctx.state === "suspended") await ctx.resume();
    // Load the worklet module BEFORE getUserMedia — a permission prompt
    // must never race module resolution.
    await ctx.audioWorklet.addModule("/worklet/capture.js");
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    sourceNode = ctx.createMediaStreamSource(mediaStream);
    // numberOfOutputs: 0 — the capture node has NO output, so a feedback
    // path (mic → graph → speakers → mic) is structurally impossible.
    workletNode = new AudioWorkletNode(ctx, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    workletNode.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "frame") onFrame(new Int16Array(msg.pcm));
      else if (msg.type === "rms") onRms(msg.value);
      else if (msg.type === "stopped" && stopAck) {
        const ack = stopAck;
        stopAck = null;
        ack();
      }
    };
    sourceNode.connect(workletNode);
  }

  function startCapture() {
    if (workletNode) workletNode.port.postMessage("start");
  }

  // Resolves AFTER the worklet has flushed its final (padded) frame, so
  // the caller can send the empty TURN_END frame in order.
  function stopCapture() {
    if (!workletNode) return Promise.resolve();
    return new Promise((resolveAck) => {
      stopAck = resolveAck;
      workletNode.port.postMessage("stop");
    });
  }

  // Downlink PCM16 → scheduled playback. convoke guard #3: NEVER
  // decodeAudioData on raw PCM — it expects a container (WAV/MP3) and
  // fails or mangles bare samples. Manual createBuffer + Int16→Float32
  // fill is the only correct path.
  function enqueuePcm(int16) {
    if (!ctx || int16.length === 0) return;
    const buf = ctx.createBuffer(1, int16.length, VOX_PROTOCOL.SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
    pending.push(buf);
    pendingS += buf.duration;
    if (buffering) {
      if (pendingS < PREBUFFER_S) return; // 150 ms prebuffer before first start
      buffering = false;
      playhead = ctx.currentTime + RESYNC_PAD_S;
    }
    drain();
  }

  function drain() {
    // Underrun: the clock fell behind real time while the network
    // starved. Resync instead of scheduling in the past — otherwise the
    // drift accumulates and every later chunk starts late forever.
    if (playhead < ctx.currentTime) playhead = ctx.currentTime + RESYNC_PAD_S;
    while (pending.length > 0) {
      const buf = pending.shift();
      pendingS -= buf.duration;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => {
        live.delete(src);
        // Queue fully drained → next turn prebuffers again.
        if (live.size === 0 && pending.length === 0) buffering = true;
      };
      src.start(playhead);
      playhead += buf.duration;
      live.add(src);
    }
  }

  // Instant kill of everything scheduled + queued — audio.clear frames
  // and local barge-in both land here.
  function flushAll() {
    for (const src of live) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already ended — fine
      }
    }
    live.clear();
    pending = [];
    pendingS = 0;
    buffering = true;
    playhead = 0;
  }

  return {
    init,
    startCapture,
    stopCapture,
    enqueuePcm,
    flushAll,
    isInited: () => ctx !== null,
    state: () => (ctx ? ctx.state : "closed"),
    resume: () => (ctx ? ctx.resume() : Promise.resolve()),
  };
}

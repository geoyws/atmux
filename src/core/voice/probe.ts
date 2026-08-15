// ADR-272: voice operator interface — the headless probe client
// (RUNBOOK-voice §6). `scripts/voice-probe.ts` is a thin shim over this
// module; all logic lives here so it sits inside the `src/**` coverage
// universe (the `scripts/lint-socket-resolver.ts` →
// `src/core/socket-resolver-lint.ts` precedent).
//
// What it proves: a real client can authenticate, stream PCM16 uplink
// frames at the wire's nominal pace, and receive a `ready` plus whatever
// downlink the provider sends — without a phone, a microphone, or
// ffmpeg. The tone is synthesized in TypeScript (a sine at
// `VOICE_SAMPLE_RATE`), so the probe has no binary dependency and runs
// identically against loopback and `wss://` through nginx.
//
// Everything is injected: the socket comes from `connectWebSocket`
// (never a raw `new WebSocket`), the clock and the sleeper are seams, and
// output goes to a `log` callback. Tests drive it against a real
// `Bun.serve` on port 0 with a fake provider.
//
// Logging discipline: the probe writes to `process.stderr` in the shim;
// nothing here touches stdout.

import { z } from "zod";
import { tryParseJsonString } from "../../abstractions/json.ts";
import {
  type ConnectWebSocketOpts,
  connectWebSocket,
  type WsHandle,
} from "../../abstractions/websocket.ts";
import { UsageError } from "../../errors.ts";
import {
  decodeFrame,
  encodeFrame,
  nextSeq,
  VOICE_BYTES_PER_FRAME,
  VOICE_FLAG_TURN_END,
  VOICE_FRAME_MS,
  VOICE_SAMPLE_RATE,
  VOICE_SAMPLES_PER_FRAME,
} from "./frame.ts";

const USAGE =
  "bun scripts/voice-probe.ts --url <ws-url> --token <t> [--seconds N] [--text <s>] [--tone HZ]";

/** Default tone frequency (Hz) — A4, comfortably inside every codec's band. */
export const PROBE_DEFAULT_TONE_HZ = 440;
/** Default collect window (s) after the uplink burst finishes. */
export const PROBE_DEFAULT_SECONDS = 8;
/** Default synthetic-utterance length (ms) — 2s at 24 kHz. */
export const PROBE_TONE_MS = 2_000;
/** Peak amplitude of the synthesized sine (≈ -3 dBFS; leaves headroom). */
export const PROBE_TONE_AMPLITUDE = 0.5;

// ---------- Args ----------

export interface ProbeArgs {
  url: string;
  token: string;
  seconds: number;
  toneHz: number;
  /** When set, a `text` frame replaces the audio burst. */
  text?: string;
}

function requireValue(argv: ReadonlyArray<string>, i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) {
    throw new UsageError({ what: `voice-probe: ${flag} requires a value`, hint: USAGE });
  }
  return v;
}

function positiveNumber(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError({
      what: `voice-probe: ${flag} must be a positive number, got '${raw}'`,
      hint: USAGE,
    });
  }
  return n;
}

/** Pure arg parser. Throws `UsageError` on a bad or incomplete invocation. */
export function parseProbeArgs(argv: ReadonlyArray<string>): ProbeArgs {
  let url: string | undefined;
  let token: string | undefined;
  let seconds = PROBE_DEFAULT_SECONDS;
  let toneHz = PROBE_DEFAULT_TONE_HZ;
  let text: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--url") {
      url = requireValue(argv, i, "--url");
      i += 2;
      continue;
    }
    if (a === "--token") {
      token = requireValue(argv, i, "--token");
      i += 2;
      continue;
    }
    if (a === "--seconds") {
      seconds = positiveNumber(requireValue(argv, i, "--seconds"), "--seconds");
      i += 2;
      continue;
    }
    if (a === "--tone") {
      toneHz = positiveNumber(requireValue(argv, i, "--tone"), "--tone");
      i += 2;
      continue;
    }
    if (a === "--text") {
      text = requireValue(argv, i, "--text");
      i += 2;
      continue;
    }
    throw new UsageError({ what: `voice-probe: unknown arg: ${a ?? ""}`, hint: USAGE });
  }
  if (url === undefined) {
    throw new UsageError({ what: "voice-probe: --url is required", hint: USAGE });
  }
  if (token === undefined) {
    throw new UsageError({ what: "voice-probe: --token is required", hint: USAGE });
  }
  const out: ProbeArgs = { url, token, seconds, toneHz };
  if (text !== undefined) out.text = text;
  return out;
}

// ---------- Tone synthesis ----------

/**
 * Synthesize a mono PCM16LE sine at `VOICE_SAMPLE_RATE`. Sample n is
 * `round(amplitude · 32767 · sin(2π·hz·n / rate))`, clamped to the int16
 * range so an out-of-band amplitude can never wrap a sample to the
 * opposite sign.
 */
export function synthesizeTone(opts: {
  hz: number;
  ms: number;
  amplitude?: number;
  sampleRate?: number;
}): Uint8Array {
  const rate = opts.sampleRate ?? VOICE_SAMPLE_RATE;
  const amplitude = opts.amplitude ?? PROBE_TONE_AMPLITUDE;
  const samples = Math.round((rate * opts.ms) / 1000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let n = 0; n < samples; n += 1) {
    const raw = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * opts.hz * n) / rate));
    const clamped = Math.max(-32768, Math.min(32767, raw));
    view.setInt16(n * 2, clamped, true);
  }
  return out;
}

/**
 * Slice PCM into wire frames: `VOICE_BYTES_PER_FRAME` each, sequence
 * numbers advancing with uint16 wrap, and `TURN_END` set on the LAST
 * frame (PTT release). A trailing partial frame is kept as-is — the
 * codec only requires an even-length payload, which PCM16 guarantees.
 */
export function toneFrames(pcm: Uint8Array, startSeq = 0): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < pcm.length; off += VOICE_BYTES_PER_FRAME) {
    chunks.push(pcm.subarray(off, Math.min(off + VOICE_BYTES_PER_FRAME, pcm.length)));
  }
  // An empty PCM buffer still owes the server a turn boundary, else the
  // provider waits forever for an end-of-turn that never arrives.
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  let seq = startSeq;
  for (let i = 0; i < chunks.length; i += 1) {
    const last = i === chunks.length - 1;
    frames.push(
      encodeFrame({
        flags: last ? VOICE_FLAG_TURN_END : 0,
        seq,
        payload: chunks[i] as Uint8Array,
      }),
    );
    seq = nextSeq(seq);
  }
  return frames;
}

// ---------- Probe run ----------

/**
 * Connect options carrying the token to the PRE-UPGRADE gate.
 *
 * `--token` reaching only the `hello` frame is not enough: `authorizeUpgrade`
 * runs before the socket exists and rejects with HTTP 401, so the probe never
 * gets far enough to send `hello` at all.
 *
 * The token rides an `Authorization: Bearer` header rather than `?token=`
 * deliberately — `extractToken` accepts either, but a query parameter lands in
 * nginx access logs, shell history, and `ps` output. A header lands in none of
 * them. (The PWA has no choice and uses `?token=`, which is exactly why
 * `access_log off` is mandatory on the `/ws` location.)
 */
export function probeConnectOpts(token: string): ConnectWebSocketOpts {
  return { headers: { Authorization: `Bearer ${token}` } };
}

export interface ProbeResult {
  /** True iff a `ready` frame arrived and the socket never closed with
   *  an error code — the exit-0 condition. */
  ok: boolean;
  /** The `ready` frame as received, or null when none arrived. */
  ready: Record<string, unknown> | null;
  /** Every JSON frame `type` seen, in first-seen order. */
  frameTypes: string[];
  /** Downlink binary frame + byte counts. */
  downlinkFrames: number;
  downlinkBytes: number;
  /** Uplink frames actually sent. */
  uplinkFrames: number;
  /** WS close code, or null when the socket was still open at the end. */
  closeCode: number | null;
  /** Populated when `ok` is false. */
  failure?: string;
}

export interface ProbeDeps {
  args: ProbeArgs;
  /** Socket seam — defaults to the `connectWebSocket` abstraction.
   *  Receives the connect opts so a test can assert what rides the
   *  upgrade request (see `probeConnectOpts`). */
  connect?: (url: string, opts: ConnectWebSocketOpts) => Promise<WsHandle>;
  /** Sleep seam — defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-enough ms clock. */
  clock?: () => number;
  /** Diagnostic sink (stderr in the shim). */
  log?: (line: string) => void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one probe: connect → `hello` → await `ready` → stream the
 * synthetic utterance (or a single `text` frame) → collect for
 * `args.seconds`. Never throws on a protocol outcome; a connect failure
 * is surfaced as `ok: false` with `failure` set.
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeResult> {
  const { args } = deps;
  const connect =
    deps.connect ?? ((url: string, opts: ConnectWebSocketOpts) => connectWebSocket(url, opts));
  const sleep = deps.sleep ?? realSleep;
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.log ?? ((): void => {});

  const frameTypes: string[] = [];
  const result: ProbeResult = {
    ok: false,
    ready: null,
    frameTypes,
    downlinkFrames: 0,
    downlinkBytes: 0,
    uplinkFrames: 0,
    closeCode: null,
  };

  let ws: WsHandle;
  try {
    ws = await connect(args.url, probeConnectOpts(args.token));
  } catch (e) {
    result.failure = `connect failed: ${e instanceof Error ? e.message : String(e)}`;
    log(result.failure);
    return result;
  }

  // Single consumer of frames(); the collector runs concurrently with
  // the uplink burst so downlink audio is counted while we are still
  // sending (which is exactly what a barge-in-capable server does).
  const deadline = clock() + args.seconds * 1000;
  const collector = (async (): Promise<void> => {
    for await (const frame of ws.frames()) {
      if (typeof frame !== "string") {
        result.downlinkFrames += 1;
        const decoded = decodeFrame(frame);
        result.downlinkBytes += decoded.ok ? decoded.payload.length : 0;
        continue;
      }
      const parsed = tryReadServerType(frame);
      if (parsed === null) continue;
      if (!frameTypes.includes(parsed.type)) frameTypes.push(parsed.type);
      if (parsed.type === "ready" && result.ready === null) {
        result.ready = parsed.raw;
        log(`ready: ${frame}`);
      }
    }
  })();

  void ws.closed.then((info) => {
    result.closeCode = info.code;
  });

  ws.send(
    JSON.stringify({ type: "hello", v: 1, token: args.token, mode: "ptt", ua: "voice-probe" }),
  );

  // Wait for `ready` (bounded by the collect window) before streaming —
  // sending audio into a session that never authenticated proves nothing.
  while (result.ready === null && result.closeCode === null && clock() < deadline) {
    await sleep(VOICE_FRAME_MS);
  }

  if (result.ready === null) {
    result.failure =
      result.closeCode === null
        ? "no ready frame before the collect window elapsed"
        : `socket closed (code ${result.closeCode}) before ready`;
    log(result.failure);
    ws.close(1000, "probe done");
    await collector;
    return result;
  }

  if (args.text !== undefined) {
    ws.send(JSON.stringify({ type: "text", text: args.text }));
    result.uplinkFrames = 0;
  } else {
    const pcm = synthesizeTone({ hz: args.toneHz, ms: PROBE_TONE_MS });
    const frames = toneFrames(pcm);
    log(`streaming ${frames.length} frames (${pcm.length} bytes PCM16 @ ${VOICE_SAMPLE_RATE} Hz)`);
    for (const f of frames) {
      if (result.closeCode !== null) break;
      ws.send(f);
      result.uplinkFrames += 1;
      // Real-time pace: one nominal frame per VOICE_FRAME_MS. A server
      // that only works when fed faster than real time is not working.
      await sleep(VOICE_FRAME_MS);
    }
  }

  while (result.closeCode === null && clock() < deadline) {
    await sleep(VOICE_FRAME_MS);
  }

  if (result.closeCode === null) ws.close(1000, "probe done");
  await collector;

  // Exit-0 condition: ready arrived AND the socket did not close with an
  // error code. 1000 (normal) and "still open" both pass.
  const closedCleanly = result.closeCode === null || result.closeCode === 1000;
  result.ok = closedCleanly;
  if (!closedCleanly) result.failure = `socket closed with code ${result.closeCode}`;
  return result;
}

/**
 * Parse a server text frame far enough to read its `type`. Returns null
 * for anything that is not a JSON object carrying a string `type`.
 *
 * Deliberately NOT `parseClientFrame` — that validates the CLIENT union,
 * and every frame the probe receives is a SERVER frame, so it would
 * reject all of them. JSON parsing goes through `tryParseJsonString`
 * (R3 / ADR-006: only `src/abstractions/json.ts` may call `JSON.parse`).
 */
export function tryReadServerType(
  text: string,
): { type: string; raw: Record<string, unknown> } | null {
  const v = tryParseJsonString(text, z.unknown());
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Record<string, unknown>;
  const t = raw.type;
  if (typeof t !== "string") return null;
  return { type: t, raw };
}

/** Render a human summary line for the probe result (stderr). */
export function formatProbeResult(r: ProbeResult): string {
  const parts = [
    `ok=${r.ok}`,
    `uplinkFrames=${r.uplinkFrames}`,
    `downlinkFrames=${r.downlinkFrames}`,
    `downlinkBytes=${r.downlinkBytes}`,
    `frameTypes=[${r.frameTypes.join(",")}]`,
    `closeCode=${r.closeCode === null ? "open" : r.closeCode}`,
  ];
  if (r.failure !== undefined) parts.push(`failure=${r.failure}`);
  return `voice-probe: ${parts.join(" ")}`;
}

/** Frames the tone occupies — exported for the RUNBOOK's arithmetic. */
export const PROBE_TONE_FRAMES = Math.ceil(
  (VOICE_SAMPLE_RATE * PROBE_TONE_MS) / 1000 / VOICE_SAMPLES_PER_FRAME,
);

// ADR-272 P4 — `src/core/vox/probe.ts` (the headless probe client).
//
// Two layers: pure unit tests for the sine math + arg parsing, and a live
// round trip driven against a REAL `Bun.serve` voice server on port 0
// wired to a fake provider. No real network, no real provider, no ffmpeg.

import { describe, expect, test } from "bun:test";
import type { ConnectWebSocketOpts } from "../../../../src/abstractions/websocket.ts";
import {
  decodeFrame,
  VOX_BYTES_PER_FRAME,
  VOX_FLAG_TURN_END,
  VOX_MAGIC_PCM16_V1,
  VOX_SAMPLE_RATE,
} from "../../../../src/core/vox/frame.ts";
import {
  formatProbeResult,
  PROBE_DEFAULT_SECONDS,
  PROBE_DEFAULT_TONE_HZ,
  PROBE_TONE_FRAMES,
  PROBE_TONE_MS,
  type ProbeResult,
  parseProbeArgs,
  probeConnectOpts,
  runProbe,
  synthesizeTone,
  toneFrames,
  tryReadServerType,
} from "../../../../src/core/vox/probe.ts";
import { UsageError } from "../../../../src/errors.ts";
import { withVoxServer } from "../../../helpers/vox-server.ts";

describe("parseProbeArgs", () => {
  test("requires --url and --token", () => {
    expect(() => parseProbeArgs([])).toThrow(UsageError);
    expect(() => parseProbeArgs(["--url", "ws://x/ws"])).toThrow(/--token is required/);
    expect(() => parseProbeArgs(["--token", "t"])).toThrow(/--url is required/);
  });

  test("defaults seconds and tone", () => {
    expect(parseProbeArgs(["--url", "ws://127.0.0.1:4390/ws", "--token", "t"])).toEqual({
      url: "ws://127.0.0.1:4390/ws",
      token: "t",
      seconds: PROBE_DEFAULT_SECONDS,
      toneHz: PROBE_DEFAULT_TONE_HZ,
    });
  });

  test("accepts every flag", () => {
    expect(
      parseProbeArgs([
        "--url",
        "wss://atmux.geoy.ws/ws",
        "--token",
        "secret",
        "--seconds",
        "12",
        "--tone",
        "880",
        "--text",
        "fleet status",
      ]),
    ).toEqual({
      url: "wss://atmux.geoy.ws/ws",
      token: "secret",
      seconds: 12,
      toneHz: 880,
      text: "fleet status",
    });
  });

  test.each([
    [["--url"], /--url requires a value/],
    [["--token"], /--token requires a value/],
    [["--seconds"], /--seconds requires a value/],
    [["--tone"], /--tone requires a value/],
    [["--text"], /--text requires a value/],
  ])("%p is a usage error", (argv, re) => {
    expect(() => parseProbeArgs(argv as string[])).toThrow(re as RegExp);
  });

  test.each([
    ["--seconds", "0"],
    ["--seconds", "-3"],
    ["--seconds", "abc"],
    ["--tone", "0"],
    ["--tone", "NaN"],
  ])("%s %s is refused", (flag, value) => {
    expect(() => parseProbeArgs(["--url", "u", "--token", "t", flag, value])).toThrow(
      /must be a positive number/,
    );
  });

  test("an unknown flag is a usage error", () => {
    expect(() => parseProbeArgs(["--url", "u", "--token", "t", "--nope"])).toThrow(/unknown arg/);
  });
});

describe("synthesizeTone", () => {
  test("produces the right sample count for the duration", () => {
    const pcm = synthesizeTone({ hz: 440, ms: 1000 });
    expect(pcm.length).toBe(VOX_SAMPLE_RATE * 2); // 24000 samples × 2 bytes
    const half = synthesizeTone({ hz: 440, ms: 500 });
    expect(half.length).toBe(VOX_SAMPLE_RATE);
  });

  test("is a real sine — first sample 0, quarter-period at the peak", () => {
    // 1 Hz at 24 kHz: sample 0 is sin(0)=0; sample 6000 is sin(π/2)=1.
    const pcm = synthesizeTone({ hz: 1, ms: 1000, amplitude: 1 });
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(6000 * 2, true)).toBe(32767);
    expect(view.getInt16(18000 * 2, true)).toBe(-32767);
  });

  test("amplitude scales the peak", () => {
    const pcm = synthesizeTone({ hz: 1, ms: 1000, amplitude: 0.5 });
    expect(new DataView(pcm.buffer).getInt16(6000 * 2, true)).toBe(Math.round(0.5 * 32767));
  });

  test("clamps rather than wrapping when amplitude overdrives", () => {
    const pcm = synthesizeTone({ hz: 1, ms: 1000, amplitude: 4 });
    const view = new DataView(pcm.buffer);
    // A wrap would flip the sign at the peak; a clamp keeps it positive.
    expect(view.getInt16(6000 * 2, true)).toBe(32767);
    expect(view.getInt16(18000 * 2, true)).toBe(-32768);
  });

  test("honours a non-default sample rate", () => {
    expect(synthesizeTone({ hz: 440, ms: 1000, sampleRate: 16000 }).length).toBe(32000);
  });
});

describe("toneFrames", () => {
  test("slices into wire frames with TURN_END on the last one only", () => {
    const pcm = synthesizeTone({ hz: 440, ms: PROBE_TONE_MS });
    const frames = toneFrames(pcm);
    expect(frames).toHaveLength(PROBE_TONE_FRAMES);
    expect(frames).toHaveLength(
      Math.ceil((VOX_SAMPLE_RATE * PROBE_TONE_MS) / 1000 / (VOX_BYTES_PER_FRAME / 2)),
    );
    frames.forEach((f, i) => {
      const d = decodeFrame(f);
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(f[0]).toBe(VOX_MAGIC_PCM16_V1);
      expect(d.seq).toBe(i);
      expect(d.turnEnd).toBe(i === frames.length - 1);
    });
    // Every full frame is exactly the nominal payload size.
    expect((frames[0] as Uint8Array).length - 4).toBe(VOX_BYTES_PER_FRAME);
  });

  test("keeps a trailing partial frame and still marks TURN_END", () => {
    const pcm = new Uint8Array(VOX_BYTES_PER_FRAME + 10);
    const frames = toneFrames(pcm);
    expect(frames).toHaveLength(2);
    const last = decodeFrame(frames[1] as Uint8Array);
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.payload.length).toBe(10);
      expect(last.turnEnd).toBe(true);
    }
  });

  test("empty PCM still emits one bare TURN_END frame", () => {
    const frames = toneFrames(new Uint8Array(0));
    expect(frames).toHaveLength(1);
    const d = decodeFrame(frames[0] as Uint8Array);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.payload.length).toBe(0);
      expect(d.flags & VOX_FLAG_TURN_END).toBe(VOX_FLAG_TURN_END);
    }
  });

  test("sequence numbers start where asked and wrap at uint16", () => {
    const frames = toneFrames(new Uint8Array(VOX_BYTES_PER_FRAME * 3), 65534);
    const seqs = frames.map((f) => {
      const d = decodeFrame(f);
      return d.ok ? d.seq : -1;
    });
    expect(seqs).toEqual([65534, 65535, 0]);
  });
});

describe("tryReadServerType", () => {
  test("reads the type off a server frame", () => {
    expect(tryReadServerType('{"type":"ready","sessionId":"s"}')).toEqual({
      type: "ready",
      raw: { type: "ready", sessionId: "s" },
    });
  });

  test.each([
    "not json",
    "[1,2]",
    "null",
    '"bare"',
    "42",
    '{"noType":1}',
    '{"type":7}',
  ])("%p reads as null", (text) => {
    expect(tryReadServerType(text)).toBeNull();
  });
});

describe("formatProbeResult", () => {
  const base: ProbeResult = {
    ok: true,
    ready: { type: "ready" },
    frameTypes: ["ready", "status"],
    downlinkFrames: 3,
    downlinkBytes: 96,
    uplinkFrames: 50,
    closeCode: 1000,
  };

  test("renders every counter", () => {
    const line = formatProbeResult(base);
    expect(line).toContain("ok=true");
    expect(line).toContain("uplinkFrames=50");
    expect(line).toContain("downlinkFrames=3");
    expect(line).toContain("downlinkBytes=96");
    expect(line).toContain("frameTypes=[ready,status]");
    expect(line).toContain("closeCode=1000");
    expect(line).not.toContain("failure=");
  });

  test("renders an open socket and a failure", () => {
    const line = formatProbeResult({ ...base, ok: false, closeCode: null, failure: "boom" });
    expect(line).toContain("closeCode=open");
    expect(line).toContain("failure=boom");
  });
});

// ---------- Live round trip against a real server ----------

describe("probeConnectOpts (pre-upgrade auth)", () => {
  test("carries the token as an Authorization: Bearer header", () => {
    expect(probeConnectOpts("s3cr3t")).toEqual({
      headers: { Authorization: "Bearer s3cr3t" },
    });
  });

  test("keeps the secret OUT of the URL — nothing to leak into logs", () => {
    const opts = probeConnectOpts("s3cr3t");
    expect(JSON.stringify(opts)).not.toContain("?token=");
  });

  test("runProbe actually sends it on the upgrade request", async () => {
    // The regression this pins: the probe used to call
    // `connectWebSocket(url)` with no opts, so `--token` reached only the
    // `hello` frame and every documented command 401'd at the gate. The
    // suite hid it because the harness pre-tokenized the URL.
    const seen: Array<{ url: string; opts: ConnectWebSocketOpts }> = [];
    await runProbe({
      args: { url: "ws://127.0.0.1:9/ws", token: "tok-abc", seconds: 1, toneHz: 440 },
      connect: (url, opts) => {
        seen.push({ url, opts });
        return Promise.reject(new Error("stop here — we only care about the opts"));
      },
      sleep: () => Promise.resolve(),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.opts.headers?.Authorization).toBe("Bearer tok-abc");
    expect(seen[0]?.url).toBe("ws://127.0.0.1:9/ws");
    expect(seen[0]?.url).not.toContain("token");
  });
});

describe("runProbe (live, real Bun.serve + fake provider)", () => {
  test("connects, authenticates, streams the tone and counts the downlink", async () => {
    await withVoxServer({}, async (ctx) => {
      const logs: string[] = [];
      // All 50 tone frames are streamed; `seconds: 3` is the COLLECT
      // window after the burst, not a frame cap. The sleep seam is what
      // keeps the real-time pacer from costing 2s of wall clock.
      const result = await runProbe({
        args: { url: ctx.wsUrlNoToken, token: ctx.token, seconds: 3, toneHz: 440 },
        sleep: () => new Promise<void>((r) => setTimeout(r, 0)),
        log: (l) => logs.push(l),
      });

      expect(result.ok).toBe(true);
      expect(result.ready).toMatchObject({
        type: "ready",
        resumed: false,
        provider: "openai-realtime",
      });
      expect(result.uplinkFrames).toBe(PROBE_TONE_FRAMES);
      expect(result.frameTypes).toContain("ready");
      expect(logs.some((l) => l.startsWith("ready: "))).toBe(true);
      expect(logs.some((l) => l.includes("streaming"))).toBe(true);

      // The server actually received the audio and the turn boundary.
      const leg = ctx.provider.lastLeg;
      expect(leg.sentAudio.length).toBe(PROBE_TONE_FRAMES);
      expect(leg.turnEnds).toBe(1);

      // BYTE-FOR-BYTE, not merely the right number of frames. Counting
      // frames would pass on all-zero payloads or a mis-sliced tone; this
      // reassembles what the provider received and compares it to the
      // exact PCM the probe synthesized.
      const expected = synthesizeTone({ hz: 440, ms: PROBE_TONE_MS });
      const received = new Uint8Array(expected.length);
      let off = 0;
      for (const chunk of leg.sentAudio) {
        received.set(chunk, off);
        off += chunk.length;
      }
      expect(off).toBe(expected.length);
      expect(Array.from(received)).toEqual(Array.from(expected));
      // And it is real signal, not silence — a zero-filled buffer would
      // satisfy every assertion above if the tone generator regressed.
      expect(received.some((b) => b !== 0)).toBe(true);
    });
  });

  test("relays provider downlink audio back to the probe", async () => {
    await withVoxServer({}, async (ctx) => {
      // Emit downlink as soon as the leg exists — the probe counts frames
      // while it is still uploading.
      const pump = (async (): Promise<void> => {
        for (let i = 0; i < 40 && ctx.provider.legs.length === 0; i += 1) {
          await new Promise<void>((r) => setTimeout(r, 5));
        }
        const leg = ctx.provider.lastLeg;
        leg.emit({ type: "audio-out", pcm: new Uint8Array(320) });
        leg.emit({ type: "audio-out", pcm: new Uint8Array(320) });
        leg.emit({ type: "transcript", role: "assistant", id: "a", text: "hi", final: true });
      })();

      const result = await runProbe({
        args: { url: ctx.wsUrlNoToken, token: ctx.token, seconds: 2, toneHz: 440 },
        sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
      });
      await pump;

      expect(result.ok).toBe(true);
      expect(result.downlinkFrames).toBeGreaterThanOrEqual(2);
      expect(result.downlinkBytes).toBeGreaterThanOrEqual(640);
      expect(result.frameTypes).toContain("transcript.assistant");
    });
  });

  test("with NO sleep seam it paces on the real clock (production wiring)", async () => {
    await withVoxServer({}, async (ctx) => {
      const started = Date.now();
      const result = await runProbe({
        // --text so the run is a hello + one frame; the real 40ms pacer
        // still governs the ready-wait and the collect window.
        args: { url: ctx.wsUrlNoToken, token: ctx.token, seconds: 0.3, toneHz: 440, text: "hi" },
      });
      expect(result.ok).toBe(true);
      expect(result.ready).not.toBeNull();
      // It really waited rather than spinning: the collect window is 300ms.
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(ctx.provider.lastLeg.texts).toEqual(["hi"]);
    });
  });

  test("--text sends a text frame instead of audio", async () => {
    await withVoxServer({}, async (ctx) => {
      const result = await runProbe({
        args: {
          url: ctx.wsUrlNoToken,
          token: ctx.token,
          seconds: 2,
          toneHz: 440,
          text: "fleet status",
        },
        sleep: () => new Promise<void>((r) => setTimeout(r, 0)),
      });
      expect(result.ok).toBe(true);
      expect(result.uplinkFrames).toBe(0);
      expect(ctx.provider.lastLeg.texts).toEqual(["fleet status"]);
      expect(ctx.provider.lastLeg.sentAudio).toHaveLength(0);
    });
  });

  test("a bad token is refused at the PRE-upgrade gate, never reaching hello", async () => {
    await withVoxServer({}, async (ctx) => {
      const result = await runProbe({
        // The probe now carries its token on the upgrade request, so a bad
        // one is rejected with HTTP 401 before a socket exists — the
        // connect itself fails. (The POST-upgrade 4401 path — a valid
        // upgrade with a mismatched `hello.token` — is unreachable from
        // the probe by construction and is covered instead by
        // verbs/vox.test.ts "a bad hello token closes 4401
        // post-upgrade" and the session suite.)
        args: { url: ctx.wsUrlNoToken, token: "wrong-token-entirely", seconds: 2, toneHz: 440 },
        sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
      });
      expect(result.ok).toBe(false);
      expect(result.ready).toBeNull();
      expect(result.failure).toContain("connect failed");
      expect(result.uplinkFrames).toBe(0);
    });
  });

  test("a connect failure is reported, never thrown", async () => {
    const result = await runProbe({
      args: { url: "ws://127.0.0.1:1/ws", token: "t", seconds: 1, toneHz: 440 },
      connect: () => Promise.reject(new Error("ECONNREFUSED")),
      sleep: () => Promise.resolve(),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("ECONNREFUSED");
    expect(result.ready).toBeNull();
  });

  test("a non-Error connect rejection is still reported", async () => {
    const result = await runProbe({
      args: { url: "ws://x/ws", token: "t", seconds: 1, toneHz: 440 },
      // eslint-disable-next-line prefer-promise-reject-errors
      connect: () => Promise.reject("plain string"),
      sleep: () => Promise.resolve(),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain("plain string");
  });

  test("no ready before the window elapses is a clean non-ok result", async () => {
    // A server that upgrades but never answers hello.
    const server = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: (): void => {} },
    });
    try {
      let now = 0;
      const result = await runProbe({
        args: { url: `ws://127.0.0.1:${server.port}/ws`, token: "t", seconds: 1, toneHz: 440 },
        sleep: async (ms) => {
          now += ms;
          await new Promise<void>((r) => setTimeout(r, 0));
        },
        clock: () => now,
      });
      expect(result.ok).toBe(false);
      expect(result.ready).toBeNull();
      expect(result.failure).toContain("no ready frame");
    } finally {
      server.stop(true);
    }
  });

  test("garbage and non-object text frames are skipped without breaking the run", async () => {
    const server = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message(ws): void {
          ws.send("not json at all");
          ws.send("[1,2,3]");
          ws.send(JSON.stringify({ noType: true }));
          ws.send(JSON.stringify({ type: "ready", sessionId: "s", resumed: false }));
          ws.send(JSON.stringify({ type: "ready", sessionId: "second" })); // ignored
        },
      },
    });
    try {
      const result = await runProbe({
        args: { url: `ws://127.0.0.1:${server.port}/ws`, token: "t", seconds: 2, toneHz: 440 },
        sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
      });
      expect(result.ready).toMatchObject({ sessionId: "s" }); // first ready wins
      expect(result.frameTypes).toEqual(["ready"]);
      expect(result.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("a server that hangs up mid-burst stops the uplink instead of throwing", async () => {
    let sock: { close: (c?: number, r?: string) => void } | null = null;
    const server = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message(ws, msg): void {
          if (typeof msg === "string") {
            sock = ws as unknown as { close: (c?: number, r?: string) => void };
            ws.send(JSON.stringify({ type: "ready", sessionId: "s", resumed: false }));
            return;
          }
          sock?.close(1000, "enough");
        },
      },
    });
    try {
      const result = await runProbe({
        args: { url: `ws://127.0.0.1:${server.port}/ws`, token: "t", seconds: 3, toneHz: 440 },
        sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
      });
      expect(result.ready).not.toBeNull();
      expect(result.uplinkFrames).toBeLessThan(PROBE_TONE_FRAMES);
      expect(result.closeCode).toBe(1000);
      expect(result.ok).toBe(true); // 1000 is a clean close
    } finally {
      server.stop(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { HttpResponse, request } from "../../../../../src/abstractions/http.ts";
import {
  cacheKey,
  cachePath,
  pcmDurationMs,
  resolveTtsParams,
  synthesize,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  TTS_RESPONSE_FORMAT,
  TTS_URL,
  ttsRequestBody,
} from "../../../../../src/core/voice/e2e/tts.ts";
import { VOICE_SAMPLE_RATE } from "../../../../../src/core/voice/frame.ts";

function fakeHttp(bytes: Uint8Array): {
  post: typeof request;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const post: typeof request = async (opts) => {
    calls.push(opts as unknown as Record<string, unknown>);
    return {
      url: opts.url,
      method: "POST",
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: new TextDecoder().decode(bytes),
      bytes,
      durationMs: 1,
    } satisfies HttpResponse;
  };
  return { post, calls };
}

/** One second of silence at the wire rate. */
const ONE_SECOND = new Uint8Array(VOICE_SAMPLE_RATE * 2);

function deps(overrides: Partial<Parameters<typeof synthesize>[1]> = {}) {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    d: {
      apiKey: "sk-test",
      cacheDir: "/tmp/cache",
      readCache: async () => null,
      writeCache: async (p: string, b: Uint8Array) => {
        written.set(p, b);
      },
      post: fakeHttp(ONE_SECOND).post,
      ...overrides,
    } as Parameters<typeof synthesize>[1],
  };
}

describe("tts parameters", () => {
  test("defaults model, voice, and the no-conversion format", () => {
    const p = resolveTtsParams({ text: "hi" });
    expect(p.model).toBe(TTS_DEFAULT_MODEL);
    expect(p.voice).toBe(TTS_DEFAULT_VOICE);
    // `pcm` is the whole reason this endpoint was chosen: raw 24 kHz PCM16
    // is byte-for-byte the wire format, so no resampling is ever needed.
    expect(p.format).toBe(TTS_RESPONSE_FORMAT);
    expect(TTS_RESPONSE_FORMAT).toBe("pcm");
  });

  test("honours overrides", () => {
    const p = resolveTtsParams({ text: "hi", voice: "nova", model: "tts-1" });
    expect(p.voice).toBe("nova");
    expect(p.model).toBe("tts-1");
  });

  test("the request body asks for raw pcm", () => {
    expect(ttsRequestBody(resolveTtsParams({ text: "hello" }))).toEqual({
      model: TTS_DEFAULT_MODEL,
      input: "hello",
      voice: TTS_DEFAULT_VOICE,
      response_format: "pcm",
    });
  });
});

describe("tts cache key", () => {
  test("is stable for the same text and voice", () => {
    expect(cacheKey(resolveTtsParams({ text: "a" }))).toBe(
      cacheKey(resolveTtsParams({ text: "a" })),
    );
  });

  test("changes with the text", () => {
    expect(cacheKey(resolveTtsParams({ text: "a" }))).not.toBe(
      cacheKey(resolveTtsParams({ text: "b" })),
    );
  });

  test("changes with the voice", () => {
    expect(cacheKey(resolveTtsParams({ text: "a", voice: "nova" }))).not.toBe(
      cacheKey(resolveTtsParams({ text: "a", voice: "alloy" })),
    );
  });

  test("does not depend on the API key", () => {
    // Hashing a credential into a filename is how credentials end up in
    // directory listings.
    const p = resolveTtsParams({ text: "a" });
    expect(cachePath("/c", p)).toBe(`/c/${cacheKey(p)}.pcm`);
    expect(cacheKey(p)).not.toContain("sk-");
  });
});

describe("pcmDurationMs", () => {
  test("one second of PCM16 at the wire rate reads as 1000ms", () => {
    expect(pcmDurationMs(ONE_SECOND)).toBe(1000);
  });

  test("an empty buffer is zero", () => {
    expect(pcmDurationMs(new Uint8Array(0))).toBe(0);
  });
});

describe("synthesize", () => {
  test("calls the speech endpoint with a bearer key and caches the result", async () => {
    const { post, calls } = fakeHttp(ONE_SECOND);
    const { d, written } = deps({ post });
    const r = await synthesize({ text: "what needs my attention?" }, d);
    expect(r.cached).toBe(false);
    expect(r.durationMs).toBe(1000);
    expect(r.pcm.byteLength).toBe(ONE_SECOND.byteLength);
    expect(calls[0]?.url).toBe(TTS_URL);
    expect((calls[0]?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(written.get(r.path)).toBe(ONE_SECOND);
  });

  test("a cache hit skips the network entirely", async () => {
    let called = false;
    const { d } = deps({
      readCache: async () => ONE_SECOND,
      post: (async () => {
        called = true;
        throw new Error("should not dial");
      }) as unknown as typeof request,
    });
    const r = await synthesize({ text: "cached" }, d);
    expect(r.cached).toBe(true);
    expect(called).toBe(false);
  });

  test("an empty cache file is treated as a miss", async () => {
    const { post } = fakeHttp(ONE_SECOND);
    const { d } = deps({ readCache: async () => new Uint8Array(0), post });
    expect((await synthesize({ text: "x" }, d)).cached).toBe(false);
  });

  test("refuses an empty response body", async () => {
    const { post } = fakeHttp(new Uint8Array(0));
    const { d } = deps({ post });
    await expect(synthesize({ text: "x" }, d)).rejects.toThrow("returned an empty body");
  });

  test("refuses a body that is not a whole number of PCM16 samples", async () => {
    // An odd byte count means the payload is not PCM16 at all — most likely
    // a JSON error body that slipped through with a 200.
    const { post } = fakeHttp(new Uint8Array([1, 2, 3]));
    const { d } = deps({ post });
    await expect(synthesize({ text: "x" }, d)).rejects.toThrow("not a whole number of PCM16");
  });

  test("logs through the injected sink on both paths", async () => {
    const lines: string[] = [];
    const { post } = fakeHttp(ONE_SECOND);
    const { d } = deps({ post, log: (l: string) => lines.push(l) });
    await synthesize({ text: "x" }, d);
    expect(lines.join()).toContain("synthesized");
    const hit = deps({ readCache: async () => ONE_SECOND, log: (l: string) => lines.push(l) });
    await synthesize({ text: "x" }, hit.d);
    expect(lines.join()).toContain("cache hit");
  });

  test("never puts the API key on the cache path", async () => {
    const { post } = fakeHttp(ONE_SECOND);
    const { d } = deps({ post });
    const r = await synthesize({ text: "x" }, d);
    expect(r.path).not.toContain("sk-test");
  });
});

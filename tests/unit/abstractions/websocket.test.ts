// Unit tests for src/abstractions/websocket.ts (ADR-272).
//
// Real-socket coverage runs against the scripted Bun.serve fixture
// (tests/helpers/ws-fixture.ts) — including the empirical verification that
// Bun's client WebSocket delivers custom headers + subprotocols on the
// upgrade request. Paths a real socket can't reach deterministically
// (post-open error events, pre-open close-without-error, lying readyState)
// are driven through the injected FakeWebSocket.

import { describe, expect, test } from "bun:test";
import {
  connectWebSocket,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_OPEN_TIMEOUT_MS,
  type WsHandle,
} from "../../../src/abstractions/websocket.ts";
import { VoiceProviderError } from "../../../src/errors.ts";
import {
  FakeWebSocket,
  startRejectingWsFixture,
  startWsFixture,
  waitUntil,
} from "../../helpers/ws-fixture.ts";

async function collectAllFrames(handle: WsHandle): Promise<Array<string | Uint8Array>> {
  const out: Array<string | Uint8Array> = [];
  for await (const frame of handle.frames()) {
    out.push(frame);
  }
  return out;
}

async function collectFrames(handle: WsHandle, count: number): Promise<Array<string | Uint8Array>> {
  const out: Array<string | Uint8Array> = [];
  for await (const frame of handle.frames()) {
    out.push(frame);
    if (out.length >= count) break;
  }
  return out;
}

async function expectVoiceProviderError(fn: () => Promise<unknown>): Promise<VoiceProviderError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof VoiceProviderError) return e;
    throw e;
  }
  throw new Error("expected VoiceProviderError, got success");
}

describe("connectWebSocket — real fixture", () => {
  test("connects with zero opts and exposes bufferedAmount 0", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      expect(handle.bufferedAmount).toBe(0);
      handle.close();
      await handle.closed;
    } finally {
      await fx.stop();
    }
  });

  test("custom headers arrive at the server (Bun WS options-object extension)", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url, {
        headers: { authorization: "Bearer sk-fake-abc", "x-atmux-probe": "yes" },
      });
      const conn = fx.connections[0];
      expect(conn?.headers.authorization).toBe("Bearer sk-fake-abc");
      expect(conn?.headers["x-atmux-probe"]).toBe("yes");
      handle.close();
      await handle.closed;
    } finally {
      await fx.stop();
    }
  });

  test("requested subprotocols arrive at the server", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url, {
        protocols: ["realtime", "fake-key.abc"],
      });
      expect(fx.connections[0]?.protocols).toEqual(["realtime", "fake-key.abc"]);
      handle.close();
      await handle.closed;
    } finally {
      await fx.stop();
    }
  });

  test("open-timeout rejects with VoiceProviderError when the upgrade hangs", async () => {
    const fx = startWsFixture({ hang: true });
    try {
      const err = await expectVoiceProviderError(() =>
        connectWebSocket(fx.url, { openTimeoutMs: 150 }),
      );
      expect(err.tag).toBe("voice-provider");
      expect(err.message).toContain("timed out after 150ms");
    } finally {
      await fx.stop();
    }
  });

  test("rejecting server (HTTP 401, never upgrades) → clean pre-open error", async () => {
    const rej = startRejectingWsFixture(401);
    try {
      const err = await expectVoiceProviderError(() =>
        connectWebSocket(rej.url, { openTimeoutMs: 2000 }),
      );
      expect(err.tag).toBe("voice-provider");
      expect(err.message).toContain("websocket connection failed");
    } finally {
      await rej.stop();
    }
  });

  test("frames queued before iteration starts are delivered in order, then iterator ends", async () => {
    const fx = startWsFixture({
      onConnect: ["first", new Uint8Array([4, 5, 6]), "third"],
      closeOnConnect: { code: 4000, reason: "scripted done" },
    });
    try {
      const handle = await connectWebSocket(fx.url);
      // Let the frames + close land BEFORE the first poll — queue-backed.
      await handle.closed;
      const frames = await collectAllFrames(handle);
      expect(frames).toEqual(["first", new Uint8Array([4, 5, 6]), "third"]);
    } finally {
      await fx.stop();
    }
  });

  test("frames arriving after iteration starts wake the iterator (text + binary in order)", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      const collecting = collectFrames(handle, 2);
      fx.sendToLast("hello");
      fx.sendToLast(new Uint8Array([7, 8]));
      const frames = await collecting;
      expect(frames[0]).toBe("hello");
      expect(frames[1]).toEqual(new Uint8Array([7, 8]));
      handle.close();
      await handle.closed;
    } finally {
      await fx.stop();
    }
  });

  test("server close ends the iterator and resolves closed with code + reason", async () => {
    const fx = startWsFixture({
      onConnect: ["only-frame"],
      closeOnConnect: { code: 4001, reason: "server bye" },
    });
    try {
      const handle = await connectWebSocket(fx.url);
      const frames = await collectAllFrames(handle);
      expect(frames).toEqual(["only-frame"]);
      expect(await handle.closed).toEqual({ code: 4001, reason: "server bye" });
    } finally {
      await fx.stop();
    }
  });

  test("abrupt server destroy resolves closed as abnormal closure (1006)", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      fx.destroyAll();
      const info = await handle.closed;
      expect(info.code).toBe(1006);
      expect(await collectAllFrames(handle)).toEqual([]);
    } finally {
      await fx.stop();
    }
  });

  test("send delivers text and binary frames to the server", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      handle.send("outbound-text");
      handle.send(new Uint8Array([9, 9, 9]));
      await fx.waitForReceived(2);
      expect(fx.received[0]).toBe("outbound-text");
      expect(fx.received[1]).toEqual(new Uint8Array([9, 9, 9]));
      handle.close();
      await handle.closed;
    } finally {
      await fx.stop();
    }
  });

  test("client close with explicit code reaches the server (Bun drops the outbound reason)", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      handle.close(4002, "client done");
      await handle.closed;
      await waitUntil(() => fx.closes.length === 1);
      // Bun 1.3.14 quirk (verified against a raw client socket too): the
      // client→server close REASON is not delivered — only the code. Pinned
      // here so a future Bun fix surfaces as a diff, not silence.
      expect(fx.closes[0]).toEqual({ code: 4002, reason: "" });
    } finally {
      await fx.stop();
    }
  });

  test("send on a non-open socket throws VoiceProviderError (open-state guard)", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      handle.close();
      await handle.closed;
      let caught: VoiceProviderError | null = null;
      try {
        handle.send("too late");
      } catch (e) {
        if (e instanceof VoiceProviderError) caught = e;
      }
      expect(caught?.message).toContain("non-open socket");
    } finally {
      await fx.stop();
    }
  });

  test("send exceeding maxBufferedBytes throws instead of buffering unboundedly", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url, { maxBufferedBytes: 4 });
      let caught: VoiceProviderError | null = null;
      try {
        handle.send("hello!"); // 6 utf-8 bytes > 4-byte cap
      } catch (e) {
        if (e instanceof VoiceProviderError) caught = e;
      }
      expect(caught?.message).toContain("buffered-bytes cap");
      expect(fx.received.length).toBe(0);
      handle.close();
      await handle.closed;
    } finally {
      await fx.stop();
    }
  });

  test("close is idempotent — double close and close-after-closed are safe", async () => {
    const fx = startWsFixture();
    try {
      const handle = await connectWebSocket(fx.url);
      handle.close();
      handle.close();
      await handle.closed;
      handle.close(4003, "again");
      expect((await handle.closed).code).toBeNumber();
    } finally {
      await fx.stop();
    }
  });
});

describe("connectWebSocket — injected fake factory", () => {
  test("factory receives the url + connection opts and its socket is used", async () => {
    const fake = new FakeWebSocket();
    let seenUrl = "";
    let seenOpts: unknown;
    const pending = connectWebSocket("ws://injected.invalid/x", {
      headers: { "x-h": "1" },
      protocols: ["p1"],
      factory: (url, opts) => {
        seenUrl = url;
        seenOpts = opts;
        return fake;
      },
    });
    fake.fireOpen();
    const handle = await pending;
    expect(seenUrl).toBe("ws://injected.invalid/x");
    expect(seenOpts).toEqual({ headers: { "x-h": "1" }, protocols: ["p1"] });
    expect(fake.binaryType).toBe("arraybuffer");
    handle.send("via-fake");
    expect(fake.sent).toEqual(["via-fake"]);
  });

  test("open-timeout destroys the socket (close called on the fake)", async () => {
    const fake = new FakeWebSocket();
    const err = await expectVoiceProviderError(() =>
      connectWebSocket("ws://never.invalid", { factory: () => fake, openTimeoutMs: 30 }),
    );
    expect(err.message).toContain("timed out after 30ms");
    expect(fake.closeCalls.length).toBe(1);
  });

  test("error event before open rejects (error carries a message)", async () => {
    const fake = new FakeWebSocket();
    const pending = connectWebSocket("ws://err.invalid", { factory: () => fake });
    fake.fireError({ message: "boom upstream" });
    const err = await expectVoiceProviderError(() => pending);
    expect(err.message).toContain("websocket connection failed");
    expect(err.message).toContain("boom upstream");
    expect(fake.closeCalls.length).toBe(1);
  });

  test("error event before open without a message still rejects cleanly", async () => {
    const fake = new FakeWebSocket();
    const pending = connectWebSocket("ws://err2.invalid", { factory: () => fake });
    fake.fireError({});
    const err = await expectVoiceProviderError(() => pending);
    expect(err.message).toContain("websocket connection failed");
  });

  test("close before open (no error event) rejects with the close code", async () => {
    const fake = new FakeWebSocket();
    const pending = connectWebSocket("ws://closed.invalid", { factory: () => fake });
    fake.fireClose(1013, "try again later");
    const err = await expectVoiceProviderError(() => pending);
    expect(err.message).toContain("closed before open");
    expect(err.message).toContain("code 1013");
  });

  test("error after open terminates frames() and resolves closed as 1006", async () => {
    const fake = new FakeWebSocket();
    const pending = connectWebSocket("ws://mid.invalid", { factory: () => fake });
    fake.fireOpen();
    const handle = await pending;
    fake.fireMessage("pre-error-frame");
    fake.fireError({ message: "mid-stream failure" });
    expect(await collectAllFrames(handle)).toEqual(["pre-error-frame"]);
    expect(await handle.closed).toEqual({ code: 1006, reason: "mid-stream failure" });
    // A trailing close event after the error is a settled-promise no-op.
    fake.fireClose(1000, "late close");
    expect((await handle.closed).code).toBe(1006);
  });

  test("send on a socket reporting a lying readyState throws (guard reads readyState live)", async () => {
    const fake = new FakeWebSocket();
    const pending = connectWebSocket("ws://lying.invalid", { factory: () => fake });
    fake.fireOpen();
    const handle = await pending;
    fake.readyState = 0; // regressed to CONNECTING — send must refuse
    let caught: VoiceProviderError | null = null;
    try {
      handle.send("nope");
    } catch (e) {
      if (e instanceof VoiceProviderError) caught = e;
    }
    expect(caught?.message).toContain("readyState 0");
  });

  test("bufferedAmount getter reads through to the socket", async () => {
    const fake = new FakeWebSocket();
    const pending = connectWebSocket("ws://buf.invalid", { factory: () => fake });
    fake.fireOpen();
    const handle = await pending;
    fake.bufferedAmount = 7;
    expect(handle.bufferedAmount).toBe(7);
    // Binary send accounting: 7 buffered + 2-byte frame > 8-byte cap? No cap
    // here (default) — the frame goes through and counts its byteLength arm.
    handle.send(new Uint8Array([1, 2]));
    expect(fake.sent.at(-1)).toEqual(new Uint8Array([1, 2]));
  });
});

describe("defaults", () => {
  test("exported defaults match ADR-272 (10s open timeout, 4 MiB cap)", () => {
    expect(DEFAULT_OPEN_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_MAX_BUFFERED_BYTES).toBe(4 * 1024 * 1024);
  });
});

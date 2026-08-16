import { describe, expect, test } from "bun:test";
import type { WsCloseInfo, WsHandle } from "../../../../../src/abstractions/websocket.ts";
import {
  type DriveResult,
  driveUtterance,
  formatDriveResult,
  handleServerFrame,
  QUIET_AFTER_FINAL_MS,
  TranscriptAssembler,
} from "../../../../../src/core/voice/e2e/drive.ts";
import {
  decodeFrame,
  VOICE_BYTES_PER_FRAME,
  VOICE_FLAG_TURN_END,
  VOICE_FRAME_MS,
  VOICE_SAMPLE_RATE,
} from "../../../../../src/core/voice/frame.ts";

/**
 * A scripted socket. `script` is consulted after each client send, so the
 * fake can answer `hello` with `ready` and answer the audio burst with a
 * transcript — the same ordering a real server produces.
 */
function fakeSocket(opts: {
  onSend?: (data: string | Uint8Array, push: (f: string | Uint8Array) => void) => void;
  closeCode?: number;
  failConnect?: boolean;
}): { connect: () => Promise<WsHandle>; sent: Array<string | Uint8Array> } {
  const sent: Array<string | Uint8Array> = [];
  const queue: Array<string | Uint8Array> = [];
  let done = false;
  let resolveClosed: (i: WsCloseInfo) => void = () => {};
  const closed = new Promise<WsCloseInfo>((r) => {
    resolveClosed = r;
  });
  // Event-driven rather than polled: a poll loop here would race the
  // virtual clock (which advances without real time passing) and the
  // generator would never get a turn.
  let wake: () => void = () => {};
  const waitForWork = (): Promise<void> => new Promise<void>((r) => (wake = r));
  const push = (f: string | Uint8Array): void => {
    queue.push(f);
    wake();
  };
  const handle: WsHandle = {
    send: (data) => {
      sent.push(data);
      opts.onSend?.(data, push);
    },
    frames: () => ({
      async *[Symbol.asyncIterator]() {
        while (!done || queue.length > 0) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await waitForWork();
        }
      },
    }),
    closed,
    close: (code) => {
      if (done) return;
      done = true;
      wake();
      resolveClosed({ code: code ?? opts.closeCode ?? 1000, reason: "" });
    },
    get bufferedAmount() {
      return 0;
    },
  };
  const connect = async (): Promise<WsHandle> => {
    if (opts.failConnect === true) throw new Error("refused");
    return handle;
  };
  return { connect, sent };
}

const READY = JSON.stringify({
  type: "ready",
  sessionId: "s1",
  provider: "openai-realtime",
  model: "m",
});

/** Two nominal frames' worth of PCM. */
const PCM = new Uint8Array(VOICE_BYTES_PER_FRAME * 2);

/**
 * Virtual clock. `sleep` advances it instead of waiting, so the timeout
 * paths (a 20s ready window, a collect window) are exercised in
 * microseconds. Without this the suite would busy-spin against `Date.now()`
 * and the ready-timeout test alone would take twenty real seconds — the
 * kind of slow test that gets deleted rather than fixed.
 */
function virtualClock(): {
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let t = 0;
  const slept: number[] = [];
  return {
    clock: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
      // Yield a MACROTASK, not just a microtask: the collector generator
      // parks on a promise resolved from `push`, and only a real task
      // boundary lets it run before the next clock check.
      await new Promise((r) => setTimeout(r, 0));
    },
    slept,
  };
}

function run(opts: Parameters<typeof fakeSocket>[0], collectMs = 500): Promise<DriveResult> {
  const { connect } = fakeSocket(opts);
  const vc = virtualClock();
  return driveUtterance({
    args: { url: "ws://127.0.0.1:1/ws", token: "t".repeat(32), pcm: PCM, collectMs },
    connect,
    sleep: vc.sleep,
    clock: vc.clock,
  });
}

describe("TranscriptAssembler", () => {
  test("a final frame's text wins outright", () => {
    const a = new TranscriptAssembler();
    a.add("1", "partial", false);
    a.add("1", "the complete sentence", true);
    expect(a.text()).toBe("the complete sentence");
    expect(a.hasFinal()).toBe(true);
  });

  test("a later partial never overwrites a final", () => {
    const a = new TranscriptAssembler();
    a.add("1", "final text", true);
    a.add("1", "stray", false);
    expect(a.text()).toBe("final text");
  });

  test("the longest partial wins when no final arrives", () => {
    // Cumulative partials are the documented shape; keeping the longest is
    // correct for those AND safe if they were ever deltas.
    const a = new TranscriptAssembler();
    a.add("1", "he", false);
    a.add("1", "hello there", false);
    a.add("1", "hi", false);
    expect(a.text()).toBe("hello there");
    expect(a.hasFinal()).toBe(false);
  });

  test("multiple utterances join in first-seen order", () => {
    const a = new TranscriptAssembler();
    a.add("1", "first.", true);
    a.add("2", "second.", true);
    expect(a.text()).toBe("first. second.");
  });

  test("blank utterances are dropped", () => {
    const a = new TranscriptAssembler();
    a.add("1", "   ", true);
    a.add("2", "real", true);
    expect(a.text()).toBe("real");
  });

  test("an empty assembler is empty", () => {
    expect(new TranscriptAssembler().text()).toBe("");
  });
});

describe("uplink framing and pacing", () => {
  test("streams the PCM as wire frames with TURN_END on the last", async () => {
    const { connect, sent } = fakeSocket({
      onSend: (data, push) => {
        if (typeof data === "string") push(READY);
      },
    });
    const vc = virtualClock();
    await driveUtterance({
      args: { url: "ws://x/ws", token: "t", pcm: PCM, collectMs: 200 },
      connect,
      sleep: vc.sleep,
      clock: vc.clock,
    });
    const binary = sent.filter((s): s is Uint8Array => typeof s !== "string");
    expect(binary.length).toBe(2);
    const last = decodeFrame(binary[1] as Uint8Array);
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.turnEnd).toBe(true);
      expect(last.seq).toBe(1);
    }
    const first = decodeFrame(binary[0] as Uint8Array);
    if (first.ok) expect(first.flags & VOICE_FLAG_TURN_END).toBe(0);
  });

  test("paces one frame per VOICE_FRAME_MS — real time, not as fast as possible", async () => {
    // A server that only works when fed faster than real time is not working.
    const vc = virtualClock();
    const slept = vc.slept;
    const { connect } = fakeSocket({
      onSend: (data, push) => {
        if (typeof data === "string") push(READY);
      },
    });
    await driveUtterance({
      args: { url: "ws://x/ws", token: "t", pcm: PCM, collectMs: 100 },
      connect,
      sleep: vc.sleep,
      clock: vc.clock,
    });
    expect(slept.filter((ms) => ms === VOICE_FRAME_MS).length).toBeGreaterThanOrEqual(2);
    expect(new Set(slept)).toEqual(new Set([VOICE_FRAME_MS]));
  });

  test("sends hello before any audio", async () => {
    const { connect, sent } = fakeSocket({
      onSend: (data, push) => {
        if (typeof data === "string") push(READY);
      },
    });
    const vc = virtualClock();
    await driveUtterance({
      args: { url: "ws://x/ws", token: "tok", pcm: PCM, collectMs: 100 },
      connect,
      sleep: vc.sleep,
      clock: vc.clock,
    });
    const hello = JSON.parse(String(sent[0])) as Record<string, unknown>;
    expect(hello.type).toBe("hello");
    expect(hello.token).toBe("tok");
    expect(hello.mode).toBe("ptt");
    expect(typeof sent[1]).not.toBe("string");
  });

  test("one second of speech is 25 frames at the wire rate", () => {
    // Sanity on the arithmetic the RUNBOOK quotes.
    expect(VOICE_SAMPLE_RATE * 2 * 1) // one second of PCM16
      .toBe(VOICE_BYTES_PER_FRAME * 25);
  });
});

describe("collection", () => {
  test("collects transcript, tool calls, and downlink bytes", async () => {
    const r = await run({
      onSend: (data, push) => {
        if (typeof data !== "string") return;
        push(READY);
        push(JSON.stringify({ type: "tool.start", id: "t1", name: "fleet_attention", args: "{}" }));
        push(JSON.stringify({ type: "tool.done", id: "t1", ok: true, summary: "2 panes", ms: 42 }));
        push(
          JSON.stringify({
            type: "transcript.assistant",
            id: "a1",
            text: "Two panes need you.",
            final: true,
          }),
        );
      },
    });
    expect(r.ok).toBe(true);
    expect(r.transcript).toBe("Two panes need you.");
    expect(r.toolNames).toEqual(["fleet_attention"]);
    expect(r.tools[0]?.ok).toBe(true);
    expect(r.tools[0]?.ms).toBe(42);
    expect(r.frameTypes).toContain("ready");
    expect(r.ready).not.toBeNull();
  });

  test("counts downlink audio payload bytes", async () => {
    const { encodeFrame } = await import("../../../../../src/core/voice/frame.ts");
    const audio = encodeFrame({ flags: 0, seq: 0, payload: new Uint8Array(160) });
    const r = await run({
      onSend: (data, push) => {
        if (typeof data !== "string") return;
        push(READY);
        push(audio);
        push(JSON.stringify({ type: "transcript.assistant", id: "a", text: "hi", final: true }));
      },
    });
    expect(r.downlinkFrames).toBe(1);
    expect(r.downlinkBytes).toBe(160);
  });

  test("fails when the assistant produces no transcript at all", async () => {
    // Silence is not success: a session that connects, streams, and says
    // nothing has proven nothing.
    const r = await run({
      onSend: (data, push) => {
        if (typeof data === "string") push(READY);
      },
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("no transcript");
  });

  test("surfaces a fatal server error frame", async () => {
    const r = await run({
      onSend: (data, push) => {
        if (typeof data !== "string") return;
        push(READY);
        push(JSON.stringify({ type: "error", code: "provider-down", fatal: true }));
      },
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("provider-down");
    expect(r.errors[0]?.fatal).toBe(true);
  });

  test("a non-fatal error does not by itself fail the run", async () => {
    const r = await run({
      onSend: (data, push) => {
        if (typeof data !== "string") return;
        push(READY);
        push(JSON.stringify({ type: "error", code: "hiccup", fatal: false, message: "m" }));
        push(JSON.stringify({ type: "transcript.assistant", id: "a", text: "ok", final: true }));
      },
    });
    expect(r.ok).toBe(true);
    expect(r.errors[0]?.message).toBe("m");
  });

  test("reports a connect failure without throwing", async () => {
    const r = await run({ failConnect: true });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("connect failed");
  });

  test("reports a missing ready frame", async () => {
    const r = await run({}, 50);
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("no ready frame");
  });

  test("ignores unparseable and unknown frames", async () => {
    const r = await run({
      onSend: (data, push) => {
        if (typeof data !== "string") return;
        push("not json");
        push(JSON.stringify({ noType: true }));
        push(JSON.stringify({ type: "status", state: "thinking" }));
        push(READY);
        push(JSON.stringify({ type: "transcript.assistant", id: "a", text: "ok", final: true }));
      },
    });
    expect(r.ok).toBe(true);
    expect(r.frameTypes).toContain("status");
  });
});

describe("default seams", () => {
  test("uses the real websocket abstraction when no connect is injected", async () => {
    // Exercises the production connect path; port 1 refuses immediately, so
    // this asserts the failure is reported rather than thrown.
    const r = await driveUtterance({
      args: { url: "ws://127.0.0.1:1/ws", token: "t", pcm: PCM, collectMs: 100 },
    });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain("connect failed");
  });

  test("runs with the real clock, sleeper, and a silent default log", async () => {
    const { connect } = fakeSocket({
      onSend: (data, push) => {
        if (typeof data !== "string") return;
        push(READY);
        push(JSON.stringify({ type: "transcript.assistant", id: "a", text: "ok", final: true }));
      },
    });
    // `collectMs` omitted too, so DEFAULT_COLLECT_MS is the window — the
    // quiet-after-final shortcut is what ends this in seconds rather than
    // sitting out the full default.
    const r = await driveUtterance({
      args: { url: "ws://x/ws", token: "t", pcm: PCM },
      connect,
    });
    expect(r.ok).toBe(true);
    expect(r.transcript).toBe("ok");
  });

  test("stops streaming when the socket closes mid-burst", async () => {
    // A closed socket must end the uplink rather than keep pushing frames
    // into a dead connection for the rest of the utterance.
    let handle: WsHandle | null = null;
    const fake = fakeSocket({
      onSend: (data, push) => {
        if (typeof data === "string") {
          push(READY);
          return;
        }
        handle?.close(1006);
      },
    });
    const vc = virtualClock();
    handle = await fake.connect();
    const r = await driveUtterance({
      args: { url: "ws://x/ws", token: "t", pcm: PCM, collectMs: 100 },
      connect: async () => handle as WsHandle,
      sleep: vc.sleep,
      clock: vc.clock,
    });
    expect(r.uplinkFrames).toBe(1);
    expect(r.closeCode).toBe(1006);
    expect(r.failure).toContain("closed with code 1006");
  });
});

describe("handleServerFrame", () => {
  const blank = (): {
    a: TranscriptAssembler;
    tools: DriveResult["tools"];
    errors: DriveResult["errors"];
    res: { ready: Record<string, unknown> | null };
  } => ({
    a: new TranscriptAssembler(),
    tools: [],
    errors: [],
    res: { ready: null },
  });

  test("only the first ready frame is kept", () => {
    const s = blank();
    handleServerFrame("ready", { provider: "a" }, s.a, s.tools, s.errors, s.res, () => {});
    handleServerFrame("ready", { provider: "b" }, s.a, s.tools, s.errors, s.res, () => {});
    expect(s.res.ready?.provider).toBe("a");
  });

  test("a malformed transcript frame is ignored", () => {
    const s = blank();
    handleServerFrame(
      "transcript.assistant",
      { id: 1, text: "x" },
      s.a,
      s.tools,
      s.errors,
      s.res,
      () => {},
    );
    expect(s.a.text()).toBe("");
  });

  test("a malformed tool.start is ignored", () => {
    const s = blank();
    handleServerFrame("tool.start", { id: "x" }, s.a, s.tools, s.errors, s.res, () => {});
    expect(s.tools.length).toBe(0);
  });

  test("tool.start without args defaults to an empty preview", () => {
    const s = blank();
    handleServerFrame(
      "tool.start",
      { id: "1", name: "n" },
      s.a,
      s.tools,
      s.errors,
      s.res,
      () => {},
    );
    expect(s.tools[0]?.args).toBe("");
  });

  test("a tool.done for an unknown id is ignored", () => {
    const s = blank();
    handleServerFrame(
      "tool.done",
      { id: "ghost", ok: true },
      s.a,
      s.tools,
      s.errors,
      s.res,
      () => {},
    );
    expect(s.tools.length).toBe(0);
  });

  test("tool.done tolerates missing summary and ms", () => {
    const s = blank();
    handleServerFrame(
      "tool.start",
      { id: "1", name: "n" },
      s.a,
      s.tools,
      s.errors,
      s.res,
      () => {},
    );
    handleServerFrame("tool.done", { id: "1", ok: false }, s.a, s.tools, s.errors, s.res, () => {});
    expect(s.tools[0]?.summary).toBeNull();
    expect(s.tools[0]?.ms).toBeNull();
    expect(s.tools[0]?.ok).toBe(false);
  });

  test("an error frame without a code is recorded as unknown", () => {
    const s = blank();
    handleServerFrame("error", { fatal: false }, s.a, s.tools, s.errors, s.res, () => {});
    expect(s.errors[0]?.code).toBe("unknown");
    expect(s.errors[0]?.message).toBeNull();
  });

  test("an unrecognized frame type is a no-op", () => {
    const s = blank();
    handleServerFrame("takeover", {}, s.a, s.tools, s.errors, s.res, () => {});
    expect(s.tools.length + s.errors.length).toBe(0);
  });
});

describe("formatDriveResult", () => {
  test("summarizes the run on one line", () => {
    const r = { ...({} as DriveResult) };
    const text = formatDriveResult({
      ...r,
      ok: true,
      transcript: "hi",
      toolNames: ["fleet_attention"],
      uplinkFrames: 2,
      downlinkBytes: 160,
      closeCode: 1000,
      failure: null,
    } as DriveResult);
    expect(text).toContain("ok=true");
    expect(text).toContain("tools=[fleet_attention]");
    expect(text).toContain("close=1000");
    expect(text).not.toContain("failure=");
  });

  test("shows an open socket and a failure when present", () => {
    const text = formatDriveResult({
      ok: false,
      transcript: "",
      toolNames: [],
      uplinkFrames: 0,
      downlinkBytes: 0,
      closeCode: null,
      failure: "boom",
    } as unknown as DriveResult);
    expect(text).toContain("close=open");
    expect(text).toContain("failure=boom");
  });
});

describe("collect-window shortcut", () => {
  test("QUIET_AFTER_FINAL_MS ends a passing run early", () => {
    // Waiting the full window on every scenario would multiply provider
    // minutes for no extra evidence.
    expect(QUIET_AFTER_FINAL_MS).toBeGreaterThan(0);
    expect(QUIET_AFTER_FINAL_MS).toBeLessThan(10_000);
  });
});

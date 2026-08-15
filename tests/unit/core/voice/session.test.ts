// ADR-272 P4 — `src/core/voice/session.ts` per-connection state machine.
//
// Everything runs against fakes: a recording PhoneLeg, a scriptable
// VoiceProvider whose legs emit events on demand, and a fake timer wheel.
// No sockets, no real clock, no provider.
//
// Assertion posture (repo NO-LIES rule): each test asserts the property
// it names. Where an ORDERING is the invariant (barge-in), the test reads
// the transcript of what the phone actually received and asserts the
// index relationship — not merely that both frames exist.

import { describe, expect, test } from "bun:test";
import type {
  VoiceSession as ProviderLeg,
  VoiceEvent,
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSessionOpts,
} from "../../../../src/abstractions/voice-provider.ts";
import type { VoiceConfig } from "../../../../src/core/voice/config.ts";
import {
  encodeFrame,
  VOICE_FLAG_TURN_END,
  VOICE_FRAME_MS,
  VOICE_MAGIC_PCM16_V1,
  VOICE_SAMPLE_RATE,
} from "../../../../src/core/voice/frame.ts";
import {
  createProviderPump,
  createVoiceSession,
  createVoiceSharedState,
  DOWNLINK_BUFFER_CAP_BYTES,
  firstLine,
  HELLO_TIMEOUT_MS,
  IDLE_CLOSE_MS,
  type PhoneLeg,
  PROVIDER_ERROR_LOG_CAP,
  PROVIDER_ERROR_LOG_MAX_CHARS,
  REDIAL_BACKOFF_MAX_MS,
  REDIAL_MAX_ATTEMPTS,
  redialBackoffMs,
  SERVER_VAD_TUNINGS,
  SESSION_READY_TIMEOUT_MS,
  TOOL_ARGS_PREVIEW_MAX_CHARS,
  type VoiceSessionDeps,
  type VoiceSharedState,
  type VoiceTimers,
} from "../../../../src/core/voice/session.ts";
import type { VoiceTeamIndex } from "../../../../src/core/voice/team-context.ts";
import type {
  ExecuteToolInput,
  ExecuteToolOutput,
  ToolBridge,
} from "../../../../src/core/voice/tool-bridge.ts";
import { VOICE_TOOL_CATALOG } from "../../../../src/core/voice/tool-catalog.ts";
import { VoiceProviderError } from "../../../../src/errors.ts";
import { VOICE_CLOSE } from "../../../../src/schema/voice.ts";

const TOKEN = "t".repeat(40);
const API_KEY = "sk-super-secret-key-do-not-leak";

// ---------- Fakes ----------

/** Yield to the macrotask queue so pump/await chains settle. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

class FakeTimers implements VoiceTimers {
  now = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.pending.set(this.seq, { at: this.now + ms, fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Advance to `now + ms`, firing due timers in due order, settling
   *  microtasks after each so chained awaits progress. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of this.pending) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const entry = this.pending.get(nextId) as { at: number; fn: () => void };
      this.pending.delete(nextId);
      this.now = entry.at;
      entry.fn();
      await flush();
    }
    this.now = target;
  }
}

class FakePhone implements PhoneLeg {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  buffered = 0;
  /** Interleaved transcript so ORDER between text and binary is assertable. */
  readonly wire: Array<{ kind: "text"; value: string } | { kind: "binary"; value: Uint8Array }> =
    [];

  send(text: string): void {
    this.texts.push(text);
    this.wire.push({ kind: "text", value: text });
  }

  sendBinary(b: Uint8Array): void {
    this.binaries.push(b);
    this.wire.push({ kind: "binary", value: b });
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  frames(): Array<Record<string, unknown>> {
    return this.texts.map((t) => JSON.parse(t) as Record<string, unknown>);
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((f) => f.type === type);
  }

  /** Index of the first frame of `type` in the interleaved wire log. */
  wireIndexOfType(type: string): number {
    return this.wire.findIndex(
      (e) => e.kind === "text" && (JSON.parse(e.value) as { type?: string }).type === type,
    );
  }

  firstBinaryWireIndex(after = -1): number {
    return this.wire.findIndex((e, i) => i > after && e.kind === "binary");
  }
}

class FakeLeg implements ProviderLeg {
  readonly sentAudio: Uint8Array[] = [];
  readonly texts: string[] = [];
  readonly toolResults: Array<{ callId: string; resultJson: string }> = [];
  turnEnds = 0;
  interrupts = 0;
  closeCalls = 0;
  /** When set, the named verb throws this error once. */
  throwOn: Partial<
    Record<"sendAudio" | "endTurn" | "sendText" | "interrupt" | "sendToolResult", Error>
  > = {};

  private readonly queue: VoiceEvent[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;

  private maybeThrow(k: keyof FakeLeg["throwOn"]): void {
    const e = this.throwOn[k];
    if (e !== undefined) {
      delete this.throwOn[k];
      throw e;
    }
  }

  sendAudio(pcm16: Uint8Array): void {
    this.maybeThrow("sendAudio");
    this.sentAudio.push(pcm16);
  }

  endTurn(): void {
    this.maybeThrow("endTurn");
    this.turnEnds += 1;
  }

  sendText(text: string): void {
    this.maybeThrow("sendText");
    this.texts.push(text);
  }

  sendToolResult(callId: string, resultJson: string): void {
    this.maybeThrow("sendToolResult");
    this.toolResults.push({ callId, resultJson });
  }

  interrupt(): void {
    this.maybeThrow("interrupt");
    this.interrupts += 1;
  }

  emit(ev: VoiceEvent): void {
    this.queue.push(ev);
    if (ev.type === "closed") this.ended = true;
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      w();
    }
  }

  async *events(): AsyncGenerator<VoiceEvent, void, unknown> {
    for (;;) {
      while (this.queue.length > 0) {
        const ev = this.queue.shift() as VoiceEvent;
        yield ev;
        if (ev.type === "closed") return;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeProvider implements VoiceProvider {
  readonly kind = "openai-realtime" as const;
  readonly legs: FakeLeg[] = [];
  readonly opts: VoiceSessionOpts[] = [];
  connectCalls = 0;
  /** Fail this many upcoming connects before succeeding. */
  failures = 0;
  /** Whether a connected leg answers with `session-ready` (see connect). */
  emitSessionReady = true;
  /** Awaited inside connect — lets a test tear the session down mid-dial. */
  gate: (() => Promise<void>) | null = null;

  async connect(_cfg: VoiceProviderConfig, opts: VoiceSessionOpts): Promise<ProviderLeg> {
    this.connectCalls += 1;
    this.opts.push(opts);
    if (this.gate !== null) await this.gate();
    if (this.failures > 0) {
      this.failures -= 1;
      throw new VoiceProviderError({ what: "dial failed" });
    }
    const leg = new FakeLeg();
    this.legs.push(leg);
    // A real provider answers the handshake: OpenAI's `session.created`,
    // Gemini's `setupComplete`. Set `emitSessionReady = false` to model
    // one that opens its socket and then goes quiet.
    if (this.emitSessionReady) leg.emit({ type: "session-ready" });
    return leg;
  }

  get lastLeg(): FakeLeg {
    return this.legs[this.legs.length - 1] as FakeLeg;
  }
}

const TEAM_INDEX: VoiceTeamIndex = {
  teams: [
    { name: "atmux", root: "/root/work/src/atmux", type: "team" },
    { name: "atmux-epic", root: "/root/work/src/atmux", type: "epic-team" },
    { name: "sopx-root", root: "/root/work/ifca/src/sopx-root", type: "team" },
  ],
};

function baseConfig(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    token: TOKEN,
    provider: "openai-realtime",
    port: 4390,
    host: "127.0.0.1",
    origins: [],
    toolTimeoutMs: 20_000,
    maxResultChars: 2000,
    readonly: false,
    resumeGraceMs: 90_000,
    confirmTtlMs: 120_000,
    ...over,
  };
}

interface Harness {
  phone: FakePhone;
  provider: FakeProvider;
  timers: FakeTimers;
  shared: VoiceSharedState;
  config: VoiceConfig;
  bridge: ToolBridge;
  session: ReturnType<typeof createVoiceSession>;
  deps: VoiceSessionDeps;
  /** Every diagnostics line the session emitted, in order. */
  logs: string[];
}

function makeHarness(
  over: {
    config?: Partial<VoiceConfig>;
    shared?: VoiceSharedState;
    provider?: FakeProvider;
    timers?: FakeTimers;
    bridge?: ToolBridge;
    uuid?: () => string;
    nowMyt?: () => string;
    /** Omit the `log` dep entirely — exercises the no-op default. */
    noLog?: boolean;
  } = {},
): Harness {
  const timers = over.timers ?? new FakeTimers();
  const config = baseConfig(over.config);
  const provider = over.provider ?? new FakeProvider();
  const phone = new FakePhone();
  const shared =
    over.shared ??
    createVoiceSharedState({ clock: () => timers.now, graceMs: config.resumeGraceMs });
  const bridge: ToolBridge = over.bridge ?? {
    executeTool: async (): Promise<ExecuteToolOutput> => ({
      envelopeJson: JSON.stringify({
        ok: true,
        tool: "team_status",
        data: "all green\nsecond line",
      }),
    }),
  };
  let n = 0;
  const logs: string[] = [];
  const deps: VoiceSessionDeps = {
    phone,
    provider,
    providerCfg: { apiKey: API_KEY, model: "gpt-realtime" },
    bridge,
    shared,
    config,
    catalog: VOICE_TOOL_CATALOG,
    teamIndex: TEAM_INDEX,
    clock: () => timers.now,
    timers,
    uuid:
      over.uuid ??
      ((): string => {
        n += 1;
        return `sess-${n}`;
      }),
    ...(over.nowMyt !== undefined ? { nowMyt: over.nowMyt } : {}),
    ...(over.noLog === true ? {} : { log: (line: string): void => void logs.push(line) }),
  };
  return {
    phone,
    provider,
    timers,
    shared,
    config,
    bridge,
    session: createVoiceSession(deps),
    deps,
    logs,
  };
}

function hello(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "hello", v: 1, token: TOKEN, mode: "ptt", ...over });
}

function audioFrame(bytes: number, seq = 0, turnEnd = false): Uint8Array {
  return encodeFrame({
    flags: turnEnd ? VOICE_FLAG_TURN_END : 0,
    seq,
    payload: new Uint8Array(bytes),
  });
}

/** Bring a harness to `live` with a dialled provider leg. */
async function live(h: Harness, helloOver: Record<string, unknown> = {}): Promise<void> {
  await h.session.handlePhoneMessage(hello(helloOver));
  await flush();
}

// ---------- Tunables + pure helpers ----------

describe("tunables + pure helpers", () => {
  test("redialBackoffMs doubles from 250ms and caps at 4s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(redialBackoffMs)).toEqual([
      250,
      500,
      1000,
      2000,
      4000,
      REDIAL_BACKOFF_MAX_MS,
      REDIAL_BACKOFF_MAX_MS,
    ]);
  });

  test("firstLine returns the whole string when there is no newline", () => {
    expect(firstLine("only line")).toBe("only line");
    expect(firstLine("head\ntail\nmore")).toBe("head");
    expect(firstLine("")).toBe("");
  });

  test("wire tunables match the documented contract", () => {
    expect(HELLO_TIMEOUT_MS).toBe(3_000);
    expect(IDLE_CLOSE_MS).toBe(120_000);
    expect(DOWNLINK_BUFFER_CAP_BYTES).toBe(512 * 1024);
    expect(REDIAL_MAX_ATTEMPTS).toBe(5);
    expect(TOOL_ARGS_PREVIEW_MAX_CHARS).toBe(200);
    expect(SERVER_VAD_TUNINGS).toEqual({
      threshold: 0.7,
      prefixPaddingMs: 220,
      silenceDurationMs: 400,
    });
  });

  test("createProviderPump survives a throwing sink and still drains the leg", async () => {
    const leg = new FakeLeg();
    const pump = createProviderPump(leg);
    const seen: string[] = [];
    let first = true;
    pump.setSink(async (ev) => {
      if (first) {
        first = false;
        throw new Error("sink bug");
      }
      seen.push(ev.type);
    });
    leg.emit({ type: "session-ready" });
    leg.emit({ type: "turn-complete" });
    leg.emit({ type: "closed", code: 1000, reason: "bye" });
    await pump.done;
    // The throwing first delivery did not strand the stream.
    expect(seen).toEqual(["turn-complete", "closed"]);
  });

  test("createProviderPump drops events while no sink is attached", async () => {
    const leg = new FakeLeg();
    const pump = createProviderPump(leg);
    leg.emit({ type: "session-ready" });
    await flush();
    const seen: string[] = [];
    pump.setSink(async (ev) => {
      seen.push(ev.type);
    });
    leg.emit({ type: "turn-complete" });
    leg.emit({ type: "closed", code: 1000, reason: "" });
    await pump.done;
    expect(seen).toEqual(["turn-complete", "closed"]);
  });
});

// ---------- Hello / auth ----------

describe("hello handshake", () => {
  test("no hello within HELLO_TIMEOUT_MS closes 4408", async () => {
    const h = makeHarness();
    expect(h.phone.closes).toHaveLength(0);
    await h.timers.advance(HELLO_TIMEOUT_MS);
    expect(h.phone.closes).toEqual([{ code: VOICE_CLOSE.HELLO_TIMEOUT, reason: "hello timeout" }]);
    // And it never dialled a provider.
    expect(h.provider.connectCalls).toBe(0);
  });

  test("a valid hello disarms the timeout — no late 4408", async () => {
    const h = makeHarness();
    await live(h);
    await h.timers.advance(HELLO_TIMEOUT_MS * 3);
    expect(h.phone.closes.filter((c) => c.code === VOICE_CLOSE.HELLO_TIMEOUT)).toHaveLength(0);
  });

  test("a wrong hello.token closes 4401 and never dials", async () => {
    const h = makeHarness();
    await h.session.handlePhoneMessage(hello({ token: "wrong-token-entirely-different" }));
    expect(h.phone.closes).toEqual([{ code: VOICE_CLOSE.AUTH, reason: "bad token" }]);
    expect(h.provider.connectCalls).toBe(0);
    expect(h.phone.ofType("ready")).toHaveLength(0);
  });

  test("pre-hello JSON garbage closes 4400", async () => {
    const h = makeHarness();
    await h.session.handlePhoneMessage("{not json");
    expect(h.phone.closes).toEqual([
      { code: VOICE_CLOSE.PROTOCOL, reason: "pre-hello protocol garbage" },
    ]);
  });

  test("a valid non-hello frame before hello closes 4400", async () => {
    const h = makeHarness();
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ping" }));
    expect(h.phone.closes).toEqual([{ code: VOICE_CLOSE.PROTOCOL, reason: "expected hello" }]);
  });

  test("binary before hello closes 4400", async () => {
    const h = makeHarness();
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.phone.closes).toEqual([{ code: VOICE_CLOSE.PROTOCOL, reason: "binary before hello" }]);
  });

  test("a duplicate hello after ready is a non-fatal protocol error", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(hello());
    const errs = h.phone.ofType("error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: "protocol", fatal: false, message: "duplicate hello" });
    expect(h.phone.closes).toHaveLength(0);
  });

  test("hello.team pre-selects the current team for the instructions", async () => {
    const h = makeHarness();
    await live(h, { team: "sopx" });
    const ready = h.phone.ofType("ready")[0] as { team: string };
    expect(ready.team).toBe("sopx-root");
    expect(h.provider.opts[0]?.instructions).toContain("The current team is sopx-root");
  });

  test("an unresolvable hello.team leaves the session team-less", async () => {
    const h = makeHarness();
    await live(h, { team: "not-a-team-at-all" });
    expect((h.phone.ofType("ready")[0] as { team: string | null }).team).toBeNull();
    expect(h.provider.opts[0]?.instructions).toContain("No current team is selected");
  });
});

// ---------- ready frame ----------

describe("ready frame", () => {
  test("carries EXACTLY the schema key set", async () => {
    const h = makeHarness();
    await live(h);
    const ready = h.phone.ofType("ready")[0] as Record<string, unknown>;
    expect(Object.keys(ready).sort()).toEqual(
      [
        "frameMs",
        "model",
        "provider",
        "rates",
        "readonly",
        "resumed",
        "sessionId",
        "team",
        "teams",
        "type",
        "vad",
      ].sort(),
    );
    expect(ready).toMatchObject({
      type: "ready",
      sessionId: "sess-1",
      resumed: false,
      provider: "openai-realtime",
      model: "gpt-realtime",
      team: null,
      teams: ["atmux", "atmux-epic", "sopx-root"],
      rates: { in: VOICE_SAMPLE_RATE, out: VOICE_SAMPLE_RATE },
      frameMs: VOICE_FRAME_MS,
      vad: false,
      readonly: false,
    });
  });

  test("leaks neither the api key nor the shared token (ADR-272 §Security)", async () => {
    const h = makeHarness();
    await live(h, { mode: "vad" });
    // Not just the ready frame — nothing the phone ever receives may carry
    // a secret, so scan the whole outbound transcript.
    const everything = h.phone.texts.join("\n");
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(TOKEN);
  });

  test("reports readonly when the config is readonly", async () => {
    const h = makeHarness({ config: { readonly: true } });
    await live(h);
    expect((h.phone.ofType("ready")[0] as { readonly: boolean }).readonly).toBe(true);
  });

  test("vad stays false in ready even when hello.mode is vad (P7 gate)", async () => {
    const h = makeHarness();
    await live(h, { mode: "vad" });
    expect((h.phone.ofType("ready")[0] as { vad: boolean }).vad).toBe(false);
  });
});

// ---------- provider connect opts ----------

describe("provider connect options", () => {
  test("ptt mode requests ptt turn detection", async () => {
    const h = makeHarness();
    await live(h);
    expect(h.provider.opts[0]?.turnDetection).toEqual({ mode: "ptt" });
  });

  test("vad mode carries George's server-vad tunings", async () => {
    const h = makeHarness();
    await live(h, { mode: "vad" });
    expect(h.provider.opts[0]?.turnDetection).toEqual({
      mode: "server-vad",
      threshold: 0.7,
      prefixPaddingMs: 220,
      silenceDurationMs: 400,
    });
  });

  test("tools are the flat-schema catalog, assignable to the provider seam", async () => {
    const h = makeHarness();
    await live(h);
    const tools = h.provider.opts[0]?.tools ?? [];
    expect(tools).toHaveLength(VOICE_TOOL_CATALOG.length);
    for (const t of tools) {
      expect(t.parameters.type).toBe("object");
      for (const prop of Object.values(t.parameters.properties)) {
        expect(["string", "number", "integer", "boolean"]).toContain(prop.type);
      }
    }
    expect(tools.map((t) => t.name)).toContain("list_teams");
  });

  test("nowMyt, when supplied, reaches the instructions", async () => {
    const h = makeHarness({ nowMyt: () => "2026-08-14 15:04 MYT" });
    await live(h);
    expect(h.provider.opts[0]?.instructions).toContain("2026-08-14 15:04 MYT");
  });
});

// ---------- uplink ----------

describe("uplink", () => {
  test("audio payload reaches the provider byte-for-byte", async () => {
    const h = makeHarness();
    await live(h);
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6]);
    await h.session.handlePhoneMessage(encodeFrame({ flags: 0, seq: 7, payload }));
    expect(h.provider.lastLeg.sentAudio).toHaveLength(1);
    expect(Array.from(h.provider.lastLeg.sentAudio[0] as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("TURN_END ends the provider turn and announces thinking", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(audioFrame(4, 1, true));
    expect(h.provider.lastLeg.turnEnds).toBe(1);
    const statuses = h.phone.ofType("status");
    expect(statuses[statuses.length - 1]).toEqual({ type: "status", state: "thinking" });
  });

  test("an empty TURN_END frame ends the turn without sending audio", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(
      encodeFrame({ flags: VOICE_FLAG_TURN_END, seq: 0, payload: new Uint8Array(0) }),
    );
    expect(h.provider.lastLeg.sentAudio).toHaveLength(0);
    expect(h.provider.lastLeg.turnEnds).toBe(1);
  });

  test("a malformed binary frame is counted and IGNORED — never closes", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(new Uint8Array([0x00, 0x00, 0x00, 0x00])); // bad magic
    await h.session.handlePhoneMessage(new Uint8Array([VOICE_MAGIC_PCM16_V1])); // short
    await h.session.handlePhoneMessage(new Uint8Array([VOICE_MAGIC_PCM16_V1, 0, 0, 0, 1])); // odd
    expect(h.session.stats().badBinaryFrames).toBe(3);
    expect(h.phone.closes).toHaveLength(0);
    expect(h.provider.lastLeg.sentAudio).toHaveLength(0);
    // Session is still usable afterwards.
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.provider.lastLeg.sentAudio).toHaveLength(1);
  });

  test("malformed JSON after hello is a non-fatal error frame, not a close", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage("}}}not json{{{");
    const errs = h.phone.ofType("error");
    expect(errs[0]).toMatchObject({ code: "protocol", fatal: false });
    expect(h.phone.closes).toHaveLength(0);
  });

  test("a schema-invalid control frame is a non-fatal error frame", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "text", text: "" }));
    expect(h.phone.ofType("error")[0]).toMatchObject({ code: "protocol", fatal: false });
  });

  test("a VoiceProviderError on sendAudio drops the frame, never crashes", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.lastLeg.throwOn.sendAudio = new VoiceProviderError({ what: "socket backed up" });
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.session.stats().droppedUplinkFrames).toBe(1);
    expect(h.phone.closes).toHaveLength(0);
  });

  test("a VoiceProviderError on endTurn drops the frame and skips the status", async () => {
    const h = makeHarness();
    await live(h);
    const before = h.phone.ofType("status").length;
    h.provider.lastLeg.throwOn.endTurn = new VoiceProviderError({ what: "dead socket" });
    await h.session.handlePhoneMessage(audioFrame(0, 0, true));
    expect(h.session.stats().droppedUplinkFrames).toBe(1);
    expect(h.phone.ofType("status")).toHaveLength(before);
  });

  test("a NON-provider error from the leg propagates (programmer bug, not transport)", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.lastLeg.throwOn.sendAudio = new TypeError("bug in the adapter");
    await expect(h.session.handlePhoneMessage(audioFrame(4))).rejects.toThrow("bug in the adapter");
  });
});

// ---------- control frames ----------

describe("control frames", () => {
  test("ptt down announces listening; ptt up announces nothing", async () => {
    const h = makeHarness();
    await live(h);
    const before = h.phone.ofType("status").length;
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ptt", down: true }));
    expect(h.phone.ofType("status")).toHaveLength(before + 1);
    expect(h.phone.ofType("status").pop()).toEqual({ type: "status", state: "listening" });
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ptt", down: false }));
    expect(h.phone.ofType("status")).toHaveLength(before + 1);
  });

  test("mode takes effect on the NEXT dial, not the live one", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "mode", mode: "vad" }));
    expect(h.provider.opts[0]?.turnDetection).toEqual({ mode: "ptt" });
    // Force a redial: the new dial must carry server-vad.
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "boom" });
    await flush();
    await h.timers.advance(500);
    expect(h.provider.connectCalls).toBe(2);
    expect(h.provider.opts[1]?.turnDetection).toMatchObject({ mode: "server-vad" });
  });

  test("text is forwarded and announces thinking", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "text", text: "fleet status" }));
    expect(h.provider.lastLeg.texts).toEqual(["fleet status"]);
    expect(h.phone.ofType("status").pop()).toEqual({ type: "status", state: "thinking" });
  });

  test("text during a redial answers with a non-fatal provider error", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.failures = 1; // the redial's first attempt fails → conn stays null
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "drop" });
    await flush();
    // Mid-backoff: no provider leg is attached.
    await h.session.handlePhoneMessage(JSON.stringify({ type: "text", text: "hello?" }));
    const err = h.phone.ofType("error").pop() as Record<string, unknown>;
    expect(err).toMatchObject({ code: "provider", fatal: false });
    expect(String(err.message)).toContain("redial");
    await h.timers.advance(10_000);
  });

  test("a VoiceProviderError on sendText is swallowed without a status", async () => {
    const h = makeHarness();
    await live(h);
    const before = h.phone.ofType("status").length;
    h.provider.lastLeg.throwOn.sendText = new VoiceProviderError({ what: "closed" });
    await h.session.handlePhoneMessage(JSON.stringify({ type: "text", text: "hi" }));
    expect(h.phone.ofType("status")).toHaveLength(before);
    expect(h.phone.closes).toHaveLength(0);
  });

  test("team resolves fuzzily and re-emits the CURRENT status (no assistant transcript)", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "text", text: "x" })); // → thinking
    await h.session.handlePhoneMessage(JSON.stringify({ type: "team", team: "sopx" }));
    expect(h.phone.ofType("status").pop()).toEqual({ type: "status", state: "thinking" });
    expect(h.phone.ofType("transcript.assistant")).toHaveLength(0);
    // Proven by the NEXT dial carrying the new team in its instructions.
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "" });
    await flush();
    await h.timers.advance(500);
    expect(h.provider.opts[1]?.instructions).toContain("The current team is sopx-root");
  });

  test("an unknown team is a non-fatal unknown_team error", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "team", team: "zzzzzzzz" }));
    const err = h.phone.ofType("error").pop() as Record<string, unknown>;
    expect(err).toMatchObject({ code: "unknown_team", fatal: false });
    expect(String(err.message)).toContain("zzzzzzzz");
  });

  test("an ambiguous team is a non-fatal ambiguous_team error listing candidates", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "team", team: "atmux" }));
    // "atmux" prefixes BOTH atmux and atmux-epic on the prefix rung...
    // ...but the exact rung matches exactly one, so this resolves.
    expect(h.phone.ofType("error")).toHaveLength(0);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "team", team: "atmu" }));
    const err = h.phone.ofType("error").pop() as Record<string, unknown>;
    expect(err).toMatchObject({ code: "ambiguous_team", fatal: false });
    expect(String(err.message)).toContain("atmux");
    expect(String(err.message)).toContain("atmux-epic");
  });

  test("ping echoes t; a bare ping replies with a bare pong", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ping", t: 1234 }));
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ping" }));
    expect(h.phone.ofType("pong")).toEqual([{ type: "pong", t: 1234 }, { type: "pong" }]);
  });
});

// ---------- barge-in ----------

describe("barge-in (cancel)", () => {
  test("audio.clear precedes any later audio AND the queue is actually flushed", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;

    // A turn is speaking.
    leg.emit({ type: "audio-out", pcm: new Uint8Array([1, 1]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(1);

    await h.session.handlePhoneMessage(JSON.stringify({ type: "cancel" }));
    const clearIdx = h.phone.wireIndexOfType("audio.clear");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(leg.interrupts).toBe(1);

    // Audio still streaming from the CANCELLED response must be suppressed
    // — this is the "queue actually flushed" half. If it were merely
    // "clear sent", these frames would still reach the phone.
    leg.emit({ type: "audio-out", pcm: new Uint8Array([2, 2]) });
    leg.emit({ type: "audio-out", pcm: new Uint8Array([3, 3]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(1);
    expect(h.session.stats().droppedDownlinkFrames).toBe(2);
    expect(h.phone.firstBinaryWireIndex(clearIdx)).toBe(-1);

    // The NEXT turn is not suppressed — the gate lifts at the boundary.
    leg.emit({ type: "turn-complete" });
    await flush();
    leg.emit({ type: "audio-out", pcm: new Uint8Array([4, 4]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(2);
    expect(h.phone.firstBinaryWireIndex(clearIdx)).toBeGreaterThan(clearIdx);
  });

  test("a TURN_END uplink also lifts the barge-in suppression", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    await h.session.handlePhoneMessage(JSON.stringify({ type: "cancel" }));
    leg.emit({ type: "audio-out", pcm: new Uint8Array([9, 9]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(0);
    await h.session.handlePhoneMessage(audioFrame(0, 1, true));
    leg.emit({ type: "audio-out", pcm: new Uint8Array([9, 9]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(1);
  });

  test("cancel with no live leg still clears the client queue", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.failures = 1;
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "" });
    await flush();
    await h.session.handlePhoneMessage(JSON.stringify({ type: "cancel" }));
    expect(h.phone.ofType("audio.clear").pop()).toEqual({
      type: "audio.clear",
      reason: "barge-in",
    });
    await h.timers.advance(10_000);
  });

  test("a VoiceProviderError on interrupt is swallowed", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.lastLeg.throwOn.interrupt = new VoiceProviderError({ what: "gone" });
    await h.session.handlePhoneMessage(JSON.stringify({ type: "cancel" }));
    expect(h.phone.ofType("audio.clear")).toHaveLength(1);
    expect(h.phone.closes).toHaveLength(0);
  });
});

// ---------- downlink ----------

describe("downlink", () => {
  test("audio-out is framed SYNTHETIC with an advancing seq and announces speaking once", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    leg.emit({ type: "audio-out", pcm: new Uint8Array([1, 2]) });
    leg.emit({ type: "audio-out", pcm: new Uint8Array([3, 4]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(2);
    const [a, b] = h.phone.binaries as [Uint8Array, Uint8Array];
    expect(a[0]).toBe(VOICE_MAGIC_PCM16_V1);
    expect(a[1]).toBe(0x02); // SYNTHETIC
    expect(new DataView(a.buffer, a.byteOffset).getUint16(2, true)).toBe(0);
    expect(new DataView(b.buffer, b.byteOffset).getUint16(2, true)).toBe(1);
    expect(Array.from(a.subarray(4))).toEqual([1, 2]);
    // "speaking" announced on the FIRST chunk of the turn, not every chunk.
    expect(h.phone.ofType("status").filter((s) => s.state === "speaking")).toHaveLength(1);
  });

  test("backpressure above the cap DROPS the frame instead of buffering", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    h.phone.buffered = DOWNLINK_BUFFER_CAP_BYTES + 1;
    leg.emit({ type: "audio-out", pcm: new Uint8Array([1, 2]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(0);
    expect(h.session.stats().droppedDownlinkFrames).toBe(1);
    // Exactly at the cap is still allowed — the guard is strictly-greater.
    h.phone.buffered = DOWNLINK_BUFFER_CAP_BYTES;
    leg.emit({ type: "audio-out", pcm: new Uint8Array([1, 2]) });
    await flush();
    expect(h.phone.binaries).toHaveLength(1);
  });

  test("transcripts relay partial then final for both roles", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    leg.emit({ type: "transcript", role: "user", id: "u1", text: "fleet st", final: false });
    leg.emit({ type: "transcript", role: "user", id: "u1", text: "fleet status", final: true });
    leg.emit({ type: "transcript", role: "assistant", id: "a1", text: "All", final: false });
    leg.emit({ type: "transcript", role: "assistant", id: "a1", text: "All green.", final: true });
    await flush();
    expect(h.phone.ofType("transcript.user")).toEqual([
      { type: "transcript.user", id: "u1", text: "fleet st", final: false },
      { type: "transcript.user", id: "u1", text: "fleet status", final: true },
    ]);
    expect(h.phone.ofType("transcript.assistant")).toEqual([
      { type: "transcript.assistant", id: "a1", text: "All", final: false },
      { type: "transcript.assistant", id: "a1", text: "All green.", final: true },
    ]);
  });

  test("speech-started clears playback and flips to listening", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    leg.emit({ type: "speech-started" });
    await flush();
    expect(h.phone.ofType("audio.clear").pop()).toEqual({
      type: "audio.clear",
      reason: "speech-started",
    });
    expect(h.phone.ofType("status").pop()).toEqual({ type: "status", state: "listening" });
  });

  test("speech-started re-arms the speaking announcement for the next chunk", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    leg.emit({ type: "audio-out", pcm: new Uint8Array([1, 1]) });
    await flush();
    leg.emit({ type: "speech-started" });
    await flush();
    leg.emit({ type: "audio-out", pcm: new Uint8Array([2, 2]) });
    await flush();
    expect(h.phone.ofType("status").filter((s) => s.state === "speaking")).toHaveLength(2);
  });

  test("session-ready is not user-visible", async () => {
    const h = makeHarness();
    await live(h);
    const before = h.phone.texts.length;
    h.provider.lastLeg.emit({ type: "session-ready" });
    await flush();
    expect(h.phone.texts).toHaveLength(before);
  });

  test("turn-complete returns the orb to idle", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.lastLeg.emit({ type: "turn-complete" });
    await flush();
    expect(h.phone.ofType("status").pop()).toEqual({ type: "status", state: "idle" });
  });

  test("a non-fatal provider-error becomes a non-fatal error frame", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.lastLeg.emit({ type: "provider-error", message: "rate limited", fatal: false });
    await flush();
    expect(h.phone.ofType("error").pop()).toEqual({
      type: "error",
      code: "provider",
      fatal: false,
      message: "rate limited",
    });
    expect(h.phone.closes).toHaveLength(0);
  });
});

// ---------- tools ----------

describe("tool calls", () => {
  function bridgeReturning(out: ExecuteToolOutput, seen: ExecuteToolInput[] = []): ToolBridge {
    return {
      executeTool: async (input): Promise<ExecuteToolOutput> => {
        seen.push(input);
        return out;
      },
    };
  }

  test("tool.start → tool.done round trip, and the envelope reaches the provider verbatim", async () => {
    const seen: ExecuteToolInput[] = [];
    const envelopeJson = JSON.stringify({
      ok: true,
      tool: "team_status",
      data: "atmux: 4 members up\nkanban: 3 todo",
    });
    const h = makeHarness({ bridge: bridgeReturning({ envelopeJson }, seen) });
    await live(h, { team: "atmux" });
    const leg = h.provider.lastLeg;
    leg.emit({
      type: "tool-call",
      id: "call_1",
      name: "team_status",
      argsJson: '{"team":"atmux"}',
    });
    await flush();

    expect(h.phone.ofType("tool.start")).toEqual([
      { type: "tool.start", id: "call_1", name: "team_status", args: '{"team":"atmux"}' },
    ]);
    expect(h.phone.ofType("status").some((s) => s.state === "working")).toBe(true);

    const done = h.phone.ofType("tool.done")[0] as Record<string, unknown>;
    expect(done).toMatchObject({ type: "tool.done", id: "call_1", ok: true });
    // Summary is the FIRST line of the envelope data, not the whole dump.
    expect(done.summary).toBe("atmux: 4 members up");
    expect(done.needs_confirmation).toBeUndefined();

    // The bridge saw the session id + current team.
    expect(seen[0]).toMatchObject({
      name: "team_status",
      argsJson: '{"team":"atmux"}',
      sessionId: "sess-1",
      currentTeam: "atmux",
    });
    // Verbatim passthrough — the model gets the full envelope, not the summary.
    expect(leg.toolResults).toEqual([{ callId: "call_1", resultJson: envelopeJson }]);
  });

  test("tool.start args are truncated to the schema's 200-char display cap", async () => {
    const h = makeHarness();
    await live(h);
    const long = `{"team":"${"x".repeat(400)}"}`;
    h.provider.lastLeg.emit({ type: "tool-call", id: "c", name: "team_status", argsJson: long });
    await flush();
    const start = h.phone.ofType("tool.start")[0] as { args: string };
    expect(start.args).toHaveLength(TOOL_ARGS_PREVIEW_MAX_CHARS);
    expect(start.args).toBe(long.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS));
  });

  test("a needs_confirmation envelope sets the snake_case flag", async () => {
    const envelopeJson = JSON.stringify({
      ok: false,
      tool: "dispatch_task",
      error: "needs_confirmation",
      token: "tok",
      preview: "Confirm dispatch task: task_id 4a2f. Say yes to proceed.",
    });
    const h = makeHarness({
      bridge: {
        executeTool: async (): Promise<ExecuteToolOutput> => ({
          envelopeJson,
          needsConfirmation: { token: "tok", preview: "Confirm dispatch task…" },
        }),
      },
    });
    await live(h);
    h.provider.lastLeg.emit({ type: "tool-call", id: "c2", name: "dispatch_task", argsJson: "{}" });
    await flush();
    const done = h.phone.ofType("tool.done")[0] as Record<string, unknown>;
    expect(done.ok).toBe(false);
    expect(done.needs_confirmation).toBe(true);
    expect(done.summary).toBe("needs_confirmation");
    expect(h.provider.lastLeg.toolResults[0]?.resultJson).toBe(envelopeJson);
  });

  test("a failed envelope summarizes to its error code", async () => {
    const h = makeHarness({
      bridge: bridgeReturning({
        envelopeJson: JSON.stringify({ ok: false, tool: "team_status", error: "unknown_team" }),
      }),
    });
    await live(h);
    h.provider.lastLeg.emit({ type: "tool-call", id: "c3", name: "team_status", argsJson: "{}" });
    await flush();
    expect(h.phone.ofType("tool.done")[0]).toMatchObject({ ok: false, summary: "unknown_team" });
  });

  test("an unparseable envelope still answers the turn", async () => {
    const h = makeHarness({ bridge: bridgeReturning({ envelopeJson: "<<<not json>>>" }) });
    await live(h);
    h.provider.lastLeg.emit({ type: "tool-call", id: "c4", name: "team_status", argsJson: "{}" });
    await flush();
    expect(h.phone.ofType("tool.done")[0]).toMatchObject({ ok: false, summary: "error" });
    expect(h.provider.lastLeg.toolResults[0]?.resultJson).toBe("<<<not json>>>");
  });

  test("an ok envelope with no data summarizes to the empty string", async () => {
    const h = makeHarness({
      bridge: bridgeReturning({ envelopeJson: JSON.stringify({ ok: true, tool: "list_teams" }) }),
    });
    await live(h);
    h.provider.lastLeg.emit({ type: "tool-call", id: "c5", name: "list_teams", argsJson: "" });
    await flush();
    expect(h.phone.ofType("tool.done")[0]).toMatchObject({ ok: true, summary: "" });
  });

  test("tool duration is measured on the injected clock", async () => {
    const timers = new FakeTimers();
    const h = makeHarness({
      timers,
      bridge: {
        executeTool: async (): Promise<ExecuteToolOutput> => {
          timers.now += 1234;
          return { envelopeJson: JSON.stringify({ ok: true, data: "done" }) };
        },
      },
    });
    await live(h);
    h.provider.lastLeg.emit({ type: "tool-call", id: "c6", name: "team_status", argsJson: "{}" });
    await flush();
    expect(h.phone.ofType("tool.done")[0]).toMatchObject({ ms: 1234 });
  });

  test("a VoiceProviderError on sendToolResult is swallowed", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.lastLeg.throwOn.sendToolResult = new VoiceProviderError({ what: "closed" });
    h.provider.lastLeg.emit({ type: "tool-call", id: "c7", name: "team_status", argsJson: "{}" });
    await flush();
    expect(h.phone.ofType("tool.done")).toHaveLength(1);
    expect(h.phone.closes).toHaveLength(0);
  });

  test("a tool result arriving after the leg died still reaches the phone", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    h.provider.failures = REDIAL_MAX_ATTEMPTS; // keep conn null after the drop
    leg.emit({ type: "tool-call", id: "c8", name: "team_status", argsJson: "{}" });
    leg.emit({ type: "closed", code: 1006, reason: "" });
    await flush();
    expect(h.phone.ofType("tool.done")).toHaveLength(1);
    await h.timers.advance(30_000);
  });
});

// ---------- redial ----------

describe("provider redial", () => {
  test("recovers mid-way through the backoff ladder", async () => {
    const h = makeHarness();
    await live(h);
    expect(h.provider.connectCalls).toBe(1);
    h.provider.failures = 2; // attempts 0+1 fail, attempt 2 succeeds
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "network" });
    await flush();
    expect(h.phone.ofType("status").pop()).toEqual({ type: "status", state: "thinking" });

    await h.timers.advance(250);
    expect(h.provider.connectCalls).toBe(2);
    await h.timers.advance(500);
    expect(h.provider.connectCalls).toBe(3);
    await h.timers.advance(1000);
    expect(h.provider.connectCalls).toBe(4);

    // Recovered: a fresh leg is attached and audio flows again.
    expect(h.phone.closes).toHaveLength(0);
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.provider.lastLeg.sentAudio).toHaveLength(1);
  });

  test("exhausting the budget errors fatal and closes 4500", async () => {
    const h = makeHarness();
    await live(h);
    h.provider.failures = REDIAL_MAX_ATTEMPTS;
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "gone" });
    await flush();
    await h.timers.advance(30_000);

    // 1 initial dial + REDIAL_MAX_ATTEMPTS redials.
    expect(h.provider.connectCalls).toBe(1 + REDIAL_MAX_ATTEMPTS);
    expect(h.phone.ofType("error").pop()).toEqual({
      type: "error",
      code: "provider-unrecoverable",
      fatal: true,
    });
    expect(h.phone.closes).toEqual([
      { code: VOICE_CLOSE.PROVIDER, reason: "provider unrecoverable" },
    ]);
  });

  test("a FRESH dial that fails every attempt also closes 4500 without a ready", async () => {
    const h = makeHarness();
    h.provider.failures = REDIAL_MAX_ATTEMPTS;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    await h.timers.advance(30_000);
    await p;
    expect(h.phone.ofType("ready")).toHaveLength(0);
    expect(h.phone.closes).toEqual([
      { code: VOICE_CLOSE.PROVIDER, reason: "provider unrecoverable" },
    ]);
  });

  test("a dial that completes AFTER teardown closes the orphan leg and does not resurrect", async () => {
    const h = makeHarness();
    let release: (() => void) | null = null;
    h.provider.gate = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    // The phone hangs up cleanly while the dial is still in flight.
    h.session.handlePhoneClose(VOICE_CLOSE.NORMAL);
    (release as unknown as () => void)();
    await p;
    await flush();

    expect(h.provider.legs).toHaveLength(1);
    expect(h.provider.lastLeg.closeCalls).toBe(1); // orphan hung up on
    expect(h.phone.ofType("ready")).toHaveLength(0); // never resurrected
    expect(h.shared.registry.current()).toBeNull();
  });

  // ---- session-ready timeout (the quiet-provider hang) ----
  //
  // `connectWebSocket` bounds only the WS handshake. `session-ready`
  // arrives afterwards from an inbound provider frame, so a provider that
  // opens its socket and then goes quiet — or sends a frame its adapter
  // cannot parse — used to leave the dial hanging forever: no ready, no
  // error, no `closed`. Neither adapter's own tests can reach this.

  test("a provider that never answers the handshake times out and redials", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false; // connects, then goes quiet
    const p = h.session.handlePhoneMessage(hello());
    await flush();

    // The socket is up and a leg exists, but the dial has NOT completed:
    // no ready frame reaches the phone.
    expect(h.provider.connectCalls).toBe(1);
    expect(h.phone.ofType("ready")).toHaveLength(0);

    // Nothing happens until the budget elapses — the wait is real.
    await h.timers.advance(SESSION_READY_TIMEOUT_MS - 1);
    expect(h.provider.connectCalls).toBe(1);

    // On expiry the wedged leg is hung up on and the next attempt begins.
    // A FRESH dial spends attempt 0 immediately, so its second attempt
    // sits on rung 1 of the ladder (500ms) — 250ms is the redial path's
    // first rung, not this one.
    await h.timers.advance(1);
    expect(h.provider.legs[0]?.closeCalls).toBe(1);
    await h.timers.advance(redialBackoffMs(1));
    expect(h.provider.connectCalls).toBe(2);

    // A provider that answers on a later attempt recovers the session:
    // attempt 1's budget expires, then attempt 2 waits rung 2 (1s).
    h.provider.emitSessionReady = true;
    await h.timers.advance(SESSION_READY_TIMEOUT_MS + redialBackoffMs(2) + 1);
    await p;
    expect(h.phone.ofType("ready")).toHaveLength(1);
    expect(h.phone.closes).toHaveLength(0);
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.provider.lastLeg.sentAudio).toHaveLength(1);
  });

  test("a permanently quiet provider exhausts the budget and closes 4500", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    // 5 attempts × 12s timeout + the backoff ladder (7.75s) ≈ 68s — which
    // must stay well inside IDLE_CLOSE_MS so the operator hears the right
    // cause, not a 120s idle close.
    await h.timers.advance(5 * SESSION_READY_TIMEOUT_MS + 10_000);
    await p;

    expect(h.provider.connectCalls).toBe(REDIAL_MAX_ATTEMPTS);
    // Every wedged leg was hung up on — none left dangling.
    for (const leg of h.provider.legs) expect(leg.closeCalls).toBe(1);
    expect(h.phone.ofType("ready")).toHaveLength(0);
    expect(h.phone.ofType("error").pop()).toEqual({
      type: "error",
      code: "provider-unrecoverable",
      fatal: true,
    });
    expect(h.phone.closes).toEqual([
      { code: VOICE_CLOSE.PROVIDER, reason: "provider unrecoverable" },
    ]);
    // Crucially it did NOT fall through to the idle path.
    expect(h.phone.closes.some((c) => c.reason === "idle")).toBe(false);
    expect(h.timers.now).toBeLessThan(IDLE_CLOSE_MS);
  });

  test("a quiet provider on a REDIAL is bounded the same way", async () => {
    const h = makeHarness();
    await live(h);
    expect(h.phone.ofType("ready")).toHaveLength(1);

    h.provider.emitSessionReady = false;
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "network" });
    await flush();
    await h.timers.advance(250);
    expect(h.provider.connectCalls).toBe(2); // reconnected, but quiet

    h.provider.emitSessionReady = true;
    await h.timers.advance(SESSION_READY_TIMEOUT_MS + 500);
    // Recovered on the following attempt without bothering the phone.
    expect(h.phone.closes).toHaveLength(0);
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.provider.lastLeg.sentAudio).toHaveLength(1);
  });

  test("a leg dying mid-handshake fails that attempt without a nested redial", async () => {
    const h = makeHarness();
    await live(h);
    const first = h.provider.lastLeg;
    h.provider.emitSessionReady = false;
    first.emit({ type: "closed", code: 1006, reason: "drop" });
    await flush();
    await h.timers.advance(250);
    expect(h.provider.connectCalls).toBe(2);

    // The replacement leg dies while we await ITS session-ready. That must
    // fail the attempt in place — a second concurrent dialLoop would race
    // for `conn` and burn the budget twice as fast.
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "again" });
    await flush();
    expect(h.provider.connectCalls).toBe(2); // no immediate re-entrant dial

    h.provider.emitSessionReady = true;
    await h.timers.advance(500);
    expect(h.provider.connectCalls).toBe(3);
    expect(h.phone.closes).toHaveLength(0);
  });

  test("a provider close while the phone is already gone does not redial", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    h.session.handlePhoneClose(VOICE_CLOSE.NORMAL); // clean release → full teardown
    leg.emit({ type: "closed", code: 1006, reason: "" });
    await flush();
    await h.timers.advance(30_000);
    expect(h.provider.connectCalls).toBe(1);
  });
});

// ---------- dial diagnostics ----------
//
// THE INCIDENT THIS PINS. On the first live dial (2026-08-15) the OpenAI
// adapter was still speaking the retired Realtime BETA shape. Every one of
// the 5 attempts failed, the phone was closed 4500, and the entire server
// log held nothing but the startup banner — while the provider had said,
// on the wire, `beta_api_shape_disabled: "The Realtime Beta API is no
// longer supported."` Diagnosing it took hand-written throwaway WebSocket
// probes against the live API.
//
// So these tests are not "logging exists" tests. Each one asserts that a
// specific, load-bearing FACT reaches the log: the provider's error code,
// the attempt counter, WHICH of the three dial faults occurred, and the
// elapsed budget at exhaustion. If the logging regressed to a bare
// "dial failed", every test below fails.

describe("dial diagnostics", () => {
  /** The exact frame OpenAI answered with on 2026-08-15. */
  const BETA_ERROR = {
    type: "provider-error" as const,
    code: "beta_api_shape_disabled",
    message:
      "The Realtime Beta API is no longer supported. Please use /v1/realtime for the GA API.",
    fatal: false,
  };

  /** Reproduce the incident: the leg opens, answers with the provider's
   *  error, then hangs up — never sending `session-ready`. */
  function emitBetaFailure(h: Harness, closeCode = 4000): void {
    h.provider.lastLeg.emit(BETA_ERROR);
    h.provider.lastLeg.emit({ type: "closed", code: closeCode, reason: "beta shape" });
  }

  test("the happy path is ONE line, and it names provider, model and attempt", async () => {
    const h = makeHarness();
    await live(h);
    expect(h.logs).toEqual([
      `voice: provider ready — openai-realtime/gpt-realtime attempt 1/${REDIAL_MAX_ATTEMPTS} in 0ms`,
    ]);
  });

  test("a failed attempt logs the PROVIDER'S OWN error code and message", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    emitBetaFailure(h);
    await flush();

    const failure = h.logs.find((l) => l.includes("dial attempt 1/"));
    expect(failure).toBeDefined();
    // The load-bearing half: the code names the fault CLASS.
    expect(failure).toContain("beta_api_shape_disabled");
    expect(failure).toContain("The Realtime Beta API is no longer supported");
    expect(failure).toContain(`dial attempt 1/${REDIAL_MAX_ATTEMPTS}`);
    expect(failure).toContain("openai-realtime/gpt-realtime");
    // ...and the backoff about to be waited.
    expect(failure).toContain(`retrying in ${redialBackoffMs(1)}ms`);

    await h.timers.advance(60_000);
    await p;
  });

  test("the provider-error event is itself logged with its code, before the attempt fails", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    h.provider.lastLeg.emit(BETA_ERROR);
    await flush();

    const errLine = h.logs.find((l) => l.includes("provider error"));
    expect(errLine).toBe(
      "voice: provider error (openai-realtime/gpt-realtime) [beta_api_shape_disabled] The Realtime Beta API is no longer supported. Please use /v1/realtime for the GA API.",
    );
    // Drain: every attempt here is a full SESSION_READY_TIMEOUT_MS wait
    // (the leg never closes), so the budget must clear 5×12s + backoffs.
    await h.timers.advance(120_000);
    await p;
  });

  test("a HANDSHAKE TIMEOUT is labelled distinctly from a refused socket", async () => {
    const quiet = makeHarness();
    quiet.provider.emitSessionReady = false; // socket opens, provider goes silent
    const pq = quiet.session.handlePhoneMessage(hello());
    await flush();
    await quiet.timers.advance(SESSION_READY_TIMEOUT_MS);
    const quietLine = quiet.logs.find((l) => l.includes("dial attempt 1/"));
    expect(quietLine).toContain(`no session-ready within ${SESSION_READY_TIMEOUT_MS}ms`);
    expect(quietLine).toContain("socket opened, provider handshake never completed");

    const refused = makeHarness();
    refused.provider.failures = 1; // connect() itself throws
    const pr = refused.session.handlePhoneMessage(hello());
    await flush();
    const refusedLine = refused.logs.find((l) => l.includes("dial attempt 1/"));
    expect(refusedLine).toContain("connect failed —");
    // The two faults must NOT read the same: "the socket opened and the
    // provider went quiet" is a different bug from "the socket was refused".
    expect(refusedLine).not.toContain("no session-ready within");
    expect(quietLine).not.toContain("connect failed");

    await quiet.timers.advance(60_000);
    await refused.timers.advance(60_000);
    await Promise.all([pq, pr]);
  });

  test("a leg that hangs up before session-ready reports the CLOSE CODE", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    emitBetaFailure(h, 4000);
    await flush();

    const failure = h.logs.find((l) => l.includes("dial attempt 1/"));
    expect(failure).toContain("provider closed before session-ready");
    expect(failure).toContain("code=4000");
    expect(failure).toContain("reason=beta shape");
    await h.timers.advance(60_000);
    await p;
  });

  test("exhaustion states the attempts made, the elapsed time, and the 4500 close", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    // Each attempt: leg opens, provider complains, leg hangs up.
    for (let i = 0; i < REDIAL_MAX_ATTEMPTS; i += 1) {
      emitBetaFailure(h);
      await flush();
      await h.timers.advance(redialBackoffMs(i + 1));
    }
    await p;

    expect(h.phone.closes).toEqual([
      { code: VOICE_CLOSE.PROVIDER, reason: "provider unrecoverable" },
    ]);
    const exhausted = h.logs.find((l) => l.includes("dial exhausted"));
    expect(exhausted).toBeDefined();
    expect(exhausted).toContain(`${REDIAL_MAX_ATTEMPTS} attempts`);
    expect(exhausted).toContain(`closing phone ${VOICE_CLOSE.PROVIDER}`);
    expect(exhausted).toContain("provider-unrecoverable");
    // Elapsed is a real measurement off the injected clock, not a constant:
    // 250+500+1000+2000 of backoff elapsed across the five attempts.
    const elapsed = Number(/ in (\d+)ms/.exec(exhausted as string)?.[1]);
    expect(elapsed).toBe(
      redialBackoffMs(1) + redialBackoffMs(2) + redialBackoffMs(3) + redialBackoffMs(4),
    );
    // And it still names the cause — the single most important fact.
    expect(exhausted).toContain("beta_api_shape_disabled");
  });

  test("the last-attempt line says there are no attempts left, not 'retrying'", async () => {
    const h = makeHarness();
    h.provider.failures = REDIAL_MAX_ATTEMPTS;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    await h.timers.advance(60_000);
    await p;
    const last = h.logs.filter((l) => l.includes("dial attempt")).pop();
    expect(last).toContain(`dial attempt ${REDIAL_MAX_ATTEMPTS}/${REDIAL_MAX_ATTEMPTS}`);
    expect(last).toContain("no attempts left");
    expect(last).not.toContain("retrying in");
  });

  test("a mid-session provider close logs the redial WITH its close code", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "network" });
    await flush();
    await h.timers.advance(redialBackoffMs(0));

    const redial = h.logs.find((l) => l.includes("closed mid-session"));
    expect(redial).toBe(
      "voice: provider closed mid-session (openai-realtime/gpt-realtime) code=1006 reason=network — redialing",
    );
  });

  test("a close with no reason renders the code alone, not a dangling 'reason='", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    h.provider.lastLeg.emit({ type: "closed", code: 1006, reason: "" });
    await flush();
    expect(h.logs.find((l) => l.includes("closed mid-session"))).toBe(
      "voice: provider closed mid-session (openai-realtime/gpt-realtime) code=1006 — redialing",
    );
  });

  test("provider errors are CAPPED per leg — one suppression notice, then silence", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    const total = PROVIDER_ERROR_LOG_CAP + 4;
    for (let i = 0; i < total; i += 1) {
      h.provider.lastLeg.emit({ type: "provider-error", message: `blip ${i}`, fatal: false });
    }
    await flush();

    const errLines = h.logs.filter(
      (l) => l.includes("provider error") && !l.includes("suppressed"),
    );
    expect(errLines).toHaveLength(PROVIDER_ERROR_LOG_CAP);
    expect(h.logs.filter((l) => l.includes("suppressed"))).toHaveLength(1);
    // A per-frame provider error must not become a per-frame log line.
    expect(h.logs.length).toBe(PROVIDER_ERROR_LOG_CAP + 1);
    // The phone still gets EVERY one — the cap is on the log, not the wire.
    expect(h.phone.ofType("error")).toHaveLength(total);
  });

  test("the cap resets per leg, so a later attempt's errors are not silenced by an earlier one's", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    for (let i = 0; i < PROVIDER_ERROR_LOG_CAP + 2; i += 1) {
      h.provider.lastLeg.emit({ type: "provider-error", message: `leg1-${i}`, fatal: false });
    }
    h.provider.lastLeg.emit({ type: "closed", code: 4000, reason: "" });
    await flush();
    await h.timers.advance(redialBackoffMs(1));
    // Attempt 2's leg — its first error must be logged again.
    h.provider.lastLeg.emit({ type: "provider-error", message: "leg2-first", fatal: false });
    await flush();
    expect(h.logs.some((l) => l.includes("leg2-first"))).toBe(true);

    await h.timers.advance(60_000);
    await p;
  });

  test("an attempt's failure line never quotes the PREVIOUS attempt's provider error", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    h.provider.lastLeg.emit({
      type: "provider-error",
      message: "stale-from-attempt-1",
      fatal: false,
    });
    h.provider.lastLeg.emit({ type: "closed", code: 4000, reason: "" });
    await flush();
    await h.timers.advance(redialBackoffMs(1));
    // Attempt 2 says nothing before timing out.
    await h.timers.advance(SESSION_READY_TIMEOUT_MS);

    const second = h.logs.find((l) => l.includes("dial attempt 2/"));
    expect(second).toBeDefined();
    expect(second).not.toContain("stale-from-attempt-1");
    expect(second).not.toContain("last provider error");

    await h.timers.advance(60_000);
    await p;
  });

  test("a fatal provider error is marked fatal in the log", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    h.provider.lastLeg.emit({ type: "provider-error", message: "session died", fatal: true });
    await flush();
    expect(h.logs[0]).toContain("provider error (fatal)");
  });

  test("a codeless provider error logs the message alone, with no empty bracket", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    h.provider.lastLeg.emit({ type: "provider-error", message: "rate limited", fatal: false });
    await flush();
    expect(h.logs[0]).toBe("voice: provider error (openai-realtime/gpt-realtime) rate limited");
  });

  test("an oversized provider message is truncated before it reaches the log", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    const huge = "x".repeat(PROVIDER_ERROR_LOG_MAX_CHARS * 3);
    h.provider.lastLeg.emit({ type: "provider-error", message: huge, fatal: false });
    await flush();
    const xs = /x+/.exec(h.logs[0] as string)?.[0] ?? "";
    expect(xs).toHaveLength(PROVIDER_ERROR_LOG_MAX_CHARS);
  });

  // ---- NO SPEECH (ADR-272 OQ-4) ----

  test("NOTHING the operator said reaches this log — no transcripts, no tool args", async () => {
    const h = makeHarness();
    await live(h);
    h.logs.length = 0;
    const leg = h.provider.lastLeg;
    leg.emit({
      type: "transcript",
      role: "user",
      id: "u1",
      text: "cancel the deploy to production immediately",
      final: true,
    });
    leg.emit({
      type: "transcript",
      role: "assistant",
      id: "a1",
      text: "understood, cancelling the deploy",
      final: false,
    });
    leg.emit({
      type: "tool-call",
      id: "c1",
      name: "tell_lead",
      argsJson: JSON.stringify({ team: "atmux", message: "stand down, we are reverting" }),
    });
    leg.emit({ type: "speech-started" });
    leg.emit({ type: "turn-complete" });
    await flush();

    // The phone DID receive the transcripts — the events were really live.
    expect(h.phone.ofType("transcript.user")).toHaveLength(1);
    expect(h.phone.ofType("tool.start")).toHaveLength(1);
    // ...and the server log stayed empty. Transcripts are the sensitive
    // payload bounded by ADR-272 OQ-4; this sink is protocol events only.
    expect(h.logs).toEqual([]);
  });

  test("a session built WITHOUT a log sink stays silent instead of guessing one", async () => {
    const h = makeHarness({ noLog: true });
    h.provider.failures = REDIAL_MAX_ATTEMPTS;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    await h.timers.advance(60_000);
    await p;
    // The dial really did run and really did exhaust...
    expect(h.provider.connectCalls).toBe(REDIAL_MAX_ATTEMPTS);
    expect(h.phone.closes).toEqual([
      { code: VOICE_CLOSE.PROVIDER, reason: "provider unrecoverable" },
    ]);
    // ...with no sink to write to, and no crash.
    expect(h.logs).toEqual([]);
  });

  test("a teardown mid-handshake is not reported as a dial failure", async () => {
    const h = makeHarness();
    h.provider.emitSessionReady = false;
    const p = h.session.handlePhoneMessage(hello());
    await flush();
    h.logs.length = 0;
    // Takeover displaces this session while it waits for session-ready.
    h.shared.registry.claim({ sessionId: "other", onTakeover: () => {} });
    await flush();
    await h.timers.advance(60_000);
    await p;
    // Our own teardown is not a provider fault and must not be logged as one.
    expect(h.logs.filter((l) => l.includes("dial attempt"))).toEqual([]);
    expect(h.logs.filter((l) => l.includes("dial exhausted"))).toEqual([]);
  });
});

// ---------- park / resume / takeover ----------

describe("park, resume and takeover", () => {
  test("suspend parks the leg and closes 1000; resume within grace reattaches", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const provider = new FakeProvider();
    const a = makeHarness({ timers, shared, provider });
    await live(a);
    const leg = provider.lastLeg;
    const sessionId = (a.phone.ofType("ready")[0] as { sessionId: string }).sessionId;

    await a.session.handlePhoneMessage(JSON.stringify({ type: "suspend" }));
    expect(a.phone.closes).toEqual([{ code: VOICE_CLOSE.NORMAL, reason: "suspended" }]);
    expect(leg.closeCalls).toBe(0); // the provider leg is PARKED, not closed
    expect(shared.parked.has(sessionId)).toBe(true);

    // A second connection resumes inside the grace window.
    await timers.advance(30_000);
    const b = makeHarness({ timers, shared, provider });
    await b.session.handlePhoneMessage(hello({ resume: sessionId }));
    await flush();
    const ready = b.phone.ofType("ready")[0] as { resumed: boolean; sessionId: string };
    expect(ready).toMatchObject({ resumed: true, sessionId });
    // No new dial — it adopted the parked leg.
    expect(provider.connectCalls).toBe(1);

    // The adopted leg now drives the NEW phone.
    leg.emit({ type: "transcript", role: "assistant", id: "a", text: "still here", final: true });
    await flush();
    expect(b.phone.ofType("transcript.assistant")).toHaveLength(1);
    expect(a.phone.ofType("transcript.assistant")).toHaveLength(0);
  });

  test("an abnormal phone drop parks; a clean 1000 close releases", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const dropped = makeHarness({ timers, shared });
    await live(dropped);
    const droppedLeg = dropped.provider.lastLeg;
    dropped.session.handlePhoneClose(1006);
    expect(shared.parked.size).toBe(1);
    expect(droppedLeg.closeCalls).toBe(0);

    const clean = makeHarness({
      timers,
      shared: createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 }),
    });
    await live(clean);
    const cleanLeg = clean.provider.lastLeg;
    clean.session.handlePhoneClose(VOICE_CLOSE.NORMAL);
    expect(cleanLeg.closeCalls).toBe(1);
  });

  test("grace expiry tears the parked leg down; a later resume gets a FRESH session", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const provider = new FakeProvider();
    const a = makeHarness({ timers, shared, provider });
    await live(a);
    const leg = provider.lastLeg;
    const sessionId = (a.phone.ofType("ready")[0] as { sessionId: string }).sessionId;
    a.session.handlePhoneClose(1006);

    await timers.advance(90_001);
    expect(leg.closeCalls).toBe(1);
    expect(shared.parked.size).toBe(0);
    expect(shared.registry.current()).toBeNull();

    const b = makeHarness({ timers, shared, provider, uuid: () => "sess-after-expiry" });
    await b.session.handlePhoneMessage(hello({ resume: sessionId }));
    await flush();
    const ready = b.phone.ofType("ready")[0] as { resumed: boolean; sessionId: string };
    expect(ready.resumed).toBe(false);
    expect(ready.sessionId).not.toBe(sessionId);
    expect(provider.connectCalls).toBe(2); // it had to dial again
  });

  test("resume of an unknown session id falls through to a fresh session", async () => {
    const h = makeHarness();
    await h.session.handlePhoneMessage(hello({ resume: "nope-not-a-session" }));
    await flush();
    expect(h.phone.ofType("ready")[0]).toMatchObject({ resumed: false });
    expect(h.provider.connectCalls).toBe(1);
  });

  test("registry knows the id but the leg is gone → release + fresh session", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const provider = new FakeProvider();
    const a = makeHarness({ timers, shared, provider });
    await live(a);
    const sessionId = (a.phone.ofType("ready")[0] as { sessionId: string }).sessionId;
    a.session.handlePhoneClose(1006);
    // Simulate the defensive hole: registry still parked, leg record gone.
    shared.parked.delete(sessionId);

    const b = makeHarness({ timers, shared, provider });
    await b.session.handlePhoneMessage(hello({ resume: sessionId }));
    await flush();
    expect(b.phone.ofType("ready")[0]).toMatchObject({ resumed: false });
    expect(provider.connectCalls).toBe(2);
  });

  test("the provider leg dying mid-park dissolves the park", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const a = makeHarness({ timers, shared });
    await live(a);
    const leg = a.provider.lastLeg;
    a.session.handlePhoneClose(1006);
    expect(shared.parked.size).toBe(1);
    leg.emit({ type: "closed", code: 1006, reason: "provider died while parked" });
    await flush();
    expect(shared.parked.size).toBe(0);
    expect(shared.registry.current()).toBeNull();
  });

  test("latest-wins: a second claim announces takeover, closes 4001 and kills the first leg", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const provider = new FakeProvider();
    const a = makeHarness({ timers, shared, provider });
    await live(a);
    const firstLeg = provider.lastLeg;

    const b = makeHarness({ timers, shared, provider });
    await live(b);

    expect(a.phone.ofType("takeover")).toEqual([{ type: "takeover" }]);
    expect(a.phone.closes).toEqual([{ code: VOICE_CLOSE.TAKEOVER, reason: "takeover" }]);
    expect(firstLeg.closeCalls).toBe(1);
    // The new session owns the slot — NOT released by the displaced one.
    expect(shared.registry.current()?.state).toBe("live");
    expect(b.phone.ofType("ready")[0]).toMatchObject({ resumed: false });
  });

  test("a RESUMED session becomes the takeover target (owner re-pointing)", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const provider = new FakeProvider();
    const a = makeHarness({ timers, shared, provider });
    await live(a);
    const sessionId = (a.phone.ofType("ready")[0] as { sessionId: string }).sessionId;
    a.session.handlePhoneClose(1006);

    const b = makeHarness({ timers, shared, provider });
    await b.session.handlePhoneMessage(hello({ resume: sessionId }));
    await flush();
    expect(b.phone.ofType("ready")[0]).toMatchObject({ resumed: true });

    // A third phone claims fresh: B (the CURRENT owner) must be the one
    // torn down — not A, whose hook the registry originally closed over.
    const c = makeHarness({ timers, shared, provider });
    await live(c);
    expect(b.phone.ofType("takeover")).toEqual([{ type: "takeover" }]);
    expect(b.phone.closes).toEqual([{ code: VOICE_CLOSE.TAKEOVER, reason: "takeover" }]);
    expect(a.phone.ofType("takeover")).toHaveLength(0);
  });

  test("a parked session displaced by a new claim is torn down, not left parked", async () => {
    const timers = new FakeTimers();
    const shared = createVoiceSharedState({ clock: () => timers.now, graceMs: 90_000 });
    const provider = new FakeProvider();
    const a = makeHarness({ timers, shared, provider });
    await live(a);
    const parkedLeg = provider.lastLeg;
    a.session.handlePhoneClose(1006);
    expect(shared.parked.size).toBe(1);

    const b = makeHarness({ timers, shared, provider });
    await live(b);
    expect(shared.parked.size).toBe(0);
    expect(parkedLeg.closeCalls).toBe(1);
  });

  test("frames arriving after a park are ignored", async () => {
    const h = makeHarness();
    await live(h);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "suspend" }));
    const before = h.phone.texts.length;
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ping", t: 1 }));
    await h.session.handlePhoneMessage(audioFrame(4));
    expect(h.phone.texts).toHaveLength(before);
  });

  test("a phone close before hello ends the session with no park", async () => {
    const h = makeHarness();
    h.session.handlePhoneClose(1006);
    expect(h.shared.parked.size).toBe(0);
    expect(h.timers.pendingCount).toBe(0); // hello timer disarmed
    await h.timers.advance(HELLO_TIMEOUT_MS * 2);
    expect(h.phone.closes).toHaveLength(0);
  });

  test("a repeat phone close after teardown is a no-op", async () => {
    const h = makeHarness();
    await live(h);
    h.session.handlePhoneClose(VOICE_CLOSE.NORMAL);
    const legCloses = h.provider.lastLeg.closeCalls;
    h.session.handlePhoneClose(VOICE_CLOSE.NORMAL);
    expect(h.provider.lastLeg.closeCalls).toBe(legCloses);
  });
});

// ---------- idle ----------

describe("idle close", () => {
  test("no phone frames for IDLE_CLOSE_MS closes 1000 and parks", async () => {
    const h = makeHarness();
    await live(h);
    const leg = h.provider.lastLeg;
    await h.timers.advance(IDLE_CLOSE_MS);
    expect(h.phone.closes).toEqual([{ code: VOICE_CLOSE.NORMAL, reason: "idle" }]);
    expect(h.shared.parked.size).toBe(1);
    expect(leg.closeCalls).toBe(0); // parked, resumable
  });

  test("any phone frame resets the idle timer", async () => {
    const h = makeHarness();
    await live(h);
    await h.timers.advance(IDLE_CLOSE_MS - 1);
    await h.session.handlePhoneMessage(JSON.stringify({ type: "ping" }));
    await h.timers.advance(IDLE_CLOSE_MS - 1);
    expect(h.phone.closes).toHaveLength(0);
    await h.timers.advance(2);
    expect(h.phone.closes).toEqual([{ code: VOICE_CLOSE.NORMAL, reason: "idle" }]);
  });

  test("the session exposes its id once hello lands", async () => {
    const h = makeHarness();
    expect(h.session.id).toBe("");
    await live(h);
    expect(h.session.id).toBe("sess-1");
  });
});

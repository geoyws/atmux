// ADR-272 P4 test helper — a REAL `Bun.serve` voice server on an
// ephemeral port, wired to a fake provider.
//
// Nothing here is mocked except the provider: the HTTP routes, the auth
// gate, the WebSocket upgrade, the frame codec and the whole session
// state machine are the production code paths. That is the point — a
// test that stubs the server proves nothing about the server.
//
// Port note: `resolveVoxConfig` deliberately refuses a non-positive
// port (it fails closed to 4390), so port 0 cannot be reached through
// config. The harness therefore overrides `deps.config.port` on the
// built object — a test-only poke at a plain field, not a production
// path.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  VoiceSession as ProviderLeg,
  VoiceEvent,
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSessionOpts,
} from "../../src/abstractions/voice-provider.ts";
import type { VerbFn } from "../../src/core/verb-capture.ts";
import type { VoxTeamIndex } from "../../src/core/vox/team-context.ts";
import type { VoxRunnerKey } from "../../src/core/vox/tool-catalog.ts";
import { VoiceProviderError } from "../../src/errors.ts";
import {
  buildVoxDeps,
  startVoxServer,
  type VoxServeDeps,
  type VoxServerHandle,
} from "../../src/verbs/vox.ts";

/** Yield to the macrotask queue so pump/await chains settle. */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/**
 * Poll `cond` until true or the budget elapses. Returns whether it held.
 *
 * The condition may be async (an HTTP probe, say) and the result is
 * AWAITED — a bare `if (cond())` on a promise is always truthy, which
 * would make every such wait pass instantly and assert nothing.
 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  return await cond();
}

/** A scriptable provider leg: records every outbound verb, emits inbound
 *  events on demand. */
export class FakeLeg implements ProviderLeg {
  readonly sentAudio: Uint8Array[] = [];
  readonly texts: string[] = [];
  readonly toolResults: Array<{ callId: string; resultJson: string }> = [];
  turnEnds = 0;
  interrupts = 0;
  closeCalls = 0;
  /** Set a key to make that verb throw ONCE, then clear itself. */
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
    // Copy: Bun hands the server a pooled buffer that is reused after the
    // handler returns, so retaining the view would alias later frames.
    this.sentAudio.push(new Uint8Array(pcm16));
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

export class FakeProvider implements VoiceProvider {
  readonly kind = "openai-realtime" as const;
  readonly legs: FakeLeg[] = [];
  readonly opts: VoiceSessionOpts[] = [];
  readonly configs: VoiceProviderConfig[] = [];
  connectCalls = 0;
  /** Fail this many upcoming connects before succeeding. */
  failures = 0;
  /** Whether a connected leg answers with `session-ready` (see connect). */
  emitSessionReady = true;
  /** Awaited inside connect — lets a test act while a dial is in flight. */
  gate: (() => Promise<void>) | null = null;

  async connect(cfg: VoiceProviderConfig, opts: VoiceSessionOpts): Promise<ProviderLeg> {
    this.connectCalls += 1;
    this.configs.push(cfg);
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

/**
 * `$HOME` every test server resolves its transcript directory against
 * (ADR-272 OQ-4). NEVER the real one: `serveVox` runs a retention sweep
 * at boot, and a unit suite that swept the operator's actual
 * `~/.atmux/vox-logs/` would delete real recordings. Nothing creates
 * this path, so the sweep finds no directory and does nothing — which is
 * also the shape the "absent directory is not an error" case needs.
 */
export const TEST_VOX_HOME = join(tmpdir(), "atmux-vox-test-home");

export const TEST_VOX_TOKEN = "v".repeat(40);
export const TEST_OPENAI_KEY = "sk-test-key-must-never-reach-the-client";

export const TEST_TEAM_INDEX: VoxTeamIndex = {
  teams: [
    { name: "atmux", root: "/root/work/src/atmux", type: "team" },
    { name: "sopx-root", root: "/root/work/ifca/src/sopx-root", type: "team" },
  ],
};

export interface VoxServerCtx {
  deps: VoxServeDeps;
  handle: VoxServerHandle;
  provider: FakeProvider;
  token: string;
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  /** `ws://127.0.0.1:<port>/ws?token=<token>` — for browser-style clients
   *  that cannot set request headers (the PWA's situation). */
  wsUrl: string;
  /**
   * `ws://127.0.0.1:<port>/ws` with NO token in the URL.
   *
   * The probe MUST authenticate with this one. Handing it a pre-tokenized
   * URL is what let a probe that never sent its token to the pre-upgrade
   * gate pass every test while the documented commands 401'd in reality.
   */
  wsUrlNoToken: string;
  /** What the server wrote to its (redacting) stderr sink. */
  logSink: LogSink;
}

export interface WithVoxServerOpts {
  env?: Record<string, string>;
  flags?: Record<string, unknown>;
  provider?: FakeProvider;
  teamIndex?: VoxTeamIndex;
  runners?: Partial<Record<VoxRunnerKey, VerbFn>>;
  maxFrames?: number;
  log?: (line: string) => void;
  /** Leave `createVoxLogger`'s sink at its PRODUCTION default
   *  (`process.stderr`) instead of routing it into `logSink` — for the
   *  tests that assert the default wiring itself. */
  logToStderr?: boolean;
}

/**
 * Captures what the server would write to stderr.
 *
 * Deliberately hooks the RAW BYTE SINK under `createVoxLogger` rather
 * than replacing `deps.log`: the redactor stays in the path, so a test
 * asserting a secret is absent is asserting it about production's own
 * code, not about a stand-in that happens to be safe.
 */
export class LogSink {
  /** Every chunk exactly as it would have hit stderr (newline included). */
  readonly chunks: string[] = [];

  readonly write = (chunk: string): void => {
    this.chunks.push(chunk);
  };

  /** Chunks with their trailing newline stripped. */
  get lines(): string[] {
    return this.chunks.map((c) => c.replace(/\n$/, ""));
  }

  /** Everything written, concatenated — for absence assertions. */
  get text(): string {
    return this.chunks.join("");
  }

  find(substr: string): string | undefined {
    return this.lines.find((l) => l.includes(substr));
  }

  matching(substr: string): string[] {
    return this.lines.filter((l) => l.includes(substr));
  }
}

/** Build deps for a test server: real config resolution + a fake provider. */
export async function buildTestDeps(opts: WithVoxServerOpts = {}): Promise<{
  deps: VoxServeDeps;
  provider: FakeProvider;
  logSink: LogSink;
}> {
  const provider = opts.provider ?? new FakeProvider();
  const logSink = new LogSink();
  const env: NodeJS.ProcessEnv = {
    ATMUX_VOX_TOKEN: TEST_VOX_TOKEN,
    OPENAI_API_KEY: TEST_OPENAI_KEY,
    HOME: TEST_VOX_HOME,
    ...opts.env,
  };
  const deps = await buildVoxDeps({
    env,
    ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
    loadTeamIndex: async () => opts.teamIndex ?? TEST_TEAM_INDEX,
    makeProvider: () => provider,
    ...(opts.runners !== undefined ? { runners: opts.runners } : {}),
    ...(opts.logToStderr === true ? {} : { logWrite: logSink.write }),
  });
  return { deps, provider, logSink };
}

/**
 * Boot a real voice server on an ephemeral port, run `body`, then stop it
 * — even if `body` throws.
 */
export async function withVoxServer(
  opts: WithVoxServerOpts,
  body: (ctx: VoxServerCtx) => Promise<void>,
): Promise<void> {
  const { deps, provider, logSink } = await buildTestDeps(opts);
  // See the port note in the file header.
  deps.config.port = 0;
  const handle = startVoxServer({
    deps,
    ...(opts.maxFrames !== undefined ? { maxFrames: opts.maxFrames } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  const token = deps.config.token;
  const baseUrl = `http://127.0.0.1:${handle.port}`;
  const ctx: VoxServerCtx = {
    deps,
    handle,
    provider,
    token,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(token)}`,
    wsUrlNoToken: `ws://127.0.0.1:${handle.port}/ws`,
    logSink,
  };
  try {
    await body(ctx);
  } finally {
    handle.stop();
    await handle.done;
  }
}

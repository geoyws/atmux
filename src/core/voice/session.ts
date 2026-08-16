// ADR-272: voice operator interface — the per-connection session state
// machine (P4). Fully injected: no sockets (PhoneLeg seam), no real
// timers (VoiceTimers seam), no wall clock (clock seam), no uuid source
// (uuid seam) — every behavior is drivable from tests with fakes.
//
// Lifecycle (ADR-272 D8 + §Security):
//   awaiting-hello → (valid hello within HELLO_TIMEOUT_MS, else 4408)
//   → token re-assert via checkToken (mismatch → 4401)
//   → resume path (registry.tryResume + parked-leg adopt → resumed:true)
//     or fresh path (uuid, registry.claim latest-wins, provider dial)
//   → live → parked (suspend / abnormal phone drop / idle) → resumed
//     within resumeGraceMs, or torn down at grace expiry.
//
// Ownership indirection: `VoiceSharedState.owners` maps sessionId → the
// CURRENT owner's takeover-teardown hook. registry.claim closures route
// through it, so a session resumed by a NEW connection re-points the
// takeover target without re-claiming (a re-claim would tear down the
// leg being adopted).
//
// Discipline pins:
//   - Mic audio buffered during a disconnect is DISCARDED, never
//     replayed (D8 — nothing here buffers uplink).
//   - Downlink backpressure: a frame is DROPPED (counted) when
//     phone.bufferedAmount() exceeds DOWNLINK_BUFFER_CAP_BYTES — never
//     buffered unboundedly.
//   - Barge-in ordering invariant: `audio.clear` is sent BEFORE any
//     subsequent audio; provider audio still streaming from the
//     cancelled response is suppressed until the turn boundary. BOTH
//     barge-in paths obey it — the phone's `cancel` and the provider's
//     `speech-started` (ADR-272 §Supplement-P7 §R4).
//   - No stdout writes anywhere (stdout is capture-owned while a verb
//     runs). Diagnostics go through the injected `log` seam, which the
//     verb layer points at stderr behind a redactor
//     (`src/core/voice/log.ts`). Default is a no-op, so a session built
//     without one stays silent rather than guessing a sink.
//   - What `log` carries, and what it MUST NOT. It carries the
//     provider-dial story — attempt N of MAX, provider kind + model, the
//     provider's error CODE and message, handshake-timeout vs
//     socket-refused, mid-session redials, and exhaustion with attempts +
//     elapsed. That set exists because the first live dial (2026-08-15)
//     failed all 5 attempts and closed 4500 with NOTHING in the server
//     log but the startup banner, while the provider had plainly said
//     `beta_api_shape_disabled`. It carries NO SPEECH: no transcript
//     text, no tool arguments, nothing the operator said — transcripts
//     are the sensitive payload bounded by ADR-272 OQ-4 (local-only,
//     7-day retention), and these are protocol events. Tool NAMES are
//     fine; tool ARGUMENTS are not.
//   - Speech has exactly ONE persistence path: the optional
//     `openTranscript` sink (`src/core/voice/transcript.ts`), which is
//     absent unless the operator set `ATMUX_VOICE_TRANSCRIPTS=1`. The
//     two sinks are disjoint by design — `log` carries protocol events
//     and no speech; the transcript sink carries speech and nothing else.
//   - A tool result is bound to the leg that ISSUED the call. A call id
//     is meaningful only inside the provider session that minted it, so a
//     redial during a slow tool means the result is DROPPED (with a log
//     line) rather than delivered to a leg that never asked
//     (ADR-272 §Supplement-P7 §R3).
//   - Frames arriving while `dialing` are ignored; binary before hello
//     (or any pre-hello garbage) closes 4400.
//   - Client-frame + provider-event switches are EXHAUSTIVE (no
//     `default:` arm): both unions are closed types, and TS forces a
//     new arm when either grows.

import { z } from "zod";
import { tryParseJsonString } from "../../abstractions/json.ts";
import type {
  VoiceSession as ProviderLeg,
  VoiceEvent,
  VoiceProvider,
  VoiceProviderConfig,
  VoiceSessionOpts,
  VoiceToolDef,
  VoiceTurnDetection,
} from "../../abstractions/voice-provider.ts";
import { VoiceProviderError } from "../../errors.ts";
import {
  type ClientFrame,
  type HelloFrame,
  type PongFrame,
  parseClientFrame,
  type ReadyFrame,
  type ServerFrame,
  type StatusFrame,
  type ToolDoneFrame,
  VOICE_CLOSE,
} from "../../schema/voice.ts";
import { checkToken } from "./auth.ts";
import type { VoiceConfig } from "./config.ts";
import {
  decodeFrame,
  encodeFrame,
  nextSeq,
  VOICE_FLAG_SYNTHETIC,
  VOICE_FRAME_MS,
  VOICE_SAMPLE_RATE,
} from "./frame.ts";
import { buildInstructions } from "./instructions.ts";
import { createSessionRegistry, type SessionRegistry } from "./registry.ts";
import { resolveTeamName, type VoiceTeamIndex } from "./team-context.ts";
import type { ToolBridge } from "./tool-bridge.ts";
import { toolJsonSchema, type VoiceToolEntry } from "./tool-catalog.ts";
import type { VoiceTranscriptSink } from "./transcript.ts";

// ---------- Tunables (wire contract — tests pin these) ----------

/** A valid `hello` must arrive within this budget or the socket closes 4408. */
export const HELLO_TIMEOUT_MS = 3_000;
/** No phone frames (any kind) for this long → close 1000 + park. */
export const IDLE_CLOSE_MS = 120_000;
/** Downlink backpressure cap: above this `bufferedAmount()`, audio frames
 *  are dropped (counted), never buffered unboundedly. */
export const DOWNLINK_BUFFER_CAP_BYTES = 512 * 1024;
/** Provider redial budget after an unexpected `closed`. */
export const REDIAL_MAX_ATTEMPTS = 5;
/**
 * Budget from "socket open" to the provider's `session-ready`.
 *
 * `connectWebSocket` bounds only the WS handshake (10s). `session-ready`
 * arrives afterwards, from an INBOUND provider frame — OpenAI's
 * `session.created`, Gemini's `setupComplete`. A provider that opens the
 * socket and then goes quiet (or sends a frame its adapter cannot parse)
 * would otherwise leave the dial hanging forever: no ready, no error, and
 * no `closed` to trigger a redial. This bounds that wait, and expiry is
 * treated as a FAILED DIAL ATTEMPT so it inherits the redial backoff and
 * the 5-attempt exhaustion path rather than falling through to the far
 * slower idle-close (which would also report the wrong cause).
 */
export const SESSION_READY_TIMEOUT_MS = 12_000;
/** Redial backoff: 250ms doubling, capped at 4s (250→500→1000→2000→4000). */
export const REDIAL_BACKOFF_BASE_MS = 250;
export const REDIAL_BACKOFF_MAX_MS = 4_000;
/** `tool.start.args` display-preview cap (schema pins ≤200). */
export const TOOL_ARGS_PREVIEW_MAX_CHARS = 200;
/** George's server-VAD tunings — reachable behind hello.mode === "vad"
 *  (ready still reports vad:false until P7 — ADR-272 OQ-3). */
export const SERVER_VAD_TUNINGS = Object.freeze({
  threshold: 0.7,
  prefixPaddingMs: 220,
  silenceDurationMs: 400,
} as const);

/**
 * Non-fatal `provider-error` events LOGGED per provider leg before the
 * sink goes quiet for that leg.
 *
 * Provider errors are advisory and can repeat per frame; logging every
 * one would drown the dial story this logging exists to tell, and could
 * write a line per audio frame under a misbehaving provider. The cap
 * keeps the first few (which is where the diagnosis is), then emits ONE
 * suppression notice so a reader knows the tail was dropped rather than
 * absent. The counter resets on every new dial attempt.
 */
export const PROVIDER_ERROR_LOG_CAP = 3;
/** Provider error messages are truncated to this before logging — a
 *  provider echoing a whole frame must not blow up a log line. */
export const PROVIDER_ERROR_LOG_MAX_CHARS = 300;

/**
 * Tool NAMES are truncated to this before they reach a log line.
 *
 * A tool name looks like server-controlled data and is not: it arrives on
 * the provider's tool-call frame, so a hallucinating model can put an
 * arbitrary string there. The catalog's longest name is 15 characters
 * (`fleet_attention`), so
 * this never touches a real one — it only bounds what an invented name can
 * write, which is the same NO-SPEECH property `log.ts` exists to protect.
 * Applied by {@link VoiceServerSessionImpl.toolLabel} at every callsite
 * that logs a name, including the stale-result drop line.
 */
export const TOOL_NAME_LOG_MAX_CHARS = 64;
/**
 * Tool failure CLASSES are truncated to this before they reach a log line.
 *
 * The class is `envelope.error`, and the bridge only ever writes one of
 * the closed `ToolErrorCode` set there — the longest is 23 chars
 * (`verb_output_unparseable`).
 * The cap is for the envelope the bridge did NOT write: a garbled or
 * hand-injected one, where `error` is whatever it happens to be. Same
 * reasoning as the name cap; the log's no-speech guarantee should not
 * depend on a producer staying well-behaved.
 */
export const TOOL_ERROR_CLASS_LOG_MAX_CHARS = 48;
/** Failure class logged when the envelope was unparseable — the bridge
 *  answered with something that is not our envelope shape at all. */
export const TOOL_ERROR_CLASS_UNPARSEABLE = "unparseable-envelope";
/** Failure class logged when the envelope parsed but named no error. */
export const TOOL_ERROR_CLASS_UNSPECIFIED = "unspecified";

/** Probe for the presence of a `confirm_token` on a tool call. Presence
 *  ONLY — the value is a credential and the arguments are speech; neither
 *  is read out of this, and neither is logged (ADR-272 OQ-4). */
const ConfirmTokenProbeSchema = z.object({ confirm_token: z.string().optional() }).passthrough();

/**
 * Which side of the D7 round trip a confirm-gated call landed on.
 *
 * `null` for an ungated tool, and for a gated one that never reached the
 * gate (bad args, unknown team, readonly) — claiming either of the two
 * stages there would be a lie about what happened.
 */
export type ConfirmStage = "previewed" | "redeemed";

/** Backoff for redial attempt N (0-based). */
export function redialBackoffMs(attempt: number): number {
  return Math.min(REDIAL_BACKOFF_BASE_MS * 2 ** attempt, REDIAL_BACKOFF_MAX_MS);
}

/**
 * How a pending `awaitSessionReady` settled. The three failure arms are
 * NOT interchangeable in a log: "the socket opened and the provider went
 * quiet" (`timeout`) is a different fault from "the provider hung up
 * before answering" (`provider-closed`), which is different again from
 * "we tore the session down while waiting" (`aborted`, never a dial
 * failure). Collapsing them to a boolean is what made the 2026-08-15
 * exhaustion unreadable.
 */
export type SessionReadyOutcome = "ready" | "timeout" | "provider-closed" | "aborted";

/** A provider-reported fault, kept for the dial-failure line. */
interface ProviderErrorNote {
  code: string | null;
  message: string;
}

/** Render a provider error as `[code] message`, or bare message when the
 *  provider sent no code. */
export function formatProviderError(note: ProviderErrorNote): string {
  return note.code !== null ? `[${note.code}] ${note.message}` : note.message;
}

/** Render a WS close as `code=<n> reason=<r>`; `code` is null when the
 *  provider has no such concept, and an empty reason is elided. */
export function formatCloseInfo(code: number | null, reason: string): string {
  const codePart = `code=${code === null ? "none" : code}`;
  return reason === "" ? codePart : `${codePart} reason=${reason}`;
}

/** Message text of an unknown thrown value. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Seams ----------

/** The phone-side transport seam — the verb layer adapts a Bun
 *  ServerWebSocket onto this; tests inject a recorder. */
export interface PhoneLeg {
  send(text: string): void;
  sendBinary(b: Uint8Array): void;
  close(code: number, reason: string): void;
  bufferedAmount(): number;
}

/** Timer seam — real setTimeout/clearTimeout in production, fake in tests. */
export interface VoiceTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// ---------- Provider event pump ----------

/** Sink for normalized provider events. Swappable so a resumed session
 *  re-points the pump at the new connection's session object. */
export type ProviderEventSink = (ev: VoiceEvent) => Promise<void>;

export interface ProviderPump {
  setSink(sink: ProviderEventSink | null): void;
  /** Resolves when the leg's event stream ends (after `closed`). */
  readonly done: Promise<void>;
}

/** One pump per provider leg — the single consumer of `leg.events()`.
 *  A throwing sink never kills the pump (the session's handler is
 *  expected to be total, but a bug there must not strand the stream). */
export function createProviderPump(leg: ProviderLeg): ProviderPump {
  let sink: ProviderEventSink | null = null;
  // Read through a call, not the binding: `sink` is only ever assigned
  // `null` at the point this closure is created, so TS narrows a direct
  // read to `never` and rejects the call. Same shape as `dashboardLoop`'s
  // `isAborted()` — a function result is not narrowed across statements.
  const currentSink = (): ProviderEventSink | null => sink;
  const done = (async () => {
    for await (const ev of leg.events()) {
      const s = currentSink();
      if (s !== null) {
        try {
          await s(ev);
        } catch {
          // expected: defensive — a sink bug must not kill the pump
        }
      }
    }
  })();
  return {
    setSink(s: ProviderEventSink | null): void {
      sink = s;
    },
    done,
  };
}

// ---------- Shared server-wide state ----------

/** A live provider connection: the leg + its pump travel together. */
export interface ProviderConn {
  leg: ProviderLeg;
  pump: ProviderPump;
}

/** A parked session's transferable state (ADR-272 D8). */
export interface ParkedLeg {
  conn: ProviderConn;
  currentTeam: string | null;
  seq: number;
  /** Grace-expiry timer handle (via the VoiceTimers seam). */
  timer: unknown;
}

/** Server-wide singleton state shared by every connection's session. */
export interface VoiceSharedState {
  registry: SessionRegistry;
  /** sessionId → CURRENT owner's takeover-teardown hook (see header). */
  owners: Map<string, () => void>;
  /** sessionId → parked provider leg awaiting `hello.resume`. */
  parked: Map<string, ParkedLeg>;
}

/** Build the shared state (one per server). */
export function createVoiceSharedState(opts: {
  clock: () => number;
  graceMs: number;
}): VoiceSharedState {
  return {
    registry: createSessionRegistry({ clock: opts.clock, graceMs: opts.graceMs }),
    owners: new Map(),
    parked: new Map(),
  };
}

// ---------- Session ----------

export interface VoiceSessionDeps {
  phone: PhoneLeg;
  provider: VoiceProvider;
  providerCfg: VoiceProviderConfig;
  bridge: ToolBridge;
  shared: VoiceSharedState;
  config: VoiceConfig;
  /** The visible tool catalog (readonly-filtered by the caller —
   *  ADR-272 §Security layer 5: absent, not refused). */
  catalog: ReadonlyArray<VoiceToolEntry>;
  teamIndex: VoiceTeamIndex;
  clock: () => number;
  timers: VoiceTimers;
  uuid: () => string;
  /** Pre-formatted MYT timestamp for the instructions builder. */
  nowMyt?: () => string;
  /**
   * Diagnostics sink — one call per line, newline added by the sink.
   * Production points this at stderr through `createVoiceLogger`, which
   * redacts secrets structurally. Defaults to a no-op.
   *
   * NO SPEECH may be passed here (see the module header).
   */
  log?: (line: string) => void;
  /**
   * Per-session transcript sink factory (ADR-272 OQ-4). ABSENT unless the
   * operator opted in with `ATMUX_VOICE_TRANSCRIPTS=1` — a session built
   * without it records nothing, which is the shipped default and the
   * reason this is an optional dep rather than a flag read in here.
   *
   * Called once, with the session id, as soon as that id exists (fresh
   * dial or resumed park), so one file carries one session.
   */
  openTranscript?: (sessionId: string) => VoiceTranscriptSink;
}

export interface VoiceSessionStats {
  badBinaryFrames: number;
  droppedUplinkFrames: number;
  droppedDownlinkFrames: number;
}

export interface VoiceServerSession {
  handlePhoneMessage(data: string | Uint8Array): Promise<void>;
  handlePhoneClose(code: number): void;
  stats(): VoiceSessionStats;
  /** Session id — empty string until a hello lands. */
  readonly id: string;
}

type Phase = "awaiting-hello" | "dialing" | "live" | "parked" | "ended";

/** Tool-envelope shape the session reads back for `tool.done` (the
 *  bridge produced it; loose parse — a garbled envelope still answers). */
const EnvelopeSchema = z
  .object({
    ok: z.boolean().optional(),
    error: z.string().optional(),
    data: z.string().optional(),
  })
  .passthrough();

/** First line of a (possibly multi-line) string. */
export function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

class VoiceServerSessionImpl implements VoiceServerSession {
  private readonly deps: VoiceSessionDeps;
  private readonly log: (line: string) => void;
  private phase: Phase = "awaiting-hello";
  private phoneOpen = true;
  private sessionId = ""; // empty until hello; set exactly once per fresh/resume
  /** Transcript sink for this session, or null when recording is off
   *  (the default — ADR-272 OQ-4 ships transcripts opt-in). */
  private transcript: VoiceTranscriptSink | null = null;
  private conn: ProviderConn | null = null;
  private currentTeam: string | null = null;
  private mode: "ptt" | "vad" = "ptt";
  private seq = 0;
  private statusState: StatusFrame["state"] = "idle";
  /** Barge-in flush: provider audio suppressed until the turn boundary. */
  private suppressAudio = false;
  private speakingAnnounced = false;
  private helloTimer: unknown = null;
  private idleTimer: unknown = null;
  private parkTimer: unknown = null;
  /** Pending `session-ready` wait (see SESSION_READY_TIMEOUT_MS). */
  private sessionReadyTimer: unknown = null;
  private sessionReadyResolve: ((outcome: SessionReadyOutcome) => void) | null = null;
  /** Last provider-reported fault on the CURRENT leg — the payload the
   *  dial-failure and exhaustion lines carry. Reset per attempt. */
  private lastProviderError: ProviderErrorNote | null = null;
  /** provider-error events seen on the current leg (drives the log cap). */
  private providerErrorsSeen = 0;
  /** How the current leg closed — for `provider-closed` failure text. */
  private lastCloseInfo: { code: number | null; reason: string } | null = null;
  /** True while `dialLoop` is running — blocks a re-entrant redial. */
  private dialInFlight = false;
  private badBinaryFrames = 0;
  private droppedUplinkFrames = 0;
  private droppedDownlinkFrames = 0;

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
    this.log = deps.log ?? ((): void => {});
    this.helloTimer = deps.timers.setTimeout(() => {
      this.helloTimer = null;
      this.endPreHello(VOICE_CLOSE.HELLO_TIMEOUT, "hello timeout");
    }, HELLO_TIMEOUT_MS);
  }

  get id(): string {
    return this.sessionId;
  }

  /** Phase read behind a call so TS does not narrow `this.phase` across
   *  an `await` — the session CAN be torn down while a dial is in
   *  flight, which is exactly what `dialLoop` re-checks for. */
  private isEnded(): boolean {
    return this.phase === "ended";
  }

  stats(): VoiceSessionStats {
    return {
      badBinaryFrames: this.badBinaryFrames,
      droppedUplinkFrames: this.droppedUplinkFrames,
      droppedDownlinkFrames: this.droppedDownlinkFrames,
    };
  }

  // ---------- Phone-side inbound ----------

  async handlePhoneMessage(data: string | Uint8Array): Promise<void> {
    if (this.phase === "ended" || this.phase === "parked") return;
    if (this.phase === "live") this.resetIdleTimer();
    if (typeof data !== "string") {
      this.handleBinary(data);
      return;
    }
    const parsed = parseClientFrame(data);
    if (!parsed.ok) {
      if (this.phase === "awaiting-hello") {
        this.endPreHello(VOICE_CLOSE.PROTOCOL, "pre-hello protocol garbage");
        return;
      }
      this.sendJson({ type: "error", code: "protocol", fatal: false, message: parsed.error });
      return;
    }
    const frame = parsed.frame;
    if (this.phase === "awaiting-hello") {
      if (frame.type !== "hello") {
        this.endPreHello(VOICE_CLOSE.PROTOCOL, "expected hello");
        return;
      }
      await this.onHello(frame);
      return;
    }
    if (this.phase === "dialing") return; // ignored until the dial settles
    await this.onControlFrame(frame);
  }

  handlePhoneClose(code: number): void {
    this.phoneOpen = false;
    if (this.phase === "ended" || this.phase === "parked") return;
    if (this.phase === "awaiting-hello") {
      this.clearHelloTimer();
      this.phase = "ended";
      return;
    }
    // dialing or live.
    if (code === VOICE_CLOSE.NORMAL) {
      // Clean client release — no park (ADR-272 D8: park is for drops).
      this.fullTeardown();
      return;
    }
    if (this.phase === "live" && this.conn !== null) {
      this.park();
      return;
    }
    // Abnormal drop with no live leg (mid-dial / mid-redial) — release.
    this.fullTeardown();
  }

  // ---------- Binary uplink ----------

  private handleBinary(buf: Uint8Array): void {
    if (this.phase === "awaiting-hello") {
      this.endPreHello(VOICE_CLOSE.PROTOCOL, "binary before hello");
      return;
    }
    if (this.phase !== "live") {
      this.droppedUplinkFrames += 1;
      return;
    }
    const decoded = decodeFrame(buf);
    if (!decoded.ok) {
      this.badBinaryFrames += 1;
      return;
    }
    const conn = this.conn;
    if (conn === null) {
      // mid-redial — mic audio is discarded, never replayed (D8)
      this.droppedUplinkFrames += 1;
      return;
    }
    if (decoded.payload.length > 0) {
      try {
        conn.leg.sendAudio(decoded.payload);
      } catch (e) {
        if (!(e instanceof VoiceProviderError)) throw e;
        this.droppedUplinkFrames += 1;
      }
    }
    if (decoded.turnEnd) {
      try {
        conn.leg.endTurn();
      } catch (e) {
        if (!(e instanceof VoiceProviderError)) throw e;
        this.droppedUplinkFrames += 1;
        return;
      }
      this.suppressAudio = false;
      this.sendStatus("thinking");
    }
  }

  // ---------- Hello / dial ----------

  private async onHello(hello: HelloFrame): Promise<void> {
    this.clearHelloTimer();
    if (!checkToken(hello.token, this.deps.config.token)) {
      this.phoneOpen = false;
      this.deps.phone.close(VOICE_CLOSE.AUTH, "bad token");
      this.phase = "ended";
      return;
    }
    this.mode = hello.mode;
    if (hello.resume !== undefined) {
      const resumed = this.deps.shared.registry.tryResume(hello.resume);
      if (resumed.ok) {
        const entry = this.deps.shared.parked.get(hello.resume);
        if (entry !== undefined) {
          this.adopt(hello.resume, entry);
          return;
        }
        // Defensive: registry knew the id but the leg is gone (e.g. the
        // provider died mid-park) — release + fall through to fresh.
        this.deps.shared.registry.release(hello.resume);
      }
    }
    await this.freshSession(hello);
  }

  /** Open this session's transcript sink, if recording is enabled. No-op
   *  otherwise — `this.transcript` stays null and nothing is ever
   *  written (ADR-272 OQ-4 §off-by-default). */
  private openTranscript(sessionId: string): void {
    this.transcript = this.deps.openTranscript?.(sessionId) ?? null;
  }

  private adopt(sessionId: string, entry: ParkedLeg): void {
    this.deps.timers.clearTimeout(entry.timer);
    this.deps.shared.parked.delete(sessionId);
    this.sessionId = sessionId;
    // Same id → same transcript file: a resume APPENDS to the record the
    // pre-drop half of the conversation started (ADR-272 D8 + OQ-4).
    this.openTranscript(sessionId);
    this.conn = entry.conn;
    this.currentTeam = entry.currentTeam;
    this.seq = entry.seq;
    // Re-point the takeover hook at THIS session (see module header).
    this.deps.shared.owners.set(sessionId, () => this.teardownForTakeover());
    entry.conn.pump.setSink((ev) => this.onProviderEvent(ev));
    this.phase = "live";
    this.armIdleTimer();
    this.sendReady(true);
  }

  private async freshSession(hello: HelloFrame): Promise<void> {
    const sessionId = this.deps.uuid();
    this.sessionId = sessionId;
    this.openTranscript(sessionId);
    this.deps.shared.registry.claim({
      sessionId,
      onTakeover: () => {
        this.deps.shared.owners.get(sessionId)?.();
      },
    });
    this.deps.shared.owners.set(sessionId, () => this.teardownForTakeover());
    if (hello.team !== undefined) {
      const resolved = resolveTeamName(this.deps.teamIndex, hello.team);
      if (resolved.ok) this.currentTeam = resolved.team.name;
    }
    this.phase = "dialing";
    const ok = await this.dialLoop(false);
    if (!ok) return; // dialLoop closed the session (or a mid-dial abort)
    this.phase = "live";
    this.armIdleTimer();
    this.sendReady(false);
  }

  /** Dial (or redial) the provider with backoff. Initial dials attempt
   *  immediately; redials wait first. Returns false when the session
   *  ended mid-loop or the budget is exhausted (which errors + closes
   *  4500).
   *
   *  LOGGING SHAPE — one line per ATTEMPT, carrying the outcome. A
   *  successful dial is therefore a single line (the "provider ready"
   *  one), which is what keeps the happy path quiet; a failed attempt is
   *  a single line naming the provider, the model, attempt N of MAX, the
   *  distinguishable failure reason, the provider's own error code +
   *  message, and the backoff about to be waited. Emitting a
   *  before-the-attempt line as well would double every session's dial
   *  chatter to buy nothing: `connectWebSocket` bounds the handshake at
   *  10s and `SESSION_READY_TIMEOUT_MS` bounds the wait after it, so an
   *  attempt cannot hang without producing its outcome line. */
  private async dialLoop(redial: boolean): Promise<boolean> {
    // Re-entrancy guard: a leg that dies mid-dial delivers `closed`, and
    // without this the handler would start a SECOND concurrent dialLoop
    // (each with its own 5-attempt budget) racing to own `this.conn`.
    this.dialInFlight = true;
    const dialStart = this.deps.clock();
    let lastFailure = "no attempt completed";
    try {
      for (let attempt = 0; attempt < REDIAL_MAX_ATTEMPTS; attempt += 1) {
        if (redial || attempt > 0) await this.wait(redialBackoffMs(attempt));
        if (this.isEnded()) return false;
        this.resetLegDiagnostics();
        let failure: string;
        try {
          const leg = await this.deps.provider.connect(
            this.deps.providerCfg,
            this.buildConnectOpts(),
          );
          if (this.isEnded()) {
            // The phone dropped (or a takeover landed) WHILE this dial was
            // in flight. Adopting the leg now would resurrect a torn-down
            // session and strand a live provider connection nothing ever
            // closes — hang up on it instead.
            void leg.close();
            return false;
          }
          const pump = createProviderPump(leg);
          this.conn = { leg, pump };
          pump.setSink((ev) => this.onProviderEvent(ev));
          // The socket is up, but the provider is NOT configured until
          // `session-ready`. Streaming audio before that is discarded by
          // the provider, so the dial is not complete until it lands.
          const outcome = await this.awaitSessionReady();
          if (outcome === "ready") {
            this.log(
              `voice: provider ready — ${this.providerTag()} attempt ${attempt + 1}/${REDIAL_MAX_ATTEMPTS} in ${this.deps.clock() - dialStart}ms`,
            );
            return true;
          }
          failure = this.describeReadyFailure(outcome);
          // Quiet (or unparseable) provider — discard this leg and spend
          // the next attempt on a fresh one.
          this.discardConn();
        } catch (e) {
          // expected: transport failure — retry with backoff
          failure = `connect failed — ${errorText(e)}`;
        }
        lastFailure = failure;
        // A teardown mid-attempt is not a dial failure; the next loop
        // head returns false. Control flow is unchanged either way — only
        // the log line is suppressed.
        if (!this.isEnded()) {
          const next =
            attempt + 1 < REDIAL_MAX_ATTEMPTS
              ? `retrying in ${redialBackoffMs(attempt + 1)}ms`
              : "no attempts left";
          this.log(
            `voice: dial attempt ${attempt + 1}/${REDIAL_MAX_ATTEMPTS} failed (${this.providerTag()}) — ${failure}${this.providerErrorSuffix()}; ${next}`,
          );
        }
      }
      this.log(
        `voice: dial exhausted — ${REDIAL_MAX_ATTEMPTS} attempts in ${this.deps.clock() - dialStart}ms (${this.providerTag()}); closing phone ${VOICE_CLOSE.PROVIDER} provider-unrecoverable; last failure: ${lastFailure}${this.providerErrorSuffix()}`,
      );
      this.sendJson({ type: "error", code: "provider-unrecoverable", fatal: true });
      this.phoneOpen = false;
      this.deps.phone.close(VOICE_CLOSE.PROVIDER, "provider unrecoverable");
      this.fullTeardown();
      return false;
    } finally {
      this.dialInFlight = false;
    }
  }

  /** `<provider-kind>/<model>` — every dial line carries both, because
   *  "which provider and which model was it dialling?" is the first
   *  question asked of a dial failure. */
  private providerTag(): string {
    return `${this.deps.provider.kind}/${this.deps.providerCfg.model}`;
  }

  /** Clear per-leg diagnostics at the head of each dial attempt, so an
   *  attempt's failure line can never quote the PREVIOUS attempt's
   *  provider error. */
  private resetLegDiagnostics(): void {
    this.lastProviderError = null;
    this.providerErrorsSeen = 0;
    this.lastCloseInfo = null;
  }

  /** `; last provider error [code] message`, or "" when the provider
   *  reported nothing on this leg. */
  private providerErrorSuffix(): string {
    const note = this.lastProviderError;
    return note === null ? "" : `; last provider error ${formatProviderError(note)}`;
  }

  /** Turn a non-ready `awaitSessionReady` outcome into the failure text.
   *  The `timeout` arm is deliberately explicit that the SOCKET opened —
   *  that is the whole difference from a refused dial. */
  private describeReadyFailure(outcome: Exclude<SessionReadyOutcome, "ready">): string {
    switch (outcome) {
      case "timeout":
        return `no session-ready within ${SESSION_READY_TIMEOUT_MS}ms (socket opened, provider handshake never completed)`;
      case "provider-closed": {
        const info = this.lastCloseInfo;
        const tag = info === null ? "no close info" : formatCloseInfo(info.code, info.reason);
        return `provider closed before session-ready (${tag})`;
      }
      case "aborted":
        return "session ended before session-ready";
    }
  }

  /** Wait for `session-ready` on the freshly-attached leg, bounded by
   *  {@link SESSION_READY_TIMEOUT_MS}. The resolved {@link
   *  SessionReadyOutcome} distinguishes the three non-ready endings so
   *  the failure line can name the actual fault. */
  private awaitSessionReady(): Promise<SessionReadyOutcome> {
    return new Promise<SessionReadyOutcome>((resolve) => {
      this.sessionReadyResolve = resolve;
      this.sessionReadyTimer = this.deps.timers.setTimeout(() => {
        this.sessionReadyTimer = null;
        this.settleSessionReady("timeout");
      }, SESSION_READY_TIMEOUT_MS);
    });
  }

  /** Settle a pending {@link awaitSessionReady}. Idempotent — every
   *  teardown path calls it (with `"aborted"`) so a dial promise can
   *  never be stranded. */
  private settleSessionReady(outcome: SessionReadyOutcome): void {
    if (this.sessionReadyTimer !== null) {
      this.deps.timers.clearTimeout(this.sessionReadyTimer);
      this.sessionReadyTimer = null;
    }
    const resolve = this.sessionReadyResolve;
    this.sessionReadyResolve = null;
    if (resolve !== null) resolve(outcome);
  }

  /** Detach + hang up the current leg without touching session phase.
   *  Used between dial attempts; the sink is cleared FIRST so the leg's
   *  own `closed` cannot re-enter the event handler. */
  private discardConn(): void {
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) {
      conn.pump.setSink(null);
      void conn.leg.close();
    }
  }

  private buildConnectOpts(): VoiceSessionOpts {
    // Type glue check (ADR-272 P2/P3 alignment): `toolJsonSchema`'s
    // FlatToolSchema must be assignable to the provider seam's
    // VoiceJsonSchema — the annotation below enforces it at compile time.
    const tools: VoiceToolDef[] = this.deps.catalog.map((e) => ({
      name: e.name,
      description: e.description,
      parameters: toolJsonSchema(e),
    }));
    const turnDetection: VoiceTurnDetection =
      this.mode === "vad" ? { mode: "server-vad", ...SERVER_VAD_TUNINGS } : { mode: "ptt" };
    return {
      instructions: buildInstructions({
        teams: this.deps.teamIndex.teams.map((t) => t.name),
        currentTeam: this.currentTeam,
        readonly: this.deps.config.readonly,
        ...(this.deps.nowMyt !== undefined ? { nowMytIso: this.deps.nowMyt() } : {}),
      }),
      tools,
      turnDetection,
    };
  }

  // ---------- Control frames (post-hello) ----------

  private async onControlFrame(frame: ClientFrame): Promise<void> {
    switch (frame.type) {
      case "hello":
        this.sendJson({
          type: "error",
          code: "protocol",
          fatal: false,
          message: "duplicate hello",
        });
        return;
      case "ptt":
        if (frame.down) this.sendStatus("listening");
        return;
      case "mode":
        // Takes effect on the next (re)dial; ready keeps vad:false (P7).
        this.mode = frame.mode;
        return;
      case "cancel": {
        // Barge-in: flush queued playback BEFORE any later audio (the
        // ordering invariant), suppress the cancelled response's
        // still-streaming audio until the turn boundary, interrupt.
        this.suppressAudio = true;
        this.speakingAnnounced = false;
        this.sendJson({ type: "audio.clear", reason: "barge-in" });
        const conn = this.conn;
        if (conn !== null) {
          try {
            conn.leg.interrupt();
          } catch (e) {
            if (!(e instanceof VoiceProviderError)) throw e;
          }
        }
        return;
      }
      case "text": {
        const conn = this.conn;
        if (conn === null) {
          this.sendJson({
            type: "error",
            code: "provider",
            fatal: false,
            message: "provider not connected (redial in progress)",
          });
          return;
        }
        try {
          conn.leg.sendText(frame.text);
        } catch (e) {
          if (!(e instanceof VoiceProviderError)) throw e;
          return;
        }
        this.suppressAudio = false;
        this.sendStatus("thinking");
        return;
      }
      case "team": {
        const resolved = resolveTeamName(this.deps.teamIndex, frame.team);
        if (!resolved.ok) {
          if (resolved.reason === "ambiguous") {
            this.sendJson({
              type: "error",
              code: "ambiguous_team",
              fatal: false,
              message: `ambiguous team '${frame.team}' — candidates: ${resolved.candidates.join(", ")}`,
            });
            return;
          }
          this.sendJson({
            type: "error",
            code: "unknown_team",
            fatal: false,
            message: `unknown team '${frame.team}'`,
          });
          return;
        }
        this.currentTeam = resolved.team.name;
        // Status frame reflecting current state — NO transcript.assistant
        // confirmation (the model handles conversational acks).
        this.sendStatus(this.statusState);
        return;
      }
      case "suspend":
        this.parkAndClose("suspended");
        return;
      case "ping": {
        const pong: PongFrame =
          frame.t !== undefined ? { type: "pong", t: frame.t } : { type: "pong" };
        this.sendJson(pong);
        return;
      }
    }
  }

  // ---------- Provider events ----------

  private async onProviderEvent(ev: VoiceEvent): Promise<void> {
    if (this.phase === "ended") return;
    switch (ev.type) {
      case "session-ready":
        // Dial completion — nothing user-visible, but it is what
        // releases `awaitSessionReady` and makes the dial succeed.
        this.settleSessionReady("ready");
        return;
      case "audio-out":
        this.onAudioOut(ev.pcm);
        return;
      case "transcript":
        // FINALS ONLY (ADR-272 OQ-4). `final: true` closes an utterance
        // id, so the finals ARE the conversation; recording the partial
        // deltas as well would write the same sentence a dozen times in
        // pieces. Off unless the operator opted in — `transcript` is null
        // by default, and the phone still gets every partial either way.
        if (ev.final) this.transcript?.record({ role: ev.role, text: ev.text });
        this.sendJson({
          type: ev.role === "user" ? "transcript.user" : "transcript.assistant",
          id: ev.id,
          text: ev.text,
          final: ev.final,
        });
        return;
      case "speech-started": {
        // PROVIDER-SIDE BARGE-IN, and it must behave like the phone-side
        // one (`cancel`): flush the client queue, and SUPPRESS the audio
        // still streaming from the response being interrupted — otherwise
        // a straggler `audio-out` lands after the clear and the operator
        // hears the assistant talk over him. Ordering is the invariant:
        // `audio.clear` goes out BEFORE any later audio can be sent.
        //
        // The condition is load-bearing, not caution. The two adapters do
        // not agree on when this event fires: `gemini-live.ts` emits it
        // only for `interrupted: true` (a response WAS in flight), while
        // `openai-realtime.ts` maps every `input_audio_buffer.speech_started`
        // — which fires whether or not the assistant is mid-response.
        // Suppressing unconditionally would therefore latch on OpenAI when
        // nothing was speaking, and since the gate only lifts on
        // `turn-complete`, the ENTIRE NEXT RESPONSE would be dropped:
        // silence, on the provider this feature ships as its default.
        // `speakingAnnounced` is true exactly when assistant audio is in
        // flight for the current turn, which is precisely when stragglers
        // exist — so this makes OpenAI behave like Gemini's already-correct
        // signal. Reachable only in `mode:"vad"` today (OQ-3 keeps `ready`
        // at `vad:false`), i.e. latent until P7 turns VAD on.
        //
        // RESIDUAL RISK (P7 hardening, ADR-272 §Supplement-P7 §R4): the
        // gate lifts on `turn-complete`, and gemini-live.ts notes that
        // native-audio models are widely reported to DROP `turnComplete`
        // after an interrupt. A provider that does would leave this armed
        // and silence the next response. Not new and not specific to this
        // arm — `cancel` has had the same dependency since P4, and in PTT
        // the phone's own TURN_END clears it. V-19 checks it on hardware.
        if (this.speakingAnnounced) this.suppressAudio = true;
        this.speakingAnnounced = false;
        this.sendJson({ type: "audio.clear", reason: "speech-started" });
        this.sendStatus("listening");
        return;
      }
      case "tool-call":
        await this.onToolCall(ev);
        return;
      case "turn-complete":
        this.suppressAudio = false;
        this.speakingAnnounced = false;
        this.sendStatus("idle");
        return;
      case "provider-error":
        this.noteProviderError(ev);
        this.sendJson({ type: "error", code: "provider", fatal: false, message: ev.message });
        return;
      case "closed":
        await this.onProviderClosed(ev.code, ev.reason);
        return;
    }
  }

  private onAudioOut(pcm: Uint8Array): void {
    if (this.phase !== "live") {
      this.droppedDownlinkFrames += 1; // parked — phone is gone
      return;
    }
    if (this.suppressAudio) {
      this.droppedDownlinkFrames += 1; // post-cancel flush (barge-in)
      return;
    }
    if (this.deps.phone.bufferedAmount() > DOWNLINK_BUFFER_CAP_BYTES) {
      this.droppedDownlinkFrames += 1; // backpressure — drop, never buffer
      return;
    }
    const frame = encodeFrame({ flags: VOICE_FLAG_SYNTHETIC, seq: this.seq, payload: pcm });
    this.seq = nextSeq(this.seq);
    if (!this.speakingAnnounced) {
      this.speakingAnnounced = true;
      this.sendStatus("speaking");
    }
    this.deps.phone.sendBinary(frame);
  }

  /**
   * A tool name, bounded and quoted, ready to drop into a log line. The
   * ONE place a tool name is rendered for the log — see
   * {@link TOOL_NAME_LOG_MAX_CHARS} for why the bound exists.
   */
  private toolLabel(name: string): string {
    return `'${name.slice(0, TOOL_NAME_LOG_MAX_CHARS)}'`;
  }

  /**
   * ONE LINE IN. Emitted where `tool.start` is, and says the two things
   * that cannot be recovered afterwards: WHICH tool the model chose, and
   * whether that tool is behind the D7 confirmation gate — which is what
   * makes the closing line's `previewed` / `redeemed` readable.
   *
   * A name the catalog does not hold is called out as such rather than
   * reported as ungated: an invented tool is not an ungated tool, and
   * under `ATMUX_VOICE_READONLY=1` the messaging tools are genuinely
   * absent from the catalog, so this arm is how "the model tried to
   * mutate while readonly" looks in the log.
   *
   * NAME ONLY — never `ev.argsJson`, which is the operator's speech
   * rendered as arguments (ADR-272 OQ-4; see `log.ts` property 3).
   */
  private logToolInvoked(entry: VoiceToolEntry | undefined, name: string): void {
    const gate =
      entry === undefined
        ? "not in catalog"
        : entry.confirm
          ? "confirm-gated"
          : "no confirmation gate";
    this.log(`voice: tool ${this.toolLabel(name)} invoked (${gate})`);
  }

  /**
   * ONE LINE OUT. Outcome, duration, and — when it failed — the failure
   * CLASS, which is `envelope.error`: a closed set of codes, never the
   * spoken summary and never the arguments.
   *
   * `previewed` gets its own sentence because it is not an outcome of the
   * tool at all: nothing ran. Distinguishing it from `redeemed` is the
   * point of logging the gate — "the model previewed and never came back"
   * and "the model never tried" are the same silence otherwise, and once
   * `ATMUX_VOICE_READONLY` is cleared that difference is how a refusal is
   * told apart from an outage.
   */
  private logToolDone(
    name: string,
    ok: boolean,
    ms: number,
    stage: ConfirmStage | null,
    errorClass: string,
  ): void {
    const label = this.toolLabel(name);
    if (stage === "previewed") {
      this.log(
        `voice: tool ${label} previewed in ${ms}ms — NOT executed, awaiting the operator's confirmation`,
      );
      return;
    }
    const notes: string[] = [];
    if (!ok) notes.push(errorClass.slice(0, TOOL_ERROR_CLASS_LOG_MAX_CHARS));
    if (stage === "redeemed") notes.push("confirmation redeemed");
    const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    this.log(`voice: tool ${label} ${ok ? "ok" : "failed"} in ${ms}ms${suffix}`);
  }

  /**
   * Which side of D7's round trip this call landed on, decided from what
   * the bridge actually did rather than from what the model intended.
   *
   * - `previewed` — the bridge answered `needs_confirmation`, so nothing
   *   ran. A mismatched or unknown token re-previews, and that IS a
   *   preview: the action still did not happen.
   * - `redeemed` — a `confirm_token` was offered AND the bridge did not
   *   bounce it, so the gate opened and the verb ran. `confirm_expired`
   *   is excluded because the token was offered and refused; that call
   *   reports the expiry as its failure class, which is the true story.
   * - `null` — ungated, or gated and rejected before the gate (bad args,
   *   unknown team, readonly). Neither stage is claimable there.
   *
   * The token is probed for PRESENCE only. Its value is a credential and
   * the rest of the arguments are speech; nothing here reads either, and
   * nothing here is logged.
   */
  private confirmStage(
    entry: VoiceToolEntry | undefined,
    argsJson: string,
    needs: boolean,
    error: string | undefined,
  ): ConfirmStage | null {
    if (entry === undefined || !entry.confirm) return null;
    if (needs) return "previewed";
    if (error === "confirm_expired") return null;
    const probed = tryParseJsonString(argsJson, ConfirmTokenProbeSchema);
    return probed?.confirm_token === undefined ? null : "redeemed";
  }

  private async onToolCall(ev: { id: string; name: string; argsJson: string }): Promise<void> {
    // The catalog the MODEL was given (readonly-filtered upstream), so
    // `undefined` means the model named something it was never offered.
    const entry = this.deps.catalog.find((t) => t.name === ev.name);
    this.sendJson({
      type: "tool.start",
      id: ev.id,
      name: ev.name,
      args: ev.argsJson.slice(0, TOOL_ARGS_PREVIEW_MAX_CHARS),
    });
    this.logToolInvoked(entry, ev.name);
    this.sendStatus("working");
    // The leg that ISSUED this call, captured before the await. A tool
    // call id is meaningful only within the provider session that minted
    // it, so a result must go back to that leg or nowhere — see the drop
    // below.
    const issuedBy = this.conn;
    const start = this.deps.clock();
    const out = await this.deps.bridge.executeTool({
      name: ev.name,
      argsJson: ev.argsJson,
      sessionId: this.sessionId,
      currentTeam: this.currentTeam,
    });
    const ms = this.deps.clock() - start;
    const envelope = tryParseJsonString(out.envelopeJson, EnvelopeSchema);
    const ok = envelope !== null && envelope.ok === true;
    let summary: string;
    if (ok) {
      summary = firstLine(envelope.data ?? "");
    } else {
      summary = envelope?.error ?? "error";
    }
    const needs = out.needsConfirmation !== undefined || envelope?.error === "needs_confirmation";
    const done: ToolDoneFrame = { type: "tool.done", id: ev.id, ok, summary, ms };
    if (needs) done.needs_confirmation = true;
    // The phone gets the outcome either way — it is the operator's own
    // view of a tool HE asked for, and it does not depend on any provider
    // leg still being up.
    this.sendJson(done);
    this.logToolDone(
      ev.name,
      ok,
      ms,
      this.confirmStage(entry, ev.argsJson, needs, envelope?.error),
      envelope === null
        ? TOOL_ERROR_CLASS_UNPARSEABLE
        : (envelope.error ?? TOOL_ERROR_CLASS_UNSPECIFIED),
    );
    // The provider half does. `this.conn` is re-read here, and if a
    // redial happened while the tool ran it now points at a DIFFERENT
    // leg — one that never issued `ev.id`. Handing it this result is a
    // foreign call id on a live conversation: ignored at best, a protocol
    // error at worst, and either way the fresh leg is left waiting for a
    // tool turn that has already been answered elsewhere. The window was
    // narrow only because read tools return in milliseconds; P7's
    // mutating tools make slow tools ordinary.
    if (this.conn === null || this.conn !== issuedBy) {
      // Tool NAME only — this sink carries no speech (see module header).
      this.log(
        `voice: dropping tool result for ${this.toolLabel(ev.name)} — the provider leg that issued it is gone (redial during execution)`,
      );
      return;
    }
    try {
      issuedBy.leg.sendToolResult(ev.id, out.envelopeJson);
      this.suppressAudio = false;
    } catch (e) {
      if (!(e instanceof VoiceProviderError)) throw e;
    }
  }

  /**
   * Record a provider-reported fault, and log it — capped per leg (see
   * {@link PROVIDER_ERROR_LOG_CAP}). The RECORD is always kept even once
   * the log goes quiet, because the dial-failure line quotes it and that
   * line is the one the 2026-08-15 incident needed.
   */
  private noteProviderError(ev: { message: string; fatal: boolean; code?: string }): void {
    const note: ProviderErrorNote = {
      code: ev.code ?? null,
      message: ev.message.slice(0, PROVIDER_ERROR_LOG_MAX_CHARS),
    };
    this.lastProviderError = note;
    this.providerErrorsSeen += 1;
    if (this.providerErrorsSeen === PROVIDER_ERROR_LOG_CAP + 1) {
      this.log(
        `voice: further provider errors on this leg suppressed (logged ${PROVIDER_ERROR_LOG_CAP})`,
      );
      return;
    }
    if (this.providerErrorsSeen > PROVIDER_ERROR_LOG_CAP) return;
    this.log(
      `voice: provider error${ev.fatal ? " (fatal)" : ""} (${this.providerTag()}) ${formatProviderError(note)}`,
    );
  }

  private async onProviderClosed(code: number | null, reason: string): Promise<void> {
    this.conn = null;
    this.lastCloseInfo = { code, reason };
    // A leg that dies while we are still waiting for its `session-ready`
    // fails THAT dial attempt; `dialLoop` owns the retry from here, so
    // this handler must not start a second one.
    this.settleSessionReady("provider-closed");
    if (this.dialInFlight) return;
    if (this.phase === "parked") {
      // Provider died while parked — dissolve the park now; a later
      // hello.resume falls through to a fresh session.
      this.clearParkTimer();
      this.dissolvePark();
      return;
    }
    if (this.phase !== "live" || !this.phoneOpen) return;
    // Unexpected close with the phone still live → REDIAL (fresh
    // provider context — history resume across redial is deferred).
    this.log(
      `voice: provider closed mid-session (${this.providerTag()}) ${formatCloseInfo(code, reason)}${this.providerErrorSuffix()} — redialing`,
    );
    this.sendStatus("thinking");
    await this.dialLoop(true);
  }

  // ---------- Park / resume / teardown ----------

  private parkAndClose(reason: string): void {
    if (this.conn !== null) {
      this.park();
    } else {
      this.fullTeardown();
    }
    if (this.phoneOpen) {
      this.phoneOpen = false;
      this.deps.phone.close(VOICE_CLOSE.NORMAL, reason);
    }
  }

  /** Park the live leg for `resumeGraceMs` (callers guarantee `conn`). */
  private park(): void {
    const sessionId = this.sessionId;
    const conn = this.conn;
    if (conn === null) {
      this.fullTeardown();
      return;
    }
    this.clearIdleTimer();
    this.deps.shared.registry.park(sessionId);
    this.parkTimer = this.deps.timers.setTimeout(() => {
      this.parkTimer = null;
      this.dissolvePark();
    }, this.deps.config.resumeGraceMs);
    this.deps.shared.parked.set(sessionId, {
      conn,
      currentTeam: this.currentTeam,
      seq: this.seq,
      timer: this.parkTimer,
    });
    this.phase = "parked";
  }

  /** Tear a parked session fully down (grace expiry, or the provider
   *  leg dying mid-park). */
  private dissolvePark(): void {
    this.settleSessionReady("aborted");
    const sessionId = this.sessionId;
    this.deps.shared.parked.delete(sessionId);
    this.deps.shared.owners.delete(sessionId);
    this.deps.shared.registry.release(sessionId);
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) {
      conn.pump.setSink(null);
      void conn.leg.close();
    }
    this.phase = "ended";
  }

  /** Latest-wins displacement (ADR-272 D8): a newer claim owns the slot;
   *  this session announces, closes 4001, and tears its leg down. */
  private teardownForTakeover(): void {
    this.settleSessionReady("aborted");
    if (this.phase === "ended") return;
    this.sendJson({ type: "takeover" });
    if (this.phoneOpen) {
      this.phoneOpen = false;
      this.deps.phone.close(VOICE_CLOSE.TAKEOVER, "takeover");
    }
    this.clearHelloTimer();
    this.clearIdleTimer();
    this.clearParkTimer();
    this.deps.shared.parked.delete(this.sessionId);
    this.deps.shared.owners.delete(this.sessionId);
    // NOT registry.release — the slot now belongs to the new claimant.
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) {
      conn.pump.setSink(null);
      void conn.leg.close();
    }
    this.phase = "ended";
  }

  private fullTeardown(): void {
    this.settleSessionReady("aborted");
    this.clearHelloTimer();
    this.clearIdleTimer();
    this.clearParkTimer();
    this.deps.shared.parked.delete(this.sessionId);
    this.deps.shared.owners.delete(this.sessionId);
    this.deps.shared.registry.release(this.sessionId);
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) {
      conn.pump.setSink(null);
      void conn.leg.close();
    }
    this.phase = "ended";
  }

  private endPreHello(code: number, reason: string): void {
    this.settleSessionReady("aborted");
    this.clearHelloTimer();
    this.phoneOpen = false;
    this.deps.phone.close(code, reason);
    this.phase = "ended";
  }

  // ---------- Frame plumbing ----------

  private sendReady(resumed: boolean): void {
    // EXACT key set (ADR-272 §Security: a unit test asserts it and that
    // no value carries the api key or token).
    const ready: ReadyFrame = {
      type: "ready",
      sessionId: this.sessionId,
      resumed,
      provider: this.deps.provider.kind,
      model: this.deps.providerCfg.model,
      team: this.currentTeam,
      teams: this.deps.teamIndex.teams.map((t) => t.name),
      rates: { in: VOICE_SAMPLE_RATE, out: VOICE_SAMPLE_RATE },
      frameMs: VOICE_FRAME_MS,
      vad: false,
      readonly: this.deps.config.readonly,
    };
    this.sendJson(ready);
  }

  private sendStatus(state: StatusFrame["state"]): void {
    this.statusState = state;
    this.sendJson({ type: "status", state });
  }

  private sendJson(frame: ServerFrame): void {
    if (!this.phoneOpen) return;
    this.deps.phone.send(JSON.stringify(frame));
  }

  // ---------- Timers ----------

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.deps.timers.setTimeout(resolve, ms);
    });
  }

  private armIdleTimer(): void {
    this.idleTimer = this.deps.timers.setTimeout(() => {
      this.idleTimer = null;
      this.parkAndClose("idle");
    }, IDLE_CLOSE_MS);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.armIdleTimer();
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      this.deps.timers.clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.deps.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearParkTimer(): void {
    if (this.parkTimer !== null) {
      this.deps.timers.clearTimeout(this.parkTimer);
      this.parkTimer = null;
    }
  }
}

/** Create the per-connection session state machine. The hello timer is
 *  armed immediately (the WS just opened). */
export function createVoiceSession(deps: VoiceSessionDeps): VoiceServerSession {
  return new VoiceServerSessionImpl(deps);
}

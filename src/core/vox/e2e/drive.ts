// ADR-272 §Supplement — drives one real voice session for the e2e harness.
//
// Same shape as `src/core/vox/probe.ts`, and deliberately reuses its
// framing (`toneFrames`) and its connect options (`probeConnectOpts`) rather
// than re-deriving them: a harness whose uplink framing drifts from the
// probe's is a harness that can pass while the real client fails.
//
// What differs from the probe is the payload and the collection. The probe
// streams a sine wave and counts bytes; this streams SYNTHESIZED SPEECH and
// collects what the assistant did with it — transcript, tool calls, downlink
// audio, close code. That collection is the judge's input.
//
// Frames are paced at one per `VOX_FRAME_MS`, real time. Feeding audio
// faster than real time is a different test: the provider's VAD and
// turn-detection behave differently, so a harness that only works when fed
// at speed is not exercising the path the phone uses.

import {
  type ConnectWebSocketOpts,
  connectWebSocket,
  type WsHandle,
} from "../../../abstractions/websocket.ts";
import { decodeFrame, VOX_FRAME_MS } from "../frame.ts";
import { probeConnectOpts, toneFrames, tryReadServerType } from "../probe.ts";

/** How long to keep collecting after `TURN_END` before giving up. */
export const DEFAULT_COLLECT_MS = 45_000;

/** How long to wait for `ready` after `hello`. */
export const READY_TIMEOUT_MS = 20_000;

/**
 * Stop collecting once the assistant has produced a final transcript AND
 * gone quiet for this long. Ends a passing run in seconds rather than
 * burning the whole collect window (and the provider minutes that go with
 * it) waiting for a timeout that proves nothing.
 */
export const QUIET_AFTER_FINAL_MS = 2_500;

/**
 * How long to wait for the assistant to finish ONE turn of a multi-turn
 * conversation before speaking the next.
 *
 * Shorter than {@link DEFAULT_COLLECT_MS} because a turn that has not
 * produced a final transcript inside this window has not merely been
 * slow: the confirm round trip the multi-turn scenarios exist to exercise
 * is a tool call plus one short spoken preview, and the loop exits the
 * moment that lands. Speaking the next turn over a still-talking
 * assistant would trigger barge-in and test a different thing entirely.
 */
export const TURN_TIMEOUT_MS = 60_000;

export interface DriveArgs {
  url: string;
  token: string;
  /** PCM16 mono 24 kHz — the operator's utterance. */
  pcm: Uint8Array;
  collectMs?: number;
}

/**
 * A CONVERSATION on ONE socket (ADR-272 §Supplement E6).
 *
 * The confirm round trip cannot be driven as two independent sessions,
 * and that is a property of D7 rather than a convenience: the token is
 * `sha256(tool ‖ canonicalJson(args) ‖ sessionId)`, and a fresh socket is
 * a fresh `sessionId`. Reconnecting to say "yes" would present a token
 * bound to a session that no longer exists — which the store would
 * correctly refuse, so the scenario would pass for the wrong reason and
 * would keep passing if the gate broke.
 */
export interface DriveTurnsArgs {
  url: string;
  token: string;
  /** One PCM16 24 kHz buffer per operator turn, spoken in order. */
  pcms: ReadonlyArray<Uint8Array>;
  /** Overall budget across every turn. */
  collectMs?: number;
  /** Per-turn budget. Defaults to {@link TURN_TIMEOUT_MS}. */
  turnTimeoutMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: string;
  ok: boolean | null;
  summary: string | null;
  ms: number | null;
}

export interface DriveResult {
  ok: boolean;
  ready: Record<string, unknown> | null;
  /** Assistant transcript, assembled from the per-id frames. */
  transcript: string;
  /** Tool calls in invocation order. */
  tools: ToolCall[];
  /** Just the names, for the mechanical tool gate. */
  toolNames: string[];
  frameTypes: string[];
  uplinkFrames: number;
  downlinkFrames: number;
  downlinkBytes: number;
  errors: Array<{ code: string; fatal: boolean; message: string | null }>;
  closeCode: number | null;
  failure: string | null;
}

export interface DriveDeps {
  args: DriveArgs;
  connect?: (url: string, opts: ConnectWebSocketOpts) => Promise<WsHandle>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  log?: (line: string) => void;
}

export interface DriveTurnsDeps {
  args: DriveTurnsArgs;
  connect?: (url: string, opts: ConnectWebSocketOpts) => Promise<WsHandle>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  log?: (line: string) => void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Assembles assistant transcript frames into one string.
 *
 * The server sends incremental frames sharing an `id`, with `final` set on
 * the last. A `final` frame's text is the complete utterance, so it wins
 * outright; absent a final, the LONGEST partial is kept. That handles both
 * possible partial semantics (cumulative growth or deltas) without
 * concatenating a cumulative stream into a stutter.
 */
export class TranscriptAssembler {
  private readonly order: string[];
  private readonly byId: Map<string, { text: string; final: boolean }>;

  // Assigned in an explicit constructor rather than as field initializers
  // ON PURPOSE: Bun's coverage counts each field initializer as its own
  // function and reports one of them unhit even when the class is
  // constructed, which drops the file below the 100%-function gate
  // (ADR-009 §2) for no real gap. Do not "tidy" these back into
  // initializers without re-checking `bun tests/lcov-gate.ts`.
  constructor() {
    this.order = [];
    this.byId = new Map();
  }

  add(id: string, text: string, final: boolean): void {
    const prev = this.byId.get(id);
    if (prev === undefined) {
      this.order.push(id);
      this.byId.set(id, { text, final });
      return;
    }
    // A final always wins; otherwise keep whichever partial says more.
    if (prev.final && !final) return;
    if (final || text.length >= prev.text.length) this.byId.set(id, { text, final });
  }

  text(): string {
    return this.order
      .map((id) => {
        return this.byId.get(id)?.text ?? "";
      })
      .filter((t) => {
        return t.trim().length > 0;
      })
      .join(" ")
      .trim();
  }

  /** True once at least one assistant utterance has been finalized. */
  hasFinal(): boolean {
    return this.finalCount() > 0;
  }

  /**
   * How many assistant utterances have been finalized so far.
   *
   * `hasFinal()` is sticky, which is right for a single-turn drive and
   * wrong for a conversation: after turn 1 it is permanently true, so a
   * turn-2 wait keyed on it would fall through instantly and speak over
   * the assistant. The COUNT lets each turn wait for a final that is
   * new since that turn started.
   */
  finalCount(): number {
    let n = 0;
    for (const v of this.byId.values()) if (v.final) n += 1;
    return n;
  }
}

/**
 * Run one utterance end to end: connect → `hello` → await `ready` → stream
 * the speech at real-time pace → `TURN_END` → collect until the assistant
 * finishes or the window elapses.
 *
 * Never throws on a protocol outcome; a connect failure comes back as
 * `ok: false` with `failure` set.
 */
export async function driveUtterance(deps: DriveDeps): Promise<DriveResult> {
  const turnsDeps: DriveTurnsDeps = {
    args: {
      url: deps.args.url,
      token: deps.args.token,
      pcms: [deps.args.pcm],
      ...(deps.args.collectMs !== undefined ? { collectMs: deps.args.collectMs } : {}),
    },
    ...(deps.connect !== undefined ? { connect: deps.connect } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };
  return await driveTurns(turnsDeps);
}

/**
 * Run a whole conversation on ONE socket: connect → `hello` → await
 * `ready` → for each turn, stream the speech at real-time pace, send
 * `TURN_END`, and wait for the assistant to finish → collect → close.
 *
 * Never throws on a protocol outcome; a connect failure comes back as
 * `ok: false` with `failure` set.
 */
export async function driveTurns(deps: DriveTurnsDeps): Promise<DriveResult> {
  const { args } = deps;
  const connect =
    deps.connect ??
    ((url: string, opts: ConnectWebSocketOpts) => {
      return connectWebSocket(url, opts);
    });
  const sleep = deps.sleep ?? realSleep;
  const clock =
    deps.clock ??
    ((): number => {
      return Date.now();
    });
  const log =
    deps.log ??
    ((): void => {
      /* silent by default */
    });
  const collectMs = args.collectMs ?? DEFAULT_COLLECT_MS;

  const assembler = new TranscriptAssembler();
  const tools: ToolCall[] = [];
  const frameTypes: string[] = [];
  const errors: DriveResult["errors"] = [];
  const result: DriveResult = {
    ok: false,
    ready: null,
    transcript: "",
    tools,
    toolNames: [],
    frameTypes,
    uplinkFrames: 0,
    downlinkFrames: 0,
    downlinkBytes: 0,
    errors,
    closeCode: null,
    failure: null,
  };

  let ws: WsHandle;
  try {
    ws = await connect(args.url, probeConnectOpts(args.token));
  } catch (e) {
    result.failure = `connect failed: ${e instanceof Error ? e.message : String(e)}`;
    log(result.failure);
    return result;
  }

  let lastFrameAtMs = clock();

  const collector = (async (): Promise<void> => {
    for await (const frame of ws.frames()) {
      lastFrameAtMs = clock();
      if (typeof frame !== "string") {
        result.downlinkFrames += 1;
        const decoded = decodeFrame(frame);
        result.downlinkBytes += decoded.ok ? decoded.payload.length : 0;
        continue;
      }
      const parsed = tryReadServerType(frame);
      if (parsed === null) continue;
      if (!frameTypes.includes(parsed.type)) frameTypes.push(parsed.type);
      handleServerFrame(parsed.type, parsed.raw, assembler, tools, errors, result, log);
    }
  })();

  void ws.closed.then((info) => {
    result.closeCode = info.code;
  });

  ws.send(JSON.stringify({ type: "hello", v: 1, token: args.token, mode: "ptt", ua: "vox-e2e" }));

  const readyDeadline = clock() + READY_TIMEOUT_MS;
  while (result.ready === null && result.closeCode === null && clock() < readyDeadline) {
    await sleep(VOX_FRAME_MS);
  }
  if (result.ready === null) {
    result.failure =
      result.closeCode === null
        ? "no ready frame within the timeout"
        : `socket closed (code ${result.closeCode}) before ready`;
    log(result.failure);
    ws.close(1000, "e2e done");
    await collector;
    return finish(result, assembler);
  }

  const turnTimeoutMs = args.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const overallDeadline = clock() + collectMs;
  // Uplink sequence numbers continue ACROSS turns. The server does not
  // validate them today, so this buys nothing at runtime — it is here
  // because a harness that restarts the counter every turn is a harness
  // that would stop matching the client the moment the server started
  // checking, and the whole point of reusing `toneFrames` is that the
  // harness's uplink cannot drift from the phone's.
  let seq = 0;

  for (let turn = 0; turn < args.pcms.length; turn += 1) {
    if (result.closeCode !== null) break;
    const pcm = args.pcms[turn] ?? new Uint8Array(0);
    const frames = toneFrames(pcm, seq);
    seq = (seq + frames.length) & 0xffff;
    log(
      `turn ${turn + 1}/${args.pcms.length}: streaming ${frames.length} frames (${pcm.byteLength} B PCM16) at real-time pace`,
    );
    // The count of finals BEFORE this turn. Waiting for `hasFinal()` would
    // return instantly on every turn after the first (it is sticky), and
    // the harness would speak straight over the assistant's preview —
    // which is barge-in, a different test, and one that would make the
    // confirm round trip unobservable.
    const finalsBefore = assembler.finalCount();
    for (const f of frames) {
      if (result.closeCode !== null) break;
      ws.send(f);
      result.uplinkFrames += 1;
      await sleep(VOX_FRAME_MS);
    }

    // Collect until the assistant has finalized a NEW utterance AND gone
    // quiet, or this turn's budget elapses. Waiting the full window on
    // every turn would multiply provider minutes for no extra evidence.
    const turnDeadline = Math.min(clock() + turnTimeoutMs, overallDeadline);
    while (result.closeCode === null && clock() < turnDeadline) {
      if (assembler.finalCount() > finalsBefore && clock() - lastFrameAtMs > QUIET_AFTER_FINAL_MS) {
        break;
      }
      await sleep(VOX_FRAME_MS);
    }
    if (assembler.finalCount() === finalsBefore) {
      log(`turn ${turn + 1}: no new final transcript within ${turnTimeoutMs}ms`);
    }
  }

  if (result.closeCode === null) ws.close(1000, "e2e done");
  await collector;
  return finish(result, assembler);
}

/** Fold the streaming state into the final result. */
function finish(result: DriveResult, assembler: TranscriptAssembler): DriveResult {
  result.transcript = assembler.text();
  result.toolNames = result.tools.map((t) => {
    return t.name;
  });
  const closedCleanly = result.closeCode === null || result.closeCode === 1000;
  const fatal = result.errors.find((e) => {
    return e.fatal;
  });
  if (result.failure === null && fatal !== undefined) {
    result.failure = `server error ${fatal.code}: ${fatal.message ?? "(no message)"}`;
  }
  if (result.failure === null && !closedCleanly) {
    result.failure = `socket closed with code ${result.closeCode}`;
  }
  if (result.failure === null && result.ready !== null && result.transcript.length === 0) {
    result.failure = "assistant produced no transcript";
  }
  result.ok = result.failure === null;
  return result;
}

/** Route one server frame into the collectors. Exported for the unit suite. */
export function handleServerFrame(
  type: string,
  raw: Record<string, unknown>,
  assembler: TranscriptAssembler,
  tools: ToolCall[],
  errors: DriveResult["errors"],
  result: Pick<DriveResult, "ready">,
  log: (line: string) => void,
): void {
  switch (type) {
    case "ready":
      if (result.ready === null) {
        result.ready = raw;
        log(`ready: provider=${String(raw.provider)} model=${String(raw.model)}`);
      }
      return;
    case "transcript.assistant":
      if (typeof raw.id === "string" && typeof raw.text === "string") {
        assembler.add(raw.id, raw.text, raw.final === true);
      }
      return;
    case "tool.start":
      if (typeof raw.id === "string" && typeof raw.name === "string") {
        tools.push({
          id: raw.id,
          name: raw.name,
          args: typeof raw.args === "string" ? raw.args : "",
          ok: null,
          summary: null,
          ms: null,
        });
        log(`tool.start ${raw.name}`);
      }
      return;
    case "tool.done": {
      const call = tools.find((t) => {
        return t.id === raw.id;
      });
      if (call !== undefined) {
        call.ok = raw.ok === true;
        call.summary = typeof raw.summary === "string" ? raw.summary : null;
        call.ms = typeof raw.ms === "number" ? raw.ms : null;
        log(`tool.done ${call.name} ok=${call.ok} ${call.ms ?? "?"}ms`);
      }
      return;
    }
    case "error":
      errors.push({
        code: typeof raw.code === "string" ? raw.code : "unknown",
        fatal: raw.fatal === true,
        message: typeof raw.message === "string" ? raw.message : null,
      });
      log(`error frame: ${String(raw.code)} fatal=${String(raw.fatal)}`);
      return;
    default:
      return;
  }
}

/** One-line summary for stderr. */
export function formatDriveResult(r: DriveResult): string {
  const parts = [
    `ok=${r.ok}`,
    `uplink=${r.uplinkFrames}`,
    `downlinkBytes=${r.downlinkBytes}`,
    `tools=[${r.toolNames.join(",")}]`,
    `transcriptChars=${r.transcript.length}`,
    `close=${r.closeCode === null ? "open" : r.closeCode}`,
  ];
  if (r.failure !== null) parts.push(`failure=${r.failure}`);
  return parts.join(" ");
}

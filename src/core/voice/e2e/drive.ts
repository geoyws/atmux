// ADR-272 §Supplement — drives one real voice session for the e2e harness.
//
// Same shape as `src/core/voice/probe.ts`, and deliberately reuses its
// framing (`toneFrames`) and its connect options (`probeConnectOpts`) rather
// than re-deriving them: a harness whose uplink framing drifts from the
// probe's is a harness that can pass while the real client fails.
//
// What differs from the probe is the payload and the collection. The probe
// streams a sine wave and counts bytes; this streams SYNTHESIZED SPEECH and
// collects what the assistant did with it — transcript, tool calls, downlink
// audio, close code. That collection is the judge's input.
//
// Frames are paced at one per `VOICE_FRAME_MS`, real time. Feeding audio
// faster than real time is a different test: the provider's VAD and
// turn-detection behave differently, so a harness that only works when fed
// at speed is not exercising the path the phone uses.

import {
  type ConnectWebSocketOpts,
  connectWebSocket,
  type WsHandle,
} from "../../../abstractions/websocket.ts";
import { decodeFrame, VOICE_FRAME_MS } from "../frame.ts";
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

export interface DriveArgs {
  url: string;
  token: string;
  /** PCM16 mono 24 kHz — the operator's utterance. */
  pcm: Uint8Array;
  collectMs?: number;
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
    for (const v of this.byId.values()) if (v.final) return true;
    return false;
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

  ws.send(JSON.stringify({ type: "hello", v: 1, token: args.token, mode: "ptt", ua: "voice-e2e" }));

  const readyDeadline = clock() + READY_TIMEOUT_MS;
  while (result.ready === null && result.closeCode === null && clock() < readyDeadline) {
    await sleep(VOICE_FRAME_MS);
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

  const frames = toneFrames(args.pcm);
  log(`streaming ${frames.length} frames (${args.pcm.byteLength} B PCM16) at real-time pace`);
  for (const f of frames) {
    if (result.closeCode !== null) break;
    ws.send(f);
    result.uplinkFrames += 1;
    await sleep(VOICE_FRAME_MS);
  }

  // Collect until the assistant has finalized AND gone quiet, or the window
  // elapses. Waiting the full window on every run would multiply provider
  // minutes across scenarios for no extra evidence.
  const deadline = clock() + collectMs;
  while (result.closeCode === null && clock() < deadline) {
    if (assembler.hasFinal() && clock() - lastFrameAtMs > QUIET_AFTER_FINAL_MS) break;
    await sleep(VOICE_FRAME_MS);
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

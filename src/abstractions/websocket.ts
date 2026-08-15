// ADR-272: voice operator interface — WebSocket client abstraction.
//
// THE ONLY `new WebSocket()` site in the codebase. Domain code never
// constructs a WebSocket directly — the same discipline http.ts applies to
// `fetch` (R-fetch per ADR-006 + ADR-009 §3.5), extended to the WS transport.
// This module owns:
//   - Open-timeout enforcement (default 10s), surfaced as `VoiceProviderError`
//     (tag "voice-provider" maps to BSD `EX_TEMPFAIL` 75 — retries cleanly)
//   - Backpressure guard: `send()` throws before `bufferedAmount` would
//     exceed `maxBufferedBytes` (default 4 MiB) instead of buffering
//     unboundedly against a stalled peer
//   - A queue-backed `frames()` async iterator (text frames as `string`,
//     binary as `Uint8Array`) that ends cleanly on socket close
//   - The `factory` seam so tests inject fakes and adapters swap transports
//
// Bun extension note: Bun's client WebSocket accepts an options object as the
// second constructor argument (`{ headers, protocols }`) and delivers those
// headers on the upgrade request — verified empirically against Bun 1.3.14 by
// tests/unit/abstractions/websocket.test.ts ("custom headers arrive at the
// server"). Browsers cannot do this; atmux only runs under Bun.

import { VoiceProviderError } from "../errors.ts";

// ---------- Public types ----------

/** Default open-timeout budget (ms). */
export const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
/** Default `send()` backpressure cap (bytes): 4 MiB. */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** WHATWG readyState — OPEN. Structural fakes report plain numbers, so the
 *  constant lives here rather than on a class static. */
const WS_READY_STATE_OPEN = 1;

/** Close code for an abnormal closure (WHATWG 7.1.5) — used when the socket
 *  errors after open without delivering a close frame. */
const WS_ABNORMAL_CLOSURE = 1006;

/**
 * Minimal structural surface of a client WebSocket — exactly what
 * `connectWebSocket` touches. Bun's `WebSocket` satisfies it; tests inject
 * hand-rolled fakes.
 */
export interface MinimalWebSocket {
  /** Set to "arraybuffer" by `connectWebSocket` so binary frames arrive as ArrayBuffer. */
  binaryType: string;
  /** WHATWG readyState: 0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED. */
  readonly readyState: number;
  /** Bytes queued by send() but not yet flushed to the network. */
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

/** Options handed to a `WebSocketFactory` — the connection-level knobs. */
export interface WebSocketFactoryOpts {
  headers?: Record<string, string>;
  protocols?: string[];
}

/** Constructs the underlying socket. The default uses Bun's client WebSocket;
 *  tests inject fakes, and adapters may swap transports via
 *  `VoiceProviderConfig.wsFactory`. */
export type WebSocketFactory = (url: string, opts: WebSocketFactoryOpts) => MinimalWebSocket;

/** Close info `WsHandle.closed` resolves with. `closed` never rejects. */
export interface WsCloseInfo {
  code: number;
  reason: string;
}

/** A connected WebSocket, post-open. Single-consumer: call `frames()` once. */
export interface WsHandle {
  /**
   * Send one frame.
   * @throws VoiceProviderError when the socket is not open, or when
   *         `bufferedAmount + frame size` would exceed `maxBufferedBytes`.
   */
  send(data: string | Uint8Array): void;
  /**
   * Queue-backed async iterator over inbound frames — text frames as
   * `string`, binary as `Uint8Array`. Frames arriving before the first poll
   * are queued, not dropped. Ends cleanly when the socket closes (or errors
   * post-open). Single consumer; concurrent iterators race for frames.
   */
  frames(): AsyncIterable<string | Uint8Array>;
  /** Resolves with the close code + reason. Never rejects; a post-open error
   *  without a close frame resolves as code 1006 (abnormal closure). */
  readonly closed: Promise<WsCloseInfo>;
  /** Initiate close. Idempotent — safe on an already-closed socket. */
  close(code?: number, reason?: string): void;
  /** Live bytes-queued-not-yet-flushed readout from the underlying socket. */
  get bufferedAmount(): number;
}

export interface ConnectWebSocketOpts {
  headers?: Record<string, string>;
  protocols?: string[];
  /** Reject (and destroy the socket) if not open within this budget. Default 10_000. */
  openTimeoutMs?: number;
  /** `send()` backpressure cap in bytes. Default 4 MiB. */
  maxBufferedBytes?: number;
  /** Socket constructor seam — default is Bun's client WebSocket. */
  factory?: WebSocketFactory;
}

// ---------- Default factory ----------

/** The one real `new WebSocket()` call. Bun's options-object second argument
 *  carries headers + protocols onto the upgrade request (see file header). */
function defaultWebSocketFactory(url: string, opts: WebSocketFactoryOpts): MinimalWebSocket {
  return new WebSocket(url, opts) as unknown as MinimalWebSocket;
}

// ---------- Connect ----------

/**
 * Open a WebSocket and resolve with a `WsHandle` once the socket is OPEN.
 *
 * @throws VoiceProviderError (as a rejection) on open-timeout (socket is
 *         destroyed), on an error event before open, or on a close before
 *         open (e.g. the server refused the upgrade).
 */
export function connectWebSocket(url: string, opts: ConnectWebSocketOpts = {}): Promise<WsHandle> {
  const factoryOpts: WebSocketFactoryOpts = {};
  if (opts.headers !== undefined) factoryOpts.headers = opts.headers;
  if (opts.protocols !== undefined) factoryOpts.protocols = opts.protocols;
  const factory = opts.factory ?? defaultWebSocketFactory;
  const openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

  const ws = factory(url, factoryOpts);
  ws.binaryType = "arraybuffer";

  // Frame queue + single-slot waiter backing frames().
  const queue: Array<string | Uint8Array> = [];
  let ended = false;
  let wakeWaiter: (() => void) | null = null;
  const notify = (): void => {
    if (wakeWaiter !== null) {
      const wake = wakeWaiter;
      wakeWaiter = null;
      wake();
    }
  };

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<WsCloseInfo>();

  async function* frames(): AsyncGenerator<string | Uint8Array, void, unknown> {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as string | Uint8Array;
      }
      if (ended) return;
      await new Promise<void>((wake) => {
        wakeWaiter = wake;
      });
    }
  }

  const handle: WsHandle = {
    send(data: string | Uint8Array): void {
      if (ws.readyState !== WS_READY_STATE_OPEN) {
        throw new VoiceProviderError({
          what: "websocket send on non-open socket",
          detail: `readyState ${ws.readyState}`,
        });
      }
      const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
      if (ws.bufferedAmount + bytes > maxBufferedBytes) {
        throw new VoiceProviderError({
          what: "websocket send would exceed the buffered-bytes cap",
          detail: `bufferedAmount ${ws.bufferedAmount} + frame ${bytes} > cap ${maxBufferedBytes}`,
        });
      }
      ws.send(data);
    },
    frames,
    closed,
    close(code?: number, reason?: string): void {
      if (code === undefined) ws.close();
      else ws.close(code, reason);
    },
    get bufferedAmount(): number {
      return ws.bufferedAmount;
    },
  };

  return new Promise<WsHandle>((resolveConnect, rejectConnect) => {
    let opened = false;
    const timer = setTimeout(() => {
      // Destroy the half-open socket so it can't leak; close() during
      // CONNECTING fails the connection per WHATWG.
      ws.close();
      rejectConnect(
        new VoiceProviderError({
          what: `websocket open timed out after ${openTimeoutMs}ms`,
          detail: url,
        }),
      );
    }, openTimeoutMs);

    ws.onopen = (): void => {
      opened = true;
      clearTimeout(timer);
      resolveConnect(handle);
    };

    ws.onmessage = (ev): void => {
      queue.push(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
      notify();
    };

    ws.onerror = (ev): void => {
      if (!opened) {
        clearTimeout(timer);
        ws.close();
        rejectConnect(
          new VoiceProviderError({
            what: "websocket connection failed",
            detail: describeErrorEvent(ev),
            cause: ev,
          }),
        );
        return;
      }
      // Post-open error: terminate frames() and resolve `closed` as an
      // abnormal closure. A trailing close event (if any) is a no-op —
      // the promise is already settled.
      ended = true;
      notify();
      resolveClosed({ code: WS_ABNORMAL_CLOSURE, reason: describeErrorEvent(ev) });
    };

    ws.onclose = (ev): void => {
      ended = true;
      notify();
      resolveClosed({ code: ev.code, reason: ev.reason });
      if (!opened) {
        // Close before open without a preceding error event (or after one —
        // then this reject is a settled-promise no-op).
        clearTimeout(timer);
        rejectConnect(
          new VoiceProviderError({
            what: "websocket closed before open",
            detail: `code ${ev.code}: ${ev.reason}`,
          }),
        );
      }
    };
  });
}

// ---------- Internals ----------

/** Best-effort message extraction from a WHATWG error event (Bun's carries
 *  `.message`) or whatever a fake fired. */
function describeErrorEvent(ev: unknown): string {
  const message = (ev as { message?: unknown } | null | undefined)?.message;
  return message === undefined ? String(ev) : String(message);
}

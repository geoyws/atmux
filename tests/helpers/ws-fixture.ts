// Scripted WebSocket fixture for unit tests (ADR-272).
//
// A real `Bun.serve({ port: 0 })` WebSocket server with a small scripted-
// behavior surface, so websocket.ts / voice-adapter tests never touch the
// network beyond localhost. Records every upgrade request (headers +
// requested subprotocols + URL), every inbound frame, and every close.
//
// Two entry points:
//   - `startWsFixture(script?)` — upgrades every request; behavior driven by
//     the script (send-on-connect frames, respond(frame) → reply frames,
//     close-on-connect with a code, `hang` to never answer the upgrade).
//   - `startRejectingWsFixture(status?)` — never upgrades; answers plain HTTP
//     (default 401) so connect-failure paths can be driven for real.
//
// Frames are normalized at both edges: text as `string`, binary as
// `Uint8Array`.

import type { ServerWebSocket } from "bun";
import type { MinimalWebSocket } from "../../src/abstractions/websocket.ts";

/**
 * Hand-driven `MinimalWebSocket` fake for paths a real socket can't reach
 * deterministically (post-open error events, pre-open close-without-error,
 * lying readyState). Tests call the `fire*` methods to script the far end.
 */
export class FakeWebSocket implements MinimalWebSocket {
  binaryType = "blob";
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  /** Every frame passed to send(), in order. */
  sent: Array<string | Uint8Array> = [];
  /** Every close() call, in order (args as received). */
  closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  fireOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  fireError(ev: unknown): void {
    this.onerror?.(ev);
  }

  fireClose(code: number, reason: string): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code, reason });
  }
}

/** One recorded upgrade request. Header keys are lowercased by Bun. */
export interface WsFixtureConnection {
  /** Full request URL (http:// scheme — the upgrade request as Bun saw it). */
  url: string;
  headers: Record<string, string>;
  /** Parsed `sec-websocket-protocol` list, in request order. */
  protocols: string[];
}

/** Scripted server behavior. All fields optional; default = echo nothing. */
export interface WsFixtureScript {
  /** Frames sent to each client immediately on connect, in order. */
  onConnect?: ReadonlyArray<string | Uint8Array>;
  /** Called per inbound frame; returned frames are sent back, in order. */
  respond?: (frame: string | Uint8Array) => ReadonlyArray<string | Uint8Array>;
  /** Close each connection right after `onConnect` frames are sent. */
  closeOnConnect?: { code: number; reason: string };
  /** Never answer the upgrade request (drives open-timeout paths). */
  hang?: boolean;
}

export interface WsFixture {
  /** ws:// URL of the fixture. */
  url: string;
  /** One record per upgrade request, in connection order. */
  connections: WsFixtureConnection[];
  /** Every frame received from any client, in arrival order. */
  received: Array<string | Uint8Array>;
  /** Every client close observed server-side, in order. */
  closes: Array<{ code: number; reason: string }>;
  sendToAll(frame: string | Uint8Array): void;
  /** Send to the most recently opened connection. Throws if none is open. */
  sendToLast(frame: string | Uint8Array): void;
  /** Server-initiated close handshake on every open connection. */
  closeAll(code?: number, reason?: string): void;
  /** Abruptly destroy every open connection — no close handshake. */
  destroyAll(): void;
  /** Wait until at least `n` frames have been received (default 2s budget). */
  waitForReceived(n: number, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export function startWsFixture(script: WsFixtureScript = {}): WsFixture {
  const connections: WsFixtureConnection[] = [];
  const received: Array<string | Uint8Array> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const sockets = new Set<ServerWebSocket<undefined>>();
  let last: ServerWebSocket<undefined> | null = null;

  const srv = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (script.hang === true) {
        return new Promise<Response>(() => {
          // never settles — the client sits in CONNECTING until its timeout
        });
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const protoHeader = req.headers.get("sec-websocket-protocol") ?? "";
      connections.push({
        url: req.url,
        headers,
        protocols: protoHeader
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      });
      if (server.upgrade(req)) return undefined;
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        sockets.add(ws);
        last = ws;
        for (const frame of script.onConnect ?? []) {
          ws.send(frame);
        }
        if (script.closeOnConnect !== undefined) {
          ws.close(script.closeOnConnect.code, script.closeOnConnect.reason);
        }
      },
      message(ws: ServerWebSocket<undefined>, message: string | Buffer) {
        const frame = typeof message === "string" ? message : new Uint8Array(message);
        received.push(frame);
        for (const reply of script.respond?.(frame) ?? []) {
          ws.send(reply);
        }
      },
      close(ws: ServerWebSocket<undefined>, code: number, reason: string) {
        closes.push({ code, reason });
        sockets.delete(ws);
        if (last === ws) last = null;
      },
    },
  });

  return {
    url: `ws://localhost:${srv.port}`,
    connections,
    received,
    closes,
    sendToAll(frame) {
      for (const ws of sockets) ws.send(frame);
    },
    sendToLast(frame) {
      if (last === null) throw new Error("ws-fixture: no open connection to send to");
      last.send(frame);
    },
    closeAll(code?, reason?) {
      for (const ws of sockets) ws.close(code, reason);
    },
    destroyAll() {
      for (const ws of sockets) ws.terminate();
    },
    async waitForReceived(n, timeoutMs = 2000) {
      await waitUntil(() => received.length >= n, timeoutMs);
    },
    async stop() {
      // Bun 1.3.14 quirk (verified empirically): `server.stop(true)` never
      // resolves when the SERVER initiated a websocket close (close-after-
      // client-close resolves fine). Race a short grace so teardown always
      // completes; the test process reaps whatever the runtime leaks.
      await Promise.race([srv.stop(true), Bun.sleep(250)]);
    },
  };
}

/** HTTP server that never upgrades — answers every request with `status`. */
export function startRejectingWsFixture(status = 401): { url: string; stop(): Promise<void> } {
  const srv = Bun.serve({
    port: 0,
    fetch() {
      return new Response("no websockets here", { status });
    },
  });
  return {
    url: `ws://localhost:${srv.port}`,
    stop: async () => {
      await srv.stop(true);
    },
  };
}

/** Poll `cond` every 10ms until true; throw after `timeoutMs` (default 2s). */
export async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

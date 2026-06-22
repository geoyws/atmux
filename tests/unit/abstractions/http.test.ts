// Unit tests for src/abstractions/http.ts (ADR-003).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HttpError,
  isReachable,
  postJson,
  probeStatus,
  request,
} from "../../../src/abstractions/http.ts";
import { ConfigError } from "../../../src/errors.ts";

// ---------- Local test server ----------

interface ServerHandle {
  url(path: string): string;
  close(): Promise<void>;
  recordedRequests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }>;
}

let server: ServerHandle;
let attempts = 0;

beforeAll(() => {
  attempts = 0;
  const recorded: ServerHandle["recordedRequests"] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.body ? await req.text() : "";
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      recorded.push({ method: req.method, path: url.pathname, headers, body });

      switch (url.pathname) {
        case "/ok":
          return new Response("hello", { status: 200 });
        case "/json":
          return Response.json({ a: 1, b: "two" });
        case "/echo":
          return new Response(body, { status: 200 });
        case "/404":
          return new Response("not found", { status: 404 });
        case "/500":
          return new Response("oops", { status: 500 });
        case "/flaky-500-then-200":
          attempts += 1;
          if (attempts < 3) return new Response("transient", { status: 500 });
          return new Response("ok-eventually", { status: 200 });
        case "/slow":
          await new Promise((r) => setTimeout(r, 500));
          return new Response("late", { status: 200 });
        case "/teapot":
          return new Response("teapot", { status: 418 });
        default:
          return new Response("nope", { status: 404 });
      }
    },
  });
  server = {
    url: (path: string) => `http://localhost:${srv.port}${path}`,
    close: async () => {
      await srv.stop(true);
    },
    recordedRequests: recorded,
  };
});

afterAll(async () => {
  await server.close();
});

// ---------- Tests ----------

describe("request — happy path", () => {
  test("GET 200 returns parsed HttpResponse", async () => {
    const r = await request({ url: server.url("/ok") });
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello");
    expect(r.method).toBe("GET");
    expect(r.url).toBe(server.url("/ok"));
    expect(r.statusText).toBeDefined();
    expect(r.headers).toBeInstanceOf(Headers);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("default method is GET", async () => {
    await request({ url: server.url("/ok") });
    const got = server.recordedRequests.find((r) => r.path === "/ok");
    expect(got?.method).toBe("GET");
  });

  test("expectStatus array accepts unusual statuses", async () => {
    const r = await request({
      url: server.url("/teapot"),
      expectStatus: [200, 418],
    });
    expect(r.status).toBe(418);
  });

  test("expectStatus range form (default)", async () => {
    const r = await request({ url: server.url("/json") });
    expect(r.status).toBe(200);
  });

  test("respects explicit method", async () => {
    const r = await request({ url: server.url("/echo"), method: "post", body: "ping" });
    expect(r.status).toBe(200);
    expect(r.body).toBe("ping");
  });

  test("merges custom headers", async () => {
    await request({
      url: server.url("/ok"),
      headers: { "x-test-marker": "hello" },
    });
    const last = server.recordedRequests.find((r) => r.headers["x-test-marker"] === "hello");
    expect(last).toBeDefined();
  });
});

describe("request — failure paths", () => {
  test("4xx throws HttpError without retry", async () => {
    let caught: HttpError | null = null;
    try {
      await request({ url: server.url("/404") });
    } catch (e) {
      if (e instanceof HttpError) caught = e;
    }
    expect(caught?.status).toBe(404);
    expect(caught?.body).toBe("not found");
    expect(caught?.url).toBe(server.url("/404"));
    expect(caught?.method).toBe("GET");
    expect(caught?.message).toContain("HTTP 404");
  });

  test("5xx throws HttpError when retry exhausted", async () => {
    let caught: HttpError | null = null;
    try {
      await request({ url: server.url("/500"), retry: 1, retryDelayMs: 10 });
    } catch (e) {
      if (e instanceof HttpError) caught = e;
    }
    expect(caught?.status).toBe(500);
  });

  test("5xx retries succeed when transient", async () => {
    attempts = 0;
    const r = await request({
      url: server.url("/flaky-500-then-200"),
      retry: 5,
      retryDelayMs: 10,
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe("ok-eventually");
    expect(attempts).toBe(3);
  });

  test("invalid URL throws ConfigError", async () => {
    let caught: ConfigError | null = null;
    try {
      await request({ url: "not-a-url" });
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("not-a-url");
  });

  test("timeout aborts the request", async () => {
    let caught: Error | null = null;
    try {
      await request({ url: server.url("/slow"), timeoutMs: 50 });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
  });

  test("network failure retries then surfaces error", async () => {
    let caught: Error | null = null;
    try {
      await request({
        url: "http://127.0.0.1:1/never",
        retry: 2,
        retryDelayMs: 10,
        timeoutMs: 200,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
  });

  test("retry: 0 (default) means no second attempt on 5xx", async () => {
    let caught: HttpError | null = null;
    try {
      await request({ url: server.url("/500") });
    } catch (e) {
      if (e instanceof HttpError) caught = e;
    }
    expect(caught?.status).toBe(500);
  });

  test("AbortSignal cancels in-flight request", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    let caught: Error | null = null;
    try {
      await request({ url: server.url("/slow"), signal: ctrl.signal });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
  });

  test("pre-aborted external signal aborts immediately", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let caught: Error | null = null;
    try {
      await request({ url: server.url("/slow"), signal: ctrl.signal });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
  });

  test("negative retry treated as 0", async () => {
    let caught: HttpError | null = null;
    try {
      await request({ url: server.url("/404"), retry: -3 });
    } catch (e) {
      if (e instanceof HttpError) caught = e;
    }
    expect(caught?.status).toBe(404);
  });

  test("4xx is NOT retried even when retry budget > 0", async () => {
    const before = server.recordedRequests.filter((r) => r.path === "/404").length;
    let caught: HttpError | null = null;
    try {
      await request({ url: server.url("/404"), retry: 5, retryDelayMs: 1 });
    } catch (e) {
      if (e instanceof HttpError) caught = e;
    }
    expect(caught?.status).toBe(404);
    const after = server.recordedRequests.filter((r) => r.path === "/404").length;
    expect(after - before).toBe(1); // exactly one attempt; 4xx skipped retry
  });

  test("expectStatus range form rejects status outside range", async () => {
    let caught: HttpError | null = null;
    try {
      await request({ url: server.url("/teapot"), expectStatus: { min: 200, max: 299 } });
    } catch (e) {
      if (e instanceof HttpError) caught = e;
    }
    expect(caught?.status).toBe(418);
  });

  test("non-finite timeoutMs (Infinity) skips the timer setup", async () => {
    // Hits the `timer === null` branch in sendOnce — when caller opts out
    // of timeout enforcement (rare; reserved for streaming-style callers).
    const r = await request({ url: server.url("/ok"), timeoutMs: Infinity });
    expect(r.status).toBe(200);
  });
});

describe("postJson", () => {
  test("serializes payload + sets content-type", async () => {
    const r = await postJson(server.url("/echo"), { hello: "world" });
    expect(r.status).toBe(200);
    expect(r.body).toBe(`{"hello":"world"}`);
    const last = server.recordedRequests
      .filter((rec) => rec.path === "/echo" && rec.method === "POST")
      .at(-1);
    expect(last?.headers["content-type"]).toContain("application/json");
  });

  test("preserves caller-supplied headers", async () => {
    await postJson(server.url("/echo"), { x: 1 }, { headers: { "x-trace": "abc" } });
    const last = server.recordedRequests
      .filter((r) => r.path === "/echo" && r.headers["x-trace"] === "abc")
      .at(-1);
    expect(last).toBeDefined();
  });
});

describe("isReachable", () => {
  test("returns true on 200", async () => {
    expect(await isReachable(server.url("/ok"))).toBe(true);
  });

  test("returns false on non-2xx (HttpError swallowed)", async () => {
    expect(await isReachable(server.url("/404"))).toBe(false);
  });

  test("returns false on network failure", async () => {
    expect(await isReachable("http://127.0.0.1:1/never")).toBe(false);
  });

  test("returns false on timeout (HttpTimeoutError swallowed)", async () => {
    expect(await isReachable(server.url("/slow"), { timeoutMs: 50 })).toBe(false);
  });

  test("re-throws non-Http errors (e.g. ConfigError on bad URL)", async () => {
    let caught: Error | null = null;
    try {
      await isReachable("not-a-url");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.constructor.name).toBe("ConfigError");
  });
});

describe("probeStatus", () => {
  test("returns 200 on a 2xx response", async () => {
    expect(await probeStatus(server.url("/ok"))).toBe(200);
  });

  test("returns the 4xx status code (Discord webhook 405-on-GET pattern)", async () => {
    expect(await probeStatus(server.url("/404"))).toBe(404);
  });

  test("returns 0 on network failure (connection refused)", async () => {
    expect(await probeStatus("http://127.0.0.1:1/never")).toBe(0);
  });

  test("returns 0 on timeout (HttpTimeoutError swallowed)", async () => {
    expect(await probeStatus(server.url("/slow"), { timeoutMs: 50 })).toBe(0);
  });

  test("re-throws non-Http errors (e.g. ConfigError on bad URL)", async () => {
    let caught: Error | null = null;
    try {
      await probeStatus("not-a-url");
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.constructor.name).toBe("ConfigError");
  });
});

describe("HttpError", () => {
  test("carries url + method + status + body", () => {
    const e = new HttpError({
      url: "https://x/y",
      method: "POST",
      status: 500,
      body: "boom",
    });
    expect(e instanceof HttpError).toBe(true);
    expect(e.tag).toBe("http");
    expect(e.message).toContain("HTTP 500 from POST https://x/y");
    expect(e.status).toBe(500);
    expect(e.body).toBe("boom");
    expect(e.url).toBe("https://x/y");
    expect(e.method).toBe("POST");
  });

  test("carries cause for network-level failures (status=0)", () => {
    const cause = new TypeError("fetch failed");
    const e = new HttpError({
      url: "https://x/y",
      method: "GET",
      status: 0,
      body: "",
      cause,
    });
    expect(e.status).toBe(0);
    expect(e.cause).toBe(cause);
  });
});

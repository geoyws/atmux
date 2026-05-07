// ADR-003: HTTP requests — typed wrapper over Bun's `fetch`.
//
// Domain code never calls `fetch` directly (R-fetch per ADR-006 + ADR-009 §3.5).
// This module owns:
//   - JSON request shorthand (`postJson`)
//   - Status-code validation (default: 2xx success; configurable)
//   - AbortSignal-driven timeout, surfaced as `HttpTimeoutError` (ADR-006 tag
//     "http-timeout" maps to BSD `EX_TEMPFAIL` 75 — cron retries cleanly)
//   - Optional retry (caller-supplied `retry` count + delay; 5xx is retried,
//     4xx is the caller's bug — no retry)
//   - Reachability probe (`isReachable`) — ports doctor.sh's status-code
//     check (`curl -w '%{http_code}' --max-time 5`)
//
// Discord webhook send goes through `discord.ts` which delegates to
// `spawn(ping-discord.sh)`; this module is for the doctor verb's HTTP probe
// + any future verb that talks plain HTTP.

import { ConfigError, HttpError, HttpTimeoutError } from "../errors.ts";

/** Re-export for ergonomics — callers usually `import { HttpError } from "..../http.ts"`
 *  next to the request helpers. The canonical class lives in `errors.ts`. */
export { HttpError, HttpTimeoutError } from "../errors.ts";

// ---------- Public types ----------

export interface HttpRequestOpts {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  /** Body. JSON helpers serialize automatically; `request` takes raw bytes. */
  body?: string | Uint8Array | null;
  /** Hard timeout in ms; default 10_000. */
  timeoutMs?: number;
  /** Retry count (additional attempts on network/5xx error). Default 0. */
  retry?: number;
  /** Backoff between retries in ms. Default 200ms. */
  retryDelayMs?: number;
  /** Accepted status range. Default `[200, 299]`. */
  expectStatus?: ReadonlyArray<number> | { min: number; max: number };
  /** External cancellation. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  url: string;
  method: string;
  status: number;
  statusText: string;
  headers: Headers;
  /** Decoded body. Empty string for 204 / no-content responses. */
  body: string;
  /** ms from request issue to body fully read. */
  durationMs: number;
}

// ---------- Core request ----------

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 200;

/**
 * Execute a single HTTP request with timeout + optional retry.
 *
 * @throws ConfigError on a malformed URL.
 * @throws HttpTimeoutError if the AbortController fires before the response.
 * @throws HttpError on a status outside `expectStatus` (status field carries
 *         the response code) OR on a network failure (DNS / refused / TLS;
 *         status field set to 0 with `cause` carrying the underlying error).
 *
 * 5xx is retried up to `retry` extra attempts; 4xx is the caller's bug — no retry.
 */
export async function request(opts: HttpRequestOpts): Promise<HttpResponse> {
  validateUrl(opts.url);
  const method = (opts.method ?? "GET").toUpperCase();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retry = Math.max(0, opts.retry ?? 0);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const expect = opts.expectStatus ?? { min: 200, max: 299 };

  // Single-loop retry walker — every path inside the body either returns,
  // `continue`s with backoff, or throws. No unreachable trailing throw
  // (which would dilute the 100% coverage gate per ADR-009 §2).
  let attempt = 0;
  while (true) {
    try {
      const start = nowMs();
      const sent = await sendOnce({
        url: opts.url,
        method,
        headers: opts.headers,
        body: opts.body ?? null,
        timeoutMs,
        externalSignal: opts.signal,
      });
      const durationMs = nowMs() - start;
      const body = await sent.response.text();
      const httpResp: HttpResponse = {
        url: opts.url,
        method,
        status: sent.response.status,
        statusText: sent.response.statusText,
        headers: sent.response.headers,
        body,
        durationMs,
      };
      if (!statusAccepted(httpResp.status, expect)) {
        // 5xx is retryable; 4xx is the caller's bug, no retry (ADR-003 §retry).
        if (httpResp.status >= 500 && attempt < retry) {
          attempt += 1;
          await sleep(retryDelayMs);
          continue;
        }
        throw new HttpError({
          url: opts.url,
          method,
          status: httpResp.status,
          body,
        });
      }
      return httpResp;
    } catch (e) {
      // Status-rejection HttpError thrown above — propagate without retry.
      // (5xx-with-retry-budget already `continue`d before reaching here.)
      if (e instanceof HttpError) throw e;
      // Timeout already typed by sendOnce — propagate untouched.
      if (e instanceof HttpTimeoutError) throw e;
      // Network-level failure (TypeError from fetch, AbortError from
      // external signal, DNS / refused / TLS) — retry budget remaining
      // means backoff + try again.
      if (attempt < retry) {
        attempt += 1;
        await sleep(retryDelayMs);
        continue;
      }
      // Budget exhausted — wrap with status=0 so catch-by-tag sites have
      // a uniform shape (ADR-006 R6: every IO failure is an AtmuxError).
      throw new HttpError({
        url: opts.url,
        method,
        status: 0,
        body: "",
        cause: e,
      });
    }
  }
}

/** Convenience: HEAD-style probe that returns true on 2xx, false otherwise
 *  (status-failure OR timeout OR network-failure). No body parse, no retry.
 *  Used by doctor verb's health checks (matches bash `curl -w '%{http_code}'`). */
export async function isReachable(
  url: string,
  opts?: Omit<HttpRequestOpts, "url" | "method" | "body" | "expectStatus" | "retry">,
): Promise<boolean> {
  try {
    await request({ ...opts, url, method: "GET", expectStatus: { min: 200, max: 299 } });
    return true;
  } catch (e) {
    if (e instanceof HttpError) return false; // expected: caller wants up/down
    if (e instanceof HttpTimeoutError) return false; // expected: timeout = unreachable
    throw e;
  }
}

/** Convenience: GET probe that returns the HTTP status code, or `0` on
 *  network/timeout failure. Mirrors bash `curl -sS -o /dev/null -w '%{http_code}'
 *  || echo 000`. Doctor's webhook check uses this — Discord returns 405 on
 *  GET (not 2xx), so `isReachable` returns false even though the webhook IS
 *  reachable; doctor needs the status code to distinguish 405 (green:
 *  "rejected method, but reached") from 000 (red: "DNS / connection
 *  failure") and 4xx-other (red: "webhook rejected — likely revoked"). */
export async function probeStatus(
  url: string,
  opts?: Omit<HttpRequestOpts, "url" | "method" | "body" | "expectStatus" | "retry">,
): Promise<number> {
  try {
    const r = await request({
      ...opts,
      url,
      method: "GET",
      expectStatus: { min: 0, max: 999 },
    });
    return r.status;
  } catch (e) {
    if (e instanceof HttpError) return 0; // network failure (status=0 on the error)
    if (e instanceof HttpTimeoutError) return 0; // timeout = unreachable
    throw e;
  }
}

/**
 * Convenience: POST with JSON body + `Content-Type: application/json`.
 * Caller passes a value; we serialize via `JSON.stringify`. (R3 gates
 * `JSON.parse`, not `JSON.stringify`; see ADR-005 §"Reviewer rule".)
 */
export async function postJson(
  url: string,
  payload: unknown,
  opts?: Omit<HttpRequestOpts, "url" | "method" | "body">,
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts?.headers ?? {}),
  };
  return request({
    ...opts,
    url,
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

// ---------- Internals ----------

interface SendOnceOpts {
  url: string;
  method: string;
  headers: Readonly<Record<string, string>> | undefined;
  body: string | Uint8Array | null;
  timeoutMs: number;
  externalSignal: AbortSignal | undefined;
}

async function sendOnce(opts: SendOnceOpts): Promise<{ response: Response }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs)
      : null;
  // Bridge external abort onto the controller so a timeout-or-external
  // cancel both surface as the same AbortError.
  const onExternalAbort = (): void => controller.abort(opts.externalSignal?.reason);
  if (opts.externalSignal) {
    if (opts.externalSignal.aborted) onExternalAbort();
    else opts.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const init: RequestInit = {
      method: opts.method,
      signal: controller.signal,
    };
    if (opts.headers) init.headers = opts.headers as Record<string, string>;
    if (opts.body !== null) init.body = opts.body;
    const response = await fetch(opts.url, init);
    return { response };
  } catch (e) {
    if (timedOut) {
      throw new HttpTimeoutError({
        url: opts.url,
        method: opts.method,
        timeoutMs: opts.timeoutMs,
      });
    }
    throw e;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (opts.externalSignal) {
      opts.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function statusAccepted(
  status: number,
  expect: ReadonlyArray<number> | { min: number; max: number },
): boolean {
  if (Array.isArray(expect)) return expect.includes(status);
  const range = expect as { min: number; max: number };
  return status >= range.min && status <= range.max;
}

function validateUrl(url: string): void {
  try {
    // Throws on invalid form. Doesn't validate that the host is reachable.
    new URL(url);
  } catch (e) {
    throw new ConfigError({
      what: `invalid URL: ${url}`,
      hint: "URLs must include a scheme (http:// or https://)",
      cause: e,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  return Bun.nanoseconds() / 1_000_000;
}

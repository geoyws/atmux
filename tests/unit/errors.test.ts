// Unit tests for src/errors.ts (ADR-006).
// 100% line/branch/function coverage on the narrowed denominator.

import { describe, expect, test } from "bun:test";
import { ZodError, z } from "zod";
import type { AtmuxErrorTag } from "../../src/errors.ts";
import {
  AtmuxError,
  assertNever,
  ConfigError,
  DiscordWebhookError,
  exitCodeForTag,
  FsError,
  formatErrorChain,
  HttpError,
  HttpTimeoutError,
  LockError,
  LockTimeoutError,
  SchemaError,
  SpawnError,
  SpawnTimeoutError,
  TmuxError,
  TrackerRateLimitError,
  UsageError,
  VerbMutexError,
  VoiceProviderError,
} from "../../src/errors.ts";

describe("AtmuxError subclasses", () => {
  test("TmuxError carries argv + exitCode + stderr in message", () => {
    const e = new TmuxError({
      argv: ["new-session", "-d", "-s", "x"],
      exitCode: 1,
      stderr: "no server\n",
    });
    expect(e.tag).toBe("tmux");
    expect(e.message).toContain("tmux new-session failed (exit 1)");
    expect(e.message).toContain("no server");
    expect(e instanceof AtmuxError).toBe(true);
  });

  test("TmuxError handles empty argv", () => {
    const e = new TmuxError({ argv: [], exitCode: 2, stderr: "boom" });
    expect(e.message).toContain("tmux  failed");
  });

  test("SpawnError formats cmd + argv + exit", () => {
    const e = new SpawnError({
      cmd: "curl",
      argv: ["-fsS", "https://x"],
      exitCode: 22,
      stderr: "",
    });
    expect(e.tag).toBe("spawn");
    expect(e.message).toBe("curl -fsS https://x failed (exit 22)");
    expect(e.context.cmd).toBe("curl");
  });

  test("SpawnTimeoutError formats cmd + argv + ms", () => {
    const e = new SpawnTimeoutError({
      cmd: "sleep",
      argv: ["10"],
      timeoutMs: 100,
    });
    expect(e.tag).toBe("spawn-timeout");
    expect(e.message).toBe("sleep 10 timed out after 100ms");
  });

  test("SchemaError surfaces first issue path + message", () => {
    const schema = z.object({ a: z.number() });
    let zerr: ZodError | undefined;
    try {
      schema.parse({ a: "not-a-number" });
    } catch (e) {
      if (e instanceof ZodError) zerr = e;
    }
    expect(zerr).toBeDefined();
    if (!zerr) throw new Error("zerr missing");
    const e = new SchemaError({ file: "kanban.json", issues: zerr.issues, cause: zerr });
    expect(e.tag).toBe("schema");
    expect(e.message).toContain("kanban.json");
    expect(e.message).toContain("a");
    expect(e.cause).toBe(zerr);
  });

  test("SchemaError handles empty issues list", () => {
    const fakeZerr = new ZodError([]);
    const e = new SchemaError({ file: "team.json", issues: [], cause: fakeZerr });
    expect(e.message).toContain("<root>");
    expect(e.message).toContain("unknown schema error");
  });

  test("SchemaError uses <root> for empty path", () => {
    const issues = [{ path: [], message: "expected object", code: "custom" } as never];
    const fakeZerr = new ZodError([]);
    const e = new SchemaError({ file: "t.json", issues, cause: fakeZerr });
    expect(e.message).toContain("<root>");
    expect(e.message).toContain("expected object");
  });

  test("LockError formats path", () => {
    const e = new LockError({ path: "/tmp/x.lock" });
    expect(e.tag).toBe("lock");
    expect(e.message).toBe("could not acquire lock on /tmp/x.lock");
  });

  test("LockError preserves cause", () => {
    const cause = new Error("EACCES");
    const e = new LockError({ path: "/tmp/x.lock", cause });
    expect(e.cause).toBe(cause);
  });

  test("LockTimeoutError formats path + timeout", () => {
    const e = new LockTimeoutError({ path: "/tmp/k.json.lock", timeoutMs: 5000 });
    expect(e.tag).toBe("lock-timeout");
    expect(e.message).toBe("lock on /tmp/k.json.lock timed out after 5000ms");
  });

  test("FsError formats path + op", () => {
    const e = new FsError({ path: "/tmp/x", op: "read", cause: new Error("ENOENT") });
    expect(e.tag).toBe("fs");
    expect(e.message).toBe("fs read failed on /tmp/x");
  });

  test("HttpError formats status + method + url", () => {
    const cause = new TypeError("fetch failed");
    const e = new HttpError({
      url: "https://x/y",
      method: "POST",
      status: 503,
      body: "Service Unavailable",
      cause,
    });
    expect(e.tag).toBe("http");
    expect(e.message).toBe("HTTP 503 from POST https://x/y");
    expect(e.status).toBe(503);
    expect(e.body).toBe("Service Unavailable");
    expect(e.url).toBe("https://x/y");
    expect(e.method).toBe("POST");
    expect(e.cause).toBe(cause);
  });

  test("HttpError carries status=0 for network failures", () => {
    const e = new HttpError({
      url: "http://127.0.0.1:1/never",
      method: "GET",
      status: 0,
      body: "",
      cause: new TypeError("fetch failed"),
    });
    expect(e.status).toBe(0);
    expect(e.message).toContain("HTTP 0");
  });

  test("HttpTimeoutError formats url + method + ms", () => {
    const e = new HttpTimeoutError({
      url: "https://x/y",
      method: "GET",
      timeoutMs: 5000,
    });
    expect(e.tag).toBe("http-timeout");
    expect(e.message).toBe("http GET https://x/y timed out after 5000ms");
  });

  test("TrackerRateLimitError carries trackerId + resetAtSec + status", () => {
    const e = new TrackerRateLimitError({
      trackerId: "github",
      url: "https://api.github.com/repos/a/b/issues",
      status: 403,
      resetAtSec: 1765432100,
    });
    expect(e.tag).toBe("tracker-rate-limit");
    expect(e.trackerId).toBe("github");
    expect(e.resetAtSec).toBe(1765432100);
    expect(e.message).toBe(
      "github rate limit exhausted (HTTP 403 from https://api.github.com/repos/a/b/issues, resets at epoch 1765432100)",
    );
    expect(e instanceof AtmuxError).toBe(true);
  });

  test("TrackerRateLimitError omits the reset tail when resetAtSec is null", () => {
    const cause = new Error("upstream");
    const e = new TrackerRateLimitError({
      trackerId: "github",
      url: "https://api.github.com/x",
      status: 429,
      resetAtSec: null,
      cause,
    });
    expect(e.resetAtSec).toBeNull();
    expect(e.message).toBe("github rate limit exhausted (HTTP 429 from https://api.github.com/x)");
    expect(e.message).not.toContain("resets at epoch");
    expect(e.cause).toBe(cause);
  });

  test("DiscordWebhookError adds HTTP status when provided", () => {
    const e = new DiscordWebhookError({ template: "whip-progress", statusCode: 429 });
    expect(e.tag).toBe("discord");
    expect(e.message).toContain("(HTTP 429)");
    expect(e.message).toContain("whip-progress");
  });

  test("DiscordWebhookError omits status when not provided", () => {
    const e = new DiscordWebhookError({ template: "report-digest" });
    expect(e.message).toBe("discord webhook report-digest failed");
  });

  test("DiscordWebhookError appends detail", () => {
    const e = new DiscordWebhookError({
      template: "whip-progress",
      detail: "bullet 3 too long",
    });
    expect(e.message).toContain("bullet 3 too long");
  });

  test("ConfigError formats with hint", () => {
    const e = new ConfigError({ what: "no team.json", hint: "run atmux init" });
    expect(e.tag).toBe("config");
    expect(e.message).toBe("no team.json (hint: run atmux init)");
  });

  test("ConfigError omits hint when absent", () => {
    const e = new ConfigError({ what: "no team.json" });
    expect(e.message).toBe("no team.json");
  });

  test("UsageError formats with hint", () => {
    const e = new UsageError({ what: "unknown verb", hint: "try `atmux help`" });
    expect(e.tag).toBe("usage");
    expect(e.message).toBe("unknown verb — try `atmux help`");
  });

  test("UsageError omits hint", () => {
    const e = new UsageError({ what: "missing arg" });
    expect(e.message).toBe("missing arg");
  });

  test("VoiceProviderError formats provider + what + detail", () => {
    const e = new VoiceProviderError({
      what: "session died",
      provider: "openai-realtime",
      detail: "code 1006",
    });
    expect(e.tag).toBe("voice-provider");
    expect(e.message).toBe("voice provider (openai-realtime): session died — code 1006");
    expect(e instanceof AtmuxError).toBe(true);
    expect(e.context.provider).toBe("openai-realtime");
  });

  test("VoiceProviderError omits provider + detail when absent, preserves cause", () => {
    const cause = new Error("ECONNRESET");
    const e = new VoiceProviderError({ what: "websocket connection failed", cause });
    expect(e.message).toBe("voice provider: websocket connection failed");
    expect(e.cause).toBe(cause);
  });

  test("VerbMutexError (queue_full) names the holder and says nothing ran", () => {
    const e = new VerbMutexError({
      reason: "queue_full",
      label: "team_health",
      blockedBy: "team_status",
      waitedMs: 0,
      queueDepth: 8,
      queueCap: 8,
    });
    expect(e.tag).toBe("verb-mutex");
    expect(e.message).toBe(
      "verb lane full behind 'team_status': 8/8 queued — 'team_health' was not run",
    );
    expect(e instanceof AtmuxError).toBe(true);
    expect(e.reason).toBe("queue_full");
    expect(e.blockedBy).toBe("team_status");
    expect(e.queueDepth).toBe(8);
    expect(e.queueCap).toBe(8);
    expect(e.waitedMs).toBe(0);
  });

  test("VerbMutexError (abandoned) reports the wait it gave up after", () => {
    const e = new VerbMutexError({
      reason: "abandoned",
      label: "dispatch_task",
      blockedBy: "team_status",
      waitedMs: 45_000,
      queueDepth: 2,
      queueCap: 8,
    });
    expect(e.message).toBe(
      "verb lane: 'dispatch_task' abandoned after waiting 45000ms behind 'team_status'",
    );
    expect(e.reason).toBe("abandoned");
    expect(e.waitedMs).toBe(45_000);
  });

  test("VerbMutexError with no holder omits the 'behind' clause rather than naming null", () => {
    const full = new VerbMutexError({
      reason: "queue_full",
      label: "a",
      blockedBy: null,
      waitedMs: 0,
      queueDepth: 1,
      queueCap: 1,
    });
    expect(full.message).toBe("verb lane full: 1/1 queued — 'a' was not run");
    const abandoned = new VerbMutexError({
      reason: "abandoned",
      label: "b",
      blockedBy: null,
      waitedMs: 5,
      queueDepth: 0,
      queueCap: 1,
    });
    expect(abandoned.message).toBe("verb lane: 'b' abandoned after waiting 5ms");
  });
});

describe("exitCodeForTag", () => {
  test.each<[AtmuxErrorTag, number]>([
    ["usage", 64],
    ["config", 78],
    ["lock-timeout", 75],
    ["spawn-timeout", 75],
    ["http-timeout", 75],
    ["tracker-rate-limit", 75],
    ["voice-provider", 75],
    ["verb-mutex", 75],
    ["schema", 65],
    ["tmux", 1],
    ["spawn", 1],
    ["fs", 1],
    ["http", 1],
    ["discord", 1],
    ["lock", 1],
  ])("tag %s → exit %d", (tag, expected) => {
    expect(exitCodeForTag(tag)).toBe(expected);
  });

  test("exhaustiveness guard throws on an impossible tag", () => {
    expect(() => exitCodeForTag("bogus" as never)).toThrow("unreachable: bogus");
  });
});

describe("assertNever", () => {
  test("throws on any input", () => {
    expect(() => assertNever("anything" as never)).toThrow("unreachable: anything");
  });
});

describe("formatErrorChain", () => {
  test("renders single AtmuxError with tag", () => {
    const e = new ConfigError({ what: "missing" });
    const out = formatErrorChain(e);
    expect(out).toContain("[config]");
    expect(out).toContain("missing");
  });

  test("walks .cause chain", () => {
    const root = new Error("ENOENT");
    const wrap = new FsError({ path: "/x", op: "read", cause: root });
    const out = formatErrorChain(wrap);
    expect(out).toContain("[fs]");
    expect(out).toContain("ENOENT");
  });

  test("handles non-Error cause leaf", () => {
    const wrap = new ConfigError({ what: "bad", cause: "raw string cause" });
    const out = formatErrorChain(wrap);
    expect(out).toContain("raw string cause");
  });

  test("handles plain Error (no tag)", () => {
    const out = formatErrorChain(new Error("boom"));
    expect(out).toContain("Error: boom");
  });

  test("handles null / undefined", () => {
    expect(formatErrorChain(undefined)).toBe("\n");
    expect(formatErrorChain(null)).toBe("\n");
  });

  test("stops at depth limit on cause cycle", () => {
    const a = new Error("a");
    // forge a cycle (real-world: misconfigured cause)
    (a as { cause?: unknown }).cause = a;
    const out = formatErrorChain(a);
    // Should not infinite-loop; bounded output.
    expect(out.length).toBeLessThan(10_000);
  });
});

// Unit tests for src/abstractions/budget-probe.ts (ADR-053 §D1 + §D5
// + Fix C OAuth refresh).
//
// Coverage axes:
//   - Account short-circuits (empty / default / null).
//   - Cache hit (TTL respected) + stale-cache miss + force-bypass.
//   - Live probe — happy path, header parsing, on-disk shape (bash
//     compatible), history-log append.
//   - OAuth refresh on near-expiry expiresAt (< now+60s) — tokens
//     atomically re-written to credentials.json; tokenRefreshed=true
//     in history.
//   - 401 retry — single force-refresh round-trip on probe 401, then
//     re-probe.
//   - Refresh-failure → status=probe-401 + flag surface invoked.
//   - Refresh-failure-on-near-expiry without refreshToken → probe-401.
//   - no-credentials → file missing / malformed / no accessToken.
//   - probe-error → non-2xx, missing utilization headers.
//   - All failure paths still write cache + history (observability).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BudgetProbeResult, probeBudget } from "../../../src/abstractions/budget-probe.ts";
import { resetNow, setNow } from "../../../src/abstractions/time.ts";

// ---------- Fixed test clock ----------

const FIXED_NOW_MS = Date.UTC(2026, 4, 7, 3, 44); // 2026-05-07 03:44 UTC = 11:44 MYT
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

// File-scope PATH isolation — t-3460d587 root cause. Tests that don't
// inject `opts.flagSurface` fall through to `defaultFlagSurface`, which
// spawns the real `atmux flags add` against the worktree's actual
// .atmux/flags.md. With PATH neutered, that spawn fails-to-find and the
// catch block swallows the error per ADR-053 §D1 (flags surface failure
// is best-effort; probe-401 status still in cache + history).
let _origPath: string | undefined;

beforeAll(() => {
  setNow(() => FIXED_NOW_MS);
  _origPath = process.env.PATH;
  process.env.PATH = "/nonexistent/atmux-test-isolation";
});

afterAll(() => {
  resetNow();
  if (_origPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = _origPath;
  }
});

// ---------- Sandbox per test ----------

let tmpRoot: string;
let homeDir: string;
let atmuxDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atmux-budget-probe-"));
  homeDir = join(tmpRoot, "home");
  atmuxDir = join(tmpRoot, "project", ".atmux");
  await mkdir(homeDir, { recursive: true });
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------- Helpers ----------

interface CredsOverride {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function writeCreds(account: string, overrides: CredsOverride = {}): Promise<string> {
  const dir = join(homeDir, `.claude-${account}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  const creds = {
    claudeAiOauth: {
      accessToken: overrides.accessToken ?? "valid-access-token",
      refreshToken: overrides.refreshToken ?? "valid-refresh-token",
      expiresAt: overrides.expiresAt ?? FIXED_NOW_MS + 86_400_000,
    },
  };
  await writeFile(path, JSON.stringify(creds, null, 2));
  return path;
}

interface ProbeServerOpts {
  utilization5h?: number;
  utilization7d?: number;
  reset5h?: number;
  reset7d?: number;
  statusHeader?: string;
  forceStatusCode?: number;
  /** When set, the FIRST request returns 401; subsequent return 2xx normally. */
  failFirstWith401?: boolean;
}

interface ProbeServerHandle {
  url: string;
  refreshUrl: string;
  /** Stop the server. */
  stop: () => Promise<void>;
  /** Number of times the probe endpoint was hit. */
  probeCalls: () => number;
  /** Number of times the refresh endpoint was hit. */
  refreshCalls: () => number;
  /** Most recent refresh-token sent (for assertion). */
  lastRefreshToken: () => string;
  /** Override refresh response body. */
  setRefreshResponse: (body: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    status?: number;
  }) => void;
}

function startProbeServer(opts: ProbeServerOpts = {}): ProbeServerHandle {
  let probeCallCount = 0;
  let refreshCallCount = 0;
  let lastRefreshToken = "";
  let refreshResp: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    status?: number;
  } = {
    access_token: "fresh-access-token",
    refresh_token: "fresh-refresh-token",
    expires_in: 86_400,
  };

  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/oauth/token") {
        refreshCallCount += 1;
        try {
          const body = (await req.json()) as { refresh_token?: string };
          lastRefreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
        } catch {
          /* expected: malformed-body tests don't send JSON */
        }
        const status = refreshResp.status ?? 200;
        return new Response(JSON.stringify(refreshResp), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/messages") {
        probeCallCount += 1;
        if (opts.failFirstWith401 === true && probeCallCount === 1) {
          return new Response("", { status: 401 });
        }
        if (opts.forceStatusCode !== undefined) {
          return new Response("", { status: opts.forceStatusCode });
        }
        const headers = new Headers();
        if (opts.utilization5h !== undefined) {
          headers.set("anthropic-ratelimit-unified-5h-utilization", String(opts.utilization5h));
        }
        if (opts.utilization7d !== undefined) {
          headers.set("anthropic-ratelimit-unified-7d-utilization", String(opts.utilization7d));
        }
        if (opts.reset5h !== undefined) {
          headers.set("anthropic-ratelimit-unified-5h-reset", String(opts.reset5h));
        }
        if (opts.reset7d !== undefined) {
          headers.set("anthropic-ratelimit-unified-7d-reset", String(opts.reset7d));
        }
        if (opts.statusHeader !== undefined) {
          headers.set("anthropic-ratelimit-unified-status", opts.statusHeader);
        }
        return new Response('{"ok":true}', { status: 200, headers });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${srv.port}/messages`,
    refreshUrl: `http://localhost:${srv.port}/oauth/token`,
    stop: () => srv.stop(true),
    probeCalls: () => probeCallCount,
    refreshCalls: () => refreshCallCount,
    lastRefreshToken: () => lastRefreshToken,
    setRefreshResponse: (body) => {
      refreshResp = body;
    },
  };
}

async function readHistoryLines(): Promise<unknown[]> {
  const path = join(atmuxDir, "logs", "budget-history.jsonl");
  try {
    const txt = await readFile(path, "utf8");
    return txt
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ---------- Account short-circuits ----------

describe("probeBudget — account short-circuits", () => {
  test("empty account → no-credentials without filesystem touch", async () => {
    const r = await probeBudget("", { atmuxDir, homeDir });
    expect(r.status).toBe("no-credentials");
    expect(r.account).toBe("");
  });

  test("default → no-credentials", async () => {
    const r = await probeBudget("default", { atmuxDir, homeDir });
    expect(r.status).toBe("no-credentials");
  });

  test("null → no-credentials", async () => {
    const r = await probeBudget("null", { atmuxDir, homeDir });
    expect(r.status).toBe("no-credentials");
  });
});

// ---------- Cache flow ----------

describe("probeBudget — cache flow", () => {
  test("cache hit returns source=cache-hit and skips probe", async () => {
    // Pre-populate cache with bash-shape JSON; align mtime to mocked now()
    // so ageSec computes inside ttl. (Real-time mtime would skew negative
    // -OR- arbitrarily positive depending on when the test runs vs the
    // FIXED_NOW_MS mock.)
    const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        h5_util: 0.42,
        wk_util: 0.18,
        h5_reset: FIXED_NOW_SEC + 3600,
        wk_reset: FIXED_NOW_SEC + 86400,
        status: "allowed",
        probedAt: FIXED_NOW_SEC,
      }),
    );
    const mtime = new Date(FIXED_NOW_MS - 30_000); // 30s before mocked now
    await utimes(cachePath, mtime, mtime);

    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      // Probe URL set but should NEVER be hit — cache short-circuits.
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.source).toBe("cache-hit");
    expect(r.h5_pct_used).toBe(42);
    expect(r.wk_pct_used).toBe(18);
    expect(r.status).toBe("allowed");
    expect(r.probedAt).toBe(FIXED_NOW_SEC);
  });

  test("cache miss when stale → live probe", async () => {
    const server = startProbeServer({
      utilization5h: 0.05,
      utilization7d: 0.1,
      reset5h: FIXED_NOW_SEC + 3600,
      reset7d: FIXED_NOW_SEC + 86400,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud");
      // Pre-populate stale cache (mtime older than ttl).
      const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({
          h5_util: 0.99,
          wk_util: 0.99,
          h5_reset: 0,
          wk_reset: 0,
          status: "allowed",
          probedAt: FIXED_NOW_SEC - 1000,
        }),
      );
      // Backdate the file mtime to 600s before mocked now (> ttlSec=60).
      const oldTime = new Date(FIXED_NOW_MS - 600_000);
      await utimes(cachePath, oldTime, oldTime);

      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        ttlSec: 60, // shorter than backdate
      });
      expect(r.source).toBe("probe");
      expect(r.h5_pct_used).toBe(5);
      expect(server.probeCalls()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("force=true skips cache even when fresh", async () => {
    const server = startProbeServer({
      utilization5h: 0.1,
      utilization7d: 0.2,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud");
      const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({
          h5_util: 0.99,
          wk_util: 0.99,
          h5_reset: 0,
          wk_reset: 0,
          status: "allowed",
          probedAt: FIXED_NOW_SEC,
        }),
      );
      const fresh = new Date(FIXED_NOW_MS - 1_000); // fresh enough to hit
      await utimes(cachePath, fresh, fresh);

      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        force: true,
      });
      expect(r.source).toBe("probe");
      expect(r.h5_pct_used).toBe(10); // fresh probe, not 99 from cache
      expect(server.probeCalls()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("corrupt cache JSON → treat as miss + live probe", async () => {
    const server = startProbeServer({
      utilization5h: 0.07,
      utilization7d: 0.13,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud");
      const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      await writeFile(cachePath, "not json{");
      // Align mtime to mocked now so we reach the JSON.parse step
      // rather than short-circuiting on the staleness check.
      const fresh = new Date(FIXED_NOW_MS - 1_000);
      await utimes(cachePath, fresh, fresh);

      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });
      expect(r.source).toBe("probe");
      expect(r.h5_pct_used).toBe(7);
    } finally {
      await server.stop();
    }
  });

  test("cache JSON missing required fields → treat as miss + live probe", async () => {
    // Hits the !isCacheJson(cache) branch — JSON parses but shape is wrong.
    const server = startProbeServer({
      utilization5h: 0.04,
      utilization7d: 0.06,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud");
      const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ unrelated: "shape" }));
      const fresh = new Date(FIXED_NOW_MS - 1_000);
      await utimes(cachePath, fresh, fresh);

      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });
      expect(r.source).toBe("probe");
    } finally {
      await server.stop();
    }
  });

  test("cache hit with cached status=probe-401 normalizes to probe-401 enum", async () => {
    const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        h5_util: 0,
        wk_util: 0,
        h5_reset: 0,
        wk_reset: 0,
        status: "probe-401",
        probedAt: FIXED_NOW_SEC,
      }),
    );
    const fresh = new Date(FIXED_NOW_MS - 1_000);
    await utimes(cachePath, fresh, fresh);

    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.source).toBe("cache-hit");
    expect(r.status).toBe("probe-401");
  });

  test("cache hit with status=unknown (bash legacy) collapses to probe-error", async () => {
    const cachePath = join(atmuxDir, "state", "budget-probe-icloud.json");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        h5_util: 0.02,
        wk_util: 0.03,
        h5_reset: 0,
        wk_reset: 0,
        status: "unknown",
        probedAt: FIXED_NOW_SEC,
      }),
    );
    const fresh = new Date(FIXED_NOW_MS - 1_000);
    await utimes(cachePath, fresh, fresh);

    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.status).toBe("probe-error");
  });

  test("cache hit with status=rejected, probe-error, no-credentials each round-trip", async () => {
    for (const cached of ["rejected", "probe-error", "no-credentials"] as const) {
      const cachePath = join(atmuxDir, "state", `budget-probe-acc-${cached}.json`);
      await mkdir(join(atmuxDir, "state"), { recursive: true });
      await writeFile(
        cachePath,
        JSON.stringify({
          h5_util: 0,
          wk_util: 0,
          h5_reset: 0,
          wk_reset: 0,
          status: cached,
          probedAt: FIXED_NOW_SEC,
        }),
      );
      const fresh = new Date(FIXED_NOW_MS - 1_000);
      await utimes(cachePath, fresh, fresh);

      const r = await probeBudget(`acc-${cached}`, {
        atmuxDir,
        homeDir,
        probeUrl: "http://127.0.0.1:1/never",
        oauthRefreshUrl: "http://127.0.0.1:1/never",
      });
      expect(r.status).toBe(cached);
    }
  });
});

// ---------- Live probe happy path ----------

describe("probeBudget — live probe", () => {
  test("happy path: parses headers + writes bash-compatible cache + appends history", async () => {
    const server = startProbeServer({
      utilization5h: 0.12,
      utilization7d: 0.34,
      reset5h: FIXED_NOW_SEC + 3600,
      reset7d: FIXED_NOW_SEC + 7 * 86400,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud");
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });

      expect(r.account).toBe("icloud");
      expect(r.h5_pct_used).toBe(12);
      expect(r.wk_pct_used).toBe(34);
      expect(r.h5_reset_epoch).toBe(FIXED_NOW_SEC + 3600);
      expect(r.wk_reset_epoch).toBe(FIXED_NOW_SEC + 7 * 86400);
      expect(r.status).toBe("allowed");
      expect(r.source).toBe("probe");
      expect(r.probedAt).toBe(FIXED_NOW_SEC);

      // Cache file shape matches bash byte-for-byte.
      const cacheText = await readFile(join(atmuxDir, "state", "budget-probe-icloud.json"), "utf8");
      const cache = JSON.parse(cacheText);
      expect(cache).toEqual({
        h5_util: 0.12,
        wk_util: 0.34,
        h5_reset: FIXED_NOW_SEC + 3600,
        wk_reset: FIXED_NOW_SEC + 7 * 86400,
        status: "allowed",
        probedAt: FIXED_NOW_SEC,
      });

      // History line appended.
      const lines = await readHistoryLines();
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatchObject({
        account: "icloud",
        h5_util: 0.12,
        wk_util: 0.34,
        status: "allowed",
        source: "probe",
        tokenRefreshed: false,
      });
    } finally {
      await server.stop();
    }
  });

  test("rejected status header propagates to result + cache", async () => {
    const server = startProbeServer({
      utilization5h: 0.95,
      utilization7d: 0.99,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "rejected",
    });
    try {
      await writeCreds("icloud");
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });
      expect(r.status).toBe("rejected");
      expect(r.h5_pct_used).toBe(95);
    } finally {
      await server.stop();
    }
  });

  test("missing utilization headers → status=probe-error, still writes cache + history", async () => {
    const server = startProbeServer({
      // Omit util headers — server returns 200 but no rate-limit info.
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud");
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });
      expect(r.status).toBe("probe-error");
      expect(r.error).toContain("missing utilization headers");
      const lines = await readHistoryLines();
      expect(lines.length).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("non-2xx status → status=probe-error", async () => {
    const server = startProbeServer({ forceStatusCode: 503 });
    try {
      await writeCreds("icloud");
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });
      expect(r.status).toBe("probe-error");
      expect(r.error).toContain("HTTP 503");
    } finally {
      await server.stop();
    }
  });

  test("network failure (unreachable host) → status=probe-error", async () => {
    await writeCreds("icloud");
    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.status).toBe("probe-error");
    expect(r.error).toContain("HTTP 0");
  });
});

// ---------- OAuth refresh — Fix C ----------

describe("probeBudget — OAuth refresh (Fix C)", () => {
  test("near-expiry expiresAt → refresh fires + probe uses new token + tokenRefreshed=true", async () => {
    const server = startProbeServer({
      utilization5h: 0.05,
      utilization7d: 0.1,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      const credsPath = await writeCreds("icloud", {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: FIXED_NOW_MS + 30_000, // < now + 60s margin
      });

      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        // ADR-078 — opt-in to Fix-C OAuth refresh path. This test pins
        // the daemon-on-flag contract; the default-off contract is
        // pinned by the "refreshOnNearExpiry default-off" test below.
        refreshOnNearExpiry: true,
      });
      expect(r.status).toBe("allowed");
      expect(server.refreshCalls()).toBe(1);
      expect(server.lastRefreshToken()).toBe("old-refresh");
      expect(server.probeCalls()).toBe(1);

      // Credentials file atomically overwritten with new tokens.
      const updated = JSON.parse(await readFile(credsPath, "utf8"));
      expect(updated.claudeAiOauth.accessToken).toBe("fresh-access-token");
      expect(updated.claudeAiOauth.refreshToken).toBe("fresh-refresh-token");
      expect(typeof updated.claudeAiOauth.expiresAt).toBe("number");

      // History records tokenRefreshed=true.
      const lines = await readHistoryLines();
      expect(lines[0]).toMatchObject({ tokenRefreshed: true });
    } finally {
      await server.stop();
    }
  });

  test("future expiresAt → no refresh, direct probe", async () => {
    const server = startProbeServer({
      utilization5h: 0.05,
      utilization7d: 0.1,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      await writeCreds("icloud", {
        expiresAt: FIXED_NOW_MS + 86_400_000, // 24h in future
      });
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });
      expect(r.status).toBe("allowed");
      expect(server.refreshCalls()).toBe(0);
      expect(server.probeCalls()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("near-expiry + missing refreshToken → status=probe-401 + flag surfaced", async () => {
    const flagsCalled: Array<{ msg: string; account: string }> = [];
    await writeCreds("icloud", {
      refreshToken: "",
      expiresAt: FIXED_NOW_MS + 30_000,
    });
    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
      // ADR-078 — opt-in so Branch 1 fires on near-expiry.
      refreshOnNearExpiry: true,
      flagSurface: async (msg, account) => {
        flagsCalled.push({ msg, account });
      },
    });
    expect(r.status).toBe("probe-401");
    expect(r.error).toContain("no refreshToken");
    expect(flagsCalled.length).toBe(1);
    expect(flagsCalled[0]?.account).toBe("icloud");
    // Cache + history written even on failure.
    expect(await readHistoryLines()).toHaveLength(1);
  });

  test("refresh endpoint returns 401 → status=probe-401 + flag surfaced", async () => {
    const flagsCalled: string[] = [];
    const server = startProbeServer();
    server.setRefreshResponse({ status: 401 });
    try {
      await writeCreds("icloud", {
        expiresAt: FIXED_NOW_MS + 30_000,
      });
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        // ADR-078 — opt-in so refresh actually fires.
        refreshOnNearExpiry: true,
        flagSurface: async (msg) => {
          flagsCalled.push(msg);
        },
      });
      expect(r.status).toBe("probe-401");
      expect(flagsCalled.length).toBe(1);
      expect(flagsCalled[0]).toContain("OAuth refresh failed");
    } finally {
      await server.stop();
    }
  });

  test("refresh returns malformed body → status=probe-401 + flag surfaced", async () => {
    const flagsCalled: string[] = [];
    const server = startProbeServer();
    server.setRefreshResponse({ status: 200 }); // omits access_token
    try {
      await writeCreds("icloud", {
        expiresAt: FIXED_NOW_MS + 30_000,
      });
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        // ADR-078 — opt-in so refresh fires.
        refreshOnNearExpiry: true,
        flagSurface: async (msg) => {
          flagsCalled.push(msg);
        },
      });
      expect(r.status).toBe("probe-401");
      expect(flagsCalled.length).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

// ---------- 401 retry (Fix C continuation) ----------

describe("probeBudget — 401 retry", () => {
  test("probe 401 → force-refresh + retry probe → success", async () => {
    const server = startProbeServer({
      utilization5h: 0.05,
      utilization7d: 0.1,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
      failFirstWith401: true,
    });
    try {
      await writeCreds("icloud"); // expiresAt far future, so no pre-refresh
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        // ADR-078 — opt-in so the 401-retry refresh fires (Branch 2).
        refreshOnNearExpiry: true,
      });
      expect(r.status).toBe("allowed");
      expect(server.probeCalls()).toBe(2); // first 401 + retry
      expect(server.refreshCalls()).toBe(1); // forced once
      const lines = await readHistoryLines();
      expect(lines[0]).toMatchObject({ tokenRefreshed: true });
    } finally {
      await server.stop();
    }
  });

  test("probe 401 + refresh 401 → status=probe-401, no infinite loop", async () => {
    const flagsCalled: string[] = [];
    const server = startProbeServer({ failFirstWith401: true });
    server.setRefreshResponse({ status: 401 });
    try {
      await writeCreds("icloud");
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        // ADR-078 — opt-in so the 401-retry refresh fires (Branch 2).
        refreshOnNearExpiry: true,
        flagSurface: async (msg) => {
          flagsCalled.push(msg);
        },
      });
      expect(r.status).toBe("probe-401");
      expect(flagsCalled.length).toBe(1);
      expect(server.probeCalls()).toBe(1); // bailed before retry
      expect(server.refreshCalls()).toBe(1); // tried once, gave up
    } finally {
      await server.stop();
    }
  });

  test("probe 401 → refresh succeeds → re-probe ALSO 401 → status=probe-401", async () => {
    // Server always 401's the probe regardless of token. Refresh succeeds.
    // The retry path runs once (tokenRefreshed=true after first refresh),
    // re-probe still 401 → no further refresh, finalize as probe-401.
    let probeCallCount = 0;
    let refreshCallCount = 0;
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          refreshCallCount += 1;
          return new Response(
            JSON.stringify({ access_token: "fresh", refresh_token: "fresh-r", expires_in: 86400 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.pathname === "/messages") {
          probeCallCount += 1;
          return new Response("", { status: 401 });
        }
        return new Response("", { status: 404 });
      },
    });
    try {
      await writeCreds("icloud");
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: `http://localhost:${srv.port}/messages`,
        oauthRefreshUrl: `http://localhost:${srv.port}/oauth/token`,
        // ADR-078 — opt-in so the 401-retry refresh fires (Branch 2).
        refreshOnNearExpiry: true,
      });
      expect(r.status).toBe("probe-401");
      expect(probeCallCount).toBe(2); // first + retry
      expect(refreshCallCount).toBe(1); // single refresh between
    } finally {
      await srv.stop(true);
    }
  });

  test("refresh response with non-JSON body → returns null + flag surfaced", async () => {
    const flagsCalled: string[] = [];
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          // 200 status but body is not JSON — JSON.parse throws.
          return new Response("not-json{garbage", { status: 200 });
        }
        return new Response("", { status: 404 });
      },
    });
    try {
      await writeCreds("icloud", { expiresAt: FIXED_NOW_MS + 30_000 });
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: `http://localhost:${srv.port}/messages`,
        oauthRefreshUrl: `http://localhost:${srv.port}/oauth/token`,
        // ADR-078 — opt-in so Branch 1 (near-expiry refresh) fires.
        refreshOnNearExpiry: true,
        flagSurface: async (msg) => {
          flagsCalled.push(msg);
        },
      });
      expect(r.status).toBe("probe-401");
      expect(flagsCalled.length).toBe(1);
    } finally {
      await srv.stop(true);
    }
  });
});

// ---------- no-credentials surface ----------

describe("probeBudget — no-credentials", () => {
  test("missing credentials file → no-credentials", async () => {
    const r = await probeBudget("nonexistent", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.status).toBe("no-credentials");
    expect(r.error).toContain("credentials missing at");
  });

  test("malformed credentials JSON → no-credentials", async () => {
    const dir = join(homeDir, ".claude-icloud");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".credentials.json"), "not json{");

    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.status).toBe("no-credentials");
    expect(r.error).toContain("malformed");
  });

  test("credentials file missing accessToken → no-credentials", async () => {
    await writeCreds("icloud", { accessToken: "" });
    const r = await probeBudget("icloud", {
      atmuxDir,
      homeDir,
      probeUrl: "http://127.0.0.1:1/never",
      oauthRefreshUrl: "http://127.0.0.1:1/never",
    });
    expect(r.status).toBe("no-credentials");
    expect(r.error).toContain("missing claudeAiOauth.accessToken");
  });
});

// ---------- Default flag-surface helper ----------

describe("probeBudget — default flag-surface helper", () => {
  test("default flagSurface (no opts.flagSurface) does not throw + spawn-failure swallowed", async () => {
    // No flagSurface override → default helper attempts spawn of the
    // bash atmux CLI. File-scope `beforeAll` neuters PATH so the spawn
    // fail-to-finds; the catch block must swallow the error and still
    // surface probe-401 cleanly. Without the PATH override this test
    // would pollute the worktree's real .atmux/flags.md (t-3460d587).
    const credsResult = async (): Promise<BudgetProbeResult> => {
      const server = startProbeServer();
      server.setRefreshResponse({ status: 401 });
      await writeCreds("icloud", { expiresAt: FIXED_NOW_MS + 30_000 });
      try {
        const r = await probeBudget("icloud", {
          atmuxDir,
          homeDir,
          probeUrl: server.url,
          oauthRefreshUrl: server.refreshUrl,
          // ADR-078 — opt-in so Branch 1 fires + the refresh-401 path
          // exercises defaultFlagSurface.
          refreshOnNearExpiry: true,
        });
        return r;
      } finally {
        await server.stop();
      }
    };
    const r = await credsResult();
    expect(r.status).toBe("probe-401");
  });
});

// ---------- ADR-078: refreshOnNearExpiry opt-in ----------
//
// Pins the default-off contract so spawn-time / one-shot probes
// (cockpit, account-swap) cannot rotate refreshTokens behind a TUI's
// back. The opt-in path is regression-pinned in the `Fix C` describe
// block above (every refresh-firing test now passes the explicit
// `refreshOnNearExpiry: true`).

describe("probeBudget — ADR-078 refreshOnNearExpiry gate", () => {
  test("default-off: near-expiry token does NOT trigger refresh", async () => {
    const server = startProbeServer({
      utilization5h: 0.05,
      utilization7d: 0.1,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      const credsPath = await writeCreds("icloud", {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: FIXED_NOW_MS + 30_000, // < now + 60s margin (near-expiry)
      });

      // No refreshOnNearExpiry flag → Branch 1 must NOT fire.
      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
      });

      // Probe runs with the OLD accessToken; server returns 200/allowed.
      expect(r.status).toBe("allowed");
      // Refresh endpoint NEVER touched — this is the structural fix.
      expect(server.refreshCalls()).toBe(0);
      expect(server.probeCalls()).toBe(1);

      // Credentials file untouched — no rotation, no race against TUIs.
      const stored = JSON.parse(await readFile(credsPath, "utf8"));
      expect(stored.claudeAiOauth.accessToken).toBe("old-token");
      expect(stored.claudeAiOauth.refreshToken).toBe("old-refresh");

      // History records tokenRefreshed=false.
      const lines = await readHistoryLines();
      expect(lines[0]).toMatchObject({ tokenRefreshed: false });
    } finally {
      await server.stop();
    }
  });

  test("opt-in: near-expiry token triggers refresh + persists tokens", async () => {
    // Regression-pin of the existing Fix-C behaviour with the explicit
    // ADR-078 flag. Mirror of the legacy "near-expiry → refresh fires"
    // test, hoisted here so the gate semantics live next to each other.
    const server = startProbeServer({
      utilization5h: 0.05,
      utilization7d: 0.1,
      reset5h: 0,
      reset7d: 0,
      statusHeader: "allowed",
    });
    try {
      const credsPath = await writeCreds("icloud", {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: FIXED_NOW_MS + 30_000,
      });

      const r = await probeBudget("icloud", {
        atmuxDir,
        homeDir,
        probeUrl: server.url,
        oauthRefreshUrl: server.refreshUrl,
        refreshOnNearExpiry: true,
      });

      expect(r.status).toBe("allowed");
      expect(server.refreshCalls()).toBe(1);
      expect(server.lastRefreshToken()).toBe("old-refresh");

      const updated = JSON.parse(await readFile(credsPath, "utf8"));
      expect(updated.claudeAiOauth.accessToken).toBe("fresh-access-token");
      expect(updated.claudeAiOauth.refreshToken).toBe("fresh-refresh-token");

      const lines = await readHistoryLines();
      expect(lines[0]).toMatchObject({ tokenRefreshed: true });
    } finally {
      await server.stop();
    }
  });

  test("401 retry path also gated by the flag (Branch 2)", async () => {
    // Setup: token is NOT near-expiry (24h future), so Branch 1 is
    // dormant for both calls. Probe upstream always returns 401 →
    // Branch 2 is the only refresh path under test.

    // Call A — default off → no refresh, single 401, status=probe-401.
    {
      const server = startProbeServer({ failFirstWith401: true });
      try {
        await writeCreds("icloud"); // far-future expiresAt
        const r = await probeBudget("icloud", {
          atmuxDir,
          homeDir,
          probeUrl: server.url,
          oauthRefreshUrl: server.refreshUrl,
          // No flag → Branch 2 must NOT fire.
        });
        expect(r.status).toBe("probe-401");
        expect(server.refreshCalls()).toBe(0); // gate held
        expect(server.probeCalls()).toBe(1); // no retry
      } finally {
        await server.stop();
      }
    }

    // Fresh sandbox needed since Call A wrote a (probe-401) cache that
    // would otherwise short-circuit Call B. Re-create.
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = await mkdtemp(join(tmpdir(), "atmux-budget-probe-"));
    homeDir = join(tmpRoot, "home");
    atmuxDir = join(tmpRoot, "project", ".atmux");
    await mkdir(homeDir, { recursive: true });
    await mkdir(atmuxDir, { recursive: true });

    // Call B — opt-in true → 401 + refresh + retry succeeds.
    {
      const server = startProbeServer({
        utilization5h: 0.05,
        utilization7d: 0.1,
        reset5h: 0,
        reset7d: 0,
        statusHeader: "allowed",
        failFirstWith401: true,
      });
      try {
        await writeCreds("icloud");
        const r = await probeBudget("icloud", {
          atmuxDir,
          homeDir,
          probeUrl: server.url,
          oauthRefreshUrl: server.refreshUrl,
          refreshOnNearExpiry: true,
        });
        expect(r.status).toBe("allowed");
        expect(server.refreshCalls()).toBe(1); // single retry refresh
        expect(server.probeCalls()).toBe(2); // first 401 + retry
      } finally {
        await server.stop();
      }
    }
  });
});

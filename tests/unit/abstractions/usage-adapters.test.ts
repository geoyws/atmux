// Unit tests for e-50 T3 usage adapters (t-25764270):
//   - normalize* map recorded provider payloads to the metric vocab
//   - probes never throw: missing keys / bad shapes / request failures
//     become ok=0 rows
//   - probeAllProviders aggregates without throwing (stubbed request)
//
// Fixtures mirror docs/briefs/budget-tracker-discovery.md shapes. No
// network: every probe test injects a stub `request` or empty env.

import { describe, expect, test } from "bun:test";
import {
  normalizeCursor,
  normalizeDeepSeek,
  normalizeKimi,
  normalizeMinimax,
  normalizeOpenRouter,
  normalizeZai,
  probeAllProviders,
  probeCursor,
  probeDeepSeek,
  probeKimi,
  probeMinimax,
  probeOpenRouter,
  probeZai,
  type AdapterCtx,
  type UsageRow,
} from "../../../src/abstractions/usage-adapters.ts";
import type { HttpRequestOpts, HttpResponse } from "../../../src/abstractions/http.ts";

function stubRequest(body: unknown, status = 200): (opts: HttpRequestOpts) => Promise<HttpResponse> {
  return async () =>
    ({
      url: "https://stub",
      method: "GET",
      status,
      statusText: "OK",
      headers: new Headers(),
      body: typeof body === "string" ? body : JSON.stringify(body),
      bytes: new Uint8Array(),
      durationMs: 1,
    }) as HttpResponse;
}

function failingRequest(message: string): (opts: HttpRequestOpts) => Promise<HttpResponse> {
  return async () => {
    throw new Error(message);
  };
}

function rowsFor(rows: UsageRow[], provider: string, account: string): Record<string, UsageRow> {
  const out: Record<string, UsageRow> = {};
  for (const r of rows) {
    if (r.provider === provider && r.account === account) out[r.metric] = r;
  }
  return out;
}

describe("normalizeZai", () => {
  // Live shape (captured 2026-09-26): CREDIT_LIMIT entries.
  const body = {
    data: {
      level: "max",
      limits: [
        { type: "CREDIT_LIMIT", percentage: 30, nextResetTime: 1785500000000 },
        { type: "CREDIT_LIMIT", percentage: 6, nextResetTime: 1785600000000 },
      ],
    },
  };

  test("plan tier + 5h/weekly split by reset order", () => {
    const m = rowsFor(normalizeZai(body, "zai"), "zai", "zai");
    expect(m.plan_tier?.valueText).toBe("max");
    expect(m.util_5h?.value).toBe(30);
    expect(m.util_weekly?.value).toBe(6);
    expect(m.reset_5h?.unit).toBe("epoch_ms");
    expect(m.reset_weekly?.value).toBe(1785600000000);
  });

  test("garbage body → no rows (never throws)", () => {
    expect(normalizeZai(null, "zai")).toEqual([]);
    expect(normalizeZai({ data: null }, "zai")).toEqual([]);
  });
});

describe("normalizeDeepSeek", () => {
  test("balance + status rows", () => {
    const m = rowsFor(
      normalizeDeepSeek({ balance_infos: [{ total_balance: 7.25, is_available: true }] }, "deepseek"),
      "deepseek",
      "deepseek",
    );
    expect(m.balance_usd?.value).toBe(7.25);
    expect(m.balance_usd?.unit).toBe("usd");
    expect(m.status?.valueText).toBe("available");
  });

  test("missing infos → ok=0 row", () => {
    const rows = normalizeDeepSeek({}, "deepseek");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(0);
  });
});

describe("normalizeOpenRouter", () => {
  test("credits + usage rows", () => {
    const m = rowsFor(
      normalizeOpenRouter({ data: { total_credits: 50, total_usage: 17.5 } }, "openrouter"),
      "openrouter",
      "openrouter",
    );
    expect(m.credits_usd?.value).toBe(50);
    expect(m.usage_usd?.value).toBe(17.5);
  });
});

describe("normalizeMinimax", () => {
  test("remaining% inverts to util%; resets + request counts", () => {
    const m = rowsFor(
      normalizeMinimax(
        {
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 80,
              current_weekly_remaining_percent: 60,
              end_time: 1785500000000,
              weekly_end_time: 1785600000000,
              current_interval_usage_count: 200,
              current_interval_total_count: 1000,
            },
          ],
        },
        "minimax",
      ),
      "minimax",
      "minimax",
    );
    expect(m.util_5h?.value).toBe(20);
    expect(m.util_weekly?.value).toBe(40);
    expect(m.reset_5h?.unit).toBe("epoch_ms");
    expect(m.requests_used?.value).toBe(200);
    expect(m.requests_limit?.value).toBe(1000);
  });

  test("missing general entry → ok=0", () => {
    expect(normalizeMinimax({ model_remains: [] }, "minimax")[0]?.ok).toBe(0);
  });
});

describe("normalizeKimi", () => {
  test("weekly pct + iso reset + 5h detail", () => {
    const m = rowsFor(
      normalizeKimi(
        {
          usage: { used: 30, limit: 100, remaining: 70, resetTime: "2026-08-01T00:00:00Z" },
          limits: [{ detail: { used: 12 } }],
        },
        "kimi",
      ),
      "kimi",
      "kimi",
    );
    expect(m.util_weekly?.value).toBeCloseTo(30);
    expect(m.reset_weekly?.valueText).toBe("2026-08-01T00:00:00Z");
    expect(m.reset_weekly?.unit).toBe("iso8601");
    expect(m.util_5h?.value).toBe(12);
  });

  test("non-object → no rows", () => {
    expect(normalizeKimi(null, "kimi")).toEqual([]);
  });
});

describe("normalizeCursor", () => {
  test("request/token/balance rows", () => {
    const m = rowsFor(
      normalizeCursor(
        { "gpt-4": { numRequests: 400, maxRequestUsage: 500, numTokens: 123456 }, customerBalance: 3.5 },
        "cursor",
      ),
      "cursor",
      "cursor",
    );
    expect(m.requests_used?.value).toBe(400);
    expect(m.requests_limit?.value).toBe(500);
    expect(m.tokens_used?.value).toBe(123456);
    expect(m.balance_usd?.value).toBe(3.5);
  });
});

describe("probe key absence", () => {
  const empty: AdapterCtx = { env: {} };

  test("zai/deepseek/openrouter/minimax without keys → ok=0, never throws", async () => {
    for (const run of [
      () => probeZai(empty),
      () => probeDeepSeek(empty),
      () => probeOpenRouter(empty),
      () => probeMinimax(empty),
    ]) {
      const rows = await run();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.ok).toBe(0);
    }
  });

  test("request failure → ok=0", async () => {
    const ctx: AdapterCtx = { env: { ZAI_API_KEY: "x" }, request: failingRequest("boom") };
    const rows = await probeZai(ctx);
    expect(rows[0]?.ok).toBe(0);
    expect(rows[0]?.error).toContain("boom");
  });

  test("live-shape end-to-end via stub (zai)", async () => {
    const ctx: AdapterCtx = {
      env: { ZAI_API_KEY: "x" },
      request: stubRequest({ data: { level: "pro", limits: [] } }),
    };
    const m = rowsFor(await probeZai(ctx), "zai", "zai");
    expect(m.plan_tier?.valueText).toBe("pro");
  });

  test("kimi without token files → ok=0", async () => {
    const rows = await probeKimi({ env: {}, homeDir: "/nonexistent-home-xyz" });
    expect(rows[0]?.ok).toBe(0);
  });

  test("cursor always ok=0 with the non-interactive reason", async () => {
    const rows = await probeCursor({ env: {} });
    expect(rows[0]?.ok).toBe(0);
    expect(rows[0]?.error).toContain("agent.db");
  });
});

describe("probeAllProviders", () => {
  test("aggregates every provider without throwing on empty env", async () => {
    const rows = await probeAllProviders({ env: {} });
    const providers = new Set(rows.map((r) => `${r.provider}:${r.account}`));
    for (const key of [
      "anthropic:gmail",
      "anthropic:ifca2",
      "zai:zai",
      "deepseek:deepseek",
      "deepseek:deepseek-ifca",
      "openrouter:openrouter",
      "minimax:minimax",
      "minimax:minimax-ifca",
      "kimi:kimi",
      "cursor:cursor",
    ]) {
      expect(providers.has(key)).toBe(true);
    }
  });
});

// e-50 T3 (t-25764270): multi-provider usage adapters.
//
// One normalized row-set per provider per docs/briefs/budget-tracker.md
// §Provider adapters. Each adapter NEVER throws: any failure (network,
// auth, shape drift) becomes `ok=0` rows with `error` — the batch must
// not abort (kimi/cursor are best-effort by design). Keys come from
// `ctx.env` by variable name, never hardcoded.
//
// Pure `normalize*` functions take parsed response bodies so unit tests
// feed recorded fixtures without network. Live `probe*` functions wrap
// fetch + normalize + catch-all.

import { readTextOrNull } from "./fs.ts";
import { request as defaultRequest, type HttpRequestOpts, type HttpResponse } from "./http.ts";
import { probeBudget } from "./budget-probe.ts";

export type UsageUnit =
  | "pct"
  | "usd"
  | "tokens"
  | "requests"
  | "epoch_s"
  | "epoch_ms"
  | "iso8601"
  | "enum";

export interface UsageRow {
  provider: string;
  account: string;
  metric: string;
  value: number | null;
  valueText: string | null;
  unit: UsageUnit;
  ok: 0 | 1;
  error: string | null;
}

export interface AdapterCtx {
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  request?: (opts: HttpRequestOpts) => Promise<HttpResponse>;
}

type RequestFn = (opts: HttpRequestOpts) => Promise<HttpResponse>;

function failRow(provider: string, account: string, error: string): UsageRow[] {
  return [
    {
      provider,
      account,
      metric: "status",
      value: null,
      valueText: "error",
      unit: "enum",
      ok: 0,
      error,
    },
  ];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// ---------- anthropic (budget-probe reuse) ----------

const ANTHROPIC_SUFFIXES: ReadonlyArray<{ suffix: string; account: string }> = [
  { suffix: "gmail", account: "gmail" },
  { suffix: "ifca2", account: "ifca2" },
];

export async function probeAnthropic(ctx: AdapterCtx): Promise<UsageRow[]> {
  const out: UsageRow[] = [];
  for (const { suffix, account } of ANTHROPIC_SUFFIXES) {
    try {
      const r = await probeBudget(suffix, {
        ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
        force: true,
        flagSurface: async () => {},
      });
      if (r.status !== "allowed") {
        out.push(...failRow("anthropic", account, r.error ?? r.status));
        continue;
      }
      out.push(
        { provider: "anthropic", account, metric: "util_5h", value: r.h5_pct_used, valueText: null, unit: "pct", ok: 1, error: null },
        { provider: "anthropic", account, metric: "util_weekly", value: r.wk_pct_used, valueText: null, unit: "pct", ok: 1, error: null },
        { provider: "anthropic", account, metric: "reset_5h", value: r.h5_reset_epoch, valueText: null, unit: "epoch_s", ok: 1, error: null },
        { provider: "anthropic", account, metric: "reset_weekly", value: r.wk_reset_epoch, valueText: null, unit: "epoch_s", ok: 1, error: null },
        { provider: "anthropic", account, metric: "status", value: null, valueText: "allowed", unit: "enum", ok: 1, error: null },
      );
    } catch (e) {
      out.push(...failRow("anthropic", account, e instanceof Error ? e.message : String(e)));
    }
  }
  return out;
}

// ---------- z.ai ----------

export function normalizeZai(body: unknown, account: string): UsageRow[] {
  const out: UsageRow[] = [];
  const root = body !== null && typeof body === "object" && "data" in body &&
      body.data !== null && typeof body.data === "object"
    ? (body.data as Record<string, unknown>)
    : null;
  const level = root !== null ? str(root.level) : null;
  if (level !== null) {
    out.push({ provider: "zai", account, metric: "plan_tier", value: null, valueText: level, unit: "enum", ok: 1, error: null });
  }
  const limitsRaw = root !== null && "limits" in root ? root.limits : undefined;
  const limits = Array.isArray(limitsRaw)
    ? limitsRaw.filter((l): l is Record<string, unknown> => l !== null && typeof l === "object")
    : [];
  // Live shape (verified 2026-09-26): CREDIT_LIMIT entries with
  // `percentage` (used pct) + `nextResetTime`; two entries sorted by
  // reset = 5h + weekly. Filter to entries carrying a percentage.
  const usable = limits
    .filter((l) => num(l.percentage) !== null && num(l.nextResetTime) !== null)
    .sort((a, b) => (num(a.nextResetTime) ?? 0) - (num(b.nextResetTime) ?? 0));
  const [first, second] = [usable[0], usable[1]];
  const emit = (entry: Record<string, unknown> | undefined, prefix: "util_5h" | "util_weekly", resetMetric: "reset_5h" | "reset_weekly") => {
    if (entry === undefined) return;
    const used = num(entry.percentage);
    if (used !== null) {
      out.push({ provider: "zai", account, metric: prefix, value: used, valueText: null, unit: "pct", ok: 1, error: null });
    }
    const reset = num(entry.nextResetTime);
    if (reset !== null) {
      out.push({ provider: "zai", account, metric: resetMetric, value: reset, valueText: null, unit: "epoch_ms", ok: 1, error: null });
    }
  };
  emit(first, "util_5h", "reset_5h");
  emit(second, "util_weekly", "reset_weekly");
  return out;
}

export async function probeZai(ctx: AdapterCtx): Promise<UsageRow[]> {
  const request: RequestFn = ctx.request ?? defaultRequest;
  const key = ctx.env.ZAI_API_KEY;
  if (key === undefined || key.length === 0) return failRow("zai", "zai", "ZAI_API_KEY unset");
  try {
    const res = await request({
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      headers: { Authorization: `Bearer ${key}` },
    });
    return normalizeZai(JSON.parse(res.body) as unknown, "zai");
  } catch (e) {
    return failRow("zai", "zai", e instanceof Error ? e.message : String(e));
  }
}

// ---------- deepseek ----------

export function normalizeDeepSeek(body: unknown, account: string): UsageRow[] {
  const infos = body !== null && typeof body === "object" && "balance_infos" in body
    ? body.balance_infos
    : undefined;
  const info = Array.isArray(infos) && infos[0] !== null && typeof infos[0] === "object"
    ? (infos[0] as Record<string, unknown>)
    : undefined;
  if (info === undefined) return failRow("deepseek", account, "missing balance_infos[0]");
  const out: UsageRow[] = [];
  const balance = num(info.total_balance);
  if (balance !== null) {
    out.push({ provider: "deepseek", account, metric: "balance_usd", value: balance, valueText: null, unit: "usd", ok: 1, error: null });
  }
  const avail = info.is_available;
  out.push({
    provider: "deepseek", account, metric: "status",
    value: null, valueText: typeof avail === "boolean" ? (avail ? "available" : "unavailable") : "unknown",
    unit: "enum", ok: 1, error: null,
  });
  return out;
}

export async function probeDeepSeek(
  ctx: AdapterCtx,
  account: "deepseek" | "deepseek-ifca" = "deepseek",
): Promise<UsageRow[]> {
  const request: RequestFn = ctx.request ?? defaultRequest;
  const key = account === "deepseek" ? ctx.env.DEEPSEEK_API_KEY : ctx.env.DEEPSEEK_API_KEY_IFCA;
  if (key === undefined || key.length === 0) {
    return failRow("deepseek", account, `${account === "deepseek" ? "DEEPSEEK_API_KEY" : "DEEPSEEK_API_KEY_IFCA"} unset`);
  }
  try {
    const res = await request({
      url: "https://api.deepseek.com/user/balance",
      headers: { Authorization: `Bearer ${key}` },
    });
    return normalizeDeepSeek(JSON.parse(res.body) as unknown, account);
  } catch (e) {
    return failRow("deepseek", account, e instanceof Error ? e.message : String(e));
  }
}

// ---------- openrouter ----------

export function normalizeOpenRouter(body: unknown, account: string): UsageRow[] {
  const data = body !== null && typeof body === "object" && "data" in body &&
      body.data !== null && typeof body.data === "object"
    ? (body.data as Record<string, unknown>)
    : null;
  const credits = data !== null ? num(data.total_credits) : null;
  const usage = data !== null ? num(data.total_usage) : null;
  const out: UsageRow[] = [];
  if (credits !== null) {
    out.push({ provider: "openrouter", account, metric: "credits_usd", value: credits, valueText: null, unit: "usd", ok: 1, error: null });
  }
  if (usage !== null) {
    out.push({ provider: "openrouter", account, metric: "usage_usd", value: usage, valueText: null, unit: "usd", ok: 1, error: null });
  }
  return out;
}

export async function probeOpenRouter(ctx: AdapterCtx): Promise<UsageRow[]> {
  const request: RequestFn = ctx.request ?? defaultRequest;
  const key = ctx.env.OPENROUTER_API_KEY;
  if (key === undefined || key.length === 0) return failRow("openrouter", "openrouter", "OPENROUTER_API_KEY unset");
  try {
    const res = await request({
      url: "https://openrouter.ai/api/v1/credits",
      headers: { Authorization: `Bearer ${key}` },
    });
    return normalizeOpenRouter(JSON.parse(res.body) as unknown, "openrouter");
  } catch (e) {
    return failRow("openrouter", "openrouter", e instanceof Error ? e.message : String(e));
  }
}

// ---------- minimax ----------

export function normalizeMinimax(body: unknown, account: string): UsageRow[] {
  const list = body !== null && typeof body === "object" && "model_remains" in body
    ? body.model_remains
    : undefined;
  const remains = Array.isArray(list)
    ? list.find((m): m is Record<string, unknown> =>
        m !== null && typeof m === "object" && "model_name" in m && m.model_name === "general")
    : undefined;
  if (remains === undefined) return failRow("minimax", account, "missing model_remains[general]");
  const out: UsageRow[] = [];
  // Live shape (verified 2026-09-26): remaining_percent → util% = 100 − remaining.
  const cur = num(remains.current_interval_remaining_percent);
  if (cur !== null) {
    out.push({ provider: "minimax", account, metric: "util_5h", value: 100 - cur, valueText: null, unit: "pct", ok: 1, error: null });
  }
  const weekly = num(remains.current_weekly_remaining_percent);
  if (weekly !== null) {
    out.push({ provider: "minimax", account, metric: "util_weekly", value: 100 - weekly, valueText: null, unit: "pct", ok: 1, error: null });
  }
  const endTime = num(remains.end_time);
  if (endTime !== null) {
    out.push({ provider: "minimax", account, metric: "reset_5h", value: endTime, valueText: null, unit: "epoch_ms", ok: 1, error: null });
  }
  const weeklyEnd = num(remains.weekly_end_time);
  if (weeklyEnd !== null) {
    out.push({ provider: "minimax", account, metric: "reset_weekly", value: weeklyEnd, valueText: null, unit: "epoch_ms", ok: 1, error: null });
  }
  const used = num(remains.current_interval_usage_count);
  const limit = num(remains.current_interval_total_count);
  if (used !== null) {
    out.push({ provider: "minimax", account, metric: "requests_used", value: used, valueText: null, unit: "requests", ok: 1, error: null });
  }
  if (limit !== null) {
    out.push({ provider: "minimax", account, metric: "requests_limit", value: limit, valueText: null, unit: "requests", ok: 1, error: null });
  }
  return out;
}

export async function probeMinimax(
  ctx: AdapterCtx,
  account: "minimax" | "minimax-ifca" = "minimax",
): Promise<UsageRow[]> {
  const request: RequestFn = ctx.request ?? defaultRequest;
  const key = account === "minimax" ? ctx.env.MINIMAX_API_KEY : ctx.env.MINIMAX_API_KEY_IFCA;
  if (key === undefined || key.length === 0) {
    return failRow("minimax", account, `${account === "minimax" ? "MINIMAX_API_KEY" : "MINIMAX_API_KEY_IFCA"} unset`);
  }
  try {
    const res = await request({
      url: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
      headers: { Authorization: `Bearer ${key}` },
    });
    return normalizeMinimax(JSON.parse(res.body) as unknown, account);
  } catch (e) {
    return failRow("minimax", account, e instanceof Error ? e.message : String(e));
  }
}

// ---------- kimi (best-effort) ----------

export function normalizeKimi(body: unknown, account: string): UsageRow[] {
  if (body === null || typeof body !== "object") return [];
  const out: UsageRow[] = [];
  const usage = "usage" in body && body.usage !== null && typeof body.usage === "object"
    ? (body.usage as Record<string, unknown>)
    : null;
  const used = usage !== null ? num(usage.used) : null;
  const limit = usage !== null ? num(usage.limit) : null;
  if (used !== null && limit !== null && limit !== 0) {
    out.push({ provider: "kimi", account, metric: "util_weekly", value: (used / limit) * 100, valueText: null, unit: "pct", ok: 1, error: null });
  }
  const reset = usage !== null ? str(usage.resetTime) : null;
  if (reset !== null) {
    out.push({ provider: "kimi", account, metric: "reset_weekly", value: null, valueText: reset, unit: "iso8601", ok: 1, error: null });
  }
  const limitsRaw = "limits" in body ? body.limits : undefined;
  const limits = Array.isArray(limitsRaw) ? limitsRaw : [];
  const first: unknown = limits[0];
  const detail = first !== null && typeof first === "object" && "detail" in first &&
      first.detail !== null && typeof first.detail === "object"
    ? (first.detail as Record<string, unknown>)
    : null;
  const used5h = detail !== null ? num(detail.used) : null;
  if (used5h !== null) {
    out.push({ provider: "kimi", account, metric: "util_5h", value: used5h, valueText: null, unit: "pct", ok: 1, error: null });
  }
  return out;
}

async function kimiToken(ctx: AdapterCtx): Promise<string | null> {
  // Live layout (verified 2026-09-26): ~/.kimi-code/oauth/kimi-code and
  // ~/.kimi-code/credentials/kimi-code.json (JSON with accessToken/token).
  for (const rel of ["oauth/kimi-code", "credentials/kimi-code.json"]) {
    let txt: string | null;
    try {
      txt = await readTextOrNull(joinKimiPath(ctx, rel));
    } catch {
      continue; // e.g. path is a directory — try the next candidate.
    }
    if (txt === null) continue;
    try {
      const parsed: unknown = JSON.parse(txt);
      if (parsed === null || typeof parsed !== "object") continue;
      const tok = ("accessToken" in parsed ? str(parsed.accessToken) : null) ??
        ("access_token" in parsed ? str(parsed.access_token) : null) ??
        ("token" in parsed ? str(parsed.token) : null);
      if (tok !== null) return tok;
    } catch {
      // Unparseable token file — try the next candidate path.
    }
  }
  return null;
}

function joinKimiPath(ctx: AdapterCtx, rel: string): string {
  const home = ctx.homeDir ?? ctx.env.HOME ?? "";
  return `${home}/.kimi-code/${rel}`;
}

export async function probeKimi(ctx: AdapterCtx): Promise<UsageRow[]> {
  const request: RequestFn = ctx.request ?? defaultRequest;
  try {
    const token = await kimiToken(ctx);
    if (token === null) return failRow("kimi", "kimi", "no kimi OAuth token under ~/.kimi-code");
    const res = await request({
      url: "https://api.kimi.com/coding/v1/usages",
      headers: { Authorization: `Bearer ${token}` },
    });
    return normalizeKimi(JSON.parse(res.body) as unknown, "kimi");
  } catch (e) {
    return failRow("kimi", "kimi", e instanceof Error ? e.message : String(e));
  }
}

// ---------- cursor (best-effort) ----------

export function normalizeCursor(body: unknown, account: string): UsageRow[] {
  const gpt4 = body !== null && typeof body === "object" && "gpt-4" in body &&
      body["gpt-4"] !== null && typeof body["gpt-4"] === "object"
    ? (body["gpt-4"] as Record<string, unknown>)
    : null;
  const out: UsageRow[] = [];
  const used = gpt4 !== null ? num(gpt4.numRequests) : null;
  if (used !== null) {
    out.push({ provider: "cursor", account, metric: "requests_used", value: used, valueText: null, unit: "requests", ok: 1, error: null });
  }
  const limit = gpt4 !== null ? num(gpt4.maxRequestUsage) : null;
  if (limit !== null) {
    out.push({ provider: "cursor", account, metric: "requests_limit", value: limit, valueText: null, unit: "requests", ok: 1, error: null });
  }
  const tokens = gpt4 !== null ? num(gpt4.numTokens) : null;
  if (tokens !== null) {
    out.push({ provider: "cursor", account, metric: "tokens_used", value: tokens, valueText: null, unit: "tokens", ok: 1, error: null });
  }
  const balance = body !== null && typeof body === "object" && "customerBalance" in body
    ? num(body.customerBalance)
    : null;
  if (balance !== null) {
    out.push({ provider: "cursor", account, metric: "balance_usd", value: balance, valueText: null, unit: "usd", ok: 1, error: null });
  }
  return out;
}

export async function probeCursor(_ctx: AdapterCtx): Promise<UsageRow[]> {
  return failRow("cursor", "cursor", "cursor usage API needs an interactive OAuth session (agent.db); no non-interactive credential — see KEYS.md");
}

// ---------- batch ----------

/** Run every adapter; never throws (each adapter is already catch-all,
 *  but the batch guards against adapter bugs too). */
export async function probeAllProviders(ctx: AdapterCtx): Promise<UsageRow[]> {
  const out: UsageRow[] = [];
  const adapters: ReadonlyArray<() => Promise<UsageRow[]>> = [
    () => probeAnthropic(ctx),
    () => probeZai(ctx),
    () => probeDeepSeek(ctx, "deepseek"),
    () => probeDeepSeek(ctx, "deepseek-ifca"),
    () => probeOpenRouter(ctx),
    () => probeMinimax(ctx, "minimax"),
    () => probeMinimax(ctx, "minimax-ifca"),
    () => probeKimi(ctx),
    () => probeCursor(ctx),
  ];
  for (const run of adapters) {
    try {
      out.push(...(await run()));
    } catch (e) {
      out.push(...failRow("unknown", "unknown", e instanceof Error ? e.message : String(e)));
    }
  }
  return out;
}

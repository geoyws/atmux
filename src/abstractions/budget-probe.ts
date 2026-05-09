// ADR-053 §D1: per-account budget probe + Fix C OAuth refresh.
//
// Bun-side port of bash `lib/whip.sh::_atmux_whip_probe_account_budget`,
// extended with OAuth-401 self-heal (Fix C). The bash baseline assumes a
// fresh access token and silently returns empty when the probe 401's; the
// bun port refreshes via `claudeAiOauth.refreshToken` ahead of expiry
// (60s margin) AND on a single 401 retry.
//
// Layout per ADR-053 §D1:
//   1. Read `~/.claude-<account>/.credentials.json` (bash convention; the
//      ADR's `~/.<account>/credentials.json` snippet is the abstract form,
//      real path on hax adds the `claude-` prefix + dotfile suffix).
//   2. Cache check on `<atmuxDir>/state/budget-probe-<account>.json`. TTL
//      default 240s (matches bash `ATMUX_BUDGET_PROBE_TTL`); `force: true`
//      skips cache.
//   3. OAuth refresh BEFORE probe if `expiresAt < now+60s`. Atomic
//      tmp+rename write of new tokens back into credentials.json. On
//      refresh failure (401/403) → status `probe-401`, surface
//      `atmux flags add` entry, write cache + history, return.
//   4. Probe call mirrors bash byte-identically: POST
//      https://api.anthropic.com/v1/messages with claude-haiku-4-5 +
//      max_tokens=1. Read rate-limit response headers.
//   5. Single 401 retry: if probe 401's, force-refresh once + retry probe.
//      Second 401 → `probe-401`.
//   6. Cache JSON shape mirrors bash byte-for-byte
//      (`{h5_util, wk_util, h5_reset, wk_reset, status, probedAt}`) so
//      bash whip can read it directly during the bash→bun transition.
//   7. Append history line to `<atmuxDir>/logs/budget-history.jsonl`
//      (D5; `appendText` under flock).
//
// Status surface (BudgetProbeResult.status) is the structured ADR-defined
// enum (allowed | rejected | probe-401 | probe-error | no-credentials);
// the on-disk cache file's `status` field stores the raw upstream
// `anthropic-ratelimit-unified-status` header value (typically `allowed`
// or `rejected` — bash treats anything else as `unknown`). Cache-hit
// reads pass that raw value through `normalizeStatus` to return one of
// the structured enum values.

import { homedir } from "node:os";
import { join } from "node:path";
import { appendHistoryEntry } from "../core/budget-history.ts";
import { atomicWrite, readTextOrNull, statOrNull } from "./fs.ts";
import { request } from "./http.ts";
import { now } from "./time.ts";

// ---------- Public types ----------

export type BudgetProbeStatus =
  | "allowed"
  | "rejected"
  | "probe-401"
  | "probe-error"
  | "no-credentials";

export interface BudgetProbeResult {
  /** Identity from `.claude-<account>` directory + team config. */
  account: string;
  /** 5h window utilization, 0–100 integer percentage. */
  h5_pct_used: number;
  /** 7d window utilization, 0–100 integer percentage. */
  wk_pct_used: number;
  /** Epoch seconds when the 5h window resets (0 when unknown). */
  h5_reset_epoch: number;
  /** Epoch seconds when the 7d window resets (0 when unknown). */
  wk_reset_epoch: number;
  /** Structured probe outcome (ADR-053 §D1 enum). */
  status: BudgetProbeStatus;
  /** Whether the result came from the live probe or a TTL-fresh cache. */
  source: "probe" | "cache-hit";
  /** Epoch seconds when the underlying probe ran (cache-hit preserves
   *  the original probe's stamp; probe writes `Math.floor(now()/1000)`). */
  probedAt: number;
  /** Free-form detail when `status !== "allowed"`. */
  error?: string;
}

export interface ProbeBudgetOpts {
  /** Skip cache; force a live probe. */
  force?: boolean;
  /** Cache age tolerance; default 240s (matches bash). */
  ttlSec?: number;
  /** Override `.atmux/` location; default `<cwd>/.atmux`. */
  atmuxDir?: string;
  /** Override `$HOME`; default `os.homedir()`. */
  homeDir?: string;
  /** OAuth token endpoint; default Anthropic prod. */
  oauthRefreshUrl?: string;
  /** Probe endpoint; default Anthropic prod. */
  probeUrl?: string;
  /** Surface a Fix C flag entry. Default: spawn `atmux flags add`
   *  best-effort (cross-runtime to bash); tests inject a recorder. */
  flagSurface?: (msg: string, account: string) => Promise<void>;
}

// ---------- On-disk shape (bash-compatible) ----------

/** Cache JSON shape mirrors `lib/whip.sh::_atmux_whip_probe_account_budget`
 *  byte-for-byte so bash whip can read this file during the bun→bash
 *  transition window. Bash uses 0–1 fractions for utilization, epoch
 *  seconds for reset, and the raw upstream `status` header value. */
interface CacheJson {
  h5_util: number;
  wk_util: number;
  h5_reset: number;
  wk_reset: number;
  status: string;
  probedAt: number;
}

// ---------- Constants ----------

const DEFAULT_TTL_SEC = 240;
const REFRESH_MARGIN_SEC = 60;
const DEFAULT_OAUTH_URL = "https://api.anthropic.com/v1/oauth/token";
const DEFAULT_PROBE_URL = "https://api.anthropic.com/v1/messages";

// ---------- Public API ----------

/**
 * Probe the rate-limit utilization for a Claude Max account.
 *
 * `account` is the suffix of the credentials directory: `icloud`,
 * `ifca`, `unum`, etc. (bash convention `~/.claude-<account>/.credentials.json`).
 * Empty / `default` / `null` are accepted but short-circuit to a
 * `no-credentials` result without touching the filesystem.
 *
 * Returns a `BudgetProbeResult` with `source: "cache-hit"` when a
 * fresh cache is found AND `force !== true`; otherwise fires a live
 * probe per the flow above.
 */
export async function probeBudget(
  account: string,
  opts: ProbeBudgetOpts = {},
): Promise<BudgetProbeResult> {
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const force = opts.force === true;
  const atmuxDir = opts.atmuxDir ?? join(process.cwd(), ".atmux");
  const homeDir = opts.homeDir ?? homedir();
  const oauthUrl = opts.oauthRefreshUrl ?? DEFAULT_OAUTH_URL;
  const probeUrl = opts.probeUrl ?? DEFAULT_PROBE_URL;
  const flagSurface = opts.flagSurface ?? defaultFlagSurface;

  // Bash short-circuit: empty / default / null account → silent no-op.
  if (account === "" || account === "default" || account === "null") {
    return noCredsResult(account, "account name not set");
  }

  const cachePath = join(atmuxDir, "state", `budget-probe-${account}.json`);

  // 1. Cache check (skipped on force).
  if (!force) {
    const hit = await tryCacheRead(cachePath, ttlSec, account);
    if (hit !== null) return hit;
  }

  // 2. Read credentials.
  const credsPath = join(homeDir, `.claude-${account}`, ".credentials.json");
  const credsText = await readTextOrNull(credsPath);
  if (credsText === null) {
    return noCredsResult(account, `credentials missing at ${credsPath}`);
  }
  let creds: {
    claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
  };
  try {
    creds = JSON.parse(credsText);
  } catch (e) {
    return noCredsResult(
      account,
      `credentials.json malformed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const oauth = creds.claudeAiOauth ?? {};
  let accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  if (accessToken.length === 0) {
    return noCredsResult(account, "credentials missing claudeAiOauth.accessToken");
  }

  let tokenRefreshed = false;

  // 3. OAuth refresh on near-expiry (Fix C).
  if (expiresAt > 0 && expiresAt < now() + REFRESH_MARGIN_SEC * 1000) {
    if (refreshToken.length === 0) {
      const r = await finalize(
        atmuxDir,
        cachePath,
        probe401Result(account, "expiresAt past + no refreshToken"),
        tokenRefreshed,
      );
      await flagSurface("OAuth refresh failed (no refreshToken)", account);
      return r;
    }
    const refreshed = await tryRefreshOauth(oauthUrl, refreshToken);
    if (refreshed === null) {
      const r = await finalize(
        atmuxDir,
        cachePath,
        probe401Result(account, "OAuth refresh endpoint failed pre-probe"),
        tokenRefreshed,
      );
      await flagSurface(`OAuth refresh failed for account=${account}`, account);
      return r;
    }
    accessToken = refreshed.accessToken;
    tokenRefreshed = true;
    await persistRefreshedTokens(credsPath, creds, refreshed, refreshToken);
  }

  // 4. Probe.
  let probeResp = await tryProbe(probeUrl, accessToken);

  // 5. Single 401 retry: assume token expired between step 3 and 4.
  if (probeResp.status === 401 && refreshToken.length > 0 && !tokenRefreshed) {
    const refreshed = await tryRefreshOauth(oauthUrl, refreshToken);
    if (refreshed === null) {
      const r = await finalize(
        atmuxDir,
        cachePath,
        probe401Result(account, "OAuth refresh failed on 401 retry"),
        tokenRefreshed,
      );
      await flagSurface(`OAuth refresh failed for account=${account}`, account);
      return r;
    }
    accessToken = refreshed.accessToken;
    tokenRefreshed = true;
    await persistRefreshedTokens(credsPath, creds, refreshed, refreshToken);
    probeResp = await tryProbe(probeUrl, accessToken);
  }

  if (probeResp.status === 401) {
    return finalize(
      atmuxDir,
      cachePath,
      probe401Result(account, "probe 401 after refresh attempt"),
      tokenRefreshed,
    );
  }

  if (probeResp.status === 0 || probeResp.status >= 300) {
    return finalize(
      atmuxDir,
      cachePath,
      probeErrorResult(account, `probe HTTP ${probeResp.status}`),
      tokenRefreshed,
    );
  }

  // Parse rate-limit headers.
  const h5Util = parseFloatHeader(probeResp.headers, "anthropic-ratelimit-unified-5h-utilization");
  const wkUtil = parseFloatHeader(probeResp.headers, "anthropic-ratelimit-unified-7d-utilization");
  const h5Reset = parseIntHeader(probeResp.headers, "anthropic-ratelimit-unified-5h-reset") ?? 0;
  const wkReset = parseIntHeader(probeResp.headers, "anthropic-ratelimit-unified-7d-reset") ?? 0;
  const statusHeader = probeResp.headers.get("anthropic-ratelimit-unified-status") ?? "unknown";

  if (h5Util === null || wkUtil === null) {
    return finalize(
      atmuxDir,
      cachePath,
      probeErrorResult(account, "missing utilization headers"),
      tokenRefreshed,
    );
  }

  const probedAt = Math.floor(now() / 1000);
  const cache: CacheJson = {
    h5_util: h5Util,
    wk_util: wkUtil,
    h5_reset: h5Reset,
    wk_reset: wkReset,
    status: statusHeader,
    probedAt,
  };
  await atomicWrite(cachePath, JSON.stringify(cache));

  const result: BudgetProbeResult = {
    account,
    h5_pct_used: Math.round(h5Util * 100),
    wk_pct_used: Math.round(wkUtil * 100),
    h5_reset_epoch: h5Reset,
    wk_reset_epoch: wkReset,
    status: normalizeStatus(statusHeader),
    source: "probe",
    probedAt,
  };
  await appendHistory(atmuxDir, result, h5Util, wkUtil, tokenRefreshed);
  return result;
}

// ---------- Internals ----------

async function tryCacheRead(
  cachePath: string,
  ttlSec: number,
  account: string,
): Promise<BudgetProbeResult | null> {
  const stat = await statOrNull(cachePath);
  if (stat === null) return null;
  const ageSec = (now() - stat.mtimeMs) / 1000;
  if (ageSec >= ttlSec) return null;
  const txt = await readTextOrNull(cachePath);
  if (txt === null) return null;
  let cache: unknown;
  try {
    cache = JSON.parse(txt);
  } catch {
    // Corrupt cache — treat as miss; next probe will overwrite.
    return null;
  }
  if (!isCacheJson(cache)) return null;
  return {
    account,
    h5_pct_used: Math.round(cache.h5_util * 100),
    wk_pct_used: Math.round(cache.wk_util * 100),
    h5_reset_epoch: cache.h5_reset,
    wk_reset_epoch: cache.wk_reset,
    status: normalizeStatus(cache.status),
    source: "cache-hit",
    probedAt: cache.probedAt,
  };
}

function isCacheJson(v: unknown): v is CacheJson {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.h5_util === "number" &&
    typeof o.wk_util === "number" &&
    typeof o.h5_reset === "number" &&
    typeof o.wk_reset === "number" &&
    typeof o.status === "string" &&
    typeof o.probedAt === "number"
  );
}

interface ProbeResponse {
  status: number;
  headers: Headers;
}

async function tryProbe(url: string, accessToken: string): Promise<ProbeResponse> {
  try {
    const resp = await request({
      url,
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      timeoutMs: 15_000,
      // Accept all statuses; caller branches on .status.
      expectStatus: { min: 0, max: 999 },
    });
    return { status: resp.status, headers: resp.headers };
  } catch {
    // Network / timeout / abort → status=0 surfaces as probe-error.
    return { status: 0, headers: new Headers() };
  }
}

interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function tryRefreshOauth(url: string, refreshToken: string): Promise<RefreshResult | null> {
  try {
    const resp = await request({
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      timeoutMs: 15_000,
      expectStatus: { min: 200, max: 299 },
    });
    let body: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    try {
      body = JSON.parse(resp.body);
    } catch {
      return null;
    }
    if (typeof body.access_token !== "string" || body.access_token.length === 0) return null;
    const out: RefreshResult = { accessToken: body.access_token };
    if (typeof body.refresh_token === "string" && body.refresh_token.length > 0) {
      out.refreshToken = body.refresh_token;
    }
    if (typeof body.expires_in === "number" && body.expires_in > 0) {
      out.expiresAt = now() + body.expires_in * 1000;
    }
    return out;
  } catch {
    return null;
  }
}

async function persistRefreshedTokens(
  credsPath: string,
  creds: { claudeAiOauth?: Record<string, unknown> },
  refreshed: RefreshResult,
  oldRefreshToken: string,
): Promise<void> {
  const oauth = { ...(creds.claudeAiOauth ?? {}) };
  oauth.accessToken = refreshed.accessToken;
  oauth.refreshToken = refreshed.refreshToken ?? oldRefreshToken;
  if (refreshed.expiresAt !== undefined) oauth.expiresAt = refreshed.expiresAt;
  const updated = { ...creds, claudeAiOauth: oauth };
  await atomicWrite(credsPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
}

async function finalize(
  atmuxDir: string,
  cachePath: string,
  result: BudgetProbeResult,
  tokenRefreshed: boolean,
): Promise<BudgetProbeResult> {
  // Write cache so subsequent ticks see the failure too (per ADR §D1
  // step 7 "regardless of status — failures are observable"). Use the
  // bash-compatible shape with 0/0 for util when the probe didn't yield
  // headers.
  const cache: CacheJson = {
    h5_util: result.h5_pct_used / 100,
    wk_util: result.wk_pct_used / 100,
    h5_reset: result.h5_reset_epoch,
    wk_reset: result.wk_reset_epoch,
    status: result.status,
    probedAt: result.probedAt,
  };
  try {
    await atomicWrite(cachePath, JSON.stringify(cache));
  } catch {
    // Best-effort: cache-write failure shouldn't mask the probe outcome.
  }
  await appendHistory(atmuxDir, result, cache.h5_util, cache.wk_util, tokenRefreshed);
  return result;
}

async function appendHistory(
  atmuxDir: string,
  result: BudgetProbeResult,
  h5Util: number,
  wkUtil: number,
  tokenRefreshed: boolean,
): Promise<void> {
  await appendHistoryEntry(atmuxDir, {
    ts: result.probedAt,
    account: result.account,
    h5_util: h5Util,
    wk_util: wkUtil,
    h5_reset: result.h5_reset_epoch,
    wk_reset: result.wk_reset_epoch,
    status: result.status,
    source: result.source,
    tokenRefreshed,
  });
}

function parseFloatHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v === null) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

function parseIntHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v === null) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function normalizeStatus(raw: string): BudgetProbeStatus {
  if (raw === "allowed") return "allowed";
  if (raw === "rejected") return "rejected";
  if (raw === "probe-401") return "probe-401";
  if (raw === "probe-error") return "probe-error";
  if (raw === "no-credentials") return "no-credentials";
  // Upstream emitted some other value (e.g. `unknown` from bash legacy
  // cache); collapse to probe-error so the structured enum holds.
  return "probe-error";
}

function noCredsResult(account: string, detail: string): BudgetProbeResult {
  return {
    account,
    h5_pct_used: 0,
    wk_pct_used: 0,
    h5_reset_epoch: 0,
    wk_reset_epoch: 0,
    status: "no-credentials",
    source: "probe",
    probedAt: Math.floor(now() / 1000),
    error: detail,
  };
}

function probe401Result(account: string, detail: string): BudgetProbeResult {
  return {
    account,
    h5_pct_used: 0,
    wk_pct_used: 0,
    h5_reset_epoch: 0,
    wk_reset_epoch: 0,
    status: "probe-401",
    source: "probe",
    probedAt: Math.floor(now() / 1000),
    error: detail,
  };
}

function probeErrorResult(account: string, detail: string): BudgetProbeResult {
  return {
    account,
    h5_pct_used: 0,
    wk_pct_used: 0,
    h5_reset_epoch: 0,
    wk_reset_epoch: 0,
    status: "probe-error",
    source: "probe",
    probedAt: Math.floor(now() / 1000),
    error: detail,
  };
}

/** Default flag surface — best-effort spawn of `atmux flags add`. The
 *  bash CLI runs cross-runtime via the symlinked binary in PATH; if the
 *  spawn fails (binary missing, exit non-zero), we swallow because the
 *  primary probe outcome is already recorded in the cache + history. */
async function defaultFlagSurface(message: string, account: string): Promise<void> {
  try {
    const { spawn } = await import("./spawn.ts");
    await spawn({
      cmd: "atmux",
      argv: ["flags", "add", message, "--severity", "p2", "--needs", "context"],
      timeoutMs: 5_000,
      expectExitCode: "any",
    });
  } catch {
    // Best-effort: flags surface failure leaves the result intact. The
    // probe-401 status is still in the cache and history, so the next
    // operator-grep across budget-history.jsonl finds the issue.
  }
  // Reference `account` so unused-arg lint (caller may inject test
  // recorder that wants the account name) doesn't complain at the
  // default-impl level.
  void account;
}

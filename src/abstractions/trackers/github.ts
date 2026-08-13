// GitHub IssueTracker adapter — ADR-261 Phase 1 (§D11).
//
// Wraps the GitHub REST issues surface behind the vendor-agnostic
// `IssueTracker` interface (src/abstractions/issue-tracker.ts). Two ADR-261
// invariants govern everything here:
//   - Provider frames NEVER leak (§D2): consumers see only NormalizedIssue
//     fields + a minimal `extra`; the GitHub row shape stays inside this file.
//   - All HTTP goes through `src/abstractions/http.ts` (§D1): no raw `fetch`,
//     no `gh` CLI shell-out. http.ts owns timeout / 5xx-retry / status
//     validation — this adapter adds NO sleeping or retrying of its own.
//
//   listIssues() → GET /repos/<owner>/<repo>/issues with per_page≤100,
//                  state=all, sort=updated, direction=asc, since=<ISO>.
//                  The cursor encodes BOTH the `since` watermark AND the
//                  page/per-page coordinates (§D4): orchd ticks are
//                  hard-killed at ATMUX_ORCHD_TICK_TIMEOUT_SECS, so a killed
//                  paginating sync RESUMES the same walk (same watermark,
//                  same page size, next page) instead of restarting. The
//                  next page number comes from the response's Link header
//                  (`rel="next"`). GitHub serves pull requests on the
//                  issues endpoint — rows carrying a `pull_request` key are
//                  dropped (PRs are not issues).
//   getIssue()   → GET /repos/<owner>/<repo>/issues/<n> from the §D3
//                  sourceId (`github:owner/repo#123`). Resolves null on 404
//                  (the §D4 pending-repair path probes ids that may be
//                  gone) and for PR-pointing ids (same filter as
//                  listIssues). Malformed sourceIds throw ConfigError — a
//                  caller bug, not a missing issue.
//
// Auth (§D7.4): the house 3-tier token cascade (`resolveTrackerToken` —
// pattern: `resolveWebhookUrl`, src/abstractions/discord.ts): env
// `ATMUX_GITHUB_TOKEN` → team.json token literal → the XDG config file
// `${XDG_CONFIG_HOME:-~/.config}/atmux/github-token`, contents trimmed.
// The Phase 0 `team.json::issueSync` schema carries NO token field
// (`TeamIssueSyncTracker`, src/schema/team.ts — the github arm is
// `.strict()` with no token key), so tier 2 never resolves for this adapter
// today; the generic cascade still implements it because the Phase 0
// `TrackerAuthConfig` contract pins all three tiers (Phase 2's ADO adapter
// reuses it). No token resolving ⇒ unauthenticated mode (public repos —
// allowed per §D7; GitHub's anonymous 60 req/h budget applies). Tokens ride
// the Authorization header ONLY — never argv, never logged; this adapter
// logs nothing (§D7.5).
//
// Rate-limit hygiene: a 403/429 with `x-ratelimit-remaining: 0` surfaces as
// the typed `TrackerRateLimitError` carrying the reset epoch — the sync
// ENGINE decides whether to checkpoint + bail or wait. Any other 403/429
// (bad credentials, SSO enforcement, abuse blocks without the marker) is
// the plain HttpError `request()` would have thrown for it.

import { z } from "zod";
import { ConfigError, HttpError, TrackerRateLimitError } from "../../errors.ts";
import { readTextOrNull } from "../fs.ts";
import { type HttpResponse, request } from "../http.ts";
import type {
  IssueState,
  IssueTracker,
  IssueTrackerPage,
  ListIssuesOptions,
  NormalizedIssue,
  SourceIdPrefixByTrackerId,
  TrackerAuthConfig,
  TrackerId,
  TrackerScope,
} from "../issue-tracker.ts";
import { tryParseJsonString } from "../json.ts";

/** Re-export for ergonomics — engine code catching the §D1 rate-limit signal
 *  usually imports it next to the adapter factory. The canonical class lives
 *  in `errors.ts` (same pattern as http.ts's HttpError re-export). */
export { TrackerRateLimitError } from "../../errors.ts";

// ---------- Identity constants ----------

/** Stable adapter id (ADR-261 §D2). Surfaces in NormalizedIssue.trackerId +
 *  TrackerRateLimitError.trackerId for routing + observability. */
export const GITHUB_TRACKER_ID = "github" satisfies TrackerId;

/** The frozen §D3 sourceId prefix for this adapter — type-pinned to the
 *  Phase 0 {@link SourceIdPrefixByTrackerId} contract so the 1:1
 *  prefix↔adapter mapping cannot drift. */
export const GITHUB_SOURCE_ID_PREFIX: SourceIdPrefixByTrackerId["github"] = "github";

/** The §D7.4 cascade coordinates for this adapter: tier 1 env var + tier 3
 *  XDG file basename. No `teamJsonToken` tier-2 literal — the Phase 0
 *  `team.json::issueSync` schema has no token field (see header). */
export const GITHUB_AUTH: TrackerAuthConfig = Object.freeze({
  envVar: "ATMUX_GITHUB_TOKEN",
  configFileBasename: "github-token",
});

// ---------- Tuning constants ----------

const GITHUB_API_BASE = "https://api.github.com";
/** GitHub's documented `per_page` ceiling for the issues listing. */
export const GITHUB_MAX_PER_PAGE = 100;
/** Extra 5xx attempts delegated to http.ts's built-in retry (§D1 — the
 *  adapter itself never sleeps or retries; 4xx is never retried). */
const GITHUB_HTTP_RETRY = 2;
/** GitHub rejects requests without a User-Agent header. */
const GITHUB_USER_AGENT = "atmux-issue-sync";
/** REST API version pin (GitHub's `x-github-api-version` header). */
const GITHUB_API_VERSION = "2022-11-28";

// ---------- Provider frame (NEVER exported — §D2) ----------

/** `user` / `assignee` reference — only the login is read. */
const GithubUserRef = z.object({ login: z.string() }).passthrough();

/** Finite-parseable ISO timestamp — a 200 whose timestamps don't parse is a
 *  frame violation surfaced by the body-shape check, so the epoch mapping
 *  below needs no NaN branch. */
const GithubIsoTimestamp = z
  .string()
  .refine((s) => Number.isFinite(Date.parse(s)), { message: "not a parseable ISO timestamp" });

/** The slice of a GitHub REST issue object this adapter reads. Passthrough:
 *  GitHub adds fields freely; only the declared keys are load-bearing. */
const GithubIssueRow = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    html_url: z.string(),
    state: z.string(),
    /** Label entries arrive as objects (`{ name }`) or bare strings. */
    labels: z.array(z.union([z.string(), z.object({ name: z.string() }).passthrough()])).optional(),
    user: GithubUserRef.nullable().optional(),
    assignee: GithubUserRef.nullable().optional(),
    created_at: GithubIsoTimestamp,
    updated_at: GithubIsoTimestamp,
    /** Present (as an object) exactly when the row is a pull request — the
     *  §D2 filter key; PRs are dropped from the issues walk. */
    pull_request: z.unknown().optional(),
  })
  .passthrough();
type GithubIssueRow = z.infer<typeof GithubIssueRow>;

// ---------- Cursor (§D4) ----------

/**
 * Decoded cursor coordinates — the resume point of one listing walk.
 * The on-the-wire form is adapter-owned and OPAQUE to consumers
 * (IssueTrackerPage contract): only this encode/decode pair interprets it.
 */
export interface GithubCursorState {
  /** The walk's `since` watermark (epoch sec), or null for a full walk.
   *  Pinned at walk start — a resumed page MUST reuse it: changing `since`
   *  mid-walk renumbers every page, skipping or duplicating rows. */
  readonly sinceSec: number | null;
  /** Next page to fetch (1-based — GitHub page-numbered pagination). */
  readonly page: number;
  /** The walk's `per_page` size — pinned for the same offset-alignment
   *  reason as `sinceSec`. */
  readonly perPage: number;
}

/** Versioned wire shape. `v` pins the format so a future cursor change can
 *  refuse (not misread) tokens checkpointed by an older adapter. */
const GithubCursor = z
  .object({
    v: z.literal(1),
    sinceSec: z.number().int().nullable(),
    page: z.number().int().min(1),
    perPage: z.number().int().min(1).max(GITHUB_MAX_PER_PAGE),
  })
  .strict();

/** Encode a resume point into the opaque wire form (§D4 — checkpointed per
 *  page by the caller via IssueSyncRepo.setCursor). */
export function encodeGithubCursor(state: GithubCursorState): string {
  return JSON.stringify({
    v: 1,
    sinceSec: state.sinceSec,
    page: state.page,
    perPage: state.perPage,
  });
}

/** Decode an opaque cursor back into resume coordinates. Fails CLOSED on
 *  anything malformed — a silently-restarted walk could re-flood the lead
 *  (§D8), so a corrupt checkpoint is a refusal, never a fresh start. */
export function decodeGithubCursor(cursor: string): GithubCursorState {
  const parsed = tryParseJsonString(cursor, GithubCursor);
  if (parsed === null) {
    throw new ConfigError({
      what: `malformed github cursor: ${cursor}`,
      hint: "cursors are adapter-owned opaque tokens — pass back exactly what listIssues returned, or null to restart the walk",
    });
  }
  return { sinceSec: parsed.sinceSec, page: parsed.page, perPage: parsed.perPage };
}

// ---------- Scope + sourceId parsing (§D3) ----------

/** `owner/repo` — owner is a GitHub login (alnum + hyphens), repo allows
 *  dots/underscores. The character classes are URL-safe by construction,
 *  so validated scopes interpolate into request paths without escaping. */
const GITHUB_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** Canonical §D3 identity: `github:owner/repo#<number>`. */
const GITHUB_SOURCE_ID_RE = /^github:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

/** Validate a §D7.2 allowlist scope. Scopes come from `team.json::issueSync`
 *  — a malformed one is operator config error, refused before any HTTP. */
function assertGithubScope(scope: TrackerScope): void {
  if (!GITHUB_SCOPE_RE.test(scope)) {
    throw new ConfigError({
      what: `invalid github scope: ${JSON.stringify(scope)}`,
      hint: "expected 'owner/repo' (a team.json::issueSync repos allowlist entry)",
    });
  }
}

/** Split a §D3 sourceId (`github:owner/repo#123`) into its coordinates.
 *  Throws ConfigError on anything that isn't this adapter's frozen format —
 *  including other adapters' prefixes (`ado:` ids are never GitHub's). */
export function parseGithubSourceId(sourceId: string): { scope: string; issueNumber: number } {
  const m = GITHUB_SOURCE_ID_RE.exec(sourceId);
  if (m === null) {
    throw new ConfigError({
      what: `malformed github sourceId: ${JSON.stringify(sourceId)}`,
      hint: "expected 'github:owner/repo#<number>' (ADR-261 §D3)",
    });
  }
  // Both groups are non-optional in the regex — the `?? ""` arms exist only
  // to satisfy noUncheckedIndexedAccess (house pattern: needs-approval.ts).
  return { scope: m[1] ?? "", issueNumber: Number(m[2] ?? "") };
}

// ---------- Link-header pagination ----------

/**
 * Extract the NEXT page number from a GitHub `Link` response header
 * (`<url&page=2>; rel="next", <…>; rel="last"`). Returns null when there is
 * no `rel="next"` entry (listing exhausted). When the next link exists but
 * its `page` param is missing or garbled, falls back to `currentPage + 1`
 * (page-numbered pagination always advances by one). Pure — exported for
 * direct unit-testing.
 */
export function nextPageFromLinkHeader(
  linkHeader: string | null,
  currentPage: number,
): number | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const url = /<([^>]*)>\s*;\s*rel="next"/.exec(part)?.[1];
    if (url === undefined) continue;
    const fromUrl = pageParamFromUrl(url);
    return fromUrl ?? currentPage + 1;
  }
  return null;
}

/** Positive-integer `page` query param of a link URL, or null when the URL
 *  is malformed / the param is absent or non-numeric. */
function pageParamFromUrl(url: string): number | null {
  try {
    const raw = new URL(url).searchParams.get("page");
    return raw !== null && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
  } catch {
    return null; // expected: garbled link URL — caller falls back to +1
  }
}

// ---------- Token resolution (§D7.4) ----------

/** Injection seams for {@link resolveTrackerToken} — production callers
 *  omit (mirrors `resolveWebhookUrl`'s injectable env). */
export interface ResolveTrackerTokenDeps {
  /** Process env override (test injection). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Tier-3 config-file reader (`null` ⇒ absent). Defaults to
   *  `readTextOrNull` (src/abstractions/fs.ts). */
  readTextFile?: (path: string) => Promise<string | null>;
}

/**
 * Resolve a tracker API token per the house 3-tier cascade (ADR-261 §D7.4;
 * pattern: `resolveWebhookUrl`, src/abstractions/discord.ts). First
 * non-empty hit wins:
 *
 *   1. env var named by `auth.envVar`
 *   2. `auth.teamJsonToken` literal (when the team.json schema carries one)
 *   3. `${XDG_CONFIG_HOME:-$HOME/.config}/atmux/<auth.configFileBasename>`,
 *      contents trimmed
 *
 * Returns null when no tier resolves — callers then run unauthenticated
 * (allowed for public repos, §D7). Tracker-generic: Phase 2's azure-devops
 * adapter passes its own TrackerAuthConfig.
 */
export async function resolveTrackerToken(
  auth: TrackerAuthConfig,
  deps: ResolveTrackerTokenDeps = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const readTextFile = deps.readTextFile ?? readTextOrNull;

  // 1. env
  const fromEnv = env[auth.envVar];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  // 2. team.json literal
  if (auth.teamJsonToken !== undefined && auth.teamJsonToken !== "") return auth.teamJsonToken;

  // 3. XDG file
  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME ?? "";
  const base = xdg !== undefined && xdg !== "" ? xdg : `${home}/.config`;
  const text = await readTextFile(`${base}/atmux/${auth.configFileBasename}`);
  if (text !== null) {
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

// ---------- Normalization (§D2) ----------

/** GitHub issues are exactly open|closed; anything unexpected maps to
 *  "open" — fail-open: a never-seen state should surface to the lead, not
 *  be silently treated as already-closed (the §D4 absent+closed arm never
 *  files). */
function normalizeState(state: string): IssueState {
  return state === "closed" ? "closed" : "open";
}

/** Label entries → bare name strings (input to the §D10 severity map). */
function labelNames(labels: GithubIssueRow["labels"]): string[] {
  return (labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
}

/** ISO → epoch seconds. Finite-parseable is guaranteed by the row schema's
 *  GithubIsoTimestamp refinement. */
function epochSecFromIso(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Map one GitHub row onto the vendor-agnostic NormalizedIssue (§D2). The
 *  `extra` bag is deliberately minimal (forward-compat only — consumers
 *  must not make load-bearing reads of it). */
function normalizeGithubIssue(row: GithubIssueRow, scope: TrackerScope): NormalizedIssue {
  return Object.freeze({
    trackerId: GITHUB_TRACKER_ID,
    sourceId: `${GITHUB_SOURCE_ID_PREFIX}:${scope}#${row.number}`,
    url: row.html_url,
    title: row.title,
    body: row.body ?? null,
    state: normalizeState(row.state),
    labels: Object.freeze(labelNames(row.labels)),
    assignee: row.assignee?.login ?? null,
    author: row.user?.login ?? null,
    createdAtSec: epochSecFromIso(row.created_at),
    updatedAtSec: epochSecFromIso(row.updated_at),
    extra: Object.freeze({ number: row.number }),
  });
}

// ---------- Response-body parsing ----------

/** A 2xx whose body is not the documented GitHub frame — surfaced as an
 *  HttpError (transport succeeded, payload didn't; callers treat it like
 *  any other tracker IO failure). The body is truncated so a huge HTML
 *  error page doesn't balloon the error context. */
function frameError(resp: HttpResponse): HttpError {
  return new HttpError({
    url: resp.url,
    method: resp.method,
    status: resp.status,
    body: `github response body did not match the expected frame: ${resp.body.slice(0, 200)}`,
  });
}

function parseListBody(resp: HttpResponse): GithubIssueRow[] {
  const rows = tryParseJsonString(resp.body, z.array(GithubIssueRow));
  if (rows === null) throw frameError(resp);
  return rows;
}

function parseIssueBody(resp: HttpResponse): GithubIssueRow {
  const row = tryParseJsonString(resp.body, GithubIssueRow);
  if (row === null) throw frameError(resp);
  return row;
}

// ---------- Rate-limit classification (§D1 hygiene) ----------

/** Re-classify a 403/429: with `x-ratelimit-remaining: 0` it IS the rate
 *  limit — the typed TrackerRateLimitError carries the reset epoch so the
 *  sync engine can checkpoint + bail (the adapter never sleeps). Anything
 *  else (bad credentials, SSO enforcement, abuse blocks without the
 *  marker) is the plain HttpError `request()` would have thrown. */
function classifyDenial(resp: HttpResponse): TrackerRateLimitError | HttpError {
  if (resp.headers.get("x-ratelimit-remaining") === "0") {
    return new TrackerRateLimitError({
      trackerId: GITHUB_TRACKER_ID,
      url: resp.url,
      status: resp.status,
      resetAtSec: parseResetEpoch(resp.headers.get("x-ratelimit-reset")),
    });
  }
  return new HttpError({
    url: resp.url,
    method: resp.method,
    status: resp.status,
    body: resp.body,
  });
}

/** `x-ratelimit-reset` is epoch seconds; absent/garbled → null (the engine
 *  then applies its own backoff policy — never a fabricated epoch). */
function parseResetEpoch(raw: string | null): number | null {
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  return Number(raw);
}

// ---------- The adapter ----------

/**
 * Injection seams for {@link createGithubTracker} — production callers omit
 * every field (defaults are the real abstractions). Matches the house
 * deps-object discipline (template: ComplaintConsumerDeps,
 * src/core/complaint-consumer.ts).
 */
export interface GithubTrackerDeps {
  /** HTTP request fn — default: the house `request` (src/abstractions/
   *  http.ts, §D1). Tests inject a fake to script GitHub responses without
   *  a network. */
  httpRequest?: typeof request;
  /** Env for the §D7.4 cascade tier 1. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Config-file reader for cascade tier 3 (`null` ⇒ absent). Default
   *  `readTextOrNull` (src/abstractions/fs.ts). */
  readTextFile?: (path: string) => Promise<string | null>;
}

/** Build the GitHub IssueTracker over the injected seams. Stateless — the
 *  resume point lives entirely in the cursor (§D4), so a fresh adapter
 *  after a tick kill picks up exactly where the checkpoint left off. */
export function createGithubTracker(deps: GithubTrackerDeps = {}): IssueTracker {
  const httpRequest = deps.httpRequest ?? request;
  const env = deps.env ?? process.env;
  const readTextFile = deps.readTextFile ?? readTextOrNull;

  /** One authenticated(-when-possible) GET against the GitHub API. The
   *  token is re-resolved per call (cheap; picks up env/config rotation
   *  between pages). `expectStatus` admits 403/429 so their rate-limit
   *  headers stay readable — the HttpError `request()` throws carries no
   *  headers — then re-classifies them below; 5xx keeps http.ts's built-in
   *  retry; every other unexpected status throws http.ts's own HttpError. */
  async function githubGet(url: string, allow404: boolean): Promise<HttpResponse> {
    const token = await resolveTrackerToken(GITHUB_AUTH, { env, readTextFile });
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": GITHUB_USER_AGENT,
    };
    // Unauthenticated mode (§D7): when no cascade tier resolves, the
    // Authorization header is simply omitted — public repos still work.
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const resp = await httpRequest({
      url,
      method: "GET",
      headers,
      retry: GITHUB_HTTP_RETRY,
      expectStatus: allow404 ? [200, 403, 404, 429] : [200, 403, 429],
    });
    if (resp.status === 403 || resp.status === 429) throw classifyDenial(resp);
    return resp;
  }

  return {
    id: GITHUB_TRACKER_ID,

    async listIssues(opts: ListIssuesOptions): Promise<IssueTrackerPage> {
      assertGithubScope(opts.scope);
      // A cursor resumes an in-flight walk and therefore WINS over
      // opts.sinceSec/pageSize — page offsets only align within one
      // (since, per_page) listing (§D4 resume-not-restart).
      const walk: GithubCursorState =
        opts.cursor !== undefined && opts.cursor !== null
          ? decodeGithubCursor(opts.cursor)
          : {
              sinceSec: opts.sinceSec ?? null,
              page: 1,
              perPage: clampPerPage(opts.pageSize),
            };
      const url = new URL(`${GITHUB_API_BASE}/repos/${opts.scope}/issues`);
      url.searchParams.set("per_page", String(walk.perPage));
      url.searchParams.set("state", "all");
      url.searchParams.set("sort", "updated");
      url.searchParams.set("direction", "asc");
      if (walk.sinceSec !== null) {
        url.searchParams.set("since", new Date(walk.sinceSec * 1000).toISOString());
      }
      url.searchParams.set("page", String(walk.page));

      const resp = await githubGet(url.toString(), false);
      const rows = parseListBody(resp);
      const issues = rows
        // GitHub returns PRs on the issues endpoint — drop them (§D2).
        .filter((r) => r.pull_request === undefined)
        .map((r) => normalizeGithubIssue(r, opts.scope));
      const nextPage = nextPageFromLinkHeader(resp.headers.get("link"), walk.page);
      const nextCursor =
        nextPage === null
          ? null
          : encodeGithubCursor({ sinceSec: walk.sinceSec, page: nextPage, perPage: walk.perPage });
      return { issues, nextCursor };
    },

    async getIssue(externalId: string): Promise<NormalizedIssue | null> {
      const { scope, issueNumber } = parseGithubSourceId(externalId);
      const resp = await githubGet(`${GITHUB_API_BASE}/repos/${scope}/issues/${issueNumber}`, true);
      // Interface contract: not-found resolves null, never throws — the
      // §D4 pending-repair path probes ids that may be gone.
      if (resp.status === 404) return null;
      const row = parseIssueBody(resp);
      // A sourceId pointing at a PR is not an issue — same filter as
      // listIssues, so getIssue can never resurrect a row the walk drops.
      if (row.pull_request !== undefined) return null;
      return normalizeGithubIssue(row, scope);
    },
  };
}

/** Page-size hint → GitHub's 1..100 `per_page` range. Missing/non-finite
 *  hints take the maximum (fewest round-trips per 900s tick budget). */
function clampPerPage(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return GITHUB_MAX_PER_PAGE;
  return Math.min(GITHUB_MAX_PER_PAGE, Math.max(1, Math.floor(pageSize)));
}

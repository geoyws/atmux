// GitHub issue-tracker adapter (ADR-263 §D3, P3). Implements the
// vendor-agnostic `IssueTracker` seam against the GitHub REST API.
//
// Invariants (ADR-263 §D3 / §D1):
//   - All HTTP goes through `src/abstractions/http.ts` — no raw `fetch`,
//     no `gh` CLI shell-out. The `request` fn is dependency-injected so
//     unit tests mock the wire without touching the network.
//   - Consumers see only NORMALIZED issues — GitHub's payload shape never
//     leaks past this file.
//   - Read-only: v1 lists + gets issues; there is no write-back path.
//
// GitHub's `/issues` endpoint returns pull requests too (a PR is an issue
// with a `pull_request` key) — ADR-263 §D3 wants "issues AND PRs" as
// tasks, so we keep both and flag PRs in `NormalizedIssue.extra` for the
// human-readable task body.

import { readTextOrNull } from "../fs.ts";
import { request as defaultRequest, type HttpResponse } from "../http.ts";
import type {
  IssueTracker,
  IssueTrackerPage,
  ListIssuesOptions,
  NormalizedIssue,
  TrackerAuthConfig,
} from "../issue-tracker.ts";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_MAX_PER_PAGE = 100;
const TRACKER_ID = "github";

/** GitHub's auth config under the house 3-tier cascade. */
export const GITHUB_AUTH: TrackerAuthConfig = {
  envVar: "ATMUX_GITHUB_TOKEN",
  configFileBasename: "github-token",
};

/** Minimal subset of the GitHub REST issue object we read. The full
 *  payload is far larger; we name only the fields we map. */
interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<string | { name?: string }>;
  assignee: { login?: string } | null;
  user: { login?: string } | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

/** Injectable request fn — exactly the `http.ts::request` signature. */
type RequestFn = typeof defaultRequest;

export interface GithubTrackerOpts {
  /** Resolved API token (from {@link resolveTrackerToken}). Omit for
   *  unauthenticated access (public repos only; 60 req/hr rate limit). */
  token?: string | null;
  /** DI seam — defaults to the house `http.ts::request`. Tests pass a stub. */
  requestFn?: RequestFn;
  /** Override the API base (tests / GitHub Enterprise). */
  apiBase?: string;
}

/**
 * Resolve a tracker API token via the house 3-tier cascade (env →
 * team.json literal → `~/.config/atmux/<basename>` file). Returns `null`
 * when no token is configured (callers fall back to unauthenticated).
 *
 * Tokens NEVER come from argv (tmux pane capture records command lines);
 * env or file only, per the seam's auth contract.
 */
export async function resolveTrackerToken(
  auth: TrackerAuthConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  // Tier 1 — environment variable.
  const fromEnv = env[auth.envVar];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  // Tier 2 — team.json literal.
  if (auth.teamJsonToken !== undefined && auth.teamJsonToken.trim().length > 0) {
    return auth.teamJsonToken.trim();
  }
  // Tier 3 — config file under XDG_CONFIG_HOME (or ~/.config).
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : `${env.HOME ?? ""}/.config`;
  const path = `${configHome}/atmux/${auth.configFileBasename}`;
  const contents = await readTextOrNull(path);
  if (contents !== null && contents.trim().length > 0) return contents.trim();
  return null;
}

/**
 * Construct a GitHub `IssueTracker`. The returned object is stateless
 * apart from the captured token + request fn — safe to build per-sync.
 */
export function makeGithubTracker(opts: GithubTrackerOpts = {}): IssueTracker {
  const requestFn = opts.requestFn ?? defaultRequest;
  const apiBase = opts.apiBase ?? GITHUB_API_BASE;
  const token = opts.token ?? null;

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "atmux-issue-sync",
      "x-github-api-version": "2022-11-28",
    };
    if (token !== null && token.length > 0) h.authorization = `Bearer ${token}`;
    return h;
  };

  return {
    id: TRACKER_ID,

    async listIssues(o: ListIssuesOptions): Promise<IssueTrackerPage> {
      const { owner, repo } = parseScope(o.scope);
      const page = cursorToPage(o.cursor);
      const perPage = clampPerPage(o.pageSize);
      const params = new URLSearchParams();
      params.set("state", o.state ?? "open");
      params.set("per_page", String(perPage));
      params.set("page", String(page));
      params.set("sort", "updated");
      params.set("direction", "desc");
      if (o.labels !== undefined && o.labels.length > 0) {
        params.set("labels", o.labels.join(","));
      }
      if (o.sinceSec !== undefined) {
        params.set("since", new Date(o.sinceSec * 1000).toISOString());
      }
      const url = `${apiBase}/repos/${owner}/${repo}/issues?${params.toString()}`;
      const resp = await requestFn({ url, method: "GET", headers: headers() });
      const issues = parseIssueArray(resp.body, o.scope);
      const nextCursor = nextPageFromLinkHeader(resp.headers);
      return { issues, nextCursor };
    },

    async getIssue(externalId: string): Promise<NormalizedIssue | null> {
      const parsed = parseSourceId(externalId);
      if (parsed === null) return null;
      const { owner, repo, number } = parsed;
      const url = `${apiBase}/repos/${owner}/${repo}/issues/${number}`;
      let resp: HttpResponse;
      try {
        resp = await requestFn({
          url,
          method: "GET",
          headers: headers(),
          // 404 (gone / no read access) → null, not throw. Other 4xx still throw.
          expectStatus: { min: 200, max: 299 },
        });
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
      const raw = JSON.parse(resp.body) as GithubIssue;
      return normalizeIssue(raw, `${owner}/${repo}`);
    },
  };
}

// ---------- Pure helpers (exported for direct unit-testing) ----------

/** Parse a `owner/repo` scope. Throws on malformed input so a typo'd
 *  `team.json::taskSources[].scope` fails loud, not silent. */
export function parseScope(scope: string): { owner: string; repo: string } {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(scope.trim());
  if (m === null) {
    throw new Error(`github: invalid scope "${scope}" — expected "owner/repo"`);
  }
  return { owner: m[1] as string, repo: m[2] as string };
}

/** Parse a canonical `github:owner/repo#123` sourceId. Returns `null` on
 *  any non-github / malformed id (so `getIssue` resolves null rather than
 *  throwing on a foreign id). */
export function parseSourceId(
  sourceId: string,
): { owner: string; repo: string; number: number } | null {
  const m = /^github:([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(sourceId.trim());
  if (m === null) return null;
  return {
    owner: m[1] as string,
    repo: m[2] as string,
    number: Number.parseInt(m[3] as string, 10),
  };
}

/** Build the canonical sourceId for an issue number in a scope. */
export function buildSourceId(scope: string, issueNumber: number): string {
  return `github:${scope}#${issueNumber}`;
}

/** `cursor` is the stringified next page number; absent → page 1. */
function cursorToPage(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined || cursor.length === 0) return 1;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function clampPerPage(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize <= 0) {
    return GITHUB_MAX_PER_PAGE;
  }
  return Math.min(pageSize, GITHUB_MAX_PER_PAGE);
}

/** Extract the `rel="next"` page number from a GitHub `Link` header.
 *  Returns the page number as a string cursor, or `null` when exhausted. */
export function nextPageFromLinkHeader(headers: Headers): string | null {
  const link = headers.get("link") ?? headers.get("Link");
  if (link === null || link.length === 0) return null;
  // Entries look like: <https://api.github.com/...&page=2>; rel="next"
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const urlMatch = /<([^>]+)>/.exec(part);
    if (urlMatch === null) continue;
    try {
      const u = new URL(urlMatch[1] as string);
      const p = u.searchParams.get("page");
      if (p !== null && p.length > 0) return p;
    } catch {
      // malformed URL in the Link header — treat as exhausted
    }
  }
  return null;
}

/** Parse + normalize a JSON array of GitHub issues. */
export function parseIssueArray(body: string, scope: string): NormalizedIssue[] {
  const arr = JSON.parse(body) as unknown;
  if (!Array.isArray(arr)) {
    throw new Error(`github: expected a JSON array of issues for ${scope}`);
  }
  return arr.map((raw) => normalizeIssue(raw as GithubIssue, scope));
}

/** Map a raw GitHub issue object onto the normalized shape. */
export function normalizeIssue(raw: GithubIssue, scope: string): NormalizedIssue {
  const labels = (raw.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((s) => s.length > 0);
  return {
    trackerId: TRACKER_ID,
    sourceId: buildSourceId(scope, raw.number),
    url: raw.html_url,
    title: raw.title,
    body: raw.body ?? null,
    state: raw.state === "closed" ? "closed" : "open",
    labels,
    assignee: raw.assignee?.login ?? null,
    author: raw.user?.login ?? null,
    createdAtSec: isoToEpochSec(raw.created_at),
    updatedAtSec: isoToEpochSec(raw.updated_at),
    extra: { isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null },
  };
}

function isoToEpochSec(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** True when an error from `request` represents a 404 (HttpError with
 *  status 404). The http wrapper throws `HttpError` with a `.status`
 *  field on non-2xx. */
function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    (e as { status: unknown }).status === 404
  );
}

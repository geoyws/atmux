// Unit tests for the GitHub IssueTracker adapter (ADR-261 Phase 1, §D1/§D2).
//
// All HTTP is faked through the GithubTrackerDeps.httpRequest seam (the
// house DI discipline — no network, no real tokens). The fake mirrors
// http.ts `request()`'s expectStatus contract (status outside the accepted
// set throws HttpError) so the adapter's reliance on that behaviour is
// exercised truthfully, not assumed.
//
// Every assertion checks REAL behaviour: the exact request URL/params/
// headers, the normalized field values, the cursor coordinates, the typed
// error shapes. If the PR filter, the §D3 prefix, the §D4 resume
// coordinates, or the §D7 cascade order were wrong, the matching test
// fails — no shape-only assertions.

import { describe, expect, test } from "bun:test";
import type { HttpRequestOpts, HttpResponse, request } from "../../../../src/abstractions/http.ts";
import {
  createGithubTracker,
  decodeGithubCursor,
  encodeGithubCursor,
  GITHUB_AUTH,
  GITHUB_MAX_PER_PAGE,
  GITHUB_SOURCE_ID_PREFIX,
  GITHUB_TRACKER_ID,
  type GithubTrackerDeps,
  nextPageFromLinkHeader,
  parseGithubSourceId,
  resolveTrackerToken,
  TrackerRateLimitError,
} from "../../../../src/abstractions/trackers/github.ts";
import { ConfigError, HttpError } from "../../../../src/errors.ts";

const SCOPE = "geoyws/atmux";
// Epoch-second literals (independent oracle: `date -u -d <iso> +%s`).
const CREATED_ISO = "2026-06-01T00:00:00Z"; // 1780272000
const UPDATED_ISO = "2026-06-02T03:04:05Z"; // 1780369445
const CREATED_SEC = 1780272000;
const UPDATED_SEC = 1780369445;

// ---------- Fake http (mirrors request()'s expectStatus contract) ----------

interface ScriptedResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function makeFakeHttp(...script: ScriptedResponse[]): {
  fn: typeof request;
  calls: HttpRequestOpts[];
} {
  const calls: HttpRequestOpts[] = [];
  const queue = [...script];
  const fn: typeof request = async (opts) => {
    calls.push(opts);
    const next = queue.shift();
    if (next === undefined) throw new Error(`fake http: unscripted request to ${opts.url}`);
    const status = next.status ?? 200;
    const method = (opts.method ?? "GET").toUpperCase();
    const body = next.body ?? "[]";
    // Mirror http.ts: a status outside the caller's accepted set throws
    // HttpError — the adapter leans on this for listIssues' 404 path.
    const expect = opts.expectStatus ?? { min: 200, max: 299 };
    const accepted = Array.isArray(expect)
      ? expect.includes(status)
      : status >= (expect as { min: number; max: number }).min &&
        status <= (expect as { min: number; max: number }).max;
    if (!accepted) throw new HttpError({ url: opts.url, method, status, body });
    return {
      url: opts.url,
      method,
      status,
      statusText: "",
      headers: new Headers(next.headers ?? {}),
      body,
      // Mirror http.ts, which reads bytes once and decodes `body` from them.
      bytes: new TextEncoder().encode(body),
      durationMs: 1,
    } satisfies HttpResponse;
  };
  return { fn, calls };
}

/** Deps with NO resolvable token (every cascade tier empty). */
function noTokenDeps(fn: typeof request): GithubTrackerDeps {
  return { httpRequest: fn, env: { HOME: "/home/u" }, readTextFile: async () => null };
}

/** A GitHub REST issue row as the API serves it (provider frame — exists
 *  only inside this test + the adapter). */
function ghIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: "boom on start",
    body: "stack trace",
    html_url: `https://github.com/${SCOPE}/issues/1`,
    state: "open",
    labels: [{ name: "bug" }, "p0"],
    user: { login: "alice" },
    assignee: null,
    created_at: CREATED_ISO,
    updated_at: UPDATED_ISO,
    ...over,
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection, got resolution");
}

// ---------- Identity + defaults ----------

describe("identity", () => {
  test("tracker id and §D3 prefix are the frozen 'github' pair", () => {
    expect(GITHUB_TRACKER_ID).toBe("github");
    expect(GITHUB_SOURCE_ID_PREFIX).toBe("github");
    expect(GITHUB_AUTH.envVar).toBe("ATMUX_GITHUB_TOKEN");
    expect(GITHUB_AUTH.configFileBasename).toBe("github-token");
  });

  test("createGithubTracker() with default deps builds a tracker with readonly id 'github'", () => {
    // No network call — only the factory's default-seam binding runs.
    const tracker = createGithubTracker();
    expect(tracker.id).toBe("github");
  });
});

// ---------- listIssues: request shape, mapping, PR filter ----------

describe("listIssues", () => {
  test("first page: URL params, headers, retry delegation, mapping, PR filter", async () => {
    const rows = [
      ghIssue(),
      // GitHub serves PRs on the issues endpoint — must be dropped.
      ghIssue({ number: 2, pull_request: { url: "https://api.github.com/x/pulls/2" } }),
      ghIssue({
        number: 3,
        title: "closed one",
        body: null,
        state: "closed",
        labels: [],
        user: null,
        assignee: { login: "bob" },
        html_url: `https://github.com/${SCOPE}/issues/3`,
      }),
    ];
    const { fn, calls } = makeFakeHttp({ body: JSON.stringify(rows) });
    const tracker = createGithubTracker(noTokenDeps(fn));

    const page = await tracker.listIssues({ scope: SCOPE });

    // Request shape.
    const call = calls[0];
    expect(call).toBeDefined();
    const url = new URL(call?.url ?? "");
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname).toBe(`/repos/${SCOPE}/issues`);
    expect(url.searchParams.get("per_page")).toBe(String(GITHUB_MAX_PER_PAGE));
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("direction")).toBe("asc");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("since")).toBeNull(); // no watermark ⇒ full walk
    expect(call?.method).toBe("GET");
    expect(call?.retry).toBe(2); // 5xx retry delegated to http.ts (§D1)
    const headers = call?.headers ?? {};
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["user-agent"]).toBe("atmux-issue-sync");
    expect(headers.authorization).toBeUndefined(); // unauthenticated mode (§D7)

    // PR filtered: 3 rows in, 2 issues out.
    expect(page.issues).toHaveLength(2);
    expect(page.nextCursor).toBeNull(); // no Link header ⇒ exhausted

    // Full normalized mapping — every NormalizedIssue field.
    expect(page.issues[0]).toEqual({
      trackerId: "github",
      sourceId: `github:${SCOPE}#1`,
      url: `https://github.com/${SCOPE}/issues/1`,
      title: "boom on start",
      body: "stack trace",
      state: "open",
      labels: ["bug", "p0"], // object + string label entries both normalized
      assignee: null,
      author: "alice",
      createdAtSec: CREATED_SEC,
      updatedAtSec: UPDATED_SEC,
      extra: { number: 1 },
    });
    // Closed / unassigned-author / assigned variants.
    expect(page.issues[1]).toEqual({
      trackerId: "github",
      sourceId: `github:${SCOPE}#3`,
      url: `https://github.com/${SCOPE}/issues/3`,
      title: "closed one",
      body: null,
      state: "closed",
      labels: [],
      assignee: "bob",
      author: null,
      createdAtSec: CREATED_SEC,
      updatedAtSec: UPDATED_SEC,
      extra: { number: 3 },
    });
  });

  test("provider frames never leak (§D2): exactly the NormalizedIssue keys, frozen, minimal extra", async () => {
    const { fn } = makeFakeHttp({
      body: JSON.stringify([ghIssue({ milestone: { title: "v9" } })]),
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const { issues } = await tracker.listIssues({ scope: SCOPE });
    const issue = issues[0];
    expect(issue).toBeDefined();
    expect(Object.keys(issue ?? {}).sort()).toEqual([
      "assignee",
      "author",
      "body",
      "createdAtSec",
      "extra",
      "labels",
      "sourceId",
      "state",
      "title",
      "trackerId",
      "updatedAtSec",
      "url",
    ]);
    // extra is minimal — no GitHub fields (milestone etc.) pass through.
    expect(Object.keys(issue?.extra ?? {})).toEqual(["number"]);
    expect(Object.isFrozen(issue)).toBe(true);
    expect(Object.isFrozen(issue?.labels)).toBe(true);
    expect(Object.isFrozen(issue?.extra)).toBe(true);
  });

  test("missing body / missing labels keys normalize to null / []", async () => {
    const row = ghIssue();
    delete row.body;
    delete row.labels;
    const { fn } = makeFakeHttp({ body: JSON.stringify([row]) });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const { issues } = await tracker.listIssues({ scope: SCOPE });
    expect(issues[0]?.body).toBeNull();
    expect(issues[0]?.labels).toEqual([]);
  });

  test("unexpected upstream state maps fail-open to 'open'", async () => {
    const { fn } = makeFakeHttp({ body: JSON.stringify([ghIssue({ state: "wat" })]) });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const { issues } = await tracker.listIssues({ scope: SCOPE });
    expect(issues[0]?.state).toBe("open");
  });

  test("sinceSec watermark renders as an ISO `since` param", async () => {
    const { fn, calls } = makeFakeHttp({ body: "[]" });
    const tracker = createGithubTracker(noTokenDeps(fn));
    await tracker.listIssues({ scope: SCOPE, sinceSec: 1000 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("since")).toBe("1970-01-01T00:16:40.000Z");
  });

  test("pageSize clamps to GitHub's 1..100 per_page range", async () => {
    const cases: Array<[number, string]> = [
      [250, "100"],
      [0, "1"],
      [Number.NaN, "100"],
      [33.7, "33"],
    ];
    for (const [pageSize, expected] of cases) {
      const { fn, calls } = makeFakeHttp({ body: "[]" });
      const tracker = createGithubTracker(noTokenDeps(fn));
      await tracker.listIssues({ scope: SCOPE, pageSize });
      expect(new URL(calls[0]?.url ?? "").searchParams.get("per_page")).toBe(expected);
    }
  });

  test("invalid scope refuses with ConfigError BEFORE any HTTP", async () => {
    const { fn, calls } = makeFakeHttp();
    const tracker = createGithubTracker(noTokenDeps(fn));
    for (const scope of ["no-slash", "a/b/c", "geo yws/repo", "/repo"]) {
      const e = await rejection(tracker.listIssues({ scope }));
      expect(e).toBeInstanceOf(ConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  test("repo-level 404 propagates as HttpError (listIssues does NOT admit 404)", async () => {
    const { fn } = makeFakeHttp({ status: 404, body: '{"message":"Not Found"}' });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(404);
  });

  test("200 with a non-JSON body throws HttpError (frame violation)", async () => {
    const { fn } = makeFakeHttp({ body: "<html>maintenance</html>" });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).body).toContain("did not match the expected frame");
  });

  test("200 with a wrong-shape row throws HttpError (frame violation)", async () => {
    const { fn } = makeFakeHttp({ body: '[{"number":"not-a-number"}]' });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect(e).toBeInstanceOf(HttpError);
  });
});

// ---------- Cursor (§D4): encode/decode + resume ----------

describe("cursor", () => {
  test("encode/decode round-trips every field (watermark, page, perPage)", () => {
    const state = { sinceSec: 1780136430, page: 7, perPage: 50 };
    expect(decodeGithubCursor(encodeGithubCursor(state))).toEqual(state);
  });

  test("round-trips a null watermark (full walk)", () => {
    const state = { sinceSec: null, page: 2, perPage: 100 };
    expect(decodeGithubCursor(encodeGithubCursor(state))).toEqual(state);
  });

  test("malformed cursors fail CLOSED with ConfigError", () => {
    const bad = [
      "garbage",
      '{"v":2,"sinceSec":null,"page":1,"perPage":100}', // unknown version
      '{"v":1,"sinceSec":0.5,"page":1,"perPage":100}', // non-integer watermark
      '{"v":1,"sinceSec":null,"page":0,"perPage":100}', // page < 1
      '{"v":1,"sinceSec":null,"page":1,"perPage":101}', // perPage > GitHub max
      '{"v":1,"sinceSec":null,"page":1,"perPage":100,"x":1}', // strict: extra key
    ];
    for (const cursor of bad) {
      expect(() => decodeGithubCursor(cursor)).toThrow(ConfigError);
    }
  });

  test("Link-header walk: pages chain via cursors until exhausted", async () => {
    const link = (page: number): Record<string, string> => ({
      link: `<https://api.github.com/repos/${SCOPE}/issues?page=${page}>; rel="next", <https://api.github.com/repos/${SCOPE}/issues?page=3>; rel="last"`,
    });
    const { fn, calls } = makeFakeHttp(
      { body: JSON.stringify([ghIssue({ number: 1 })]), headers: link(2) },
      { body: JSON.stringify([ghIssue({ number: 2 })]), headers: link(3) },
      { body: JSON.stringify([ghIssue({ number: 3 })]) },
    );
    const tracker = createGithubTracker(noTokenDeps(fn));
    const got: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await tracker.listIssues({ scope: SCOPE, cursor });
      got.push(...page.issues.map((i) => i.sourceId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(got).toEqual([`github:${SCOPE}#1`, `github:${SCOPE}#2`, `github:${SCOPE}#3`]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  test("a killed sync resumes mid-pagination: fresh adapter, cursor wins over opts", async () => {
    // Walk start: watermark 1000, page size 50; server says next is page 2.
    const first = makeFakeHttp({
      body: JSON.stringify([ghIssue()]),
      headers: {
        link: `<https://api.github.com/repos/${SCOPE}/issues?per_page=50&page=2>; rel="next"`,
      },
    });
    const t1 = createGithubTracker(noTokenDeps(first.fn));
    const page1 = await t1.listIssues({ scope: SCOPE, sinceSec: 1000, pageSize: 50 });
    expect(page1.nextCursor).not.toBeNull();
    // Cursor encodes BOTH the watermark and the page coordinates (§D4).
    expect(decodeGithubCursor(page1.nextCursor ?? "")).toEqual({
      sinceSec: 1000,
      page: 2,
      perPage: 50,
    });

    // ...tick killed here. A FRESH adapter resumes from the checkpoint;
    // conflicting opts.sinceSec/pageSize lose to the cursor's pinned walk
    // coordinates (changing them mid-walk would renumber every page).
    const second = makeFakeHttp({ body: "[]" });
    const t2 = createGithubTracker(noTokenDeps(second.fn));
    await t2.listIssues({
      scope: SCOPE,
      cursor: page1.nextCursor,
      sinceSec: 7777,
      pageSize: 5,
    });
    const url = new URL(second.calls[0]?.url ?? "");
    expect(url.searchParams.get("since")).toBe("1970-01-01T00:16:40.000Z"); // sinceSec 1000
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
  });
});

describe("nextPageFromLinkHeader", () => {
  test("null header ⇒ null (exhausted)", () => {
    expect(nextPageFromLinkHeader(null, 1)).toBeNull();
  });

  test("header without rel=next ⇒ null", () => {
    expect(nextPageFromLinkHeader('<https://x?page=3>; rel="last"', 1)).toBeNull();
  });

  test("rel=next page param wins (also when next is not the first entry)", () => {
    const h = '<https://x?page=9>; rel="prev", <https://x?page=4>; rel="next"';
    expect(nextPageFromLinkHeader(h, 3)).toBe(4);
  });

  test("next link without a usable page param falls back to current+1", () => {
    expect(nextPageFromLinkHeader('<https://x/issues>; rel="next"', 3)).toBe(4);
    expect(nextPageFromLinkHeader('<https://x?page=abc>; rel="next"', 3)).toBe(4);
    expect(nextPageFromLinkHeader('<not a url>; rel="next"', 3)).toBe(4);
  });
});

// ---------- getIssue ----------

describe("getIssue", () => {
  test("fetches by sourceId coordinates and normalizes", async () => {
    const { fn, calls } = makeFakeHttp({
      body: JSON.stringify(ghIssue({ number: 123, state: "closed", assignee: { login: "bob" } })),
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const issue = await tracker.getIssue(`github:${SCOPE}#123`);
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/${SCOPE}/issues/123`);
    expect(issue?.sourceId).toBe(`github:${SCOPE}#123`);
    expect(issue?.state).toBe("closed");
    expect(issue?.assignee).toBe("bob");
    expect(issue?.trackerId).toBe("github");
  });

  test("404 resolves null (the §D4 pending-repair path probes gone ids)", async () => {
    const { fn } = makeFakeHttp({ status: 404, body: '{"message":"Not Found"}' });
    const tracker = createGithubTracker(noTokenDeps(fn));
    expect(await tracker.getIssue(`github:${SCOPE}#999`)).toBeNull();
  });

  test("a sourceId pointing at a pull request resolves null (same filter as listIssues)", async () => {
    const { fn } = makeFakeHttp({
      body: JSON.stringify(ghIssue({ number: 5, pull_request: { url: "https://x/pulls/5" } })),
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    expect(await tracker.getIssue(`github:${SCOPE}#5`)).toBeNull();
  });

  test("200 with a wrong-shape body throws HttpError (frame violation)", async () => {
    const { fn } = makeFakeHttp({ body: '{"message":"moved"}' });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.getIssue(`github:${SCOPE}#1`));
    expect(e).toBeInstanceOf(HttpError);
  });

  test("malformed sourceIds throw ConfigError before any HTTP", async () => {
    const { fn, calls } = makeFakeHttp();
    const tracker = createGithubTracker(noTokenDeps(fn));
    for (const id of ["github:no-number", "ado:org/proj/42", `github:${SCOPE}#0`, "owner/repo#1"]) {
      const e = await rejection(tracker.getIssue(id));
      expect(e).toBeInstanceOf(ConfigError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("parseGithubSourceId", () => {
  test("round-trips a listed issue's sourceId (§D3 prefix correctness)", () => {
    expect(parseGithubSourceId(`github:${SCOPE}#42`)).toEqual({
      scope: SCOPE,
      issueNumber: 42,
    });
  });
});

// ---------- Token cascade (§D7.4) ----------

describe("token cascade", () => {
  test("tier 1: env wins — config file never consulted", async () => {
    const fileReads: string[] = [];
    const { fn, calls } = makeFakeHttp({ body: "[]" });
    const tracker = createGithubTracker({
      httpRequest: fn,
      env: { ATMUX_GITHUB_TOKEN: "tok-env", HOME: "/home/u" },
      readTextFile: async (path) => {
        fileReads.push(path);
        return "tok-file";
      },
    });
    await tracker.listIssues({ scope: SCOPE });
    expect(calls[0]?.headers?.authorization).toBe("Bearer tok-env");
    expect(fileReads).toHaveLength(0);
  });

  test("tier 3: XDG file fallback, trimmed, HOME-derived default path", async () => {
    const fileReads: string[] = [];
    const { fn, calls } = makeFakeHttp({ body: "[]" });
    const tracker = createGithubTracker({
      httpRequest: fn,
      env: { HOME: "/home/u" },
      readTextFile: async (path) => {
        fileReads.push(path);
        return " tok-file\n";
      },
    });
    await tracker.listIssues({ scope: SCOPE });
    expect(fileReads).toEqual(["/home/u/.config/atmux/github-token"]);
    expect(calls[0]?.headers?.authorization).toBe("Bearer tok-file");
  });

  test("tier 3: XDG_CONFIG_HOME overrides the HOME-derived base", async () => {
    const fileReads: string[] = [];
    const { fn } = makeFakeHttp({ body: "[]" });
    const tracker = createGithubTracker({
      httpRequest: fn,
      env: { XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" },
      readTextFile: async (path) => {
        fileReads.push(path);
        return "tok-xdg";
      },
    });
    await tracker.listIssues({ scope: SCOPE });
    expect(fileReads).toEqual(["/xdg/atmux/github-token"]);
  });

  test("no tier resolves ⇒ unauthenticated (empty env strings fall through)", async () => {
    const { fn, calls } = makeFakeHttp({ body: "[]" });
    const tracker = createGithubTracker({
      httpRequest: fn,
      env: { ATMUX_GITHUB_TOKEN: "", XDG_CONFIG_HOME: "", HOME: "" },
      readTextFile: async () => "   \n", // whitespace-only file ⇒ no token
    });
    await tracker.listIssues({ scope: SCOPE });
    expect(calls[0]?.headers?.authorization).toBeUndefined();
  });

  test("resolveTrackerToken tier 2: team.json literal beats the file, loses to env", async () => {
    const auth = { envVar: "T_X", teamJsonToken: "tok-team", configFileBasename: "x-token" };
    const noFile = async (): Promise<string | null> => null;
    expect(await resolveTrackerToken(auth, { env: {}, readTextFile: noFile })).toBe("tok-team");
    expect(await resolveTrackerToken(auth, { env: { T_X: "tok-env" }, readTextFile: noFile })).toBe(
      "tok-env",
    );
    // Empty tier-2 literal falls through to the file.
    expect(
      await resolveTrackerToken(
        { ...auth, teamJsonToken: "" },
        { env: { HOME: "/h" }, readTextFile: async () => "tok-file" },
      ),
    ).toBe("tok-file");
    // Nothing anywhere ⇒ null.
    expect(
      await resolveTrackerToken(
        { envVar: "T_X", configFileBasename: "x-token" },
        { env: {}, readTextFile: noFile },
      ),
    ).toBeNull();
  });
});

// ---------- Rate-limit hygiene (§D1) ----------

describe("rate limit", () => {
  test("403 + x-ratelimit-remaining:0 throws TrackerRateLimitError with the reset epoch — token never leaks", async () => {
    const { fn, calls } = makeFakeHttp({
      status: 403,
      body: '{"message":"API rate limit exceeded"}',
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1765432100" },
    });
    const tracker = createGithubTracker({
      httpRequest: fn,
      env: { ATMUX_GITHUB_TOKEN: "sekrit-token", HOME: "/home/u" },
      readTextFile: async () => null,
    });
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect(e).toBeInstanceOf(TrackerRateLimitError);
    const err = e as TrackerRateLimitError;
    expect(err.tag).toBe("tracker-rate-limit");
    expect(err.trackerId).toBe("github");
    expect(err.resetAtSec).toBe(1765432100);
    expect(err.context.status).toBe(403);
    // The token rode the Authorization header ONLY (§D7.5) — never the
    // error message/context, never the URL.
    expect(calls[0]?.headers?.authorization).toBe("Bearer sekrit-token");
    expect(err.message).not.toContain("sekrit-token");
    expect(JSON.stringify(err.context)).not.toContain("sekrit-token");
    expect(calls[0]?.url ?? "").not.toContain("sekrit-token");
  });

  test("429 without a reset header ⇒ resetAtSec null (never fabricated)", async () => {
    const { fn } = makeFakeHttp({
      status: 429,
      headers: { "x-ratelimit-remaining": "0" },
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect(e).toBeInstanceOf(TrackerRateLimitError);
    expect((e as TrackerRateLimitError).resetAtSec).toBeNull();
  });

  test("garbled reset header ⇒ resetAtSec null", async () => {
    const { fn } = makeFakeHttp({
      status: 429,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" },
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect((e as TrackerRateLimitError).resetAtSec).toBeNull();
  });

  test("403 WITHOUT remaining:0 is a plain HttpError (bad credentials ≠ rate limit)", async () => {
    const { fn } = makeFakeHttp({
      status: 403,
      body: '{"message":"Bad credentials"}',
      headers: { "x-ratelimit-remaining": "4999" },
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.listIssues({ scope: SCOPE }));
    expect(e).toBeInstanceOf(HttpError);
    expect(e).not.toBeInstanceOf(TrackerRateLimitError);
    expect((e as HttpError).status).toBe(403);
  });

  test("getIssue surfaces the same typed rate-limit error", async () => {
    const { fn } = makeFakeHttp({
      status: 429,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1765432100" },
    });
    const tracker = createGithubTracker(noTokenDeps(fn));
    const e = await rejection(tracker.getIssue(`github:${SCOPE}#1`));
    expect(e).toBeInstanceOf(TrackerRateLimitError);
    expect((e as TrackerRateLimitError).resetAtSec).toBe(1765432100);
  });
});

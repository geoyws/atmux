// ADR-263 §D3 (P3): GitHub issue-tracker adapter tests.
//
// The adapter's `requestFn` is dependency-injected, so every test runs
// against a stubbed wire — no network, no `gh` CLI. Pure helpers
// (parseScope / parseSourceId / nextPageFromLinkHeader / normalizeIssue)
// are tested directly; `listIssues` / `getIssue` against the stub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpRequestOpts, HttpResponse } from "../../../../src/abstractions/http.ts";
import {
  buildSourceId,
  GITHUB_AUTH,
  makeGithubTracker,
  nextPageFromLinkHeader,
  normalizeIssue,
  parseIssueArray,
  parseScope,
  parseSourceId,
  resolveTrackerToken,
} from "../../../../src/abstractions/trackers/github.ts";
import { HttpError } from "../../../../src/errors.ts";

/** A canned GitHub issue object (subset). */
function ghIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Crash on save",
    body: "stack trace here",
    state: "open",
    html_url: "https://github.com/o/r/issues/7",
    labels: [{ name: "bug" }, { name: "p1" }],
    assignee: { login: "alice" },
    user: { login: "bob" },
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
    ...over,
  };
}

/** Build a stub `requestFn` that returns the given body + headers and
 *  records the URLs it was called with. */
function stubRequest(
  body: string,
  headers: Headers = new Headers(),
): { fn: (o: HttpRequestOpts) => Promise<HttpResponse>; calls: string[] } {
  const calls: string[] = [];
  const fn = async (o: HttpRequestOpts): Promise<HttpResponse> => {
    calls.push(o.url);
    return {
      url: o.url,
      method: o.method ?? "GET",
      status: 200,
      statusText: "OK",
      headers,
      body,
      durationMs: 1,
    };
  };
  return { fn, calls };
}

// ---------- pure helpers ----------

describe("parseScope", () => {
  test("splits owner/repo", () => {
    expect(parseScope("octocat/hello")).toEqual({ owner: "octocat", repo: "hello" });
  });
  test("trims surrounding whitespace", () => {
    expect(parseScope("  a/b  ")).toEqual({ owner: "a", repo: "b" });
  });
  test("throws on malformed scope", () => {
    expect(() => parseScope("no-slash")).toThrow(/invalid scope/);
    expect(() => parseScope("a/b/c")).toThrow(/invalid scope/);
  });
});

describe("parseSourceId", () => {
  test("parses a canonical github sourceId", () => {
    expect(parseSourceId("github:octocat/hello#42")).toEqual({
      owner: "octocat",
      repo: "hello",
      number: 42,
    });
  });
  test("returns null on a foreign / malformed id", () => {
    expect(parseSourceId("ado:org/proj/3")).toBeNull();
    expect(parseSourceId("github:octocat/hello")).toBeNull();
    expect(parseSourceId("nonsense")).toBeNull();
  });
});

describe("buildSourceId", () => {
  test("composes prefix + scope + number", () => {
    expect(buildSourceId("octocat/hello", 9)).toBe("github:octocat/hello#9");
  });
});

describe("nextPageFromLinkHeader", () => {
  test("extracts the rel=next page number", () => {
    const h = new Headers({
      link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=5>; rel="last"',
    });
    expect(nextPageFromLinkHeader(h)).toBe("2");
  });
  test("returns null when there is no next rel", () => {
    const h = new Headers({
      link: '<https://api.github.com/repositories/1/issues?page=1>; rel="prev"',
    });
    expect(nextPageFromLinkHeader(h)).toBeNull();
  });
  test("returns null when no Link header present", () => {
    expect(nextPageFromLinkHeader(new Headers())).toBeNull();
  });
  test("returns null when the rel=next URL is malformed (treated as exhausted)", () => {
    const h = new Headers({ link: '<::not-a-url::>; rel="next"' });
    expect(nextPageFromLinkHeader(h)).toBeNull();
  });
  test("returns null when rel=next URL has no page param", () => {
    const h = new Headers({ link: '<https://api.github.com/x>; rel="next"' });
    expect(nextPageFromLinkHeader(h)).toBeNull();
  });
});

describe("normalizeIssue", () => {
  test("maps a full issue object", () => {
    const n = normalizeIssue(ghIssue() as never, "o/r");
    expect(n).toEqual({
      trackerId: "github",
      sourceId: "github:o/r#7",
      url: "https://github.com/o/r/issues/7",
      title: "Crash on save",
      body: "stack trace here",
      state: "open",
      labels: ["bug", "p1"],
      assignee: "alice",
      author: "bob",
      createdAtSec: Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000),
      updatedAtSec: Math.floor(Date.parse("2026-06-02T00:00:00Z") / 1000),
      extra: { isPullRequest: false },
    });
  });
  test("null body + null assignee tolerated", () => {
    const n = normalizeIssue(ghIssue({ body: null, assignee: null }) as never, "o/r");
    expect(n.body).toBeNull();
    expect(n.assignee).toBeNull();
  });
  test("closed state normalized", () => {
    expect(normalizeIssue(ghIssue({ state: "closed" }) as never, "o/r").state).toBe("closed");
  });
  test("pull_request marker flips isPullRequest", () => {
    const n = normalizeIssue(ghIssue({ pull_request: { url: "x" } }) as never, "o/r");
    expect(n.extra.isPullRequest).toBe(true);
  });
  test("string labels (legacy shape) tolerated; empties dropped", () => {
    const n = normalizeIssue(
      ghIssue({ labels: ["bug", { name: "" }, { name: "x" }] }) as never,
      "o/r",
    );
    expect(n.labels).toEqual(["bug", "x"]);
  });
});

describe("parseIssueArray", () => {
  test("maps a JSON array", () => {
    const arr = JSON.stringify([ghIssue(), ghIssue({ number: 8, title: "Other" })]);
    const out = parseIssueArray(arr, "o/r");
    expect(out.map((i) => i.sourceId)).toEqual(["github:o/r#7", "github:o/r#8"]);
  });
  test("throws when the body is not an array", () => {
    expect(() => parseIssueArray(JSON.stringify({ message: "Not Found" }), "o/r")).toThrow(
      /expected a JSON array/,
    );
  });
});

// ---------- listIssues / getIssue against the stub ----------

describe("makeGithubTracker.listIssues", () => {
  test("builds the request URL with state/labels/since/page params", async () => {
    const { fn, calls } = stubRequest(JSON.stringify([ghIssue()]));
    const tracker = makeGithubTracker({ requestFn: fn, token: "t0" });
    const page = await tracker.listIssues({
      scope: "o/r",
      state: "all",
      labels: ["bug", "p1"],
      sinceSec: Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
      cursor: "3",
    });
    expect(page.issues).toHaveLength(1);
    const url = new URL(calls[0] as string);
    expect(url.pathname).toBe("/repos/o/r/issues");
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("labels")).toBe("bug,p1");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00.000Z");
  });

  test("defaults state=open and page=1 when unspecified", async () => {
    const { fn, calls } = stubRequest(JSON.stringify([]));
    const tracker = makeGithubTracker({ requestFn: fn });
    await tracker.listIssues({ scope: "o/r" });
    const url = new URL(calls[0] as string);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("page")).toBe("1");
  });

  test("surfaces the next-page cursor from the Link header", async () => {
    const h = new Headers({ link: '<https://api.github.com/x?page=2>; rel="next"' });
    const { fn } = stubRequest(JSON.stringify([ghIssue()]), h);
    const tracker = makeGithubTracker({ requestFn: fn });
    const page = await tracker.listIssues({ scope: "o/r" });
    expect(page.nextCursor).toBe("2");
  });

  test("clamps pageSize to the GitHub max (100)", async () => {
    const { fn, calls } = stubRequest(JSON.stringify([]));
    const tracker = makeGithubTracker({ requestFn: fn });
    await tracker.listIssues({ scope: "o/r", pageSize: 5000 });
    expect(new URL(calls[0] as string).searchParams.get("per_page")).toBe("100");
  });
});

describe("makeGithubTracker.getIssue", () => {
  test("fetches + normalizes a single issue", async () => {
    const { fn, calls } = stubRequest(JSON.stringify(ghIssue({ number: 42 })));
    const tracker = makeGithubTracker({ requestFn: fn });
    const issue = await tracker.getIssue("github:o/r#42");
    expect(issue?.sourceId).toBe("github:o/r#42");
    expect(new URL(calls[0] as string).pathname).toBe("/repos/o/r/issues/42");
  });

  test("returns null on a foreign sourceId without calling the wire", async () => {
    const { fn, calls } = stubRequest("{}");
    const tracker = makeGithubTracker({ requestFn: fn });
    expect(await tracker.getIssue("ado:org/proj/1")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("returns null on a 404 (gone / no read access)", async () => {
    const fn = async (o: HttpRequestOpts): Promise<HttpResponse> => {
      throw new HttpError({ url: o.url, method: "GET", status: 404, body: "not found" });
    };
    const tracker = makeGithubTracker({ requestFn: fn });
    expect(await tracker.getIssue("github:o/r#99")).toBeNull();
  });

  test("re-throws non-404 HTTP errors", async () => {
    const fn = async (o: HttpRequestOpts): Promise<HttpResponse> => {
      throw new HttpError({ url: o.url, method: "GET", status: 500, body: "boom" });
    };
    const tracker = makeGithubTracker({ requestFn: fn });
    await expect(tracker.getIssue("github:o/r#99")).rejects.toThrow(/HTTP 500/);
  });
});

describe("auth headers", () => {
  test("Authorization: Bearer set when a token is present", async () => {
    let seen: Record<string, string> | undefined;
    const fn = async (o: HttpRequestOpts): Promise<HttpResponse> => {
      seen = o.headers as Record<string, string>;
      return {
        url: o.url,
        method: "GET",
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: "[]",
        durationMs: 1,
      };
    };
    const tracker = makeGithubTracker({ requestFn: fn, token: "secret" });
    await tracker.listIssues({ scope: "o/r" });
    expect(seen?.authorization).toBe("Bearer secret");
  });

  test("no Authorization header when token is null", async () => {
    let seen: Record<string, string> | undefined;
    const fn = async (o: HttpRequestOpts): Promise<HttpResponse> => {
      seen = o.headers as Record<string, string>;
      return {
        url: o.url,
        method: "GET",
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        body: "[]",
        durationMs: 1,
      };
    };
    const tracker = makeGithubTracker({ requestFn: fn, token: null });
    await tracker.listIssues({ scope: "o/r" });
    expect(seen?.authorization).toBeUndefined();
  });
});

describe("resolveTrackerToken", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "atmux-gh-token-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("tier 1: env var wins", async () => {
    const t = await resolveTrackerToken(GITHUB_AUTH, { ATMUX_GITHUB_TOKEN: "from-env" });
    expect(t).toBe("from-env");
  });

  test("tier 2: team.json literal when no env", async () => {
    const t = await resolveTrackerToken({ ...GITHUB_AUTH, teamJsonToken: "from-team" }, {});
    expect(t).toBe("from-team");
  });

  test("tier 3: config file when no env / literal", async () => {
    await mkdir(join(home, "atmux"), { recursive: true });
    await writeFile(join(home, "atmux", "github-token"), "from-file\n");
    const t = await resolveTrackerToken(GITHUB_AUTH, { XDG_CONFIG_HOME: home });
    expect(t).toBe("from-file");
  });

  test("returns null when nothing configured", async () => {
    const t = await resolveTrackerToken(GITHUB_AUTH, { XDG_CONFIG_HOME: home });
    expect(t).toBeNull();
  });

  test("env precedence over file", async () => {
    await mkdir(join(home, "atmux"), { recursive: true });
    await writeFile(join(home, "atmux", "github-token"), "from-file");
    const t = await resolveTrackerToken(GITHUB_AUTH, {
      ATMUX_GITHUB_TOKEN: "from-env",
      XDG_CONFIG_HOME: home,
    });
    expect(t).toBe("from-env");
  });
});

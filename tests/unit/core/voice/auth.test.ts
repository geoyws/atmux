// Unit tests for src/core/voice/auth.ts — ADR-272 upgrade-gate helpers.
//
// Pins:
//   - checkToken: sha256 + timingSafeEqual; null/undefined/empty candidates
//     never match a non-empty expected token.
//   - extractToken precedence: Authorization Bearer → ?token= → cookie.
//   - checkOrigin: ABSENT origin allowed; present must URL-normalize-match
//     an allowlist entry; garbage never matches.
//   - authorizeUpgrade ordering: ORIGIN first (4403), then token (4401) —
//     asserted with a request that fails both.

import { describe, expect, test } from "bun:test";
import {
  authorizeUpgrade,
  checkOrigin,
  checkToken,
  extractToken,
} from "../../../../src/core/voice/auth.ts";
import { VOICE_CLOSE } from "../../../../src/schema/voice.ts";

const EXPECTED = "sekrit-token-1";

describe("checkToken", () => {
  test.each([
    ["exact match", EXPECTED, true],
    ["mismatch", "wrong", false],
    ["prefix is not a match", "sekrit-token", false],
    ["longer candidate is not a match", `${EXPECTED}x`, false],
    ["empty candidate", "", false],
  ])("%s → %p", (_name, candidate, expected) => {
    expect(checkToken(candidate, EXPECTED)).toBe(expected);
  });

  test("null and undefined candidates are false", () => {
    expect(checkToken(null, EXPECTED)).toBe(false);
    expect(checkToken(undefined, EXPECTED)).toBe(false);
  });

  test("empty candidate matches empty expected (config layer gates empties)", () => {
    expect(checkToken("", "")).toBe(true);
  });
});

describe("extractToken precedence", () => {
  const url = (search = "") => new URL(`https://voice.example/ws${search}`);

  test("Authorization Bearer wins over query + cookie", () => {
    const headers = new Headers({
      authorization: "Bearer from-header",
      cookie: "atmux_voice=from-cookie",
    });
    expect(extractToken(headers, url("?token=from-query"))).toBe("from-header");
  });

  test("Bearer scheme is case-insensitive", () => {
    expect(extractToken(new Headers({ authorization: "bearer abc" }), url())).toBe("abc");
  });

  test("non-Bearer Authorization falls through to query", () => {
    const headers = new Headers({ authorization: "Basic dXNlcjpwdw==" });
    expect(extractToken(headers, url("?token=from-query"))).toBe("from-query");
  });

  test("query param when no Authorization header", () => {
    expect(extractToken(new Headers(), url("?token=q-tok"))).toBe("q-tok");
  });

  test("empty ?token= falls through to cookie", () => {
    const headers = new Headers({ cookie: "atmux_voice=c-tok" });
    expect(extractToken(headers, url("?token="))).toBe("c-tok");
  });

  test("cookie parsed out of a multi-cookie header", () => {
    const headers = new Headers({ cookie: "a=1; atmux_voice=c-tok; b=2" });
    expect(extractToken(headers, url())).toBe("c-tok");
  });

  test("cookie header without atmux_voice → null", () => {
    const headers = new Headers({ cookie: "a=1; b=2" });
    expect(extractToken(headers, url())).toBeNull();
  });

  test("no sources at all → null", () => {
    expect(extractToken(new Headers(), url())).toBeNull();
  });
});

describe("checkOrigin", () => {
  const ALLOW = ["https://voice.example", "https://app.example:8443"] as const;

  test("absent Origin is allowed (native/probe clients)", () => {
    expect(checkOrigin(null, ALLOW)).toBe(true);
    expect(checkOrigin(null, [])).toBe(true);
  });

  test("exact allowlist match", () => {
    expect(checkOrigin("https://voice.example", ALLOW)).toBe(true);
    expect(checkOrigin("https://app.example:8443", ALLOW)).toBe(true);
  });

  test("URL normalization: default port + trailing slash + path collapse to origin", () => {
    expect(checkOrigin("https://voice.example:443", ALLOW)).toBe(true);
    expect(checkOrigin("https://voice.example/", ALLOW)).toBe(true);
    expect(checkOrigin("https://voice.example", ["https://voice.example:443/some/path"])).toBe(
      true,
    );
  });

  test("mismatches: wrong host / scheme / port", () => {
    expect(checkOrigin("https://evil.example", ALLOW)).toBe(false);
    expect(checkOrigin("http://voice.example", ALLOW)).toBe(false);
    expect(checkOrigin("https://app.example:9443", ALLOW)).toBe(false);
    expect(checkOrigin("https://voice.example", [])).toBe(false);
  });

  test("garbage origins never match (including the opaque 'null' origin)", () => {
    expect(checkOrigin("not a url", ALLOW)).toBe(false);
    expect(checkOrigin("null", ALLOW)).toBe(false);
    expect(checkOrigin("", ALLOW)).toBe(false);
  });

  test("malformed allowlist entry is skipped, later valid entry still matches", () => {
    expect(checkOrigin("https://voice.example", ["%%%not-a-url", "https://voice.example"])).toBe(
      true,
    );
    expect(checkOrigin("https://voice.example", ["%%%not-a-url"])).toBe(false);
  });
});

describe("authorizeUpgrade", () => {
  const ORIGINS = ["https://voice.example"] as const;
  const make = (opts: { origin?: string; auth?: string; cookie?: string; search?: string }) => {
    const headers = new Headers();
    if (opts.origin !== undefined) headers.set("origin", opts.origin);
    if (opts.auth !== undefined) headers.set("authorization", opts.auth);
    if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
    return {
      headers,
      url: new URL(`https://voice.example/ws${opts.search ?? ""}`),
      expectedToken: EXPECTED,
      origins: ORIGINS,
    };
  };

  test("good origin + Bearer token → ok", () => {
    expect(
      authorizeUpgrade(make({ origin: "https://voice.example", auth: `Bearer ${EXPECTED}` })),
    ).toEqual({ ok: true });
  });

  test("absent origin + query token → ok", () => {
    expect(authorizeUpgrade(make({ search: `?token=${EXPECTED}` }))).toEqual({ ok: true });
  });

  test("cookie token → ok", () => {
    expect(authorizeUpgrade(make({ cookie: `atmux_voice=${EXPECTED}` }))).toEqual({ ok: true });
  });

  test("bad origin with a VALID token → 4403 (origin gates first)", () => {
    expect(
      authorizeUpgrade(make({ origin: "https://evil.example", auth: `Bearer ${EXPECTED}` })),
    ).toEqual({ ok: false, closeCode: 4403 });
  });

  test("bad origin AND bad token → 4403, not 4401 (ordering pin)", () => {
    expect(
      authorizeUpgrade(make({ origin: "https://evil.example", auth: "Bearer wrong" })),
    ).toEqual({ ok: false, closeCode: 4403 });
  });

  test("good origin + wrong token → 4401", () => {
    expect(
      authorizeUpgrade(make({ origin: "https://voice.example", auth: "Bearer wrong" })),
    ).toEqual({ ok: false, closeCode: 4401 });
  });

  test("no token anywhere → 4401", () => {
    expect(authorizeUpgrade(make({}))).toEqual({ ok: false, closeCode: 4401 });
  });

  test("close codes line up with VOICE_CLOSE", () => {
    expect(VOICE_CLOSE.ORIGIN).toBe(4403);
    expect(VOICE_CLOSE.AUTH).toBe(4401);
  });
});

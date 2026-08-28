// Unit tests for src/core/vox/model-check.ts — ADR-272 §Supplement
// (model-pin drift guard).
//
// No network, ever: the HTTP call is an injected seam.
//
// The four properties that make this guard safe rather than merely
// present, each with the failure it prevents:
//
//   1. **A network failure is `unreachable`, not `missing`.** Reporting
//      an egress hiccup as MODEL PIN DRIFT would send the operator
//      hunting a model id that is fine — and after two of those he stops
//      reading the warning, which is how the guard dies.
//   2. **It never throws.** It runs at boot; a throw would be able to
//      stop the voice server from starting, trading a rare loud problem
//      for a common total one.
//   3. **The API key never appears in any rendered line.** A boot banner
//      is exactly the kind of output that gets pasted into a chat.
//   4. **`missing` is unmistakable.** The previous version of this
//      failure was a silent 4500 sixty-eight seconds into a phone call;
//      a verdict that scrolled past as one more info line would not have
//      prevented it.

import { describe, expect, test } from "bun:test";
import {
  checkModelPin,
  describeFetchFailure,
  fetchModelListBody,
  formatModelCheck,
  MODEL_CHECK_TIMEOUT_MS,
  MODEL_SUGGESTION_LIMIT,
  type ModelCheckResult,
  SKIP_MODEL_CHECK_ENV,
  suggestModels,
} from "../../../../src/core/vox/model-check.ts";
import { HttpError, HttpTimeoutError } from "../../../../src/errors.ts";

const KEY = "sk-live-secret-value-9f3a";

/** The live Gemini pin — a DATED PREVIEW id, i.e. the one this guard
 *  exists for. */
const PINNED = "gemini-2.5-flash-native-audio-preview-09-2025";

function geminiBody(ids: string[]): string {
  return JSON.stringify({ models: ids.map((id) => ({ name: `models/${id}` })) });
}

function openaiBody(ids: string[]): string {
  return JSON.stringify({ data: ids.map((id) => ({ id })) });
}

describe("checkModelPin — verdicts", () => {
  test("model present → ok, with the list size as evidence", async () => {
    const r = await checkModelPin({
      kind: "openai-realtime",
      model: "gpt-realtime",
      apiKey: KEY,
      env: {},
      fetchBody: async () => openaiBody(["gpt-4o", "gpt-realtime", "o3"]),
    });
    expect(r).toMatchObject({ status: "ok", available: 3, suggestions: [], detail: null });
  });

  test("a RETIRED dated-preview id → missing, with near-miss suggestions", async () => {
    const r = await checkModelPin({
      kind: "gemini-live",
      model: PINNED,
      apiKey: KEY,
      env: {},
      fetchBody: async () =>
        geminiBody([
          "gemini-2.5-flash",
          "gemini-2.5-flash-native-audio-latest",
          "gemini-2.5-flash-preview-native-audio-dialog",
          "gemini-2.5-pro",
        ]),
    });
    expect(r.status).toBe("missing");
    expect(r.available).toBe(4);
    expect(r.suggestions[0]).toBe("gemini-2.5-flash-native-audio-latest");
  });

  test("the check reads the CONFIGURED model, not a hard-coded one", async () => {
    // Same list, two different pins, two different verdicts.
    const list = async (): Promise<string> => geminiBody(["gemini-a", "gemini-b"]);
    expect(
      (
        await checkModelPin({
          kind: "gemini-live",
          model: "gemini-a",
          apiKey: KEY,
          env: {},
          fetchBody: list,
        })
      ).status,
    ).toBe("ok");
    expect(
      (
        await checkModelPin({
          kind: "gemini-live",
          model: "gemini-z",
          apiKey: KEY,
          env: {},
          fetchBody: list,
        })
      ).status,
    ).toBe("missing");
  });

  test("an exact match is required — a prefix is NOT a match", async () => {
    const r = await checkModelPin({
      kind: "gemini-live",
      model: "gemini-2.5-flash",
      apiKey: KEY,
      env: {},
      fetchBody: async () => geminiBody(["gemini-2.5-flash-native-audio-latest"]),
    });
    expect(r.status).toBe("missing");
  });
});

describe("checkModelPin — it must NOT be able to stop a boot", () => {
  test("a network failure is `unreachable`, never `missing`", async () => {
    const r = await checkModelPin({
      kind: "openai-realtime",
      model: "gpt-realtime",
      apiKey: KEY,
      env: {},
      fetchBody: async () => {
        throw new HttpError({ url: "https://x", method: "GET", status: 0, body: "" });
      },
    });
    // The distinction IS the safety: an egress hiccup reported as drift
    // trains the operator to ignore the drift warning.
    expect(r.status).toBe("unreachable");
    expect(r.available).toBeNull();
    expect(r.suggestions).toEqual([]);
  });

  test("a timeout is `unreachable`", async () => {
    const r = await checkModelPin({
      kind: "openai-realtime",
      model: "gpt-realtime",
      apiKey: KEY,
      env: {},
      fetchBody: async () => {
        throw new HttpTimeoutError({ url: "https://x", method: "GET", timeoutMs: 3000 });
      },
    });
    expect(r.status).toBe("unreachable");
    expect(r.detail).toContain("timed out");
  });

  test("a 401 says the KEY was rejected, not that the model drifted", async () => {
    const r = await checkModelPin({
      kind: "openai-realtime",
      model: "gpt-realtime",
      apiKey: KEY,
      env: {},
      fetchBody: async () => {
        throw new HttpError({ url: "https://x", method: "GET", status: 401, body: "nope" });
      },
    });
    expect(r.status).toBe("unreachable");
    expect(r.detail).toContain("rejected the API key");
  });

  test("an unrecognised response shape is `unreachable`, not a drift claim", async () => {
    const r = await checkModelPin({
      kind: "gemini-live",
      model: PINNED,
      apiKey: KEY,
      env: {},
      fetchBody: async () => '{"unexpected":"envelope"}',
    });
    expect(r.status).toBe("unreachable");
    expect(r.detail).toContain("documented shape");
  });

  test("checkModelPin RESOLVES on every failure path — it never rejects", async () => {
    // Boot calls this. A rejection would be able to take the server down.
    const r = await checkModelPin({
      kind: "gemini-live",
      model: PINNED,
      apiKey: KEY,
      env: {},
      fetchBody: async () => {
        throw new Error("something nobody anticipated");
      },
    });
    expect(r.status).toBe("unreachable");
    expect(r.detail).toBe("something nobody anticipated");
  });
});

describe("checkModelPin — the skip flag", () => {
  test.each([["1"], ["true"], ["TRUE"]])("%s skips the check entirely", async (raw) => {
    let called = false;
    const r = await checkModelPin({
      kind: "gemini-live",
      model: PINNED,
      apiKey: KEY,
      env: { [SKIP_MODEL_CHECK_ENV]: raw },
      fetchBody: async () => {
        called = true;
        return geminiBody([]);
      },
    });
    expect(r.status).toBe("skipped");
    expect(called).toBe(false);
  });

  test("anything else does NOT skip — the flag fails closed toward checking", async () => {
    const r = await checkModelPin({
      kind: "gemini-live",
      model: "gemini-a",
      apiKey: KEY,
      env: { [SKIP_MODEL_CHECK_ENV]: "no" },
      fetchBody: async () => geminiBody(["gemini-a"]),
    });
    expect(r.status).toBe("ok");
  });

  test("unset does not skip", async () => {
    const r = await checkModelPin({
      kind: "gemini-live",
      model: "gemini-a",
      apiKey: KEY,
      env: {},
      fetchBody: async () => geminiBody(["gemini-a"]),
    });
    expect(r.status).toBe("ok");
  });
});

describe("the PRODUCTION http path (loopback only — no provider is ever dialled)", () => {
  // Every other test injects `fetchBody`. A seam that is always injected
  // is a seam nobody has proved works, so this drives the real one
  // against a local `Bun.serve` — which is also the only place the
  // end-to-end "the key rides a HEADER, never the URL" property is
  // observable rather than merely constructed.
  test("issues one GET, carries the auth header, and returns the body verbatim", async () => {
    const seen: Array<{ url: string; auth: string | null; method: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push({
          url: req.url,
          auth: req.headers.get("x-goog-api-key"),
          method: req.method,
        });
        return new Response(geminiBody(["gemini-a"]));
      },
    });
    try {
      const body = await fetchModelListBody(
        { url: `http://127.0.0.1:${server.port}/models`, headers: { "x-goog-api-key": KEY } },
        MODEL_CHECK_TIMEOUT_MS,
      );
      expect(body).toBe(geminiBody(["gemini-a"]));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe("GET");
      expect(seen[0]?.auth).toBe(KEY);
      expect(seen[0]?.url).not.toContain(KEY);
    } finally {
      server.stop(true);
    }
  });

  test("a non-2xx throws, and does NOT retry (the budget is boot latency)", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        hits += 1;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      await expect(
        fetchModelListBody({ url: `http://127.0.0.1:${server.port}/x`, headers: {} }),
      ).rejects.toThrow();
      // A 5xx is the one status `request()` would retry if a budget were
      // set. Exactly one hit proves none is.
      expect(hits).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("the default timeout is a boot-latency budget, not the HTTP default", () => {
    expect(MODEL_CHECK_TIMEOUT_MS).toBeLessThan(10_000);
    expect(MODEL_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("suggestModels", () => {
  test("ranks by shared prefix — the drift is always in the SUFFIX", () => {
    expect(
      suggestModels(PINNED, [
        "gemini-2.5-pro",
        "gemini-2.5-flash-native-audio-latest",
        "gemini-2.5-flash",
      ]),
    ).toEqual(["gemini-2.5-flash-native-audio-latest", "gemini-2.5-flash", "gemini-2.5-pro"]);
  });

  test("caps the list so the warning stays readable", () => {
    const many = Array.from({ length: 20 }, (_, i) => `gemini-2.5-flash-x${i}`);
    expect(suggestModels(PINNED, many)).toHaveLength(MODEL_SUGGESTION_LIMIT);
  });

  test("models sharing nothing are dropped rather than padded in", () => {
    expect(suggestModels(PINNED, ["whisper-1", "dall-e-3"])).toEqual([]);
  });

  test("ties break alphabetically, so the suggestion list is deterministic", () => {
    expect(suggestModels("gem", ["gemB", "gemA"])).toEqual(["gemA", "gemB"]);
  });
});

describe("describeFetchFailure", () => {
  test("a non-auth, non-zero status names the code", () => {
    expect(
      describeFetchFailure(new HttpError({ url: "u", method: "GET", status: 500, body: "" })),
    ).toContain("HTTP 500");
  });

  test("403 is treated like 401", () => {
    expect(
      describeFetchFailure(new HttpError({ url: "u", method: "GET", status: 403, body: "" })),
    ).toContain("rejected the API key");
  });

  test("a non-Error throw still yields a string", () => {
    expect(describeFetchFailure("plain string")).toBe("plain string");
  });
});

describe("formatModelCheck — what the operator actually reads", () => {
  const base: ModelCheckResult = {
    status: "ok",
    kind: "gemini-live",
    model: PINNED,
    available: 312,
    suggestions: [],
    detail: null,
  };

  test("ok is ONE quiet line — a check that shouts when fine trains skimming", () => {
    const lines = formatModelCheck(base);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("model check ok");
    expect(lines[0]).toContain(`gemini-live/${PINNED}`);
    expect(lines[0]).toContain("312");
  });

  test("missing is a multi-line banner naming the fix and the consequence", () => {
    const lines = formatModelCheck({
      ...base,
      status: "missing",
      suggestions: ["gemini-2.5-flash-native-audio-latest"],
    });
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(4);
    expect(text).toContain("MODEL PIN DRIFT");
    expect(text).toContain(PINNED);
    expect(text).toContain("4500");
    expect(text).toContain("gemini-2.5-flash-native-audio-latest");
    expect(text).toContain("ATMUX_VOX_MODEL");
    expect(text).toContain(SKIP_MODEL_CHECK_ENV);
  });

  test("missing with NO near miss says so rather than printing an empty list", () => {
    const text = formatModelCheck({ ...base, status: "missing" }).join("\n");
    expect(text).toContain("No similarly-named model");
  });

  test("unreachable says the pin is UNVERIFIED — not that it is wrong", () => {
    const text = formatModelCheck({
      ...base,
      status: "unreachable",
      available: null,
      detail: "the provider's model list timed out",
    }).join("\n");
    expect(text).toContain("UNVERIFIED");
    expect(text).not.toContain("DRIFT");
  });

  test("skipped warns that a retired id will NOT be caught", () => {
    const text = formatModelCheck({
      ...base,
      status: "skipped",
      available: null,
      detail: `${SKIP_MODEL_CHECK_ENV} is set`,
    }).join("\n");
    expect(text).toContain("SKIPPED");
    expect(text).toContain("will not be caught");
  });

  test("NO rendered line can contain the API key, on any status", async () => {
    // The key is never passed to the formatter, but the property worth
    // pinning is end-to-end: run the real check for every status and
    // grep every line.
    const cases: Array<[ModelCheckResult["status"], () => Promise<string>]> = [
      ["ok", async () => geminiBody([PINNED])],
      ["missing", async () => geminiBody(["something-else"])],
      [
        "unreachable",
        async () => {
          throw new HttpError({
            url: `https://x?key=${KEY}`,
            method: "GET",
            status: 401,
            body: KEY,
          });
        },
      ],
    ];
    for (const [expected, fetchBody] of cases) {
      const r = await checkModelPin({
        kind: "gemini-live",
        model: PINNED,
        apiKey: KEY,
        env: {},
        fetchBody,
      });
      expect(r.status).toBe(expected);
      for (const line of formatModelCheck(r)) expect(line).not.toContain(KEY);
    }
    const skipped = await checkModelPin({
      kind: "gemini-live",
      model: PINNED,
      apiKey: KEY,
      env: { [SKIP_MODEL_CHECK_ENV]: "1" },
    });
    for (const line of formatModelCheck(skipped)) expect(line).not.toContain(KEY);
  });
});

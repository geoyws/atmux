// Unit tests for src/abstractions/voice/model-catalog.ts — ADR-272
// §Supplement (model-pin drift guard).
//
// Two properties matter more than the parsing:
//
//   1. **The API key never rides the URL.** Gemini's REST API accepts
//      `?key=`, and using it would put a live credential into nginx
//      logs, shell history and `ps`. A test asserts the built URL
//      contains no key for either provider.
//   2. **An unknown response shape yields `null`, not `[]`.** An empty
//      list would read as "your model is missing" and print a loud,
//      WRONG drift warning the first time a provider changes its
//      envelope. `null` reads as "could not check", which is true.

import { describe, expect, test } from "bun:test";
import {
  GEMINI_MODELS_URL,
  modelListRequestFor,
  OPENAI_MODELS_URL,
  parseModelList,
  stripGeminiPrefix,
} from "../../../../src/abstractions/voice/model-catalog.ts";

const KEY = "sk-live-secret-value-9f3a";

describe("modelListRequestFor", () => {
  test("openai: the documented index, key on an Authorization header", () => {
    expect(modelListRequestFor("openai-realtime", KEY)).toEqual({
      url: OPENAI_MODELS_URL,
      headers: { Authorization: `Bearer ${KEY}` },
    });
  });

  test("gemini: the v1beta index with an explicit pageSize, key on x-goog-api-key", () => {
    expect(modelListRequestFor("gemini-live", KEY)).toEqual({
      url: GEMINI_MODELS_URL,
      headers: { "x-goog-api-key": KEY },
    });
  });

  test("NEITHER url carries the key — it is a header, never a query param", () => {
    for (const kind of ["openai-realtime", "gemini-live"] as const) {
      const req = modelListRequestFor(kind, KEY);
      expect(req.url).not.toContain(KEY);
      expect(req.url).not.toContain("key=");
      expect(req.url.startsWith("https://")).toBe(true);
    }
  });

  test("gemini asks for a page big enough to contain the real catalog", () => {
    // The API defaults to 50, well under the live catalog size — a
    // default page would make a present model look absent, which is the
    // false-positive this guard must never produce.
    expect(GEMINI_MODELS_URL).toContain("pageSize=1000");
  });
});

describe("parseModelList", () => {
  test("openai: ids out of the data array", () => {
    const body = JSON.stringify({
      object: "list",
      data: [
        { id: "gpt-realtime", object: "model" },
        { id: "gpt-4o", object: "model" },
      ],
    });
    expect(parseModelList("openai-realtime", body)).toEqual(["gpt-realtime", "gpt-4o"]);
  });

  test("gemini: the models/ resource prefix is stripped so both providers share a vocabulary", () => {
    const body = JSON.stringify({
      models: [
        { name: "models/gemini-2.5-flash-native-audio-latest" },
        { name: "models/gemini-2.5-pro" },
      ],
    });
    expect(parseModelList("gemini-live", body)).toEqual([
      "gemini-2.5-flash-native-audio-latest",
      "gemini-2.5-pro",
    ]);
  });

  test("an empty list parses as an empty list (a real, if surprising, answer)", () => {
    expect(parseModelList("openai-realtime", JSON.stringify({ data: [] }))).toEqual([]);
    expect(parseModelList("gemini-live", JSON.stringify({ models: [] }))).toEqual([]);
  });

  test.each([
    ["openai-realtime" as const, "not json at all"],
    ["openai-realtime" as const, JSON.stringify({ models: [{ name: "x" }] })],
    ["openai-realtime" as const, JSON.stringify({ data: [{ nope: 1 }] })],
    ["gemini-live" as const, "not json at all"],
    ["gemini-live" as const, JSON.stringify({ data: [{ id: "x" }] })],
    ["gemini-live" as const, JSON.stringify({ models: "nope" })],
    ["gemini-live" as const, ""],
  ])("%s: an unrecognised body yields null, NOT an empty list", (kind, body) => {
    // The distinction is the whole safety of the guard: `[]` would make
    // the caller print MODEL PIN DRIFT for a provider that merely
    // reshaped its envelope.
    expect(parseModelList(kind, body)).toBeNull();
  });
});

describe("exhaustiveness", () => {
  test("an unknown provider kind is a loud unreachable, not a silent empty list", () => {
    expect(() => modelListRequestFor("bogus" as never, KEY)).toThrow("unreachable: bogus");
    expect(() => parseModelList("bogus" as never, "{}")).toThrow("unreachable: bogus");
  });
});

describe("stripGeminiPrefix", () => {
  test("strips the resource prefix", () => {
    expect(stripGeminiPrefix("models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  test("leaves an already-bare id alone", () => {
    expect(stripGeminiPrefix("gemini-2.5-pro")).toBe("gemini-2.5-pro");
  });

  test("only strips a LEADING prefix", () => {
    expect(stripGeminiPrefix("tunedModels/models/x")).toBe("tunedModels/models/x");
  });
});

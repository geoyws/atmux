// ADR-272 §Supplement (model-pin drift guard) — the ONE place each
// provider's model-list endpoint and response shape lives.
//
// Why this file exists at all: the OpenAI adapter was built against a
// RETIRED API and nobody knew until a live dial (ADR-272 §Consequences /
// RUNBOOK-vox §8, `beta_api_shape_disabled`). The same class of fault
// is already loaded and aimed — `defaultModelFor("gemini-live")` pins
// `gemini-2.5-flash-native-audio-preview-09-2025`, a **dated preview id**
// that will be retired on a schedule nobody in this repo controls. When
// it goes, the only symptom is a phone call that fails after ~68 seconds
// with close code 4500, which is the least diagnosable failure the whole
// feature can produce.
//
// A model-list GET at boot converts that into one loud line before the
// operator ever dials.
//
// Design constraints, all load-bearing:
//
//   - **The key never rides the URL.** Gemini's REST API accepts
//     `?key=<k>` and the SDKs use it, but a URL is logged, kept in shell
//     history and visible in `ps`. Both providers accept a HEADER
//     (`Authorization: Bearer` / `x-goog-api-key`), so both use one, and
//     a test asserts the built URL contains no key.
//   - **Parsing goes through `tryParseJsonString`** (R3 / ADR-006:
//     `src/abstractions/json.ts` is the only module allowed to call
//     `JSON.parse`).
//   - **Unknown response shapes degrade to `null`**, never to an empty
//     list. An empty list would read as "the model is missing" and print
//     a loud, wrong drift warning; `null` reads as "could not check",
//     which is the truth.

import { z } from "zod";
import { assertNever } from "../../errors.ts";
import { tryParseJsonString } from "../json.ts";
import type { VoiceProviderKind } from "../voice-provider.ts";

/** Where to GET a provider's model list, and what to send with it. */
export interface ModelListRequest {
  url: string;
  /** Auth header. Never a query parameter — see the file header. */
  headers: Record<string, string>;
}

/** OpenAI's model index. Not paginated. */
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/**
 * Google's model index. `pageSize` is capped at 1000 by the API and
 * defaults to 50 — well under the real catalog size, so omitting it
 * would make a present model look absent. One page at the maximum is
 * enough today and is the whole reason the bound is explicit rather than
 * defaulted; if Google ever ships >1000 models this needs a
 * `nextPageToken` loop, and {@link parseModelList} returning a short
 * list is what will surface it.
 */
export const GEMINI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";

/** Build the model-list request for a provider kind. */
export function modelListRequestFor(kind: VoiceProviderKind, apiKey: string): ModelListRequest {
  switch (kind) {
    case "openai-realtime":
      return { url: OPENAI_MODELS_URL, headers: { Authorization: `Bearer ${apiKey}` } };
    case "gemini-live":
      return { url: GEMINI_MODELS_URL, headers: { "x-goog-api-key": apiKey } };
    default:
      return assertNever(kind);
  }
}

/** OpenAI: `{ data: [{ id }] }`. Extra fields are stripped by zod. */
const openaiListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/** Gemini: `{ models: [{ name: "models/<id>" }] }`. */
const geminiListSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
});

/** Strip Google's `models/` resource prefix so both providers yield the
 *  same vocabulary the operator pins in `ATMUX_VOX_MODEL`. */
export function stripGeminiPrefix(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

/**
 * Parse a provider's model-list body into plain model ids.
 *
 * Returns `null` when the body does not match the provider's documented
 * shape — deliberately NOT an empty array, which the caller would have
 * to read as "your model is not in the list" and would turn a provider
 * changing its response envelope into a loud, wrong drift warning.
 */
export function parseModelList(kind: VoiceProviderKind, body: string): string[] | null {
  switch (kind) {
    case "openai-realtime": {
      const parsed = tryParseJsonString(body, openaiListSchema);
      return parsed === null ? null : parsed.data.map((m) => m.id);
    }
    case "gemini-live": {
      const parsed = tryParseJsonString(body, geminiListSchema);
      return parsed === null ? null : parsed.models.map((m) => stripGeminiPrefix(m.name));
    }
    default:
      return assertNever(kind);
  }
}

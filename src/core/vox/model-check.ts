// ADR-272 §Supplement (model-pin drift guard) — does the configured
// realtime model actually EXIST, checked once at boot.
//
// ---------------------------------------------------------------------
// The failure this converts
// ---------------------------------------------------------------------
//
// The OpenAI adapter was built against a retired API and nobody knew
// until a live dial. The class is not closed: `defaultModelFor` pins
// `gemini-2.5-flash-native-audio-preview-09-2025` — a DATED PREVIEW id,
// which by construction will be retired. When it is, the operator's
// entire experience of the fault is a phone call that goes silent and
// closes 4500 after ~68 seconds of dial retries. That is the least
// diagnosable failure this feature can produce, and it is entirely
// avoidable with one GET at boot.
//
// ---------------------------------------------------------------------
// Three rules, each with a failure it prevents
// ---------------------------------------------------------------------
//
// 1. **It never blocks startup, and never fails the boot.** An
//    unreachable provider at boot is NOT the same fault as a bad model
//    id, and failing closed on it would make the voice server refuse to
//    start whenever the box's egress hiccups — trading a rare, loud
//    problem for a common, total one. Network failure ⇒ `unreachable` ⇒
//    a warning line, and the server serves.
// 2. **It is skippable and bounded.** `ATMUX_VOX_SKIP_MODEL_CHECK=1`
//    for offline and dev use; a short timeout and zero retries so a
//    slow provider costs a few seconds at worst, once, at boot.
// 3. **It never prints the API key.** Nothing here interpolates the key
//    into a message, the key rides a HEADER rather than the URL
//    (`model-catalog.ts`), and the server's sink is the redacting
//    `createVoxLogger` on top of that. Three layers, because a boot
//    banner is exactly the kind of line that gets pasted into a chat.
//
// The check is a READ. It cannot make the server behave differently — a
// `missing` verdict still serves, because a wrong warning must never be
// able to take the feature down.

import { HttpError, HttpTimeoutError, request } from "../../abstractions/http.ts";
import { modelListRequestFor, parseModelList } from "../../abstractions/voice/model-catalog.ts";
import type { VoiceProviderKind } from "../../abstractions/voice-provider.ts";
import { parseBooleanEnv } from "./config.ts";
import { readVoxEnv } from "./env-compat.ts";

/** Env flag that skips the check entirely (offline / dev). */
export const SKIP_MODEL_CHECK_ENV = "ATMUX_VOX_SKIP_MODEL_CHECK";

/**
 * Wall-clock bound for the model-list GET.
 *
 * Boot latency the operator pays once. Long enough that a cold TLS
 * handshake to a provider on another continent completes; short enough
 * that a black-holed egress costs three seconds rather than the HTTP
 * default of ten. No retries — a retry budget here would multiply the
 * only cost this check has.
 */
export const MODEL_CHECK_TIMEOUT_MS = 3_000;

/** How many near-miss ids the warning suggests. */
export const MODEL_SUGGESTION_LIMIT = 3;

export type ModelCheckStatus =
  /** The configured model is in the provider's list. */
  | "ok"
  /** The list came back and the model is NOT in it — the drift case. */
  | "missing"
  /** Skipped by env flag. */
  | "skipped"
  /** The list could not be fetched or parsed. NOT a model verdict. */
  | "unreachable";

export interface ModelCheckResult {
  status: ModelCheckStatus;
  kind: VoiceProviderKind;
  model: string;
  /** How many models the provider listed (`null` unless status is
   *  `ok` / `missing`). */
  available: number | null;
  /** Nearest ids by shared prefix — only for `missing`. */
  suggestions: string[];
  /** Why, for `unreachable` / `skipped`. Never carries a credential. */
  detail: string | null;
}

export interface ModelCheckDeps {
  kind: VoiceProviderKind;
  model: string;
  apiKey: string;
  env?: NodeJS.ProcessEnv;
  /** HTTP seam. Defaults to {@link fetchModelListBody}; injected in
   *  tests so the unit suite never dials a provider. Its signature is
   *  the production function's, so the default needs no wrapper. */
  fetchBody?: ModelListFetcher;
  timeoutMs?: number;
}

/** The model-list fetch seam. */
export type ModelListFetcher = (
  req: { url: string; headers: Record<string, string> },
  timeoutMs: number,
) => Promise<string>;

/**
 * Rank candidate ids by the length of the prefix they share with
 * `model`, longest first, ties broken alphabetically so the suggestion
 * list is deterministic.
 *
 * Prefix rather than edit distance on purpose: the drift this catches is
 * a DATE or a stage suffix moving
 * (`…native-audio-preview-09-2025` → `…native-audio-latest`), so the
 * useful neighbours are exactly the ids that share the long stem. An
 * edit-distance ranking would surface unrelated short model names that
 * happen to be close in characters.
 */
export function suggestModels(model: string, available: ReadonlyArray<string>): string[] {
  const scored = available
    .map((id) => ({ id, score: sharedPrefixLength(model, id) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, MODEL_SUGGESTION_LIMIT).map((c) => c.id);
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n += 1;
  return n;
}

function result(over: Partial<ModelCheckResult> & Pick<ModelCheckResult, "status">) {
  return {
    kind: "openai-realtime" as VoiceProviderKind,
    model: "",
    available: null,
    suggestions: [],
    detail: null,
    ...over,
  } satisfies ModelCheckResult;
}

/**
 * Check the configured model against the provider's model list.
 *
 * NEVER throws and never rejects: every failure mode is a status. The
 * caller runs this at boot and must not be able to be taken down by it.
 */
export async function checkModelPin(deps: ModelCheckDeps): Promise<ModelCheckResult> {
  const env = deps.env ?? process.env;
  const base = { kind: deps.kind, model: deps.model };
  // SUNSET(v0.9.1): ADR-274 D2 — `ATMUX_VOICE_SKIP_MODEL_CHECK` still read.
  if (parseBooleanEnv(readVoxEnv(env, "SKIP_MODEL_CHECK"))) {
    return result({ ...base, status: "skipped", detail: `${SKIP_MODEL_CHECK_ENV} is set` });
  }
  const req = modelListRequestFor(deps.kind, deps.apiKey);
  const fetchBody: ModelListFetcher = deps.fetchBody ?? fetchModelListBody;
  let body: string;
  try {
    body = await fetchBody(req, deps.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS);
  } catch (e) {
    return result({ ...base, status: "unreachable", detail: describeFetchFailure(e) });
  }
  const available = parseModelList(deps.kind, body);
  if (available === null) {
    return result({
      ...base,
      status: "unreachable",
      detail: "the model list did not match the provider's documented shape",
    });
  }
  if (available.includes(deps.model)) {
    return result({ ...base, status: "ok", available: available.length });
  }
  return result({
    ...base,
    status: "missing",
    available: available.length,
    suggestions: suggestModels(deps.model, available),
  });
}

/**
 * Turn a thrown HTTP failure into one line that names the fault CLASS.
 *
 * A 401/403 is the one worth distinguishing by hand: it means the key is
 * wrong or lacks scope, which is actionable and is NOT "your model id is
 * retired" — reporting it as drift would send the operator hunting the
 * wrong thing. The message deliberately quotes only the status, never a
 * response body, because a provider's auth error can echo request
 * material back.
 */
export function describeFetchFailure(e: unknown): string {
  if (e instanceof HttpTimeoutError) return "the provider's model list timed out";
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) {
      return `the provider rejected the API key (HTTP ${e.status}) — the model could not be checked, and dialling will fail too`;
    }
    if (e.status === 0) return "the provider was unreachable (DNS / connection / TLS)";
    return `the provider's model list returned HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Production HTTP: one GET, **no retries**, hard-bounded.
 *
 * No retry budget on purpose — the only cost this whole check has is
 * boot latency, and a retry would multiply exactly that. A provider that
 * cannot answer once at boot is reported as `unreachable`, which is the
 * honest verdict anyway.
 *
 * Exported so the production path is reachable from a test against a
 * loopback server rather than only through the injected seam (a seam
 * that is always injected is a seam nobody has proved works).
 */
export async function fetchModelListBody(
  req: { url: string; headers: Record<string, string> },
  timeoutMs: number = MODEL_CHECK_TIMEOUT_MS,
): Promise<string> {
  const res = await request({
    url: req.url,
    method: "GET",
    headers: req.headers,
    timeoutMs,
    retry: 0,
  });
  return res.body;
}

/** Banner rule used by the loud verdict — wide enough to be unmissable
 *  in a tmux pane, narrow enough not to wrap at 100 columns. */
const RULE = "#".repeat(72);

/**
 * Render the check for the server's stderr sink.
 *
 * `missing` is deliberately SHOUTY and multi-line. The whole point is
 * that the previous version of this failure was a silent 4500 sixty-
 * eight seconds into a phone call; a verdict that scrolled past as one
 * more info line would not have prevented it. `ok` is one quiet line,
 * because a check that is noisy when everything is fine trains the
 * operator to skim.
 */
export function formatModelCheck(r: ModelCheckResult): string[] {
  const pin = `${r.kind}/${r.model}`;
  switch (r.status) {
    case "ok":
      return [`vox: model check ok — ${pin} is in the provider's list of ${r.available} models`];
    case "skipped":
      return [`vox: model check SKIPPED (${r.detail}) — a retired model id will not be caught`];
    case "unreachable":
      return [
        `vox: model check could not run — ${r.detail}. Serving anyway; the pin ${pin} is UNVERIFIED`,
      ];
    default:
      return [
        `vox: ${RULE}`,
        `vox: ## MODEL PIN DRIFT — '${r.model}' is NOT in ${r.kind}'s model list (${r.available} models)`,
        "vox: ## The server WILL start, and every dial will fail with close code 4500.",
        "vox: ## A retired or renamed dated-preview id is the usual cause.",
        ...(r.suggestions.length > 0
          ? [`vox: ## Closest available: ${r.suggestions.join(", ")}`]
          : ["vox: ## No similarly-named model was offered — check the provider's console."]),
        "vox: ## Fix: export ATMUX_VOX_MODEL=<id>, or pass --model <id>.",
        `vox: ## Skip this check with ${SKIP_MODEL_CHECK_ENV}=1 (offline / dev only).`,
        `vox: ${RULE}`,
      ];
  }
}

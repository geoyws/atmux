// ADR-272: voice operator interface — the server's diagnostics sink.
//
// WHY THIS EXISTS. On the first live dial (2026-08-15) the OpenAI
// adapter was still speaking the retired Realtime BETA shape. All five
// attempts failed and the phone was closed 4500 — and the entire server
// log held nothing but the startup banner. The provider had said
// exactly what was wrong (`beta_api_shape_disabled` — "The Realtime Beta
// API is no longer supported"), and the server discarded it. Diagnosing
// it took hand-written throwaway WebSocket probes against the live API.
// One log line would have made it obvious. This module is the sink those
// lines go to, and the reason they are safe to emit.
//
// THREE PROPERTIES, all enforced here rather than trusted to callers:
//
//   1. STDERR, never stdout. `process.stdout` is capture-owned while a
//      voice tool's verb runs (`src/core/verb-capture.ts`), so a stray
//      stdout write would land INSIDE a spoken tool result. The default
//      `write` is `process.stderr.write`; nothing here touches stdout.
//
//   2. REDACTION IS STRUCTURAL. Every line goes through
//      {@link redactVoxSecrets} on the way out — a caller cannot forget
//      it, and a caller cannot bypass it, because the only handle it gets
//      is the already-wrapping logger. Two layers: the secrets the server
//      actually holds (`OPENAI_API_KEY` / `GEMINI_API_KEY` and
//      `ATMUX_VOX_TOKEN`), plus shape-based patterns for a credential
//      the server was never told about (`?key=…` — the form Gemini Live's
//      URL auth takes, `Bearer …`, `openai-insecure-api-key.…`, `sk-…`).
//      `gemini-live.ts::redactSecret` already does the first layer at its
//      own connect boundary; this is the same discipline applied to
//      everything the server ever prints.
//
//   3. NO SPEECH, EVER. ADR-272 OQ-4 (resolved 2026-08-15) bounds
//      TRANSCRIPTS to `~/.atmux/vox-logs/`, local-only, 7-day
//      retention — because a transcript is a durable record of everything
//      said near the microphone. The lines this sink carries are
//      protocol/connection events (attempt counts, close codes, provider
//      error codes, tool NAMES) and must carry no transcript text and no
//      tool ARGUMENTS. That is a rule about what callers pass in; the
//      session layer's tests pin it (a transcript event emits nothing).

/** What a redacted secret renders as. */
export const VOX_REDACTED = "<redacted>";

/**
 * Secrets shorter than this are NOT substring-redacted.
 *
 * `"".split("")` shreds the text (gemini-live.ts guards the same way),
 * and a 2-3 character "secret" would blank out unrelated substrings —
 * turning a diagnostic line into noise. Real credentials here are ≥32
 * chars (`ATMUX_VOX_TOKEN` is refused below 32; provider API keys are
 * far longer), so this floor never excludes a real one.
 */
export const MIN_REDACTABLE_SECRET_CHARS = 8;

/** Diagnostics sink shape — one call per line, newline added by the sink. */
export type VoxLog = (line: string) => void;

/**
 * Shape-based redactions, applied AFTER the known secrets. These catch a
 * credential the server was never handed — e.g. a provider echoing back
 * a URL, or an error whose text embeds an auth header.
 */
const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replace: string }> = Object.freeze([
  // `?key=…` / `&api_key=…` / `?access_token=…` / `&token=…` — the query
  // form Gemini Live's WS auth uses, and the form our own `?token=` gate
  // uses. Stops at the next `&`, whitespace, or quote.
  {
    re: /([?&](?:key|api[-_]?key|access[-_]?token|token)=)[^&\s"'`]+/gi,
    replace: `$1${VOX_REDACTED}`,
  },
  // `Authorization: Bearer <key>` in any error text.
  { re: /\b(Bearer\s+)\S+/gi, replace: `$1${VOX_REDACTED}` },
  // The OpenAI browser-style subprotocol element carrying the raw key.
  { re: /(openai-insecure-api-key\.)[^\s,"'`\]]+/gi, replace: `$1${VOX_REDACTED}` },
  // Bare OpenAI-shaped keys (`sk-…`), wherever they appear.
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: VOX_REDACTED },
]);

/**
 * Redact `secrets` (raw AND URI-encoded form — a key that reached a URL
 * is percent-encoded there) plus the shape patterns above.
 *
 * Pure and exported so the property is directly testable without a sink.
 */
export function redactVoxSecrets(line: string, secrets: ReadonlyArray<string>): string {
  let out = line;
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTABLE_SECRET_CHARS) continue;
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(VOX_REDACTED);
    out = out.split(secret).join(VOX_REDACTED);
  }
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

export interface CreateVoxLoggerOpts {
  /** Secrets the server holds — API key + voice token. */
  secrets: ReadonlyArray<string>;
  /** Raw byte sink; receives the redacted line WITH its trailing newline.
   *  Defaults to `process.stderr` (see property 1 in the file header). */
  write?: (chunk: string) => void;
}

/**
 * Build the server's diagnostics logger. Redaction is applied inside, so
 * every consumer of the returned function is safe by construction — see
 * property 2 in the file header.
 */
export function createVoxLogger(opts: CreateVoxLoggerOpts): VoxLog {
  const secrets = opts.secrets.filter((s) => s.length >= MIN_REDACTABLE_SECRET_CHARS);
  const write =
    opts.write ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });
  return (line: string): void => {
    write(`${redactVoxSecrets(line, secrets)}\n`);
  };
}

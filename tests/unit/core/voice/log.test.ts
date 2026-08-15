// ADR-272 — `src/core/voice/log.ts`, the voice server's diagnostics sink.
//
// The property under test is NEGATIVE — "the secret is not in the output"
// — which is the shape most prone to a lie: an assertion that a string is
// absent passes trivially when nothing was written at all. Every test
// here therefore asserts BOTH halves: the secret is gone AND the
// surrounding diagnostic survived. A redactor that returned "" would fail
// every one of them.

import { describe, expect, test } from "bun:test";
import {
  createVoiceLogger,
  MIN_REDACTABLE_SECRET_CHARS,
  redactVoiceSecrets,
  VOICE_REDACTED,
} from "../../../../src/core/voice/log.ts";

const API_KEY = "sk-live-4f9a2c7e11b3d8f60a5e9c2b7d4188aa";
const TOKEN = "v".repeat(40);

describe("redactVoiceSecrets — known secrets", () => {
  test("removes a known secret and keeps the rest of the line", () => {
    const out = redactVoiceSecrets(`connect failed with key ${API_KEY} at hop 3`, [API_KEY]);
    expect(out).not.toContain(API_KEY);
    expect(out).toBe(`connect failed with key ${VOICE_REDACTED} at hop 3`);
  });

  test("removes EVERY occurrence, not just the first", () => {
    const out = redactVoiceSecrets(`${API_KEY} then ${API_KEY}`, [API_KEY]);
    expect(out).not.toContain(API_KEY);
    expect(out.split(VOICE_REDACTED)).toHaveLength(3); // two replacements
  });

  test("removes the URI-ENCODED form too — a key that reached a URL is percent-encoded there", () => {
    const keyWithSpecials = "abc/def+ghi=jkl-mnop-qrst";
    const encoded = encodeURIComponent(keyWithSpecials);
    expect(encoded).not.toBe(keyWithSpecials); // guard: the case is real
    const out = redactVoiceSecrets(`wss://host/ws?key=${encoded}`, [keyWithSpecials]);
    expect(out).not.toContain(encoded);
    expect(out).toContain("wss://host/ws?key=");
  });

  test("redacts several distinct secrets in one line", () => {
    const out = redactVoiceSecrets(`key=${API_KEY} token=${TOKEN}`, [API_KEY, TOKEN]);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(TOKEN);
  });

  test("a too-short 'secret' is IGNORED rather than shredding the text", () => {
    const short = "a".repeat(MIN_REDACTABLE_SECRET_CHARS - 1);
    const out = redactVoiceSecrets("attempt 1/5 failed at stage a", [short]);
    // Substring-redacting a 7-char token would blank out unrelated words
    // and leave a line nobody can read. The line must survive intact.
    expect(out).toBe("attempt 1/5 failed at stage a");
  });

  test("the empty string is ignored (it would otherwise shred the line)", () => {
    expect(redactVoiceSecrets("dial attempt 1/5", [""])).toBe("dial attempt 1/5");
  });

  test("a line with no secret in it is returned unchanged", () => {
    const line = "voice: dial attempt 2/5 failed (openai-realtime/gpt-realtime)";
    expect(redactVoiceSecrets(line, [API_KEY, TOKEN])).toBe(line);
  });
});

describe("redactVoiceSecrets — shape patterns (credentials we were never told about)", () => {
  test.each([
    [
      "?key= query auth (the form Gemini Live's WS URL uses)",
      "wss://generativelanguage.googleapis.com/ws?key=AIzaSyUNKNOWN123456 failed",
      "AIzaSyUNKNOWN123456",
      "wss://generativelanguage.googleapis.com/ws?key=",
    ],
    [
      "&api_key= query auth",
      "GET /v1?model=x&api_key=UNKNOWNSECRET9999&z=1",
      "UNKNOWNSECRET9999",
      "&api_key=",
    ],
    [
      "&access_token= query auth",
      "redirect https://h/cb?a=1&access_token=UNKNOWNSECRET8888",
      "UNKNOWNSECRET8888",
      "&access_token=",
    ],
    [
      "?token= query auth (our own pre-upgrade gate)",
      "upgrade refused /ws?token=UNKNOWNVOICETOKEN7777",
      "UNKNOWNVOICETOKEN7777",
      "/ws?token=",
    ],
    [
      "Authorization: Bearer header echoed into an error",
      "handshake rejected: Authorization: Bearer UNKNOWNBEARER6666",
      "UNKNOWNBEARER6666",
      "Bearer ",
    ],
    [
      "the OpenAI browser-style subprotocol element",
      "protocols: [realtime, openai-insecure-api-key.UNKNOWNSUBPROTO5555]",
      "UNKNOWNSUBPROTO5555",
      "openai-insecure-api-key.",
    ],
    [
      "a bare sk- shaped key",
      "auth failed for sk-UNKNOWNBAREKEY4444 on attempt 1",
      "sk-UNKNOWNBAREKEY4444",
      "auth failed for",
    ],
  ])("%s", (_name, line, secret, keptContext) => {
    // NOTE: the secret is NOT passed in `secrets` — the point is that the
    // shape alone is enough, for a credential the server never held.
    const out = redactVoiceSecrets(line, []);
    expect(out).not.toContain(secret);
    expect(out).toContain(VOICE_REDACTED);
    expect(out).toContain(keptContext); // the diagnostic survived
  });

  test("a query redaction stops at the next & — later params still readable", () => {
    const out = redactVoiceSecrets("dial wss://h/ws?key=UNKNOWNSECRET1111&model=gpt-realtime", []);
    expect(out).not.toContain("UNKNOWNSECRET1111");
    expect(out).toContain("&model=gpt-realtime");
  });
});

describe("createVoiceLogger", () => {
  test("writes ONE newline-terminated chunk per call, through the redactor", () => {
    const chunks: string[] = [];
    const log = createVoiceLogger({ secrets: [API_KEY], write: (c) => chunks.push(c) });
    log(`voice: dial failed with ${API_KEY}`);
    log("voice: retrying");
    expect(chunks).toEqual([`voice: dial failed with ${VOICE_REDACTED}\n`, "voice: retrying\n"]);
  });

  test("a caller CANNOT bypass redaction — it is inside the returned function", () => {
    const chunks: string[] = [];
    const log = createVoiceLogger({ secrets: [API_KEY, TOKEN], write: (c) => chunks.push(c) });
    log(`banner token=${TOKEN} key=${API_KEY}`);
    const written = chunks.join("");
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain(API_KEY);
    expect(written).toContain("banner"); // and the line still says something
  });

  test("defaults its sink to process.stderr — never stdout (capture-owned)", () => {
    // stdout is monkeypatched by `verb-capture.ts` while a voice tool's
    // verb runs; a diagnostic landing there would be spoken aloud inside a
    // tool result. Assert the default writes to stderr and NOT stdout.
    const stderrChunks: string[] = [];
    const stdoutChunks: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrChunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutChunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    }) as typeof process.stdout.write;
    try {
      createVoiceLogger({ secrets: [API_KEY] })(`default sink ${API_KEY}`);
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    expect(stdoutChunks).toEqual([]);
    expect(stderrChunks).toEqual([`default sink ${VOICE_REDACTED}\n`]);
  });
});

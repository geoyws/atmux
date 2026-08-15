// ADR-272: voice operator interface — pure auth helpers for the WS
// upgrade gate.
//
// Everything here is argument-driven (config resolution lands in a later
// phase): token check, token extraction, Origin allowlist check, and the
// combined upgrade verdict. No IO, no clocks, no sockets.
//
// Ordering pin (ADR-272): `authorizeUpgrade` checks ORIGIN FIRST → 4403,
// then token → 4401. A cross-site browser request must read as a CSRF
// rejection even when it also lacks a token — reporting bad credentials
// for what is actually a forbidden origin muddies incident triage.

import { createHash, timingSafeEqual } from "node:crypto";
import { VOICE_CLOSE } from "../../schema/voice.ts";

/**
 * Constant-time token comparison: sha256 both sides, then
 * `crypto.timingSafeEqual` on the equal-length digests — constant-time
 * regardless of candidate length. `null`/`undefined` (no token supplied)
 * is false without hashing (absence is not timing-sensitive content).
 */
export function checkToken(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Extract the client token. Precedence: `Authorization: Bearer <t>` →
 * `?token=<t>` query param → `atmux_voice` cookie. A present-but-non-
 * Bearer Authorization header and an empty `?token=` both fall through
 * to the next source. Cookie values are returned verbatim (tokens are
 * opaque; no URL-decoding).
 */
export function extractToken(headers: Headers, url: URL): string | null {
  const auth = headers.get("authorization");
  if (auth !== null) {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    if (bearer !== undefined) return bearer;
  }
  const q = url.searchParams.get("token");
  if (q !== null && q.length > 0) return q;
  const cookie = headers.get("cookie");
  if (cookie !== null) {
    for (const part of cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("atmux_voice=")) return trimmed.slice("atmux_voice=".length);
    }
  }
  return null;
}

/**
 * Origin allowlist check. ABSENT Origin is allowed (native apps and
 * probe clients send none — token still gates them); a PRESENT Origin
 * must exact-match an allowlist entry after URL-normalizing both sides
 * (`new URL(x).origin`). Garbage origins (including the literal opaque
 * `"null"` origin) and malformed allowlist entries never match.
 */
export function checkOrigin(origin: string | null, allowlist: readonly string[]): boolean {
  if (origin === null) return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false; // expected: garbage / opaque Origin header
  }
  for (const entry of allowlist) {
    try {
      if (new URL(entry).origin === normalized) return true;
    } catch {
      // expected: malformed allowlist entry — a broken config line must
      // not grant access; skip it
    }
  }
  return false;
}

export interface AuthorizeUpgradeOpts {
  headers: Headers;
  url: URL;
  expectedToken: string;
  origins: readonly string[];
}

export type AuthorizeUpgradeResult = { ok: true } | { ok: false; closeCode: 4401 | 4403 };

/** Combined upgrade gate: origin first (4403), then token (4401). */
export function authorizeUpgrade(opts: AuthorizeUpgradeOpts): AuthorizeUpgradeResult {
  if (!checkOrigin(opts.headers.get("origin"), opts.origins)) {
    return { ok: false, closeCode: VOICE_CLOSE.ORIGIN };
  }
  if (!checkToken(extractToken(opts.headers, opts.url), opts.expectedToken)) {
    return { ok: false, closeCode: VOICE_CLOSE.AUTH };
  }
  return { ok: true };
}

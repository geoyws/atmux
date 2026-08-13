// ADR-272: voice operator interface — static asset routing for the PWA.
//
// Pure map + resolver: the asset FILES land in `templates/voice/` in a
// later phase; this module only decides which pathname maps to which
// file + mime + cache policy. Lookup is EXPLICIT-MAP-ONLY — no fs
// access, no normalization of user input — so there is zero
// path-traversal surface: anything not literally a key in VOICE_ROUTES
// (including `/../etc/passwd` and prototype names like `/toString`)
// resolves to null.
//
// Cache policy: html/css/js/manifest are `no-store` (the PWA shell must
// pick up server upgrades immediately); icons are immutable-for-a-year
// (renamed if they ever change).

import { resolve } from "node:path";
import { resolveTemplatesDir } from "../templates-dir.ts";

export interface VoiceAssetEntry {
  /** Path relative to the assets dir. */
  file: string;
  mime: string;
  cacheControl: string;
}

const HTML_MIME = "text/html; charset=utf-8";
const MANIFEST_MIME = "application/manifest+json";
const CSS_MIME = "text/css; charset=utf-8";
const JS_MIME = "text/javascript; charset=utf-8";
const PNG_MIME = "image/png";
const NO_STORE = "no-store";
const IMMUTABLE = "public, max-age=31536000, immutable";

function asset(file: string, mime: string, cacheControl: string): Readonly<VoiceAssetEntry> {
  return Object.freeze({ file, mime, cacheControl });
}

/** The complete, closed route map. `/` aliases `index.html`. */
export const VOICE_ROUTES: Readonly<Record<string, Readonly<VoiceAssetEntry>>> = Object.freeze({
  "/": asset("index.html", HTML_MIME, NO_STORE),
  "/index.html": asset("index.html", HTML_MIME, NO_STORE),
  "/manifest.webmanifest": asset("manifest.webmanifest", MANIFEST_MIME, NO_STORE),
  "/css/app.css": asset("css/app.css", CSS_MIME, NO_STORE),
  "/js/app.js": asset("js/app.js", JS_MIME, NO_STORE),
  "/js/protocol.js": asset("js/protocol.js", JS_MIME, NO_STORE),
  "/js/audio.js": asset("js/audio.js", JS_MIME, NO_STORE),
  "/worklet/capture.js": asset("worklet/capture.js", JS_MIME, NO_STORE),
  "/icons/icon-192.png": asset("icons/icon-192.png", PNG_MIME, IMMUTABLE),
  "/icons/icon-512.png": asset("icons/icon-512.png", PNG_MIME, IMMUTABLE),
  "/icons/apple-touch-icon.png": asset("icons/apple-touch-icon.png", PNG_MIME, IMMUTABLE),
});

export interface ResolvedVoiceAsset {
  filePath: string;
  mime: string;
  cacheControl: string;
}

/**
 * Resolve a request pathname to a servable asset, or null when the
 * pathname is not an exact VOICE_ROUTES key. `Object.hasOwn` guards the
 * lookup so inherited prototype properties can never satisfy a route.
 * Default assets dir: `<templates>/voice` via `resolveTemplatesDir()`.
 */
export function resolveVoiceAsset(
  pathname: string,
  opts?: { assetsDir?: string },
): ResolvedVoiceAsset | null {
  const entry = Object.hasOwn(VOICE_ROUTES, pathname) ? VOICE_ROUTES[pathname] : undefined;
  if (entry === undefined) return null;
  const dir = opts?.assetsDir ?? resolve(resolveTemplatesDir(), "voice");
  return {
    filePath: resolve(dir, entry.file),
    mime: entry.mime,
    cacheControl: entry.cacheControl,
  };
}

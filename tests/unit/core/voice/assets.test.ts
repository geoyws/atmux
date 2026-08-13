// Unit tests for src/core/voice/assets.ts — ADR-272 PWA asset routing.
//
// Pins:
//   - Every route resolves with the right file / mime / cache policy;
//     `/` aliases index.html.
//   - Lookup is explicit-map-only: traversal attempts, prototype names,
//     and near-misses all resolve to null (zero path-traversal surface).
//   - Default assets dir composes `resolveTemplatesDir() + "voice"`;
//     `assetsDir` override wins.

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveTemplatesDir } from "../../../../src/core/templates-dir.ts";
import { resolveVoiceAsset, VOICE_ROUTES } from "../../../../src/core/voice/assets.ts";

const DIR = "/srv/voice-assets";
const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const MANIFEST = "application/manifest+json";
const PNG = "image/png";
const NO_STORE = "no-store";
const IMMUTABLE = "public, max-age=31536000, immutable";

describe("route table", () => {
  test.each([
    ["/", "index.html", HTML, NO_STORE],
    ["/index.html", "index.html", HTML, NO_STORE],
    ["/manifest.webmanifest", "manifest.webmanifest", MANIFEST, NO_STORE],
    ["/css/app.css", "css/app.css", CSS, NO_STORE],
    ["/js/app.js", "js/app.js", JS, NO_STORE],
    ["/js/protocol.js", "js/protocol.js", JS, NO_STORE],
    ["/js/audio.js", "js/audio.js", JS, NO_STORE],
    ["/worklet/capture.js", "worklet/capture.js", JS, NO_STORE],
    ["/icons/icon-192.png", "icons/icon-192.png", PNG, IMMUTABLE],
    ["/icons/icon-512.png", "icons/icon-512.png", PNG, IMMUTABLE],
    ["/icons/apple-touch-icon.png", "icons/apple-touch-icon.png", PNG, IMMUTABLE],
  ])("%s → %s (%s, %s)", (pathname, file, mime, cacheControl) => {
    expect(resolveVoiceAsset(pathname, { assetsDir: DIR })).toEqual({
      filePath: resolve(DIR, file),
      mime,
      cacheControl,
    });
  });

  test("the map is exactly these 11 routes", () => {
    expect(Object.keys(VOICE_ROUTES).length).toBe(11);
  });

  test("/ aliases /index.html (same file path)", () => {
    const root = resolveVoiceAsset("/", { assetsDir: DIR });
    const index = resolveVoiceAsset("/index.html", { assetsDir: DIR });
    expect(root?.filePath).toBe(index?.filePath ?? "");
  });

  test("VOICE_ROUTES map and entries are frozen", () => {
    expect(Object.isFrozen(VOICE_ROUTES)).toBe(true);
    const entry = VOICE_ROUTES["/"];
    if (entry === undefined) throw new Error("route '/' missing");
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("explicit-map-only lookup (zero traversal surface)", () => {
  test.each([
    ["/../etc/passwd"],
    ["/js/../../x"],
    ["/etc/passwd"],
    ["/js/app.js/"],
    ["index.html"],
    ["/INDEX.HTML"],
    ["//index.html"],
    ["/index.html%00"],
    [""],
    ["/toString"],
    ["/constructor"],
    ["toString"],
    ["constructor"],
    ["__proto__"],
    ["hasOwnProperty"],
  ])("%j → null", (pathname) => {
    expect(resolveVoiceAsset(pathname, { assetsDir: DIR })).toBeNull();
  });
});

describe("assets dir resolution", () => {
  const savedTemplatesDir = process.env.ATMUX_TEMPLATES_DIR;

  afterEach(() => {
    if (savedTemplatesDir === undefined) delete process.env.ATMUX_TEMPLATES_DIR;
    else process.env.ATMUX_TEMPLATES_DIR = savedTemplatesDir;
  });

  test("default dir composes resolveTemplatesDir() + voice", () => {
    const expected = resolve(resolveTemplatesDir(), "voice", "css", "app.css");
    expect(resolveVoiceAsset("/css/app.css")?.filePath).toBe(expected);
  });

  test("opts without assetsDir still uses the default dir", () => {
    const expected = resolve(resolveTemplatesDir(), "voice", "index.html");
    expect(resolveVoiceAsset("/", {})?.filePath).toBe(expected);
  });

  test("default dir follows the ATMUX_TEMPLATES_DIR override seam", () => {
    process.env.ATMUX_TEMPLATES_DIR = "/opt/custom-templates";
    expect(resolveVoiceAsset("/js/app.js")?.filePath).toBe("/opt/custom-templates/voice/js/app.js");
  });

  test("assetsDir override wins over the default", () => {
    process.env.ATMUX_TEMPLATES_DIR = "/opt/custom-templates";
    expect(resolveVoiceAsset("/js/app.js", { assetsDir: DIR })?.filePath).toBe(
      resolve(DIR, "js/app.js"),
    );
  });
});

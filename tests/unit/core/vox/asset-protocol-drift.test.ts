// ADR-272 D5/D9 drift guard — the PWA's browser-side codec mirror
// (templates/vox/js/protocol.js) is vanilla ESM outside the TS universe,
// so it cannot be imported here. Instead the numeric tables are
// REGEX-EXTRACTED from the file text and asserted strictly equal to the
// server-side exports. If either side moves alone, this goes red.
//
// Also pins route↔file integrity: every VOX_ROUTES entry must resolve
// to a real file under templates/vox/ (catches a route or file rename
// drifting), and the PNG routes must actually be PNGs.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveVoxAsset, VOX_ROUTES } from "../../../../src/core/vox/assets.ts";
import {
  VOX_BYTES_PER_FRAME,
  VOX_FLAG_SYNTHETIC,
  VOX_FLAG_TURN_END,
  VOX_FRAME_MS,
  VOX_HEADER_BYTES,
  VOX_MAGIC_PCM16_V1,
  VOX_SAMPLE_RATE,
  VOX_SAMPLES_PER_FRAME,
} from "../../../../src/core/vox/frame.ts";
import { VOICE_CLOSE } from "../../../../src/schema/voice.ts";

const ASSETS_DIR = resolve(import.meta.dir, "../../../..", "templates", "vox");
const PROTOCOL_JS = readFileSync(resolve(ASSETS_DIR, "js", "protocol.js"), "utf8");

/** Regex-extract a `export const NAME = { KEY: <numeric literal>, … }` table. */
function extractNumericTable(source: string, name: string): Record<string, number> {
  const block = source.match(new RegExp(`export const ${name} = \\{([^}]*)\\}`));
  if (!block?.[1]) throw new Error(`table ${name} not found in protocol.js`);
  const table: Record<string, number> = {};
  for (const entry of block[1].matchAll(/([A-Z][A-Z0-9_]*):\s*(0x[0-9a-fA-F]+|\d+)/g)) {
    const key = entry[1];
    const value = entry[2];
    if (key === undefined || value === undefined) continue;
    table[key] = Number(value);
  }
  return table;
}

describe("protocol.js VOX_PROTOCOL mirrors src/core/vox/frame.ts", () => {
  test("all eight constants match exactly", () => {
    expect(extractNumericTable(PROTOCOL_JS, "VOX_PROTOCOL")).toEqual({
      MAGIC_PCM16_V1: VOX_MAGIC_PCM16_V1,
      FLAG_TURN_END: VOX_FLAG_TURN_END,
      FLAG_SYNTHETIC: VOX_FLAG_SYNTHETIC,
      HEADER_BYTES: VOX_HEADER_BYTES,
      SAMPLE_RATE: VOX_SAMPLE_RATE,
      FRAME_MS: VOX_FRAME_MS,
      SAMPLES_PER_FRAME: VOX_SAMPLES_PER_FRAME,
      BYTES_PER_FRAME: VOX_BYTES_PER_FRAME,
    });
  });
});

describe("protocol.js VOICE_CLOSE mirrors src/schema/voice.ts", () => {
  test("close-code table matches exactly (same keys, same values)", () => {
    expect(extractNumericTable(PROTOCOL_JS, "VOICE_CLOSE")).toEqual({ ...VOICE_CLOSE });
  });
});

describe("every VOX_ROUTES entry has a file on disk in templates/vox/", () => {
  const routes = Object.keys(VOX_ROUTES);

  test.each(routes)("%s resolves to an existing file", (pathname) => {
    const resolved = resolveVoxAsset(pathname, { assetsDir: ASSETS_DIR });
    expect(resolved).not.toBeNull();
    expect(existsSync((resolved as { filePath: string }).filePath)).toBe(true);
  });

  test("png routes serve real PNGs (magic bytes)", () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const pathname of routes.filter((r) => r.endsWith(".png"))) {
      const resolved = resolveVoxAsset(pathname, { assetsDir: ASSETS_DIR });
      expect(resolved).not.toBeNull();
      const head = readFileSync((resolved as { filePath: string }).filePath).subarray(0, 8);
      expect(head.equals(pngMagic)).toBe(true);
    }
  });
});

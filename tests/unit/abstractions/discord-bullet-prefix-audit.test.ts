// Structural lint: every `bullet80(\`<emoji> ...\`)` literal across
// `src/**/*.ts` must use an emoji that's in `ALLOWED_BULLET_PREFIX`.
// Coupling enforcement for Bug 1 (driver-auth 19:00 MYT 2026-05-08):
// the Discord validator (`src/abstractions/discord.ts:263`) silently
// drops bullets whose first emoji isn't in the allowlist — pings
// vanish into the void without a stderr line. This test fails the
// build at lint-time when a new emoji enters the code path without
// also being added to the allowlist.
//
// Synthetic-regression gate: a fixture string with a known-bad emoji
// (💎) must be DETECTED — proving the audit mechanism actually works.
// Reviewer signoff requires the regression test to run AND fail on
// the synthetic; we assert detection (not source presence) because
// 💎 must NOT actually appear in `src/`.

import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ALLOWED_BULLET_PREFIX } from "../../../src/abstractions/discord.ts";

const SRC_ROOT = resolve(__dirname, "../../../src");

/**
 * Walk `src/**` and return absolute paths of `.ts` files. Skips test
 * helpers (none in src/) and node_modules. Async to avoid blocking.
 */
async function walkTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      out.push(...(await walkTsFiles(full)));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** First grapheme of a string — multi-codepoint emojis (with VS-16
 *  selectors like ⏱️ or ⚠️) count as ONE emoji. Mirrors the matching
 *  logic in `discord.ts:graphemes`. */
function firstGrapheme(s: string): string {
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  const it = seg.segment(s)[Symbol.iterator]();
  const g = it.next();
  return g.done ? "" : g.value.segment;
}

/**
 * Multi-line aware regex matching `bullet80( <whitespace incl newlines>
 * \` <first non-whitespace, non-backtick chunk>`. The capture is the
 * raw token at the start of the template literal — we then take its
 * first grapheme to pick the emoji.
 *
 * Why multi-line — `poke.ts` (formerly `whip.ts` pre-ADR-160 TR2)
 * wraps `bullet80(` and the backtick onto separate lines (long
 * bullet body); a single-line regex misses those calls.
 */
const BULLET80_EMOJI_RE = /bullet80\s*\(\s*`([^\s`]+)/g;

/** Extract every emoji used as the leading character of a `bullet80(\``
 *  call in `source`. Returns the unique set of (emoji, callsite-line)
 *  pairs so failure messages can point the operator at the offending
 *  line directly. */
export function extractBulletEmojis(
  source: string,
): { emoji: string; lineNo: number; raw: string }[] {
  const out: { emoji: string; lineNo: number; raw: string }[] = [];
  // Reset regex global state defensively.
  BULLET80_EMOJI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = BULLET80_EMOJI_RE.exec(source)) !== null) {
    const raw = m[1] ?? "";
    const emoji = firstGrapheme(raw);
    if (emoji.length === 0) continue;
    const lineNo = source.slice(0, m.index).split("\n").length;
    out.push({ emoji, lineNo, raw });
  }
  return out;
}

// ---------- Live audit ----------

describe("bullet80(`<emoji>` audit — every emitted emoji is allowlisted", () => {
  test("scan src/**/*.ts and verify each emoji is in ALLOWED_BULLET_PREFIX", async () => {
    const files = await walkTsFiles(SRC_ROOT);
    const violations: { file: string; emoji: string; line: number }[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const usages = extractBulletEmojis(source);
      for (const u of usages) {
        if (!ALLOWED_BULLET_PREFIX.has(u.emoji)) {
          violations.push({ file, emoji: u.emoji, line: u.lineNo });
        }
      }
    }
    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line} — emoji "${v.emoji}" NOT in ALLOWED_BULLET_PREFIX`)
        .join("\n");
      throw new Error(
        `bullet80 emoji-allowlist violations (Bug 1 regression):\n${msg}\n` +
          `Fix: add the emoji to ALLOWED_BULLET_PREFIX in src/abstractions/discord.ts.`,
      );
    }
    expect(violations).toEqual([]);
  });

  test("audit covers known callers (regression coverage anchor)", async () => {
    // Sanity: confirm the audit walks at least the named files from the
    // dispatch (poke, discorder). If the walker breaks, this catches it
    // before a silent zero-violation pass masks the regression.
    // `poke.ts` was `whip.ts` pre-ADR-160 TR2 (refactor: whip→poke rename).
    const files = await walkTsFiles(SRC_ROOT);
    const names = files.map((f) => f.split("/").pop());
    expect(names).toContain("poke.ts");
    expect(names).toContain("discorder.ts");
    expect(names).toContain("discord.ts");
  });
});

// ---------- Synthetic regression ----------

describe("synthetic regression — audit MUST detect a bad emoji", () => {
  test("fixture `bullet80(\\`💎 foo\\`)` IS detected as an emoji-using bullet", () => {
    const fixture = "const x = bullet80(`💎 foo bar baz`);";
    const usages = extractBulletEmojis(fixture);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.emoji).toBe("💎");
  });

  test("fixture's 💎 is NOT in ALLOWED_BULLET_PREFIX (would be flagged)", () => {
    expect(ALLOWED_BULLET_PREFIX.has("💎")).toBe(false);
  });

  test("end-to-end: synthetic source with 💎 produces a violation", () => {
    const fixture = `
      function foo() {
        return bullet80(\`💎 some text\`);
      }
    `;
    const usages = extractBulletEmojis(fixture);
    const violations = usages.filter((u) => !ALLOWED_BULLET_PREFIX.has(u.emoji));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.emoji).toBe("💎");
  });

  test("multi-line bullet80 call (poke.ts pattern) is captured by the audit", () => {
    // Mirrors src/verbs/poke.ts (formerly whip.ts pre-ADR-160 TR2) where
    // `bullet80(` and the backtick are on separate lines for long-bullet
    // readability.
    const fixture = `
      findings.push({
        bullet: bullet80(
          \`⏰ \${member.name}: \${stale.length} task(s) > \${threshold}min\`,
        ),
      });
    `;
    const usages = extractBulletEmojis(fixture);
    expect(usages).toHaveLength(1);
    expect(usages[0]?.emoji).toBe("⏰");
  });
});

// ---------- Allowlist content ----------

describe("ALLOWED_BULLET_PREFIX — Bug 1 driver-auth 6-emoji floor", () => {
  test("contains every emoji from the driver-auth dispatch", () => {
    for (const emoji of ["⏰", "📋", "🩹", "💓", "🚀", "⏳"]) {
      expect(ALLOWED_BULLET_PREFIX.has(emoji)).toBe(true);
    }
  });

  test("retains pre-existing CLAUDE.md per-bullet emojis", () => {
    // Spot-check: regressions removing entries would silently re-break
    // the digest. Pin the load-bearing primaries.
    for (const emoji of ["✅", "🛑", "🔴", "🟡", "📊", "♻️", "📍"]) {
      expect(ALLOWED_BULLET_PREFIX.has(emoji)).toBe(true);
    }
  });
});

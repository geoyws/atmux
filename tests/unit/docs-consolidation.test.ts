// Smoke test for the 2026-05-13 docs-consolidation (ADR-093).
//
// Locks in the consolidation guarantee:
//   1. No docs/adr-bun/ directory.
//   2. Zero stale 'docs/adr-bun/' path refs outside ADR-093's own prose.
//   3. Every ADR-NNN ref in tracked files resolves to a real
//      docs/adr/<NNN>-*.md file.
//   4. ADR-093 carries Status: accepted.
//   5. ADR-093 body contains the renumber map (markdown table with
//      both 'adr-bun/' and 'adr/' strings — proxy for map presence).
//
// Closes T7 (`t-f1576e0a`) of the docs-consolidation chain.
// Reviewer pre-flag: tests are intentionally tight on Tests 1+2+4+5;
// Test 3 (ADR ref resolution) maintains a whitelist of intentional
// gaps (rejected proposals) since the ADR sequence may have holes
// in the future.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Project root — resolve from this test file's location.
const REPO_ROOT = join(import.meta.dir, "..", "..");

/** ADR IDs that are LEGITIMATELY absent from docs/adr/ (rejected proposals,
 *  reserved-but-not-yet-authored slots, etc). Extend as needed; reviewer
 *  blocks unexplained additions. */
const ADR_GAP_WHITELIST = new Set<string>([
  // Historical parent-repo or retired pre-consolidation references.
  "046",
  "048",
  "049",
  "058",
  "064",
  "066",
  "069",
  // Shipped decisions that were intentionally never backfilled as files.
  "053",
  "054",
  "055",
  "056",
  "060",
  "062",
  "068",
  "076",
  // Reserved, re-slotted, or withdrawn gaps recorded in the ADR index.
  "156",
  "270",
  "283",
]);

/** Build the set of existing ADR NNN tokens from docs/adr/*.md filenames. */
function existingAdrIds(): Set<string> {
  const dir = join(REPO_ROOT, "docs", "adr");
  const out = new Set<string>();
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(\d{3})-.*\.md$/);
    if (m?.[1] !== undefined) out.add(m[1]);
  }
  return out;
}

describe("docs-consolidation (ADR-093) smoke", () => {
  test("(1) docs/adr-bun/ directory does not exist", () => {
    const p = join(REPO_ROOT, "docs", "adr-bun");
    expect(existsSync(p)).toBe(false);
  });

  test("(2) rg 'docs/adr-bun/' returns zero matches outside ADR-093's prose", () => {
    // Use ripgrep so the test mirrors the documented AC verb.
    const res = spawnSync(
      "rg",
      [
        "docs/adr-bun/",
        "--glob=!docs/adr/093-adr-bun-to-adr-consolidation.md",
        "--glob=!.git/**",
        "--glob=!tests/unit/docs-consolidation.test.ts",
        "--glob=!CHANGELOG.md",
      ],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );
    // rg exit 1 = no matches (success for our AC). Exit 0 = matches found
    // (failure). Exit 2 = error.
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
  });

  test("(3) every ADR-NNN ref in tracked files resolves to a docs/adr/<NNN>-*.md file", () => {
    const ids = existingAdrIds();
    // Find every ADR-NNN token in tracked, non-binary files.
    const res = spawnSync("git", ["grep", "-I", "-h", "-o", "-E", "ADR-[0-9]{3}", "--", "."], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(res.status).toBeLessThan(2);
    const refs = new Set<string>(
      res.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/^ADR-/, "")),
    );
    const missing: string[] = [];
    for (const ref of refs) {
      if (ids.has(ref)) continue;
      if (ADR_GAP_WHITELIST.has(ref)) continue;
      missing.push(`ADR-${ref}`);
    }
    expect(missing.sort()).toEqual([]);
  });

  test("(4) ADR-093 carries Status: accepted", () => {
    const body = readFileSync(
      join(REPO_ROOT, "docs", "adr", "093-adr-bun-to-adr-consolidation.md"),
      "utf-8",
    );
    expect(body).toMatch(/^\*\*Status\*\*:\s*accepted\s*$/m);
  });

  test("(5) ADR-093 contains the renumber map (markdown table referencing both adr-bun/ and adr/)", () => {
    const body = readFileSync(
      join(REPO_ROOT, "docs", "adr", "093-adr-bun-to-adr-consolidation.md"),
      "utf-8",
    );
    // Proxy: at least one markdown table row mentions both adr-bun/ and adr/.
    const tableLines = body.split("\n").filter((l) => l.startsWith("|"));
    const hasMapRow = tableLines.some((l) => l.includes("adr-bun/") && l.includes("adr/"));
    expect(hasMapRow).toBe(true);
    // Sanity: the body mentions the renumber range explicitly.
    expect(body).toMatch(/095-130/);
  });
});

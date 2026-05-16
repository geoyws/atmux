// Structural lint: no bare `[whip]` template literal in `src/**/*.ts`.
//
// ADR-079 §C / ADR-008 R10 (named-template enforcement). Bun's
// `DiscordTemplate` union (`src/abstractions/discord.ts:34-99`) has no
// bare `"whip"` literal — TypeScript already refuses `template: "whip"`
// at compile time. This lint catches the failure-mode where a future
// contributor adds `"whip"` to the union AND a caller emits it,
// silently bypassing the namespacing intent (every send must be a
// named template like `whip-progress` / `whip-blocker` / `whip-stuck`
// / `whip-heartbeat` / `whip-overdue` / `whip-audit` / etc.).
//
// Investigation-pin: per `docs/INVESTIGATION-bare-whip-emitters.md`,
// the bash `lib/whip.sh:715` site is the (.archive-bash) origin of the
// 90% bare-`[whip]` ping volume operator measured. Bun source has no
// such site and this lint is the trip-wire keeping it that way.
//
// Synthetic-regression gate: a fixture with a bare `template: "whip"`
// MUST be detected. Reviewer signoff requires the regression test to
// run AND fail on the synthetic; we assert detection (not source
// presence) because bare `template: "whip"` must NOT appear in src/.

import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(__dirname, "../../../src");

/** Walk `<dir>/**` and return absolute paths of `.ts` files (excluding
 *  `.d.ts`). Same shape as `discord-bullet-prefix-audit.test.ts`'s
 *  walker — each pure-fs lint owns its copy because cross-test imports
 *  expand the test boundary. */
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

/**
 * Match `template:` followed by a string literal whose body is exactly
 * `whip` (no suffix). Handles three quote forms (`"…"`, `'…'`, `` `…` ``)
 * and tolerates whitespace around the colon. The closing-quote is the
 * load-bearing part: `template: "whip-progress"` does not match because
 * `whip` isn't immediately followed by a closing quote.
 */
const BARE_WHIP_TEMPLATE_RE = /\btemplate\s*:\s*(["'`])whip\1/g;

export interface BareWhipHit {
  file: string;
  line: number;
  raw: string;
}

export function findBareWhipTemplates(file: string, source: string): BareWhipHit[] {
  const hits: BareWhipHit[] = [];
  // Reset regex global state defensively (each call gets a fresh scan).
  BARE_WHIP_TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = BARE_WHIP_TEMPLATE_RE.exec(source);
  while (m !== null) {
    const line = source.slice(0, m.index).split("\n").length;
    hits.push({ file, line, raw: m[0] });
    m = BARE_WHIP_TEMPLATE_RE.exec(source);
  }
  return hits;
}

// ---------- Live audit ----------

describe("structural lint — no bare [whip] template literal in src/", () => {
  test("scan src/**/*.ts → zero bare `template: \"whip\"` literals", async () => {
    const files = await walkTsFiles(SRC_ROOT);
    const offenders: BareWhipHit[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      offenders.push(...findBareWhipTemplates(file, source));
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line} — ${o.raw}`).join("\n");
      throw new Error(
        `bare [whip] template literal violation (ADR-008 R10 / ADR-079 §C):\n${msg}\n` +
          `Fix: use a namespaced template — whip-progress / whip-blocker / whip-stuck / ` +
          `whip-heartbeat / whip-overdue / whip-audit / etc. Per ADR-008, every Discord ` +
          `send must pick a closed-set named template; bare "whip" is the boilerplate ` +
          `90%-noise template the operator measured at sopx-driver 18:30 MYT 2026-05-08.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test("audit covers known callers (regression coverage anchor)", async () => {
    // Sanity: confirm the walker reaches the named files. If the walker
    // breaks, this catches it before a silent zero-violation pass masks
    // the regression. ADR-160: whip.ts → poke.ts; anchor follows the
    // rename. Lint itself still searches for bare `template: "whip"`
    // literals (the historical noise template); see follow-up task to
    // rename the lint + named-template union (poke-progress / etc.).
    const files = await walkTsFiles(SRC_ROOT);
    const names = files.map((f) => f.split("/").pop());
    expect(names).toContain("poke.ts");
    expect(names).toContain("discorder.ts");
    expect(names).toContain("discord.ts");
  });
});

// ---------- Synthetic regression ----------

describe("synthetic regression — audit MUST detect bare `template: \"whip\"`", () => {
  test("double-quote bare-whip → 1 hit", () => {
    const hits = findBareWhipTemplates("synthetic.ts", 'const x = { template: "whip" };');
    expect(hits).toHaveLength(1);
  });

  test("single-quote bare-whip → 1 hit", () => {
    const hits = findBareWhipTemplates("synthetic.ts", "const x = { template: 'whip' };");
    expect(hits).toHaveLength(1);
  });

  test("backtick bare-whip → 1 hit", () => {
    const hits = findBareWhipTemplates("synthetic.ts", "const x = { template: `whip` };");
    expect(hits).toHaveLength(1);
  });

  test("no-space `template:\"whip\"` → 1 hit", () => {
    const hits = findBareWhipTemplates("synthetic.ts", 'const x = { template:"whip" };');
    expect(hits).toHaveLength(1);
  });

  test("namespaced `template: \"whip-progress\"` → 0 hits", () => {
    const hits = findBareWhipTemplates(
      "synthetic.ts",
      'const x = { template: "whip-progress" };',
    );
    expect(hits).toEqual([]);
  });

  test("namespaced `template: \"whip-audit\"` → 0 hits", () => {
    const hits = findBareWhipTemplates("synthetic.ts", 'const x = { template: "whip-audit" };');
    expect(hits).toEqual([]);
  });

  test("variable named `templateWhip = \"whip\"` → 0 hits (word-boundary on `template`)", () => {
    const hits = findBareWhipTemplates("synthetic.ts", 'const templateWhip = "whip";');
    expect(hits).toEqual([]);
  });

  test("multi-line offender is detected with correct line number", () => {
    const fixture = [
      "function foo() {",
      "  return send({",
      '    template: "whip",', // line 3 (1-indexed)
      "    bullets: [],",
      "  });",
      "}",
    ].join("\n");
    const hits = findBareWhipTemplates("synthetic.ts", fixture);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(3);
  });
});

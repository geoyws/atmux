// Import-boundary test for ADR-292 §D5: the `msg` surface must never
// touch pane input. Starting from `src/verbs/msg.ts` and every module
// under `src/core/msg/`, the TRANSITIVE relative-import closure must not
// import the tmux abstraction (`src/abstractions/tmux.ts`, the only
// module that can send keys) and no module in it may call a sending
// surface (`sendKeys` / `pasteBuffer`) or spell a `send-keys` argv
// outside comments. Delivery stays caller-side via
// `/pane-agent send --queued`, so `msg` stays correct whether the
// in-tree `DriverSendKeysViolation` guard is kept, narrowed or lifted.
//
// Run with `env -u TMUX bun test tests/unit/verbs/msg-boundary.test.ts`.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = new URL("../../..", import.meta.url).pathname;
const TMUX_ABSTRACTION = normalize(join(ROOT, "src/abstractions/tmux.ts"));

const IMPORT_SPEC =
  /(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const SENDING_SURFACE = /\bsendKeys\b|\bpasteBuffer\b|send-keys/;

/** Strip line and block comments so prose mentioning send-keys is not a hit. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function resolveSpec(from: string, spec: string): string {
  const base = normalize(join(dirname(from), spec));
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return base;
}

/** Relative-import closure of `entries` (static, re-export and dynamic imports). */
function importClosure(entries: ReadonlyArray<string>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (graph.has(file) || !existsSync(file)) continue;
    const deps: string[] = [];
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_SPEC)) {
      const spec = m[1] ?? m[2];
      if (spec !== undefined) deps.push(resolveSpec(file, spec));
    }
    graph.set(file, deps);
    stack.push(...deps);
  }
  return graph;
}

function msgEntries(): string[] {
  const coreDir = join(ROOT, "src/core/msg");
  return [
    normalize(join(ROOT, "src/verbs/msg.ts")),
    ...readdirSync(coreDir)
      .filter((e) => e.endsWith(".ts"))
      .map((e) => normalize(join(coreDir, e))),
  ];
}

describe("msg import boundary (ADR-292 §D5)", () => {
  const graph = importClosure(msgEntries());

  test("the closure really is transitive (it reaches modules outside src/core/msg)", () => {
    const outside = [...graph.keys()].filter(
      (f) => !f.includes("/src/core/msg/") && !f.endsWith("/src/verbs/msg.ts"),
    );
    expect(outside.length).toBeGreaterThan(0);
  });

  test("nothing in the transitive closure imports the tmux abstraction", () => {
    const offenders = [...graph.entries()]
      .filter(([, deps]) => deps.includes(TMUX_ABSTRACTION))
      .map(([file]) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  test("no module in the transitive closure calls a pane-input sending surface", () => {
    const offenders = [...graph.keys()]
      .filter((file) => SENDING_SURFACE.test(code(readFileSync(file, "utf8"))))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  test("the walker catches a send path hidden behind a helper (fixture)", () => {
    // A helper two hops away imports the tmux abstraction: the closure
    // must reach it even though the entry file never names tmux.
    const fixture = join(ROOT, "tests/fixtures/msg-boundary");
    const g = importClosure([join(fixture, "entry.ts")]);
    const reached = [...g.entries()].filter(([, deps]) =>
      deps.some((d) => d.endsWith("/src/abstractions/tmux.ts")),
    );
    expect(reached.map(([f]) => relative(fixture, f))).toEqual(["hop2.ts"]);
  });
});

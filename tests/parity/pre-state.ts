// ADR-029: Parity row-level pre-state hook.
//
// State-mutating verbs that exercise the UPDATE class (dispatch / claim /
// done) need state files pre-seeded BEFORE `runVerb` fires — `kanban.json`
// must already contain the task the verb operates on. The `lifecycle`
// fixture preset (per ADR-026) ships a bare empty kanban; iter-3 needs a
// uniform mechanism to layer per-row pre-state ON TOP of the preset
// without forking a new preset.
//
// `applyPreState` walks `row.preState` entries and writes each into the
// row's per-side cloned fixture dir. Per-relPath: a JSON-shaped value
// stringifies (2-space indent, matches the lifecycle preset's
// `JSON.stringify(team, null, 2)` shape) + writes; a string writes the
// literal content verbatim. Both sides receive identical pre-state per
// ADR-029 §3 (per-side asymmetry is iter-4+ work).
//
// Pair: `tests/parity/index.test.ts` (call site, after per-side clone);
//       `tests/parity/matrix.ts` (`ParityRow.preState` type);
//       `docs/adr-bun/029-phase3-state-mutating-lane-scope.md` §3.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Apply pre-state writes to a fixture root. Each `<relPath>` is resolved
 * against `rootDir`; intermediate dirs are created via `mkdir -p`. JSON
 * values stringify with 2-space indent + trailing newline; strings write
 * verbatim (no newline-coercion — caller controls line endings).
 *
 * `undefined` / empty `preState` is a no-op. Existing files at any
 * `<relPath>` are overwritten — this is by design (caller has already
 * decided the row needs the file in a specific shape).
 *
 * Returns `void` on success; rethrows fs errors verbatim (test harness
 * surfaces them as test failures, which is the desired signal — a row
 * whose preState path is malformed should fail loudly, not green-falsely).
 */
export async function applyPreState(
  rootDir: string,
  preState?: Record<string, unknown>,
): Promise<void> {
  if (!preState) return;
  for (const [relPath, value] of Object.entries(preState)) {
    const absPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(absPath, content);
  }
}

// Source-tree guard test (t-d0229be5, expanded by t-fe0bfb65) —
// forbid bare `getDefaultSocket(<team>.name)` outside an explicit
// allowlist.
//
// Drives the same scanner that backs `scripts/lint-socket-resolver.ts`
// (wired into `pnpm lint`) — defence-in-depth at near-zero cost. The
// CLI lint catches violations at editor/CI/commit time; this test
// catches them on `bun test` so a regression can't sneak through a
// missing lint invocation.
//
// Rule semantics + allowlist rationale live in
// `src/core/socket-resolver-lint.ts`. Keep this test thin — anything
// non-trivial belongs in the shared module so the script + test stay
// in sync.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ALLOWLIST, lintFileContent, lintSourceTree } from "../../src/core/socket-resolver-lint.ts";

const SRC_ROOT = resolve(import.meta.dir, "..", "..", "src");

describe("socket-resolver guard (t-d0229be5, t-fe0bfb65)", () => {
  test("no bare `getDefaultSocket(<ident>.name)` outside the allowlist", async () => {
    const findings = await lintSourceTree(SRC_ROOT);
    if (findings.length > 0) {
      const report = findings.map((v) => `  src/${v.file}:${v.line}\n    ${v.text}`).join("\n");
      throw new Error(
        `socket-resolver guard: ${findings.length} bare \`getDefaultSocket(<team>.name)\` call(s) found.\n\n${report}\n\nUse \`resolveTeamSocket(team)\` instead — it honours \`team.tmuxTmpdir\`.\nIf this site genuinely cannot reach a full Team object (e.g. a CLI string),\nadd the file path to ALLOWLIST in src/core/socket-resolver-lint.ts\nwith a justifying comment.`,
      );
    }
    expect(findings).toHaveLength(0);
  });

  test("allowlist entries actually exist on disk", async () => {
    for (const rel of ALLOWLIST) {
      const path = join(SRC_ROOT, rel);
      const body = await readFile(path, "utf8").catch(() => null);
      expect(body).not.toBeNull();
    }
  });

  test("scanner flags a deliberately-broken site (positive-control)", () => {
    const findings = lintFileContent(
      "verbs/fake.ts",
      `import { getDefaultSocket } from "../core/common.ts";\n\nexport function bad(team: { name: string }) {\n  return getDefaultSocket(team.name);\n}\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
    expect(findings[0]?.file).toBe("verbs/fake.ts");
  });

  test("scanner skips allowlisted files even when they contain the pattern", () => {
    const findings = lintFileContent("core/common.ts", `return getDefaultSocket(team.name);\n`);
    expect(findings).toHaveLength(0);
  });

  test("scanner ignores the pattern inside line comments", () => {
    const findings = lintFileContent(
      "verbs/fake.ts",
      `// Migrate getDefaultSocket(team.name) → resolveTeamSocket(team).\n`,
    );
    expect(findings).toHaveLength(0);
  });

  test("scanner ignores the pattern inside block-comment continuation lines", () => {
    const findings = lintFileContent(
      "verbs/fake.ts",
      ` * Avoid bare getDefaultSocket(team.name) on the write side.\n`,
    );
    expect(findings).toHaveLength(0);
  });

  test("scanner ignores `getDefaultSocket(stringLiteral)` (no .name)", () => {
    const findings = lintFileContent("verbs/fake.ts", `const s = getDefaultSocket("alpha");\n`);
    expect(findings).toHaveLength(0);
  });

  test("scanner ignores `getDefaultSocket(parsed.team)` (string CLI param, not .name)", () => {
    const findings = lintFileContent("verbs/fake.ts", `const s = getDefaultSocket(parsed.team);\n`);
    expect(findings).toHaveLength(0);
  });
});

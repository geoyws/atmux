// Source-tree guard test (t-d0229be5) — forbid bare
// `getDefaultSocket(<team>.name)` outside the definition site.
//
// `getDefaultSocket(teamName)` constructs the canonical bun fallback
// socket `/tmp/atmux-<team>/sock`. Anywhere a full Team object is in
// scope, callers MUST go through `resolveTeamSocket(team)` so that
// `team.tmuxTmpdir` is honoured (write-side parity with the read-side
// fix in t-add5976a; same vulnerability class as t-b37c8f4f).
//
// The guard targets the structural shape `getDefaultSocket(<ident>.name)`
// — identifier dot-access ending in `.name`. String-literal callers
// (`getDefaultSocket("alpha")`) and CLI-string parameters
// (`getDefaultSocket(parsed.team)` where `parsed.team` is a flag string,
// not a Team object) are out of scope; they don't have a Team object
// to consult.
//
// Allowlisted call sites are documented in the ALLOW set below.

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir, "..", "..", "src");

/** Files where `getDefaultSocket` may legitimately appear in any form
 *  (definition, alias re-export, or justified call). */
const ALLOW = new Set<string>([
  // The definition + the resolveTeamSocket fallback.
  "core/common.ts",
  // Re-exports `getDefaultSocket` under the legacy name `defaultSocketPath`.
  // The re-export itself isn't a call site; `start.ts` body uses
  // `resolveTeamSocket` for its actual socket resolution. Allowlisted so
  // the regex doesn't have to inspect re-export shape.
  "verbs/start.ts",
  // Same as start.ts — `defaultSocketPath` alias re-export.
  "verbs/attach.ts",
  // Justified fallback: the `team repair-rename` verb operates on a
  // bash-era team that has NOT yet been ported to bun-native tmpdir
  // semantics. Its CLI `--team <name>` arg is a string, no full Team
  // object in scope at the call sites. Repair semantics deliberately
  // anchor on the canonical socket as the post-repair target.
  "verbs/team-repair-rename.ts",
]);

/** Recursive walk of `*.ts` files under `dir`, returning paths relative
 *  to `SRC_ROOT`. */
async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (e.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        out.push(full.slice(SRC_ROOT.length + 1));
      }
    }
  };
  await walk(dir);
  return out.sort();
}

describe("socket-resolver guard (t-d0229be5)", () => {
  test("no bare `getDefaultSocket(<ident>.name)` outside the allowlist", async () => {
    const files = await listTypeScriptFiles(SRC_ROOT);
    // Captures the receiver expression (everything up to `.name`) so the
    // failure message points at the offending identifier — `team`,
    // `this.team`, `ctx.team`, etc. Match-anywhere; line scan handles
    // the human-readable reporting.
    const BAD_CALL = /getDefaultSocket\(\s*[a-zA-Z_$][a-zA-Z_$0-9.]*\.name\s*\)/;
    const violations: { file: string; line: number; text: string }[] = [];

    for (const rel of files) {
      if (ALLOW.has(rel)) continue;
      const body = await readFile(join(SRC_ROOT, rel), "utf8");
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Skip pure-comment lines so docstrings citing the pattern
        // ("e.g. getDefaultSocket(team.name)") don't trip the guard.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (BAD_CALL.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  src/${v.file}:${v.line}\n    ${v.text}`)
        .join("\n");
      throw new Error(
        `socket-resolver guard: ${violations.length} bare \`getDefaultSocket(<team>.name)\` call(s) found.\n\n${report}\n\nUse \`resolveTeamSocket(team)\` instead — it honours \`team.tmuxTmpdir\`.\nIf this site genuinely cannot reach a full Team object (e.g. a CLI string),\nadd the file path to the ALLOW set in tests/unit/socket-resolver-guard.test.ts\nwith a justifying comment.`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  test("allowlist entries actually exist", async () => {
    for (const rel of ALLOW) {
      const path = join(SRC_ROOT, rel);
      const body = await readFile(path, "utf8").catch(() => null);
      expect(body).not.toBeNull();
    }
  });
});


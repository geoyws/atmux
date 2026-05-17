// t-fe0bfb65: socket-resolver lint — forbid bare
// `getDefaultSocket(<ident>.name)` outside an explicit allowlist.
//
// `getDefaultSocket(teamName)` constructs the canonical bun-fallback
// socket `/tmp/atmux-<team>/sock`. Anywhere a full Team object is in
// scope, callers MUST go through `resolveTeamSocket(team)` so that
// `team.tmuxTmpdir` is honoured authoritatively (the write-side
// invariant established by t-add5976a + t-b37c8f4f + t-d0229be5).
//
// This module is the pure file-content scanner. The CLI wrapper at
// `scripts/lint-socket-resolver.ts` wires it into `pnpm lint` so the
// gate fires at editor/CI time, not just `bun test`. The same scanner
// also backs the unit-test guard at
// `tests/unit/socket-resolver-guard.test.ts` — defence-in-depth at
// near-zero cost.
//
// Pattern targeted: structural shape `getDefaultSocket(<ident>.name)`
// — an identifier dot-access ending in `.name`. String-literal
// callers (`getDefaultSocket("alpha")`) and CLI-string parameters
// (`getDefaultSocket(parsed.team)`, where `parsed.team` is a CLI flag
// string, not a Team object) are out of scope; they don't have a
// Team object in scope to consult.
//
// Biome v2.4 lacks a stable user-defined-rule plugin API; until that
// lands we keep the regex scan as the implementation. Reconsider as
// a Biome GritQL plugin when biome plugins/rules go stable.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** One lint finding — a forbidden call site. */
export interface SocketResolverFinding {
  /** Path relative to the source root (e.g. `verbs/foo.ts`). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The offending line, trimmed. */
  text: string;
}

/** Files where `getDefaultSocket` may appear in any form (definition,
 *  alias re-export, or justified call). Keep this set tiny — every
 *  entry is a documented carve-out, not a convenience.
 *
 *  Paths are relative to the source root (e.g. `core/common.ts`,
 *  `verbs/start.ts`). */
export const ALLOWLIST: ReadonlyArray<string> = [
  // Definition + the `resolveTeamSocket` canonical-fallback path.
  "core/common.ts",
  // Re-exports `getDefaultSocket` under the legacy alias
  // `defaultSocketPath`; the re-export itself isn't a call site, and
  // the file's own socket resolution goes through `resolveTeamSocket`.
  "verbs/start.ts",
  // Same as start.ts — `defaultSocketPath` alias re-export.
  "verbs/attach.ts",
  // Justified fallback: the `team repair-rename` verb operates on a
  // bash-era team where the CLI `--team <name>` arg is a string with
  // no full Team object in scope at the call sites. Repair semantics
  // deliberately anchor on the canonical socket as the post-repair
  // target.
  "verbs/team-repair-rename.ts",
  // Justified fallback (t-b5864443): `resolveCageSocket` is the cockpit
  // single-source-of-truth that goes through `resolveTeamSocket` on the
  // happy path. When `loadTeam` throws (team.json missing / unreadable
  // / malformed) there is no Team object available, so the canonical
  // `/tmp/atmux-<cockpitTeam.name>/sock` fallback is the only safe
  // default. Cockpit rebuild must stay green even when a member team
  // is misconfigured — same posture as `resolveTeamWindowMode`'s
  // `no-driver-config` placeholder branch.
  "core/cockpit.ts",
];

/** Match-anywhere: `getDefaultSocket(<ident>[.x.y]*.name)`. Captures
 *  the structural shape only — receiver expression must be a dotted
 *  identifier chain ending in `.name`. */
const BAD_CALL = /getDefaultSocket\(\s*[a-zA-Z_$][a-zA-Z_$0-9.]*\.name\s*\)/;

/** Recursive walk of `*.ts` files under `dir`, returning paths
 *  relative to `dir`. Skips `*.test.ts` (tests cite the pattern in
 *  fixture strings and documentation). */
export async function listTypeScriptFiles(dir: string): Promise<string[]> {
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
        out.push(full.slice(dir.length + 1));
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/** Scan a single file's content for forbidden calls. Pure — drives
 *  the unit-test guard without filesystem access. */
export function lintFileContent(relativePath: string, content: string): SocketResolverFinding[] {
  if (ALLOWLIST.includes(relativePath)) return [];
  const findings: SocketResolverFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip pure-comment lines so docstrings citing the pattern
    // ("e.g. `getDefaultSocket(team.name)`") don't trip the guard.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (BAD_CALL.test(line)) {
      findings.push({ file: relativePath, line: i + 1, text: trimmed });
    }
  }
  return findings;
}

/** Scan the entire source tree rooted at `srcRoot`. CLI entry. */
export async function lintSourceTree(srcRoot: string): Promise<SocketResolverFinding[]> {
  const files = await listTypeScriptFiles(srcRoot);
  const all: SocketResolverFinding[] = [];
  for (const rel of files) {
    const body = await readFile(join(srcRoot, rel), "utf8");
    all.push(...lintFileContent(rel, body));
  }
  return all;
}

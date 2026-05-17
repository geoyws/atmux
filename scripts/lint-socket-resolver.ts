#!/usr/bin/env bun
// t-fe0bfb65: socket-resolver lint CLI wrapper.
//
// Reviewer-gate runs `bun scripts/lint-socket-resolver.ts` (zero-arg)
// to enforce the "no bare `getDefaultSocket(<team>.name)` outside the
// allowlist" rule across the source tree. Exits 0 when clean, 1 with
// one finding line per violation otherwise.
//
// Override the source root with a positional arg:
//   bun scripts/lint-socket-resolver.ts /path/to/alt-src

import { resolve } from "node:path";
import { lintSourceTree } from "../src/core/socket-resolver-lint.ts";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const srcRoot = argv[0] ?? resolve(process.cwd(), "src");
  const findings = await lintSourceTree(srcRoot);
  if (findings.length === 0) {
    process.stderr.write(`socket-resolver-lint: clean (root=${srcRoot})\n`);
    return 0;
  }
  for (const f of findings) {
    process.stdout.write(`src/${f.file}:${f.line}: bare \`getDefaultSocket(<team>.name)\` — ${f.text}\n`);
  }
  process.stderr.write(
    `\nsocket-resolver-lint: ${findings.length} finding(s). Use \`resolveTeamSocket(team)\` instead — honours \`team.tmuxTmpdir\`.\nAdd file to ALLOWLIST in src/core/socket-resolver-lint.ts only when no full Team object is in scope (justifying comment required).\n`,
  );
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);

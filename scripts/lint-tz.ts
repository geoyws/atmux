#!/usr/bin/env bun
// ADR-057 §D5d: TZ lint CLI wrapper.
//
// Reviewer-gate runs `bun scripts/lint-tz.ts` (zero-arg) to enforce the
// no-bare-HH:MM rule across the user-facing-emit set. Exits 0 when
// clean, 1 with a per-finding line on failure.
//
// Override the file list with positional args:
//   bun scripts/lint-tz.ts src/verbs/foo.ts src/verbs/bar.ts

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_TRACKED_FILES, lintFileContent, type TzLintFinding } from "../src/core/tz-lint.ts";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const files = argv.length > 0 ? argv : DEFAULT_TRACKED_FILES;
  const all: TzLintFinding[] = [];
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      // Skip absent files — D5d brief lists files that may not exist
      // yet (decisions.ts, flags.ts); the gate fires only on present
      // files. The reviewer can grep new files into the list as they land.
      continue;
    }
    all.push(...lintFileContent(file, content));
  }
  if (all.length === 0) {
    process.stderr.write(`tz-lint: clean (${files.length} file(s) scanned)\n`);
    return 0;
  }
  for (const f of all) {
    process.stdout.write(
      `${f.file}:${f.line}: bare timestamp \`${f.match}\` lacks 'MYT' or '+08:00' suffix — ${f.context}\n`,
    );
  }
  process.stderr.write(
    `\ntz-lint: ${all.length} finding(s). Use formatMyt/formatMytFull from src/abstractions/time.ts.\n`,
  );
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);

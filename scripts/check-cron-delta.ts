#!/usr/bin/env bun
// t-e1247699: CI guard — bun-test cron-leak detection.
//
// Counts marker-fenced `>>> atmux:team=` header lines in the host
// crontab and compares to a pre-recorded baseline. Fails (exit 2) on
// any positive delta — i.e. a `bun test` run left orphan cron blocks
// pointing at now-deleted mkdtemp fixtures.
//
// Usage:
//   # Pre-test baseline (write to a file)
//   bun scripts/check-cron-delta.ts --record /tmp/cron-baseline.txt
//   # ... run `bun test` ...
//   # Post-test gate (read + compare)
//   bun scripts/check-cron-delta.ts --check /tmp/cron-baseline.txt
//
// CI wires the pair around `bun test` in `.github/workflows/ci.yml`.
// Devs can run locally too — same script, no env coupling.
//
// Non-fatal when `crontab` is absent (records `0`, check passes).
// Bash equivalent at `tests/helpers/setup.bash:138-157`
// (`_atmux_teardown_cron_path_sweep`) — that helper PRUNES; this gate
// DETECTS post-run. Layered defense: prune at test teardown +
// detect at CI boundary.

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const HEADER_PREFIX = "# >>> atmux:team=";

async function countAtmuxBlocks(): Promise<number> {
  return await new Promise<number>((resolve) => {
    const p = spawn("crontab", ["-l"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    p.on("close", () => {
      // `crontab -l` exits 1 when no crontab installed — treat as 0
      // blocks. Either path resolves with the count below.
      let n = 0;
      for (const ln of out.split("\n")) {
        if (ln.startsWith(HEADER_PREFIX)) n += 1;
      }
      resolve(n);
    });
    p.on("error", () => resolve(0));
  });
}

async function readBaseline(path: string): Promise<number> {
  try {
    const txt = await readFile(path, "utf8");
    const n = Number.parseInt(txt.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    // Missing baseline is fail-secure: callers MUST `--record` first
    // so the post-run check has something to compare. Surface a clear
    // error rather than silently passing.
    process.stderr.write(`check-cron-delta: baseline file not found: ${path}\n`);
    process.stderr.write(`  run: bun scripts/check-cron-delta.ts --record ${path}\n`);
    process.stderr.write(`  before invoking 'bun test'\n`);
    process.exit(2);
  }
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const mode = argv[0];
  const path = argv[1];
  if ((mode !== "--record" && mode !== "--check") || path === undefined) {
    process.stderr.write(
      "usage: bun scripts/check-cron-delta.ts (--record|--check) <baseline-file>\n",
    );
    return 2;
  }
  const current = await countAtmuxBlocks();
  if (mode === "--record") {
    await writeFile(path, `${current}\n`, "utf8");
    process.stdout.write(`check-cron-delta: baseline ${current} blocks → ${path}\n`);
    return 0;
  }
  const baseline = await readBaseline(path);
  const delta = current - baseline;
  if (delta > 0) {
    process.stderr.write(
      `check-cron-delta: FAIL — ${delta} new atmux:team= block(s) (baseline ${baseline}, current ${current})\n`,
    );
    process.stderr.write(
      "  bun test leaked cron entries; inspect with: crontab -l | grep '>>> atmux:team='\n",
    );
    process.stderr.write(
      "  recover with: atmux cron-orphans --prune  (strips blocks whose ATMUX_DIR is missing on disk)\n",
    );
    return 2;
  }
  process.stdout.write(
    `check-cron-delta: OK — ${current} block(s), no delta vs baseline\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c));

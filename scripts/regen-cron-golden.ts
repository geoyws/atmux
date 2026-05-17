#!/usr/bin/env bun
// Regenerator for tests/golden/cron-block.txt (ADR-057 §D6d / t-bb519494).
//
// Re-run when an intentional change lands in src/core/cron.ts that
// shifts the rendered crontab block shape. Emits the byte-equal block;
// the test harness preserves the human-readable header in the golden
// file (lines before `# >>> atmux:team=`) — paste only the lines from
// the canonical block start through `# <<< atmux:team=` footer over the
// existing block portion of the golden file.
//
// Usage (manual):
//   bun scripts/regen-cron-golden.ts
//   # then hand-replace the block portion of tests/golden/cron-block.txt
//
// Usage (in-place rewrite — preserves header):
//   bun scripts/regen-cron-golden.ts --in-place
//
// The reference Team here MUST match the documented gating-conditions
// table in tests/golden/cron-block.txt (header L1-L12). Update both
// sides together if the renderer grows a new cron line.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCronBlock } from "../src/core/cron.ts";
import type { Team } from "../src/schema/team.ts";

const team = {
  name: "golden-reference",
  members: [
    { name: "lead", role: "lead", cwd: "/x" },
    { name: "u", role: "unblocker", cwd: "/x" },
    { name: "fe", role: "member", lane: "fe", cwd: "/x" },
    { name: "ombud", role: "ombudsman", cwd: "/x" },
    { name: "git", role: "committer", cwd: "/x" },
  ],
  whip: { claudeAccount: "icloud" },
  merger: { enabled: true },
  ombudsman: { enabled: true },
  cadence: { enabled: true },
  autoMerge: { enabled: true },
  epicTeam: { parentName: "demo-parent", anchorEpicId: "e-golden01" },
} as unknown as Team;

const block = renderCronBlock({
  team,
  atmuxDir: "/srv/golden-reference/.atmux",
  atmuxBin: "/usr/local/bin/atmux",
});

const inPlace = process.argv.includes("--in-place");
const goldenPath = join(import.meta.dir, "..", "tests/golden/cron-block.txt");

if (!inPlace) {
  process.stdout.write(block);
} else {
  const existing = readFileSync(goldenPath, "utf8");
  const markerIdx = existing.indexOf("\n# >>> atmux:team=");
  if (markerIdx === -1) {
    throw new Error(
      `regen-cron-golden: cannot locate canonical block start (\\n# >>> atmux:team=) in ${goldenPath} — file shape changed; hand-merge`,
    );
  }
  const header = existing.slice(0, markerIdx + 1);
  writeFileSync(goldenPath, header + block, "utf8");
  process.stderr.write(`rewrote ${goldenPath} (header preserved, block replaced)\n`);
}

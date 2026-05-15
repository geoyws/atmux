#!/usr/bin/env bun
// ADR-146 T2: one-shot Story.branch backfill.
//
// Walks every Story in `.atmux/state.db` and, for those without a
// `branch` field set, infers the per-member branch from the Story's
// child tasks' owner. The inference is conservative — it only fires
// when ALL child tasks share the same owner AND that owner is a
// declared member name. Otherwise the Story stays branch-less and
// the ADR-146 auto-emit short-circuits per §D5 (no source-branch →
// no auto-Task; operator backfills manually if desired).
//
// Run-once, idempotent — Stories already carrying a `branch` are
// skipped. Logs counts of inferred / skipped / already-set.
//
// Usage:
//
//   bun scripts/backfill-story-branch.ts [--team-dir <path>] [--apply]
//
// `--apply` writes the inferred branches back to state.db. Without
// it the script runs as a dry-run, printing what WOULD change. Safe
// to re-run.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  closeDatabase,
  openDatabase,
} from "../src/abstractions/sqlite.ts";
import { migrations } from "../src/abstractions/sqlite-migrations.ts";
import { tryLoadTeam } from "../src/core/common.ts";
import { KanbanRepo } from "../src/core/repositories/kanban-repo.ts";

interface Argv {
  teamDir: string;
  apply: boolean;
}

function parseArgs(): Argv {
  const out: Argv = { teamDir: process.cwd(), apply: false };
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === "--team-dir") {
      const v = process.argv[i + 1];
      if (v === undefined) {
        console.error("--team-dir requires a path");
        process.exit(2);
      }
      out.teamDir = resolve(v);
      i += 1;
    } else if (a === "--apply") {
      out.apply = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun scripts/backfill-story-branch.ts [--team-dir <path>] [--apply]\n" +
          "\n" +
          "  Dry-run by default; --apply writes inferences back to state.db.",
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function inferBranch(
  ownerCounts: Map<string, number>,
  memberNames: ReadonlySet<string>,
): string | null {
  // Conservative inference: all child tasks share the same owner +
  // the owner is a declared member (skip the gitter / orphan
  // sentinel cases).
  if (ownerCounts.size !== 1) return null;
  const [singleOwner] = [...ownerCounts.keys()];
  if (singleOwner === undefined || !memberNames.has(singleOwner)) return null;
  // ADR-084 naming convention: `<base>-<member>`. We can't probe the
  // base here without git access — assume "geoyws" per the atmux-
  // team convention. Operator overrides via manual SQL if their team
  // uses a different base. This is the documented default per ADR-146
  // §"branch inference".
  return `geoyws-${singleOwner}`;
}

async function main(): Promise<void> {
  const argv = parseArgs();
  const atmuxDir = join(argv.teamDir, ".atmux");
  const dbPath = join(atmuxDir, "state.db");
  if (!existsSync(dbPath)) {
    console.error(`no state.db at ${dbPath}; run \`atmux init\` first`);
    process.exit(1);
  }
  const team = await tryLoadTeam({ dir: atmuxDir });
  if (team === null) {
    console.error(`no team.json found near ${atmuxDir}; team membership lookup unavailable`);
    process.exit(1);
  }
  const memberNames = new Set(team.members.map((m) => m.name));
  console.log(`team=${team.name}  members=${memberNames.size}  apply=${argv.apply}`);

  const db = openDatabase(dbPath, migrations);
  try {
    const repo = new KanbanRepo(db);
    const stories = repo.listStories();
    let alreadySet = 0;
    let inferred = 0;
    let skipped = 0;
    for (const story of stories) {
      const status = story.status ?? "planning";
      // Per ADR-146 backfill spec, only Stories in active or terminal
      // lifecycle states are candidates. `planning`/`ready` Stories
      // can be backfilled later when they enter `in-progress`.
      if (!["in-progress", "testing", "review", "merging", "done"].includes(status)) {
        continue;
      }
      if (story.branch !== undefined && story.branch !== null && story.branch.length > 0) {
        alreadySet += 1;
        continue;
      }
      const tasks = repo.listTasks({ story: story.id });
      const ownerCounts = new Map<string, number>();
      for (const t of tasks) {
        if (t.owner !== null && t.owner !== undefined && t.owner.length > 0) {
          ownerCounts.set(t.owner, (ownerCounts.get(t.owner) ?? 0) + 1);
        }
      }
      const branch = inferBranch(ownerCounts, memberNames);
      if (branch === null) {
        skipped += 1;
        console.log(
          `  skipped ${story.id}: ${status}, ${tasks.length} task(s), owners=[${[...ownerCounts.keys()].join(", ")}]`,
        );
        continue;
      }
      inferred += 1;
      console.log(`  inferred ${story.id}: branch=${branch} (${status})`);
      if (argv.apply) {
        repo.upsertStory({ ...story, branch });
      }
    }
    console.log(
      `\nsummary: already-set=${alreadySet}  inferred=${inferred}  skipped=${skipped}` +
        (argv.apply ? "" : "  (dry-run — re-run with --apply to write)"),
    );
  } finally {
    closeDatabase(db);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ADR-010: CLI dispatcher — `issues` verb (the git task source, ADR-263 §D3).
//
//   atmux issues sync [--source <scope>] [--dry-run] [--team-dir <dir>]
//
// `issues sync` polls each `team.json::taskSources` entry's tracker and
// upserts matching issues/PRs as tasks in `state.db`, deduped on the
// canonical `sourceId`. Feed-only — no complaints, no lead, no
// auto-dispatch; a Claude pane (or the operator) picks the task up via
// `atmux claim --next`.
//
// All real work lives in `core/issue-sync.ts`; this verb is CLI plumbing
// (flag parse + source selection + result rendering).

import { getAtmuxDir, type ResolveDirOpts, requireTeam } from "../core/common.ts";
import { type SyncDeps, type SyncResult, syncSource } from "../core/issue-sync.ts";
import { ConfigError, UsageError } from "../errors.ts";
import type { TaskSource } from "../schema/team.ts";

const USAGE_ROOT = "atmux issues sync [--source <scope>] [--dry-run] [--team-dir <dir>]";
const USAGE_SYNC = USAGE_ROOT;

/** `atmux issues <subverb> [args]`. `deps` is the DI seam for tests
 *  (default: the production github resolver inside `core/issue-sync`). */
export async function issues(argv: ReadonlyArray<string>, deps: SyncDeps = {}): Promise<number> {
  const verb = argv[0];
  if (verb === undefined) {
    throw new UsageError({ what: "issues: missing subverb", hint: USAGE_ROOT });
  }
  switch (verb) {
    case "sync":
      return await issuesSync(argv.slice(1), deps);
    default:
      throw new UsageError({
        what: `issues: unknown subverb: ${verb} (only 'sync')`,
        hint: USAGE_ROOT,
      });
  }
}

interface ParsedSyncArgs {
  source?: string;
  dryRun: boolean;
  teamDir?: string;
}

export function parseSyncArgs(argv: ReadonlyArray<string>): ParsedSyncArgs {
  let source: string | undefined;
  let dryRun = false;
  let teamDir: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--source") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({ what: "issues sync: --source requires a value", hint: USAGE_SYNC });
      }
      source = v;
      i += 2;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (a === "--team-dir") {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new UsageError({
          what: "issues sync: --team-dir requires a value",
          hint: USAGE_SYNC,
        });
      }
      teamDir = v;
      i += 2;
      continue;
    }
    throw new UsageError({ what: `issues sync: unknown arg: ${a ?? ""}`, hint: USAGE_SYNC });
  }
  const out: ParsedSyncArgs = { dryRun };
  if (source !== undefined) out.source = source;
  if (teamDir !== undefined) out.teamDir = teamDir;
  return out;
}

async function issuesSync(argv: ReadonlyArray<string>, deps: SyncDeps): Promise<number> {
  const parsed = parseSyncArgs(argv);
  const dirOpts: ResolveDirOpts = parsed.teamDir !== undefined ? { teamDir: parsed.teamDir } : {};
  const atmuxDir = await getAtmuxDir(dirOpts);
  const team = await requireTeam(dirOpts);

  const all: ReadonlyArray<TaskSource> = team.taskSources ?? [];
  if (all.length === 0) {
    throw new ConfigError({
      what: "issues sync: no taskSources configured in team.json",
      hint: 'add e.g. "taskSources": [{ "provider": "github", "scope": "owner/repo", "labels": ["bug"] }]',
    });
  }

  // Select sources: --source filters by exact scope match.
  const selected = parsed.source !== undefined ? all.filter((s) => s.scope === parsed.source) : all;
  if (selected.length === 0) {
    throw new ConfigError({
      what: `issues sync: no taskSource with scope "${parsed.source}"`,
      hint: `configured scopes: ${all.map((s) => s.scope).join(", ")}`,
    });
  }

  const results: SyncResult[] = [];
  for (const source of selected) {
    results.push(await syncSource(atmuxDir, source, deps, { dryRun: parsed.dryRun }));
  }

  for (const r of results) {
    const verb = parsed.dryRun ? "would sync" : "synced";
    process.stdout.write(
      `${verb} ${r.provider}:${r.scope} — fetched ${r.fetched}, created ${r.created}, updated ${r.updated}, closed ${r.closed}\n`,
    );
    // Per-issue errors are non-fatal (the sync continued past them);
    // surface each as a warning but the verb still exits 0 on a run that
    // completed.
    for (const err of r.errors) {
      process.stderr.write(`  ! ${err}\n`);
    }
  }
  return 0;
}

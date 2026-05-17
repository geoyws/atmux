// ADR-164 §"Verb registration + CLI shape" — `atmux sync <sub>` dispatcher.
//
// Sub-verbs:
//   claude-team-json  — materialize .claude/team.json from .atmux/team.json
//                       per ADR-164 §Behavior. Composed across T2-T6:
//                         T2 (this file)  — dispatcher + sub-verb registry
//                         T3              — core compute path (src/core/sync-claude-team-json/*)
//                         T4 (this file)  — --overwrite-briefs flag-parse
//                         T5              — drift detection + --force (pending)
//                         T6 (this file)  — --dry-run preview wired through
//                                            computeMappedTeam → renderDiff → stdout
//
// Mirrors the dispatcher pattern in src/verbs/team.ts (`dispatchTeamSubverb`)
// + src/verbs/member.ts (`dispatchMemberSubverb`) — bare `atmux sync` and
// unknown sub-verbs both throw UsageError so the exit code matches
// reportError's existing 64 path. Future sync targets (cockpit-json,
// inbox-mirror, etc.) slot into the switch without breaking parity.

import { renderDiff } from "../core/sync-claude-team-json/diff.ts";
import {
  computeMappedTeam,
  type ComputeOpts,
} from "../core/sync-claude-team-json/index.ts";
import { defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";

const KNOWN_SUBVERBS = ["claude-team-json"] as const;
type KnownSubverb = (typeof KNOWN_SUBVERBS)[number];

function subverbList(): string {
  return KNOWN_SUBVERBS.join(" | ");
}

/** Injection points for test isolation. `dir` / `teamDir` / `cwd` /
 *  `env` thread through to `computeMappedTeam` via the shared
 *  `ComputeOpts` shape; `claudeDir` pins the `.claude/` lookup dir;
 *  `stdout` lets unit tests capture the dry-run preview without
 *  prodding `process.stdout`. */
export interface SyncOpts extends ComputeOpts {
  stdout?: Writer;
}

export async function dispatchSyncSubverb(
  argv: ReadonlyArray<string>,
  opts: SyncOpts = {},
): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "") {
    throw new UsageError({
      what: `sync: subverb required (try: ${subverbList()})`,
      hint: "run 'atmux help' for the list of verbs",
    });
  }
  switch (sub as KnownSubverb) {
    case "claude-team-json":
      return syncClaudeTeamJson(argv.slice(1), opts);
    default:
      throw new UsageError({
        what: `sync: unknown subverb '${sub}' (try: ${subverbList()})`,
        hint: "run 'atmux help' for the list of verbs",
      });
  }
}

// Flag-parse contract for `atmux sync claude-team-json`. T4 (t-87e81c8e)
// added `--overwrite-briefs`. T5 will add `--force` (drift override). T6
// (this commit, t-fe4a570e) adds `--dry-run` — `--dry-run` skips the
// atomic write step and instead renders a unified-diff-style preview to
// stdout per ADR-164 §Behavior step 8.
interface SyncClaudeTeamJsonFlags {
  overwriteBriefs: boolean;
  dryRun: boolean;
}

function parseSyncClaudeTeamJsonFlags(
  argv: ReadonlyArray<string>,
): SyncClaudeTeamJsonFlags {
  const flags: SyncClaudeTeamJsonFlags = { overwriteBriefs: false, dryRun: false };
  for (const a of argv) {
    if (a === "--overwrite-briefs") {
      flags.overwriteBriefs = true;
      continue;
    }
    if (a === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new UsageError({
        what: `sync claude-team-json: unknown flag: ${a}`,
        hint: "known flags: --dry-run | --overwrite-briefs (T5 will add --force)",
      });
    }
    throw new UsageError({
      what: `sync claude-team-json: unexpected positional arg: ${a}`,
      hint: "this subverb takes no positional args; try --dry-run or --overwrite-briefs",
    });
  }
  return flags;
}

async function syncClaudeTeamJson(
  argv: ReadonlyArray<string>,
  opts: SyncOpts,
): Promise<number> {
  const flags = parseSyncClaudeTeamJsonFlags(argv);

  if (flags.dryRun) {
    // T6 (t-fe4a570e) — preview path: compute the mapped roster against
    // the current on-disk Claude file (or null = fresh-file) and render
    // a +/-/space diff. SKIPS the atomic write step per ADR-164 §Behavior
    // step 8. `overwriteBriefs` is parsed-and-ignored on the dry-run path
    // until T4's mergeBriefs is threaded into computeMappedTeam (out of
    // scope for T6 — owned by T4's follow-up wiring commit).
    const { prior, computed } = await computeMappedTeam(opts);
    const out = renderDiff(prior, computed);
    (opts.stdout ?? defaultStdoutWrite)(out);
    return 0;
  }

  // Non-dry-run write path lands when T4 (brief-preservation write
  // wiring) + T5 (drift detection + --force) layer the atomic write on
  // top. Until both ship, the dispatcher signals stub-status here.
  // T7 (t-4329b053) integrated tests assert the post-T4/T5 write path
  // end-to-end; T6 (this commit) covers the preview branch only.
  throw new Error(
    "atmux sync claude-team-json: write path not yet implemented — see T4 (t-87e81c8e) + T5 (t-c2b757c1). Use --dry-run for preview (ADR-164 §Behavior step 8).",
  );
}

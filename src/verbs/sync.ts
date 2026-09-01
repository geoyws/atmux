// ADR-164 §"Verb registration + CLI shape" — `atmux sync <sub>` dispatcher.
//
// Sub-verbs:
//   claude-team-json  — materialize .claude/team.json from .atmux/team.json
//                       per ADR-164 §Behavior. Composed across T2-T6:
//                         T2 (this file)  — dispatcher + sub-verb registry
//                         T3              — core compute path (src/core/sync-claude-team-json/*)
//                         T4 (this file)  — --overwrite-briefs flag-parse
//                         T5 (this file)  — --force flag-parse + write-path
//                                            wire-through (writeSync composes
//                                            drift detection + atomic write +
//                                            event log; DriftAbortError surfaces
//                                            as exit 65 here)
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
  DriftAbortError,
  EX_DATAERR,
  formatDriftHint,
} from "../core/sync-claude-team-json/drift.ts";
import {
  computeMappedTeam,
  writeSync,
  type ComputeOpts,
  type WriteSyncOpts,
} from "../core/sync-claude-team-json/index.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";

const KNOWN_SUBVERBS = ["claude-team-json"] as const;
type KnownSubverb = (typeof KNOWN_SUBVERBS)[number];

function subverbList(): string {
  return KNOWN_SUBVERBS.join(" | ");
}

/** Injection points for test isolation. `dir` / `teamDir` / `cwd` /
 *  `env` thread through to `computeMappedTeam` / `writeSync` via the
 *  shared `ComputeOpts` shape; `claudeDir` pins the `.claude/` lookup
 *  dir; `stdout` lets unit tests capture the dry-run preview;
 *  `stderr` captures the drift warning; `now` pins the marker
 *  timestamp for deterministic write-path assertions. */
export interface SyncOpts extends ComputeOpts {
  stdout?: Writer;
  stderr?: Writer;
  now?: WriteSyncOpts["now"];
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
// added `--overwrite-briefs`. T5 (t-c2b757c1) adds `--force` (drift
// override per ADR-164 §"Behavior" step 5 + §OQ-5). T6 (t-fe4a570e)
// adds `--dry-run` — skips the atomic write step and instead renders a
// unified-diff-style preview to stdout per ADR-164 §Behavior step 8.
interface SyncClaudeTeamJsonFlags {
  overwriteBriefs: boolean;
  dryRun: boolean;
  force: boolean;
}

function parseSyncClaudeTeamJsonFlags(argv: ReadonlyArray<string>): SyncClaudeTeamJsonFlags {
  const flags: SyncClaudeTeamJsonFlags = {
    overwriteBriefs: false,
    dryRun: false,
    force: false,
  };
  for (const a of argv) {
    if (a === "--overwrite-briefs") {
      flags.overwriteBriefs = true;
      continue;
    }
    if (a === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (a === "--force") {
      flags.force = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new UsageError({
        what: `sync claude-team-json: unknown flag: ${a}`,
        hint: "known flags: --dry-run | --overwrite-briefs | --force",
      });
    }
    throw new UsageError({
      what: `sync claude-team-json: unexpected positional arg: ${a}`,
      hint: "this subverb takes no positional args; try --dry-run, --overwrite-briefs, or --force",
    });
  }
  return flags;
}

async function syncClaudeTeamJson(argv: ReadonlyArray<string>, opts: SyncOpts): Promise<number> {
  const flags = parseSyncClaudeTeamJsonFlags(argv);

  if (flags.dryRun) {
    // T6 (t-fe4a570e) — preview path: compute the mapped roster against
    // the current on-disk Claude file (or null = fresh-file) and render
    // a +/-/space diff. SKIPS the atomic write step per ADR-164 §Behavior
    // step 8. The dry-run path intentionally bypasses drift detection
    // (drift.ts §note) so previewing never aborts.
    const computeOpts: ComputeOpts = {
      ...opts,
      overwriteBriefs: flags.overwriteBriefs,
    };
    const { prior, computed } = await computeMappedTeam(computeOpts);
    const out = renderDiff(prior, computed);
    (opts.stdout ?? defaultStdoutWrite)(out);
    return 0;
  }

  // T5 (t-c2b757c1) write path — compose drift detection + atomic write
  // via writeSync. DriftAbortError surfaces as exit 65 (EX_DATAERR) with
  // a 3-line diff hint emitted to stderr; the one-line drift warning was
  // already emitted inside writeSync. Other errors propagate as-is so
  // reportError's existing exit-code routing kicks in.
  const writeOpts = {
    ...opts,
    overwriteBriefs: flags.overwriteBriefs,
    force: flags.force,
  } as WriteSyncOpts;
  const stderr = opts.stderr ?? defaultStderrWrite;
  try {
    await writeSync(writeOpts);
    return 0;
  } catch (e) {
    if (e instanceof DriftAbortError) {
      stderr(`${formatDriftHint(e.detection)}\n`);
      stderr(
        "atmux sync claude-team-json: refusing to overwrite drifted .claude/team.json; re-run with --force to override\n",
      );
      return EX_DATAERR;
    }
    throw e;
  }
}

// ADR-164 §"Verb registration + CLI shape" — `atmux sync <sub>` dispatcher.
//
// First sub-verb: `claude-team-json` (materialize .claude/team.json from
// .atmux/team.json per ADR-164 §Behavior). Stubbed in T2; T3 wires the
// real core mapping module at src/core/sync-claude-team-json/* and T4-T6
// extend it with brief-preservation, drift detection, and --dry-run.
//
// Mirrors the dispatcher pattern in src/verbs/team.ts (`dispatchTeamSubverb`)
// + src/verbs/member.ts (`dispatchMemberSubverb`) — bare `atmux sync` and
// unknown sub-verbs both throw UsageError so the exit code matches
// reportError's existing 64 path. Future sync targets (cockpit-json,
// inbox-mirror, etc.) slot into the switch without breaking parity.

import { UsageError } from "../errors.ts";

const KNOWN_SUBVERBS = ["claude-team-json"] as const;
type KnownSubverb = (typeof KNOWN_SUBVERBS)[number];

function subverbList(): string {
  return KNOWN_SUBVERBS.join(" | ");
}

export async function dispatchSyncSubverb(argv: ReadonlyArray<string>): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "") {
    throw new UsageError({
      what: `sync: subverb required (try: ${subverbList()})`,
      hint: "run 'atmux help' for the list of verbs",
    });
  }
  switch (sub as KnownSubverb) {
    case "claude-team-json":
      return syncClaudeTeamJson(argv.slice(1));
    default:
      throw new UsageError({
        what: `sync: unknown subverb '${sub}' (try: ${subverbList()})`,
        hint: "run 'atmux help' for the list of verbs",
      });
  }
}

// Flag-parse contract for `atmux sync claude-team-json`. T4 (t-87e81c8e)
// lands `--overwrite-briefs` so unknown-flag refusal is in place ahead of
// T6's full dispatcher wiring. T5 adds `--force` (drift override); T6
// adds `--dry-run` + threads the parsed flags into computeMappedTeam +
// the write path.
interface SyncClaudeTeamJsonFlags {
  overwriteBriefs: boolean;
}

function parseSyncClaudeTeamJsonFlags(
  argv: ReadonlyArray<string>,
): SyncClaudeTeamJsonFlags {
  const flags: SyncClaudeTeamJsonFlags = { overwriteBriefs: false };
  for (const a of argv) {
    if (a === "--overwrite-briefs") {
      flags.overwriteBriefs = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new UsageError({
        what: `sync claude-team-json: unknown flag: ${a}`,
        hint: "known flags: --overwrite-briefs",
      });
    }
    throw new UsageError({
      what: `sync claude-team-json: unexpected positional arg: ${a}`,
      hint: "this subverb takes no positional args; try --overwrite-briefs",
    });
  }
  return flags;
}

// T2 stub — T6 (ADR-164) replaces with the real core mapping call against
// src/core/sync-claude-team-json/*. Flag-parsing surface lands in T4
// (this file) so unknown-flag refusal predates the write/dry-run wiring.
async function syncClaudeTeamJson(argv: ReadonlyArray<string>): Promise<number> {
  // Parse-and-discard for now — surfaces typos like `--overwrite-brief`
  // (missing 's') ahead of T6. The parsed flags will thread into
  // computeMappedTeam({ overwriteBriefs }) once T6 wires the write path.
  parseSyncClaudeTeamJsonFlags(argv);
  throw new Error("atmux sync claude-team-json: not yet implemented — see T5-T6 (ADR-164)");
}

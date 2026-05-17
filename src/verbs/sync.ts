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

// T2 stub — T3 (t-312fe824) replaces with the real core mapping call
// against src/core/sync-claude-team-json/*. The stub-shape preserves
// the dispatcher contract (Promise<number>) so the wiring + flag-parse
// surface can ship in parallel with the core mapping work.
async function syncClaudeTeamJson(_argv: ReadonlyArray<string>): Promise<number> {
  throw new Error("atmux sync claude-team-json: not yet implemented — see T3-T6 (ADR-164)");
}

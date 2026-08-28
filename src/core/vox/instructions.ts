// ADR-272: voice operator interface — the system prompt for the
// realtime provider session ("Jarvis" persona: composed, dry,
// unhurried, operational).
//
// Pure string composition — one exported function, no IO, no clocks
// (the MYT timestamp arrives pre-formatted from the caller). The
// load-bearing clauses (report-only-what-the-tools-returned, the
// two-states rule, the inferred-process-state "?" marker,
// confirm-preview VERBATIM, spawn/git refusal + tell_lead offer,
// readonly notice, current-team default) are pinned by unit tests: the
// behaviourally-important sentences may be reworded only together with
// their tests.
//
// The first three are the anti-confabulation set (ADR-272 §Supplement —
// no-invention). On a voice surface the spoken sentence is the whole
// interface: the operator never sees the tool result, so a plausible
// gap-filler is indistinguishable from a measurement and gets acted on.
//
// The TWO-STATES clause exists because ADR-273 §Supplement-6 put a
// behavioural verdict (`agent-state`) alongside the process taxonomy in
// `atmux status`, and `team_status` sends the TEXT table — so the model
// sees both columns and must be told which one answers the question.
// "Active", read aloud, means "working fine" to a listener; it is true
// of a pane blocked forever on a permission prompt. Leading with the
// process column is exactly the misread W6 recorded.
//
// The "?" clause exists because `CageHealth.inferredFromRender`
// (51e87b7) marks a state the probe could not confirm, and a marker the
// model was never taught to read is spoken aloud as certainty. It is
// rendered by `formatPaneStateColumn` and survives the `process: `
// prefix `formatProcessStateColumn` adds — the cell still ENDS in `?`,
// which is what this clause keys on.
//
// Note the D7 division of labour: the CONFIRMATION MECHANISM is
// enforced by the server (tool bridge + confirm store) — these
// instructions shape the conversation around it, they do not implement
// it. A model that ignores them still cannot mutate without a redeemed
// token.

export interface BuildInstructionsOpts {
  teams: string[];
  currentTeam: string | null;
  readonly: boolean;
  /** Pre-formatted MYT timestamp (e.g. "2026-08-14 15:04 MYT"). */
  nowMytIso?: string;
}

/** Compose the voice-session system prompt. */
export function buildInstructions(opts: BuildInstructionsOpts): string {
  const lines: string[] = [];

  lines.push(
    "You are the atmux fleet assistant — the operator's voice interface to his agent teams. Stay composed, dry, and unhurried; you are a calm operations officer, not a hype machine.",
  );

  lines.push(
    "Keep spoken replies to two or three short sentences. Never read lists, tables, markdown, or JSON aloud — summarize what matters and offer detail only if asked.",
  );

  lines.push(
    "Say only what the tools returned. If a tool did not report something, say so plainly instead of inferring it; do not fuse two results into one claim, and never name a team, pane, member, or count no tool gave you. An empty result is an answer — say there was nothing.",
  );

  lines.push(
    'Each member row carries TWO states. The agent-state says what the agent is DOING — that is the answer when the operator asks how a team or a pane is. The process-state says only whether a process is running there: a pane can be process-active while its agent is stopped forever on a permission prompt. Lead with the agent-state. Do NOT volunteer the process-state for a pane whose agent-state already says it is stuck — a running process is not news about a stopped agent, and "active" will be heard as "it is fine". Mention the process-state only when it is down, or when asked. An indented evidence line under a member is the pane text that produced its agent-state — quote it if the operator asks why.',
  );

  lines.push(
    'A process-state ending in a question mark ("active?") was read off the pane\'s screen because no agent process could be identified there. Speak that one as unconfirmed — "looks active, not confirmed" — and never drop the doubt. A process-state with no question mark was measured: say it plainly.',
  );

  lines.push(
    opts.nowMytIso !== undefined
      ? `All times are Malaysia time (MYT). The session started at ${opts.nowMytIso}.`
      : "All times are Malaysia time (MYT).",
  );

  lines.push('Refer to task ids by their last 4 characters (say "task 4a2f", not the full id).');

  lines.push(
    'Before running a slow tool, give an acknowledgement of three words or fewer ("checking now"), then call it.',
  );

  lines.push(
    "When a tool result says needs_confirmation: read its preview line aloud VERBATIM, then stop and wait. Redeem the confirmation token only on a clear, unambiguous yes from the operator. Silence, hesitation, a hedge, or a topic change means no — do not redeem.",
  );

  lines.push(
    "You cannot spawn, stop, or kill agents, and you cannot touch git — those controls are not in your tools. When asked for one, say so plainly and offer tell_lead to pass the request to the team's lead instead.",
  );

  if (opts.readonly) {
    lines.push(
      "Readonly mode is active: mutations are disabled. When the operator asks for anything that would change state, start that reply by saying mutations are disabled, then offer the closest read instead.",
    );
  }

  lines.push(
    "If a tool returns ambiguous_team, read out the candidate team names and ask which one the operator meant. If it returns unknown_team, say the name did not match and list a few close teams.",
  );

  const teamsLine =
    opts.teams.length > 0
      ? `Teams in the fleet: ${opts.teams.join(", ")}.`
      : "The fleet has no teams registered right now.";
  if (opts.currentTeam !== null) {
    lines.push(
      `${teamsLine} The current team is ${opts.currentTeam}; team-scoped tools default to it unless the operator names another.`,
    );
  } else {
    lines.push(
      `${teamsLine} No current team is selected — ask which team before running team-scoped tools.`,
    );
  }

  return lines.join("\n\n");
}

// ADR-272 §Supplement — the scenario table for the voice e2e harness.
//
// Adding a scenario is a DATA edit here. Nothing downstream switches on a
// scenario id, so a new row needs no new code — which is the property that
// keeps the harness from ossifying around the three questions it shipped
// with.
//
// Each row carries two independent gates:
//   - `expectAnyTool` — a MECHANICAL check against the `tool.start` frames
//     the server actually emitted. Deterministic, and not something a
//     persuasive transcript can talk its way past.
//   - `criteria` — SEMANTIC checks the judge answers by reading the
//     transcript against the ground truth.
// A scenario passes only if both hold. The mechanical gate exists because
// "did it call the right tool" is a fact, and facts should not be graded by
// a language model when they can be observed directly.

import { attentionPanes } from "./fixtures.ts";
import type { JudgeCriterion } from "./judge.ts";

export interface Scenario {
  id: string;
  /** Spoken aloud by the harness (synthesized to PCM16 24 kHz). */
  utterance: string;
  /**
   * The assistant must invoke at least one of these. An empty array means
   * no mechanical tool gate (the scenario is graded on content alone).
   */
  expectAnyTool: ReadonlyArray<string>;
  /** Scenario-specific judge criteria, appended to `BASE_CRITERIA`. */
  criteria: ReadonlyArray<JudgeCriterion>;
}

/** The panes the fleet genuinely needs the operator for, named for prompts. */
function attentionList(): string {
  return attentionPanes()
    .map((p) => `${p.team}/${p.member} (${p.kind})`)
    .join(", ");
}

export const SCENARIOS: ReadonlyArray<Scenario> = Object.freeze([
  Object.freeze({
    id: "attention",
    utterance: "What needs my attention right now?",
    expectAnyTool: Object.freeze(["fleet_attention"]),
    criteria: Object.freeze([
      Object.freeze({
        id: "named_blocked_pane",
        question:
          "Did the assistant report the pane that is blocked on a permission prompt " +
          "(be-1)? Reporting it by role or description rather than by name is fine, " +
          "as long as it is unambiguously that pane.",
      }),
      Object.freeze({
        id: "named_residue_pane",
        question:
          "Did the assistant report the pane that is idle with unsubmitted text in " +
          "its composer (fe-1)? Again, description rather than exact name is fine.",
      }),
      Object.freeze({
        id: "did_not_flag_healthy_pane",
        question:
          "Did the assistant AVOID claiming that the healthy, actively-working pane " +
          "(docs) needs attention? Mentioning it as fine or as working is acceptable; " +
          "listing it as a problem is a FAIL.",
      }),
    ]),
  }),
  Object.freeze({
    id: "all_ok",
    utterance: "Is everything okay?",
    expectAnyTool: Object.freeze(["fleet_attention", "fleet_quiet", "fleet_overview"]),
    criteria: Object.freeze([
      Object.freeze({
        id: "did_not_invent_problems",
        question:
          "Did the assistant avoid inventing problems that do not exist in the ground " +
          `truth? The ONLY real problems are: ${attentionList()}, plus the ghost team ` +
          "whose session is down. Any other reported problem is a FAIL.",
      }),
      Object.freeze({
        id: "was_honest_about_state",
        question:
          "The fleet is NOT fully healthy — some panes do need attention. Did the " +
          "assistant answer honestly rather than giving blanket reassurance that " +
          "everything is fine? A flat 'yes, all good' with no mention of the blocked " +
          "or wedged panes is a FAIL.",
      }),
    ]),
  }),
  Object.freeze({
    id: "drilldown",
    utterance: "Tell me about the alpha team.",
    expectAnyTool: Object.freeze(["team_status", "team_health", "fleet_attention", "list_teams"]),
    criteria: Object.freeze([
      Object.freeze({
        id: "scoped_to_the_right_team",
        question:
          "Did the assistant talk about the team voice-e2e-alpha specifically, rather " +
          "than about the whole fleet or about the ghost team?",
      }),
      Object.freeze({
        id: "described_alpha_accurately",
        question:
          "Was what it said about voice-e2e-alpha consistent with the ground truth " +
          "(three panes: one blocked on a permission prompt, one idle with unsubmitted " +
          "text, one working)? It need not list all three, but nothing it says may " +
          "contradict them.",
      }),
    ]),
  }),
]);

/** Look one up by id. Returns null rather than throwing — the caller turns
 *  it into a `UsageError` with the full list of valid ids. */
export function scenarioById(id: string): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

/** Every scenario id, for usage text. */
export function scenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}

export interface ToolGateResult {
  ok: boolean;
  expected: ReadonlyArray<string>;
  invoked: ReadonlyArray<string>;
  reason: string | null;
}

/**
 * The mechanical half of a scenario's gate: did the assistant invoke at
 * least one of the tools this question should route to?
 *
 * An empty `expectAnyTool` passes vacuously — that is a scenario opting out
 * of the mechanical gate, not a bug.
 */
export function checkToolGate(scenario: Scenario, invoked: ReadonlyArray<string>): ToolGateResult {
  const expected = scenario.expectAnyTool;
  if (expected.length === 0) {
    return { ok: true, expected, invoked, reason: null };
  }
  const hit = invoked.some((t) => expected.includes(t));
  return {
    ok: hit,
    expected,
    invoked,
    reason: hit
      ? null
      : `expected one of [${expected.join(", ")}] but the assistant invoked [${
          invoked.length > 0 ? invoked.join(", ") : "nothing"
        }]`,
  };
}

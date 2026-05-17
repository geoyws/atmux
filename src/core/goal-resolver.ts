// ADR-157 T2 (Task t-b5b0678e) — per-member goal resolution + runtime-gate
// helper.
//
// Single source of truth for "what is this member's standing goal?"
// across the two downstream consumers:
//   - T3 /goal injection hooks (src/verbs/rotate-member.ts +
//     src/verbs/start.ts) — fire `/goal "${resolved}"` post-brief.
//   - T4 lane-tick narrowing — skip the claim-injection branch when
//     `resolveGoalForMember(member, briefPath)` returns non-null AND
//     `runtime !== "cursor"`.
//
// Resolution order (ADR-157 §D2 + §OQ3 resolution):
//   1. `member.goal` explicit override (when string-valued).
//   2. `templates/briefs/<role>.md ## Standing Goal` section (when
//      briefPath is supplied + file is readable + section exists).
//   3. null — caller treats as goal-inactive.
//
// Explicit empty string is OPT-OUT (returns null) — operator's
// explicit way to say "this member has no /goal even though my role
// brief defines one". See `resolveGoalForMember`'s contract +
// associated unit test names for the design choice rationale.
//
// Runtime-gate helper `validateGoalRuntime` returns a WARN string (or
// null when OK) for the loader / verb-side warning surface. Zod
// doesn't have a first-class WARN severity, so this lives as an
// imperative helper rather than a `.superRefine` — partial
// migrations from cursor → claude (or vice versa) shouldn't block
// schema load.

import { readTextOrNull } from "../abstractions/fs.ts";
import type { TeamMember } from "../schema/team.ts";

/** Anchor regex for the brief's `## Standing Goal` section per
 *  ADR-157 T2 Reviewer pre-flag — case-sensitive, single space, no
 *  trailing colon. Matches the literal MD convention added to briefs
 *  in T1's same-commit doc-update. Captures the goal text (multi-line
 *  until the next markdown heading or EOF). */
const STANDING_GOAL_RE = /^## Standing Goal\n+([^\n]+(?:\n[^\n#][^\n]*)*)/m;

/** Public for direct unit testing — exercises the regex without
 *  needing to stage a brief on disk. */
export function parseStandingGoalFromBrief(briefText: string): string | null {
  const m = briefText.match(STANDING_GOAL_RE);
  if (m === null) return null;
  const captured = m[1]?.trim();
  if (captured === undefined || captured.length === 0) return null;
  return captured;
}

/** ADR-157 §D2 / §OQ3 — resolve the effective standing goal for a
 *  member. Resolution chain:
 *
 *    1. `member.goal` (when string-valued AND non-empty) — explicit
 *       override wins.
 *    2. brief at `briefPath` (when supplied + readable) — parse the
 *       `## Standing Goal` section.
 *    3. null — no goal active; caller treats as cron-driven path.
 *
 *  Empty-string contract: `member.goal === ""` is the explicit
 *  opt-out signal — returns null without consulting the brief. The
 *  operator explicitly says "this member has no /goal even though my
 *  role brief defines one" by writing `goal: ""` in team.json.
 *
 *  Graceful degrade: brief read failure (path missing, permission
 *  denied, decode error) returns null when `member.goal` is also
 *  unset, OR `member.goal` value when set — never throws. Callers
 *  treat both outcomes as "no goal active" or "explicit goal wins"
 *  respectively, no need to inspect why the brief read failed. */
export async function resolveGoalForMember(
  member: TeamMember,
  briefPath?: string,
): Promise<string | null> {
  if (typeof member.goal === "string") {
    if (member.goal.length === 0) return null;
    return member.goal;
  }
  if (briefPath === undefined) return null;
  const briefText = await readTextOrNull(briefPath);
  if (briefText === null) return null;
  return parseStandingGoalFromBrief(briefText);
}

/** ADR-157 §D4 / T2 Reviewer pre-flag — runtime-gate WARN helper.
 *  Returns a one-line WARN string when `member.runtime === "cursor"`
 *  AND `member.goal` is set non-empty (the no-op partial-migration
 *  case); returns null otherwise. The loader / verb-side surfaces
 *  the WARN via stderr but DOES NOT refuse schema load — the goal
 *  field is structurally allowed under any runtime, the hooks (T3)
 *  short-circuit on `runtime === "cursor"` so no `/goal` ever fires
 *  in that case. */
export function validateGoalRuntime(member: TeamMember): string | null {
  const isCursor = member.runtime === "cursor";
  const hasGoal = typeof member.goal === "string" && member.goal.length > 0;
  if (isCursor && hasGoal) {
    return `member ${member.name}: \`goal\` set but \`runtime: "cursor"\` — Cursor CLI has no /goal skill, field is a no-op (ADR-157 §D4)`;
  }
  return null;
}

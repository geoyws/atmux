// Per-member atmux → claude shape transform — ADR-164 §"Behavior" step 4
// + §Context mapping table.
//
// Field-by-field policy (per ADR-164):
//   name        → verbatim (with name-rewrite for team-lead, see
//                 ./name-rewrite.ts)
//   description → top-level only; per-member has no description
//   role enum   → drives `agentType` emission (team-lead only) AND drives
//                 the name rewrite; the Claude-side `role` (long-form
//                 brief) is brief-preservation territory and lives in
//                 T4 (./brief-preserve), not here.
//   color       → resolved via ./color-map
//   model       → verbatim, with "default" → "claude-opus-4-7" expansion
//                 (matches ADR-094 spawn-time resolution)
//   label / lane / tui / cwd / command / claudeAccount → DROPPED
//                 (atmux-runtime concerns, not /team-skill concerns)

import type { TeamMember } from "../../schema/team.ts";
import { resolveColor } from "./color-map.ts";
import { rewriteClaudeName } from "./name-rewrite.ts";
import type { ClaudeTeamMember, ColorSidecar } from "./types.ts";

/** ADR-094 default-model expansion. The atmux team.json may carry
 *  `model: "default"` as the sentinel for "let spawn-time pick"; on the
 *  Claude side we expand it to the concrete model so the Claude `/team`
 *  skill doesn't have to know about atmux's default-resolution chain. */
const DEFAULT_MODEL_EXPANSION = "claude-opus-4-7";

function expandModel(atmuxModel: string | undefined): string | undefined {
  if (atmuxModel === undefined) return undefined;
  if (atmuxModel === "default") return DEFAULT_MODEL_EXPANSION;
  return atmuxModel;
}

/** Map a single atmux-side member to its Claude-side counterpart.
 *  Pure function — caller composes the array. Brief preservation
 *  (T4) merges the prior Claude-side `role` text on top of this
 *  output; this T3 path emits no `role` field. */
export function mapMember(
  member: TeamMember,
  sidecar: ColorSidecar | null,
): ClaudeTeamMember {
  const claude: ClaudeTeamMember = {
    name: rewriteClaudeName(member.name, member.role),
    color: resolveColor(member.name, member.emoji, sidecar),
  };
  if (member.role === "team-lead") {
    claude.agentType = "team-lead";
  }
  const model = expandModel(member.model);
  if (model !== undefined) {
    claude.model = model;
  }
  return claude;
}

/** Map the full roster. Returns one ClaudeTeamMember per atmux member,
 *  in input order. */
export function mapRoster(
  members: readonly TeamMember[],
  sidecar: ColorSidecar | null,
): ClaudeTeamMember[] {
  return members.map((m) => mapMember(m, sidecar));
}

// Per-member atmux → claude shape transform — ADR-164 §"Behavior" step 4
// + §Context mapping table.
//
// Field-by-field policy (per ADR-164):
//   name        → verbatim (with name-rewrite for team-lead, see
//                 ./name-rewrite.ts)
//   description → top-level only; per-member has no description
//   role enum   → drives `agentType` emission (team-lead only) AND drives
//                 the name rewrite. The Claude-side `role` (long-form
//                 brief) is preserved-by-default via mergeBriefs (T4) —
//                 see ADR-164 §Behavior step 6 + §OQ-4.
//   color       → resolved via ./color-map
//   model       → verbatim, with "default" → "claude-opus-4-7" expansion
//                 (matches ADR-094 spawn-time resolution)
//   label / lane / tui / cwd / command / claudeAccount → DROPPED
//                 (atmux-runtime concerns, not /team-skill concerns)

import type { TeamMember } from "../../schema/team.ts";
import { resolveColor } from "./color-map.ts";
import { rewriteClaudeName } from "./name-rewrite.ts";
import type { ClaudeTeam, ClaudeTeamMember, ColorSidecar } from "./types.ts";

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
export function mapMember(member: TeamMember, sidecar: ColorSidecar | null): ClaudeTeamMember {
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

/** Brief-preservation policy per ADR-164 §"Behavior" step 6 + §OQ-4.
 *
 *  Matching is by post-rewrite Claude-side `name` (so atmux `lead` aligns
 *  with prior Claude `team-lead`, etc.).
 *
 *  - overwriteBriefs=false (default): if the prior Claude-side member has
 *    a non-empty `role` (long-form text), preserve it. New members (only
 *    on the atmux side) get the atmux role-enum as their initial `role`.
 *  - overwriteBriefs=true: replace every member's `role` with the
 *    atmux-side role-enum value. */
export function mergeBriefs(
  prior: ClaudeTeam | null,
  computed: readonly ClaudeTeamMember[],
  atmuxMembers: readonly TeamMember[],
  opts: { overwriteBriefs: boolean },
): ClaudeTeamMember[] {
  const priorByName = new Map<string, ClaudeTeamMember>();
  for (const m of prior?.members ?? []) {
    if (typeof m?.name === "string" && m.name.length > 0) {
      priorByName.set(m.name, m);
    }
  }
  return computed.map((member, i) => {
    // `atmuxMembers` and `computed` are 1:1 by construction (mapRoster
    // emits one Claude-side member per atmux-side member in order).
    const atmuxMember = atmuxMembers[i];
    const atmuxRole = atmuxMember?.role;
    if (opts.overwriteBriefs) {
      // Overwrite path — atmux role-enum wins. Drop the field when the
      // atmux side has no role (rare; team.json schema allows it).
      if (atmuxRole === undefined || atmuxRole.length === 0) return member;
      return { ...member, role: atmuxRole };
    }
    // Preserve path — keep prior non-empty role; otherwise seed from
    // atmux role-enum so first-sync isn't empty.
    const priorMember = priorByName.get(member.name);
    const priorRole = priorMember?.role;
    if (typeof priorRole === "string" && priorRole.length > 0) {
      return { ...member, role: priorRole };
    }
    if (atmuxRole !== undefined && atmuxRole.length > 0) {
      return { ...member, role: atmuxRole };
    }
    return member;
  });
}

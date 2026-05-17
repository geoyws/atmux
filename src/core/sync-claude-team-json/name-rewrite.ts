// Name-rewrite — `lead` → `team-lead` per ADR-164 §"Name rewrite" + §OQ-2.
//
// The atmux convention is `members[0].name = "lead"`. The Claude `/team`
// skill family (`/team rotate-lead`, bootstrap brief paste-in) hard-codes
// `team-lead` as the lead identifier. Unconditional rewrite at sync time
// keeps the two surfaces parity-aligned without forcing operators to
// rename their atmux-side `lead` member.

/** Rewrite for the Claude-side `name` field. Returns `"team-lead"` when
 *  `role === "team-lead"` (post-Zod transform, so legacy `"gitter"` etc.
 *  are already coerced upstream); else returns the input verbatim. */
export function rewriteClaudeName(
  atmuxName: string,
  atmuxRole: string | undefined,
): string {
  if (atmuxRole === "team-lead") return "team-lead";
  return atmuxName;
}

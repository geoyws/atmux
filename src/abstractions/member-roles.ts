// ADR-161 §Decision-anchor #1/#2: closed-set of default member roles.
//
// Default roles render with the `_` prefix per ADR-161's window-name
// format split — `${emoji}_${label}` — matching the cockpit-tier
// `_-prefix` convention introduced in ADR-135 §D2. User-added members
// (role = "member" or any other non-default value) keep the existing
// ADR-135 D3 hyphen form: `${emoji}-${label}`.
//
// **Why this lives in abstractions/** — `buildWindowName` (the rendering
// consumer) lives in `src/core/common.ts`; the role-check is a pure
// predicate over a string literal closed set, no I/O, no atmux-specific
// state. Abstractions/ is the right layer for shape-utilities the
// rendering layer depends on. (Mirrors `src/abstractions/tmux.ts`'s
// `TmuxNamespace` pure-shape role.)
//
// **`gitter` / `committer` rename coordination**: ADR-159 renames the
// `gitter` role to `committer`. Until ADR-159's source rename (sub-task
// t-0b8a1c1d) lands, neither literal appears in `DEFAULT_MEMBER_ROLES`
// — the role still renders with hyphen until both ADRs ship together
// per ADR-161 §3 coordination note. Once ADR-159 ships, this constant
// gets `"committer"` added in the same commit; the JSON-shim continues
// to accept the legacy `"gitter"` literal during the deprecation window.
//
// **ADR-287 §D5 (2026-09-02) — deprecated as a shipped default.** The
// default roster is drivers-only: `templates/team.example.json` ships
// `members: []`, so none of these roles spawns unless a team declares
// it in `members[]`. The constant is RETAINED, unchanged, because the
// window-name renderer (`buildWindowName`) and `atmux member sort`
// still key off it for roles a team explicitly declares — a declared
// `team-lead` still renders `🧭_lead`. What is deprecated is the
// assumption that these windows exist by default; nothing here changes
// behaviour for a team that declares them.

/** Closed set of canonical role literals atmux ships out-of-the-box.
 *  Defaults render `_-prefix`; user-added (role = "member") keeps the
 *  ADR-135 hyphen form.
 *
 *  Retained for window-name rendering of explicitly declared roles
 *  only — per ADR-287 §D5 these roles are deprecated as DEFAULTS (the
 *  shipped template declares no members); they are not removed. */
export const DEFAULT_MEMBER_ROLES = ["team-lead", "planner", "reviewer", "ombudsman"] as const;

/** Union of the canonical default role literals. */
export type DefaultMemberRole = (typeof DEFAULT_MEMBER_ROLES)[number];

/** Type-narrowing predicate: `true` iff `role` is one of the canonical
 *  default roles per ADR-161 §Decision-anchor #1. The rendering layer
 *  (`buildWindowName`) keys the `_-prefix` branch off this predicate.
 *  Still answers `true` for a declared `team-lead` / `planner` /
 *  `reviewer` / `ombudsman` after ADR-287 §D5 — the deprecation is of
 *  the default roster, not of the rendering rule. */
export function isDefaultMemberRole(role: string | undefined): role is DefaultMemberRole {
  if (role === undefined) return false;
  // Cast through `readonly string[]` so .includes accepts the wider
  // `string` argument; the const literal's narrow union doesn't trip
  // tsc's strict-comparison.
  return (DEFAULT_MEMBER_ROLES as readonly string[]).includes(role);
}

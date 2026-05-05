// ADR-005: Zod schema for `.atmux/team.json`.
//
// The boundary file every verb that knows the team identity reads. v1
// models the fields that core + the abstractions currently consume; the
// schema is `.passthrough()` because the templates ship with operator-
// authored `_comment_*` keys (see templates/team.example.json) and
// because Phase 2 porters add `whip` / `report` / `discord` sub-shapes
// as their verbs land. Once every consumer is modeled (Phase 2 close),
// flip to `.strict()` per src/schema/README.md's strict-by-default
// rule. Tightening the union is forward-compatible; loosening it
// later is not.
//
// References: ADR-005 (JSON+lock), ADR-003 (schemas import zod only),
// templates/team.example.json (canonical shape at HEAD 2aadc3f),
// lib/common.sh::atmux::team_field (bash-side reader).

import { z } from "zod";

/** TUI types atmux supports launching into a pane. Mirrors bash
 *  `lib/start.sh`'s case-on-tui — passthrough for forward-compat. */
export const TuiKind = z.enum(["claude", "opencode", "kimi", "cursor"]);
export type TuiKind = z.infer<typeof TuiKind>;

/** Member entry in `team.json :: members[]`. */
export const TeamMember = z
  .object({
    name: z.string().min(1),
    role: z.string().optional(),
    lane: z.string().optional(),
    tui: TuiKind.optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    emoji: z.string().optional(),
  })
  .passthrough();
export type TeamMember = z.infer<typeof TeamMember>;

/** Emoji-assignment policy block. Mode mirrors bash `lib/emoji.sh`. */
export const TeamEmojis = z
  .object({
    mode: z.enum(["static", "random", "ai"]).optional(),
  })
  .passthrough();
export type TeamEmojis = z.infer<typeof TeamEmojis>;

/** `.atmux/team.json` — the team's durable identity + roster. */
export const Team = z
  .object({
    /** Team name. Constrained in-code (see core/common.ts checkTeamName). */
    name: z.string().min(1),
    /** Free-form description; surfaced in `atmux status` headers. */
    description: z.string().optional(),
    /** Cage tmpdir per ADR-018 (`/tmp/atmux-tmux_<team>`); empty/null
     *  means the team uses the operator default socket. */
    tmuxTmpdir: z.string().optional(),
    /** Single-session opt-in (default `false` per 2026-04-30 reversal,
     *  see templates/team.example.json comment). */
    singleSession: z.boolean().optional(),
    /** TUI to auto-spawn in the cage's driver window on `atmux start`. */
    driverTui: z.string().nullable().optional(),
    /** Member roster. Order is preserved (window layout depends on it). */
    members: z.array(TeamMember),
    emojis: TeamEmojis.optional(),
    /** Phase 2 sub-shapes — typed once verb porters land. */
    whip: z.unknown().optional(),
    report: z.unknown().optional(),
    discord: z.unknown().optional(),
    tuiCommands: z.unknown().optional(),
  })
  .passthrough();
export type Team = z.infer<typeof Team>;

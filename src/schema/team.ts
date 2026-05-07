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

/** TUI types atmux supports launching into a pane.
 *
 * Bash `lib/tui.sh::atmux::tui_cmd` treats `tui` as a free-form name —
 * known built-ins (claude/opencode/kimi/cursor/shell/bash/zsh) hit a
 * hard-coded launcher; any other value MUST be registered in
 * `team.tuiCommands` (see `tests/unit/tui_resolution.bats`). The schema
 * therefore accepts `z.string()` rather than a closed enum: locking the
 * enum to the built-ins would refuse legitimate `team.tuiCommands`
 * names like `claude-fresh` / `opencode-minimax-fast` (live use,
 * documented at `lib/tui.sh:21`). */
export const TuiKind = z.string();
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
    /** Per-member full-command override (lib/tui.sh:30-37 / lib/add-member.sh:21).
     *  When present, `atmux::tui_cmd` uses it verbatim, ignoring `team.tuiCommands`
     *  and built-in launchers. Stamped at `add-member` time via `--command <cmd>`. */
    command: z.string().optional(),
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

/**
 * `team.json::whip` sub-config — typed per ADR-054 §D1.
 *
 * `.strict()` is intentional — drift detection requires unknown-key
 * rejection. Passthrough at this level would mask typos like
 * `budgetPauseTreshold` (note typo); strict surfaces them via the
 * 🔧 [whip-config-drift] Discord ping per ADR-054 §D3.
 *
 * Includes ALL fields used by ADR-053 (budget knobs), ADR-055
 * (selfHeal), and ADR-056 (account fallback). Adding a field requires
 * updating this schema — the intentional friction CLAUDE.md asks for.
 *
 * Bash-shared note: bash whip uses several of these fields too
 * (`staleMin`, `leadMaxMin`, `autoRotate`); they predate this schema
 * and are read in bash via `lib/whip.sh:71-81`'s loose jq lookup.
 * Adding the typed schema doesn't change bash behaviour — bash never
 * read a `schemaVersion` and we don't introduce one (per
 * `src/schema/README.md` §"Burn-in compatibility"). Operator typos in
 * fields bash uses also surface via this drift mechanism.
 */
export const TeamWhip = z
  .object({
    /** Cron interval in minutes. Default 5. ADR-054 OQ-1 surfaces
     *  cron-vs-schema mismatch as future doctor work. */
    intervalMins: z.number().int().positive().default(5),
    /** Stale-task threshold (min). Default 90 (raised from bash 30 in
     *  bash E2/S7 — demo-walk tasks legitimately run 60-90min). */
    staleMin: z.number().int().nonnegative().default(90),
    /** Lead uptime cutoff (min). ≥this → recommend rotate. Default 60. */
    leadMaxMin: z.number().int().positive().default(60),
    /** Auto-rotate execution gate. V-25 only recommends; auto-execute
     *  is V-26-deferred per ADR-021. Default false. */
    autoRotate: z.boolean().default(false),
    /** Number of consecutive DOWN ticks before reporting (false-alert
     *  dampener). Default 2 per bash E6/S1. Used by readWhipConfig +
     *  the 2-tick session-DOWN gate; pre-existed ADR-054 — added here
     *  to keep `.strict()` mode from rejecting valid live team.json. */
    downConfirmTicks: z.number().int().positive().default(2),
    /** When `false`, suppress 💓 [whip-heartbeat] on clean ticks.
     *  Pre-existed ADR-054 — added here to keep `.strict()` from
     *  rejecting valid live team.json (every whip test sets it). */
    heartbeat: z.boolean().default(true),

    // ---------- ADR-049 / ADR-053 budget knobs ----------
    /** Pause threshold (% of budget consumed). Default 90. */
    budgetPauseThreshold: z.number().int().min(0).max(100).default(90),
    /** Resume threshold (% of budget remaining). Default 80. */
    budgetResumeThreshold: z.number().int().min(0).max(100).default(80),
    /** Warning bands (fractions of budget remaining). Default
     *  [0.50, 0.25, 0.15] — pings at the 50%/25%/15% remaining marks. */
    budgetWarningBands: z.array(z.number().min(0).max(1)).default([0.5, 0.25, 0.15]),
    /** Lead time before refresh, in minutes. Default 30. */
    budgetRefreshLeadMins: z.number().int().nonnegative().default(30),
    /** Optional Claude account override for budget probe. */
    claudeAccount: z.string().optional(),

    // ---------- ADR-043 (deprecated under R1; back-compat read) ----------
    /** Idle-tick threshold for ADR-043 auto-stop. Default 0 (disabled
     *  under R1 — eternal-improvement Mode B + budget-pause supersede).
     *  Doctor warns when value > 0 (informational; no behavior change). */
    autoStopAfterIdleTicks: z.number().int().nonnegative().default(0),

    // ---------- ADR-055 self-heal opt-in ----------
    /** Enable cursor self-heal recipes. Default false. */
    selfHealEnabled: z.boolean().default(false),
    /** Whitelist of recipe ids the cursor may auto-apply. Default []. */
    selfHealRecipes: z.array(z.string()).default([]),

    // ---------- ADR-056 account-swap opt-in ----------
    /** Ordered fallback chain of Claude accounts. Default []. */
    accountFallback: z.array(z.string()).default([]),
    /** Threshold (% of budget) at which account-swap fires. Default 75. */
    accountSwapTriggerThreshold: z.number().int().min(0).max(100).default(75),
    /** Health threshold for fallback selection — a fallback account is
     *  viable when BOTH h5 AND wk pct-used are ≤ this. Default 50
     *  (ADR-056 §D2: "half-used is safe-enough; deeper would over-constrain"). */
    accountSwapFallbackHealthThreshold: z.number().int().min(0).max(100).default(50),
    /** Hard cap per single-member swap (seconds). Aborts the swap (not the
     *  member) if exceeded. Default 300 (ADR-056 §"Push-back" 5-min cap). */
    accountSwapPerMemberDeadlineSec: z.number().int().positive().default(300),
    /** Roles excluded from swap pass — their conversation memory doesn't
     *  survive `atmux handoff`. Default lead/planner/reviewer
     *  (ADR-056 §"Lead/planner exclusion"). */
    accountSwapExcludeRoles: z
      .array(z.string())
      .default(["lead", "planner", "reviewer"]),
  })
  .strict();
export type TeamWhip = z.infer<typeof TeamWhip>;

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
    /** ADR-054: typed whip sub-config with strict drift detection. */
    whip: TeamWhip.optional(),
    /** Phase 2 sub-shapes — typed once verb porters land. */
    report: z.unknown().optional(),
    discord: z.unknown().optional(),
    tuiCommands: z.unknown().optional(),
  })
  .passthrough();
export type Team = z.infer<typeof Team>;
